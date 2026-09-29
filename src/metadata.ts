// Registry documents kept on disk between runs, for the registry client (`DocumentCache` in
// `src/registry.ts`). Node-only: the client stays portable and is handed one of these.
//
// One file per url and media type, at a path read off both: `registry.npmjs.org/@scope/name/
// _corgi`, `_full` beside it, and `name/1.0.0/_full` for a version's route; a name or version
// never starts with `_`. A line of JSON says what the file is, when the registry's copy was
// current (not the file's mtime, which copying a store resets) and where each version sits in
// the body (`indexVersions`), so a read parses only the versions it wants. Then the body: as the
// registry sent it, but a full packument cut to what the resolver reads (`trimPackument`). Not
// compressed: zstd would take a third of the disk but make a warm resolve 10% slower. Reads and
// writes are synchronous, because a registry thread is terminated when the walk ends and the
// bin exits once its output is out: a write still pending then would be lost. A write goes to a
// temp file and is renamed in, so a reader never sees half of one.
import { builtin } from "./builtin.ts";
import { at as written, indexVersions, members, OPEN, valueEnd } from "./pluck.ts";
import type { VersionIndex } from "./pluck.ts";
import type { CacheMode, DocumentCache, Kept } from "./registry.ts";
import { concat } from "./runtime.ts";

export interface MetadataOptions {
  /** Where the documents are kept. */
  dir: string;
  mode: CacheMode;
}

interface Head {
  /** When the registry's copy was current, in epoch ms: first, 13 digits, rewritten in place. */
  at: number;
  key: string;
  etag?: string;
  /** Seconds the registry said the document stays fresh from `at`. */
  maxAge?: number;
  /** Where each version sits in the body. A file from before it had none, and still reads. */
  index?: VersionIndex;
}

const NEWLINE = 10;
/** Where `at`'s digits start in a head: after `{"at":`. */
const AT = 6;
/**
 * What of a head `touch` reads: `{"at":`, the digits and the key. A url takes a few hundred
 * bytes; a longer key is not rewritten in place.
 */
const HEAD_MAX = 4096;
/**
 * What a path segment may hold: a name, a version or a host, never `.` or `..`. A name Windows
 * reserves (`con`) or two that differ only by case share a file or fail to write; each is then
 * a miss, since a file's head must name its url.
 */
const SEGMENT = /^(?!\.{1,2}$)[\w.@+~-]+$/;

/** Whether the bytes are an object, by their ends: a full check is the parse that is too slow. */
function document(bytes: Uint8Array): boolean {
  let i = 0;
  let j = bytes.length - 1;
  while (i < j && bytes[i]! <= 0x20) i++;
  while (j > i && bytes[j]! <= 0x20) j--;
  return bytes[i] === 0x7b && bytes[j] === 0x7d;
}

/**
 * A file's head, and where it ends, when it is the one for `key`. A torn or foreign file is a
 * miss, not an error: the registry is asked instead.
 */
function parseHead(bytes: Uint8Array, key: string): (Head & { end: number }) | undefined {
  const end = bytes.indexOf(NEWLINE);
  if (end < 0) return undefined;
  let head: Head;
  try {
    head = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
  } catch {
    return undefined;
  }
  if (head.key !== key || typeof head.at !== "number") return undefined;
  return { ...head, end };
}

/** Whole milliseconds, which are 13 digits from 2001 to 2286. */
const stamp = (at: number) => Math.round(at);
const at13 = (at: number) => at >= 1e12 && at < 1e13;

/** Inside the store, so each store keeps its own; `prune` reads only `files` and `index`. */
export function metadataDir(store: string): string {
  return builtin.path.join(store, "metadata");
}

export function createDocumentCache(options: MetadataOptions): DocumentCache {
  const { dir, mode } = options;
  const { fs, path } = builtin;
  const made = new Set<string>();

  /**
   * `corgi https://host:8080/base/@scope%2fname` → `host+8080/base/@scope/name/_corgi`. A url
   * with a segment that is not plainly a name goes by its hash under `_`.
   */
  function fileOf(key: string): string {
    const space = key.indexOf(" ");
    const kind = key.slice(0, space);
    let segments: string[] | undefined;
    try {
      const url = new URL(key.slice(space + 1));
      const names = url.pathname.replaceAll("%2f", "/").replaceAll("%2F", "/").split("/");
      segments = [url.host.replace(":", "+"), ...names.filter(Boolean)];
    } catch {}
    if (!segments?.every((segment) => SEGMENT.test(segment))) {
      const hash = builtin.crypto.createHash("sha256").update(key).digest("hex");
      segments = ["_", hash.slice(0, 2), hash];
    }
    return path.join(dir, ...segments, `_${kind}`);
  }

  function get(key: string): Kept | undefined {
    const file = fileOf(key);
    let bytes: Uint8Array;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return undefined;
    }
    const head = parseHead(bytes, key);
    if (!head) return undefined;
    const { at, etag, maxAge, end } = head;
    const index = Array.isArray(head.index) ? head.index : undefined;
    return { bytes: bytes.subarray(end + 1), etag, at, maxAge, index };
  }

  function set(
    key: string,
    bytes: Uint8Array,
    at: number,
    etag?: string,
    maxAge?: number,
    index?: VersionIndex,
  ): void {
    if (!document(bytes)) return; // a portal's page, say, is never kept
    const trimmed = key.startsWith("full ") ? trimPackument(bytes) : undefined;
    const body = trimmed ?? bytes;
    if (trimmed) index = indexVersions(trimmed);
    const file = fileOf(key);
    const parent = path.dirname(file);
    const temp = `${file}.${globalThis.process.pid}-${globalThis.crypto.randomUUID()}.tmp`;
    try {
      if (!made.has(parent)) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      made.add(parent);
      const head = { at: stamp(at), key, etag, maxAge, index } satisfies Head;
      const fd = fs.openSync(temp, "w", 0o600);
      try {
        fs.writeSync(fd, encoder.encode(`${JSON.stringify(head)}\n`));
        fs.writeSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, file);
    } catch {
      // A cache that cannot be written only costs the next run a request.
      fs.rmSync(temp, { force: true });
    }
  }

  /**
   * A new `at`, written over the old digits: one small write, not the document again. The head
   * is the one `set` wrote when it starts `{"at":<13 digits>,"key":<key>`: the index after it
   * may be far longer than what is read here. A head short enough to read whole and with no
   * index is from before heads had one: the file is written again, once, with its own index.
   */
  function touch(key: string, at: number): void {
    let fd: number | undefined;
    let old = false;
    try {
      fd = fs.openSync(fileOf(key), "r+");
      const bytes = new Uint8Array(HEAD_MAX);
      const read = fs.readSync(fd, bytes, 0, HEAD_MAX, 0);
      const named = encoder.encode(`,"key":${JSON.stringify(key)}`);
      const after = AT + 13 + named.length;
      const ours =
        written(bytes, 0, encoder.encode('{"at":')) &&
        /^\d{13}$/.test(new TextDecoder().decode(bytes.subarray(AT, AT + 13))) &&
        written(bytes, AT + 13, named) &&
        after < read &&
        (bytes[after] === COMMA || bytes[after] === CLOSE);
      if (!ours || !at13(stamp(at))) return;
      fs.writeSync(fd, encoder.encode(`${stamp(at)}`), 0, 13, AT);
      const head = parseHead(bytes.subarray(0, read), key);
      old = head !== undefined && head.index === undefined;
    } catch {
      // As with `set`.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    const kept = old ? get(key) : undefined;
    const index = kept && indexVersions(kept.bytes);
    if (index) set(key, kept!.bytes, kept!.at, kept!.etag, kept!.maxAge, index);
  }

  return { mode, get, set, touch };
}

const encoder = new TextEncoder();
const COMMA = 0x2c;
const CLOSE = 0x7d;

/** What a full packument keeps: `modified` last, where `pluckModified` reads it. */
const ROOT = ["name", "dist-tags", "time", "versions", "modified"].map((key) =>
  encoder.encode(`"${key}"`),
);
const VERSIONS = 3;
const DIST = [encoder.encode('"dist"')];
/** The abbreviated document's fields, `devDependencies` aside, and `libc`, which it drops. */
const VERSION = [
  "name",
  "version",
  "deprecated",
  "dependencies",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bin",
  "directories",
  "dist",
  "engines",
  "_hasShrinkwrap",
  "hasInstallScript",
  "os",
  "cpu",
  "libc",
].map((key) => encoder.encode(`"${key}"`));
const COMMA_TEXT = encoder.encode(",");
const OPEN_TEXT = encoder.encode("{");
const CLOSE_TEXT = encoder.encode("}");
const VERSIONS_TEXT = encoder.encode('"versions":{');

/** Which of `keys`, written as JSON, the key from `start` to `end` is: keys are compared as written. */
function which(bytes: Uint8Array, start: number, end: number, keys: Uint8Array[]): number {
  for (let k = 0; k < keys.length; k++) {
    if (keys[k]!.length === end - start && written(bytes, start, keys[k]!)) return k;
  }
  return -1;
}

/**
 * A full packument cut to what the resolver reads of it, as deno keeps one: readmes,
 * maintainers, scripts and the like go, a fifth to a half is left. Members are copied as
 * written, found by structure the way `member` finds one, in one pass, so nothing is parsed.
 * Undefined for anything that is not a packument, which is then kept whole.
 */
export function trimPackument(bytes: Uint8Array): Uint8Array | undefined {
  const root: Uint8Array[][] = [];
  let manifest = false;
  const whole = members(bytes, 0, (start, keyEnd, value) => {
    const k = which(bytes, start, keyEnd, ROOT);
    if (k < 0 || root[k]) {
      manifest ||= which(bytes, start, keyEnd, DIST) === 0;
      return valueEnd(bytes, value);
    }
    if (k !== VERSIONS) {
      const end = valueEnd(bytes, value);
      root[k] = [bytes.subarray(start, end)];
      return end;
    }
    // A version's own route has a `dist`, and may have a field called `versions` too.
    if (bytes[value] !== OPEN) return -1;
    const parts: Uint8Array[] = (root[k] = [VERSIONS_TEXT]);
    let count = 0;
    const end = members(bytes, value, (from, _, entry) => {
      if (count++ > 0) parts.push(COMMA_TEXT);
      parts.push(bytes.subarray(from, entry), OPEN_TEXT); // `"1.0.0":{`
      let fields = 0;
      const to = members(bytes, entry, (field, fieldEnd, at) => {
        const after = valueEnd(bytes, at);
        if (after < 0 || which(bytes, field, fieldEnd, VERSION) < 0) return after;
        if (fields++ > 0) parts.push(COMMA_TEXT);
        parts.push(bytes.subarray(field, after));
        return after;
      });
      parts.push(CLOSE_TEXT);
      return to;
    });
    parts.push(CLOSE_TEXT);
    return end;
  });
  if (whole < 0 || manifest || !root[1] || !root[VERSIONS]) return undefined;
  const parts: Uint8Array[] = [OPEN_TEXT];
  for (const found of root) {
    if (!found) continue;
    if (parts.length > 1) parts.push(COMMA_TEXT);
    for (const part of found) parts.push(part);
  }
  parts.push(CLOSE_TEXT);
  return concat(parts);
}

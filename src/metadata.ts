// Registry documents kept on disk between runs, for the registry client (`DocumentCache` in
// `src/registry.ts`). Node-only: the client stays portable and is handed one of these.
//
// One file per url and media type, at a path read off both: `registry.npmjs.org/@scope/name/
// _corgi`, `_full` beside it, and `name/1.0.0/_full` for a version's route; a name or version
// never starts with `_`. A line of JSON says what the file is and when the registry's copy was
// current (not the file's mtime, which copying a store resets), then the body: as the registry
// sent it, but a full packument cut to what the resolver reads (`trimPackument`). Not
// compressed: zstd would take a third of the disk but make a warm resolve 10% slower. Reads and
// writes are synchronous, because a registry thread is terminated when the walk ends and the
// bin exits once its output is out: a write still pending then would be lost. A write goes to a
// temp file and is renamed in, so a reader never sees half of one.
import { builtin } from "./builtin.ts";
import { at as written, CLASS, COLON, objectEnd, OPEN, QUOTE, space, stringEnd } from "./pluck.ts";
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
}

const NEWLINE = 10;
/** Where `at`'s digits start in a head: after `{"at":`. */
const AT = 6;
/** Longer heads are not rewritten in place; a url and an ETag take a few hundred bytes. */
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
    return { bytes: bytes.subarray(end + 1), etag, at, maxAge };
  }

  function set(key: string, bytes: Uint8Array, at: number, etag?: string, maxAge?: number): void {
    if (!document(bytes)) return; // a portal's page, say, is never kept
    const body = (key.startsWith("full ") && trimPackument(bytes)) || bytes;
    const file = fileOf(key);
    const parent = path.dirname(file);
    const temp = `${file}.${globalThis.process.pid}-${globalThis.crypto.randomUUID()}.tmp`;
    try {
      if (!made.has(parent)) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      made.add(parent);
      const head = encoder.encode(`${JSON.stringify({ at: stamp(at), key, etag, maxAge })}\n`);
      const fd = fs.openSync(temp, "w", 0o600);
      try {
        fs.writeSync(fd, head);
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

  /** A new `at`, written over the old digits: one small write, not the document again. */
  function touch(key: string, at: number): void {
    let fd: number | undefined;
    try {
      fd = fs.openSync(fileOf(key), "r+");
      const bytes = new Uint8Array(HEAD_MAX);
      const read = fs.readSync(fd, bytes, 0, HEAD_MAX, 0);
      const head = parseHead(bytes.subarray(0, read), key);
      if (!head || !at13(head.at) || !at13(stamp(at))) return;
      fs.writeSync(fd, encoder.encode(`${stamp(at)}`), 0, 13, AT);
    } catch {
      // As with `set`.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return { mode, get, set, touch };
}

const encoder = new TextEncoder();
const COMMA = 0x2c;
const CLOSE = 0x7d;

/** The index after the value starting at `i`, or -1. */
function valueEnd(bytes: Uint8Array, i: number): number {
  const k = CLASS[bytes[i]!];
  if (k === 1) return stringEnd(bytes, i);
  if (k === 2) return objectEnd(bytes, i);
  // A number, `true`, `false` or `null`: up to what follows it.
  const from = i;
  while (i < bytes.length && bytes[i] !== COMMA && CLASS[bytes[i]!]! < 3) i++;
  return i > from ? i : -1;
}

/**
 * Each member of the object opening at `from`, as its key's bounds and its value's; false
 * when it is not a well-formed object.
 */
function members(
  bytes: Uint8Array,
  from: number,
  each: (start: number, keyEnd: number, value: number, end: number) => void,
): boolean {
  let i = space(bytes, from);
  if (bytes[i] !== OPEN) return false;
  i = space(bytes, i + 1);
  if (bytes[i] === CLOSE) return true;
  for (;;) {
    if (bytes[i] !== QUOTE) return false;
    const keyEnd = stringEnd(bytes, i);
    if (keyEnd < 0) return false;
    let value = space(bytes, keyEnd);
    if (bytes[value] !== COLON) return false;
    value = space(bytes, value + 1);
    const end = valueEnd(bytes, value);
    if (end < 0) return false;
    each(i, keyEnd, value, end);
    i = space(bytes, end);
    if (bytes[i] === CLOSE) return true;
    if (bytes[i] !== COMMA) return false;
    i = space(bytes, i + 1);
  }
}

/** What a full packument keeps: `modified` last, where `pluckModified` reads it. */
const ROOT = ["name", "dist-tags", "time", "versions", "modified"].map((key) =>
  encoder.encode(`"${key}"`),
);
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
 * written, found by structure the way `member` finds one, so nothing is parsed. Undefined
 * for anything that is not a packument, which is then kept whole.
 */
export function trimPackument(bytes: Uint8Array): Uint8Array | undefined {
  const root: ([number, number, number] | undefined)[] = [];
  let manifest = false;
  const whole = members(bytes, 0, (start, keyEnd, value, end) => {
    const k = which(bytes, start, keyEnd, ROOT);
    if (k >= 0) root[k] ??= [start, value, end];
    else manifest ||= which(bytes, start, keyEnd, DIST) === 0;
  });
  // A version's own route has a `dist`, and may have a field called `versions` too.
  const versions = root[3];
  if (!whole || manifest || !root[1] || !versions || bytes[versions[1]] !== OPEN) return undefined;
  const parts: Uint8Array[] = [OPEN_TEXT];
  let ok = true;
  for (const found of root) {
    if (!found) continue;
    if (parts.length > 1) parts.push(COMMA_TEXT);
    if (found !== versions) {
      parts.push(bytes.subarray(found[0], found[2]));
      continue;
    }
    parts.push(VERSIONS_TEXT);
    let count = 0;
    ok &&= members(bytes, found[1], (start, _, value) => {
      if (count++ > 0) parts.push(COMMA_TEXT);
      parts.push(bytes.subarray(start, value), OPEN_TEXT); // `"1.0.0":{`
      let fields = 0;
      ok &&= members(bytes, value, (from, keyEnd, _value, to) => {
        if (which(bytes, from, keyEnd, VERSION) < 0) return;
        if (fields++ > 0) parts.push(COMMA_TEXT);
        parts.push(bytes.subarray(from, to));
      });
      parts.push(CLOSE_TEXT);
    });
    parts.push(CLOSE_TEXT);
  }
  if (!ok) return undefined;
  parts.push(CLOSE_TEXT);
  return concat(parts);
}

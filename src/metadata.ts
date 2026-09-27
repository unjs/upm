// Registry documents kept on disk between runs, for the registry client (`DocumentCache` in
// `src/registry.ts`). Node-only: the client stays portable and is handed one of these.
//
// One file per url and media type, named by the hash of both: a line of JSON saying what it
// is, then the body as the registry sent it, compressed to a quarter. Not trimmed to what the
// resolver reads, though that is a fifth of it: the parse a trim takes cost a cold resolve 18%,
// where compressing alone costs nothing measurable. Reads and writes are synchronous, because
// a registry thread is terminated when the walk ends and the bin exits once its output is
// out: a write still pending then would be lost. A write goes to a temp file and is renamed
// in, so a reader never sees half of one.
import { builtin } from "./builtin.ts";
import type { CacheMode, DocumentCache, Kept } from "./registry.ts";

export interface MetadataOptions {
  /** Where the documents are kept. */
  dir: string;
  mode: CacheMode;
}

interface Head {
  key: string;
  etag?: string;
  /** Seconds the registry said the document stays fresh; the file's mtime is when it was. */
  maxAge?: number;
  /** How the body is compressed: zstd where Node has it (22.15), else gzip. */
  codec: "zstd" | "gzip";
}

/** zstd level 1: a quarter of gzip's time to compress and under half to read, 8% smaller. */
function compress(bytes: Uint8Array): { codec: Head["codec"]; body: Uint8Array } {
  const { zlib } = builtin;
  if (zlib.zstdCompressSync) {
    const params = { [zlib.constants.ZSTD_c_compressionLevel]: 1 };
    return { codec: "zstd", body: zlib.zstdCompressSync(bytes, { params }) };
  }
  return { codec: "gzip", body: zlib.gzipSync(bytes, { level: 1 }) };
}

function decompress(codec: Head["codec"], body: Uint8Array): Uint8Array {
  const { zlib } = builtin;
  if (codec === "gzip") return zlib.gunzipSync(body);
  // Written by a newer Node than this one: a miss.
  if (codec !== "zstd" || !zlib.zstdDecompressSync) throw new Error(`no ${codec}`);
  return zlib.zstdDecompressSync(body);
}

const NEWLINE = 10;

/** Whether the bytes are an object, by their ends: a full check is the parse that is too slow. */
function document(bytes: Uint8Array): boolean {
  let i = 0;
  let j = bytes.length - 1;
  while (i < j && bytes[i]! <= 0x20) i++;
  while (j > i && bytes[j]! <= 0x20) j--;
  return bytes[i] === 0x7b && bytes[j] === 0x7d;
}

/** Inside the store, so each store keeps its own; `prune` reads only `files` and `index`. */
export function metadataDir(store: string): string {
  return builtin.path.join(store, "metadata");
}

export function createDocumentCache(options: MetadataOptions): DocumentCache {
  const { dir, mode } = options;
  const { fs, path } = builtin;
  const made = new Set<string>();

  function fileOf(key: string): string {
    const hash = builtin.crypto.createHash("sha256").update(key).digest("hex");
    return path.join(dir, hash.slice(0, 2), hash);
  }

  function get(key: string): Kept | undefined {
    const file = fileOf(key);
    let bytes: Uint8Array;
    let mtime: number;
    try {
      bytes = fs.readFileSync(file);
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
    // A torn or foreign file is a miss, not an error: the registry is asked instead.
    const end = bytes.indexOf(NEWLINE);
    if (end < 0) return undefined;
    let head: Head;
    try {
      head = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
    } catch {
      return undefined;
    }
    if (head.key !== key) return undefined;
    const age = (Date.now() - mtime) / 1000;
    let body: Uint8Array;
    try {
      body = decompress(head.codec, bytes.subarray(end + 1));
    } catch {
      return undefined;
    }
    return { etag: head.etag, fresh: head.maxAge !== undefined && age < head.maxAge, bytes: body };
  }

  function set(key: string, bytes: Uint8Array, etag?: string, maxAge?: number): void {
    let packed: ReturnType<typeof compress>;
    try {
      if (!document(bytes)) return; // a portal's page, say, is never kept
      packed = compress(bytes);
    } catch {
      return;
    }
    const file = fileOf(key);
    const shard = path.dirname(file);
    const temp = `${file}.${globalThis.process.pid}-${globalThis.crypto.randomUUID()}.tmp`;
    try {
      if (!made.has(shard)) fs.mkdirSync(shard, { recursive: true, mode: 0o700 });
      made.add(shard);
      const { codec, body } = packed;
      const head = new TextEncoder().encode(`${JSON.stringify({ key, etag, maxAge, codec })}\n`);
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

  function touch(key: string): void {
    const now = new Date();
    try {
      fs.utimesSync(fileOf(key), now, now);
    } catch {
      // As with `set`.
    }
  }

  return { mode, get, set, touch };
}

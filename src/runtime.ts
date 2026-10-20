// Where Node and the web disagree. Each helper takes the Node API when it is there and the web
// one otherwise, so nothing else in `src/` asks which runtime it is on. Where the two are the
// same call (`crypto.randomUUID`, `navigator.hardwareConcurrency`, `TextDecoder`) the call sites
// use the global directly and nothing lives here. `fs` has no web side and stays in builtin.ts.

import { builtin } from "./builtin.ts";

/** Whether `builtin.ts` can hand out Node modules. False in a browser, a worker with no Node. */
export const hasNode = typeof globalThis.process?.getBuiltinModule === "function";

// A browser's `process` shim may hand out `fs` alone: crypto and zlib are asked for on first use.
const found: Record<string, boolean> = {};
const has = (id: string) => (found[id] ??= hasNode && !!globalThis.process.getBuiltinModule(id));
export const hasZlib = () => has("node:zlib");

const buffer = (globalThis as { Buffer?: typeof Buffer }).Buffer;

/** One array out of many, always a copy. `total` saves a pass when the caller has counted. */
export function concat(chunks: Uint8Array[], total?: number): Uint8Array {
  if (buffer) return buffer.concat(chunks, total);
  total ??= chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= total) break;
    out.set(chunk.subarray(0, total - offset), offset);
    offset += chunk.length;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  if (buffer)
    return buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `toBase64` in the url-safe alphabet, unpadded: a hash that can be a file or directory name. */
export function toBase64Url(bytes: Uint8Array): string {
  if (buffer)
    return buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Lenient like Buffer: stops at the first `=`, padding optional, a dangling sextet dropped. */
export function fromBase64(text: string): Uint8Array {
  if (buffer) return buffer.from(text, "base64");
  const end = text.indexOf("=");
  let clean = (end === -1 ? text : text.slice(0, end)).replace(/[^A-Za-z0-9+/]/g, "");
  if (clean.length % 4 === 1) clean = clean.slice(0, -1);
  return Uint8Array.from(atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "=")), (c) =>
    c.charCodeAt(0),
  );
}

export function fromHex(text: string): Uint8Array {
  if (buffer) return buffer.from(text, "hex");
  const out = new Uint8Array(text.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type Algorithm = "sha1" | "sha256" | "sha384" | "sha512";
const WEB_NAMES: Record<Algorithm, string> = {
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

export interface Hasher {
  /** Off Node the chunk is held, not copied, so it must not change before `digest()`. */
  update(chunk: Uint8Array): void;
  digest(): Promise<Uint8Array>;
}

/**
 * A streaming hash. Node hashes each chunk as it comes; WebCrypto has no streaming, so off Node
 * the chunks wait and are hashed in one go at the end. Async on both, so callers see one shape:
 * on Node the promise is already settled and costs a microtask.
 */
export function createHasher(algorithm: Algorithm): Hasher {
  if (has("node:crypto")) {
    const hash = builtin.crypto.createHash(algorithm);
    return {
      update: (chunk) => void hash.update(chunk),
      digest: async () => hash.digest(),
    };
  }
  const chunks: Uint8Array[] = [];
  return {
    update: (chunk) => void chunks.push(chunk),
    digest: () => digest(algorithm, concat(chunks)),
  };
}

/**
 * One digest over one buffer. On Node the one-shot `hash` skips building a `Hash` object, which
 * is most of the cost on a short input. Off Node each call is a hop to a crypto thread, tens of
 * microseconds, so a caller with many buffers should start them all and await once.
 */
export async function digest(algorithm: Algorithm, data: Uint8Array): Promise<Uint8Array> {
  if (has("node:crypto")) return builtin.crypto.hash(algorithm, data, "buffer");
  return new Uint8Array(await crypto.subtle.digest(WEB_NAMES[algorithm], data as BufferSource));
}

/**
 * 128 bits of sha256 over a string as 22 chars of base64url: a short key or hash. On Node the
 * text goes to the hash as it is and nothing is awaited, which is what makes it cheap enough
 * to call once per package: the encode, the await and the promise around each were 12 µs of
 * the 14 a call cost, and `nuxt` makes over a thousand of them. Not shake256: WebCrypto has
 * no SHAKE, and a truncated sha256 is every bit as good at telling two subgraphs apart.
 */
export async function shortHash(text: string): Promise<string> {
  const bytes = has("node:crypto")
    ? builtin.crypto.hash("sha256", text, "buffer")
    : await digest("sha256", new TextEncoder().encode(text));
  return toBase64Url(bytes.subarray(0, 16));
}

/** A web stream to loop over. Safari's have no `Symbol.asyncIterator`. */
export const iterate = <T>(stream: AsyncIterable<T> | ReadableStream<T>): AsyncIterable<T> =>
  Symbol.asyncIterator in stream ? (stream as AsyncIterable<T>) : read(stream);

async function* read<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  try {
    for (let step; !(step = await reader.read()).done;) yield step.value;
  } finally {
    // A loop left early cancels, as the native iterator does. After the end it is a no-op.
    reader.cancel().catch(() => {});
  }
}

/** This process, for temp names. Off Node there is one, so 0; the random token keeps names apart. */
export const pid = globalThis.process?.pid ?? 0;

/** A path as a `file://` url. Off Node, a posix path, as a shimmed `fs` has. */
export function toFileURL(path: string): string {
  if (has("node:url")) return builtin.url.pathToFileURL(path).href;
  return new URL(`file://${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}`).href;
}

/** A `file://` url as a path. Off Node, a posix path, as a shimmed `fs` has. */
export function fromFileURL(url: string | URL): string {
  if (has("node:url")) return builtin.url.fileURLToPath(url);
  return decodeURIComponent(new URL(url).pathname);
}

/** A pause. The global `setTimeout` is the one call both runtimes share. */
export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Cores this thread may use. Node reports `os.availableParallelism()` through the same getter,
 * which is the host's cores: a container with a CPU quota is capped by it here, once.
 */
export const cpus = (): number => {
  quota ??= cgroupQuota();
  return Math.max(1, Math.min(globalThis.navigator?.hardwareConcurrency || 4, quota));
};
let quota: number | undefined;

/** A Linux cgroup CPU quota in whole cores; Infinity when unlimited, unreadable or off Node. */
function cgroupQuota(): number {
  if (!hasNode || globalThis.process?.platform !== "linux") return Infinity;
  const read = (file: string) => builtin.fs.readFileSync(file, "utf8").trim();
  const cores = (us = "", period = "") =>
    Number(us) > 0 && Number(period) > 0 ? Math.ceil(Number(us) / Number(period)) : Infinity;
  try {
    const [max, period] = read("/sys/fs/cgroup/cpu.max").split(/\s+/); // v2: "max 100000" or "<quota> <period>"
    return cores(max, period);
  } catch {}
  try {
    const dir = "/sys/fs/cgroup/cpu/cpu.cfs_"; // v1, a quota of -1 is unlimited
    return cores(read(`${dir}quota_us`), read(`${dir}period_us`));
  } catch {}
  return Infinity;
}

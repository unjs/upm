// Just enough of Node for upm's `install` to run in a tab: a `process` whose `getBuiltinModule`
// hands out an `fs` and `fs/promises`, a posix `path` and `os`, and `worker_threads` on web
// workers. Only the calls upm makes on that path. Crypto, zlib and Buffer stay the web's
// (src/runtime.ts asks for each by name).
//
// The filesystem lives in memory, since upm's sync calls cannot wait for OPFS on this thread.
// What outlives the tab is the store's content, kept by ./opfs.ts as upm's store backend.

import type { Boot } from "./thread.ts";

type Entry = File | Dir | Link;
interface Meta {
  ino: number;
  /** Permission bits only. */
  mode: number;
  mtime: number;
  ctime: number;
}
export interface File extends Meta {
  kind: "file";
  /** Never changed in place, so a hardlink or a copy may share it. */
  data: Uint8Array;
}
export interface Dir extends Meta {
  kind: "dir";
  entries: Map<string, Entry>;
}
export interface Link extends Meta {
  kind: "link";
  target: string;
}

export interface ShimOptions {
  cwd?: string;
  home?: string;
  env?: Record<string, string>;
  platform?: string;
  arch?: string;
  /** What `process.report` says on Linux; upm installs the builds for this libc. */
  libc?: "glibc" | "musl";
}

const UMASK = 0o022;
let inodes = 0;
let clock = 0;
const root = dir(0o755);

/** Every entry under `at`, depth first, links not followed. */
export function* walk(at = "/"): Generator<[path: string, entry: Entry]> {
  const { node } = find(at, true, "scandir");
  if (node?.kind !== "dir") return;
  for (const name of [...node.entries.keys()].sort()) {
    const path = at === "/" ? `/${name}` : `${at}/${name}`;
    const entry = node.entries.get(name)!;
    yield [path, entry];
    if (entry.kind === "dir") yield* walk(path);
  }
}

/** Each shim made here, and how to give it another arch or libc. */
const retargets = new WeakMap<object, (options: ShimOptions) => void>();

/**
 * Install the shim as `globalThis.process`. Never over a real one: returns false and leaves it.
 * Over one of ours, it takes the `arch` and `libc` given, so the next install picks that
 * platform's optional builds. Linux wasm32 with glibc unless told otherwise, so the tab gets
 * the wasm ones (`-wasm32-wasi`), the only ones a browser can run; there is no Node version, so
 * every `engines.node` passes.
 */
export function installShim(options: ShimOptions = {}): boolean {
  const current = globalThis.process;
  if (current) {
    const retarget = retargets.get(current);
    retarget?.(options);
    return !!retarget;
  }
  (globalThis as { process?: unknown }).process = createProcess(options);
  return true;
}

export function createProcess(options: ShimOptions = {}) {
  const { platform = "linux" } = options;
  let libc = options.libc ?? "glibc";
  const cwd = options.cwd ?? "/project";
  const home = options.home ?? "/home/user";
  const env = { ...options.env };
  const modules: Record<string, unknown> = {
    fs,
    "fs/promises": fsp,
    path,
    os: { homedir: () => home },
    worker_threads: {
      isMainThread: true,
      parentPort: null,
      Worker: class extends Thread {
        constructor(entry: URL | string, options?: { workerData?: unknown }) {
          super(entry, options?.workerData, { platform, arch: proc.arch, env, cwd });
        }
      },
    },
  };
  const proc = {
    platform,
    arch: options.arch ?? "wasm32",
    env,
    versions: {},
    // config.ts finds npm's global `.npmrc` beside it.
    execPath: "/usr/local/bin/node",
    cwd: () => cwd,
    umask: () => UMASK,
    getBuiltinModule: (id: string) => modules[id.replace(/^node:/, "")],
    report: {
      getReport: () => ({ header: libc === "glibc" ? { glibcVersionRuntime: "2.39" } : {} }),
    },
  };
  // Only what is given: a read of the store, which gives neither, may run during an install.
  retargets.set(proc, (next) => {
    if (next.arch) proc.arch = next.arch;
    if (next.libc) libc = next.libc;
  });
  return proc;
}

// --- worker_threads: a web worker per thread ---

let threadIds = 0;

/**
 * A `Worker` on a web worker running ./thread.ts. Only the registry's: it only fetches. The unpack
 * and link workers write files, and a worker cannot reach this thread's filesystem, so those
 * throw here and their pools run on this thread, as they do with no `worker_threads`.
 */
class Thread {
  readonly threadId = ++threadIds;
  #worker: Worker;
  #listeners: Record<string, ((value: unknown) => void)[]> = { message: [], error: [], exit: [] };
  #exited = false;

  constructor(entry: URL | string, workerData: unknown, process: Boot["process"]) {
    // `upm-worker:<name>`, as vite.config.ts spells upm's worker entries.
    const name = String(entry).replace(/^upm-worker:/, "");
    if (name !== "registry") throw new Error(`upm's ${name} worker cannot run in a tab`);
    this.#worker = new Worker(new URL("./thread.ts", import.meta.url), {
      type: "module",
      name: `upm ${name}`,
    });
    this.#worker.onmessage = ({ data }) => this.#emit("message", data);
    this.#worker.onmessageerror = () => this.#fail(new Error("a message could not be read"));
    this.#worker.onerror = (event) => {
      event.preventDefault();
      const error = new Error(event.message || `upm's ${name} worker failed to load`);
      // The event carries no stack across threads, only where it was thrown.
      if (event.filename)
        error.stack += `\n    at ${event.filename}:${event.lineno}:${event.colno}`;
      this.#fail(error);
    };
    this.#worker.postMessage({ name, workerData, process } satisfies Boot);
  }

  on(type: string, listener: (value: never) => void): this {
    this.#listeners[type]?.push(listener as (value: unknown) => void);
    return this;
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.#worker.postMessage(message, transfer ?? []);
  }

  /** A tab has no process to hold open. */
  ref(): void {}
  unref(): void {}

  /** As Node's: `exit` follows, a tick later. */
  terminate(): Promise<number> {
    this.#worker.terminate();
    return Promise.resolve().then(() => {
      if (!this.#exited) this.#emit("exit", 1);
      this.#exited = true;
      return 1;
    });
  }

  /** As a Node thread that throws: `error`, then `exit`. */
  #fail(error: Error): void {
    this.#emit("error", error);
    void this.terminate();
  }

  #emit(type: string, value: unknown): void {
    if (this.#exited) return;
    for (const listener of this.#listeners[type]!) listener(value);
  }
}

// --- path: posix, strings only ---

function normalize(p: string): string {
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") out.push(part);
    else if (out.length > 0 && out.at(-1) !== "..") out.pop();
    else if (!absolute) out.push("..");
  }
  return (absolute ? "/" : "") + out.join("/") || (absolute ? "/" : ".");
}

function resolve(...parts: string[]): string {
  let at = "";
  for (let i = parts.length - 1; i >= 0 && !at.startsWith("/"); i--) {
    if (parts[i]) at = at ? `${parts[i]}/${at}` : parts[i]!;
  }
  if (!at.startsWith("/")) at = `${globalThis.process?.cwd?.() ?? "/"}/${at}`;
  return normalize(at);
}

function relative(from: string, to: string): string {
  const a = split(resolve(from));
  const b = split(resolve(to));
  let same = 0;
  while (same < a.length && a[same] === b[same]) same++;
  return [...a.slice(same).map(() => ".."), ...b.slice(same)].join("/");
}

function dirname(p: string): string {
  const trimmed = p.length > 1 ? p.replace(/\/+$/, "") : p;
  const at = trimmed.lastIndexOf("/");
  return at === -1 ? "." : at === 0 ? "/" : trimmed.slice(0, at);
}

function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").at(-1) ?? "";
}

const split = (p: string) => p.split("/").filter(Boolean);

export const path = {
  sep: "/",
  normalize,
  resolve,
  relative,
  dirname,
  basename,
  join: (...parts: string[]) => normalize(parts.filter(Boolean).join("/") || "."),
  isAbsolute: (p: string) => p.startsWith("/"),
};

// --- fs ---

/** A strictly rising clock, so two changes never share a stamp: upm's install state reads them. */
function now(): number {
  return (clock = Math.max(clock + 0.001, Date.now()));
}

function meta(mode: number): Meta {
  const t = now();
  return { ino: ++inodes, mode, mtime: t, ctime: t };
}

function dir(mode: number): Dir {
  return { kind: "dir", entries: new Map(), ...meta(mode) };
}

function fail(code: string, syscall: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), {
    code,
    syscall,
    path,
  });
}

interface Found {
  parent: Dir;
  name: string;
  node: Entry | undefined;
  /** The path with every link on the way resolved. */
  real: string;
}

/** Where `p` is. Links on the way are followed, the last one only when `follow`. */
function find(p: string, follow: boolean, syscall: string): Found {
  let parts = split(resolve(p));
  let at = root;
  let real = "";
  let hops = 0;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    const node = at.entries.get(name);
    const last = i === parts.length - 1;
    if (node?.kind === "link" && (follow || !last)) {
      if (++hops > 40) throw fail("ELOOP", syscall, p);
      parts = [...split(resolve(real || "/", node.target)), ...parts.slice(i + 1)];
      at = root;
      real = "";
      i = -1;
      continue;
    }
    if (last) return { parent: at, name, node, real: `${real}/${name}` };
    if (!node) throw fail("ENOENT", syscall, p);
    if (node.kind !== "dir") throw fail("ENOTDIR", syscall, p);
    at = node;
    real += `/${name}`;
  }
  return { parent: root, name: "", node: root, real: "/" };
}

function existing(p: string, follow: boolean, syscall: string): Found & { node: Entry } {
  const found = find(p, follow, syscall);
  if (!found.node) throw fail("ENOENT", syscall, p);
  return found as Found & { node: Entry };
}

function add(parent: Dir, name: string, node: Entry): void {
  parent.entries.set(name, node);
  parent.mtime = parent.ctime = now();
}

function remove(parent: Dir, name: string): void {
  parent.entries.delete(name);
  parent.mtime = parent.ctime = now();
}

/** The fields upm reads: its install state stamps a file by size, times and inode. */
function stats(node: Entry, bigint = false) {
  const size =
    node.kind === "file" ? node.data.length : node.kind === "dir" ? 4096 : node.target.length;
  const ns = (ms: number) => BigInt(Math.round(ms * 1e6));
  const fields = bigint
    ? {
        size: BigInt(size),
        ino: BigInt(node.ino),
        mtimeNs: ns(node.mtime),
        ctimeNs: ns(node.ctime),
      }
    : { size, ino: node.ino, mtimeMs: node.mtime, ctimeMs: node.ctime };
  return { ...fields, ...kinds(node) };
}

function kinds(node: Entry) {
  return {
    isFile: () => node.kind === "file",
    isDirectory: () => node.kind === "dir",
    isSymbolicLink: () => node.kind === "link",
  };
}

type Encoding = string | { encoding?: string | null } | undefined;

function decode(data: Uint8Array, options: Encoding): string | Uint8Array {
  const encoding = typeof options === "string" ? options : options?.encoding;
  // Shared, not copied: a file's data is replaced, never changed in place, and upm never
  // writes into what it reads. A copy per read was a second store's worth of bytes on `nuxt`.
  if (!encoding) return data;
  if (encoding === "latin1") return Array.from(data, (byte) => String.fromCharCode(byte)).join("");
  return new TextDecoder().decode(data);
}

const time = (t: Date | number | string) => (t instanceof Date ? t.getTime() : Number(t) * 1000);

function mkdirp(p: string): string | undefined {
  let found: Found;
  try {
    found = find(p, false, "mkdir");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    const first = mkdirp(dirname(resolve(p)));
    const made = find(p, false, "mkdir");
    add(made.parent, made.name, dir(0o755));
    return first ?? resolve(p);
  }
  if (!found.node) {
    add(found.parent, found.name, dir(0o755));
    return resolve(p);
  }
  if (find(p, true, "mkdir").node?.kind === "dir") return undefined;
  throw fail("EEXIST", "mkdir", p);
}

const sync = {
  existsSync(p: string): boolean {
    try {
      return find(p, true, "access").node !== undefined;
    } catch {
      return false;
    }
  },
  readFileSync(p: string, options?: Encoding) {
    const { node } = existing(p, true, "open");
    if (node.kind !== "file") throw fail("EISDIR", "read", p);
    return decode(node.data, options);
  },
  statSync: (p: string, options?: { bigint?: boolean }) =>
    stats(existing(p, true, "stat").node, options?.bigint),
  lstatSync: (p: string, options?: { bigint?: boolean }) =>
    stats(existing(p, false, "lstat").node, options?.bigint),
  readdirSync(p: string, options?: { withFileTypes?: boolean }) {
    const { node } = existing(p, true, "scandir");
    if (node.kind !== "dir") throw fail("ENOTDIR", "scandir", p);
    const names = [...node.entries.keys()].sort();
    if (!options?.withFileTypes) return names;
    return names.map((name) => ({
      name,
      parentPath: p,
      path: p,
      ...kinds(node.entries.get(name)!),
    }));
  },
  readlinkSync(p: string): string {
    const { node } = existing(p, false, "readlink");
    if (node.kind !== "link") throw fail("EINVAL", "readlink", p);
    return node.target;
  },
  realpathSync: (p: string): string => existing(p, true, "realpath").real,
  mkdirSync(p: string, options?: { recursive?: boolean }): string | undefined {
    if (options?.recursive) return mkdirp(p);
    const found = find(p, false, "mkdir");
    if (found.node) throw fail("EEXIST", "mkdir", p);
    add(found.parent, found.name, dir(0o755));
    return undefined;
  },
  writeFileSync(
    p: string,
    data: string | Uint8Array,
    options?: string | { mode?: number; flag?: string },
  ): void {
    const { mode = 0o666, flag = "w" } = typeof options === "object" ? options : {};
    let found = find(p, false, "open");
    if (found.node && flag.includes("x")) throw fail("EEXIST", "open", p);
    if (found.node?.kind === "link") found = find(p, true, "open");
    // A copy: the caller may reuse its buffer.
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    if (found.node) {
      if (found.node.kind === "dir") throw fail("EISDIR", "open", p);
      if (!(found.node.mode & 0o200)) throw fail("EACCES", "open", p);
      Object.assign(found.node, { data: bytes, mtime: now(), ctime: now() });
    } else {
      add(found.parent, found.name, { kind: "file", data: bytes, ...meta(mode & ~UMASK) });
    }
  },
  renameSync(from: string, to: string): void {
    const a = existing(from, false, "rename");
    const b = find(to, false, "rename");
    if (a.node === b.node) return;
    if (b.node && a.node.kind === "dir") {
      if (b.node.kind !== "dir") throw fail("ENOTDIR", "rename", to);
      if (b.node.entries.size > 0) throw fail("ENOTEMPTY", "rename", to);
    } else if (b.node?.kind === "dir") throw fail("EISDIR", "rename", to);
    if (a.node.kind === "dir" && `${b.real}/`.startsWith(`${a.real}/`)) {
      throw fail("EINVAL", "rename", from);
    }
    if (b.node) remove(b.parent, b.name);
    remove(a.parent, a.name);
    add(b.parent, b.name, a.node);
    a.node.ctime = now();
  },
  rmSync(p: string, options?: { recursive?: boolean; force?: boolean }): void {
    let found: Found;
    try {
      found = find(p, false, "rm");
    } catch (error) {
      if (options?.force && (error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
    if (!found.node) {
      if (options?.force) return;
      throw fail("ENOENT", "rm", p);
    }
    if (found.node.kind === "dir" && !options?.recursive) {
      throw Object.assign(new Error(`Path is a directory: rm returned EISDIR ${p}`), {
        code: "ERR_FS_EISDIR",
      });
    }
    remove(found.parent, found.name);
  },
  unlinkSync(p: string): void {
    const found = existing(p, false, "unlink");
    if (found.node.kind === "dir") throw fail("EISDIR", "unlink", p);
    remove(found.parent, found.name);
  },
  rmdirSync(p: string): void {
    const found = existing(p, false, "rmdir");
    if (found.node.kind !== "dir") throw fail("ENOTDIR", "rmdir", p);
    if (found.node.entries.size > 0) throw fail("ENOTEMPTY", "rmdir", p);
    remove(found.parent, found.name);
  },
  symlinkSync(target: string, p: string): void {
    const found = find(p, false, "symlink");
    if (found.node) throw fail("EEXIST", "symlink", p);
    add(found.parent, found.name, { kind: "link", target, ...meta(0o777) });
  },
  linkSync(from: string, to: string): void {
    const { node } = existing(from, false, "link");
    if (node.kind === "dir") throw fail("EPERM", "link", from);
    const found = find(to, false, "link");
    if (found.node) throw fail("EEXIST", "link", to);
    node.ctime = now();
    add(found.parent, found.name, node);
  },
  utimesSync(p: string, _atime: Date | number, mtime: Date | number): void {
    const { node } = existing(p, true, "utime");
    node.mtime = time(mtime);
    node.ctime = now();
  },
};

/** `fs/promises`: each sync call, run a tick later, as a real one lands later. */
const fsp = Object.fromEntries(
  Object.entries(sync)
    .filter(([name]) => name !== "existsSync")
    .map(([name, call]) => [
      name.slice(0, -"Sync".length),
      (...args: unknown[]) =>
        Promise.resolve().then(() => (call as (...a: unknown[]) => unknown)(...args)),
    ]),
);

export const fs = { ...sync, promises: fsp };

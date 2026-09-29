// Small helpers shared across modules. Nothing here knows about packages.
import type { Dirent } from "node:fs";
import { builtin } from "./builtin.ts";
import type { PackageIndex } from "./store.ts";

/** The shape of a store index. Here, and not in store.ts, because the link worker reads one too. */
export function isIndex(value: unknown): value is PackageIndex {
  const index = value as PackageIndex | null;
  return (
    typeof index === "object" &&
    index !== null &&
    typeof index.integrity === "string" &&
    Array.isArray(index.files) &&
    index.files.every(
      (file) =>
        typeof file?.path === "string" &&
        typeof file?.blob === "string" &&
        // A blob is base64url and a suffix, so `..` is never in one: a hand-edited index must
        // not be able to link content from outside `files/`.
        !file.blob.includes("..") &&
        typeof file?.size === "number",
    )
  );
}

/** A missing directory reads as empty: callers here are sweeping, not asserting. */
export async function list(dir: string): Promise<Dirent[]> {
  return await builtin.fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
}

export async function exists(path: string): Promise<boolean> {
  return await builtin.fsp.stat(path).then(
    () => true,
    () => false,
  );
}

/** Byte length on disk, or -1 when the file is missing. */
export async function sizeOf(path: string): Promise<number> {
  return await builtin.fsp.stat(path).then(
    (found) => found.size,
    () => -1,
  );
}

/**
 * The same, synchronously. A cached stat is a handful of microseconds; the promise and the
 * threadpool hop around it cost several times that, and a caller checking every file of a
 * package in a row pays it thousands of times over.
 */
export function sizeOfSync(path: string): number {
  try {
    // A missing file is the common answer, and an error for it costs more than the stat.
    return builtin.fs.statSync(path, { throwIfNoEntry: false })?.size ?? -1;
  } catch {
    return -1;
  }
}

/** An error's message with its code, as the CLI and the logs print it. */
export function describe(error: unknown): string {
  const { code, message, cause } = error as {
    code?: string;
    message?: string;
    cause?: { code?: string };
  };
  const reason = code ?? cause?.code;
  const text = message ?? String(error);
  return reason ? `${text} (${reason})` : text;
}

const WIN = globalThis.process?.platform === "win32";

/**
 * `symlink` arguments for a link at `at` to the relative `target`. Links stay relative, so a tree
 * survives being moved. Windows needs a privilege for a symlink but not for a junction, and a
 * junction must be absolute. Every link there leads to a directory: a bin is a shim, not a link.
 */
export function linkArgs(target: string, at: string): [string, "junction"?] {
  if (!WIN) return [target];
  const { dirname, resolve } = builtin.path;
  return [resolve(dirname(at), target), "junction"];
}

/** The target of the link at `at` as `linkArgs` was given it: a junction reads back absolute. */
export async function readLink(at: string): Promise<string | undefined> {
  return asGiven(at, await builtin.fsp.readlink(at).catch(() => undefined));
}

/** `readLink`, synchronously. */
export function readLinkSync(at: string): string | undefined {
  let found: string | undefined;
  try {
    found = builtin.fs.readlinkSync(at);
  } catch {
    return undefined;
  }
  return asGiven(at, found);
}

function asGiven(at: string, found: string | undefined): string | undefined {
  const { dirname, isAbsolute, relative } = builtin.path;
  if (found === undefined || !WIN || !isAbsolute(found)) return found;
  return relative(dirname(at), found);
}

/**
 * `rename` over a file. Windows refuses to replace a file another rename or reader holds open
 * for a moment, so retry there; elsewhere the replace is atomic and never busy.
 */
export async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await builtin.fsp.rename(from, to);
    } catch (error) {
      const code = (error as { code?: string }).code;
      const busy = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!busy || attempt === 10 || !WIN) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }
}

/** Whether a process could still be writing under that pid. Unknowable means yes. */
export function alive(pid: number): boolean {
  const kill = globalThis.process?.kill;
  if (!kill) return true; // no way to ask, off Node
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH"; // EPERM: alive, just not ours
  }
}

/**
 * Benchmark instrumentation, on only under `UPM_TRACE` or `UPM_PHASES`: `src/trace.ts` is then
 * loaded by the bin and the workers, never otherwise, and installs itself here. Off, a call
 * tests this constant and does nothing else. `trace(name)` is a phase mark; with fields it is
 * one event of the tarball path. `tick`/`take` are a worker's per-task counters.
 */
export const tracing: boolean = !!(
  globalThis.process?.env?.UPM_TRACE || globalThis.process?.env?.UPM_PHASES
);

export interface Tracer {
  trace(event: string, fields?: Record<string, unknown>): void;
  tick(name: string, ms: number): void;
  take(): Record<string, number>;
  flush(): void;
}

const tracer = (): Tracer | undefined => (globalThis as { __upmTrace?: Tracer }).__upmTrace;

export function trace(event: string, fields?: Record<string, unknown>): void {
  if (tracing) tracer()?.trace(event, fields);
}

export function tick(name: string, ms: number): void {
  if (tracing) tracer()?.tick(name, ms);
}

export function take(): Record<string, number> {
  return tracer()?.take() ?? {};
}

export function flushTrace(): void {
  tracer()?.flush();
}

/** Now, on a clock every thread shares (ms since the epoch, fractional). */
export function now(): number {
  return performance.timeOrigin + performance.now();
}

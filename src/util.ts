// Small helpers shared across modules, and what a worker needs to read a package.json.
import type { Dirent } from "node:fs";
import { builtin } from "./builtin.ts";
import type { FileEntry, PackageIndex } from "./store.ts";

/** The shape of a store index. Here, and not in store.ts, because the link worker reads one too. */
export function isIndex(value: unknown): value is PackageIndex {
  const index = value as PackageIndex | null;
  return (
    typeof index === "object" &&
    index !== null &&
    typeof index.integrity === "string" &&
    (index.name === undefined || typeof index.name === "string") &&
    (index.version === undefined || typeof index.version === "string") &&
    (index.aliases === undefined || isNames(index.aliases)) &&
    Array.isArray(index.files) &&
    index.files.every(
      (file) =>
        // A hand-edited index must not be able to place a file outside its package.
        isSafePath(file?.path) &&
        typeof file?.blob === "string" &&
        // A blob is base64url and a suffix, so `..` is never in one: a hand-edited index must
        // not be able to link content from outside `files/`.
        !file.blob.includes("..") &&
        typeof file?.size === "number",
    )
  );
}

// A `\`, a drive letter, a leading or doubled `/`, or a `.` or `..` part.
const UNSAFE_PATH = /\\|^[a-z]:|(?:^|\/)\.{0,2}(?:\/|$)/i;

/** What the tar reader lets through: relative, `/`-separated, no `.`, `..` or empty part. */
export function isSafePath(path: unknown): path is string {
  return typeof path === "string" && !UNSAFE_PATH.test(path);
}

/** A registry package as the tree installs it: `name` is the package it must be. */
export interface Identity {
  name: string;
  version: string;
}

/**
 * Why an index is not the package it would be linked as, or nothing. The store is keyed by
 * integrity alone, so this is what stops a lockfile giving one package another's tarball. An
 * alias is checked against the package it names, which its entry records and its dependents'
 * own package.json vouch for (see `misdeclared`). An index from before names were kept, or a
 * tarball whose package.json has none, cannot say.
 */
export function mismatch(index: PackageIndex, want: Identity): string | undefined {
  const { name, version } = index;
  const named = name === undefined || name === want.name;
  const versioned = version === undefined || plain(version) === plain(want.version);
  if (named && versioned) return undefined;
  return `its tarball is ${name ?? want.name}@${version ?? want.version}, not ${want.name}@${want.version}`;
}

/** Hosts whose archive url stands in for a clone, by shortcut: domain, then the url of a ref. */
const HOSTS: Record<string, [domain: string, archive: (path: string, ref: string) => string]> = {
  github: ["github.com", (path, ref) => `https://codeload.github.com/${path}/tar.gz/${ref}`],
  gitlab: [
    "gitlab.com",
    (path, ref) =>
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}/repository/archive.tar.gz?sha=${ref}`,
  ],
  bitbucket: ["bitbucket.org", (path, ref) => `https://bitbucket.org/${path}/get/${ref}.tar.gz`],
};
// `git:`, `git+https:`, `git+ssh:` and the like; only the first few have a host to ask.
const GIT_URL_RE = /^git(?:\+[a-z]+)?:/i;
const GIT_OK_RE = /^git(?:\+(?:https?|ssh))?:\/\//i;
// npm's host shortcuts, `github:user/repo`.
const HOST_RE = /^(github|gitlab|bitbucket|gist|sourcehut):/i;
// npm's GitHub shortcut, `user/repo#ref`.
const SHORTCUT_RE = /^[^@%/\s.~-][^:@%/\s]*\/[^:@\s/%#]+(?:#.*)?$/;
// scp's `git@github.com:user/repo`.
const SCP_RE = /^[^@/:\s]+@[^@/:\s]+\.[^@/:\s]+:/;

/**
 * Whether a spec names a git repository: a git url, scp's `git@host:user/repo`, `host:user/repo`,
 * `user/repo` or an http(s) url of a known host ending in `.git`. A tarball's file name is none.
 */
export function isGit(s: string): boolean {
  const at = s.split("#", 1)[0]!;
  if (/^https?:\/\//i.test(at)) {
    const url = URL.canParse(at) ? new URL(at) : undefined;
    const known = Object.values(HOSTS).some(([domain]) => domain === url?.hostname);
    return known && /\.git\/?$/i.test(url!.pathname);
  }
  return (
    GIT_URL_RE.test(s) ||
    HOST_RE.test(s) ||
    (SHORTCUT_RE.test(s) && !/\.(?:tgz|tar\.gz|tar)$/i.test(at)) ||
    SCP_RE.test(s)
  );
}

/**
 * The archive url of a git spec on a host in `HOSTS`, read as the tarball it is. There is no
 * clone, so another host, a `semver:` range or a `path:` in the ref throws why. No ref is `HEAD`.
 */
export function gitArchive(s: string): string {
  const hash = s.indexOf("#");
  const at = hash < 0 ? s : s.slice(0, hash);
  const ref = hash < 0 ? "" : s.slice(hash + 1);
  let host: string | undefined;
  let path: string;
  const shortcut = HOST_RE.exec(at)?.[1]?.toLowerCase();
  if (shortcut) {
    if (!HOSTS[shortcut])
      throw new Error(`only ${Object.keys(HOSTS).join(", ")} shortcuts install`);
    [host, path] = [shortcut, at.slice(shortcut.length + 1)];
  } else if (SHORTCUT_RE.test(at)) {
    [host, path] = ["github", at];
  } else {
    // `git://host/path`, `git+ssh://git@host:path`, `git@host:path`. Only a url has a port.
    const url =
      GIT_OK_RE.test(at) || /^https?:/i.test(at)
        ? /^[a-z+]+:\/\/(?:[^@/]+@)?([^@/:]+)(?::\d+(?=\/))?[:/](.*)$/i.exec(at)
        : /^[^@/:]+@([^@/:]+):(.*)$/.exec(at);
    const domain = url?.[1]!.toLowerCase();
    host = Object.keys(HOSTS).find((name) => HOSTS[name]![0] === domain);
    if (!host)
      throw new Error("upm installs git only from GitHub, GitLab or Bitbucket, as a tarball");
    path = url![2]!;
  }
  const parts = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  // GitLab nests groups; the others are always `user/repo`.
  if (parts.length < 2 || (host !== "gitlab" && parts.length > 2))
    throw new Error("no user/repo in it");
  if (parts.some((part) => !/^[\w.-]+$/.test(part) || /^(?:\.\.?|-)$/.test(part))) {
    throw new Error("user/repo is malformed");
  }
  // A ref name cannot hold a `:`, so it marks npm's `semver:` and `path:`, which need a clone.
  if (ref.includes(":")) throw new Error("only a commit, branch or tag can follow the #");
  return HOSTS[host]![1](parts.join("/"), encodeURIComponent(ref || "HEAD"));
}

/**
 * What a package.json says it installs under another name: `"x": "npm:real@^1"` is `x` ->
 * `real`, and a url is its own: `"x": "https://…"` is `x` -> the url, a git spec its archive's.
 * Peers are left out: one is settled against whatever the tree holds under its name.
 */
export function aliasesOf(manifest: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const json = manifest as Record<string, unknown> | null;
  for (const group of ["dependencies", "optionalDependencies"]) {
    const deps = json?.[group];
    if (typeof deps !== "object" || deps === null) continue;
    for (const [name, spec] of Object.entries(deps)) {
      const trimmed = typeof spec === "string" ? spec.trim() : "";
      if (isGit(trimmed)) {
        try {
          out[name] = gitArchive(trimmed);
        } catch {
          delete out[name]; // refused where it is resolved
        }
        continue;
      }
      if (/^https?:\/\//i.test(trimmed)) {
        out[name] = trimmed;
        continue;
      }
      if (!trimmed.startsWith("npm:")) {
        delete out[name]; // optionalDependencies has the last word, as in npm
        continue;
      }
      const rest = trimmed.slice(4);
      const at = rest.indexOf("@", 1);
      out[name] = at === -1 ? rest : rest.slice(0, at);
    }
  }
  return out;
}

/**
 * Why a package's own edges are not what its package.json declares, or nothing. `edges` is each
 * edge's name and the package it landed on; `declared` is `aliasesOf` the package.json. A lock
 * cannot make an edge an alias its dependent never wrote, or undo one it did.
 */
export function misdeclared(
  declared: Record<string, string>,
  edges: Record<string, string>,
): string | undefined {
  for (const [name, real] of Object.entries(edges)) {
    const want = Object.hasOwn(declared, name) ? declared[name]! : name;
    if (want !== real) return `its package.json makes ${name} ${want}, not ${real}`;
  }
  return undefined;
}

/**
 * `aliasesOf` an entry's package.json: kept in its index, else — an index from before they
 * were kept — read from the stored file, set on the index and the index added to `read`, for
 * `keepAliases` to write. One that cannot be read declares nothing, and sets nothing.
 */
export function declaredIn(
  index: PackageIndex,
  blobPath: (file: FileEntry) => string,
  read?: PackageIndex[],
): Record<string, string> {
  if (index.aliases) return index.aliases;
  const file = index.files.find((entry) => entry.path === "package.json");
  let text = "";
  try {
    if (file) text = builtin.fs.readFileSync(blobPath(file), "utf8");
  } catch {
    return {};
  }
  let aliases = {};
  try {
    // Without a BOM, as the unpack's decoder reads it.
    aliases = aliasesOf(JSON.parse(text.replace(/^\uFEFF/, "")));
  } catch {}
  read?.push(index);
  return (index.aliases = aliases);
}

/**
 * `misdeclared` against what an index's package.json declares. Aliases an older upm kept can
 * miss a spec it did not read, as git, so a failure reads the package.json again before it stands.
 */
export function misdeclaredIn(
  index: PackageIndex,
  blobPath: (file: FileEntry) => string,
  edges: Record<string, string>,
  read?: PackageIndex[],
): string | undefined {
  const kept = index.aliases !== undefined;
  const wrong = misdeclared(declaredIn(index, blobPath, read), edges);
  if (!wrong || !kept) return wrong;
  delete index.aliases;
  return misdeclared(declaredIn(index, blobPath, read), edges);
}

/** A map of names to names, as an index keeps its aliases. */
export function isNames(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((name) => typeof name === "string")
  );
}

/**
 * A version as a registry keys it: `v1.2.3+build` is `1.2.3`, and a loose one old npm
 * published, `1.2.3beta`, is `1.2.3-beta`.
 */
function plain(version: string): string {
  const m = /^[=v\s]*0*(\d+)\.0*(\d+)\.0*(\d+)(?:-?([\da-z-]+(?:\.[\da-z-]+)*))?(?:\+.*)?$/i.exec(
    version.trim(),
  );
  return m ? `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-${m[4]}` : ""}` : version.trim();
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

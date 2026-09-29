// The hidden install state, written inside `node_modules` after every successful link.
// It exists so a warm install checks a few directories instead of one stat per package: if the recorded
// hash still describes what we would install, the tree on disk is already that tree.
// IDEA.md 4, tier 1.
import { builtin } from "./builtin.ts";
import { graphHash, shortHash } from "./keys.ts";
import { pid } from "./runtime.ts";
import { replaceFile } from "./util.ts";
import type { Resolution } from "./resolve.ts";
import type { WorkspaceProof } from "./workspaces.ts";

export const STATE_FILE = ".upm.json";
export const TREE_LOCK = ".upm.lock";

export interface InstallState {
  version: 1;
  /** Covers the resolved graph AND the flags that change what gets linked. */
  hash: string;
  /** Sorted store keys that should exist under `node_modules/.upm`. */
  entries: string[];
  /** False when something the graph named could not be linked, so a check must run again. */
  complete: boolean;
  /** Absolute path of the content store this tree was linked from. */
  store: string;
  /** Linked under `production`, so an install on its own behalf (`run`'s) keeps it that way. */
  production?: true;
  /**
   * `inputsHash` of what the install was made from: the lockfile, the root manifest and each
   * workspace's. The next install with the same bytes and settings can find the tree up to
   * date without reading the graph, which is most of a no-op install.
   */
  inputs?: string;
  /** What that install reported, said again by one that finds the tree up to date. */
  summary?: { packages: number; otherPlatforms: number; warnings: string[] };
  /** The root's direct links (name -> target) and bin names: what the up-to-date check reads. */
  root?: TopLinks;
  /** The same for each workspace's own `node_modules`, by its path. */
  tops?: Record<string, TopLinks>;
  /**
   * What proves the workspace set unchanged, so the next install need not glob for it:
   * see `listWorkspaces`. Absent when the set could not be proven.
   */
  workspaces?: WorkspaceProof;
  /**
   * The lockfile and the root manifest as `stat` saw them when `inputs` was computed, and
   * the rest of the inputs as `settingsOf` spells them. The same stamps again mean the same
   * bytes — a change of content moves the ctime, which no unprivileged tool can set back —
   * so the next install compares these and skips reading and hashing the two files;
   * different stamps mean hashing, never a miss.
   */
  stamps?: { lock: Stamp; manifest: Stamp; settings: string };
  /**
   * Every local tarball the lockfile names, by source, with the stamp it had just before an
   * install checked it against the lockfile or read it into one, or null when none did. A local
   * tarball is read like package.json: the lockfile holds while each is the file it was, and one
   * with another stamp is checked again before the lockfile is trusted. Absent from a state an
   * older upm wrote, which is then no proof of anything.
   */
  tarballs?: Record<string, Stamp | null>;
}

/** A top's direct links (name -> target) and the bin names it places. */
export interface TopLinks {
  links: Record<string, string>;
  bins: string[];
}

/** A file as `stat` sees it: size, mtime and ctime in nanoseconds, inode, as decimal strings. */
export type Stamp = [size: string, mtime: string, ctime: string, ino: string];

/** The file's stamp, or nothing when it cannot be stat'd. */
export function stampOf(path: string): Stamp | undefined {
  try {
    const { size, mtimeNs, ctimeNs, ino } = builtin.fs.statSync(path, { bigint: true });
    return [String(size), String(mtimeNs), String(ctimeNs), String(ino)];
  } catch {
    return undefined;
  }
}

export function sameStamp(a: Stamp | undefined, b: Stamp | undefined): boolean {
  return a !== undefined && b !== undefined && a.every((part, i) => part === b[i]);
}

export interface StateFlags {
  production: boolean;
  store: string;
}

/** Everything the resolution and the linked tree are a function of, besides the store's content. */
export interface Inputs {
  /** The lockfile's text, byte for byte. */
  lock: string;
  /** The root's package.json, parsed: what `sameTree` compares the lockfile with. */
  manifest: unknown;
  /** Each workspace's path and parsed package.json, in order, when there are any. */
  workspaces?: [string, unknown][];
  production: boolean;
  store: string;
  /** The registry and scope registries the `.npmrc` gives, as `hosts` reads them. */
  hosts: unknown;
  /** `currentPlatform()`. */
  platform: unknown;
}

/**
 * One value over the inputs. Same value, same resolution, same `stateHash` — the resolution
 * is a pure function of these — so a repeat install compares this and skips the graph.
 */
export function inputsHash(inputs: Inputs): Promise<string> {
  const settings = settingsOf(inputs);
  // Without workspaces, the same value as before they counted: an older state still matches.
  const workspaces = inputs.workspaces?.length ? `${JSON.stringify(inputs.workspaces)}\n` : "";
  const manifest = JSON.stringify(inputs.manifest);
  return shortHash(`upm-inputs-1\n${manifest}\n${workspaces}${settings}\n${inputs.lock}`);
}

/** The inputs that are not the two files, as one string. */
export function settingsOf(inputs: Omit<Inputs, "lock" | "manifest" | "workspaces">): string {
  const { production, store, hosts, platform } = inputs;
  return JSON.stringify([production, builtin.path.resolve(store), hosts, platform]);
}

/**
 * The one value a warm install compares. `graphHash` covers the resolved graph, but not what
 * we choose to link out of it: `--production` drops dev packages, and the same package can be
 * dev or optional in one resolution and not in another. The store path is in too — the same
 * graph linked from a different store is a different set of files.
 */
export async function stateHash(resolution: Resolution, flags: StateFlags): Promise<string> {
  const lines = [
    "upm-state-1",
    await graphHash(resolution),
    `production:${flags.production ? 1 : 0}`,
    `store:${builtin.path.resolve(flags.store)}`,
  ];
  for (const id of Object.keys(resolution.packages).sort()) {
    const pkg = resolution.packages[id]!;
    // integrity too: graphHash covers the store keys, not the bins we are about to link,
    // and a `--production` run links a different subset of the same graph.
    const bin = Object.entries(pkg.bin).sort().flat().join(",");
    if (pkg.local !== undefined) {
      lines.push(`${id}:local:${pkg.local}:${bin}`); // no content, and always linked
      continue;
    }
    lines.push(`${id}:${pkg.integrity}:${bin}:${pkg.dev ? "d" : ""}${pkg.optional ? "o" : ""}`);
  }
  return shortHash(lines.join("\n"));
}

/** `dir` is the project directory; the file itself lives in its `node_modules`. */
export function statePath(dir: string): string {
  return builtin.path.join(dir, "node_modules", STATE_FILE);
}

/**
 * The recorded state, or `undefined` for "unknown". Every failure — missing, torn, hand-edited,
 * unreadable — is unknown, never a throw: this file is an optimization, and the worst it may
 * ever cost is a full link. A false match, in contrast, would leave a broken tree installed.
 */
export async function readState(dir: string): Promise<InstallState | undefined> {
  let raw: string;
  try {
    // Sync: one small file at startup, read before anything else the threadpool could do.
    // With the reads of the same kind on the no-op path, it keeps `fs/promises` (1.2 ms to
    // load) out of an install that finds nothing to do.
    raw = builtin.fs.readFileSync(statePath(dir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeState(dir: string, state: InstallState): Promise<void> {
  await writeInside(statePath(dir), `${JSON.stringify(state, undefined, 2)}\n`);
}

/**
 * A copy of the lockfile the tree was last linked from, as npm and pnpm keep one in
 * `node_modules`: an install that finds no lockfile takes this one back while it still
 * describes package.json. It says which versions to install, never that they are installed.
 */
export function treeLockPath(dir: string): string {
  return builtin.path.join(dir, "node_modules", TREE_LOCK);
}

/** The copy's text, or nothing. */
export function readTreeLock(dir: string): string | undefined {
  try {
    return builtin.fs.readFileSync(treeLockPath(dir), "utf8");
  } catch {
    return undefined;
  }
}

export async function writeTreeLock(dir: string, text: string): Promise<void> {
  await writeInside(treeLockPath(dir), text);
}

async function writeInside(file: string, text: string): Promise<void> {
  const temp = `${file}.${pid}-${globalThis.crypto.randomUUID()}.tmp`;
  try {
    await builtin.fsp.mkdir(builtin.path.dirname(file), { recursive: true });
    await builtin.fsp.writeFile(temp, text);
    await replaceFile(temp, file); // atomic, so a reader never sees a half-written file
  } catch (error) {
    await builtin.fsp.rm(temp, { force: true });
    throw fail(`cannot write ${file}: ${(error as Error).message}`);
  }
}

/** Called before a tree is touched: while we are rewriting it, its state is unknown. */
export async function clearState(dir: string): Promise<void> {
  try {
    await builtin.fsp.rm(statePath(dir), { force: true });
  } catch (error) {
    throw fail(`cannot remove ${statePath(dir)}: ${(error as Error).message}`);
  }
}

function isState(value: unknown): value is InstallState {
  const state = value as InstallState | null;
  return (
    typeof state === "object" &&
    state !== null &&
    state.version === 1 &&
    typeof state.hash === "string" &&
    typeof state.store === "string" &&
    typeof state.complete === "boolean" &&
    Array.isArray(state.entries) &&
    state.entries.every((entry) => typeof entry === "string") &&
    (state.inputs === undefined ||
      (typeof state.inputs === "string" &&
        typeof state.summary?.packages === "number" &&
        typeof state.summary.otherPlatforms === "number" &&
        Array.isArray(state.summary.warnings) &&
        state.summary.warnings.every((w) => typeof w === "string") &&
        isRecord(state.tops ?? {}) &&
        [state.root, ...Object.values(state.tops ?? {})].every(isTop) &&
        (state.stamps === undefined ||
          (isStamp(state.stamps.lock) &&
            isStamp(state.stamps.manifest) &&
            typeof state.stamps.settings === "string")))) &&
    (state.tarballs === undefined ||
      (isRecord(state.tarballs) &&
        Object.values(state.tarballs).every((stamp) => stamp === null || isStamp(stamp))))
    // `workspaces` is checked by its one reader, `listWorkspaces`: nothing else loads it.
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTop(value: unknown): value is TopLinks {
  const top = value as TopLinks | undefined;
  return (
    isRecord(top?.links) &&
    Object.values(top.links).every((to) => typeof to === "string") &&
    Array.isArray(top.bins) &&
    top.bins.every((bin) => typeof bin === "string")
  );
}

export function isStamp(value: unknown): value is Stamp {
  return Array.isArray(value) && value.length === 4 && value.every((p) => typeof p === "string");
}

function fail(message: string): Error {
  return Object.assign(new Error(message), { code: "ESTATE" });
}

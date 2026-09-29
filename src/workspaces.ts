// Which directories are workspaces of a root, and which root a directory belongs to. Declared
// in package.json `workspaces` and found the way npm's map-workspaces does, so a monorepo
// that npm, yarn or bun reads is read the same here. Node-only, like link.ts.
import { builtin } from "./builtin.ts";
import { parseManifest } from "./package-json.ts";
import { isRecord, isStamp, readState, sameStamp, stampOf } from "./state.ts";
import type { RootManifest } from "./resolve.ts";
import type { InstallState, Stamp } from "./state.ts";

export interface Workspace {
  /** Relative to the root, `/` separators, no leading `./`. */
  path: string;
  /** Absolute. */
  dir: string;
  /** `manifest.name`, else the folder name. */
  name: string;
  /** `manifest.version`, else `0.0.0`. */
  version: string;
  manifest: RootManifest;
}

/**
 * The declared patterns, split into the ones to expand and the ones to leave out. A `!`
 * negates; an even number of them does not. A leading `./` or `/` is dropped. A negation only
 * covers the patterns before it: `packages/b/a` after `!packages/b/**` is found after all, so
 * the negation goes. What is left of the negations then drops any pattern they cover whole.
 */
export function workspacePatterns(manifest: RootManifest): {
  patterns: string[];
  negated: string[];
} {
  const declared = manifest.workspaces;
  if (declared === undefined) return { patterns: [], negated: [] };
  const list = Array.isArray(declared) ? declared : declared?.packages;
  if (!Array.isArray(list) || list.some((pattern) => typeof pattern !== "string")) {
    throw fail("workspaces must be an array of patterns, or { packages: [...] }");
  }
  const { matchesGlob } = builtin.path;
  const patterns: string[] = [];
  let negated: string[] = [];
  for (const raw of list) {
    const bangs = /^!*/.exec(raw)![0].length;
    const pattern = raw.slice(bangs).replace(/^\.?\/+/, "");
    // Refused before any glob runs: a workspace is placed by a root-relative path, and one
    // above the root has no such path.
    if (pattern.split("/").includes("..")) {
      throw fail(`workspace pattern ${raw} reaches outside the project`);
    }
    if (bangs % 2 === 1) {
      negated.push(pattern);
    } else {
      negated = negated.filter((other) => !matchesGlob(pattern, other));
      patterns.push(pattern);
    }
  }
  return {
    patterns: patterns.filter((pattern) => !negated.some((other) => matchesGlob(pattern, other))),
    negated,
  };
}

/**
 * Every workspace under `dir`, in npm's order: pattern by pattern, sorted within one, each
 * directory at its first match. A match is a directory holding a package.json; anything
 * else is passed over. `node_modules` is never entered, nor taken for a workspace.
 */
export async function findWorkspaces(dir: string, manifest: RootManifest): Promise<Workspace[]> {
  return (await listWorkspaces(dir, manifest)).workspaces;
}

/**
 * What says the workspace set is the one a glob found before, so that it need not run again.
 * The glob's answer is a function of the names in each folder it lists and of which folders
 * hold a package.json, so the proof keeps both. A settled stamp stands in for reading either
 * again; a folder whose stamp moved is read, and only other names mean another glob.
 */
export interface WorkspaceProof {
  /** `workspacePatterns` of the root manifest, as JSON. */
  patterns: string;
  paths: string[];
  /** Each folder the glob could list, root-relative: its stamp once settled, and its names. */
  lists: Record<string, [stamp: Stamp | null, names: string]>;
  /**
   * Each package.json that decides a match at a pattern's last level, and each workspace's: its
   * stamp once settled, true while it is there but not settled, false when it is not there.
   */
  files: Record<string, Stamp | boolean>;
}

export interface Listed {
  workspaces: Workspace[];
  /** None when the root declares no workspaces, or when nothing could prove the set. */
  proof?: WorkspaceProof;
  /** No glob ran, and each workspace's package.json has its settled stamp: the same bytes. */
  proven: boolean;
  /** `proof` is not the one given: the state is to keep this one instead. */
  learned: boolean;
  /** The install state `workspacesOf` took the proof from, so the install need not read it again. */
  state?: InstallState;
}

/**
 * A stamp this close to the time it is taken may yet be followed by a change that leaves it as
 * it is: a timestamp moves in ticks, of two seconds on some filesystems. Such a stamp is not
 * kept, and the next call reads what it would stand for.
 */
const RACY_MS = 2000;

/**
 * The workspaces of the root at `dir`, off the proof its install state keeps unless `proofs`
 * is off: an installed monorepo is not globbed again until something the glob sees changes.
 */
export async function workspacesOf(
  dir: string,
  manifest: RootManifest,
  proofs: boolean,
): Promise<Listed> {
  const state = proofs && manifest.workspaces !== undefined ? await readState(dir) : undefined;
  return { ...(await listWorkspaces(dir, manifest, state?.workspaces)), state };
}

/**
 * `findWorkspaces`, with the proof of the set for the next call. Given `known`, a proof from
 * before, the recorded paths are read again unless something the glob would see has changed.
 */
export async function listWorkspaces(
  dir: string,
  manifest: RootManifest,
  known?: WorkspaceProof,
): Promise<Listed> {
  if (manifest.workspaces === undefined) return { workspaces: [], proven: true, learned: false };
  const { patterns, negated } = workspacePatterns(manifest);
  const key = JSON.stringify({ patterns, negated });
  // A dot name can match only a pattern that spells a dot.
  const dots = patterns.some((pattern) => pattern.includes("."));
  const racy = BigInt(Date.now() - RACY_MS) * 1_000_000n;
  const settled = (stamp: Stamp) => BigInt(stamp[1]) < racy && BigInt(stamp[2]) < racy;
  const trusted = known?.patterns === key && sound(known);
  const held = trusted ? recheck(dir, known, dots, settled) : undefined;
  if (held) {
    const { proof, same } = held;
    const workspaces = await collect(dir, [known!.paths]);
    return { workspaces, proof, proven: same, learned: proof !== known };
  }
  const seen = record(dir, patterns, dots, settled);
  const exclude = [...negated, "**/node_modules", "**/node_modules/**"];
  const matched = await Promise.all(patterns.map((pattern) => expand(dir, pattern, exclude)));
  // Each package.json stamped before it is read, never after: a write between shows next time.
  const before = new Map<string, Stamp | boolean>();
  const workspaces = await collect(dir, matched, (at) => before.set(at, fileStamp(at, settled)));
  const paths = workspaces.map((ws) => ws.path);
  // The glob ran after the folders were read: had it seen them otherwise, the sets differ.
  if (!seen || !sameSet(implied(seen, patterns, negated), paths)) {
    return { workspaces, proven: false, learned: known !== undefined };
  }
  for (const ws of workspaces) seen.files[`${ws.path}/package.json`] = before.get(ws.dir)!;
  return { workspaces, proof: { patterns: key, paths, ...seen }, proven: false, learned: true };
}

type Settled = (stamp: Stamp) => boolean;

/**
 * Whether a proof off the state has the shape this module writes, each path under the root and
 * holding a package.json: a state edited by hand must not place a workspace outside the project.
 */
function sound(proof: WorkspaceProof): boolean {
  const { paths, lists, files } = proof;
  return (
    Array.isArray(paths) &&
    isRecord(lists) &&
    Object.values(lists).every(
      (list) =>
        Array.isArray(list) &&
        (list[0] === null || isStamp(list[0])) &&
        typeof list[1] === "string",
    ) &&
    isRecord(files) &&
    Object.values(files).every((file) => typeof file === "boolean" || isStamp(file)) &&
    paths.every(
      (path) =>
        typeof path === "string" &&
        !/^\/|^[a-zA-Z]:|\\/.test(path) &&
        !path.split("/").some((part) => part === "" || part === "." || part === "..") &&
        Object.hasOwn(files, `${path}/package.json`) &&
        files[`${path}/package.json`] !== false,
    )
  );
}

/** The proof brought up to date when it still holds, and whether each manifest is the same. */
function recheck(
  dir: string,
  known: WorkspaceProof,
  dots: boolean,
  settled: Settled,
): { proof: WorkspaceProof; same: boolean } | undefined {
  const { join } = builtin.path;
  let { lists, files } = known;
  for (const [path, [stamp, names]] of Object.entries(known.lists)) {
    const now = stampOf(join(dir, path));
    if (stamp && sameStamp(now, stamp)) continue;
    if (read(dir, path, dots).names !== names) return undefined;
    const next = now && settled(now) ? now : null;
    if (next === stamp) continue; // still not settled
    if (lists === known.lists) lists = Object.assign(Object.create(null), lists);
    lists[path] = [next, names];
  }
  let same = true;
  for (const [path, was] of Object.entries(known.files)) {
    const now = stampOf(join(dir, path));
    if (!now !== (was === false)) return undefined; // there now and not then, or the other way
    if (!now || (typeof was !== "boolean" && sameStamp(now, was))) continue;
    same = false;
    const next = settled(now) ? now : true;
    if (next === was) continue;
    if (files === known.files) files = Object.assign(Object.create(null), files);
    files[path] = next;
  }
  const proof = lists === known.lists && files === known.files ? known : { ...known, lists, files };
  return { proof, same };
}

/**
 * Every folder the glob of `patterns` could list, with its names, from each pattern's static
 * head as deep as the rest of it reaches; and at the last level, each folder's package.json.
 * More than the glob reads costs only a read more. Nothing when a symlinked folder would have
 * to be followed with no depth to stop at.
 */
function record(
  dir: string,
  patterns: string[],
  dots: boolean,
  settled: Settled,
): Pick<WorkspaceProof, "lists" | "files"> | undefined {
  const { join } = builtin.path;
  // No prototype: a folder may be named `__proto__`.
  const lists: WorkspaceProof["lists"] = Object.create(null);
  const files: WorkspaceProof["files"] = Object.create(null);
  const deepest = new Map<string, number>();
  const visit = (path: string, depth: number): boolean => {
    if ((deepest.get(path) ?? -1) >= depth) return true;
    deepest.set(path, depth);
    if (depth === 0) {
      files[under(path, "package.json")] = fileStamp(join(dir, path), settled);
      return true;
    }
    const stamp = stampOf(join(dir, path)); // before the names, so a change after shows
    const { names, children } = read(dir, path, dots);
    lists[path] = [stamp && settled(stamp) ? stamp : null, names];
    for (const [name, link] of children) {
      if (link && depth === Infinity) return false;
      if (!visit(under(path, name), depth - 1)) return false;
    }
    return true;
  };
  for (const pattern of patterns) {
    // Past a `{` or a `(`, which may hold a `/` or a `**`, the depth is unknown.
    const magic = pattern.search(/[*?[\]{}()!+@\\]/);
    const head =
      magic < 0 ? pattern : pattern.slice(0, Math.max(0, pattern.lastIndexOf("/", magic)));
    const rest = pattern.slice(head.length);
    const depth = /\*\*|[{(]/.test(rest) ? Infinity : rest.split("/").filter(Boolean).length;
    if (!visit(head, depth)) return undefined;
  }
  return { lists, files };
}

/**
 * What a glob can match in a folder, as one string: each folder in it, each link with what it
 * leads to, and whether it holds a package.json; never `node_modules`, nor a dot name unless
 * `dots`. `children` are the folders and links to walk into next.
 */
function read(
  dir: string,
  path: string,
  dots: boolean,
): { names: string; children: [name: string, link: boolean][] } {
  const { join } = builtin.path;
  const children: [string, boolean][] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = builtin.fs.readdirSync(join(dir, path), { withFileTypes: true });
  } catch {
    return { names: "", children }; // gone, or not a folder: the glob finds nothing in it
  }
  const names: string[] = [];
  for (const entry of entries) {
    const { name } = entry;
    if (name === "node_modules" || (!dots && name.startsWith("."))) continue;
    if (entry.isDirectory()) {
      names.push(`d${name}`);
      children.push([name, false]);
    } else if (entry.isSymbolicLink()) {
      let to: import("node:fs").Stats | undefined;
      try {
        to = builtin.fs.statSync(join(dir, path, name));
      } catch {} // leads nowhere, or in a loop
      names.push(`l${to ? `${to.dev}:${to.ino}` : ""} ${name}`);
      // Gone into whatever it leads to: nowhere or a file now may be a folder later.
      children.push([name, true]);
    } else if (name === "package.json") {
      names.push("f");
    }
  }
  // No name holds a `/`, so the joined names say which they were.
  return { names: names.sort().join("/"), children };
}

/** A package.json's entry in `files`. */
function fileStamp(folder: string, settled: Settled): Stamp | boolean {
  const stamp = stampOf(builtin.path.join(folder, "package.json"));
  if (!stamp) return false;
  return settled(stamp) ? stamp : true;
}

/**
 * The workspaces the recorded folders make: each that holds a package.json, that a pattern
 * matches and no negation does. What the glob found must be these.
 */
function implied(
  seen: Pick<WorkspaceProof, "lists" | "files">,
  patterns: string[],
  negated: string[],
): string[] {
  const { matchesGlob } = builtin.path;
  const held = Object.keys(seen.files)
    .filter((file) => seen.files[file] !== false)
    .map((file) => file.slice(0, -"/package.json".length));
  for (const [path, [, names]] of Object.entries(seen.lists)) {
    if (`/${names}/`.includes("/f/")) held.push(path);
  }
  // A folder also matches as `path/`, as the glob sees one: `packages/**` takes `packages`.
  const match = (path: string, pattern: string) =>
    matchesGlob(path, pattern) || matchesGlob(`${path}/`, pattern);
  return held.filter(
    (path) =>
      path !== "" &&
      patterns.some((pattern) => match(path, pattern)) &&
      !negated.some((pattern) => matchesGlob(path, pattern)),
  );
}

function sameSet(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((item) => set.has(item));
}

function under(path: string, name: string): string {
  return path ? `${path}/${name}` : name;
}

/**
 * The workspaces at the matched paths, each at its first match, with their names checked.
 * `reading` is told each folder just before its package.json is read.
 */
async function collect(
  dir: string,
  matched: string[][],
  reading?: (at: string) => void,
): Promise<Workspace[]> {
  const found = new Map<string, Workspace>(); // path -> workspace
  const named = new Map<string, Workspace>(); // name -> workspace
  for (const paths of matched) {
    for (const path of paths) {
      if (path === "" || found.has(path)) continue; // the root is not its own workspace
      reading?.(builtin.path.join(dir, path));
      const workspace = await readWorkspace(dir, path);
      if (!workspace) continue;
      const other = named.get(workspace.name);
      if (other) {
        throw fail(`workspaces ${other.path} and ${path} are both named ${workspace.name}`);
      }
      found.set(path, workspace);
      named.set(workspace.name, workspace);
    }
  }
  return [...found.values()];
}

/** What `findRoot` read of the root on the way, so the caller need not read it again. */
export interface Root {
  dir: string;
  manifest?: RootManifest;
  /** Only when the root was chosen for listing `workspace`; a bare candidate has not looked. */
  workspaces?: Workspace[];
  workspace?: Workspace;
  /** `workspaces` with how they were found: see `listWorkspaces`. */
  listed?: Listed;
}

/**
 * The project a directory belongs to: npm's walk up. The nearest package.json is the project,
 * unless a package.json above it lists that directory as a workspace, in which case the
 * root is the project and the directory is the workspace to act on. A package.json that
 * does not parse, or whose workspaces cannot be listed, is passed over on the way up: it is
 * not the project's unless it claims the directory. Nothing found means `cwd` itself. Without
 * `proofs`, a root's set is always globbed, never taken from its state.
 */
export async function findRoot(cwd: string, proofs = true): Promise<Root> {
  const { path } = builtin;
  let dir = path.resolve(cwd);
  let candidate: Root | undefined;
  for (;;) {
    // Most directories on the way up have no package.json: one sync probe each, rather than
    // a read that fails on the threadpool and an Error with a stack for it — 8 of them from
    // a project 8 deep were 2 ms.
    const file = path.join(dir, "package.json");
    const manifest = builtin.fs.existsSync(file)
      ? await readManifest(file).catch(() => undefined)
      : undefined;
    if (manifest && !candidate) candidate = { dir, manifest };
    else if (manifest?.workspaces !== undefined) {
      const listed = await workspacesOf(dir, manifest, proofs).catch(() => undefined);
      const workspace = listed?.workspaces.find((ws) => ws.dir === candidate!.dir);
      if (listed && workspace) {
        return { dir, manifest, workspaces: listed.workspaces, workspace, listed };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return candidate ?? { dir: path.resolve(cwd) };
    dir = parent;
  }
}

/** The directories one pattern matches, as root-relative `/` paths, sorted npm's way. */
async function expand(dir: string, pattern: string, exclude: string[]): Promise<string[]> {
  const { path } = builtin;
  const paths: string[] = [];
  const entries = builtin.fsp.glob(pattern, { cwd: dir, exclude, withFileTypes: true });
  for await (const entry of entries) {
    // A symlink may lead to a directory; the package.json read decides.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const relative = path.relative(dir, path.join(entry.parentPath, entry.name));
    paths.push(relative.split(path.sep).join("/"));
  }
  return paths.sort((a, b) => a.localeCompare(b, "en"));
}

/** The workspace at `path` under `dir`, or nothing when there is no package.json there. */
async function readWorkspace(dir: string, path: string): Promise<Workspace | undefined> {
  const at = builtin.path.join(dir, path);
  let manifest: RootManifest;
  try {
    manifest = await readManifest(builtin.path.join(at, "package.json"));
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  return {
    path,
    dir: at,
    name: manifest.name || builtin.path.basename(at),
    version: manifest.version || "0.0.0",
    manifest,
  };
}

async function readManifest(file: string): Promise<RootManifest> {
  let raw: string;
  try {
    raw = builtin.fs.readFileSync(file, "utf8"); // sync, as the other startup reads: see readState
  } catch (error) {
    throw Object.assign(fail(`cannot read ${file}: ${(error as Error).message}`, "EMANIFEST"), {
      cause: error,
    });
  }
  return parseManifest(raw, file);
}

function fail(message: string, code = "EWORKSPACE"): Error {
  return Object.assign(new Error(message), { code });
}

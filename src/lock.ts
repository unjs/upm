// Our own flat lockfile. npm's v3 `packages` map is keyed by on-disk path, which the
// `.upm` symlink layout has no stable equivalent of; ours is keyed by identity.
import { builtin } from "./builtin.ts";
import { normalizeBin } from "./normalize-bin.ts";
import type { Overrides, Parent } from "./overrides.ts";
import { registryBase, tarballUrl } from "./registry.ts";
import type { BaseFor } from "./registry.ts";
import { pid } from "./runtime.ts";
import { parse, satisfies } from "./semver.ts";
import { declaredSpecs, declaredWorkspaces, localPath, localShape, rootEdges } from "./resolve.ts";
import type { PeerKind, Resolution, ResolvedPackage, RootManifest, RootSpecs } from "./resolve.ts";
import { parseDep, tarballSource } from "./spec.ts";
import type { Spec } from "./spec.ts";
import { replaceFile, trace } from "./util.ts";

export const LOCKFILE = "upm.lock";

/** Other managers' lockfiles, read in memory when there is no `upm.lock`; see `foreign-lock.ts`. */
export const FOREIGN = ["package-lock.json", "pnpm-lock.yaml", "bun.lock"] as const;

export type ForeignFile = (typeof FOREIGN)[number];

/** Still 1: the format is prerelease, and nothing outside this repo has written one yet. */
const VERSION = 1;

export interface LockEntry {
  /**
   * Only for a tarball dependency, whose key ends in its source — `https://…` or `file:<path>`
   * — where a registry package's ends in its version. This is the version it calls itself.
   */
  version?: string;
  /**
   * Only for an alias: the registry package its key's name installs (`"x": "npm:real@^1"` is
   * `"x@1.0.0": { "name": "real" }`). The tarball must be that package, and every dependent's
   * own package.json must alias it so, or the link refuses it.
   */
  name?: string;
  /**
   * Only when the tarball is not where the registry would put it. The usual url is
   * `<registry>/<name>/-/<basename>-<version>.tgz`, which `tarballUrl` rebuilds at install
   * time — writing it down would pin the lockfile to whichever registry produced it, so a
   * lock made against a mirror could not install from npmjs, or the other way round. The
   * registry is the scope's when `.npmrc` sends a scope elsewhere, so a private registry
   * that serves the usual url stays out of the lockfile too; one that serves another shape
   * is written down like any other.
   */
  resolved?: string;
  integrity: string;
  dependencies?: Record<string, string>;
  /** Edges an install may drop when `os`/`cpu`/`libc` rule the target out on this machine. */
  optionalDependencies?: Record<string, string>;
  bin?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  /** The ranges as declared, kept so `install --verify` can report the ones the tree misses. */
  peerDependencies?: Record<string, string>;
  /**
   * Which of the edges above are peers the resolver settled against the tree, and whether
   * each was optional. A resolve that keeps this entry settles them again, and replays only
   * the rest as the package's own edges.
   */
  peers?: Record<string, PeerKind>;
}

/**
 * A workspace: a top like the root, keyed by its path so no tarball fields are made up for
 * it. An edge to it, from the root or another workspace only, reads `"<name>": "link:<path>"`,
 * so its identity is `<name>@link:<path>` and never a registry package's.
 */
export interface WorkspaceEntry {
  name: string;
  version: string;
  /** The ranges its package.json declared, for the same reason as the root's. */
  specs?: RootSpecs;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bin?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peers?: Record<string, PeerKind>;
}

export interface Lockfile {
  lockfileVersion: 1;
  root: {
    name?: string;
    version?: string;
    /** The ranges package.json declared, so `lock` can tell whether it has moved since. */
    specs?: RootSpecs;
    /** Direct deps of the root, resolved. Which of them are dev is `specs`' job to say. */
    dependencies: Record<string, string>;
    /** The workspace patterns as declared, so a changed set is found without the glob. */
    workspaces?: string[];
    /**
     * The overrides the tree was resolved under, one `[parent>]name[@range]` selector each, so
     * `lock` can tell when package.json changed them.
     */
    overrides?: Overrides;
  };
  /** By root-relative path. */
  workspaces?: Record<string, WorkspaceEntry>;
  packages: Record<string, LockEntry>;
}

const MAPS = ["dependencies", "optionalDependencies", "bin", "peerDependencies", "peers"] as const;
const PEER_KINDS = new Set<string>(["required", "optional"]);
const LISTS = ["os", "cpu", "libc"] as const;
const GROUPS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** Without `.npmrc`: every name from the one registry. */
const npmjs: BaseFor = () => registryBase();

export function toLockfile(resolution: Resolution, baseFor = npmjs): Lockfile {
  const packages: Record<string, LockEntry> = {};
  // A Map: a workspace directory may be named `__proto__`, which a plain object would swallow.
  const workspaces = new Map<string, WorkspaceEntry>();
  for (const [key, pkg] of Object.entries(resolution.packages)) {
    if (pkg.local !== undefined) {
      workspaces.set(pkg.local, pkg);
      continue;
    }
    // A tarball's key says where it is; what is left to say is the version inside.
    if (pkg.source !== undefined) {
      packages[key] = { ...pkg, name: undefined, resolved: undefined };
      continue;
    }
    // Dropped when it is the shape every registry uses; kept verbatim when it is not. An
    // alias's url is kept too, for an older upm that knows the alias by it alone.
    const derivable = pkg.resolved === tarballUrl(baseFor(pkg.name), pkg.name, pkg.version);
    packages[key] = {
      ...pkg,
      name: pkg.fetchName,
      version: undefined,
      resolved: derivable ? undefined : pkg.resolved,
    };
  }
  return assemble(root(resolution.root), workspaceEntries(workspaces), entries(packages));
}

/** No packument, no version pick, no semver — the whole point of having a lockfile. */
export function fromLockfile(lock: Lockfile, baseFor = npmjs): Resolution {
  return fromCheckedLockfile(validate(lock), baseFor);
}

/**
 * `fromLockfile` for a lockfile that `readLockfile` returned or `formatLockfile` accepted:
 * either validated it, and validating again is 8 ms of a warm install on `nuxt`. A lockfile
 * from anywhere else goes through `fromLockfile`.
 */
export function fromCheckedLockfile(lock: Lockfile, baseFor = npmjs): Resolution {
  const shipped = shippedSet(lock);
  const required = requiredSet(lock);
  const packages: Record<string, ResolvedPackage> = {};
  const elsewhere = new Map<string, string[]>(); // host -> keys fetched from it
  for (const [path, ws] of Object.entries(lock.workspaces ?? {})) {
    // Always linked, so never dev or optional: what a top declares is walked in full.
    packages[keyOf(path, ws)] = {
      name: ws.name,
      version: ws.version,
      resolved: "",
      integrity: "",
      local: path,
      ...(ws.specs && { specs: ws.specs }),
      dependencies: { ...ws.dependencies },
      ...(ws.optionalDependencies && { optionalDependencies: { ...ws.optionalDependencies } }),
      optional: false,
      dev: false,
      bin: normalizeBin({ bin: { ...ws.bin } }),
      ...(ws.peerDependencies && { peerDependencies: ws.peerDependencies }),
      ...(ws.peers && { peers: ws.peers }),
    };
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    // Validated, so the key is `name@version` or `name@<source>` with nothing to check about
    // either half, and only a tarball's entry has a version of its own.
    const at = key.indexOf("@", 1);
    const name = key.slice(0, at);
    const tail = key.slice(at + 1);
    const source = entry.version === undefined ? undefined : tail;
    const version = entry.version ?? tail;
    // A lockfile from before aliases were named says so only in the url. Nothing trusts that:
    // the tarball and the dependents' package.json still have to agree with it.
    const real = source ? name : (entry.name ?? packageOf(entry.resolved, version) ?? name);
    if (!source && entry.resolved && !onRegistry(entry.resolved, real, baseFor)) {
      const host = originOf(entry.resolved);
      elsewhere.set(host, [...(elsewhere.get(host) ?? []), key]);
    }
    packages[key] = {
      name,
      ...(real !== name && { fetchName: real }),
      version,
      resolved: source ?? entry.resolved ?? tarballUrl(baseFor(real), real, version),
      integrity: entry.integrity,
      ...(source !== undefined && { source }),
      dependencies: { ...entry.dependencies },
      ...(entry.optionalDependencies && {
        optionalDependencies: { ...entry.optionalDependencies },
      }),
      optional: !required.has(key),
      dev: !shipped.has(key),
      // A hand-edited bin is untrusted: the linker turns both halves into paths.
      bin: normalizeBin({ bin: { ...entry.bin } }),
      ...(entry.os && { os: entry.os }),
      ...(entry.cpu && { cpu: entry.cpu }),
      ...(entry.libc && { libc: entry.libc }),
      ...(entry.peerDependencies && { peerDependencies: entry.peerDependencies }),
      ...(entry.peers && { peers: entry.peers }),
    };
  }
  const warnings = [...elsewhere].map(
    ([host, [key, ...more]]) =>
      `${key}${more.length ? ` and ${more.length} more` : ""} locked to ${host}, not a registry in use`,
  );
  return { root: root(lock.root), packages, warnings };
}

/**
 * Whether a written-down tarball url is on the host of the registry its name is read from, or
 * npmjs, where a mirror's documents often still point. Anywhere else is what an edited lockfile
 * would say: the integrity is the lockfile's too, so it proves nothing about the host. Told,
 * not refused: a registry moved since the lock was made says the same. The host, not the path:
 * GitLab's instance registry sends each project's own. An alias is fetched as the package it
 * names, which only the url tells: from the registry of unscoped names or of a scope in its
 * path (`@std/path: npm:@jsr/std__path`, from JSR's).
 */
function onRegistry(url: string, name: string, baseFor: BaseFor): boolean {
  const host = (at: string) => /^https?:\/\/([^/?#]*)/i.exec(at)?.[1]!.toLowerCase();
  let path = url;
  try {
    path = decodeURIComponent(url);
  } catch {}
  const scopes = path.split("/").filter((part) => part.startsWith("@"));
  const bases = [name, "-", ...scopes.map((scope) => `${scope}/-`)].map(baseFor);
  return [...bases, registryBase()].some((at) => host(at) === host(url));
}

/**
 * The package a url in a registry's shape is the tarball of: `…/<name>/-/<base>-<version>.tgz`,
 * or a scoped name before its version, as JSR's `…/@jsr/x/1.0.0.tgz` and GitHub's `…/1.0.0/<id>`.
 */
function packageOf(url: string | undefined, version: string): string | undefined {
  if (url === undefined) return undefined;
  let path = url.replace(/[?#].*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {}
  const parts = path.split("/");
  const n = parts.length;
  const at = (i: number) =>
    parts[i - 1]?.startsWith("@") ? `${parts[i - 1]}/${parts[i]}` : parts[i];
  if (parts[n - 2] === "-" && parts[n - 1] === `${parts[n - 3]}-${version}.tgz`) return at(n - 3);
  const i = parts[n - 1] === `${version}.tgz` ? n - 1 : parts.indexOf(version, 3);
  return i > 2 && parts[i - 2]!.startsWith("@") ? at(i - 1) : undefined;
}

/** Where a url points, without any credentials in it; the url itself when it has no origin. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * The packages a checked lockfile holds, and how many of them are optional or dev-only, with
 * both flags derived as `fromCheckedLockfile` derives them. Workspaces are not packages.
 */
export function lockCounts(lock: Lockfile): { packages: number; optional: number; dev: number } {
  const shipped = shippedSet(lock);
  const required = requiredSet(lock);
  const keys = Object.keys(lock.packages);
  const count = (set: Set<string>) => keys.filter((key) => !set.has(key)).length;
  return { packages: keys.length, optional: count(required), dev: count(shipped) };
}

/** Fixed field order plus sorted maps, so the same resolution is always the same bytes. */
export function formatLockfile(lock: Lockfile): string {
  validate(lock); // a lockfile our own reader would reject must never reach disk
  const out = assemble(root(lock.root), workspaceEntries(lock.workspaces), entries(lock.packages));
  return `${JSON.stringify(out, undefined, 2)}\n`;
}

/** The root's overrides as `readOverrides` reads them, and the values of those that reach a top's edge. */
export interface TopOverrides {
  overrides: Overrides;
  values?: (top: Parent | undefined, name: string) => string[];
}

/**
 * Whether the lockfile was made from this tree: the same workspace patterns, the same
 * workspaces at the same paths, names and versions, and in the root and in every workspace
 * the same declared ranges, each pinned to a version it or an override of it allows — plus,
 * in a workspace, the same bins and peers, which its entry carries too, and the same
 * overrides. Anything else means a resolve; nothing here needs the network.
 */
export function sameTree(
  lock: Lockfile,
  manifest: RootManifest,
  workspaces: { path: string; name: string; version: string; manifest: RootManifest }[],
  { overrides, values }: TopOverrides = { overrides: {} },
): boolean {
  const patterns = JSON.stringify(declaredWorkspaces(manifest) ?? []);
  if (patterns !== JSON.stringify(lock.root.workspaces ?? [])) return false;
  const same = JSON.stringify(sorted(overrides)) === JSON.stringify(sorted(lock.root.overrides));
  if (!same) return false;
  if (!sameSpecs(declaredSpecs(manifest), lock.root.specs)) return false;
  const over = (top?: Parent) => (name: string) => values?.(top, name) ?? [];
  if (!pinsFit(lock, lock.root.specs, lock.root.dependencies, "", over())) return false;
  const locked = lock.workspaces ?? {};
  if (Object.keys(locked).length !== workspaces.length) return false;
  return workspaces.every((ws) => {
    const entry = Object.hasOwn(locked, ws.path) ? locked[ws.path] : undefined;
    if (!entry || entry.name !== ws.name || entry.version !== ws.version) return false;
    const shape = localShape(ws.manifest);
    if (!sameSpecs(shape.specs, entry.specs)) return false;
    const edges = { ...entry.optionalDependencies, ...entry.dependencies };
    if (!pinsFit(lock, entry.specs, edges, ws.path, over(ws))) return false;
    return (["bin", "peerDependencies", "peers"] as const).every(
      (field) =>
        JSON.stringify(sorted(shape[field]) ?? {}) === JSON.stringify(sorted(entry[field]) ?? {}),
    );
  });
}

/**
 * Whether each version a top pins is one its declared range, or the value of an override that
 * reaches the edge, could have picked, of the package it names: an alias's own, and never one
 * for a plain name. A lock edited by hand, or merged badly, can pin anything under an unchanged
 * range. A name in several groups is held to the range the resolver walks; a tarball is the one
 * its spec names, a workspace spec lands on a workspace, and a tag has only its name to compare.
 */
function pinsFit(
  lock: Lockfile,
  specs: RootSpecs = {},
  edges: Record<string, string> = {},
  base = "",
  overridden: (name: string) => string[] = () => [],
): boolean {
  return rootEdges(specs).every(([name, raw]) => {
    if (!Object.hasOwn(edges, name)) return true;
    const pinned = edges[name]!;
    return [raw, ...overridden(name)].some((range, i) => {
      let spec: Spec;
      try {
        spec = parseDep(name, range);
      } catch {
        return true; // the resolve says what is wrong with it
      }
      // An override's tarball is the root's path, the top's own one its own.
      if (spec.type === "tarball") return pinned === tarballSource(spec.fetchSpec, i ? "" : base);
      if (spec.type === "workspace") return pinned.startsWith("link:");
      const entry = lock.packages[`${name}@${pinned}`];
      if (entry?.version !== undefined) return false; // a tarball, for a registry spec
      if (!parse(pinned)) return true; // a workspace, which a plain spec may land on
      if ((entry?.name ?? packageOf(entry?.resolved, pinned) ?? name) !== spec.fetchName) {
        return false;
      }
      // As `pickManifest` picks: an exact version is one key, and `*` takes any tagged version.
      if (spec.type === "version") return parse(spec.fetchSpec)?.version === pinned;
      return spec.type !== "range" || spec.fetchSpec === "*" || satisfies(pinned, spec.fetchSpec);
    });
  });
}

export function parseLockfile(text: string): Lockfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw fail(`${LOCKFILE} is not valid JSON: ${(error as Error).message}`);
  }
  trace("lockparsed");
  return validate(parsed);
}

/** `read` is told the bytes, before they are parsed. */
export async function readLockfile(
  dir: string,
  read?: (text: string) => void,
): Promise<Lockfile | undefined> {
  const file = builtin.path.join(dir, LOCKFILE);
  let text: string;
  try {
    text = await builtin.fsp.readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw fail(`cannot read ${file}: ${(error as Error).message}`);
  }
  read?.(text);
  return parseLockfile(text);
}

/** The lockfile, or text already in its format. */
export async function writeLockfile(dir: string, lock: Lockfile | string): Promise<void> {
  const file = builtin.path.join(dir, LOCKFILE);
  const temp = `${file}.${pid}-${globalThis.crypto.randomUUID()}.tmp`;
  try {
    await builtin.fsp.writeFile(temp, typeof lock === "string" ? lock : formatLockfile(lock));
    await replaceFile(temp, file); // atomic, so a reader never sees a half-written lockfile
  } catch (error) {
    await builtin.fsp.rm(temp, { force: true });
    throw fail(`cannot write ${file}: ${(error as Error).message}`);
  }
}

/** Sections in a fixed order, and `workspaces` only when there are any. */
function assemble(
  root: Lockfile["root"],
  workspaces: Record<string, WorkspaceEntry> | undefined,
  packages: Record<string, LockEntry>,
): Lockfile {
  return { lockfileVersion: VERSION, root, ...(workspaces && { workspaces }), packages };
}

/** Built from pairs, like `sorted`, so a `__proto__` path is a key and not a prototype. */
function workspaceEntries(
  source: Record<string, WorkspaceEntry> | Map<string, WorkspaceEntry> | undefined,
): Record<string, WorkspaceEntry> | undefined {
  const pairs = [...(source instanceof Map ? source : Object.entries(source ?? {}))]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, from]) => [path, canonicalWorkspace(from)] as const);
  return pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
}

function canonicalWorkspace(from: WorkspaceEntry): WorkspaceEntry {
  const specs = canonicalSpecs(from.specs);
  const entry: WorkspaceEntry = { name: from.name, version: from.version };
  if (specs) entry.specs = specs;
  for (const field of MAPS) {
    const map = sorted(from[field]);
    if (map) entry[field] = map as Record<string, PeerKind>;
  }
  return entry;
}

function keyOf(path: string, ws: WorkspaceEntry): string {
  return `${ws.name}@link:${path}`;
}

function entries(source: Record<string, LockEntry>): Record<string, LockEntry> {
  const packages: Record<string, LockEntry> = {};
  for (const key of Object.keys(source).sort()) {
    const from = source[key];
    if (from) packages[key] = canonical(from);
  }
  return packages;
}

/** Empty and false fields are omitted: a lockfile is read by humans, in diffs. */
function canonical(from: LockEntry): LockEntry {
  // `version` and `resolved` first when they are there at all, so field order is the same in
  // every entry.
  const entry: LockEntry = {
    ...(from.version !== undefined && { version: from.version }),
    ...(from.name !== undefined && { name: from.name }),
    ...(from.resolved !== undefined && { resolved: from.resolved }),
    integrity: from.integrity,
  };
  for (const field of MAPS) {
    const map = sorted(from[field]);
    if (map) entry[field] = map as Record<string, PeerKind>; // validated where it matters
  }
  for (const field of LISTS) {
    const list = from[field];
    if (list?.length) entry[field] = list;
  }
  return entry;
}

function root(from: Lockfile["root"]): Lockfile["root"] {
  const specs = canonicalSpecs(from.specs);
  const overrides = sorted(from.overrides);
  return {
    ...(from.name !== undefined && { name: from.name }),
    ...(from.version !== undefined && { version: from.version }),
    ...(specs && { specs }),
    dependencies: sorted(from.dependencies) ?? {},
    ...(from.workspaces?.length && { workspaces: from.workspaces }),
    ...(overrides && { overrides }),
  };
}

function canonicalSpecs(from: RootSpecs | undefined): RootSpecs | undefined {
  const out: RootSpecs = {};
  for (const group of GROUPS) {
    const map = sorted(from?.[group]);
    if (map) out[group] = map;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Same declared ranges, whatever order they were written in. */
export function sameSpecs(a: RootSpecs | undefined, b: RootSpecs | undefined): boolean {
  return JSON.stringify(canonicalSpecs(a) ?? {}) === JSON.stringify(canonicalSpecs(b) ?? {});
}

function sorted(map: Record<string, string> | undefined): Record<string, string> | undefined {
  const pairs = Object.entries(map ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return pairs.length === 0 ? undefined : Object.fromEntries(pairs);
}

/** What `readLockfile` checks, for a lockfile made in memory. */
export function checkLockfile(lock: Lockfile): Lockfile {
  return validate(lock);
}

function validate(value: unknown): Lockfile {
  const lock = value as Lockfile;
  if (!isObject(lock)) throw fail(`${LOCKFILE} must be an object`);
  if (lock.lockfileVersion !== VERSION) {
    const found = JSON.stringify(lock.lockfileVersion);
    throw fail(`unsupported lockfileVersion ${found}, expected ${VERSION}`);
  }
  if (!isObject(lock.root)) throw fail("root must be an object");
  if (!isObject(lock.packages)) throw fail("packages must be an object");
  // The keys an edge from a top may point at: a package, or a workspace as `name@link:path`.
  const known = { ...lock.packages, ...workspaceKeys(lock) };
  for (const [key, entry] of Object.entries(lock.packages)) {
    const at = `packages[${JSON.stringify(key)}]`;
    const { name, source } = splitKey(key);
    if (!isObject(entry)) throw fail(`${at} must be an object`);
    if (entry.name !== undefined) {
      if (source !== undefined) throw fail(`${at}.name is only for an alias of a registry package`);
      if (typeof entry.name !== "string" || entry.name === name || !isName(entry.name)) {
        throw fail(`${at}.name must be the name of another package`);
      }
    }
    if (!entry.integrity || typeof entry.integrity !== "string") {
      throw fail(`${at}.integrity must be a non-empty string`);
    }
    if (source !== undefined) {
      // The store names its entry `name@version`, so this is a path segment like a key's half.
      const { version } = entry;
      if (typeof version !== "string" || parse(version)?.version !== version) {
        throw fail(`${at}.version must be an exact version`);
      }
      if (entry.resolved !== undefined) throw fail(`${at}.resolved is its key's to say`);
    } else if (entry.version !== undefined) {
      throw fail(`${at}.version is only for a tarball, whose key names where it is`);
    } else if (entry.resolved !== undefined) {
      if (!entry.resolved || typeof entry.resolved !== "string") {
        throw fail(`${at}.resolved must be a non-empty string`);
      }
      // A `data:` url would let a lockfile carry a payload that was never on a registry.
      if (!/^https?:\/\//.test(entry.resolved)) {
        throw fail(`${at}.resolved must be an http or https url`);
      }
    }
    for (const field of LISTS) stringList(entry[field], `${at}.${field}`);
    // A `.upm` entry links to packages only: a workspace is reached from a top, never from it.
    checkEdges(entry, at, lock.packages);
  }
  for (const [path, ws] of Object.entries(lock.workspaces ?? {})) {
    const at = `workspaces[${JSON.stringify(path)}]`;
    checkEdges(ws, at, known, true);
    const edges = { ...ws.dependencies, ...ws.optionalDependencies };
    for (const [name, version] of Object.entries(edges)) {
      if (`${name}@${version}` === keyOf(path, ws)) throw fail(`${at} depends on itself`);
    }
    checkTop(ws.specs, edges, at, ws.peerDependencies);
  }
  if (!isObject(lock.root.dependencies)) throw fail("root.dependencies must be an object");
  links(lock.root.dependencies, "root.dependencies", known, true);
  checkTop(lock.root.specs, lock.root.dependencies, "root");
  stringList(lock.root.workspaces, "root.workspaces");
  stringMap(lock.root.overrides, "root.overrides");
  return lock;
}

/** Every workspace's `name@link:path`, with a name and version valid the way a package key's are. */
function workspaceKeys(lock: Lockfile): Record<string, WorkspaceEntry> {
  const out: Record<string, WorkspaceEntry> = {};
  if (lock.workspaces === undefined) return out;
  if (!isObject(lock.workspaces)) throw fail("workspaces must be an object");
  const named = new Map<string, string>(); // name -> path
  for (const [path, ws] of Object.entries(lock.workspaces)) {
    const at = `workspaces[${JSON.stringify(path)}]`;
    if (!localPath(path)) throw fail(`${at} is not a relative path inside the project`);
    if (!isObject(ws)) throw fail(`${at} must be an object`);
    if (typeof ws.name !== "string" || typeof ws.version !== "string") {
      throw fail(`${at}.name and ${at}.version must be strings`);
    }
    if (splitKey(`${ws.name}@${ws.version}`).source !== undefined) {
      throw fail(`${at}.version must be an exact version`);
    }
    // One name is one workspace: an edge `"<name>": "link:<path>"` must have one place to land.
    const other = named.get(ws.name);
    if (other !== undefined) {
      throw fail(`workspaces[${JSON.stringify(other)}] and ${at} are both named ${ws.name}`);
    }
    named.set(ws.name, path);
    out[keyOf(path, ws)] = ws;
  }
  return out;
}

/** Bins, edges and peers, the same on a package and on a workspace; only a top may link. */
function checkEdges(
  entry: LockEntry | WorkspaceEntry,
  at: string,
  known: object,
  top = false,
): void {
  stringMap(entry.bin, `${at}.bin`);
  for (const [name, target] of Object.entries(entry.bin ?? {})) {
    if (escapes(name) || escapes(target)) {
      throw fail(`${at}.bin[${JSON.stringify(name)}] escapes the package directory`);
    }
  }
  stringMap(entry.peerDependencies, `${at}.peerDependencies`);
  links(entry.dependencies, `${at}.dependencies`, known, top);
  links(entry.optionalDependencies, `${at}.optionalDependencies`, known, top);
  stringMap(entry.peers, `${at}.peers`);
  for (const [name, kind] of Object.entries(entry.peers ?? {})) {
    // Settling it again needs its range, so a peer has to be a declared one.
    if (!PEER_KINDS.has(kind)) throw fail(`${at}.peers["${name}"] must be required or optional`);
    if (!entry.peerDependencies?.[name]) {
      throw fail(`${at}.peers["${name}"] is not in ${at}.peerDependencies`);
    }
  }
}

/**
 * A top's specs, which every one of its direct deps must be in: `dev` is read out of them.
 * A workspace's settled peer is declared in its `peerDependencies` instead.
 */
function checkTop(
  specs: unknown,
  dependencies: Record<string, string>,
  at: string,
  peers: Record<string, string> = {},
): void {
  if (specs !== undefined) {
    if (!isObject(specs)) throw fail(`${at}.specs must be an object`);
    for (const group of GROUPS) stringMap(specs[group], `${at}.specs.${group}`);
  }
  const declared = new Set(GROUPS.flatMap((g) => Object.keys((specs as RootSpecs)?.[g] ?? {})));
  for (const name of Object.keys(dependencies)) {
    if (!declared.has(name) && !(name in peers)) {
      throw fail(`${at}.dependencies["${name}"] is in no ${at}.specs group, so it has no dev flag`);
    }
  }
}

/**
 * Everything the root's non-dev edges reach — the exact complement of `dev`.
 *
 * Not a stored flag: `filterPlatform` recomputes `dev` for every package on every install
 * anyway, seeding a walk from the root's own edges and overwriting whatever the entry said.
 * Measured on a 561-entry tree, flipping the flag on 560 of them changed nothing. So the three
 * lists in `root.specs` are the only part that was ever read, and this rebuilds the rest.
 */
function shippedSet(lock: Lockfile): Set<string> {
  return reach(
    lock,
    (top, name) => top.prod.has(name),
    (entry) => [entry.dependencies, entry.optionalDependencies],
  );
}

/**
 * Everything the root reaches without ever taking an optional edge — the complement of
 * `optional`, on the same reasoning as `shippedSet`.
 *
 * Which map an edge is in already says whether it is optional, so a flag on the entry stored
 * the same fact a second time, in a form that could disagree with it — and one written by an
 * older upm did, flagging platform bindings optional while they sat in a required
 * `dependencies` map. A flag that wrongly reads optional makes `filterPlatform` drop a package
 * the root needs in silence, where the edge maps make it raise `EBADPLATFORM`.
 */
function requiredSet(lock: Lockfile): Set<string> {
  // `rootEdges` gives optionalDependencies priority over a name declared in both.
  return reach(
    lock,
    (top, name) => !(name in (top.specs?.optionalDependencies ?? {})),
    (entry) => [entry.dependencies],
  );
}

/** The root or a workspace: what it declared, and the names of its non-dev edges. */
interface Top {
  specs?: RootSpecs;
  dependencies: Record<string, string>;
  prod: Set<string>;
}

/** A workspace's peer ships too, unless a devDependency of the same name gives the edge. */
function topOf(
  specs: RootSpecs | undefined,
  dependencies: Record<string, string>,
  peers: Record<string, string> = {},
): Top {
  const dev = specs?.devDependencies ?? {};
  const prod = new Set([
    ...Object.keys(specs?.dependencies ?? {}),
    ...Object.keys(specs?.optionalDependencies ?? {}),
    ...Object.keys(peers).filter((name) => !(name in dev)),
  ]);
  return { specs, dependencies, prod };
}

/**
 * Every workspace, the root's and every workspace's deps that `seed` accepts by that top's
 * specs, then everything the maps `follow` picks lead to. A workspace's own edges are only
 * ever followed from it as a top, so a devDependency of one does not ship through it.
 */
function reach(
  lock: Lockfile,
  seed: (top: Top, name: string) => boolean,
  follow: (entry: LockEntry) => (Record<string, string> | undefined)[],
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  const tops = [topOf(lock.root.specs, lock.root.dependencies)];
  for (const [path, ws] of Object.entries(lock.workspaces ?? {})) {
    seen.add(keyOf(path, ws));
    const edges = { ...ws.dependencies, ...ws.optionalDependencies };
    tops.push(topOf(ws.specs, edges, ws.peerDependencies));
  }
  const push = (key: string): void => {
    if (seen.has(key) || !Object.hasOwn(lock.packages, key)) return;
    seen.add(key);
    queue.push(key);
  };
  for (const top of tops) {
    for (const [name, version] of Object.entries(top.dependencies)) {
      if (seed(top, name)) push(`${name}@${version}`);
    }
  }
  for (const key of queue) {
    for (const map of follow(lock.packages[key]!)) {
      for (const [name, version] of Object.entries(map ?? {})) push(`${name}@${version}`);
    }
  }
  return seen;
}

/** A dangling reference is what breaks the linker, so it is a parse error here. */
function links(deps: unknown, at: string, known: object, top = false): void {
  stringMap(deps, at);
  for (const [name, version] of Object.entries((deps ?? {}) as Record<string, string>)) {
    if (!Object.hasOwn(known, `${name}@${version}`)) {
      const where = top && version.startsWith("link:") ? "workspaces" : "packages";
      throw fail(`${at}["${name}"] points at ${name}@${version}, which is not in ${where}`);
    }
  }
}

/** A `.bin` name or target that climbs out of its directory would let a lockfile write anywhere. */
function escapes(value: string): boolean {
  const clean = value.replaceAll("\\", "/");
  return clean.startsWith("/") || clean === ".." || clean.split("/").includes("..");
}

/**
 * `name@version`, or a tarball's `name@<source>`. Split at the first `@` past a scope's, since
 * a url or a path may hold one.
 */
function splitKey(key: string): { name: string; version: string; source?: string } {
  const at = key.indexOf("@", 1);
  if (at <= 0 || at === key.length - 1) throw fail(`package key "${key}" is not name@version`);
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  // The linker turns both halves into path segments, so a hand-edited key must not smuggle one.
  let spec: Spec;
  try {
    spec = parseDep(name, version);
  } catch {
    throw fail(`package key "${key}" is not a valid package name`);
  }
  // Spelled as the resolver spells it, so one tarball is one key: a path relative, clean and
  // `/`-separated. It is never a path segment: the store names the entry by its version.
  if (spec.type === "tarball") {
    if (spec.fetchSpec !== version) {
      throw fail(`package key "${key}" does not name its tarball as a lockfile does`);
    }
    return { name, version, source: version };
  }
  if (parse(version)?.version !== version) {
    throw fail(`package key "${key}" does not end in an exact version`);
  }
  return { name, version };
}

/** A registry package's name, as a key's half must be. */
function isName(name: string): boolean {
  try {
    return parseDep(name, "*").type === "range";
  } catch {
    return false;
  }
}

function stringMap(value: unknown, at: string): void {
  if (value === undefined) return;
  if (!isObject(value)) throw fail(`${at} must be an object`);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw fail(`${at}["${key}"] must be a string`);
  }
}

function stringList(value: unknown, at: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw fail(`${at} must be an array of strings`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): Error {
  return Object.assign(new Error(message), { code: "ELOCK" });
}

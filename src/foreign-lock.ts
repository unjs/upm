// Read the lockfile npm, pnpm or bun left in a project, so upm installs the tree it holds and
// writes no `upm.lock` beside it. Every format is a set of `name@version` nodes with edges once
// npm's and bun's path-keyed maps are walked the way Node resolves and pnpm's peer suffixes are
// stripped. Loaded only when a project has one of these files and no `upm.lock`.
import { normalizeBin } from "./normalize-bin.ts";
import { builtin } from "./builtin.ts";
import { checkLockfile, LOCKFILE } from "./lock.ts";
import type { ForeignFile, LockEntry, Lockfile } from "./lock.ts";
import { tarballUrl } from "./registry.ts";
import type { BaseFor } from "./registry.ts";
import { declaredSpecs, declaredWorkspaces } from "./resolve.ts";
import type { PeerKind, ResolvedPackage, RootManifest, RootSpecs } from "./resolve.ts";
import { maxSatisfying } from "./semver.ts";
import { yaml } from "./yaml.ts";
import type { Store } from "./store.ts";

export interface ForeignLock {
  lock: Lockfile;
  /** Keys of packages whose bins the file does not name: pnpm says only `hasBin`. */
  binless: string[];
  warnings: string[];
}

/** One package as the file records it, edges already exact versions. */
interface Node {
  /** What it is installed as. */
  name: string;
  /** The registry package, when `name` is an alias for it. */
  real?: string;
  version: string;
  resolved?: string;
  integrity: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peers?: Record<string, PeerKind>;
  bin?: Record<string, string>;
  hasBin?: boolean;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

interface Source {
  nodes: Node[];
  /** The ranges the file recorded for the root: what package.json is held to. */
  specs: RootSpecs;
  /** Root edges, name -> version. */
  root: Record<string, string>;
  /** The overrides the file was resolved under, where it records them (bun). */
  overrides?: unknown;
}

const GROUPS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** Who writes each file: the manager a refusal sends a person back to. */
const MANAGERS: Record<ForeignFile, string> = {
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "bun.lock": "bun",
};

/**
 * The project's lockfile as upm's, when it still describes package.json. upm never writes it,
 * so one that does not is refused rather than resolved: its own manager keeps it current.
 */
export function loadForeign(
  file: ForeignFile,
  text: string | undefined,
  project: { manifest: RootManifest; workspaces: unknown[] },
  baseFor: BaseFor,
): ForeignLock {
  const { manifest, workspaces } = project;
  if (declaredWorkspaces(manifest) || workspaces.length > 0) {
    throw fail(`upm does not read workspaces from ${file}: delete it to switch to upm`);
  }
  if (text === undefined) throw fail(`cannot read ${file}`);
  return readForeign(file, text, manifest, baseFor);
}

/** A command that would write `upm.lock` next to another manager's lockfile. */
export function beside(file: ForeignFile, command: string): Error {
  const run = `run ${MANAGERS[file]} ${command}`;
  return fail(
    `${command} would write ${LOCKFILE} beside ${file}: ${run}, or delete ${file} to switch to upm`,
  );
}

export function readForeign(
  file: ForeignFile,
  text: string,
  manifest: RootManifest,
  baseFor: BaseFor,
): ForeignLock {
  let source: Source;
  try {
    source = READERS[file](text);
  } catch (error) {
    if ((error as { code?: string }).code === "ELOCK") throw error;
    throw fail(`${file} cannot be read: ${(error as Error).message}`);
  }
  holdTo(file, source, manifest);
  return build(file, source, manifest, baseFor);
}

/**
 * Refuse a file that was not written for this package.json: every name it declares at the root
 * must have the range package.json gives it, and no more names. Managers file a name declared
 * twice under different groups (optional wins in all three, pnpm puts dependencies over dev),
 * so the groups kept are package.json's. pnpm also records the root's own peers, which upm,
 * like npm without a consumer, does not install.
 */
function holdTo(file: ForeignFile, source: Source, manifest: RootManifest): void {
  const extra = manifest as {
    patchedDependencies?: object;
    pnpm?: { patchedDependencies?: object };
  };
  if (extra.patchedDependencies || extra.pnpm?.patchedDependencies) {
    throw fail(`upm does not apply the patches package.json names`);
  }
  const stale = () =>
    fail(
      `${file} is out of date with package.json: run ${MANAGERS[file]} install, or delete it to switch to upm`,
    );
  const declared = flat(declaredSpecs(manifest));
  const recorded = flat(source.specs);
  for (const [name, range] of Object.entries(recorded)) {
    if (declared[name] === range) continue;
    if (name in declared || manifest.peerDependencies?.[name] !== range) throw stale();
    delete source.root[name];
  }
  if (Object.keys(declared).some((name) => !(name in recorded))) throw stale();
  if (source.overrides !== undefined) {
    const given = (manifest as { overrides?: object; resolutions?: object }).overrides;
    const resolutions = (manifest as { resolutions?: object }).resolutions;
    if (canonical(source.overrides) !== canonical(given ?? resolutions ?? {})) throw stale();
  }
  source.specs = declaredSpecs(manifest) ?? {};
}

/** Name -> range, the later group winning as `rootEdges` has it: optional, then dependencies. */
function flat(specs: RootSpecs | undefined): Record<string, string> {
  return Object.assign(
    {},
    specs?.devDependencies,
    specs?.dependencies,
    specs?.optionalDependencies,
  ) as Record<string, string>;
}

/** JSON with every object's keys sorted, so the same map is the same text. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/**
 * Bins for the packages the file could not name. The store holds each one unpacked, so its
 * `package.json` says which; one not there yet is fetched first. Runs before the state hash,
 * so a tree linked this way is up to date on the next install too.
 */
export async function readBins(pkgs: ResolvedPackage[], store: Store): Promise<void> {
  await Promise.all(
    pkgs.map(async (pkg) => {
      try {
        await store.ensure(pkg.resolved, pkg.integrity);
      } catch (error) {
        if (pkg.optional) return; // the fill says so, and goes on without it
        throw error;
      }
      const file = store.index(pkg.integrity)?.files.find((f) => f.path === "package.json");
      if (!file) return;
      const text = await builtin.fsp.readFile(store.blobPath(file), "utf8");
      pkg.bin = normalizeBin(JSON.parse(text)); // an alias renames the package, never its bins
    }),
  );
}

const READERS: Record<ForeignFile, (text: string) => Source> = {
  "package-lock.json": readNpm,
  "pnpm-lock.yaml": readPnpm,
  "bun.lock": readBun,
};

// --- npm package-lock.json v2/v3 --------------------------------------------------------

interface NpmEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: unknown;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  link?: boolean;
  inBundle?: boolean;
}

function readNpm(text: string): Source {
  const doc = JSON.parse(text) as { lockfileVersion?: number; packages?: object };
  if (!doc.packages) {
    const v = doc.lockfileVersion ?? 1;
    throw fail(`package-lock.json v${v} has no packages map; npm 7 and later write one`);
  }
  const paths = new Map(Object.entries(doc.packages as Record<string, NpmEntry>));
  // The `node_modules/<name>` a walk up from `from` finds, as Node's resolution does.
  const find = (from: string, name: string): NpmEntry | undefined => {
    for (let dir = from; ;) {
      const hit = paths.get(`${dir}node_modules/${name}`);
      if (hit) return hit;
      if (!dir) return undefined;
      const up = dir.lastIndexOf("node_modules/", dir.length - 2);
      dir = up < 0 ? "" : dir.slice(0, up);
    }
  };
  const registry = (entry: NpmEntry | undefined): entry is NpmEntry & { version: string } =>
    !!entry?.version && !entry.link && (!entry.resolved || /^https?:/.test(entry.resolved));
  const nodes: Node[] = [];
  for (const [path, entry] of paths) {
    // A bundled copy is inside its parent's tarball; a workspace path was refused before this.
    if (!path.startsWith("node_modules/") || entry.inBundle || !registry(entry)) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const from = `${path}/`;
    const node = {
      name,
      ...(entry.name && entry.name !== name && { real: entry.name }),
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity ?? "", // npm leaves it out now and then (npm/cli#4460)
      bin: normalizeBin({ name: entry.name ?? name, bin: entry.bin }),
      os: entry.os,
      cpu: entry.cpu,
      libc: entry.libc,
    };
    nodes.push(
      withEdges(node, entry, (dep) => {
        const hit = find(from, dep);
        if (hit?.inBundle) return null;
        return registry(hit) ? hit.version : undefined;
      }),
    );
  }
  const top = paths.get("") ?? {};
  return rootOf(top, (name) => {
    const hit = find("", name);
    return registry(hit) ? hit.version : undefined;
  }).with(nodes);
}

type Declared = Pick<
  NpmEntry,
  "dependencies" | "optionalDependencies" | "peerDependencies" | "peerDependenciesMeta"
>;

/**
 * Own edges, then declared peers, each to whatever `target` finds — how npm and bun lay a tree
 * out. `null` is an edge the tarball itself satisfies (a bundled copy); `undefined` is missing.
 */
function withEdges(
  base: Omit<Node, "dependencies" | "optionalDependencies">,
  entry: Declared,
  target: (name: string) => string | null | undefined,
): Node {
  const node: Node = { ...base, dependencies: {}, optionalDependencies: {} };
  const optional = entry.optionalDependencies ?? {};
  for (const dep of Object.keys({ ...entry.dependencies, ...optional })) {
    const version = target(dep);
    if (version === null) continue;
    // Missing is kept, to fail the closure check by name; a missing optional just did not install.
    if (dep in optional) {
      if (version !== undefined) node.optionalDependencies[dep] = version;
    } else node.dependencies[dep] = version ?? "";
  }
  const peers = entry.peerDependencies ?? {};
  if (Object.keys(peers).length === 0) return node;
  node.peerDependencies = peers;
  node.peers = {};
  for (const peer of Object.keys(peers)) {
    if (peer in node.dependencies || peer in node.optionalDependencies) continue; // its own edge
    const kind: PeerKind = entry.peerDependenciesMeta?.[peer]?.optional ? "optional" : "required";
    node.peers[peer] = kind;
    const version = target(peer);
    if (version)
      (kind === "optional" ? node.optionalDependencies : node.dependencies)[peer] = version;
  }
  return node;
}

/** The root's recorded ranges, each resolved by `target`, as a `Source` waiting for its nodes. */
function rootOf(
  top: Partial<Record<(typeof GROUPS)[number], Record<string, string>>>,
  target: (name: string) => string | undefined,
): { with: (nodes: Node[]) => Source } {
  const specs: RootSpecs = {};
  const root: Record<string, string> = {};
  for (const group of GROUPS) {
    const declared = top[group];
    if (!declared || Object.keys(declared).length === 0) continue;
    specs[group] = declared;
    for (const name of Object.keys(declared)) {
      // Missing is kept, to fail by name; an optional one just did not install.
      const version = target(name);
      if (version || group !== "optionalDependencies") root[name] = version ?? "";
    }
  }
  return { with: (nodes) => ({ nodes, specs, root }) };
}

// --- pnpm-lock.yaml v9 ------------------------------------------------------------------
// `packages` describes each version, `snapshots` each version with its peer set, and edges
// are exact already. Bins are only `hasBin: true`, so install reads them out of the package.

function readPnpm(text: string): Source {
  // pnpm 11 and later may write two documents: its own dependencies first, then the lockfile.
  const docs = text.split(/^---\s*$/m).map((part) => yaml(part) as Record<string, unknown>);
  const doc = docs.filter((d) => d.lockfileVersion).at(-1) ?? {};
  const version = String(doc.lockfileVersion ?? "");
  if (!version.startsWith("9")) {
    throw fail(`pnpm-lock.yaml ${version || "v5"} is not read; pnpm 9 and later write 9.0`);
  }
  type Importer = Record<string, Record<string, { specifier?: string; version?: string }>>;
  const importers = (doc.importers ?? {}) as Record<string, Importer>;
  if (Object.keys(importers).some((path) => path !== ".")) {
    throw fail("upm does not read workspaces from pnpm-lock.yaml");
  }
  if (doc.patchedDependencies) throw fail("upm does not apply the patches pnpm-lock.yaml names");
  const packages = (doc.packages ?? {}) as Record<string, Record<string, unknown>>;
  const snapshots = (doc.snapshots ?? {}) as Record<string, Record<string, unknown>>;
  const aliases = new Map<string, string>(); // alias@version -> real name
  const edge = (dep: string, ref: string): string => {
    const target = pnpmTarget(dep, ref);
    if (!target) return "";
    if (target.real !== dep) {
      const key = `${dep}@${target.version}`;
      // One node per `name@version`: two packages under one alias cannot share it.
      if ((aliases.get(key) ?? target.real) !== target.real) {
        throw fail(
          `pnpm-lock.yaml holds two packages as ${key}; upm keeps one per name and version`,
        );
      }
      aliases.set(key, target.real);
    }
    return target.version;
  };
  const nodes: Node[] = [];
  for (const [key, snap] of Object.entries(snapshots)) {
    const id = stripPeers(key);
    const pkg = packages[id];
    const resolution = (pkg?.resolution ?? {}) as Record<string, string>;
    if (!pkg || !resolution.integrity) continue; // a git, file or tarball-url package
    const { name, version } = splitId(id);
    const node: Node = {
      name,
      version,
      resolved: resolution.tarball,
      integrity: resolution.integrity,
      dependencies: {},
      optionalDependencies: {},
      hasBin: pkg.hasBin === true,
      os: list(pkg.os),
      cpu: list(pkg.cpu),
      libc: list(pkg.libc),
    };
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      for (const [dep, ref] of Object.entries((snap[field] ?? {}) as Record<string, string>)) {
        node[field][dep] = edge(dep, ref);
      }
    }
    const ranges = (pkg.peerDependencies ?? {}) as Record<string, string>;
    const meta = (pkg.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;
    if (Object.keys(ranges).length > 0) {
      node.peerDependencies = ranges;
      node.peers = {};
      // A snapshot lists its settled peers among its deps; the declared list tells them apart.
      for (const peer of Object.keys(ranges)) {
        const kind: PeerKind = meta[peer]?.optional ? "optional" : "required";
        node.peers[peer] = kind;
        if (kind === "optional" && peer in node.dependencies) {
          node.optionalDependencies[peer] = node.dependencies[peer]!;
          delete node.dependencies[peer];
        }
      }
    }
    nodes.push(node);
  }
  const top: Partial<Record<(typeof GROUPS)[number], Record<string, string>>> = {};
  const versions: Record<string, string> = {};
  for (const group of GROUPS) {
    for (const [name, dep] of Object.entries(importers["."]?.[group] ?? {})) {
      (top[group] ??= {})[name] = String(dep.specifier ?? "");
      versions[name] = edge(name, String(dep.version ?? ""));
    }
  }
  // pnpm keys an alias by the real package; upm gives the alias a node of its own.
  const byId = new Map(nodes.map((node) => [`${node.name}@${node.version}`, node]));
  for (const [key, real] of aliases) {
    const from = byId.get(`${real}@${splitId(key).version}`);
    if (!from) continue;
    const { dependencies, optionalDependencies } = from;
    nodes.push({
      ...from,
      name: splitId(key).name,
      real,
      dependencies: { ...dependencies },
      optionalDependencies: { ...optionalDependencies },
    });
  }
  return rootOf(top, (name) => versions[name] || undefined).with(nodes);
}

/** `1.2.3`, `1.2.3(peer@1)`, `real@1.2.3(peer@1)` for an alias; nothing for `link:`, `file:`. */
function pnpmTarget(dep: string, ref: string): { version: string; real: string } | undefined {
  const bare = stripPeers(ref);
  if (!bare || bare.includes(":")) return undefined;
  const at = bare.lastIndexOf("@");
  if (at > 0) return { real: bare.slice(0, at), version: bare.slice(at + 1) };
  return { real: dep, version: bare };
}

function stripPeers(key: string): string {
  const open = key.indexOf("(");
  return open < 0 ? key : key.slice(0, open);
}

// --- bun.lock ---------------------------------------------------------------------------
// JSON with trailing commas. `packages` is keyed by hoisted path (`a`, `c/a`), a registry
// package a tuple of `[name@version, registry, meta, integrity]`; edges are ranges resolved by
// walking up the path like npm. bun records no libc.

function readBun(text: string): Source {
  const doc = JSON.parse(text.replaceAll(/,(\s*[}\]])/g, "$1")) as {
    workspaces?: Record<string, Record<string, Record<string, string>>>;
    packages?: Record<string, unknown[]>;
    overrides?: object;
    patchedDependencies?: object;
  };
  if (Object.keys(doc.workspaces ?? {}).some((path) => path !== "")) {
    throw fail("upm does not read workspaces from bun.lock");
  }
  if (doc.patchedDependencies) throw fail("upm does not apply the patches bun.lock names");
  const paths = new Map(Object.entries(doc.packages ?? {}));
  // Git, file and workspace tuples have another shape; only a registry one ends in integrity.
  const fromRegistry = (tuple: unknown[] | undefined): tuple is BunTuple =>
    tuple?.length === 4 && typeof tuple[1] === "string" && typeof tuple[3] === "string";
  // A bundled copy is inside its parent's tarball, as npm's `inBundle` is: `null`, no edge.
  const bundled = (tuple: BunTuple) => tuple[2].bundled === true;
  const find = (from: string[], name: string): string | null | undefined => {
    for (let depth = from.length; depth >= 0; depth--) {
      const hit = paths.get([...from.slice(0, depth), name].join("/"));
      if (!hit) continue;
      if (!fromRegistry(hit)) return undefined;
      return bundled(hit) ? null : splitId(hit[0]).version;
    }
    return undefined;
  };
  const nodes: Node[] = [];
  for (const [path, tuple] of paths) {
    if (!fromRegistry(tuple) || bundled(tuple)) continue;
    const [id, host, meta, integrity] = tuple;
    const { name: real, version } = splitId(id);
    const chain = names(path);
    const name = chain.at(-1)!;
    const node = {
      name,
      ...(name !== real && { real }),
      version,
      // An empty host is the default registry; another is written out in full.
      ...(host && { resolved: tarballUrl(host.replace(/\/+$/, ""), real, version) }),
      integrity,
      bin: normalizeBin({ name: real, bin: meta.bin }),
      // bun writes an os or cpu it does not know as "none": unknown, so no restriction.
      os: list(meta.os)?.filter((os) => os !== "none"),
      cpu: list(meta.cpu)?.filter((cpu) => cpu !== "none"),
    };
    const optionalPeers = (meta.optionalPeers ?? []) as string[];
    const peerDependenciesMeta = Object.fromEntries(
      optionalPeers.map((p) => [p, { optional: true }]),
    );
    const declared = { ...(meta as Declared), peerDependenciesMeta };
    nodes.push(withEdges(node, declared, (dep) => find(chain, dep)));
  }
  const source = rootOf(doc.workspaces?.[""] ?? {}, (name) => find([], name) ?? undefined).with(
    nodes,
  );
  return { ...source, overrides: doc.overrides ?? {} };
}

type BunTuple = [string, string, Record<string, unknown>, string];

/** A path is package names joined by "/", and a scoped name has a "/" of its own. */
function names(path: string): string[] {
  const out: string[] = [];
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    out.push(parts[i]!.startsWith("@") ? `${parts[i]}/${parts[++i]}` : parts[i]!);
  }
  return out;
}

// --- shared -----------------------------------------------------------------------------

/**
 * Fold the nodes onto one per `name@version`, keep what the root reaches, and check the result
 * as `readLockfile` would. A copy with other edges is a peer settled two ways, which upm's one
 * node cannot hold: the highest version the peer range allows wins, as `settlePeers` would pick.
 */
function build(
  file: ForeignFile,
  source: Source,
  manifest: RootManifest,
  baseFor: BaseFor,
): ForeignLock {
  const nodes = new Map<string, Node>();
  const twice = new Set<string>();
  for (const node of source.nodes) {
    const key = `${node.name}@${node.version}`;
    const have = nodes.get(key);
    if (!have) {
      nodes.set(key, node);
      continue;
    }
    if (have.integrity !== node.integrity) {
      throw fail(`${file} holds two packages as ${key}; upm keeps one per name and version`);
    }
    for (const field of ["dependencies", "optionalDependencies"] as const) {
      for (const [dep, version] of Object.entries(node[field])) {
        const mine = have[field][dep];
        if (mine === version) continue;
        twice.add(key);
        const range = have.peerDependencies?.[dep] ?? "*";
        have[field][dep] = !mine ? version : (maxSatisfying([mine, version], range) ?? mine);
      }
    }
  }

  // A Set grows while it is iterated, so it is the walk's queue too.
  const reached = new Set<string>();
  const visit = (from: string, name: string, version: string): void => {
    const key = `${name}@${version}`;
    if (!version || !nodes.has(key)) {
      throw fail(`${from} depends on ${name}, which ${file} has from no registry`);
    }
    reached.add(key);
  };
  for (const [name, version] of Object.entries(source.root)) visit("package.json", name, version);
  for (const key of reached) {
    const node = nodes.get(key)!;
    for (const [name, version] of Object.entries(node.dependencies)) visit(key, name, version);
    for (const [name, version] of Object.entries(node.optionalDependencies)) {
      if (nodes.has(`${name}@${version}`)) visit(key, name, version);
      else delete node.optionalDependencies[name]; // not from a registry; an optional may go
    }
  }

  const packages: Record<string, LockEntry> = {};
  const binless: string[] = [];
  for (const key of reached) {
    const node = nodes.get(key)!;
    if (!node.integrity) throw fail(`${file} gives ${key} no integrity`);
    const bin = node.bin && Object.keys(node.bin).length > 0 ? node.bin : undefined;
    if (!bin && node.hasBin) binless.push(key);
    const peers = node.peers && Object.keys(node.peers).length > 0 ? node.peers : undefined;
    packages[key] = {
      ...(node.real && { name: node.real }),
      ...(!derivable(node) && {
        resolved: node.real
          ? tarballUrl(baseFor(node.real), node.real, node.version)
          : node.resolved,
      }),
      integrity: node.integrity,
      ...(Object.keys(node.dependencies).length > 0 && { dependencies: node.dependencies }),
      ...(Object.keys(node.optionalDependencies).length > 0 && {
        optionalDependencies: node.optionalDependencies,
      }),
      ...(bin && { bin }),
      ...(node.os?.length && { os: node.os }),
      ...(node.cpu?.length && { cpu: node.cpu }),
      ...(node.libc?.length && { libc: node.libc }),
      ...(node.peerDependencies && { peerDependencies: node.peerDependencies }),
      ...(peers && { peers }),
    };
  }
  const lock: Lockfile = {
    lockfileVersion: 1,
    root: {
      ...(manifest.name !== undefined && { name: manifest.name }),
      ...(manifest.version !== undefined && { version: manifest.version }),
      ...(Object.keys(source.specs).length > 0 && { specs: source.specs }),
      dependencies: source.root,
    },
    packages,
  };
  try {
    checkLockfile(lock);
  } catch (error) {
    throw fail(`${file} does not map onto upm: ${(error as Error).message}`);
  }
  const warnings = [...twice]
    .filter((key) => reached.has(key))
    .sort()
    .map((key) => `${file} settles a peer of ${key} two ways; upm links the highest`);
  return { lock, binless, warnings };
}

/**
 * Whether install rebuilds the url on its own. The registry shape on any host counts: a file
 * written behind a mirror names the mirror everywhere, and keeping that would pin the install
 * to it. An alias, or a url of another shape, is kept.
 */
function derivable(node: Node): boolean {
  if (node.real) return false;
  if (node.resolved === undefined) return true;
  const base = node.name.slice(node.name.indexOf("/") + 1);
  return node.resolved.endsWith(`/${node.name}/-/${base}-${node.version}.tgz`);
}

function splitId(id: string): { name: string; version: string } {
  const at = id.lastIndexOf("@");
  return { name: id.slice(0, at), version: id.slice(at + 1) };
}

function list(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function fail(message: string): Error {
  return Object.assign(new Error(message), { code: "ELOCK" });
}

// Walk a root package.json into a flat, deterministic set of `name@version` packages.
// No hoisting and no placement: the stage 5 `.upm` layout makes both unnecessary.
import { normalizeBin } from "./normalize-bin.ts";
import { builtin } from "./builtin.ts";
import { intersect, maxSatisfying, parse, satisfies, validRange } from "./semver.ts";
import { fromShasum } from "./integrity.ts";
import { pickManifest } from "./pick.ts";
import { createRegistry, tarballUrl } from "./registry.ts";
import type { Registry } from "./registry.ts";
import { parseDep, tarballSource } from "./spec.ts";
import type { Spec } from "./spec.ts";
import { createLimiter } from "./limit.ts";
import type { Manifest } from "./types.ts";

export interface ResolvedPackage {
  name: string;
  version: string;
  /** Both empty for a local entry: a workspace has no tarball. */
  resolved: string;
  integrity: string;
  /**
   * A workspace, at this root-relative `/` path. Linked from its directory, never in `.upm`.
   * Its key is `name@link:<path>` and an edge to it carries `link:<path>` as the version, so
   * it never shares an identity with a registry package of the same name and version.
   */
  local?: string;
  /** Local entries only: the ranges the workspace's manifest declared, for the lockfile. */
  specs?: RootSpecs;
  /**
   * A tarball dependency: its http(s) url, or `file:` and its root-relative `/` path. Its key is
   * `name@<source>` and an edge to it carries the source as the version, as a workspace's
   * carries `link:<path>`; `version` is what its package.json says. `resolved` is the source.
   */
  source?: string;
  /**
   * Required edges: dep name -> the exact version it resolved to, `link:<path>` for a workspace
   * or the source of a tarball.
   */
  dependencies: Record<string, string>;
  /** The same, for edges `filterPlatform` is allowed to drop. Disjoint from `dependencies`. */
  optionalDependencies?: Record<string, string>;
  /** Reachable only through optionalDependencies edges. */
  optional: boolean;
  /** Reachable only through the root's devDependencies. */
  dev: boolean;
  bin: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  /**
   * As declared. Peers are installed, so they also appear in `dependencies` — which is why
   * this is kept: it is the only record of the *range* a consumer asked for, and `unmetPeers`
   * is what re-reads it.
   */
  peerDependencies?: Record<string, string>;
  /**
   * Which of those the walk settled as peers — against the tree, not by range — and whether
   * each was optional. A declared peer the package also depends on itself is not in here: its
   * own edge won. This is what lets a locked entry's peer edges be told from its own edges,
   * so `locked` can settle them again rather than replay them.
   */
  peers?: Record<string, PeerKind>;
}

export type PeerKind = "required" | "optional";

export interface RootManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: unknown;
  workspaces?: string[] | { packages?: string[] };
}

/** The root's declared ranges, verbatim. Groups with nothing in them are left out. */
export type RootSpecs = Partial<Record<(typeof GROUPS)[number], Record<string, string>>>;

export interface Resolution {
  root: {
    name?: string;
    version?: string;
    specs?: RootSpecs;
    dependencies: Record<string, string>;
    /** The workspace patterns as declared, so the lockfile can tell when they move. */
    workspaces?: string[];
  };
  packages: Record<string, ResolvedPackage>;
  warnings: string[];
}

export interface Platform {
  os: string;
  cpu: string;
  libc?: string;
}

export interface ResolveOptions {
  registry?: Registry;
  /** Picks in flight at most; the registry's own gate adapts below it. Default 32. */
  concurrency?: number;
  /**
   * The previous resolution, to keep as much of as still fits: an edge whose range a locked
   * version satisfies takes that package and everything under it, with no registry involved.
   * Only what package.json moved, or what is new, is resolved afresh.
   */
  locked?: Resolution;
  /**
   * With `locked`: walk every package afresh, but take the highest locked version an edge's
   * range allows before asking the registry for a newer one. A tree that came to hold several
   * versions of a name converges on the fewest — the ones it already has.
   */
  dedupe?: boolean;
  /**
   * Told each package as the walk picks it, before its dependencies are walked — an install
   * starts its tarball then rather than after the lockfile. `from` is the key of the package
   * whose edge reached it first, `""` for the root. `dependencies` is still empty, and a pick
   * can still go: an optional subtree that fails takes what it reached with it. A linux build
   * whose `libc` is still being read comes with that read as `libc`: told now, so a child is
   * never announced before its parent, and `pkg.libc` is set once the read is in.
   */
  onPick?: (pkg: ResolvedPackage, from: string, libc?: Promise<string[] | undefined>) => void;
  /**
   * The workspaces under the root, each a top like it: walked in full, and where an edge from
   * the root or another workspace lands when a `workspace:` spec or a plain range fits its
   * name and version. Never from a registry package, so no `.upm` entry links out to one.
   * Read from disk every resolve, never from the lock.
   */
  workspaces?: { path: string; manifest: RootManifest }[];
  /**
   * Reads a tarball dependency: its package.json, with `dist` giving the source as the tarball
   * and the integrity of its bytes. `source` is as `ResolvedPackage.source` spells it. `pinned`
   * is the integrity the lock has for it, whose bytes are the only ones to read: asked with it
   * when deduping, since a locked tarball is otherwise replayed from the lock. Once per source;
   * without a reader, such a dependency fails.
   */
  tarball?: (source: string, pinned?: string) => Promise<Manifest>;
}

interface Edge {
  name: string;
  version: string;
  optional: boolean;
}

/** The root or a workspace: a manifest walked in full, of which `prod` names the non-dev edges. */
interface Top {
  manifest: RootManifest;
  prod: Set<string>;
}

const ROOT = "";
export const GROUPS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export async function resolveTree(
  manifest: RootManifest,
  options: ResolveOptions = {},
): Promise<Resolution> {
  const registry = options.registry ?? createRegistry();
  const limit = createLimiter(options.concurrency ?? 32);
  const picks = new Map<string, Promise<Manifest>>(); // fetched name@range, or a tarball's source
  const records = new Map<string, ResolvedPackage>(); // name@version
  const edges = new Map<string, Edge[]>(); // name@version (or ROOT) -> children
  const started = new Set<string>();
  const dead = new Map<string, unknown>(); // key -> why it cannot be installed
  const libcs = new Map<string, Promise<string[] | undefined>>(); // name@version -> libc read
  const softPeers = new Map<string, [string, string][]>(); // key -> optional peers, unresolved
  const hardPeers: [string, string, string][] = []; // [consumer, name, range], settled after the walk
  const pending: Promise<void>[] = [];
  const warnings = new Set<string>();
  // Local entries are not replayed: a workspace is what its manifest says now.
  const locked: Record<string, ResolvedPackage> = {};
  for (const [key, pkg] of Object.entries(options.locked?.packages ?? {})) {
    if (pkg.local === undefined) locked[key] = pkg;
  }
  // A registry range is never kept on a tarball: the lockfile could not say where it came from.
  const lockedVersions = byName(Object.values(locked), (key) => locked[key]!.source === undefined);
  // The root and every workspace, with the names of their non-dev edges. Everything else a
  // top declares is dev-only.
  const tops = new Map<string, Top>([[ROOT, top(manifest)]]);
  const local = new Map<string, ResolvedPackage>(); // workspace name -> its record
  for (const ws of options.workspaces ?? []) {
    const found = localRecord(ws.path, ws.manifest);
    const key = keyOf(found);
    const other = local.get(found.name);
    if (other) {
      throw fail(
        `workspaces ${other.local} and ${ws.path} are both named ${found.name}`,
        "EWORKSPACE",
      );
    }
    local.set(found.name, found);
    tops.set(key, top(ws.manifest));
    started.add(key);
    records.set(key, found);
  }

  // Memoized on the fetched name and range, not the dep name: the same range never resolves
  // twice, and two aliases of one package share the pick with each other and with a plain dep.
  function pick(spec: Spec, fresh = false): Promise<Manifest> {
    const key = `${fresh ? "!" : ""}${spec.fetchName}@${spec.fetchSpec}`;
    let hit = picks.get(key);
    if (!hit) {
      hit = limit(() => fetchManifest(spec, fresh));
      hit.catch(() => {}); // a required edge reports it; an optional one may never await
      picks.set(key, hit);
    }
    return hit;
  }

  /**
   * A pinned spec wants one version, so the registry gets to answer for that version alone —
   * by whichever of the per-version route and the packument is cheaper for the name (see
   * `registry.ts`). Anything the registry cannot answer that way falls through to the
   * packument, so the errors stay the packument's.
   */
  async function fetchManifest(spec: Spec, fresh: boolean): Promise<Manifest> {
    // `=1.2.3` and `v1.2.3` are exact specs but never registry paths. Deduping pins the same
    // way: the locked version it prefers is one the registry answers for by version.
    const exact = spec.type === "version" ? parse(spec.fetchSpec)?.version : undefined;
    const wanted = exact ?? (options.dedupe && !fresh ? kept(spec) : undefined);
    if (registry.pick) return await registry.pick(spec, wanted);
    const found = wanted === undefined ? undefined : await registry.pinned(spec.fetchName, wanted);
    return found ?? pickManifest(await registry.view(spec.fetchName), spec);
  }

  /**
   * The abbreviated packument leaves `libc` out, and the lockfile is written for other
   * machines too, so every linux build costs the read — never the name: `rustywind-linux-x64-musl`
   * declares no libc, which means any, and a lock that said `musl` would drop it on glibc.
   */
  function needsLibc(m: Manifest): boolean {
    if (m.libc !== undefined) return false;
    if (m.os === undefined && m.cpu === undefined) return false; // not a platform build
    return matches(m.os, "linux");
  }

  /** The read, once per package and off the pick; the edge that reached it waits for it. */
  function libcOf(m: Manifest): Promise<string[] | undefined> {
    const key = `${m.name}@${m.version}`;
    let hit = libcs.get(key);
    if (!hit) {
      hit = registry.manifest(m.name, m.version).then((full) => full.libc);
      hit.catch(() => {});
      libcs.set(key, hit);
    }
    return hit;
  }

  // `name` is what the package is installed as, which an alias makes differ from `m.name`.
  // Returns nothing when the package is already being walked, which is how cycles end.
  function visit(
    from: string,
    name: string,
    m: Manifest,
    source?: string,
  ): Promise<void> | undefined {
    const key = `${name}@${source ?? m.version}`;
    if (started.has(key)) return undefined;
    started.add(key);
    edges.set(key, []);
    const task = walk(from, key, name, m, source);
    // A later parent never awaits this walk, so record the failure where everyone can see it.
    task.catch((error: unknown) => dead.set(key, error));
    pending.push(task);
    return task;
  }

  async function walk(
    from: string,
    key: string,
    name: string,
    m: Manifest,
    source?: string,
  ): Promise<void> {
    const found = record(name, m, source);
    records.set(key, found);
    // The libc read is off the pick and does not hold the children; `onPick` gets it to wait
    // on, since a musl build is not this machine's until it is in. A tarball's package.json is
    // whole, so it has none to read.
    const libc = source === undefined && needsLibc(m) ? libcOf(m) : undefined;
    libc?.then(
      (read) => {
        if (read !== undefined) found.libc = read;
      },
      () => {},
    );
    options.onPick?.(found, from, libc);
    const optional = m.optionalDependencies ?? {};
    const own = m.dependencies ?? {};
    const peers = declaredPeers(m);
    if (Object.keys(peers).length > 0) found.peers = peers;
    await Promise.all([
      ...Object.entries(own)
        .filter(([n]) => !(n in optional))
        .map(([n, r]) => edge(key, n, r, false)),
      ...Object.entries(optional).map(([n, r]) => edge(key, n, r, true)),
    ]);
    settle(key, peers, m.peerDependencies ?? {});
  }

  /**
   * Peers wait: a plugin must reuse the host the tree already has, not pick its own. A
   * required peer becomes an ordinary edge, so it sits in the store entry the consumer
   * resolves from. One version per peer: duplicating the consumer is npm's algorithm, not
   * ours. An optional peer means "use it if it is here", so it is never a reason to install
   * anything.
   */
  function settle(key: string, peers: Record<string, PeerKind>, ranges: Record<string, string>) {
    const soft: [string, string][] = [];
    for (const [n, kind] of Object.entries(peers)) {
      if (kind === "optional") soft.push([n, ranges[n]!]);
      else hardPeers.push([key, n, ranges[n]!]);
    }
    softPeers.set(key, soft);
  }

  /**
   * The locked version an edge can keep. Not for a tag, which only the registry can read. An
   * alias only when its locked entry is proven to be the aliased package — its tarball is the
   * one the registry serves for that name — since the alias may point elsewhere by now.
   */
  function kept(spec: Spec): string | undefined {
    if (spec.type === "tag") return undefined;
    const same = (version: string) =>
      spec.fetchName === spec.name ||
      locked[`${spec.name}@${version}`]?.resolved ===
        tarballUrl(registry.baseFor(spec.fetchName), spec.fetchName, version);
    const versions = (lockedVersions.get(spec.name) ?? []).map((p) => p.version).filter(same);
    return maxSatisfying(versions, spec.fetchSpec);
  }

  /**
   * A locked package and everything under its own edges. The lockfile was validated closed,
   * so every child is locked too. Its peer edges are not replayed: they were settled against
   * the tree of that time, and a peer is settled against the tree at hand — otherwise a
   * plugin would keep the host version it was locked with next to the one the root moved to.
   * `settlePeers` falls back to the locked version when nothing in the tree satisfies.
   */
  function visitLocked(from: string, key: string): void {
    if (started.has(key)) return;
    started.add(key);
    const { dependencies, optionalDependencies = {}, ...pkg } = locked[key]!;
    const peers = pkg.peers ?? {};
    const found = { ...pkg, dependencies: {}, optional: true, dev: true };
    records.set(key, found);
    options.onPick?.(found, from);
    const list: Edge[] = [];
    for (const [optional, map] of [
      [false, dependencies],
      [true, optionalDependencies],
    ] as const) {
      for (const [name, version] of Object.entries(map)) {
        if (name in peers) continue;
        list.push({ name, version, optional });
        visitLocked(key, `${name}@${version}`);
      }
    }
    edges.set(key, list);
    settle(key, peers, pkg.peerDependencies ?? {});
  }

  /**
   * The workspace an edge lands on, if any. A `workspace:` spec accepts nothing else. A plain
   * range or version takes a workspace of that name when its version fits, as npm does; when
   * it does not, the registry answers, and the mismatch is said once. A tag or an alias never
   * names a workspace. Only the root and workspaces look here: a registry package's edge
   * goes to the registry, so no `.upm` entry links out to a workspace.
   */
  function localFor(spec: Spec, from: string): ResolvedPackage | undefined {
    const found = local.get(spec.fetchName);
    // A workspace is not its own workspace: a plain range on its name asks the registry, as
    // a registry package's self-dep does, and `workspace:` has nothing to land on.
    const self = found !== undefined && keyOf(found) === from;
    if (spec.type === "workspace") {
      if (!found) throw fail(`no workspace package named ${spec.fetchName}`, "EWORKSPACE");
      if (self) throw fail(`workspace ${spec.name} cannot depend on itself`, "EWORKSPACE");
      if (spec.fetchName !== spec.name) {
        throw fail(`workspace ${spec.fetchName} cannot be installed as ${spec.name}`, "EWORKSPACE");
      }
      if (!fits(found.version, spec.fetchSpec)) {
        const have = `(have ${found.version})`;
        throw fail(
          `no workspace version of ${spec.name} satisfies ${spec.fetchSpec} ${have}`,
          "EWORKSPACE",
        );
      }
      return found;
    }
    if (!found || self || spec.type === "tag" || spec.fetchName !== spec.name) return undefined;
    if (fits(found.version, spec.fetchSpec)) return found;
    const who = `${spec.name}@${found.version}`;
    warnings.add(
      `workspace ${who} does not satisfy ${spec.fetchSpec} from ${from || "root"}; using the registry`,
    );
    return undefined;
  }

  /**
   * Where a tarball is, as its key spells it. A path is read from the package.json that declares
   * it, so only a top may have one: a registry package's own directory is nowhere in the tree.
   */
  function sourceOf(fetchSpec: string, from: string): string {
    if (!fetchSpec.startsWith("file:")) return fetchSpec;
    const top = records.get(from)?.local ?? (from === ROOT ? "" : undefined);
    if (top === undefined) {
      throw fail(
        `a local tarball can be a dependency of the root or a workspace only`,
        "EINVALIDSPEC",
      );
    }
    return tarballSource(fetchSpec, top);
  }

  /** A tarball's package.json, once per source. A source has a `:`, which no name has. */
  function read(source: string, pinned?: string): Promise<Manifest> {
    const { tarball } = options;
    if (!tarball) throw fail(`nothing reads tarballs here, so not ${source}`, "EINVALIDSPEC");
    let hit = picks.get(source);
    if (!hit) {
      hit = limit(() => tarball(source, pinned));
      hit.catch(() => {});
      picks.set(source, hit);
    }
    return hit;
  }

  /** The version `from` was locked with for its required peer `name`, if it was locked at all. */
  function lockedPeer(from: string, name: string): string | undefined {
    const deps = locked[from]?.dependencies;
    return deps && Object.hasOwn(deps, name) ? deps[name] : undefined;
  }

  /**
   * `optional` marks an optionalDependencies edge: the boundary that swallows failures.
   * `fresh` skips the lockfile: a new consumer's peer that nothing in the tree satisfies is
   * fetched the way a fresh resolve would, not revived from a lock entry nothing reaches —
   * or worse, taken from a dev-only one.
   */
  async function edge(
    from: string,
    name: string,
    range: string,
    optional: boolean,
    fresh = false,
  ): Promise<void> {
    try {
      const spec = parseDep(name, range);
      if (spec.type === "tarball") {
        const source = sourceOf(spec.fetchSpec, from);
        // Replayed when locked, as a kept registry version is. Walked again when deduping, so its
        // own ranges choose again, but from the bytes the lock pinned: those never move.
        const pinned = locked[`${spec.name}@${source}`]?.integrity;
        if (pinned !== undefined && !fresh && !options.dedupe) {
          visitLocked(from, `${spec.name}@${source}`);
        } else await visit(from, spec.name, await read(source, pinned), source);
        edges.get(from)?.push({ name: spec.name, version: source, optional });
        return;
      }
      const ws = tops.has(from) ? localFor(spec, from) : undefined;
      if (ws) {
        edges.get(from)?.push({ name: spec.name, version: versionOf(ws), optional });
        return;
      }
      // Deduping walks a kept version like any other, so its ranges get to choose again.
      const version = fresh || options.dedupe ? undefined : kept(spec);
      if (version !== undefined) {
        visitLocked(from, `${spec.name}@${version}`);
        edges.get(from)?.push({ name: spec.name, version, optional });
        return;
      }
      const m = await pick(spec, fresh);
      // No os/cpu/libc test here: that is filterPlatform's job, at install time.
      // Installed under the declared name, so an alias is its own node and the linker,
      // the lockfile and the store key all keep `name@version` as the one identity.
      const walked = visit(from, spec.name, m);
      // The libc read the walk above started is this edge's to fail on.
      if (needsLibc(m)) await libcOf(m);
      await walked;
      edges.get(from)?.push({ name: spec.name, version: m.version, optional });
    } catch (error) {
      // Offline, a skipped optional would be locked out for good, where online it is fetched.
      const offline = (error as { code?: string }).code === "EOFFLINE";
      if (!optional || offline) throw context(error, name, range, from);
      warnings.add(`skipped optional ${name}@${range} of ${from || "root"}: ${reason(error)}`);
    }
  }

  /** Everything a top's non-dev edges reach. A devDependency subtree is never in here. */
  function shippedSet(): Set<string> {
    return crawl(edges, tops.keys(), (e, from) => tops.get(from)?.prod.has(e.name) ?? true);
  }

  /**
   * A required peer resolves against the tree first, so `eslint-utils` reuses the `eslint`
   * already there instead of pulling a second copy. Only an unmet peer is fetched, and each
   * fetch can declare peers of its own, so this runs to a fixpoint.
   *
   * A shipped consumer is only offered shipped versions. Otherwise a devDependency could both
   * pick a production package's peer version and get marked production itself.
   */
  async function settlePeers(): Promise<void> {
    while (hardPeers.length > 0) {
      const todo = hardPeers.splice(0).sort();
      // Recomputed each round: a peer fetched for a shipped consumer joins the shipped set.
      const shipped = shippedSet();
      // A package whose walk failed is about to be pruned, so reusing it fails the consumer.
      const alive = (key: string) => !dead.has(key);
      const have = byName(records.values(), alive);
      const shippedHave = byName(records.values(), (key) => alive(key) && shipped.has(key));
      const unmet = new Map<string, [from: string, range: string][]>();
      for (const [from, name, range] of todo) {
        const list = edges.get(from);
        if (!list || dead.has(from) || list.some((e) => e.name === name)) continue;
        const pool = shipped.has(from) ? shippedHave : have;
        const best = settleOn(from, name, range, pool);
        if (best) {
          list.push({ name, version: best, optional: false });
          continue;
        }
        const group = unmet.get(name);
        if (group) group.push([from, range]);
        else unmet.set(name, [[from, range]]);
      }
      await Promise.all([...unmet].map(([name, group]) => fetchPeer(name, group, have)));
      while (pending.length > 0) await Promise.allSettled(pending.splice(0));
    }
  }

  /**
   * A peer nothing in the tree meets. Consumers that miss the same name share one version when
   * one meets every range: `@typescript-eslint/*` caps typescript where `ts-api-utils` does
   * not, and a copy each would hand them two compilers. Only ranges with nothing in common get
   * a version each.
   *
   * The version a consumer was locked with comes first, if it still fits and is not in the tree
   * already — in the tree but not in the pool means dev-only, which a shipped consumer may not
   * take. Asked for as an exact edge, so a kept walk takes it from the lock and a deduping one
   * from the registry, like any other edge.
   */
  async function fetchPeer(
    name: string,
    group: [from: string, range: string][],
    have: Map<string, ResolvedPackage[]>,
  ): Promise<void> {
    const ranges = group.map(([, range]) => range);
    const reuse = (v: string | undefined, of: string[]): v is string =>
      v !== undefined &&
      of.every((r) => satisfies(v, r)) &&
      !have.get(name)?.some((p) => p.version === v);
    const all = group.length > 1 ? intersect(ranges) : undefined;
    const locked = group.map(([from]) => lockedPeer(from, name));
    let shared =
      all &&
      maxSatisfying(
        locked.filter((v) => reuse(v, ranges)),
        all,
      );
    const kept = !!shared;
    if (all && !kept) {
      // The intersection is only a guess at prerelease edges, so the pick must meet each range.
      const m = await pick(parseDep(name, all), true).catch(() => undefined);
      if (m && ranges.every((r) => satisfies(m.version, r))) shared = all;
    }
    await Promise.all(
      group.map(([from, range], i) => {
        const own = locked[i];
        const [spec, fresh] = shared
          ? [shared, !kept]
          : reuse(own, [range])
            ? [own, false]
            : [range, true];
        // prune() decides what an unmet peer costs: an optional ancestor drops, a required one dies.
        return edge(from, name, spec, false, fresh).catch((e: unknown) => void dead.set(from, e));
      }),
    );
  }

  /**
   * The edge version a peer `name@range` of `from` settles on out of `pool`, if any. A top takes
   * the workspace when it fits, the way its own edges do; a registry package is never offered
   * one, and the registry versions are what is left.
   */
  function settleOn(
    from: string,
    name: string,
    range: string,
    pool: Map<string, ResolvedPackage[]>,
  ): string | undefined {
    const found = pool.get(name) ?? [];
    const ws = tops.has(from) ? found.find((p) => p.local !== undefined) : undefined;
    if (ws && fits(ws.version, range)) return versionOf(ws);
    const packages = found.filter((p) => p.local === undefined);
    const best = maxSatisfying(
      packages.map((p) => p.version),
      range,
    );
    // A tarball is a version too, so a plugin can share a host the root installed from one.
    // Of two copies of the version, the one a top links by this name wins: it is the copy that
    // top chose. Otherwise the first by key, so which was read first never decides.
    const same = packages
      .filter((p) => p.version === best)
      .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
    if (same.length < 2) return same[0] && versionOf(same[0]);
    const linked = (p: ResolvedPackage) =>
      [...tops.keys()].some((top) =>
        edges.get(top)?.some((e) => e.name === name && e.version === versionOf(p)),
      );
    return versionOf(same.find(linked) ?? same[0]!);
  }

  const walks: Promise<void>[] = [];
  for (const [key, { manifest: m }] of tops) {
    edges.set(key, []);
    walks.push(...rootEdges(m).map((e) => edge(key, ...e)));
    if (key !== ROOT) settle(key, records.get(key)!.peers ?? {}, m.peerDependencies ?? {});
  }
  await Promise.all(walks);
  // A dropped optional subtree can leave work running; let it finish so the walk is stable.
  while (pending.length > 0) await Promise.allSettled(pending.splice(0));

  // Prune before settling, so peers resolve against the base graph as it will actually ship.
  prune(edges, records, dead, warnings, tops);
  await settlePeers();
  prune(edges, records, dead, warnings, tops); // settling can kill a consumer whose peer never met
  wireSoftPeers(edges, records, softPeers, shippedSet(), settleOn);

  // Both flags are reachability, not inheritance: one path that avoids the edge clears it.
  const reachable = crawl(edges, tops.keys(), () => true);
  const required = crawl(edges, tops.keys(), (e) => !e.optional);
  const shipped = shippedSet();
  const packages: Record<string, ResolvedPackage> = {};
  for (const key of [...reachable].sort()) {
    const found = records.get(key);
    if (!found) continue;
    const deps: Record<string, string> = {};
    const optionals: Record<string, string> = {};
    // Which map an edge lands in is what lets filterPlatform tell a binding it may drop from
    // a dependency whose absence takes the whole subtree with it.
    for (const e of edges.get(key) ?? []) (e.optional ? optionals : deps)[e.name] = e.version;
    packages[key] = {
      ...found,
      optional: !required.has(key),
      dev: !shipped.has(key),
      dependencies: sorted(deps),
      ...(Object.keys(optionals).length > 0 && { optionalDependencies: sorted(optionals) }),
    };
  }

  const direct: Record<string, string> = {};
  for (const e of edges.get(ROOT) ?? []) direct[e.name] = e.version;
  const specs = declaredSpecs(manifest);
  const patterns = declaredWorkspaces(manifest);
  return {
    root: {
      name: manifest.name,
      version: manifest.version,
      ...(specs && { specs }),
      dependencies: sorted(direct),
      ...(patterns && { workspaces: patterns }),
    },
    packages,
    warnings: [...warnings].sort(),
  };
}

/** What the resolution was made from, so `lock` can tell whether package.json moved. */
export function declaredSpecs(manifest: RootManifest): RootSpecs | undefined {
  const out: RootSpecs = {};
  for (const group of GROUPS) {
    const map = sorted(manifest[group] ?? {});
    if (Object.keys(map).length > 0) out[group] = map;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The workspace patterns as declared: a list, or npm's `{ packages }` object. */
export function declaredWorkspaces(manifest: RootManifest): string[] | undefined {
  const ws = manifest.workspaces;
  return Array.isArray(ws) ? ws : ws?.packages;
}

/**
 * Narrow a resolution to the packages that run here.
 *
 * The lockfile holds every platform's builds, because a lockfile is committed and installed
 * from by machines that are not the one that wrote it. This is where a tree stops being
 * portable, and it needs no network: `os`, `cpu` and `libc` came off the manifests and were
 * written down. A package with a required edge to something that cannot run here goes too —
 * it can only ever be inside an optional subtree, which is npm's rule for what may vanish.
 */
export function filterPlatform(resolution: Resolution, target?: Platform): Resolution {
  const platform = target ?? currentPlatform();
  const warnings = new Set(resolution.warnings);
  const gone = new Map<string, string>(); // key -> why, so a parent can say what it lost
  const drop = (key: string, why: string): void => {
    const found = resolution.packages[key];
    // `optional: false` means an all-required path from the root reaches it: nothing to fall
    // back to, and installing the tree without it would be a quiet lie.
    if (found && !found.optional) throw fail(`${key} ${why}`, "EBADPLATFORM");
    gone.set(key, why);
  };

  // Silent: a lockfile written for every platform is mostly builds for other platforms, and
  // saying so once per package would bury everything else an install has to report.
  for (const [key, found] of Object.entries(resolution.packages)) {
    if (!runsOn(found, platform)) drop(key, `does not run on ${show(platform)}`);
  }
  // A required edge to a dropped package takes its owner with it, until nothing points at
  // anything missing. Same fixpoint as the resolver's prune, on the same reasoning — and
  // unlike the drops above this one loses a package that was meant to be here, so it is said.
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, found] of Object.entries(resolution.packages)) {
      if (gone.has(key)) continue;
      for (const [name, version] of Object.entries(found.dependencies)) {
        if (!gone.has(`${name}@${version}`)) continue;
        const why = `needs ${name}@${version}, which ${gone.get(`${name}@${version}`)!}`;
        drop(key, why);
        warnings.add(`skipped optional ${key}: ${why}`);
        changed = true;
        break;
      }
    }
  }

  const keep = reach(resolution, (key) => !gone.has(key));
  // Recomputed, not carried over: a package the root shipped only through an optional build
  // that just went is now reachable through devDependencies alone.
  const shipped = reach(
    resolution,
    (key) => keep.has(key),
    (key) => resolution.packages[key]?.dev === false,
  );
  const packages: Record<string, ResolvedPackage> = {};
  for (const key of [...keep].sort()) {
    const found = resolution.packages[key]!;
    packages[key] = {
      ...found,
      dependencies: present(found.dependencies, keep),
      dev: !shipped.has(key),
    };
    const optionals = present(found.optionalDependencies ?? {}, keep);
    if (Object.keys(optionals).length > 0) packages[key].optionalDependencies = optionals;
    else delete packages[key].optionalDependencies;
  }
  return {
    root: { ...resolution.root, dependencies: present(resolution.root.dependencies, keep) },
    packages,
    warnings: [...warnings].sort(),
  };
}

/**
 * Consumers whose declared peer range is not what the tree installed.
 *
 * An own dependency can conflict with the consumer's peer range. The lockfile keeps that
 * range so `--verify` can report the conflict; installation cannot choose a new peer context.
 */
export function unmetPeers(resolution: Resolution): string[] {
  const out: string[] = [];
  for (const key of Object.keys(resolution.packages).sort()) {
    const pkg = resolution.packages[key]!;
    const deps = allDeps(pkg);
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {}).sort()) {
      const edge = deps[name];
      // Absent means nothing was installed under that name: an optional peer, or one the
      // platform filter dropped. Both are reported where they happen, not again here.
      if (edge === undefined) continue;
      const have = resolution.packages[`${name}@${edge}`]?.version ?? edge; // a link: edge
      if (!validRange(range)) {
        out.push(`${key} declares peer ${name}@${range}, which is not a range we can read`);
      } else if (!satisfies(have, range)) {
        out.push(`${key} needs peer ${name}@${range}, and the tree installs ${name}@${have}`);
      }
    }
  }
  return out;
}

/** Both edge maps as one. To the linker and the store key, an installed dep is a dep. */
export function allDeps(pkg: ResolvedPackage): Record<string, string> {
  if (!pkg.optionalDependencies) return pkg.dependencies;
  return sorted({ ...pkg.dependencies, ...pkg.optionalDependencies });
}

/**
 * Everything `keep` accepts that the tops' `from` edges reach, over both dependency maps.
 * A top is the root or a workspace; a workspace is always in, and its own edges are filtered
 * like the root's, so its devDependencies do not ship through it.
 */
function reach(
  resolution: Resolution,
  keep: (key: string) => boolean,
  from: (key: string) => boolean = () => true,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  const push = (key: string, top: boolean): void => {
    if (seen.has(key) || !resolution.packages[key] || !keep(key)) return;
    if (top && !from(key)) return;
    seen.add(key);
    queue.push(key);
  };
  for (const [name, version] of Object.entries(resolution.root.dependencies)) {
    push(`${name}@${version}`, true);
  }
  for (const [key, found] of Object.entries(resolution.packages)) {
    if (found.local !== undefined) push(key, false);
  }
  for (const key of queue) {
    const found = resolution.packages[key]!;
    const top = found.local !== undefined;
    for (const map of [found.dependencies, found.optionalDependencies ?? {}]) {
      for (const [name, version] of Object.entries(map)) push(`${name}@${version}`, top);
    }
  }
  return seen;
}

function present(deps: Record<string, string>, keep: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, version] of Object.entries(deps)) {
    if (keep.has(`${name}@${version}`)) out[name] = version;
  }
  return out;
}

/**
 * An optional peer is never a reason to install anything, but if the tree already holds a
 * version that satisfies it, the consumer should still see it — otherwise the feature it
 * guards can never switch on inside a `.upm` entry.
 *
 * A shipped consumer only sees shipped versions: a devDependency is not worth promoting into
 * production for a feature that is allowed to stay off.
 */
function wireSoftPeers(
  edges: Map<string, Edge[]>,
  records: Map<string, ResolvedPackage>,
  softPeers: Map<string, [string, string][]>,
  shipped: Set<string>,
  settleOn: (
    from: string,
    name: string,
    range: string,
    pool: Map<string, ResolvedPackage[]>,
  ) => string | undefined,
): void {
  const all = byName(records.values(), () => true);
  const prod = byName(records.values(), (key) => shipped.has(key));
  for (const [key, peers] of softPeers) {
    const list = edges.get(key);
    if (!list) continue;
    const pool = shipped.has(key) ? prod : all;
    for (const [name, range] of peers) {
      if (list.some((e) => e.name === name)) continue;
      const best = settleOn(key, name, range, pool);
      if (best) list.push({ name, version: best, optional: true });
    }
  }
}

/** Package name -> the records of it `keep` accepts. `maxSatisfying` sorts, so order is free. */
function byName(
  found: Iterable<ResolvedPackage>,
  keep: (key: string) => boolean,
): Map<string, ResolvedPackage[]> {
  const out = new Map<string, ResolvedPackage[]>();
  for (const p of found) {
    if (!keep(keyOf(p))) continue;
    out.set(p.name, [...(out.get(p.name) ?? []), p]);
  }
  return out;
}

/** What an edge to `pkg` carries as its version: `link:<path>` for a workspace, a tarball's source. */
function versionOf(pkg: ResolvedPackage): string {
  return pkg.local === undefined ? (pkg.source ?? pkg.version) : `link:${pkg.local}`;
}

/** The one identity of a package: `name@version`, `name@link:<path>` or `name@<source>`. */
export function keyOf(pkg: ResolvedPackage): string {
  return `${pkg.name}@${versionOf(pkg)}`;
}

/**
 * Cycles mean only the first parent of a package awaits its walk, so a failure deep in the
 * graph is invisible to every other parent. Drop those edges here instead: an optional parent
 * warns, a required one dies too, until nothing points at anything unusable.
 */
function prune(
  edges: Map<string, Edge[]>,
  records: Map<string, ResolvedPackage>,
  dead: Map<string, unknown>,
  warnings: Set<string>,
  tops: Map<string, unknown>,
): void {
  // A top has nothing above it to fall back on, so what kills it fails the resolve.
  for (const [key, why] of dead) if (tops.has(key)) throw why;
  for (let changed = true; changed;) {
    changed = false;
    for (const [key, list] of edges) {
      if (dead.has(key)) continue;
      const keep = list.filter((e) => {
        const child = `${e.name}@${e.version}`;
        if (!dead.has(child) && records.has(child)) return true;
        changed = true;
        const why = dead.get(child) ?? fail(`${child} was not resolved`, "ERESOLVE");
        if (!e.optional && tops.has(key)) throw context(why, e.name, e.version, key);
        if (e.optional) {
          warnings.add(
            `skipped optional ${e.name}@${e.version} of ${key === ROOT ? "root" : key}: ${reason(why)}`,
          );
        } else {
          dead.set(key, why);
        }
        return false;
      });
      if (keep.length !== list.length) edges.set(key, keep);
    }
  }
  for (const key of dead.keys()) {
    edges.delete(key);
    records.delete(key);
  }
}

/** The declared peers the walk settles as peers. One the package also depends on is not: its own edge wins. */
function declaredPeers(m: RootManifest): Record<string, PeerKind> {
  const own = m.dependencies ?? {};
  const optional = m.optionalDependencies ?? {};
  const meta = m.peerDependenciesMeta ?? {};
  const out: Record<string, PeerKind> = {};
  for (const name of Object.keys(m.peerDependencies ?? {}).sort()) {
    if (name in own || name in optional) continue;
    out[name] = meta[name]?.optional === true ? "optional" : "required";
  }
  return out;
}

/** Direct edges of the root as `[name, range, optional]`. A name in both groups is optional. */
function rootEdges(manifest: RootManifest): [string, string, boolean][] {
  const optional = manifest.optionalDependencies ?? {};
  const seen = new Set(Object.keys(optional));
  const out: [string, string, boolean][] = Object.entries(optional).map(([n, r]) => [n, r, true]);
  for (const group of [manifest.dependencies, manifest.devDependencies]) {
    for (const [name, range] of Object.entries(group ?? {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push([name, range, false]);
    }
  }
  return out;
}

/** A peer ships too, unless a devDependency of the same name gives the edge, as npm has it. */
function top(manifest: RootManifest): Top {
  const dev = manifest.devDependencies ?? {};
  const prod = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}).filter((name) => !(name in dev)),
  ]);
  return { manifest, prod };
}

/**
 * Whether a workspace path can be trusted where it is used: the lockfile keys entries by it
 * and the linker joins it onto the root, so it is relative, `/`-separated and never climbs.
 */
export function localPath(path: string): boolean {
  if (path === "" || path.includes("\\")) return false;
  return !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

/**
 * What a workspace's entry carries of its manifest besides its edges. `sameTree` compares the
 * same shape against the lockfile, so a change here is a change it sees.
 */
export function localShape(
  m: RootManifest,
): Pick<ResolvedPackage, "specs" | "bin" | "peerDependencies" | "peers"> {
  const peers = declaredPeers(m);
  const specs = declaredSpecs(m);
  return {
    ...(specs && { specs }),
    bin: normalizeBin(m),
    ...(m.peerDependencies ? { peerDependencies: sorted(m.peerDependencies) } : {}),
    ...(Object.keys(peers).length > 0 && { peers }),
  };
}

/** A workspace as a package: named and versioned by its manifest, placed by its path. */
function localRecord(path: string, m: RootManifest): ResolvedPackage {
  if (!localPath(path)) {
    throw fail(`workspace path ${path} is not a relative path inside the project`, "EWORKSPACE");
  }
  const name = m.name ?? path.split("/").at(-1)!;
  const version = m.version ?? "0.0.0";
  // Both halves become a key and path segments, so they get a lockfile key's checks.
  let ok = parse(version)?.version === version;
  try {
    parseDep(name, version);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw fail(
      `workspace at ${path} has an invalid name or version (${name}@${version})`,
      "EWORKSPACE",
    );
  }
  return {
    name,
    version,
    resolved: "",
    integrity: "",
    local: path,
    dependencies: {},
    optional: false,
    dev: false,
    ...localShape(m),
  };
}

/** `*` takes any version, a prerelease too, as npm reads it. */
function fits(version: string, range: string): boolean {
  return range === "*" || satisfies(version, range);
}

function record(name: string, m: Manifest, source?: string): ResolvedPackage {
  return {
    name,
    version: m.version,
    resolved: source ?? m.dist.tarball,
    integrity: integrityOf(m),
    ...(source !== undefined && { source }),
    dependencies: {},
    optional: true,
    dev: true,
    bin: normalizeBin(m), // an alias renames the package, never its bins
    ...(m.os ? { os: m.os } : {}),
    ...(m.cpu ? { cpu: m.cpu } : {}),
    ...(m.libc ? { libc: m.libc } : {}),
    ...(m.peerDependencies ? { peerDependencies: sorted(m.peerDependencies) } : {}),
  };
}

/** Packages published before 2017 carry only a legacy sha1 `shasum`. */
export function integrityOf(m: Manifest): string {
  const { integrity, shasum } = m.dist;
  if (integrity) return integrity;
  if (shasum) return fromShasum(shasum);
  throw fail(`${m.name}@${m.version} has no dist integrity or shasum`, "EINTEGRITY");
}

/** Every top but the root, and everything the tops reach through the edges `keep` accepts. */
function crawl(
  edges: Map<string, Edge[]>,
  tops: Iterable<string>,
  keep: (edge: Edge, from: string) => boolean,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const top of tops) {
    if (top !== ROOT) seen.add(top);
    queue.push(top);
  }
  for (const key of queue) {
    for (const e of edges.get(key) ?? []) {
      if (!keep(e, key)) continue;
      const child = `${e.name}@${e.version}`;
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

/** npm semantics: `!x` blocks, a plain list allows, `any` and an empty list match all. */
function matches(list: string[] | string | undefined, value: string): boolean {
  if (typeof list === "string") list = [list]; // npm accepts a bare string here
  // Only a list that is exactly ["any"] waives the check; ["any", "!win32"] still excludes win32.
  if (!list || list.length === 0 || (list.length === 1 && list[0] === "any")) return true;
  let negated = 0;
  let match = false;
  for (const entry of list) {
    if (entry.startsWith("!")) {
      negated++;
      if (entry.slice(1) === value) return false;
    } else if (entry === value) {
      match = true;
    }
  }
  return match || negated === list.length;
}

type PlatformFields = Pick<Manifest, "os" | "cpu" | "libc">;

/** Whether what a package declares lets it run on `platform`. */
export function runsOn(m: PlatformFields, platform: Platform): boolean {
  return (
    matches(m.os, platform.os) &&
    matches(m.cpu, platform.cpu) &&
    // A package that declares libc cannot be trusted on a target whose libc we cannot read.
    (m.libc === undefined || m.libc.length === 0
      ? true
      : platform.libc !== undefined && matches(m.libc, platform.libc))
  );
}

export function currentPlatform(): Platform {
  const proc = globalThis.process;
  if (!proc?.platform) {
    throw Object.assign(new Error("No current platform here; pass one to filterPlatform"), {
      code: "ENOPLATFORM",
    });
  }
  return {
    os: proc.platform,
    cpu: proc.arch,
    libc: proc.platform === "linux" ? libc() : undefined,
  };
}

/**
 * glibc or musl, read off what this process has mapped: musl's loader is `ld-musl-<arch>.so.1`,
 * glibc's C library `libc.so.6` — or `libc-2.<minor>.so` before glibc 2.34 (Debian 11, Ubuntu
 * 20.04, RHEL 8), where `libc.so.6` is a symlink and maps show the file. `process.report.getReport()`
 * answers too, the way npm reads it (only a glibc build reports a runtime version), but building
 * the whole report costs 1.7 ms on every command, so it is the fallback for a Node that maps no
 * libc, such as a static one.
 */
function libc(): string | undefined {
  try {
    const maps = builtin.fs.readFileSync("/proc/self/maps", "latin1");
    if (maps.includes("/ld-musl-")) return "musl";
    if (maps.includes("/libc.so.6") || maps.includes("/libc-2.")) return "glibc";
  } catch {}
  try {
    const report = globalThis.process?.report?.getReport() as {
      header?: { glibcVersionRuntime?: string };
    };
    return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
  } catch {}
  return undefined;
}

function show(p: Platform): string {
  return `${p.os}-${p.cpu}${p.libc ? `-${p.libc}` : ""}`;
}

function reason(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

/** Keep the underlying code, but say which edge failed. */
function context(error: unknown, name: string, range: string, from: string): Error {
  const where = `${name}@${range} (required by ${from || "root"})`;
  return Object.assign(new Error(`${reason(error)} — resolving ${where}`), {
    code: (error as { code?: string })?.code,
    cause: error,
  });
}

export function sorted(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function fail(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Bounds concurrent packument fetches; a deep tree resolved serially is unusably slow. */

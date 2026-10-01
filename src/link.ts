// Materialize node_modules. One `.upm` entry per subgraph key holds the real files,
// hardlinked from the per-file CAS; everything else is a relative symlink. IDEA.md 5.4.
import type { Progress } from "./api.ts";
import { builtin } from "./builtin.ts";
import { storeKeys } from "./keys.ts";
import { createLimiter } from "./limit.ts";
import {
  alive,
  misdeclaredIn,
  exists,
  linkArgs,
  list,
  misdeclared,
  mismatch,
  trace,
  readLink,
  readLinkSync,
  sizeOf,
} from "./util.ts";
import type { Identity } from "./util.ts";
import { allDeps } from "./resolve.ts";
import { pid } from "./runtime.ts";
import type { ResolvedPackage, Resolution } from "./resolve.ts";
import { clearState, readState, stateHash, writeState } from "./state.ts";
import type { InstallState, TopLinks } from "./state.ts";
import type { PackageIndex, Store } from "./store.ts";

export interface LinkOptions {
  dir: string;
  store: Store;
  /** Max entries materialized at once. Default 16. */
  concurrency?: number;
  /** Skip packages only devDependencies reach. */
  production?: boolean;
  /** False leaves out `.upm/node_modules`, the names a package may reach undeclared. */
  hoist?: boolean;
  /** Ignore the recorded state and check every entry on disk. */
  verify?: boolean;
  /**
   * `stateHash` of this resolution under these same `production` and `store`, when the caller
   * already has it. Computed here otherwise.
   */
  hash?: string;
  /**
   * Asked once, for a pool of worker threads to build the entries on, with a count of the
   * files in the entries `.upm` does not hold yet — a function, since counting means
   * reading every index, which a caller with a pool already up need not have done. Nothing
   * means every entry is built here, as without a pool.
   */
  pool?: (files: () => number) => Promise<LinkPool | undefined>;
  /**
   * The store is still filling: a promise for a tarball still on its way, or nothing when its
   * index is there to read. Each entry is then built as soon as its own tarball lands and its
   * dependencies are known to be in or dropped, under the tail of the downloads. The pool is
   * then asked with the files landed so far, once per count, until it is up.
   */
  awaiting?: (integrity: string) => Promise<unknown> | undefined;
  /**
   * Optionals, by integrity, the fill could not get for a reason asking again would not change:
   * a tree short of only these is recorded complete, so the next install is a no-op again.
   */
  final?: ReadonlySet<string>;
  /**
   * `inputsHash` of this install, with what it will report, for the state file: the next
   * install with the same inputs then skips the graph.
   */
  inputs?: {
    hash: string;
    packages: number;
    otherPlatforms: number;
    warnings: string[];
    stamps?: InstallState["stamps"];
  };
  /** The local tarballs' stamps, for the state file: see `InstallState.tarballs`. */
  tarballs?: InstallState["tarballs"];
  /** The `link:` directories' package.json stamps, for the state file: see `InstallState.links`. */
  links?: InstallState["links"];
  /** Told as each entry is built or found in place. */
  onProgress?: (progress: Progress) => void;
  /** The proof of the workspace set, for the state file: see `InstallState.workspaces`. */
  workspaces?: InstallState["workspaces"];
  /**
   * Asked once the tree must change, before anything in it does: holds off any other install
   * of this tree. True when it had to wait for one.
   */
  hold?: () => Promise<boolean>;
}

/**
 * One self-contained piece of an entry's build, for a worker: the directories it needs,
 * parents first, then hardlinks, then symlinks. An entry with many files is split into
 * several by directory; each still lists every directory it writes into, so no shard waits
 * on another. Paths are absolute except `paths` (under `dir`) and `blobs` (under `blobDir`).
 *
 * A small entry travels as its `index` path instead of its files: the worker reads the index
 * and finds the directories under `dir` itself, so this thread reads and sends nothing per
 * file — 13,575 files, 559 indexes on `nuxt`, most of its time in the link.
 */
export interface Shard {
  dirs: string[];
  dir: string;
  paths: string[];
  blobDir: string;
  blobs: string[];
  /** `target, at` pairs, flat. */
  symlinks: string[];
  /** `at, text` pairs, flat: Windows bins are shims. */
  shims?: string[];
  /** A small entry's index, read by the worker, and what it must be the index of. */
  index?: string;
  integrity?: string;
  want?: Identity;
  /** Its own edges, each to the package it landed on: what its package.json must declare. */
  edges?: Record<string, string>;
}

export interface ShardResult {
  linked: number;
  copied: number;
}

export interface LinkPool {
  size: number;
  /** Undefined once the pool cannot take work, so the caller builds here instead. */
  run(shard: Shard): Promise<ShardResult> | undefined;
  close(): void;
}

/** A pool rejects with this when a worker died mid-shard: the entry is undone, not failed. */
const WORKER_DIED = "EWORKERDIED";

/** Past this many files an entry is split across workers, by directory. */
const SHARD_FILES = 256;

export interface LinkResult {
  entries: number;
  linked: number;
  copied: number;
  reused: number;
  /** Entries that existed but did not hold up, and were built again. */
  repaired: number;
  /** Entries built by the worker pool, when one was on. */
  pooled: number;
  bins: number;
  /** Stale symlinks dropped, plus abandoned temp entries swept. */
  removed: number;
  /** Optional packages the store did not hold, so the tree is short of them. */
  dropped: string[];
  /** The state file already described this install, so nothing on disk was touched. */
  upToDate: boolean;
}

interface Entry {
  pkg: ResolvedPackage;
  key: string;
  /** Bytes of the store index, about 160 a file after 130 of its own; set once the tarball is in. */
  bytes: number;
  /** The index, read on first use; an entry the pool builds from the index path never reads it here. */
  readonly index: PackageIndex;
  /** `<key>/node_modules/<name>`: where the package sits under `.upm`. */
  home: string;
}

/** The package a registry entry's tarball must be: an alias's own, else its name's. */
function identityOf(pkg: ResolvedPackage): Identity {
  return { name: pkg.fetchName ?? pkg.name, version: pkg.version };
}

/** A bin: its file in the final tree, and the package and path it is read from. */
interface Bin {
  to: string;
  pkg: ResolvedPackage;
  path: string;
}

/** Bin name -> Windows shims, suffix and text. */
type Shims = Map<string, [string, string][]>;

/** A small entry, by its index's size, goes to the pool by index path; a large one is split. */
const SMALL_INDEX = 130 + SHARD_FILES * 160;

/** The root, or a workspace: a `node_modules` of its own, holding only what it declared. */
interface Top {
  /** The workspace's path, or "" for the root. */
  path: string;
  nm: string;
  dependencies: Record<string, string>;
}

const WIN = globalThis.process?.platform === "win32";

/** link() failing this way is a property of the two directories, never of one file. */
const NO_LINKS = new Set(["EXDEV", "EPERM", "ENOSYS", "EOPNOTSUPP", "ENOTSUP", "EACCES"]);

/** How long an abandoned `.tmp-*` must sit untouched before we believe it is abandoned. */
const TMP_MAX_AGE = 60 * 60 * 1000;

/**
 * Two processes sharing this tree through a mount have their own pid namespaces, so a pid is
 * not unique here. `sweepTemp` still reads the pid out of the name; the token only makes the
 * whole name unique. See the same token in unpack.ts.
 */
let token = "";
let tmpSeq = 0;

/** Read on the first temp name, so a run that never builds an entry never loads crypto. */
function tempToken(): string {
  return (token ||= globalThis.crypto.randomUUID().slice(0, 8));
}

export async function linkTree(resolution: Resolution, options: LinkOptions): Promise<LinkResult> {
  const { store } = options;
  // Read once per install: `place` runs per file, 13,575 times for `nuxt`.
  const { dirname, join, normalize, relative, sep } = builtin.path;
  const normalized = new Map<string, string>();
  const heads = new Map<string, Promise<string | undefined>>();
  const { lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat, utimes } = builtin.fsp;
  const { copyFileSync, linkSync, unlinkSync } = builtin.fs;
  const up = `..${sep}`;
  const limit = createLimiter(options.concurrency ?? 16);
  const storeDir = join(options.dir, "node_modules", ".upm");
  const production = options.production === true;
  const hoist = options.hoist !== false;
  const hash =
    options.hash ?? (await stateHash(resolution, { production, store: store.dir, hoist }));
  const result: LinkResult = {
    entries: 0,
    linked: 0,
    copied: 0,
    reused: 0,
    repaired: 0,
    pooled: 0,
    bins: 0,
    removed: 0,
    dropped: [],
    upToDate: false,
  };
  // The hash already says the tree we would link is the tree we last linked, so the only open
  // question is whether it is still there. That costs a few directory reads and one readlink
  // per direct dependency, never anything per package in the graph. IDEA.md 4.
  const tops = topsOf(options.dir, resolution);
  const state = await readState(options.dir);
  trace("link:state");
  // Each top's links and bins as they are made, for the state file's own up-to-date check.
  const made: Linked = Object.create(null); // a workspace may sit at `__proto__`
  const { inputs } = options;
  const stateOf = (
    entries: string[],
    complete: boolean,
    { "": root, ...rest }: Linked,
    missing?: string[],
  ) =>
    ({
      version: 1,
      hash,
      entries,
      complete,
      ...(missing?.length && { missing }),
      store: builtin.path.resolve(store.dir),
      ...(production && { production: true as const }),
      ...(options.tarballs && { tarballs: options.tarballs }),
      ...(options.links && { links: options.links }),
      ...(inputs && {
        inputs: inputs.hash,
        summary: {
          packages: inputs.packages,
          otherPlatforms: inputs.otherPlatforms,
          warnings: inputs.warnings,
        },
        root,
        ...(tops.length > 1 && { tops: rest }),
        ...(inputs.stamps && { stamps: inputs.stamps }),
      }),
      workspaces: options.workspaces,
    }) satisfies InstallState;
  const stood = async (state: InstallState | undefined) => {
    if (options.verify || state?.hash !== hash || !state.complete) return undefined;
    const read = await standing(options.dir, storeDir, tops, resolution, state, production, hoist);
    if (!read) return undefined;
    // The same tree from other inputs — a lockfile rewritten in the same words — or with a
    // local tarball touched but holding the same bytes, or the workspace set proven anew:
    // the state learns them, so the next install gets the short check, and hashes no
    // tarball and globs no workspace again.
    const learned = inputs && state.inputs !== inputs.hash;
    const touched =
      JSON.stringify(state.tarballs) !== JSON.stringify(options.tarballs) ||
      JSON.stringify(state.links) !== JSON.stringify(options.links);
    const proven = JSON.stringify(state.workspaces) !== JSON.stringify(options.workspaces);
    if (learned || touched || proven) {
      await writeState(options.dir, stateOf(state.entries, true, read, state.missing));
    }
    const dropped = state.missing ?? [];
    return { ...result, reused: state.entries.length, upToDate: true, dropped };
  };
  const stands = await stood(state);
  trace("link:standing");
  if (stands) return stands;
  // After a wait, the install we waited for may have linked just this tree.
  if (await options.hold?.()) {
    const now = await stood(await readState(options.dir));
    if (now) return now;
  }
  // From here the tree is being rewritten, so it describes nothing until we say so again.
  await clearState(options.dir);

  const keys = await storeKeys(resolution.packages);
  trace("link:keys");
  const wanted = new Map<string, Entry>();
  // Indexes from before they kept a package's aliases, which a link read off its package.json.
  const aged: PackageIndex[] = [];
  // Decided once, on the first link() that proves the store and the project cannot share
  // inodes. Probing per file would cost more than the fallback it guards.
  let copyOnly = false;

  // What the tops' own edges reach, each held to its package.json by `sameTree`.
  const reached = new Set(
    Object.entries(resolution.root.dependencies).map(([n, v]) => `${n}@${v}`),
  );
  for (const pkg of Object.values(resolution.packages)) {
    if (pkg.local === undefined) continue;
    // A peer it also has as a devDependency is that edge, which `sameTree` holds too.
    const dev = pkg.specs?.devDependencies ?? {};
    for (const [n, v] of Object.entries(allDeps(pkg))) {
      if (!Object.hasOwn(pkg.peers ?? {}, n) || Object.hasOwn(dev, n)) reached.add(`${n}@${v}`);
    }
  }

  /** What an edge landed on: the package, or a tarball's source. */
  function realOf(id: string): string {
    const dep = resolution.packages[id]!;
    return dep.source ?? dep.fetchName ?? dep.name;
  }

  /**
   * The edges a package.json must declare, each to what it landed on. A top's own are
   * `sameTree`'s. A peer settles on whatever the tree holds under its name: one on an alias or
   * a tarball is `doubted`.
   */
  function edgesOf(pkg: ResolvedPackage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, version] of Object.entries(allDeps(pkg))) {
      const id = `${name}@${version}`;
      const dep = resolution.packages[id];
      if (!dep || dep.local !== undefined) continue;
      const real = realOf(id);
      if (Object.hasOwn(pkg.peers ?? {}, name) ? real === name : pkg.local === undefined) {
        out[name] = real;
      }
    }
    return out;
  }

  // Peers on an alias or a tarball, by package: the lock may call any edge one (`vouch`).
  const doubted = new Map<string, Record<string, string>>();
  let vouching: Promise<ReturnType<typeof import("./vouch.ts").vouched>> | undefined;
  for (const [id, pkg] of Object.entries(resolution.packages)) {
    if (!pkg.peers) continue;
    const deps = allDeps(pkg);
    for (const name of Object.keys(pkg.peers)) {
      const to = `${name}@${deps[name]}`;
      const dep = resolution.packages[to];
      if (!dep || dep.local !== undefined || realOf(to) === name) continue;
      let edges = doubted.get(id);
      if (!edges) doubted.set(id, (edges = {}));
      edges[name] = to;
    }
  }

  // A workspace has no index to read, and no package.json that could make a peer anything else.
  for (const [id, pkg] of Object.entries(resolution.packages)) {
    const wrong = pkg.local !== undefined && misdeclared({}, edgesOf(pkg));
    if (wrong) throw fail(`${id} cannot be installed: ${wrong}`, "EMISMATCH");
  }

  // Every entry the tree may have, before any index is read: an entry links its dependencies
  // by their homes, which the keys give, so a build waits only for the tarballs it needs.
  for (const [id, pkg] of Object.entries(resolution.packages)) {
    if (pkg.local !== undefined) continue; // a workspace: no tarball, linked in place
    if (production && pkg.dev) continue;
    const key = keys[id];
    if (!key) continue;
    let held: PackageIndex | undefined;
    wanted.set(id, {
      pkg,
      key,
      bytes: 0,
      home: join(key, "node_modules", pkg.name),
      get index(): PackageIndex {
        // A torn index reads as absent: the store lost it, and the caller fills again.
        const found = store.index(pkg.integrity);
        if (!found) throw fail(`${id} is not in the store at ${store.dir}`, "ELINK");
        // Once per entry, not per index: two entries given one tarball are each held to it.
        if (held === found) return found;
        // A tarball dependency's package.json says what it is; nothing else could.
        const wrong =
          (pkg.source === undefined ? mismatch(found, identityOf(pkg)) : undefined) ??
          misdeclaredIn(found, store.blobPath, edgesOf(pkg), aged);
        if (wrong) throw fail(`${id} cannot be installed: ${wrong}`, "EMISMATCH");
        held = found;
        return found;
      },
    });
  }
  trace("link:entries");
  const blobDir = join(store.dir, "files");

  // Made here when there was none, the root's `node_modules` is new: see `linkTop`.
  const rootNew = (await mkdir(tops[0]!.nm, { recursive: true })) !== undefined;
  await mkdir(storeDir, { recursive: true });
  // One listing in place of a stat per entry. A warm install has just made `.upm`, and each
  // of nuxt's 561 probes for a name that was not there cost a rejection and a wait on the
  // directory lock the pool's renames hold. A key that appears later is caught by the rename.
  const present = new Set(await readdir(storeDir));
  // The files the pool would link: those of the entries not in `.upm` yet. An entry that is
  // there but damaged is rebuilt too, but only its stats can tell, and they cost more than the
  // pool would save on a repair. A stale state file over an intact store — the install after
  // `add` — has a few new entries, not the tree's 13,575 files.
  // Each entry's fate: its index in the store, or the entry dropped. Decided as the tarballs
  // land under a filling store, at once otherwise. An optional's index is read here, so a torn
  // one drops it the way a missing one does; a required one is read where it is linked, and
  // torn there fails the link, which the install answers by filling the store again.
  const fates = new Map<string, Promise<void>>();
  // What was dropped, by integrity: asked of `final` only at the end, once the fill that
  // failed each one has had its say.
  const lacking: string[] = [];
  // Files landed so far that `.upm` lacks, under a filling store: their indexes were just
  // written, so reading one is a memo lookup. On a full store the count is taken only when the
  // pool asks for it, since it reads every index and a pool started off the lockfile never asks.
  let landed = 0;
  for (const [id, entry] of wanted) {
    fates.set(
      id,
      (async () => {
        await options.awaiting?.(entry.pkg.integrity)?.catch(() => {});
        const { pkg } = entry;
        // A url's bytes are another tarball's until the store has them from that url.
        const bytes =
          fromUrl(pkg) && !store.vouches(pkg.resolved, pkg.integrity)
            ? 0
            : store.indexSize(pkg.integrity);
        // An optional the fetch step was allowed to drop is not linked. The tree is then short of
        // something the graph named, recorded complete only when asking again would not help.
        if (bytes === 0 || (pkg.optional && !store.index(pkg.integrity))) {
          if (!pkg.optional) throw fail(`${id} is not in the store at ${store.dir}`, "ELINK");
          lacking.push(pkg.integrity);
          result.dropped.push(id);
          wanted.delete(id);
          return;
        }
        entry.bytes = bytes;
        if (options.awaiting && !present.has(entry.key)) landed += entry.index.files.length;
      })(),
    );
  }
  // A fate rejected is heard by the build that waits for it; nothing else may hear it first.
  for (const fate of fates.values()) fate.catch(() => {});
  // With every index in hand the count is final before the first build, as it was. Under a
  // still-filling store each build asks with the count so far, so the pool starts once the
  // files known reach its threshold; an entry built before that is built here.
  if (!options.awaiting) await Promise.all(fates.values());
  trace("link:indexes");
  let asked = -1;
  const files = (): number => {
    if (options.awaiting) return (asked = landed);
    let count = 0;
    for (const entry of wanted.values()) {
      if (!present.has(entry.key)) count += entry.index.files.length;
    }
    return count;
  };
  let pool: LinkPool | undefined;
  let asking: Promise<LinkPool | undefined> | undefined;
  // The first failure is thrown only once every build has settled: one still writing under
  // its temp name would outlive the throw and race the caller's retry. None starts after it.
  const failures: unknown[] = [];
  let built = 0;
  let total = wanted.size;
  await Promise.all(
    [...wanted].map(([id, entry]) =>
      limit(async () => {
        await fates.get(id);
        // Dropped after the count was taken: out of the total, so the last entry reads as done.
        if (!wanted.has(id)) {
          options.onProgress?.({ phase: "link", done: built, total: --total });
          return;
        }
        // Its dependencies too: a dropped optional must not be linked, so it has to be known.
        for (const [name, version] of Object.entries(allDeps(entry.pkg))) {
          if (name !== entry.pkg.name) await fates.get(`${name}@${version}`);
        }
        if (doubted.has(id)) await vouch(id, entry);
        if (!pool) {
          if (!asking || (options.awaiting && landed !== asked)) {
            asking = options.pool?.(files) ?? Promise.resolve(undefined);
          }
          pool = await asking;
        }
        if (failures.length > 0) return;
        await materialize(entry);
        options.onProgress?.({ phase: "link", done: ++built, total });
      }).catch((error: unknown) => void failures.push(error)),
    ),
  );
  if (failures.length > 0) throw failures[0];
  trace("link:materialized");
  // Done with the threads: let them go now, so their teardown overlaps the tops, the sweep
  // and the state write rather than following the exit event — 3 ms on `next`.
  pool?.close();
  for (const id of doubted.keys()) {
    if (resolution.packages[id]!.local !== undefined) await vouch(id);
  }
  // Only here, after the fast path: a no-op install never pays a realpath per top.
  const realRoot = await realpath(options.dir);
  // Each top is its own `node_modules`, so they are linked side by side.
  await settle([
    ...tops.map(async (top, i) => {
      await inside(dirname(top.nm));
      await inside(top.nm);
      await linkTop(top, i === 0 && rootNew);
    }),
    linkHoisted(),
  ]);
  trace("link:tops");
  await sweepTemp();
  trace("link:swept");
  result.dropped.sort(); // in landing order until here
  await writeState(
    options.dir,
    stateOf(
      [...new Set([...wanted.values()].map((entry) => entry.key))].sort(),
      lacking.every((integrity) => options.final?.has(integrity)),
      made,
      result.dropped,
    ),
  );
  trace("link:statewritten");
  // Written back once, so the next link reads none of them. A link thread writes its own.
  if (aged.length > 0) {
    const { keepAliases } = await import("./index-upgrade.ts");
    for (const index of aged) keepAliases(store.indexPath(index.integrity), index);
  }
  return result;

  function realDir(entry: Entry): string {
    return join(storeDir, entry.home);
  }

  /**
   * A dep link's target. Every entry sits at the same depth under `.upm`, so from
   * `<entry>/node_modules` it is always `../../<home>`, one `..` more from under a scope dir.
   * Spelled rather than `relative(dirname(at), realDir(dep))`, which resolved both sides
   * against the cwd once per edge: 1,359 times on nuxt, 15 ms of `node:path` in `build`.
   */
  function depTarget(name: string, dep: Entry): string {
    return `${up}${up}${name.includes("/") ? up : ""}${dep.home}`;
  }

  /** An entry's deps that were actually linked. A self-dep would collide with its own dir. */
  function depsOf(pkg: ResolvedPackage): [string, Entry][] {
    const out: [string, Entry][] = [];
    for (const [name, version] of Object.entries(allDeps(pkg))) {
      const id = `${name}@${version}`;
      // Only the root and workspaces reach a workspace, so no entry links out of `.upm`.
      if (resolution.packages[id]?.local !== undefined) {
        throw fail(`${pkg.name}@${pkg.version} depends on the workspace ${name}`, "ELINK");
      }
      const dep = wanted.get(id);
      if (dep && name !== pkg.name) out.push([name, dep]);
    }
    return out;
  }

  /** Holds `id`'s doubted peers to `vouched`. */
  async function vouch(id: string, entry?: Entry): Promise<void> {
    vouching ??= import("./vouch.ts").then((m) =>
      // An entry the store lacks fails there as at home, so the install fills the store again.
      m.vouched(
        reached,
        resolution.packages,
        (at) => wanted.has(at),
        store,
        () => Promise.all(fates.values()),
      ),
    );
    const wrong = await (await vouching)(doubted.get(id)!, entry?.index);
    if (wrong) throw fail(`${id} cannot be installed: ${wrong}`, "EMISMATCH");
  }

  /** Built under a temp name and renamed in, so a half-written entry is never mistaken for one. */
  async function materialize(entry: Entry): Promise<void> {
    const final = join(storeDir, entry.key);
    if (present.has(entry.key)) {
      const deps = depsOf(entry.pkg);
      const home = realDir(entry);
      const files =
        (await sized(entry, (file) => join(home, file.path))) ||
        // A case-insensitive disk keeps one file for `A.js` and `a.js`.
        (await import("./verify.ts")).sized(entry.index.files, home);
      // Short here and hardlinked, it is short in the store too: power lost before the disk had
      // the bytes. ELINK has the install refill the store with sizes checked, then link again.
      if (!files && !(await sized(entry, store.blobPath))) {
        throw fail(`${entry.pkg.name}@${entry.pkg.version} is damaged in ${store.dir}`, "ELINK");
      }
      if (files && (await intact(entry, deps))) {
        result.reused++;
        // Touch it, exactly as the store touches a blob it adopts: a prune whose `keep` came
        // from the state file we just cleared must read "someone still wants this" off the
        // mtime. Only a fresh entry is young enough to be spared without it.
        const now = new Date();
        await utimes(final, now, now).catch(() => {});
        // The key covers the subgraph, so a matching entry should already be right — but one
        // written by an older upm may name deps we no longer resolve.
        const nmDir = join(final, "node_modules");
        await sweep(nmDir, new Set(deps.map(([name]) => name)));
        await sweep(join(nmDir, ".bin"), new Set(binsOf(deps, nmDir).keys()));
        return;
      }
      if (await swapIn(entry, final)) result.repaired++;
      else result.reused++;
      return;
    }
    const temp = tempName();
    try {
      const pooled = await build(entry, temp, final);
      await rename(temp, final);
      result.entries++;
      if (pooled) result.pooled++;
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      // Another install may have won the race; its entry is as good as ours.
      if (!(await exists(final))) throw error;
      result.reused++;
    }
  }

  /**
   * npm's `getAction` for our layout: the directory name proves what an entry *should* hold, not
   * what it does. Every file at the size the index recorded (asked first), every dep symlink and
   * every bin pointing where we would point it — anything else and the entry is rebuilt. Sizes
   * come from the index, so nothing is read or rehashed but under `--verify`. IDEA.md 4, tier 2.
   */
  async function intact(entry: Entry, deps: [string, Entry][]): Promise<boolean> {
    const nmDir = join(storeDir, entry.key, "node_modules");
    // A file under the package dir proves it; with none, only a stat does, or a top link dangles.
    if (entry.index.files.length === 0 && !landsOnDir(join(nmDir, entry.pkg.name))) return false;
    // `--verify` reads content too: a file edited or renamed in place keeps its size.
    if (options.verify) {
      const { placed } = await import("./verify.ts");
      if (!placed(store, entry.index.files, join(storeDir, entry.home))) return false;
    }

    const links = deps.map(async ([name, dep]) => {
      return (await readLink(join(nmDir, name))) === depTarget(name, dep);
    });
    if (!(await every(links))) return false;

    const binDir = join(nmDir, ".bin");
    const bins = binsOf(deps, nmDir);
    const shim = WIN && (await import("./shim.ts"));
    if (shim) return await shim.shimsStand(binDir, await shimsOf(bins, binDir));
    const placed = [...bins].map(
      async ([name, bin]) => (await readLink(join(binDir, name))) === relative(binDir, bin.to),
    );
    return await every(placed);
  }

  async function sized(entry: Entry, at: Store["blobPath"]): Promise<boolean> {
    return await every(entry.index.files.map(async (f) => (await sizeOf(at(f))) === f.size));
  }

  /**
   * Rebuild in full, then take the name in one rename: readers never see a partial entry.
   * False when someone else took the name first, which makes their entry the one we reused.
   */
  async function swapIn(entry: Entry, final: string): Promise<boolean> {
    const temp = tempName();
    const retired = tempName();
    let pooled = false;
    try {
      pooled = await build(entry, temp, final);
    } catch (error) {
      // Before the swap, so the damaged entry is still in place — and must stay a failure.
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
    // A concurrent install may have repaired it first and be mid-swap; either way our copy
    // is as good, so a missing `final` is not a failure.
    const moved = await rename(final, retired).then(
      () => true,
      () => false,
    );
    try {
      await rename(temp, final);
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      // The name is taken again. Only a build of this same key could have taken it, and a
      // built entry is renamed in whole, so it is as good as the one we just dropped.
      if (await exists(final)) {
        await rm(retired, { recursive: true, force: true });
        return false;
      }
      if (moved) await rename(retired, final).catch(() => {});
      throw error;
    }
    await rm(retired, { recursive: true, force: true });
    if (pooled) result.pooled++;
    return true;
  }

  function tempName(): string {
    return `${storeDir}${sep}.tmp-${pid}-${tempToken()}-${tmpSeq++}`;
  }

  /**
   * An install killed mid-entry leaves its `.tmp-*` behind and nothing else ever removes it.
   * Taking one an install is still filling would break that install, so a dir goes only when
   * its pid is gone *and* nothing has touched it for an hour. A running install always has a
   * live pid, so the pid check alone is already conservative in the safe direction — a recycled
   * pid only ever makes us leave garbage. The hour covers the one case a pid cannot answer: a
   * writer in another PID namespace, sharing the tree through a mount.
   */
  async function sweepTemp(): Promise<void> {
    const cutoff = Date.now() - TMP_MAX_AGE;
    for (const found of await list(storeDir)) {
      if (!found.isDirectory() || !found.name.startsWith(".tmp-")) continue;
      const pid = Number(found.name.split("-")[1]);
      if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
      const at = join(storeDir, found.name);
      const info = await stat(at).catch(() => undefined);
      if (!info || info.mtimeMs > cutoff) continue;
      await rm(at, { recursive: true, force: true });
      result.removed++;
    }
  }

  /** True when the pool built it: counted once the entry lands, not when a race loses it. */
  async function build(entry: Entry, temp: string, final: string): Promise<boolean> {
    const on = pool;
    if (on) {
      const finalNm = join(final, "node_modules");
      const bins = WIN ? binsOf(depsOf(entry.pkg), finalNm) : undefined;
      const shims = bins && (await shimsOf(bins, join(finalNm, ".bin")));
      const [shards, count] = plan(entry, temp, on.size, shims);
      // `run` says no only once the pool is broken, and then to every shard alike.
      const runs = shards.map((shard) => on.run(shard));
      if (!runs.includes(undefined)) {
        // Every shard, however the first one ended: a sibling still writing under `temp`
        // would race the rm below, or land in a temp dir already renamed into place.
        const settled = await Promise.allSettled(runs as Promise<ShardResult>[]);
        let died = false;
        for (const outcome of settled) {
          if (outcome.status === "fulfilled") continue;
          if ((outcome.reason as { code?: string }).code !== WORKER_DIED) throw outcome.reason;
          died = true;
        }
        if (!died) {
          for (const outcome of settled as PromiseFulfilledResult<ShardResult>[]) {
            result.linked += outcome.value.linked;
            result.copied += outcome.value.copied;
          }
          result.bins += count;
          return true;
        }
        // The pool let go of this entry part-built; start it over here.
        await rm(temp, { recursive: true, force: true });
      }
    }
    await buildHere(entry, temp, final);
    return false;
  }

  /**
   * The same work `buildHere` does, as shards for the pool: one for a small entry; several,
   * split by directory, for one with many files, so one large package (84% of `next`'s files
   * are in one) is spread over every worker. The first shard carries the links and bins.
   */
  function plan(entry: Entry, temp: string, workers: number, shims?: Shims): [Shard[], number] {
    const { pkg } = entry;
    // Spelled, not `join`ed: every piece is one clean segment, and `join` normalizes each
    // call — five of them per entry were 15 ms of `nuxt`'s link on this thread.
    const tempNm = `${temp}${sep}node_modules`;
    const pkgDir = `${tempNm}${sep}${pkg.name}`;
    const top = [temp, tempNm];
    const own = pkg.name.indexOf("/");
    const ownScope = own === -1 ? "" : pkg.name.slice(0, own);
    if (ownScope) top.push(`${tempNm}${sep}${ownScope}`);
    top.push(pkgDir);

    const deps = depsOf(pkg);
    const extra: string[] = [];
    const symlinks: string[] = [];
    for (const [name] of deps) {
      const slash = name.indexOf("/");
      if (slash !== -1 && name.slice(0, slash) !== ownScope) {
        const scope = `${tempNm}${sep}${name.slice(0, slash)}`;
        if (!extra.includes(scope)) extra.push(scope);
      }
    }
    for (const [name, dep] of deps) symlinks.push(depTarget(name, dep), `${tempNm}${sep}${name}`);
    const bins = binLinks(deps);
    const binDir = `${tempNm}${sep}.bin`;
    for (const [bin, target] of bins) symlinks.push(target, `${binDir}${sep}${bin}`);
    const texts: string[] = [];
    for (const [bin, files] of shims ?? []) {
      for (const [suffix, text] of files) texts.push(`${binDir}${sep}${bin}${suffix}`, text);
    }
    const binCount = bins.size + (shims?.size ?? 0);
    if (binCount > 0) extra.push(binDir);

    if (entry.bytes <= SMALL_INDEX) {
      const whole: Shard = {
        dirs: [...top, ...extra],
        dir: pkgDir,
        paths: [],
        blobDir,
        blobs: [],
        symlinks,
        shims: texts,
        index: store.indexPath(pkg.integrity),
        integrity: pkg.integrity,
        ...(pkg.source === undefined && { want: identityOf(pkg) }),
        edges: edgesOf(pkg),
      };
      return [[whole], binCount];
    }
    const { index } = entry;
    const shard = (files: PackageIndex["files"], first: boolean): Shard => ({
      dirs: [...top, ...(first ? extra : []), ...prefixes(files).map((p) => `${pkgDir}${sep}${p}`)],
      dir: pkgDir,
      paths: files.map((file) => file.path),
      blobDir,
      blobs: files.map((file) => file.blob),
      symlinks: first ? symlinks : [],
      shims: first ? texts : [],
    });
    const count = Math.min(workers, Math.ceil(index.files.length / SHARD_FILES));
    if (count <= 1) return [[shard(index.files, true)], binCount];

    // Whole directories to one worker each — links into one directory serialize on its lock
    // anyway — largest first onto the emptiest part, so the parts come out about even.
    const byDir = new Map<string, PackageIndex["files"]>();
    for (const file of index.files) {
      const dir = file.path.slice(0, file.path.lastIndexOf("/") + 1);
      const group = byDir.get(dir);
      if (group) group.push(file);
      else byDir.set(dir, [file]);
    }
    const parts: PackageIndex["files"][] = Array.from({ length: count }, () => []);
    for (const group of [...byDir.values()].sort((a, b) => b.length - a.length)) {
      let least = parts[0]!;
      for (const part of parts) if (part.length < least.length) least = part;
      least.push(...group);
    }
    return [
      parts.filter((files) => files.length > 0).map((files, i) => shard(files, i === 0)),
      binCount,
    ];
  }

  /** Every directory under `pkgDir` the files need, shallowest first, spelled from `pkgDir`. */
  function prefixes(files: PackageIndex["files"]): string[] {
    const levels: Set<string>[] = [];
    for (const { path } of files) {
      let depth = 0;
      for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
        (levels[depth++] ??= new Set()).add(path.slice(0, i));
      }
    }
    return levels.flatMap((level) => [...level]);
  }

  async function buildHere(entry: Entry, temp: string, final: string): Promise<void> {
    const { pkg, index } = entry;
    const tempNm = join(temp, "node_modules");
    await placeFiles(index, join(tempNm, pkg.name));

    const deps = depsOf(pkg);
    // Scope dirs once each, before the links; the package's own scope is there from placeFiles.
    const scopes = new Set<string>();
    for (const [name] of deps) {
      const slash = name.indexOf("/");
      if (slash !== -1) scopes.add(name.slice(0, slash));
    }
    const own = pkg.name.indexOf("/");
    if (own !== -1) scopes.delete(pkg.name.slice(0, own));
    await Promise.all([...scopes].map((scope) => mkdir(`${tempNm}${sep}${scope}`).catch(existing)));
    for (const [name, dep] of deps) {
      await symlinkAt(depTarget(name, dep), `${tempNm}${sep}${name}`);
    }
    const finalNm = join(final, "node_modules");
    await placeBins(join(tempNm, ".bin"), join(finalNm, ".bin"), binsOf(deps, finalNm), true);
  }

  /**
   * Directories first: it is the cost once files are links. Planned before any is made, one
   * level of depth at a time, so every file directory is one plain mkdir whose parent already
   * exists; recursive mkdirs all at once raced parents against children. Still async: the hops
   * overlap the sync link loop of other entries, and a sync loop measured slower.
   */
  async function placeFiles(index: PackageIndex, pkgDir: string): Promise<void> {
    const levels: Set<string>[] = [];
    for (const { path } of index.files) {
      let depth = 0;
      for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
        (levels[depth++] ??= new Set()).add(path.slice(0, i));
      }
    }
    // Recursive for the one path that is new from the temp dir down: its ENOENT probes on the
    // way up happen on the threadpool thread, and one hop measured better than four.
    await mkdir(pkgDir, { recursive: true });
    for (const level of levels) {
      await Promise.all([...level].map((dir) => mkdir(`${pkgDir}${sep}${dir}`).catch(existing)));
    }
    for (const file of index.files) {
      place(store.blobPath(file), `${pkgDir}${sep}${file.path}`);
    }
  }

  /**
   * Synchronous, and a plain loop rather than Promise.all. A hardlink is a metadata write the
   * kernel serializes anyway, so the threadpool hop buys no overlap and costs a futex round
   * trip per file: measured at 124ms against 95ms for the same 13,575 links.
   */
  function place(from: string, to: string, again = false): void {
    if (!copyOnly) {
      try {
        linkSync(from, to);
        result.linked++;
        return;
      } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (NO_LINKS.has(code)) copyOnly = true;
        else if (code === "EEXIST" && !again && unlinked(to)) return place(from, to, true);
        // EMLINK is this one file exhausting the inode's link count; the rest still link.
        else if (code !== "EMLINK") throw fail(`cannot link ${to}: ${reason(error)}`, "ELINK");
      }
    }
    try {
      // copyFileSync carries the source mode over, so a link is never chmodded and the
      // store file every other project shares stays exactly as it was written.
      copyFileSync(from, to);
      result.copied++;
    } catch (error) {
      throw fail(`cannot copy ${to}: ${reason(error)}`, "ELINK");
    }
  }

  /**
   * Nothing is under a fresh temp dir but a name a case-insensitive disk folds onto one placed
   * already, `A.js` after `a.js`: the later wins, as a copy's overwrite and npm's tar do.
   */
  function unlinked(path: string): boolean {
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Bin name -> its file under `finalNm`. Name collisions are last-wins, as npm's are. */
  function binsOf(deps: [string, { pkg: ResolvedPackage }][], finalNm: string): Map<string, Bin> {
    const bins = new Map<string, Bin>();
    for (const [name, { pkg }] of deps) {
      for (const [bin, path] of Object.entries(pkg.bin)) {
        bins.set(bin, { to: join(finalNm, name, path), pkg, path });
      }
    }
    return bins;
  }

  /**
   * Bin name -> the link text from an entry's `.bin`, `../<name>/<target>`: what `binsOf` and
   * `relative` come to, spelled, with each declared target normalized once for the install.
   * None on Windows, where bins are shims: see `shimsOf`.
   */
  function binLinks(deps: [string, Entry][]): Map<string, string> {
    const links = new Map<string, string>();
    if (WIN) return links;
    for (const [name, dep] of deps) {
      for (const [bin, target] of Object.entries(dep.pkg.bin)) {
        let clean = normalized.get(target);
        if (clean === undefined) normalized.set(target, (clean = normalize(target)));
        links.set(bin, `..${sep}${name}${sep}${clean}`);
      }
    }
    return links;
  }

  /** Windows bins' shims for a `.bin` at `binDir`, targets read from the store. */
  async function shimsOf(bins: Map<string, Bin>, binDir: string): Promise<Shims> {
    const shim = await import("./shim.ts");
    const shims: Shims = new Map();
    for (const [name, { to, pkg, path }] of bins) {
      const index = pkg.local === undefined ? store.index(pkg.integrity) : undefined;
      const found = index?.files.find((file) => file.path === path);
      const file =
        pkg.local === undefined
          ? found && store.blobPath(found)
          : join(options.dir, pkg.local, path);
      let head = file && heads.get(file);
      if (file && !head) heads.set(file, (head = shim.readHead(file)));
      shims.set(name, shim.shimsOf(relative(binDir, to), await head));
    }
    return shims;
  }

  /**
   * `fresh`: `atDir` is under a temp dir or a `node_modules` made just now, so nothing is there to
   * read or replace — except on a case-insensitive disk, where two bins spelled `Foo` and `foo`
   * are one name, or a concurrent install's link; then replace.
   */
  async function placeBins(
    atDir: string,
    finalDir: string,
    bins: Map<string, Bin>,
    fresh = false,
  ): Promise<void> {
    if (bins.size === 0) return;
    await mkdir(atDir, { recursive: true });
    if (WIN) {
      await (await import("./shim.ts")).placeShims(atDir, await shimsOf(bins, finalDir), fresh);
      result.bins += bins.size;
      return;
    }
    for (const [name, bin] of bins) {
      await linkAt(relative(finalDir, bin.to), join(atDir, name), atDir, fresh);
      result.bins++;
    }
  }

  /**
   * `replaceLink` and `sweep` delete under a top's `node_modules`, so a top that really sits
   * elsewhere — its directory, its `node_modules` or a scope directory in it a symlink out
   * of the project, as a hostile checkout can arrange — would have them delete there. A link
   * that stays inside the project is fine. A dangling one is not: `mkdir` would follow it.
   */
  async function inside(path: string): Promise<void> {
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      const dangling = await lstat(path).then(
        (s) => s.isSymbolicLink(),
        () => false,
      );
      if (!dangling) return; // nothing there yet
      throw fail(`refusing to link through ${path}: a symlink that leads nowhere`, "ELINK");
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw fail(
        `refusing to link through ${path}: it leads outside the project, to ${real}`,
        "ELINK",
      );
    }
  }

  /**
   * Only direct deps get a top-level name: a package may import just what it declared. A
   * registry dep links into `.upm`; a workspace dep links to the workspace's own directory,
   * `packages/a/node_modules/b -> ../../b`. Its bins go through that link like any other's.
   */
  async function linkTop({ path, nm, dependencies }: Top, rootNew: boolean): Promise<void> {
    const direct: [string, { pkg: ResolvedPackage }][] = [];
    const links: [string, string][] = [];
    const targets: Record<string, string> = {}; // by name, for the state file
    const scopes = new Set<string>();
    // A `node_modules` made just now holds nothing to read, replace or sweep. Were a concurrent
    // install to link there too, a name it took first is replaced as usual.
    const fresh = rootNew || (await mkdir(nm, { recursive: true })) !== undefined;
    for (const [name, version] of Object.entries(dependencies)) {
      const id = `${name}@${version}`;
      const pkg = resolution.packages[id];
      if (!pkg) continue;
      const entry = wanted.get(id);
      const local = pkg.local !== undefined && !(production && pkg.dev);
      const real = local ? join(options.dir, pkg.local!) : entry && realDir(entry);
      if (!real) continue; // dropped, or dev under --production
      direct.push([name, { pkg }]);
      const at = join(nm, name);
      if (name.includes("/")) scopes.add(dirname(at));
      const target = relative(dirname(at), real);
      links.push([at, target]);
      targets[name] = target;
    }
    for (const scope of scopes) {
      await inside(scope);
      await mkdir(scope, { recursive: true });
    }
    await settle(links.map(([at, target]) => linkAt(target, at, nm, fresh)));
    const bins = binsOf(direct, nm);
    made[path] = { links: targets, bins: [...bins.keys()] };
    await placeBins(join(nm, ".bin"), join(nm, ".bin"), bins, fresh);
    if (fresh) return;
    await sweep(nm, new Set(direct.map(([name]) => name)));
    await sweep(join(nm, ".bin"), new Set(bins.keys()));
  }

  /**
   * `.upm/node_modules`: one link per name, for what a package imports without declaring it.
   * Node's lookup from an entry climbs into it after the entry's own `node_modules` and before
   * the root's, so it only answers a name the package did not declare. pnpm's rule, so a tree
   * that works there works here: the root's direct names stay out, since this folder would hide
   * the root's own version; each workspace's direct deps come first; then the rest by depth,
   * parents in id order, and the first to claim a name keeps it. A workspace is never hoisted:
   * no `.upm` entry reaches one.
   */
  async function linkHoisted(): Promise<void> {
    const nm = join(storeDir, "node_modules");
    await inside(nm);
    if (!hoist) return await rm(nm, { recursive: true, force: true });
    const fresh = (await mkdir(nm, { recursive: true })) !== undefined;
    const taken = new Set<string>();
    const hoisted: [string, Entry][] = [];
    const claim = (name: string, id: string) => {
      const entry = wanted.get(id);
      if (!entry || taken.has(name)) return;
      taken.add(name);
      hoisted.push([name, entry]);
    };
    const linked = (id: string) => wanted.has(id) || resolution.packages[id]?.local !== undefined;
    for (const [name, version] of Object.entries(tops[0]!.dependencies)) {
      if (linked(`${name}@${version}`)) taken.add(name);
    }
    const seen = new Set<string>();
    let level: string[] = [];
    for (const [i, { dependencies }] of tops.entries()) {
      for (const [name, version] of Object.entries(dependencies)) {
        const id = `${name}@${version}`;
        if (i > 0) claim(name, id);
        if (wanted.has(id) && !seen.has(id)) {
          seen.add(id);
          level.push(id);
        }
      }
    }
    while (level.length > 0) {
      const next: string[] = [];
      for (const id of level.sort()) {
        for (const [name, version] of Object.entries(allDeps(wanted.get(id)!.pkg))) {
          const child = `${name}@${version}`;
          claim(name, child);
          if (wanted.has(child) && !seen.has(child)) {
            seen.add(child);
            next.push(child);
          }
        }
      }
      level = next;
    }
    const scopes = new Set<string>();
    for (const [name] of hoisted) {
      if (name.includes("/")) scopes.add(join(nm, name.slice(0, name.indexOf("/"))));
    }
    for (const scope of scopes) {
      await inside(scope);
      await mkdir(scope, { recursive: true });
    }
    // From `.upm/node_modules` an entry is `../<home>`, one `..` more from under a scope dir.
    const target = (name: string, entry: Entry) =>
      `${up}${name.includes("/") ? up : ""}${entry.home}`;
    await settle(
      hoisted.map(([name, entry]) => linkAt(target(name, entry), join(nm, name), nm, fresh)),
    );
    if (!fresh) await sweep(nm, new Set(hoisted.map(([name]) => name)));
  }

  /**
   * Converge one `node_modules` (or `.bin`) to what we just linked: every symlink `keep` does
   * not name goes. Only symlinks — a real directory is someone else's, and `.upm`, `.tmp-*`
   * and any other dot name are not ours to judge. Runs after the links are in place, so a
   * concurrent install of the same resolution can only ever see names both of us want.
   * A Windows `.bin` holds shims, which are files: those not kept go too.
   */
  async function sweep(dir: string, keep: Set<string>, scope = ""): Promise<void> {
    const shims = WIN && builtin.path.basename(dir) === ".bin";
    for (const found of await list(dir)) {
      const { name } = found;
      const at = join(dir, name);
      if (scope === "" && name.startsWith(".")) continue;
      if (scope === "" && name.startsWith("@") && found.isDirectory()) {
        await sweep(at, keep, `${name}/`);
        await rmdir(at).catch(() => {}); // ENOTEMPTY while it still holds a package
        continue;
      }
      const bin = shims ? name.replace(/\.(?:cmd|ps1)$/i, "") : scope + name;
      if (shims ? found.isDirectory() : !found.isSymbolicLink()) continue;
      if (keep.has(bin) || keep.has(scope + name)) continue;
      // Not recursive: this unlinks the link itself, never what it points at.
      await rm(at, { force: true });
      if (bin === scope + name) result.removed++; // three shims, one bin
    }
  }
}

/** The root first, then every workspace, each with the edges its `node_modules` links. */
function topsOf(dir: string, resolution: Resolution): Top[] {
  const { join } = builtin.path;
  const tops: Top[] = [
    { path: "", nm: join(dir, "node_modules"), dependencies: resolution.root.dependencies },
  ];
  for (const pkg of Object.values(resolution.packages)) {
    if (pkg.local === undefined || pkg.link) continue; // a `link:` directory is not ours to fill
    const nm = join(dir, pkg.local, "node_modules");
    tops.push({ path: pkg.local, nm, dependencies: allDeps(pkg) });
  }
  return tops;
}

/**
 * Is the tree the state file describes still on disk? Its shape only: every top's direct
 * dependency linked into an entry of its own or to its workspace and landing on a directory,
 * every bin placed, every recorded entry a real directory, `.upm/node_modules` too when hoisting.
 * Other damage inside an entry, and content that changed without changing size, need `--verify`.
 */
async function standing(
  dir: string,
  storeDir: string,
  tops: Top[],
  resolution: Resolution,
  state: InstallState,
  production: boolean,
  hoist: boolean,
): Promise<Linked | undefined> {
  const read: Linked = Object.create(null);
  for (const top of tops) {
    const found = await standingTop(dir, top, resolution, production);
    if (!found) return undefined;
    read[top.path] = found;
  }
  // withFileTypes, so a plain file named like a key cannot stand in for the entry.
  const entries = new Set(
    (await builtin.fsp.readdir(storeDir, { withFileTypes: true }).catch(() => []))
      .filter((found) => found.isDirectory())
      .map((found) => found.name),
  );
  if (hoist && !entries.has("node_modules")) return undefined;
  return state.entries.every((key) => entries.has(key)) ? read : undefined;
}

/** Each top's direct links and bin names, by its path: "" for the root. */
type Linked = Record<string, TopLinks>;

/**
 * Is the tree a state file with `root` describes still on disk? The same shape `standing`
 * checks, read off the state alone: every recorded link of the root and of each workspace
 * pointing where it was made to and landing on a directory, every recorded bin placed, every
 * recorded entry a directory under `.upm`, and `.upm/node_modules` there unless `hoist` is off.
 * For the install whose inputs have not changed, which has no graph to check against.
 */
export function treeStanding(dir: string, state: InstallState, hoist = true): boolean {
  // Sync, like the other reads of the no-op path: a few directory reads, and no
  // `fs/promises` to load for them. See readState.
  const { join } = builtin.path;
  const { readdirSync } = builtin.fs;
  const { root } = state;
  if (!root || !state.complete) return false;
  for (const [path, { links, bins }] of Object.entries({ ...state.tops, "": root })) {
    const nm = join(dir, path, "node_modules");
    for (const [name, target] of Object.entries(links)) {
      const at = join(nm, name);
      if (readLinkSync(at) !== target || !landsOnDir(at)) return false;
    }
    if (bins.length === 0) continue;
    let placed: string[];
    try {
      placed = readdirSync(join(nm, ".bin"));
    } catch {
      return false;
    }
    const set = new Set(placed);
    if (!bins.every((bin) => set.has(WIN ? `${bin}.cmd` : bin))) return false;
  }
  let found: import("node:fs").Dirent[];
  try {
    found = readdirSync(join(dir, "node_modules", ".upm"), { withFileTypes: true });
  } catch {
    return false;
  }
  const entries = new Set(found.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  if (hoist && !entries.has("node_modules")) return false;
  return state.entries.every((key) => entries.has(key));
}

/** One readdir, one readlink per direct dependency, and one more readdir when bins are due. */
async function standingTop(
  dir: string,
  { nm, dependencies }: Top,
  resolution: Resolution,
  production: boolean,
): Promise<TopLinks | undefined> {
  const { join, relative, dirname, sep } = builtin.path;
  const found = await builtin.fsp.readdir(nm, { withFileTypes: true }).catch(() => undefined);
  if (!found) return undefined;
  const read: TopLinks = { links: {}, bins: [] };

  const links = new Set<string>();
  for (const item of found) {
    if (item.isSymbolicLink()) links.add(item.name);
  }
  // A scope directory holds the links, so read one level deeper for those.
  for (const item of found) {
    if (!item.name.startsWith("@") || item.isSymbolicLink()) continue;
    const scoped = await builtin.fsp
      .readdir(join(nm, item.name), { withFileTypes: true })
      .catch(() => []);
    for (const inner of scoped) {
      if (inner.isSymbolicLink()) links.add(`${item.name}/${inner.name}`);
    }
  }
  // The same filter linkTop applies, or a production tree can never look settled.
  const direct = Object.entries(dependencies).filter(
    ([name, version]) => !(production && resolution.packages[`${name}@${version}`]?.dev),
  );
  const bins = new Set<string>();
  for (const [name, version] of direct) {
    if (!links.has(name)) return undefined;
    const pkg = resolution.packages[`${name}@${version}`];
    // A link that still exists may point anywhere, so check it lands where we would point it:
    // an entry of its own, or the workspace's directory.
    const to = (await readLink(join(nm, name))) ?? "";
    if (pkg?.local !== undefined) {
      if (to !== relative(dirname(join(nm, name)), join(dir, pkg.local))) return undefined;
    } else {
      // Anchored to this project's own `.upm`: a junction is absolute, so a moved tree still
      // leads into the `.upm` it was installed from.
      const at = join(nm, name);
      const store = relative(dirname(at), join(dir, "node_modules", ".upm")) + sep;
      if (!to.startsWith(store) || !to.endsWith(join(sep, "node_modules", name))) return undefined;
    }
    if (!landsOnDir(join(nm, name))) return undefined;
    read.links[name] = to;
    for (const bin of Object.keys(pkg?.bin ?? {})) bins.add(bin);
  }
  if (bins.size > 0) {
    const placed = new Set(
      (await builtin.fsp.readdir(join(nm, ".bin")).catch(() => [])).map(String),
    );
    for (const bin of bins) {
      if (!placed.has(WIN ? `${bin}.cmd` : bin)) return undefined;
    }
  }
  read.bins = [...bins];
  return read;
}

/**
 * Does the link at `at` still lead to a package? A link reads the same after the entry's package
 * dir is deleted under it, so the up-to-date checks follow it: one stat per direct dependency,
 * never one per package in the graph. The dir, not its package.json, which a tarball may lack
 * and would then never look up to date. Sync, like the rest of the no-op path.
 */
function landsOnDir(at: string): boolean {
  try {
    return builtin.fs.statSync(at, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false; // a link loop, say: not a package either way
  }
}

/** Leaves a symlink that is already right alone; anything else there is replaced. */
async function replaceLink(at: string, target: string, within: string): Promise<void> {
  // `rm` here is recursive, so a name that climbs out of `within` would delete anything.
  if (builtin.path.relative(within, at).startsWith("..")) {
    throw Object.assign(new Error(`refusing to link outside ${within}: ${at}`), { code: "ELINK" });
  }
  for (let attempt = 0; ; attempt++) {
    if ((await readLink(at)) === target) return;
    await builtin.fsp.rm(at, { recursive: true, force: true });
    try {
      return await symlinkAt(target, at);
    } catch (error) {
      // Taken between the rm and the symlink: a concurrent install of this tree is linking the
      // same name, so read it again. A name that keeps pointing elsewhere is a real conflict.
      existing(error);
      if (attempt === 3) throw error;
    }
  }
}

/** `fresh`: nothing should be at `at` yet, so it is linked at once, and replaced only if it was. */
function linkAt(target: string, at: string, within: string, fresh: boolean): Promise<void> {
  return fresh
    ? symlinkAt(target, at).catch(() => replaceLink(at, target, within))
    : replaceLink(at, target, within);
}

async function symlinkAt(target: string, at: string): Promise<void> {
  try {
    const [to, type] = linkArgs(target, at);
    await builtin.fsp.symlink(to, at, type);
  } catch (error) {
    throw Object.assign(fail(`cannot symlink ${at} -> ${target}: ${reason(error)}`, "ELINK"), {
      cause: error,
    });
  }
}

/** Every one settled, then the first failure: nothing is still writing when the caller hears. */
async function settle(work: Promise<unknown>[]): Promise<void> {
  for (const outcome of await Promise.allSettled(work)) {
    if (outcome.status === "rejected") throw outcome.reason;
  }
}

async function every(checks: Promise<boolean>[]): Promise<boolean> {
  return (await Promise.all(checks)).every(Boolean);
}

/** A planned directory that is already there is fine; anything else is the caller's error. */
function existing(error: unknown): void {
  const { code, cause } = error as { code?: string; cause?: { code?: string } };
  if (code !== "EEXIST" && cause?.code !== "EEXIST") throw error; // `cause`: from symlinkAt
}

function reason(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

function fail(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A tarball dependency fetched from its url, not read off the disk. */
export function fromUrl(pkg: ResolvedPackage): boolean {
  return pkg.source !== undefined && !pkg.source.startsWith("file:");
}

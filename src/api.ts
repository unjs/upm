// The commands as functions: what `upm <command>` does, without argv and without printing.
// `cli.ts` checks the flags, calls one of these and formats what it returns. Node only; the
// portable pieces are `resolver.ts`.
import { builtin } from "./builtin.ts";
import { readConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { pruneStore, sweepEntries } from "./gc.ts";
import { shortHash } from "./keys.ts";
import { linkTree, treeStanding } from "./link.ts";
import type { LinkPool } from "./link.ts";
import {
  FOREIGN,
  formatLockfile,
  fromCheckedLockfile,
  fromLockfile,
  LOCKFILE,
  parseLockfile,
  readLockfile,
  sameTree,
  toLockfile,
  writeLockfile,
} from "./lock.ts";
import type { ForeignFile, Lockfile } from "./lock.ts";
import { addDeps, formatManifest, parseManifest, removeDeps, saveRange } from "./package-json.ts";
import type { Added, Group } from "./package-json.ts";
import { pickManifest } from "./pick.ts";
import { createRegistry, hosts } from "./registry.ts";
import type { BaseFor, Registry } from "./registry.ts";
import {
  currentPlatform,
  filterPlatform,
  GROUPS,
  integrityOf,
  keyOf,
  resolveTree,
  runsOn,
  unmetPeers,
} from "./resolve.ts";
import type { ResolveOptions, Resolution, RootManifest } from "./resolve.ts";
import {
  binDirs,
  quote,
  readScripts,
  runArgs,
  runScript,
  runShell,
  shellLine,
  withPath,
} from "./run.ts";
import { cpus, pid } from "./runtime.ts";
import { parse, satisfies } from "./semver.ts";
import { bareTarball, parseDep, parseSpec } from "./spec.ts";
import type { Spec } from "./spec.ts";
import {
  inputsHash,
  readState,
  readTreeLock,
  sameStamp,
  settingsOf,
  stampOf,
  stateHash,
  treeLockPath,
  writeState,
  writeTreeLock,
} from "./state.ts";
import type { InstallState, Inputs, Stamp } from "./state.ts";
import { createStore, storeDir } from "./store.ts";
import type { Store, Tarball } from "./store.ts";
import type { StoreBackend } from "./store-backend.ts";
import type { Manifest } from "./types.ts";
import { describe, replaceFile, take, trace, tracing } from "./util.ts";

/** Only a type: the module itself is loaded by the commands that read a project. */
type Workspace = import("./workspaces.ts").Workspace;
type Root = import("./workspaces.ts").Root;

export type { Added, Group };

/** `info` is progress, `warn` wants a person's attention, `debug` is for chasing a problem. */
export type LogLevel = "info" | "warn" | "debug";

/**
 * The `code` on an error a command rejects with, where a caller can act on it. A filesystem's
 * or a worker's own code can still come through; match on codes, never on messages.
 */
export type ErrorCode =
  /** An option or argument the command cannot take. */
  | "EOPTION"
  /** package.json cannot be read, parsed or written. */
  | "EMANIFEST"
  /** `.npmrc` holds something upm refuses, such as a credential with no registry url. */
  | "ECONFIG"
  /** The workspace option names nothing, or more than the command can act on. */
  | "EWORKSPACE"
  /** A spec that does not parse, or a name given twice. */
  | "EINVALIDSPEC"
  /** `remove` of a name that is not a dependency. */
  | "ENODEP"
  /**
   * The lockfile is missing, invalid, or stale under `frozen` — or it is another manager's
   * and the command would have to write one.
   */
  | "ELOCK"
  /** `exec` found no bin to run in the package, or several and none named after it. */
  | "ENOBIN"
  /** The registry has no such package. */
  | "E404"
  /** The package has no version the spec allows, or no versions at all. */
  | "ETARGET"
  | "ENOVERSIONS"
  /** A required package does not run on this platform. */
  | "EBADPLATFORM"
  /** A tarball does not match its integrity, or a manifest has none. */
  | "EINTEGRITY"
  /** The registry answered with an error, or could not be reached in time. */
  | "EREGISTRY"
  | "ENETWORK"
  | "ETIMEDOUT"
  /** Under `offline`, the registry was needed or a tarball is not in the store. */
  | "EOFFLINE";

export interface ProjectOptions {
  /**
   * The project root, taken as given. Default: npm's walk up from cwd — the nearest
   * package.json, or the workspace root that lists it. `run` and `listScripts` without
   * `workspaces` take cwd itself instead, as `upm run` does.
   */
  dir?: string;
  /** Progress and warnings, one line each. Default: dropped. */
  log?: (message: string, level: LogLevel) => void;
}

export interface RegistryAccess {
  /** Registry base url, over `.npmrc` and `npm_config_registry`. */
  registry?: string;
  /**
   * Pick only versions published at least this many days ago, over `.npmrc` and
   * `npm_config_min_release_age`; 0 turns it off. Default: npm's config, else 1 day.
   */
  minReleaseAge?: number;
  /** Pick only versions published before this date, over `minReleaseAge` and `.npmrc`. */
  before?: string;
  /** Names or globs the cutoff never applies to, in place of `.npmrc`'s list. */
  minReleaseAgeExclude?: string[];
  /**
   * Never ask the registry or download a tarball, over `.npmrc` and `npm_config_offline`: a pick
   * reads the documents kept from earlier runs, and what needs more fails with `EOFFLINE`. An
   * install from a current lockfile into a store that holds its packages needs neither.
   * Default: npm's config, else false.
   */
  offline?: boolean;
  /**
   * Pick from a kept document however old, over `.npmrc`'s `prefer-offline`: the registry is
   * asked for a name only when none is kept, or the kept one cannot satisfy the spec.
   */
  preferOffline?: boolean;
}

export interface StoreAccess {
  /** Content-addressed store directory. Default: `UPM_STORE`, then `~/.upm/store`. */
  store?: string;
  /** Shared storage behind the store. */
  storeBackend?: StoreBackend;
}

/** Tuning that may change or go away in any release. */
export interface Experimental {
  /** Threads that read the registry, 0 to 16; 0 reads it on this thread. Default: by cores. */
  resolvePool?: number;
  /** Worker threads that build `.upm` entries, and when they are worth starting. */
  linkPool?: Partial<LinkPoolConfig>;
}

export interface LinkPoolConfig {
  /**
   * Most workers, 0 to 64; 0 never starts them. A pool starts four, or one per 4,000 files when
   * it knows them, up to this. Default: up to 8, leaving the main thread a core.
   */
  size: number;
  /** Start them from this many packages in the lockfile. Default 200. */
  packages: number;
  /** Or from this many files to link. Default 6000. */
  files: number;
}

export interface DedupeOptions extends ProjectOptions, RegistryAccess, StoreAccess {
  /** Skip packages only devDependencies reach. */
  production?: boolean;
  /** Check the tree on disk instead of trusting its state (its shape, not its bytes). */
  verify?: boolean;
  experimental?: Experimental;
}

export interface InstallOptions extends DedupeOptions {
  /** Never resolve: a stale or missing lockfile is an error. */
  frozen?: boolean;
}

export interface WorkspaceOptions {
  /**
   * Act on workspaces instead of the root: `"all"`, or each a name, a path from the root or
   * from cwd, or a directory holding some. Every entry has to find one.
   */
  workspaces?: "all" | string[];
}

/** `add` and `remove` edit one package.json, so `workspaces` must pick exactly one. */
export interface AddOptions extends DedupeOptions, WorkspaceOptions {
  /** Default `dependencies`. */
  group?: Group;
  /** Save a tag as the version it resolved to, not a caret range. Default: `save-exact`. */
  exact?: boolean;
}

/** `add` and `remove` edit one package.json, so `workspaces` must pick exactly one. */
export interface RemoveOptions extends DedupeOptions, WorkspaceOptions {}

export interface LockOptions extends ProjectOptions, RegistryAccess, StoreAccess {
  /** Write the lockfile. Default true; false only returns it. */
  write?: boolean;
  experimental?: Pick<Experimental, "resolvePool">;
}

export interface SpecOptions extends ProjectOptions, RegistryAccess {}

export interface FetchPackagesOptions extends SpecOptions, StoreAccess {}

export interface FetchLockfileOptions extends ProjectOptions, RegistryAccess, StoreAccess {
  /** Skip packages only devDependencies reach. */
  production?: boolean;
}

export interface PruneOptions extends ProjectOptions, StoreAccess {}

export interface ListScriptsOptions extends ProjectOptions, WorkspaceOptions {
  /** With `workspaces`, the root first. */
  includeRoot?: boolean;
}

export interface RunOptions extends ListScriptsOptions, RegistryAccess, StoreAccess {
  /** Appended to the command, quoted for the shell. */
  args?: string[];
  /**
   * Install the tree first, when a script is found: the whole tree the package is in, kept
   * `production` and on the store it was linked from. A project with nothing to install and no
   * tree is left alone. Default false.
   */
  install?: boolean;
  /** A package without the script is passed over instead of failing. */
  ifPresent?: boolean;
  /** Told each script just before it starts. `workspace` is set under `workspaces`. */
  onScript?: (start: ScriptStart) => void;
}

export interface ExecOptions extends ProjectOptions, RegistryAccess, StoreAccess {
  /** Given to the command, each quoted for the shell. */
  args?: string[];
  /**
   * Registry packages to install first, their bins ahead of the rest of PATH; `command` is then
   * a command line word, not a spec. Default: the command is the spec, and its package's bin runs.
   */
  packages?: string[];
  /**
   * `command` is a shell line, run as written: `packages` installed first, when given, and every
   * `node_modules/.bin` above `dir` on PATH either way. Takes no `args`.
   */
  call?: boolean;
  experimental?: Experimental;
}

export interface ExecResult {
  /** The command's exit code. */
  code: number;
  /** The directory the packages were installed in; undefined when a local bin ran. */
  installed?: string;
}

export interface ScriptStart {
  /** The script's name. */
  script: string;
  /** What the shell is given: the command with `args` quoted onto it. */
  line: string;
  /** The package it runs in, under `workspaces`. */
  workspace?: string;
}

export interface InstallResult {
  /** Registry packages this install wants: this platform's, less dev ones under `production`. */
  packages: number;
  workspaces: number;
  /** Lockfile packages that are only for other platforms. */
  otherPlatforms: number;
  /** The install state already described this tree, so nothing on disk was touched. */
  upToDate: boolean;
  /** Optional packages the store could not provide, so the tree is short of them. */
  missingOptional: string[];
  stats: InstallStats;
}

/** What the linker did. For diagnostics: fields may change in any release. */
export interface InstallStats {
  entries: number;
  linked: number;
  copied: number;
  reused: number;
  repaired: number;
  pooled: number;
  bins: number;
  removed: number;
}

export interface AddResult extends InstallResult {
  added: Added[];
}

export interface RemoveResult extends InstallResult {
  removed: string[];
}

export interface Fetched {
  name: string;
  version: string;
  /** The store already had it. */
  cached: boolean;
  files: number;
  /** Unpacked size in bytes. */
  bytes: number;
}

export interface PruneResult {
  /** This project's stale `.upm` entries; undefined without an install state to trust. */
  entries?: { removed: number; bytes: number };
  /** Store content no index references. */
  content: { files: number; packages: number; bytes: number };
}

export interface ScriptList {
  /** The package's name, or its directory's. */
  name: string;
  /** From the root, `.` for the root itself. */
  path: string;
  file: string;
  scripts: Record<string, string>;
}

export interface ScriptResult {
  /** The package's name, or its directory's. */
  name: string;
  path: string;
  file: string;
  /** The script's exit code; undefined when it did not run. */
  code?: number;
  /** The package has no such script. A failure unless `ifPresent`. */
  missing?: boolean;
}

export interface RunResult {
  /** The first failure's code: a missing script is 1. 0 when every script passed. */
  code: number;
  /** One per package, in the order they ran. */
  results: ScriptResult[];
}

/**
 * Workers by default: up to eight, leaving the main thread a core, and none unless that is at
 * least two. One worker measured 15–19% slower than linking here (`nuxt`, `next` on two
 * cores) and two a wash; three won. `--experimental-link-pool=1` can still ask for one.
 *
 * A pool starts four, or one per 4,000 files when it knows more, up to this. On a warm link
 * over sixteen cores, eight beat four by 12% on 40,000 files and 15% on 117,000, twelve did
 * no better, and on `nuxt`'s 13,575 files eight were a wash for 40% more CPU and 58 MB.
 */
export function defaultPoolSize(cores: number): number {
  const spare = Math.min(8, cores - 1);
  return spare >= 2 ? spare : 0;
}

let poolDefaults: LinkPoolConfig | undefined;

/**
 * Where the pool was measured to pay for its own startup: `angular/cli` (238 packages, 7,000
 * files) gains 15%, `webpack` (64, 3,358) loses 10%. Read on first use, so importing the
 * package does not count cores.
 */
export function linkPoolDefaults(): LinkPoolConfig {
  return (poolDefaults ??= { size: defaultPoolSize(cpus()), packages: 200, files: 6000 });
}

/** One command's options, and what it found out about the project on the way. */
interface Context {
  options: InstallOptions & AddOptions & RunOptions;
  log: (message: string, level: LogLevel) => void;
  dedupe: boolean;
  resolvePool?: number;
  linkPool: LinkPoolConfig;
  /** The project root `projectDir` found: `dir`, else the walk up from cwd. */
  root?: string;
  /** What `findRoot` read of the root, so `loadProject` does not glob and parse it again. */
  found?: Root;
  /** The workspace cwd is in, when the walk up found a root above it. */
  inside?: Workspace;
  config?: Config;
  /** Which lockfile the project installs from, once `lockSource` has looked. */
  source?: LockSource;
  /** The lockfile `restoreLock` read and wrote back, so `plan` need not read it again. */
  restored?: Lockfile;
  /** Keys of packages whose bins another manager's lockfile left out. */
  binless?: string[];
  /** Another manager's lockfile as read, stamped first: a rewrite after is a new install's. */
  read?: { text?: string; stamp?: Stamp };
  /** Each tarball dependency's package.json by source, read once however often it is asked. */
  tarballs?: Map<string, Promise<Manifest>>;
  /** Each local tarball's stamp from just before this command checked or read its bytes. */
  stamped?: Map<string, Stamp>;
  /** Told by any pool that no thread of its would start; said once per command. */
  noThreads: () => void;
}

/** The options checked, before anything is read. */
function context(options: Context["options"], dedupe = false): Context {
  const { resolvePool, linkPool } = options.experimental ?? {};
  if (resolvePool !== undefined && !count(resolvePool, 16)) {
    throw fail("experimental.resolvePool takes a count from 0 to 16", "EOPTION");
  }
  if (linkPool !== undefined && (linkPool === null || typeof linkPool !== "object")) {
    throw fail("experimental.linkPool takes an object", "EOPTION");
  }
  // An entry left `undefined` keeps its default, as a missing one does.
  const given = Object.entries(linkPool ?? {}).filter(([, value]) => value !== undefined);
  const pool: LinkPoolConfig = { ...linkPoolDefaults(), ...Object.fromEntries(given) };
  if (!count(pool.size, 64) || !count(pool.packages) || !count(pool.files)) {
    throw fail("experimental.linkPool takes counts, and a size up to 64", "EOPTION");
  }
  const { workspaces } = options;
  const list = Array.isArray(workspaces) && workspaces.every((entry) => typeof entry === "string");
  if (workspaces !== undefined && workspaces !== "all" && !list) {
    throw fail(`workspaces takes "all" or a list of names and paths`, "EOPTION");
  }
  if (Array.isArray(workspaces) && workspaces.length === 0) {
    throw fail("workspaces lists no workspace", "EWORKSPACE");
  }
  const log = options.log ?? (() => {});
  let alone = false;
  const noThreads = () => {
    if (!alone) log("worker threads unavailable; running on one thread", "warn");
    alone = true;
  };
  return { options, log, dedupe, resolvePool, linkPool: pool, noThreads };
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

/** The root and its `.npmrc`, read first by every command but `run`. */
async function open(options: Context["options"], dedupe = false): Promise<Context> {
  return await opened(context(options, dedupe));
}

async function opened(ctx: Context): Promise<Context> {
  trace("open");
  const root = await projectDir(ctx);
  trace("root");
  ctx.config = readConfig(root, ctx.options);
  trace("config");
  // As npm: one .npmrc for the tree, or two workspaces could install one lockfile two ways.
  const own = ctx.inside && builtin.path.join(ctx.inside.dir, ".npmrc");
  if (own && builtin.fs.existsSync(own)) {
    ctx.log(`ignoring ${own}: .npmrc is read from ${root}`, "warn");
  }
  return ctx;
}

/**
 * Resolve (or reuse the lockfile), fill the store, then materialize node_modules.
 * Everything expensive is already memoized elsewhere, so a warm run is mostly stat calls.
 */
export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  return await installTree(await open(options));
}

/**
 * Resolve every range again, preferring the versions the lockfile already has, then install.
 * Deleting the lockfile and node_modules is how to resolve everything afresh.
 */
export async function dedupe(options: DedupeOptions = {}): Promise<InstallResult> {
  return await installTree(await open({ ...options, frozen: false }, true));
}

async function installTree(ctx: Context, edit?: Edit, loaded?: Project): Promise<InstallResult> {
  const { options, log } = ctx;
  const project = edit?.project ?? loaded ?? (await loadProject(ctx));
  trace("project");
  const { dir } = project;
  // Before the lockfile: the pool wants to know now whether there is a tree to compare.
  const state = options.verify ? undefined : await readState(dir);
  trace("state");
  if (!options.frozen) await restoreLock(ctx, project, state);
  // The state names the inputs it was made from: the same bytes and settings again, with the
  // tree still standing, is a no-op install that never reads the graph. The two files'
  // stamps say "same bytes" without a read or a hash; failing that, the hash decides. A local
  // tarball has only its stamp: any other, and the install below checks its bytes.
  if (state?.inputs !== undefined && !edit && !ctx.dedupe && project.workspaces.length === 0) {
    const stamps = stampsOf(ctx, dir);
    const stamped =
      stamps !== undefined &&
      sameStamp(stamps.lock, state.stamps?.lock) &&
      sameStamp(stamps.manifest, state.stamps?.manifest) &&
      stamps.settings === state.stamps?.settings;
    let matched = stamped;
    if (!matched) {
      const text = await lockText(ctx, dir);
      matched =
        text !== undefined && (await inputsHash(inputsOf(ctx, project, text))) === state.inputs;
    }
    trace("inputs");
    const files = state.tarballs;
    if (matched && files && sameFiles(dir, files) && treeStanding(dir, state)) {
      // Read and hashed this time: the stamps are recorded so the next install need not.
      if (!stamped && stamps) await writeState(dir, { ...state, stamps });
      trace("linked");
      const { packages, otherPlatforms, warnings } = state.summary!;
      for (const warning of warnings) log(warning, "warn");
      return {
        packages,
        workspaces: 0,
        otherPlatforms,
        upToDate: true,
        missingOptional: [],
        stats: { ...NOTHING, reused: state.entries.length },
      };
    }
  }
  const pool = linkPool(ctx, state === undefined);
  const store = openStore(ctx, options.verify);
  trace("store");
  const walk = {
    onPick: prefetch(ctx, dir, store, pool?.picked),
    tarball: tarballReader(ctx, dir, store),
  };
  const lock = await plan(ctx, project, walk, edit?.registry, state?.tarballs);
  trace("lock");
  pool?.planned(lock, store);
  trace("poolstart");
  // Only now: a package.json that names a tree the registry cannot resolve would be one that
  // no later install can get past either.
  if (edit) await saveManifest(edit);
  // The lockfile holds every platform's builds; this machine installs its own. Checked
  // already: `plan` returns what `readLockfile` parsed or what `formatLockfile` accepted.
  const checked = fromCheckedLockfile(lock, hostsOf(ctx));
  trace("checked");
  const resolution = filterPlatform(checked);
  trace("resolution");
  for (const warning of resolution.warnings) log(warning, "warn");
  // Only under verify: it is a property of the lockfile, not of the tree, so it would say
  // the same thing on every install and be ignored by the second one.
  if (options.verify) {
    for (const unmet of unmetPeers(resolution)) log(`unmet peer — ${unmet}`, "warn");
  }
  // Workspaces are linked from their directories, so they are neither packages nor fetched.
  const workspaces = Object.keys(lock.workspaces ?? {}).length;
  const elsewhere =
    Object.keys(lock.packages).length - (Object.keys(resolution.packages).length - workspaces);
  const wanted = Object.values(resolution.packages).filter(
    (pkg) => pkg.local === undefined && !(options.production && pkg.dev),
  );
  if (ctx.binless?.length) {
    const binless = new Set(ctx.binless);
    const { readBins } = await import("./foreign-lock.ts");
    await readBins(
      wanted.filter((pkg) => binless.has(`${pkg.name}@${pkg.version}`)),
      store,
    );
    trace("bins");
  }

  // Filling the store stats every file, so skip it when the tree already matches the graph.
  const hash = await stateHash(resolution, {
    production: options.production === true,
    store: store.dir,
  });
  const settled = state?.hash === hash;
  trace("hash");
  // Before the tree changes, so a failed link cannot leave the old copy behind it.
  if (!settled && lockSource(ctx, dir).foreign) {
    await builtin.fsp.rm(treeLockPath(dir), { force: true });
  }

  const fill = async (into: Store): Promise<void> => {
    await Promise.all(
      wanted.map(async (pkg) => {
        try {
          await into.ensure(tarballOf(dir, pkg.resolved, pkg.source), pkg.integrity);
        } catch (error) {
          // A failure inside an optional subtree must never fail the install.
          if (!pkg.optional && pkg.source !== undefined) {
            throw (await import("./tarball-deps.ts")).stale(error, pkg.source);
          }
          // Offline, a missing optional fails too: skipped, it would not be fetched again until
          // the resolution changes.
          if (!pkg.optional || (error as { code?: string }).code === "EOFFLINE") throw error;
          log(`skipped optional ${pkg.name}@${pkg.version}: ${describe(error)}`, "warn");
        }
      }),
    ).finally(into.flush);
    // Its threads are done; gone now, they are not the exit's to tear down. Each pool goes
    // when its phase ends — the registry's at the lock, this one here, the link pool's once
    // the entries are built — and the bin exits once the output is out, so a cold exit tears
    // down no idle isolates. Through the library, nothing exits: an idle thread is unref'd.
    into.close();
  };

  // The link runs under the fill: each entry is built as its tarball lands, so the last
  // tarballs' tail hides the link instead of preceding it. A failed download is what the
  // caller hears, not the missing entry the link sees: the catch waits for the fill first.
  // A store that holds every index already has nothing to fill: the linker then reads no index
  // for a count as each "lands", and builds from the start. 64 ms of `large`'s link.
  const filling =
    settled || (!options.verify && wanted.every((pkg) => store.indexSize(pkg.integrity) > 0))
      ? undefined
      : fill(store).finally(() => {
          trace("fill");
          if (tracing) trace("filled", take()); // the main thread's memory at that point
        });
  filling?.catch(() => {});
  // The inputs, for the state file, read back off disk: `plan` may just have written them.
  const inputs = project.workspaces.length === 0 ? await lockText(ctx, dir) : undefined;
  // The linker is handed the hash rather than computing it again: 3.7 ms on `nuxt`.
  const link = {
    dir,
    store,
    production: options.production,
    verify: options.verify,
    hash,
    pool: pool?.ask,
    awaiting: filling && store.pending,
    inputs:
      inputs === undefined
        ? undefined
        : {
            hash: await inputsHash(inputsOf(ctx, project, inputs)),
            packages: wanted.length,
            otherPlatforms: elsewhere,
            warnings: resolution.warnings,
            stamps: stampsOf(ctx, dir),
          },
    tarballs: filesOf(ctx, lock),
  };
  const linked = await linkTree(resolution, link).catch(async (error: unknown) => {
    await filling;
    // The store lost content between the fill and the link — a concurrent prune, or a state
    // file that outlived the store it names. A *fresh* store, because the one above memoized
    // every index it read and would never look at the disk again, and a verifying one: the
    // failed link is the proof that an index here promises files that are not on disk, so this
    // is the one pass that must stat them rather than believe them.
    if ((error as { code?: string }).code !== "ELINK") throw error;
    const again = openStore(ctx, true);
    await fill(again);
    return await linkTree(resolution, { ...link, store: again, awaiting: undefined });
  });
  await filling;
  await store.flush();
  await keepTreeLock(ctx, dir, linked.upToDate, inputs);
  trace("linked");
  const { entries, linked: links, copied, reused, repaired, pooled, bins, removed } = linked;
  return {
    packages: wanted.length,
    workspaces,
    otherPlatforms: elsewhere,
    upToDate: linked.upToDate,
    missingOptional: linked.dropped,
    stats: { entries, linked: links, copied, reused, repaired, pooled, bins, removed },
  };
}

const NOTHING = {
  entries: 0,
  linked: 0,
  copied: 0,
  reused: 0,
  repaired: 0,
  pooled: 0,
  bins: 0,
  removed: 0,
};

/**
 * No lockfile, but the tree in node_modules keeps a copy of the one it was linked from: when
 * that still describes package.json, it is written back and the install goes on from it, as
 * npm and pnpm take theirs from the tree. Otherwise the install resolves as without a tree:
 * the copy never outlives a change to package.json. Never under `frozen`, where no lockfile
 * is an error.
 */
async function restoreLock(ctx: Context, project: Project, state?: InstallState): Promise<void> {
  const { dir, manifest, workspaces } = project;
  const source = lockSource(ctx, dir);
  if (!source.missing) return;
  const text = readTreeLock(dir);
  if (text === undefined) return;
  // The state's inputs are these bytes with this package.json: that install's lockfile described
  // it, so there is nothing to read. Else the copy is read and checked, as a lockfile is.
  const { inputs } = state ?? {};
  const same = inputs !== undefined && inputs === (await inputsHash(inputsOf(ctx, project, text)));
  if (!same) {
    try {
      ctx.restored = parseLockfile(text);
    } catch {
      return; // torn, or another version's: resolve
    }
    if (!sameTree(ctx.restored, manifest, workspaces)) {
      ctx.restored = undefined;
      return;
    }
  }
  await writeLockfile(dir, text);
  ctx.source = { path: source.path };
  ctx.log(`wrote ${source.path} from the tree in node_modules`, "info");
}

/**
 * The tree's copy of the lockfile it was just linked from, for `restoreLock`. Only `upm.lock`'s:
 * a tree another manager's lockfile changed has had its copy removed before the link.
 */
async function keepTreeLock(
  ctx: Context,
  dir: string,
  upToDate: boolean,
  text?: string,
): Promise<void> {
  if (lockSource(ctx, dir).foreign) return;
  text ??= await lockText(ctx, dir);
  // An up-to-date tree may still have a new lockfile: the same versions, other ranges.
  if (text !== undefined && !(upToDate && readTreeLock(dir) === text)) {
    await writeTreeLock(dir, text);
  }
}

/** The lockfile's bytes, or nothing when there is none. */
async function lockText(ctx: Context, dir: string): Promise<string | undefined> {
  if (ctx.read) return ctx.read.text;
  try {
    return builtin.fs.readFileSync(lockSource(ctx, dir).path, "utf8"); // see readState
  } catch {
    return undefined;
  }
}

/** The lockfile's and the root manifest's stamps, when both are there, and the settings. */
function stampsOf(ctx: Context, dir: string): InstallState["stamps"] {
  const { join } = builtin.path;
  const lock = ctx.read ? ctx.read.stamp : stampOf(lockSource(ctx, dir).path);
  const manifest = stampOf(join(dir, "package.json"));
  return lock && manifest ? { lock, manifest, settings: settingsOf(settingsIn(ctx)) } : undefined;
}

/** Each of the lockfile's local tarballs with the stamp this command took before it checked it. */
function filesOf(ctx: Context, lock: Lockfile): Record<string, Stamp | null> {
  const files: Record<string, Stamp | null> = {};
  for (const source of localSources(lock).values())
    files[source] = ctx.stamped?.get(source) ?? null;
  return files;
}

/** Whether every local tarball has the stamp it had when an install last checked it. */
function sameFiles(dir: string, files: Record<string, Stamp | null>): boolean {
  for (const [source, stamp] of Object.entries(files)) {
    const at = builtin.path.resolve(dir, source.slice("file:".length));
    if (!stamp || !sameStamp(stampOf(at), stamp)) return false;
  }
  return true;
}

/** The lockfile's local tarballs: key -> source. */
function localSources(lock: Lockfile): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of Object.keys(lock.packages)) {
    // No name holds `@file:`, so this is where the key's source starts.
    const at = key.indexOf("@file:");
    if (at > 0) out.set(key, key.slice(at + 1));
  }
  return out;
}

/** The lockfile's local tarballs whose file changed since, checked only when it has any. */
async function movedIn(
  ctx: Context,
  dir: string,
  lock: Lockfile,
  read: ResolveOptions["tarball"],
  recorded: Record<string, Stamp | null> = {},
): Promise<string[]> {
  const sources = localSources(lock);
  if (sources.size === 0 || !read) return [];
  const { movedTarballs } = await import("./tarball-deps.ts");
  const stamped = (ctx.stamped ??= new Map());
  const log = (message: string) => ctx.log(message, "info");
  return await movedTarballs(dir, lock, sources, read, recorded, stamped, log);
}

/** What the tree is a function of, besides the store's content. */
function inputsOf(ctx: Context, project: Project, lock: string): Inputs {
  return { lock, manifest: project.manifest, ...settingsIn(ctx) };
}

/** The inputs that are neither file. */
function settingsIn(ctx: Context): Omit<Inputs, "lock" | "manifest"> {
  const { registry, scopes } = settings(ctx);
  return {
    production: ctx.options.production === true,
    // The store the install uses, defaults included: `inputsHash` resolves it, and a default
    // resolved from "" would be the cwd.
    store: storeDir(ctx.options.store),
    hosts: [registry, scopes],
    platform: currentPlatform(),
  };
}

/**
 * Start each package's tarball as the walk picks it, so the store fills while the rest of the
 * tree resolves rather than after the lockfile: on `nuxt` the last tarball used to be asked
 * for 1.2 s after the walk had picked it. This platform's builds only, and not what only an
 * off-platform build reaches — `@img/sharp-wasm32` declares nothing itself and is 3.5 MiB
 * `next` never links. Not under production, since which packages are dev is reachability
 * and known only once the walk is done; and not for dedupe, whose passes pick versions the
 * next pass drops. A failure here is nothing: `fill` asks again, and that one is reported.
 */
function prefetch(
  ctx: Context,
  dir: string,
  store: Store,
  picked?: () => void,
): ResolveOptions["onPick"] {
  if (ctx.options.production || ctx.dedupe) return undefined;
  const here = currentPlatform();
  // Each package's fate, skipped or not, recorded the moment it is announced: a child is
  // announced after its parent and waits for the parent's, which may still wait on a libc read.
  const skipped = new Map<string, Promise<boolean>>();
  return (pkg, from, libc) => {
    const parent = skipped.get(from);
    skipped.set(
      keyOf(pkg),
      (async () => {
        if (parent && (await parent)) return true;
        if (!runsOn(pkg, here)) return true;
        if (libc) {
          const read = await libc.catch(() => undefined);
          if (read !== undefined && !runsOn({ ...pkg, libc: read }, here)) return true;
        }
        picked?.();
        store.add(tarballOf(dir, pkg.resolved, pkg.source), pkg.integrity).catch(() => {});
        return false;
      })(),
    );
  };
}

/**
 * About what this machine will install, before the lockfile is converted: the platform-neutral
 * entries. The others are every platform's native builds, of which one platform installs a
 * few — 121 of the 240 in upm's own lockfile. `files` is a guess from the size of the store's
 * indexes for those entries, a stat each: an index is about 160 bytes a file after 130 of its
 * own, and that is how a small graph of large packages (`next`, 22 entries, 10,000 files)
 * shows its size without the 8 ms it takes to read the big one. The linker counts for real.
 */
function neutral(lock: Lockfile, store: Store): { packages: number; files: number } {
  let packages = 0;
  let files = 0;
  for (const entry of Object.values(lock.packages)) {
    if (entry.os || entry.cpu || entry.libc) continue;
    packages++;
    files += Math.max(0, store.indexSize(entry.integrity) - 130) / 160;
  }
  return { packages, files };
}

/** The link pool: told the counts as they are known, asked for by the linker, who closes it. */
interface PoolPlan {
  /** The walk picked one more package this platform installs. */
  picked(): void;
  /** The lockfile is in. */
  planned(lock: Lockfile, store: Store): void;
  ask(files: () => number): Promise<LinkPool | undefined>;
}

/**
 * The link pool. A thread takes ~25 ms to come up, so on a fresh tree it is started as soon
 * as the package count says the install is large — the walk's picks reach it while the walk
 * still runs, the lockfile's entries when one is read — or the store's index sizes say its
 * few packages are; the module is loaded while the lockfile is read, so that start does not
 * wait on a thread this one is busy on. Otherwise when the linker reports the file count.
 * Not under production: the lockfile's count says nothing about what a dev-heavy tree leaves
 * to link (557 entries, one linked: a pool for nothing, +27 ms). The file count the linker
 * reports does: once with every index in hand, or as the tarballs land under a filling store.
 * Every ask gets the same pool.
 */
function linkPool(ctx: Context, fresh: boolean): PoolPlan | undefined {
  const config = ctx.linkPool;
  if (config.size === 0) return undefined;
  let loading: Promise<typeof import("./link-pool.ts")> | undefined;
  let loaded: typeof import("./link-pool.ts") | undefined;
  let pool: Promise<LinkPool | undefined> | undefined;
  let picks = 0;
  // The files known when it starts, which its size follows: see `defaultPoolSize`.
  let files = 0;
  const load = () => (loading ??= import("./link-pool.ts").then((m) => (loaded = m)));
  const begin = (m: typeof import("./link-pool.ts")) =>
    m.startLinkPool(
      Math.min(config.size, Math.max(4, Math.ceil(files / 4000))),
      undefined,
      undefined,
      ctx.noThreads,
    );
  // Started now when the module is in: from a `then`, the threads would wait for this thread's
  // next await, after the lockfile is converted and hashed — 14 ms on `next`, 33 on `large`.
  // A runtime that cannot load the pool builds every entry here, as without one.
  const start = () =>
    (pool ??= loaded
      ? Promise.resolve(begin(loaded))
      : load().then(begin, () => {
          ctx.noThreads();
          return undefined;
        }));
  const early = fresh && !ctx.options.production;
  if (early) load().catch(() => {});
  return {
    picked() {
      if (early && ++picks >= config.packages) void start();
    },
    planned(lock, store) {
      if (!early || pool) return;
      const found = neutral(lock, store);
      if ((files = found.files) >= config.files || found.packages >= config.packages) void start();
    },
    ask: (count) =>
      pool || (files = count()) >= config.files ? start() : Promise.resolve(undefined),
  };
}

/** An edited package.json on its way through an install, written once the install can use it. */
interface Edit {
  file: string;
  raw: string;
  manifest: RootManifest;
  /** The tree the install reads, with `manifest` already in it where the file was. */
  project: Project;
  registry?: OpenRegistry;
}

/**
 * Write each spec into package.json, then install. Every spec is resolved first, so a name
 * the registry does not have leaves package.json alone — and the same registry goes on to
 * the install, which then finds every packument already read. A workspace's name is not
 * the registry's to answer: a bare name or a fitting range saves a range of its version,
 * as npm does, and `workspace:` is saved as typed.
 */
export async function add(specs: string[], options: AddOptions = {}): Promise<AddResult> {
  if (specs.length === 0) throw fail("add needs at least one spec", "EOPTION");
  const group = options.group ?? "dependencies";
  if (!GROUPS.includes(group)) throw fail(`${group} is not a dependency group`, "EOPTION");
  // A tarball on its own is named by its package.json, so it is read before it is a spec.
  const bare = specs.map((raw) => bareTarball(raw));
  const parsed = specs.map((raw, i) => (bare[i] === undefined ? parseSpec(raw) : undefined));
  const ctx = await open(options);
  const exact = options.exact ?? ctx.config!.saveExact;
  const edit = await editTarget(ctx, "add");
  const local = new Map(edit.project.workspaces.map((ws) => [ws.name, ws.version]));
  const registry = await openRegistry(ctx);
  let added: Added[];
  try {
    added = await Promise.all(
      specs.map(async (raw, i) => {
        const spec = parsed[i];
        if (spec === undefined || spec.type === "tarball") {
          const { fromCwd, nameOf } = await import("./tarball-deps.ts");
          const fetchSpec = fromCwd(edit.file, bare[i] ?? spec!.fetchSpec);
          const { dir } = edit.project;
          let name = spec?.name;
          if (name === undefined) {
            const store = openStore(ctx);
            name = await nameOf(tarballReader(ctx, dir, store), dir, edit.file, raw, fetchSpec);
          }
          return { name, range: parseDep(name, fetchSpec).fetchSpec, group };
        }
        const version = local.get(spec.fetchName);
        const found =
          version !== undefined && linksTo(spec, version)
            ? version
            : (await pickOne(registry, spec)).version;
        return { name: spec.name, range: saveRange(spec, found, exact), group };
      }),
    );
    const twice = added.find((d, i) => added.some((other, j) => j < i && other.name === d.name));
    if (twice) throw fail(`${twice.name} is given more than once`, "EINVALIDSPEC");
  } catch (error) {
    // On success the install closes it, once the tree is resolved with the same memo.
    registry.close();
    throw error;
  }
  addDeps(edit.manifest, added);
  for (const dep of added) ctx.log(`+ ${dep.name}@${dep.range} in ${dep.group}`, "info");
  return { added, ...(await installTree(ctx, { ...edit, registry })) };
}

/**
 * Whether the resolver links a spec to the workspace of its name at `version`: `workspace:`
 * always (the resolver refuses a range it does not fit), a plain range when it fits; an alias
 * or a tag is the registry's.
 */
function linksTo(spec: Spec, version: string): boolean {
  if (spec.type === "workspace") return true;
  if (spec.name !== spec.fetchName || spec.type === "tag" || spec.type === "tarball") return false;
  return satisfies(version, spec.fetchSpec);
}

/** Take each name out of package.json, then install — the sweep is what unlinks them. */
export async function remove(names: string[], options: RemoveOptions = {}): Promise<RemoveResult> {
  if (names.length === 0) throw fail("remove needs at least one name", "EOPTION");
  const ctx = await open(options);
  const edit = await editTarget(ctx, "remove");
  const removed = [...new Set(names)];
  // Nothing is written unless every name is there: removing what is not a dependency is a typo.
  const missing = removeDeps(edit.manifest, removed);
  if (missing.length > 0) {
    throw fail(`not a dependency in ${edit.file}: ${missing.join(", ")}`, "ENODEP");
  }
  for (const name of removed) ctx.log(`- ${name}`, "info");
  return { removed, ...(await installTree(ctx, edit)) };
}

/**
 * Drop what nothing needs: this project's stale entries first, then content no index still
 * references. An index is never dropped just because no project wants it, and anything
 * written in the last hour is left alone, to stay clear of a running install.
 */
export async function prune(options: PruneOptions = {}): Promise<PruneResult> {
  const ctx = await open(options);
  const dir = ctx.root!;
  const store = createStore({ dir: options.store });
  const state = await readState(dir);
  const entries = state ? await sweepEntries(dir, new Set(state.entries)) : undefined;
  const { blobs, indexes, bytes } = await pruneStore(store.dir);
  return { entries, content: { files: blobs, packages: indexes, bytes } };
}

/**
 * The scripts of cwd's own package.json (or `dir`'s), root or workspace; under `workspaces`,
 * of each workspace picked, in run order.
 */
export async function listScripts(options: ListScriptsOptions = {}): Promise<ScriptList[]> {
  return (await packages(context(options))).map(({ name, path, file, manifest }) => ({
    name,
    path,
    file,
    scripts: readScripts(manifest, file),
  }));
}

/**
 * One package.json script, in a shell sharing this process's stdio and environment, with every
 * node_modules/.bin above it first on PATH. While it runs, SIGTERM (and SIGINT and SIGHUP
 * without a terminal) is forwarded to it. Without `workspaces` that is cwd's own package.json
 * (or `dir`'s).
 *
 * Under `workspaces`, the script runs in each workspace picked, each after the workspaces it
 * depends on: a monorepo's `build` needs its dependencies built first. npm runs them as
 * declared; pnpm orders them, and so does this. A failure does not stop the rest, as with both,
 * and each one is logged.
 */
export async function run(script: string, options: RunOptions = {}): Promise<RunResult> {
  const ctx = context(options);
  const { args = [], ifPresent } = options;
  const logged = options.workspaces !== undefined;
  const results: ScriptResult[] = [];
  const tops = await packages(ctx);
  const found = tops.some(({ manifest, file }) =>
    Object.hasOwn(readScripts(manifest, file), script),
  );
  if (options.install && found) await installFirst(ctx);
  for (const { name, path, file, dir, manifest } of tops) {
    const scripts = readScripts(manifest, file);
    // `hasOwn`, or a script named `constructor` would run the prototype's function.
    if (!Object.hasOwn(scripts, script)) {
      results.push({ name, path, file, missing: true });
      if (!ifPresent && logged) ctx.log(`missing script "${script}" in ${file}`, "warn");
      continue;
    }
    const command = scripts[script]!;
    const line = shellLine(command, args);
    options.onScript?.({ script, line, workspace: logged ? name : undefined });
    const code = await runScript({ dir, file, name: script, command, args, pkg: manifest });
    results.push({ name, path, file, code });
  }
  const failed = results.filter((r) => (r.missing ? !ifPresent : r.code !== 0));
  if (logged) {
    for (const { name, path, code } of failed) {
      ctx.log(`${script} failed in ${name} (${path}) with code ${code ?? 1}`, "warn");
    }
  }
  return { code: failed.length > 0 ? (failed[0]!.code ?? 1) : 0, results };
}

/** `run`'s install: of the tree its packages are in, as that tree was last installed. */
async function installFirst(ctx: Context): Promise<void> {
  const { options } = ctx;
  // Without `workspaces`, `run` reads `dir`'s own package.json: its tree may start above it.
  let found: Root | undefined;
  if (ctx.root === undefined) {
    const { findRoot } = await import("./workspaces.ts");
    found = await findRoot(builtin.path.resolve(options.dir ?? globalThis.process.cwd()));
  }
  const root = found?.dir ?? ctx.root!;
  const state = await readState(root);
  const install = context({
    ...options,
    dir: root,
    workspaces: undefined,
    production: state?.production,
    store: options.store ?? state?.store,
  });
  install.found = found ?? ctx.found;
  install.inside = found ? found.workspace : ctx.inside;
  const project = await loadProject(await opened(install));
  const { dependencies, devDependencies, optionalDependencies } = project.manifest;
  const declared = [dependencies, devDependencies, optionalDependencies].some(
    (group) => group && Object.keys(group).length > 0,
  );
  // No lockfile or node_modules for a project that never needed one.
  if (!state && !declared && project.workspaces.length === 0) return;
  const result = await installTree(install, undefined, project);
  for (const id of result.missingOptional) ctx.log(`${id} is missing from the store`, "warn");
  if (!result.upToDate) ctx.log(`installed ${result.packages} packages`, "info");
}

/**
 * A package's bin, as npx runs one, from `dir` (default cwd). A name with no version that a
 * `node_modules` above has, as a bin or a package, runs from there. Anything else installs into
 * a project under `execHome`, one per set of versions and registries, so a rerun is a no-op
 * install; a tag or range asks the registry each time. The registry is `dir`'s project's.
 */
export async function exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const { args = [], packages, call } = options;
  if (call && args.length > 0) throw fail("exec takes a call line or args, not both", "EOPTION");
  const log = options.log ?? (() => {});
  const cwd = builtin.path.resolve(options.dir ?? globalThis.process.cwd());
  const run = (line: string, dirs: string[]) =>
    runShell(line, cwd, withPath([...dirs, ...binDirs(cwd)]));
  const spawn = (words: string[], dirs: string[]) => {
    const env = withPath([...dirs, ...binDirs(cwd)]);
    return runArgs(words.map((word) => quote(word)).join(" "), args, cwd, env, words[0]);
  };
  // A call names no package, so without `packages` there is nothing to install or look up.
  if (call && packages === undefined) return { code: await run(command, []) };
  // Before the spec is parsed: `_mocha` is a bin, and no package could have that name. The
  // project's own bin first, as npm: it is never worth a registry package of the same name.
  // Loaded here, as `workspaces.ts` is: no other command needs it to start.
  const { execHome, localBin, pickBin, readJson, selfBin } = await import("./exec.ts");
  if (packages === undefined) {
    const local = (await selfBin(cwd, command)) ?? (await localBin(cwd, command));
    if (local) return { code: await spawn(local, []) };
  }
  const own = packages === undefined ? parseSpec(command) : undefined;
  if (packages?.length === 0) throw fail("exec lists no package to install", "EOPTION");
  // The install's own progress is about a directory the caller never chose; its warnings stay.
  const quiet = (message: string, level: LogLevel) => level !== "info" && log(message, level);
  const ctx = await open({ ...options, log: quiet });
  const { dir, specs } = await execProject(ctx, packages ?? [command], execHome(ctx.root!));
  const installed = await installTree(ctx);
  if (!installed.upToDate) log(`installed ${specs.join(", ")}`, "info");
  const file = builtin.path.join(dir, "node_modules", own?.name ?? "", "package.json");
  const bins = [builtin.path.join(dir, "node_modules", ".bin")];
  if (call) return { code: await run(command, bins), installed: dir };
  const bin = own ? pickBin(await readJson(file), own.fetchName) : command;
  const code = await spawn([bin], bins);
  return { code, installed: dir };
}

/**
 * Where `specs` install under `home`, made the context's root; the config stays the one `open`
 * read. The registries are in the name: the same versions there can be other bytes.
 */
async function execProject(
  ctx: Context,
  specs: string[],
  home: string,
): Promise<{ dir: string; specs: string[] }> {
  const parsed = specs.map((raw) => parseSpec(raw));
  const local = parsed.find((spec) => spec.type === "workspace" || spec.type === "tarball");
  if (local) throw fail(`exec installs registry packages, not ${local.raw}`, "EINVALIDSPEC");
  // An exact version is its own answer, so running one again asks the registry nothing.
  const loose = parsed.filter((spec) => spec.type !== "version");
  const picked =
    loose.length > 0
      ? await pickAll(
          ctx,
          loose.map((spec) => spec.raw),
        )
      : [];
  // A Map, so a package named `__proto__` stays a key.
  const deps = new Map<string, string>();
  for (const spec of parsed) {
    if (deps.has(spec.name)) throw fail(`${spec.name} is given more than once`, "EINVALIDSPEC");
    // `v1.0.0` and `=1.0.0` are 1.0.0, and one project.
    const version =
      spec.type === "version"
        ? parse(spec.fetchSpec)!.version
        : picked[loose.indexOf(spec)]!.version;
    deps.set(
      spec.name,
      spec.name === spec.fetchName ? version : `npm:${spec.fetchName}@${version}`,
    );
  }
  const sorted = [...deps].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const manifest = { private: true, dependencies: Object.fromEntries(sorted) };
  const text = `${JSON.stringify(manifest, undefined, 2)}\n`;
  const { join } = builtin.path;
  const { registry, scopes } = settings(ctx);
  const scoped = Object.entries(scopes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const key = await shortHash(JSON.stringify([registry, scoped, text]));
  const dir = join(home, key);
  const file = join(dir, "package.json");
  if ((await builtin.fsp.readFile(file, "utf8").catch(() => undefined)) !== text) {
    // Through a rename: another run of the same versions may be reading it.
    await builtin.fsp.mkdir(dir, { recursive: true });
    const temp = `${file}.${pid}-${globalThis.crypto.randomUUID()}.tmp`;
    await builtin.fsp.writeFile(temp, text);
    await replaceFile(temp, file);
  }
  ctx.root = dir;
  ctx.found = undefined;
  ctx.inside = undefined;
  return { dir, specs: sorted.map(([name, range]) => `${name}@${range}`) };
}

/** A package a script runs in: the workspaces picked, or cwd's own package.json. */
type Package = Workspace & { file: string };

async function packages(ctx: Context): Promise<Package[]> {
  const { options } = ctx;
  const { join, basename, resolve } = builtin.path;
  if (options.workspaces === undefined) {
    const dir = resolve(options.dir ?? globalThis.process.cwd());
    const { file, manifest } = await loadManifest(dir);
    const name = manifest.name || basename(dir);
    return [{ path: ".", dir, name, version: manifest.version ?? "", manifest, file }];
  }
  const project = await loadProject(ctx);
  const picked = new Set(selectWorkspaces(options, project.dir, project.workspaces));
  const { order, cycles } = runOrder(project.workspaces);
  for (const cycle of cycles) {
    if (!cycle.some((ws) => picked.has(ws))) continue;
    const names = cycle.map((ws) => ws.name).join(", ");
    ctx.log(`workspaces ${names} depend on each other; running them as declared`, "warn");
  }
  const tops = order.filter((ws) => picked.has(ws));
  if (options.includeRoot) {
    const { dir, manifest } = project;
    const name = manifest.name || basename(dir);
    tops.unshift({ path: ".", dir, name, version: manifest.version ?? "", manifest });
  }
  return tops.map((top) => ({ ...top, file: join(top.dir, "package.json") }));
}

/**
 * Every workspace, each after the ones its `dependencies`, `devDependencies` and
 * `optionalDependencies` name — by `workspace:` spec, or by a range its version fits, which is
 * where the resolver would link it — and otherwise as declared. Workspaces that depend on each
 * other in a cycle come out together, as declared, and are reported so the order is not
 * mistaken for one that works. Tarjan's walk: a component is emitted only after every
 * component it reaches, and in declared order it visits, that is dependencies first.
 */
function runOrder(all: Workspace[]): { order: Workspace[]; cycles: Workspace[][] } {
  const index = new Map<Workspace, number>();
  const low = new Map<Workspace, number>();
  const stack: Workspace[] = [];
  const order: Workspace[] = [];
  const cycles: Workspace[][] = [];
  const visit = (ws: Workspace): void => {
    index.set(ws, index.size);
    low.set(ws, index.get(ws)!);
    stack.push(ws);
    for (const dep of all) {
      if (dep === ws || !dependsOn(ws, dep)) continue;
      if (!index.has(dep)) visit(dep);
      else if (!stack.includes(dep)) continue;
      low.set(ws, Math.min(low.get(ws)!, low.get(dep)!));
    }
    if (low.get(ws) !== index.get(ws)) return;
    const members = stack.splice(stack.indexOf(ws)).sort((a, b) => all.indexOf(a) - all.indexOf(b));
    if (members.length > 1) cycles.push(members);
    order.push(...members);
  };
  for (const ws of all) if (!index.has(ws)) visit(ws);
  return { order, cycles };
}

/** Whether `ws` declares `dep` the way the resolver links a workspace: by name, never by alias. */
function dependsOn(ws: Workspace, dep: Workspace): boolean {
  for (const group of GROUPS) {
    for (const [name, range] of Object.entries(ws.manifest[group] ?? {})) {
      let spec: Spec;
      try {
        spec = parseDep(name, range);
      } catch {
        continue; // the resolver's error, not this one's
      }
      if (spec.fetchName === dep.name && linksTo(spec, dep.version)) return true;
    }
  }
  return false;
}

/**
 * The lockfile to install from. `frozen` is the CI path: read it, never write it.
 * The registry is opened only once the lockfile is known to be stale — `add` hands in the
 * one it resolved its specs with — and closed here either way.
 */
async function plan(
  ctx: Context,
  project: Project,
  walk: Walk,
  opened?: OpenRegistry,
  recorded?: Record<string, Stamp | null>,
): Promise<Lockfile> {
  const { dir, manifest, workspaces } = project;
  const { frozen } = ctx.options;
  const { foreign } = lockSource(ctx, dir);
  if (foreign) {
    opened?.close();
    if (ctx.dedupe) throw (await import("./foreign-lock.ts")).beside(foreign, "dedupe");
    return await foreignLock(ctx, project, foreign);
  }
  const existing = frozen
    ? await readLockfile(dir)
    : (ctx.restored ?? (await currentLock(ctx, dir)));
  trace("lockread");
  // A local tarball is read like package.json: other bytes in the file make the lockfile stale.
  const moved = existing ? await movedIn(ctx, dir, existing, walk.tarball, recorded) : [];
  if (existing && moved.length === 0 && sameTree(existing, manifest, workspaces) && !ctx.dedupe) {
    opened?.close();
    return existing;
  }
  if (frozen) {
    opened?.close();
    const changed = moved.map((key) => localSources(existing!).get(key)).join(", ");
    const why = !existing
      ? "is missing"
      : changed
        ? `is out of date: ${changed} changed since it was locked`
        : "is out of date with package.json";
    throw fail(`${builtin.path.join(dir, LOCKFILE)} ${why}`, "ELOCK");
  }
  const registry = opened ?? (await openRegistry(ctx));
  try {
    return await resolveLock(ctx, project, existing, registry, walk, moved);
  } finally {
    registry.close();
  }
}

/** What an install's walk is given besides the registry: its prefetch and its tarball reader. */
type Walk = Pick<ResolveOptions, "onPick" | "tarball">;

async function resolveLock(
  ctx: Context,
  project: Project,
  existing: Lockfile | undefined,
  registry: Registry,
  walk: Walk,
  moved: string[] = [],
): Promise<Lockfile> {
  const { dir, manifest } = project;
  const { dedupe, log } = ctx;
  const locked = keep(existing, registry.baseFor, moved);
  const options = { registry, dedupe, ...walk, workspaces: tops(project) };
  let resolution = await resolveTree(manifest, { ...options, locked });
  // A range the lock could not satisfy brings in a version the kept ranges never got to see;
  // another pass lets them move onto it. The registry memoizes by version, so a pass that
  // changes nothing costs no request, and the count only ever falls.
  if (dedupe) {
    for (let size = Infinity; Object.keys(resolution.packages).length < size;) {
      size = Object.keys(resolution.packages).length;
      resolution = await resolveTree(manifest, { ...options, locked: resolution });
    }
  }
  for (const warning of resolution.warnings) log(warning, "warn");
  const lock = toLockfile(resolution, registry.baseFor);
  if (existing && formatLockfile(lock) === formatLockfile(existing)) {
    if (dedupe) log("nothing to dedupe", "info");
    return existing;
  }
  if (dedupe && locked) {
    const dropped = Object.keys(locked.packages).length - Object.keys(lock.packages).length;
    if (dropped > 0) log(`dropped ${dropped} packages`, "info");
  }
  await writeLockfile(dir, lock);
  log(`wrote ${builtin.path.join(dir, LOCKFILE)} — ${counts(lock)}`, "info");
  return lock;
}

/**
 * The lockfile of the whole graph: devDependencies, marked dev-only, and every platform's
 * optional builds, marked with the os/cpu/libc they need. Resolves only when package.json
 * moved since the lockfile was written, keeping every package whose range did not.
 */
export async function lock(options: LockOptions = {}): Promise<Lockfile> {
  const ctx = await open(options);
  const project = await loadProject(ctx);
  const { dir, manifest, workspaces } = project;
  const { foreign } = lockSource(ctx, dir);
  if (foreign) {
    const locked = await foreignLock(ctx, project, foreign);
    ctx.log(`${foreign} is up to date — ${counts(locked)}`, "info");
    return locked;
  }
  const existing = await currentLock(ctx, dir);
  const store = openStore(ctx);
  const tarball = tarballReader(ctx, dir, store);
  const moved = existing ? await movedIn(ctx, dir, existing, tarball) : [];
  if (existing && moved.length === 0 && sameTree(existing, manifest, workspaces)) {
    ctx.log(`${LOCKFILE} is up to date — ${counts(existing)}`, "info");
    return existing;
  }

  const registry = await openRegistry(ctx);
  const resolution = await resolveTree(manifest, {
    registry,
    locked: keep(existing, registry.baseFor, moved),
    workspaces: tops(project),
    tarball,
  }).finally(() => {
    registry.close();
    store.close();
    return store.flush();
  });
  const lock = toLockfile(resolution, registry.baseFor);
  for (const warning of resolution.warnings) ctx.log(warning, "warn");
  ctx.log(counts(lock), "info");
  if (options.write === false) return lock;
  await writeLockfile(dir, lock);
  ctx.log(`wrote ${builtin.path.join(dir, LOCKFILE)}`, "info");
  return lock;
}

/** Fill the store with every package the lockfile names for this platform. No linking. */
export async function fetchLockfile(options: FetchLockfileOptions = {}): Promise<Fetched[]> {
  const ctx = await open(options);
  const dir = await projectDir(ctx);
  const { foreign } = lockSource(ctx, dir);
  const lock = foreign
    ? await foreignLock(ctx, await loadProject(ctx), foreign)
    : await readLockfile(dir);
  if (!lock) throw fail(`no ${LOCKFILE} in ${dir}`, "ELOCK");
  const store = openStore(ctx);
  const resolution = filterPlatform(fromCheckedLockfile(lock, hostsOf(ctx)));
  for (const warning of resolution.warnings) ctx.log(warning, "warn");
  // Not the workspaces: there is no tarball to fetch for a directory.
  const wanted = Object.values(resolution.packages).filter(
    (pkg) => pkg.local === undefined && !(options.production && pkg.dev),
  );
  // A flat loop over the lockfile: no packuments, no version picking, no semver.
  const results = await Promise.all(
    wanted.map(async (pkg) => {
      try {
        const at = tarballOf(dir, pkg.resolved, pkg.source);
        return fetched(pkg, await store.add(at, pkg.integrity));
      } catch (error) {
        // A failure inside an optional subtree must never fail the install.
        if (!pkg.optional) throw error;
        ctx.log(`skipped optional ${pkg.name}@${pkg.version}: ${describe(error)}`, "warn");
        return undefined;
      }
    }),
  ).finally(store.flush);
  return results.filter((result) => result !== undefined);
}

/** What each spec resolves to on the registry, in order. */
export async function resolve(specs: string[], options: SpecOptions = {}): Promise<Manifest[]> {
  return await pickAll(await open(options), specs);
}

/** Resolve each spec and add its tarball to the store. No package.json, no linking. */
export async function fetchPackages(
  specs: string[],
  options: FetchPackagesOptions = {},
): Promise<Fetched[]> {
  const ctx = await open(options);
  const picked = await pickAll(ctx, specs);
  const store = openStore(ctx);
  return await Promise.all(
    picked.map(async (manifest) =>
      fetched(manifest, await store.add(manifest.dist.tarball, integrityOf(manifest))),
    ),
  ).finally(store.flush);
}

function fetched(
  { name, version }: { name: string; version: string },
  { index, cached }: Awaited<ReturnType<Store["add"]>>,
): Fetched {
  return { name, version, cached, files: index.files.length, bytes: index.unpackedSize };
}

/**
 * The project root, found once: `dir` as given, else npm's walk up from cwd — the nearest
 * package.json, or the root above it that lists that directory as a workspace, which is then
 * `ctx.inside`.
 */
async function projectDir(ctx: Context): Promise<string> {
  if (ctx.root !== undefined) return ctx.root;
  const { dir } = ctx.options;
  if (dir !== undefined) return (ctx.root = builtin.path.resolve(dir));
  const { findRoot } = await import("./workspaces.ts");
  const found = (ctx.found = await findRoot(globalThis.process.cwd()));
  ctx.inside = found.workspace;
  return (ctx.root = found.dir);
}

/** The root's package.json and the workspaces it declares: what one install is of. */
interface Project {
  dir: string;
  manifest: RootManifest;
  workspaces: Workspace[];
}

async function loadProject(ctx: Context): Promise<Project> {
  const dir = await projectDir(ctx);
  const manifest = ctx.found?.manifest ?? (await loadManifest(dir)).manifest;
  const { findWorkspaces } = await import("./workspaces.ts");
  const workspaces = ctx.found?.workspaces ?? (await findWorkspaces(dir, manifest));
  return { dir, manifest, workspaces };
}

/** What the resolver is told about the workspaces: where each is and what it declares. */
function tops(project: Project): ResolveOptions["workspaces"] {
  return project.workspaces.map(({ path, manifest }) => ({ path, manifest }));
}

/**
 * The package.json `add` and `remove` edit: the workspace `workspaces` picks, else the one cwd
 * is in, else the root's. One file — the install that follows is of the whole tree either
 * way, and that install reads the edit before it is written, so the tree holds the parsed file.
 */
async function editTarget(ctx: Context, command: string): Promise<Edit> {
  const project = await loadProject(ctx);
  const { foreign } = lockSource(ctx, project.dir);
  if (foreign) throw (await import("./foreign-lock.ts")).beside(foreign, command);
  let workspace = ctx.inside;
  if (ctx.options.workspaces !== undefined) {
    const picked = selectWorkspaces(ctx.options, project.dir, project.workspaces);
    if (picked.length === 0) throw fail(`${command} found no workspace to edit`, "EWORKSPACE");
    if (picked.length > 1) {
      const names = picked.map((ws) => ws.name).join(", ");
      throw fail(`${command} edits one package.json, and workspaces picks ${names}`, "EWORKSPACE");
    }
    workspace = picked[0];
  }
  const loaded = await loadManifest(workspace?.dir ?? project.dir);
  if (workspace) {
    const found = project.workspaces.find((ws) => ws.path === workspace.path);
    if (found) found.manifest = loaded.manifest;
  } else {
    project.manifest = loaded.manifest;
  }
  return { ...loaded, project };
}

/**
 * The workspaces the option names, in declared order: each a workspace's name, its directory
 * from the root or from cwd, or a directory above some, as npm reads them. Every entry has to
 * find one, or `-w packags` would quietly act on nothing.
 */
function selectWorkspaces(options: WorkspaceOptions, root: string, all: Workspace[]): Workspace[] {
  if (options.workspaces === "all") return all;
  const { resolve, sep } = builtin.path;
  const picked = new Set<Workspace>();
  for (const arg of options.workspaces ?? []) {
    const dirs = [resolve(root, arg), resolve(globalThis.process.cwd(), arg)];
    // The workspace itself before the ones under it: `-w .` from inside one is that one.
    const exact = all.filter((ws) => ws.name === arg || dirs.includes(ws.dir));
    const under = all.filter((ws) => dirs.some((dir) => ws.dir.startsWith(dir + sep)));
    const hits = exact.length > 0 ? exact : under;
    if (hits.length === 0) throw fail(`no workspace is named or at ${arg}`, "EWORKSPACE");
    for (const ws of hits) picked.add(ws);
  }
  return all.filter((ws) => picked.has(ws));
}

/** The parsed package.json and its text — the text is what `saveManifest` keeps the shape of. */
async function loadManifest(
  dir: string,
): Promise<{ file: string; raw: string; manifest: RootManifest }> {
  const file = builtin.path.join(dir, "package.json");
  let raw: string;
  try {
    raw = await builtin.fsp.readFile(file, "utf8");
  } catch (error) {
    throw Object.assign(fail(`cannot read ${file}: ${(error as Error).message}`, "EMANIFEST"), {
      cause: error,
    });
  }
  return { file, raw, manifest: parseManifest(raw, file) };
}

async function saveManifest({ file, raw, manifest }: Edit): Promise<void> {
  const text = formatManifest(manifest, raw);
  if (text === raw) return;
  try {
    await builtin.fsp.writeFile(file, text);
  } catch (error) {
    throw fail(`cannot write ${file}: ${(error as Error).message}`, "EMANIFEST");
  }
}

/**
 * What a stale lockfile still has to say: every package whose range did not move stays where
 * it is, so an edit to package.json resolves only what it changed. Deleting the lockfile and
 * node_modules is how to resolve everything afresh.
 */
function keep(
  existing: Lockfile | undefined,
  baseFor: BaseFor,
  moved: string[] = [],
): Resolution | undefined {
  const kept = existing && fromLockfile(existing, baseFor);
  // A local tarball whose file changed is read again, and its own ranges resolved again.
  for (const key of moved) delete kept?.packages[key];
  return kept;
}

/** What `open` read, from the root it found first. */
function settings(ctx: Context): Config {
  return (ctx.config ??= readConfig(ctx.root ?? globalThis.process.cwd(), ctx.options));
}

/** The store, downloading with the config's credentials, or never under `offline`. */
function openStore(ctx: Context, verify?: boolean): Store {
  const { auth, offline } = settings(ctx);
  const { store: dir, storeBackend: backend } = ctx.options;
  const backendFailed = (error: unknown) => ctx.log(`store backend: ${describe(error)}`, "warn");
  const { noThreads } = ctx;
  return createStore({ dir, verify, auth, offline, backend, backendFailed, noThreads });
}

/** Where each name's tarball is, for a lockfile that does not say. */
function hostsOf(ctx: Context): BaseFor {
  const { registry, scopes } = settings(ctx);
  return hosts(registry, scopes);
}

/** A broken lockfile does not stop `lock`; writing a good one is the whole job. */
async function currentLock(ctx: Context, dir: string): Promise<Lockfile | undefined> {
  try {
    return await readLockfile(dir);
  } catch (error) {
    ctx.log(`ignoring ${LOCKFILE}: ${describe(error)}`, "warn");
    return undefined;
  }
}

/** Which lockfile the project installs from: `upm.lock`, else the one other manager's. */
interface LockSource {
  path: string;
  /** Set when the file is another manager's, which upm reads and never writes. */
  foreign?: ForeignFile;
  /** Set when there is no lockfile at all: `path` is where `upm.lock` would be. */
  missing?: true;
}

function lockSource(ctx: Context, dir: string): LockSource {
  if (ctx.source) return ctx.source;
  const { existsSync } = builtin.fs;
  const { join } = builtin.path;
  const ours = join(dir, LOCKFILE);
  if (existsSync(ours)) return (ctx.source = { path: ours });
  const found = FOREIGN.filter((file) => existsSync(join(dir, file)));
  // Which one is current is not upm's to guess.
  if (found.length > 1) {
    throw fail(`${found.join(" and ")} both lock ${dir}: delete all but one`, "ELOCK");
  }
  const foreign = found[0];
  return (ctx.source = foreign
    ? { path: join(dir, foreign), foreign }
    : { path: ours, missing: true });
}

/** Another manager's lockfile as upm's, when it still describes package.json. */
async function foreignLock(ctx: Context, project: Project, file: ForeignFile): Promise<Lockfile> {
  const stamp = stampOf(lockSource(ctx, project.dir).path);
  const text = await lockText(ctx, project.dir);
  ctx.read = { text, stamp };
  const { loadForeign } = await import("./foreign-lock.ts");
  const { lock, binless, warnings } = loadForeign(file, text, project, hostsOf(ctx));
  for (const warning of warnings) ctx.log(warning, "warn");
  ctx.binless = binless;
  return lock;
}

function counts(lock: Lockfile): string {
  // Through `fromLockfile`, so `dev` is the derived flag an install would see, not a stored one.
  const all = Object.values(fromLockfile(lock).packages).filter((pkg) => pkg.local === undefined);
  const of = (flag: "optional" | "dev") => all.filter((pkg) => pkg[flag]).length;
  const n = Object.keys(lock.workspaces ?? {}).length;
  const workspaces = n > 0 ? `, ${n} workspace${n === 1 ? "" : "s"}` : "";
  // Every platform's packages, so this is larger than what any one install materializes.
  return `${all.length} packages, ${of("optional")} optional, ${of("dev")} dev${workspaces}`;
}

/** A registry with threads to stop once the resolving is done. */
interface OpenRegistry extends Registry {
  close(): void;
}

/**
 * The registry, read on worker threads unless `resolvePool` says how many or 0. Loaded here
 * and not at the top so that an install with nothing to resolve never has it; its threads
 * start a few questions in. A thread that fails to load is an error when threads were asked
 * for by count, and a `debug` log line otherwise. A pool that cannot load is the plain
 * registry, as with 0.
 */
async function openRegistry(ctx: Context, size = ctx.resolvePool): Promise<OpenRegistry> {
  const { registry, scopes, auth, before, releaseAgeExclude: exclude } = settings(ctx);
  const { offline, preferOffline } = settings(ctx);
  const mode = offline ? "only" : preferOffline ? "prefer" : "revalidate";
  const { createDocumentCache, metadataDir } = await import("./metadata.ts");
  const metadata = { dir: metadataDir(storeDir(ctx.options.store)), mode } as const;
  const loaded = await import("./registry-pool.ts").catch(() => undefined);
  if (!loaded && size !== 0) ctx.noThreads();
  const pool = loaded
    ? loaded.createRegistryPool({
        registry,
        scopes,
        auth,
        before,
        exclude,
        size,
        strict: size !== undefined && size > 0,
        warn: (message) => ctx.log(message, "debug"),
        noThreads: ctx.noThreads,
        metadata,
      })
    : {
        ...createRegistry({
          registry,
          scopes,
          auth,
          before,
          exclude,
          cache: createDocumentCache(metadata),
        }),
        close() {},
      };
  return pool;
}

async function pickAll(ctx: Context, specs: string[]): Promise<Manifest[]> {
  if (specs.length === 0) throw fail("needs at least one spec", "EOPTION");
  // Every spec parsed first, so a bad one fails before any request is left running.
  const parsed = specs.map((raw) => parseSpec(raw));
  const tarball = parsed.find((spec) => spec.type === "tarball");
  if (tarball) throw fail(`${tarball.raw} is a tarball, not a registry spec`, "EINVALIDSPEC");
  // No walk follows these picks, so no threads: each spec is one question, answered here.
  const registry = await openRegistry(ctx, 0);
  return await Promise.all(parsed.map((spec) => pickOne(registry, spec))).finally(registry.close);
}

async function pickOne(registry: Registry, spec: Spec): Promise<Manifest> {
  if (registry.pick) return await registry.pick(spec);
  return pickManifest(await registry.view(spec.fetchName), spec);
}

/**
 * What the resolver reads a tarball dependency with: into the store under its own hash, so the
 * install that follows finds it there, then its package.json out of the store.
 */
function tarballReader(
  ctx: Context,
  dir: string,
  store: Store,
): NonNullable<ResolveOptions["tarball"]> {
  const reads = (ctx.tarballs ??= new Map());
  return (source, pinned) => {
    let hit = reads.get(source);
    if (!hit) {
      const at = tarballOf(dir, source, source);
      // Taken before the read, so a file that changes after it has another stamp next time. Not
      // for a pinned read, which may find the bytes in the store and never open the file.
      const stamp = typeof at === "string" || pinned !== undefined ? undefined : stampOf(at.path);
      hit = import("./tarball-deps.ts").then((m) => m.readTarball(store, at, source, pinned));
      if (stamp)
        hit.then(
          () => (ctx.stamped ??= new Map()).set(source, stamp),
          () => {},
        );
      reads.set(source, hit);
    }
    return hit;
  };
}

/**
 * Where the store reads a package's tarball: a local tarball dependency's root-relative path as
 * a file here, anything else by its url. Only a source is ever a path, never a registry's url.
 */
function tarballOf(dir: string, resolved: string, source?: string): Tarball {
  if (!source?.startsWith("file:")) return resolved;
  return { path: builtin.path.resolve(dir, source.slice("file:".length)) };
}

function fail(message: string, code: ErrorCode): Error {
  return Object.assign(new Error(message), { code });
}

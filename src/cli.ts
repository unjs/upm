// The command line: argv in, the usage text and the flags, one command of `api.ts` run, what it
// returns printed and an exit code out. npm's own commands go to npm. What `upm.ts`, `upx.ts`
// and `./upm` load once the compile cache is on.
import {
  add,
  dedupe,
  exec,
  fetchLockfile,
  fetchPackages,
  install,
  listScripts,
  linkPoolDefaults,
  lock,
  prune,
  remove,
  resolve,
  run,
} from "./api.ts";
import type {
  Fetched,
  InstallResult,
  LinkPoolConfig,
  LogLevel,
  Progress,
  PruneResult,
  RunOptions,
  RunResult,
} from "./api.ts";
import { builtin } from "./builtin.ts";
import { formatLockfile, LOCKFILE } from "./lock.ts";
import type { Bar } from "./progress.ts";
import type { Manifest } from "./types.ts";
import { describe, trace, tracing } from "./util.ts";

/** npm's commands on the registry, the account or package.json, never upm's tree: npm runs them. */
const NPM_COMMANDS = `  access, config, create, deprecate, dist-tag, info, init, login, logout, org, owner,
  pack, ping, pkg, profile, publish, search, show, stage, team, token, trust, undeprecate,
  unpublish, version, view, whoami`;
const NPM = new Set(NPM_COMMANDS.trim().split(/,\s+/));

const USAGE = `upm — a minimal npm-compatible package manager

Usage
  upm install [--production] [--frozen-lockfile] [--verify]    (also i; ci is frozen)
  upm add <spec>... [--dev | --optional] [--exact] [-w <workspace>]
  upm remove <name>... [-w <workspace>]    (also uninstall, rm, r, un)
  upm dedupe
  upm resolve <spec>...
  upm fetch <spec>...
  upm fetch --lock [--production]
  upm lock
  upm prune
  upm run [-w <workspace>... | --workspaces] [--if-present] [<script> [args...]]
                       (also run-script; t and tst are run test)
  upm <script> [args...]
  upm exec [-p <spec>...] <command> [args...]
  upm exec [-p <spec>...] -c '<command line>'    (also upx)
  upm <npm command> [args...]

Options
  -c, --call <line>    exec: run a shell line with -p packages on PATH
  -D, --dev            add: save to devDependencies
  --before <date>      pick only versions published before this date
  --dir <path>         project directory (default: nearest package.json or workspace root)
  -E, --exact          add: save an exact version for names and tags
  --min-release-age <days>
                       pick only versions published at least this long ago (0: off)
  --min-release-age-exclude <name|glob>
                       exempt from the release age (repeatable)
  --frozen-lockfile    install: fail if ${LOCKFILE} is missing or stale
  --if-present         run: skip a missing script, or workspaces missing it
  --include-workspace-root
                       run --workspaces: run the root first
  --json               print JSON
  --lock               fetch: use ${LOCKFILE}
  --no-progress        no progress bar (drawn on a terminal, not in CI, after a second)
  --offline            never use the network; fail if the registry or a download is needed
  --prefer-offline     pick from kept registry documents without checking for newer ones
  -O, --optional       add: save to optionalDependencies
  -p, --package <spec> exec: install a package for the command (repeatable)
  -y, --yes            exec: accepted for npx compatibility; no prompts
  --production         skip dev-only packages
  --registry <url>     override the registry
  -s, --silent         no progress, run banner or install summary (also -q, --loglevel)
  --store <dir>        package store directory
  --verify             install: check sizes, links, bins and peers, not file contents
  -w, --workspace <name|path>
                       add, remove, run: select workspaces (repeatable; parent paths work)
  --workspaces         run: select all workspaces
  -h, --help           show help
  --experimental-link-pool[=<size>[,<packages>[,<files>]]]
                      install: worker count and package/file thresholds (4,200,6000).
                      Size 0 disables; max 64. Thresholds 0,0 always enable.
                      Auto-enabled with spare cores. Also set via UPM_LINK_POOL.

Notes
  lock saves all platforms and dev packages; install selects this platform.
  add (also install <spec>...) and remove edit package.json, then install, keeping other locks.
  add moves groups; remove clears all groups. Explicit ranges stay; names, * and tags
  save ^version unless --exact. dedupe favors locked versions; delete ${LOCKFILE} and
  node_modules for a fresh resolve: install takes back the lockfile node_modules was installed
  from while it matches package.json.
  A url or a path to a .tgz is a tarball dependency, locked by where it is. add reads a
  path from the current directory; alone, it names the tarball by its package.json.
  With no ${LOCKFILE}, install reads package-lock.json, pnpm-lock.yaml or bun.lock and writes
  nothing; add, remove, dedupe and a stale file are refused. Delete it to switch to upm.

  prune removes unused project entries and unindexed content, keeping package indexes
  and files under an hour old. The shared store can grow.
  Config: --registry > npm_config_* > project .npmrc > ~/.npmrc > global npmrc.
  Supports registries, credentials, save-exact, offline, prefer-offline and \${VAR} values.
  Registry documents are kept in the store (metadata/) and revalidated with their ETag.
  New picks skip versions under min-release-age days old (default 1; 0 turns it off),
  or newer than before=<date>; min-release-age-exclude[] names or globs are exempt.

  run installs the tree first (a no-op when it is current), then uses a project shell
  with local/parent bins on PATH; no pre/post scripts.
  Put upm flags before the script; later args pass through (-- optional).
  run alone lists scripts; upm test = upm run test. upm <name> with no such script
  runs an installed bin of that name.
  exec (also upx) uses local bins, else installs into the root's node_modules/.upm/.exec
  (or ~/.upm/exec) with the project registry. Use -p for packages, -c for a shell line.

  npm's spellings work too: --save-dev, --save-optional, --save-exact, --omit=dev
  (--production; --include=dev undoes it), --prefix and -C (--dir). Accepted and ignored,
  as upm already behaves so: -S, --save, -P, --save-prod, --ignore-scripts, --no-audit,
  --no-fund, --legacy-peer-deps and --force.

  Workspaces use package.json patterns. install/lock/dedupe/prune use the root and its .npmrc.
  add/remove target the current workspace or -w. Bare workspace names save ^version;
  workspace: ranges stay as typed. Scripts run dependencies first, continue on failure
  and return the first error code.

Examples
  upm install --production --frozen-lockfile
  upm add --dev vitest typescript@5.9.2
  upm run --dir ./my-project build
  upx -p eslint -p prettier -c 'eslint . && prettier --check .'

Npm
  These commands run via exec with local npm or the latest. Only --dir goes before them.
  pack/publish keep workspace: ranges. ls, outdated and audit are not supported.
${NPM_COMMANDS}`;

export interface Cli {
  command?: string;
  specs: string[];
  json: boolean;
  registry?: string;
  /** `--min-release-age`: days a version must have been published to be picked. */
  minReleaseAge?: number;
  store?: string;
  dir?: string;
  /** Install only what the root's non-dev deps reach. */
  production?: boolean;
  lock?: boolean;
  /** With `install`, never resolve: a stale or missing lockfile is an error. */
  frozen?: boolean;
  /** Check what is on disk instead of trusting the recorded install state. */
  verify?: boolean;
  /** With `add`, the group to save to. Neither means `dependencies`. */
  dev?: boolean;
  optional?: boolean;
  /** With `add`, save a tag as the version it resolved to instead of a caret range. */
  exact?: boolean;
  help: boolean;
  error?: string;
  /** `upm <script>`: `run` was implied, so a missing script is an unknown command. */
  implied?: boolean;
  /** `--experimental-link-pool`: build entries on worker threads. Also `UPM_LINK_POOL`. */
  linkPool?: LinkPoolConfig;
  /** `UPM_RESOLVE_POOL`: threads that read the registry; `off` or 0 reads it here. */
  resolvePool?: number;
  /** `-w`: the workspaces to act on, each a name, a path, or a directory holding some. */
  workspace?: string[];
  /** `--workspaces`: every workspace. */
  workspaces?: boolean;
  /** `--include-workspace-root`: with `run --workspaces`, the root too, first. */
  includeRoot?: boolean;
  /** `--if-present`: with `run`, a workspace without the script is passed over. */
  ifPresent?: boolean;
  /** `-y`: with `exec`, npx's answer to a prompt upm never shows. */
  yes?: boolean;
  /** `-c`: with `exec`, a shell line to run instead of a command. */
  call?: string;
  /** `-p`: with `exec`, the packages to install for the command. */
  packages?: string[];
  /** `--before`: pick only versions published before this date. */
  before?: string;
  /** `--min-release-age-exclude`: names or globs the release age never holds back. */
  minReleaseAgeExclude?: string[];
  /** `-s`, `-q` or a low `--loglevel`: no progress notes, run banner or install summary. */
  quiet?: boolean;
  /** `--no-progress`: no progress bar, even on a terminal. */
  noProgress?: boolean;
  /** `--offline`: never ask the registry or download a tarball. */
  offline?: boolean;
  /** `--prefer-offline`: pick from kept registry documents without revalidating them. */
  preferOffline?: boolean;
}

/** `resolvePool` left to the pool to size by the cores; the user did not ask for a count. */
const RESOLVE_POOL_DEFAULT = -1;

const COMMANDS = new Set([
  "install",
  "add",
  "remove",
  "dedupe",
  "resolve",
  "fetch",
  "lock",
  "prune",
  "run",
  "exec",
]);
/** The commands that end in an install, and so take its flags. */
const INSTALLS = new Set(["install", "add", "remove", "dedupe"]);
/** The commands `-w` narrows. An install is the whole tree: its state describes one tree. */
const SCOPED = new Set(["add", "remove", "run"]);
/** npm's names for upm's commands: `upm i` is `upm install`, `upm ci` a frozen one. */
const ALIASES: Record<string, string> = {
  i: "install",
  ci: "install",
  "clean-install": "install",
  uninstall: "remove",
  rm: "remove",
  r: "remove",
  un: "remove",
  "run-script": "run",
};
/** npm's short names for `run test`. */
const TEST = new Set(["t", "tst"]);
const VALUE_FLAGS = {
  "--registry": "registry",
  "--store": "store",
  "--dir": "dir",
  "--prefix": "dir",
  "-C": "dir",
} as const;
/**
 * npm's flags for what upm already does, or never does: no dependency lifecycle scripts, no
 * audit or funding notes, no peer conflicts that fail an install.
 */
const NPM_NOOPS = new Set([
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--legacy-peer-deps",
  "--force",
  "-S",
  "--save",
  "-P",
  "--save-prod",
]);
/** Flags that turn one field on. */
const SWITCHES = {
  "-s": "quiet",
  "--silent": "quiet",
  "-q": "quiet",
  "--quiet": "quiet",
  "--no-progress": "noProgress",
  "-y": "yes",
  "--yes": "yes",
  "--workspaces": "workspaces",
  "--include-workspace-root": "includeRoot",
  "--if-present": "ifPresent",
  "-h": "help",
  "--help": "help",
  "--json": "json",
  "--production": "production",
  "--lock": "lock",
  "--offline": "offline",
  "--prefer-offline": "preferOffline",
  "--frozen-lockfile": "frozen",
  "--verify": "verify",
  "--dev": "dev",
  "-D": "dev",
  "--save-dev": "dev",
  "--optional": "optional",
  "-O": "optional",
  "--save-optional": "optional",
  "--exact": "exact",
  "-E": "exact",
  "--save-exact": "exact",
} as const;
/** npm's log levels. The first three leave only warnings and errors. */
const LOG_LEVELS = ["silent", "error", "warn", "notice", "http", "info", "verbose", "silly"];

export function parseArgv(argv: string[]): Cli {
  const cli: Cli = { specs: [], json: false, help: false };
  // Once `run` has its script name, the rest belongs to the script. A first `--` is npm's
  // way of saying so and is dropped; a later one is the script's. What follows `exec`'s
  // command is the command's, `--` and all, and so is everything after one of npm's.
  let rest = false;
  // `--` ends upm's own flags, so a script named `-x` is reachable: `upm run -- -x`.
  let flags = true;
  let includeDev = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (rest || (cli.command !== undefined && NPM.has(cli.command))) {
      cli.specs.push(arg);
      continue;
    }
    if ((cli.command === "run" || cli.command === "exec") && cli.specs.length === 1) {
      rest = true;
      if (arg !== "--" || cli.command === "exec") cli.specs.push(arg);
      continue;
    }
    if (flags && arg === "--") {
      flags = false;
      continue;
    }
    if (!flags) {
      positional(cli, arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    // A value flag's value: after its `=`, or the next argument.
    const next = () => (eq === -1 ? argv[++i] : arg.slice(eq + 1));
    // `hasOwn`, or a package named `constructor` reads as a flag that takes a value.
    const key = Object.hasOwn(VALUE_FLAGS, flag)
      ? VALUE_FLAGS[flag as keyof typeof VALUE_FLAGS]
      : undefined;
    if (key) {
      const value = next();
      if (value === undefined) return { ...cli, error: `${flag} needs a value` };
      cli[key] = value;
    } else if (flag === "-w" || flag === "--workspace") {
      const value = next();
      if (value === undefined) return { ...cli, error: `${flag} needs a value` };
      (cli.workspace ??= []).push(value);
    } else if (flag === "-c" || flag === "--call") {
      const value = next();
      if (value === undefined) return { ...cli, error: `${flag} needs a value` };
      cli.call = value;
    } else if (flag === "--before") {
      const value = next();
      if (!value || Number.isNaN(Date.parse(value)))
        return { ...cli, error: `${flag} takes a date` };
      cli.before = value;
    } else if (flag === "--min-release-age-exclude") {
      const value = next();
      if (value === undefined) return { ...cli, error: `${flag} needs a value` };
      (cli.minReleaseAgeExclude ??= []).push(value);
    } else if (flag === "--omit" || flag === "--include") {
      const value = next();
      if (flag === "--include" && ["dev", "prod", "optional", "peer"].includes(value!)) {
        // npm: an include beats an omit, whatever the order.
        if (value === "dev") includeDev = true;
      } else if (flag === "--omit" && value === "dev") {
        cli.production = true;
      } else {
        const takes = flag === "--omit" ? "dev" : "dev, prod, optional or peer";
        return { ...cli, error: `${flag} takes ${takes}` };
      }
    } else if (flag === "--loglevel") {
      const value = next();
      const level = LOG_LEVELS.indexOf(value!);
      if (level === -1) return { ...cli, error: `${flag} takes ${LOG_LEVELS.join(", ")}` };
      if (level < 3) cli.quiet = true;
    } else if (NPM_NOOPS.has(arg)) {
      // Accepted so npm's command lines run unchanged.
    } else if (flag === "--min-release-age") {
      const value = next();
      const days = value?.trim() ? Number(value) : Number.NaN;
      if (!(days >= 0)) return { ...cli, error: `${flag} takes a number of days` };
      cli.minReleaseAge = days;
    } else if (flag === "-p" || flag === "--package") {
      const value = next();
      if (value === undefined) return { ...cli, error: `${flag} needs a value` };
      (cli.packages ??= []).push(value);
    } else if (Object.hasOwn(SWITCHES, arg)) {
      cli[SWITCHES[arg as keyof typeof SWITCHES]] = true;
    } else if (flag === "--experimental-link-pool") {
      const pool = parseLinkPool(eq === -1 ? "" : arg.slice(eq + 1));
      if (!pool) return { ...cli, error: `${flag} takes ${POOL_FORM}` };
      cli.linkPool = pool;
    } else if (arg.startsWith("-")) {
      return { ...cli, error: `unknown flag "${arg}"` };
    } else {
      positional(cli, arg);
    }
  }
  if (includeDev) delete cli.production;
  return cli;
}

const POOL_FORM = "off, on or <size>[,<packages>[,<files>]] with a size up to 64";

/** `""` and `"on"` mean the defaults; `"off"` and `"0"` mean no pool. */
export function parseLinkPool(text: string): LinkPoolConfig | undefined {
  const defaults = linkPoolDefaults();
  if (text === "" || text === "on") return defaults;
  if (text === "off") return { ...defaults, size: 0 };
  const parts = text.split(",");
  // Digits only: `Number("")` is 0, so `4,,` would silently force the pool on.
  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const [size, packages, files] = parts.map(Number);
  if (size! > 64) return undefined;
  return {
    size: size!,
    packages: packages ?? defaults.packages,
    files: files ?? defaults.files,
  };
}

/** `""` and `"on"` mean the default; `"off"` and `"0"` mean this thread. Digits only, as above. */
export function parseResolvePool(text: string): number | undefined {
  if (text === "" || text === "on") return RESOLVE_POOL_DEFAULT;
  if (text === "off") return 0;
  if (!/^\d+$/.test(text) || Number(text) > 16) return undefined;
  return Number(text);
}

/** The first word is the command — or, as in pnpm, a script: `upm test` is `run test`. */
function positional(cli: Cli, arg: string): void {
  if (cli.command !== undefined) {
    cli.specs.push(arg);
  } else if (Object.hasOwn(ALIASES, arg)) {
    cli.command = ALIASES[arg];
    if (arg === "ci" || arg === "clean-install") cli.frozen = true;
  } else if (TEST.has(arg)) {
    cli.command = "run";
    cli.specs.push("test");
  } else if (COMMANDS.has(arg) || NPM.has(arg)) {
    cli.command = arg;
  } else {
    cli.command = "run";
    cli.implied = true;
    cli.specs.push(arg);
  }
}

export async function main(argv: string[]): Promise<number> {
  // `upm lock --json | head` closes the pipe while the write is still going. A reader that
  // left is not a failure; a redirect that ran out of disk is, and must not look like success.
  globalThis.process?.stdout?.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") return;
    fail(describe(error));
    if (globalThis.process) globalThis.process.exitCode = 1;
  });
  trace("stdout");

  const cli = parseArgv(argv);
  trace("argv");
  if (cli.error) return usage(cli.error);
  quiet = cli.quiet === true;
  if (cli.help || cli.command === undefined) {
    write("stdout", `${help("stdout")}\n`);
    return 0;
  }
  if (NPM.has(cli.command)) {
    const { command, specs, json, help: _help, dir: _dir, ...own } = cli;
    if (json || Object.keys(own).length > 0) return usage(`only --dir goes before ${command}`);
    // Or npm's version and init, run in a workspace, install the whole tree its own way.
    if (globalThis.process?.env) globalThis.process.env.npm_config_workspaces_update = "false";
    cli.specs = ["npm", command, ...specs];
    cli.command = "exec";
  }
  // `install <spec>` is npm's add, so it is upm's too.
  if (cli.command === "install" && cli.specs.length > 0) cli.command = "add";
  const installs = INSTALLS.has(cli.command);
  // `install`, `lock` and `fetch --lock` read package.json instead, so only the others take specs.
  const fromProject =
    cli.command === "lock" ||
    cli.command === "install" ||
    cli.command === "dedupe" ||
    cli.command === "prune" ||
    cli.lock === true;
  if (cli.command === "exec" && cli.call === undefined && cli.specs.length === 0) {
    return usage("exec needs a command or --call");
  }
  if (cli.call !== undefined && cli.specs.length > 0) {
    return usage("--call is the whole command line: give no command or args with it");
  }
  if ((cli.packages || cli.yes || cli.call !== undefined) && cli.command !== "exec") {
    return usage("--package, --call and --yes only apply to exec");
  }
  if (cli.json && cli.command === "exec") return usage("--json does not apply to exec");
  // `run` without a name lists the scripts.
  if (!fromProject && cli.command !== "run" && cli.command !== "exec" && cli.specs.length === 0) {
    return usage(`${cli.command} needs at least one ${cli.command === "remove" ? "name" : "spec"}`);
  }
  if (fromProject && cli.lock !== true && cli.specs.length > 0) {
    return usage(`${cli.command} reads package.json and takes no package names`);
  }
  if (cli.production && !installs && !(cli.command === "fetch" && cli.lock)) {
    return usage("--production only applies to install and fetch --lock");
  }
  // add and remove change package.json, and dedupe the lockfile, so all three must resolve.
  if (cli.frozen && cli.command !== "install") {
    return usage("--frozen-lockfile only applies to install, without package names");
  }
  if (cli.verify && !installs) {
    return usage("--verify only applies to install");
  }
  if (cli.linkPool && !installs) {
    return usage("--experimental-link-pool only applies to install");
  }
  // The environment stands in for the flag, and is held to the same form: a misspelling must
  // not silently turn the pool off.
  const env = globalThis.process?.env?.UPM_LINK_POOL;
  if ((installs || cli.command === "exec") && !cli.linkPool && env !== undefined) {
    cli.linkPool = parseLinkPool(env);
    if (!cli.linkPool) return usage(`UPM_LINK_POOL takes ${POOL_FORM}`);
  }
  // Read only where a registry is read, and held to one form, like UPM_LINK_POOL above.
  const threads = globalThis.process?.env?.UPM_RESOLVE_POOL;
  const resolves = installs || cli.command === "lock" || (!fromProject && cli.command !== "run");
  if (resolves && threads !== undefined) {
    cli.resolvePool = parseResolvePool(threads);
    if (cli.resolvePool === undefined)
      return usage("UPM_RESOLVE_POOL takes off or a count up to 16");
  }
  if ((cli.dev || cli.optional || cli.exact) && cli.command !== "add") {
    return usage("--dev, --optional and --exact only apply to add");
  }
  if (cli.dev && cli.optional) return usage("--dev and --optional are exclusive");
  if (cli.dev && cli.production) return usage("--production skips what --dev adds");
  if (cli.lock && cli.command !== "fetch") return usage("--lock only applies to fetch");
  const selects = cli.workspace !== undefined || cli.workspaces === true;
  if (selects && !SCOPED.has(cli.command)) {
    return usage(
      "-w and --workspaces only apply to add, remove and run: install is always the whole tree",
    );
  }
  if (cli.workspace && cli.workspaces) return usage("-w and --workspaces are exclusive");
  if (cli.ifPresent && cli.command !== "run") return usage("--if-present only applies to run");
  if (cli.includeRoot && !(cli.command === "run" && selects)) {
    return usage("--include-workspace-root only applies to run -w or --workspaces");
  }

  try {
    // The script's exit code is the answer, so this one does not go through `dispatch`.
    if (cli.command === "run") return await runCommand(cli);
    if (cli.command === "exec") return await execCommand(cli);
    const out = await dispatch(cli, fromProject).finally(() => {
      bar?.stop();
      bar = undefined;
    });
    trace("formatted");
    // Quiet drops an install's summary, not what a command is asked to print.
    const summary = !cli.json && (installs || cli.command === "prune" || cli.command === "fetch");
    if (out && !(quiet && summary)) write("stdout", `${out}\n`);
    return 0;
  } catch (error) {
    fail(describe(error));
    return 1;
  }
}

async function dispatch(cli: Cli, fromProject: boolean): Promise<string> {
  const base = {
    dir: cli.dir,
    registry: cli.registry,
    minReleaseAge: cli.minReleaseAge,
    before: cli.before,
    minReleaseAgeExclude: cli.minReleaseAgeExclude,
    offline: cli.offline,
    preferOffline: cli.preferOffline,
    log: note,
  };
  const store = { ...base, store: cli.store };
  const resolvePool = cli.resolvePool === RESOLVE_POOL_DEFAULT ? undefined : cli.resolvePool;
  const onProgress =
    INSTALLS.has(cli.command!) || cli.command === "lock" ? await progress(cli) : undefined;
  const installs = {
    ...store,
    production: cli.production,
    verify: cli.verify,
    onProgress,
    experimental: { resolvePool, linkPool: cli.linkPool },
  };
  const workspaces = cli.workspaces ? ("all" as const) : cli.workspace;
  const started = Date.now();
  if (cli.command === "install") {
    return installed(cli, await install({ ...installs, frozen: cli.frozen }), started);
  }
  if (cli.command === "dedupe") return installed(cli, await dedupe(installs), started);
  if (cli.command === "add") {
    const group = cli.dev ? "devDependencies" : cli.optional ? "optionalDependencies" : undefined;
    const options = { ...installs, workspaces, group, exact: cli.exact } as const;
    const { added, ...result } = await add(cli.specs, options);
    return installed(cli, result, started, { manifest: { added } });
  }
  if (cli.command === "remove") {
    const { removed, ...result } = await remove(cli.specs, { ...installs, workspaces });
    return installed(cli, result, started, { manifest: { removed } });
  }
  if (cli.command === "lock") {
    const options = { ...store, write: !cli.json, onProgress, experimental: { resolvePool } };
    const locked = await lock(options);
    return cli.json ? formatLockfile(locked).trimEnd() : "";
  }
  if (cli.command === "prune") return pruned(cli, await prune(store));
  if (fromProject) {
    return fetchedLock(cli, await fetchLockfile({ ...store, production: cli.production }));
  }
  // Always an array, so piping into jq does not depend on the spec count.
  if (cli.command === "resolve") return report(await resolve(cli.specs, base), cli.json);
  return fetched(cli, await fetchPackages(cli.specs, store));
}

/** What an install did, as one line or as JSON with `changes` (the package.json edit) first. */
function installed(
  cli: Cli,
  result: InstallResult,
  started: number,
  changes?: Record<string, unknown>,
): string {
  const ms = Date.now() - started;
  const seconds = (ms / 1000).toFixed(2);
  const { packages, workspaces, otherPlatforms, upToDate, missingOptional, stats } = result;
  if (cli.json) {
    const out = { ...changes, packages, workspaces, otherPlatforms, ...stats };
    return JSON.stringify({ ...out, dropped: missingOptional, upToDate, seconds }, undefined, 2);
  }
  for (const id of missingOptional) note(`${id} is missing from the store and was not linked`);
  // Shown so the count does not seem to disagree with the lockfile.
  const others = otherPlatforms > 0 ? ` (+${otherPlatforms} skipped)` : "";
  const time = ` in ${ms < 1000 ? `${ms}ms` : `${seconds}s`}`;
  const plural = workspaces > 0 ? `, ${workspaces} workspace${workspaces === 1 ? "" : "s"}` : "";
  const count = `${packages} packages${plural}`;
  const gray = (text: string) => paint("gray", text, "stdout");
  if (upToDate)
    return `${count}${gray(others)} ${paint("green", "up to date", "stdout")}${gray(time)}`;
  let detail = `${others}, ${stats.entries} entries (${stats.reused} reused), ${stats.linked} linked, ${stats.copied} copied, ${stats.bins} bins`;
  if (stats.removed > 0) detail += `, ${stats.removed} removed`;
  if (stats.repaired > 0) detail += `, ${stats.repaired} repaired`;
  return `${paint("green", "Installed", "stdout")} ${count}${gray(detail + time)}`;
}

function pruned(cli: Cli, { entries, content }: PruneResult): string {
  const { files, packages, bytes } = content;
  if (cli.json) {
    return JSON.stringify(
      { entries, content: { blobs: files, indexes: packages, bytes } },
      undefined,
      2,
    );
  }
  const swept = entries
    ? `${entries.removed} entries (${mib(entries.bytes)})`
    : "no install state, kept every entry";
  return `${swept}  ${files} files, ${packages} indexes (${mib(bytes)})`;
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * One script from package.json, or the list of them. Exits the way the script did. Without
 * `-w` that is cwd's own package.json, root or workspace; with it, each workspace named.
 */
async function runCommand(cli: Cli): Promise<number> {
  const [name, ...args] = cli.specs;
  const selects = cli.workspace !== undefined || cli.workspaces === true;
  const options: RunOptions = {
    dir: cli.dir,
    workspaces: cli.workspaces ? "all" : cli.workspace,
    includeRoot: cli.includeRoot,
    ifPresent: cli.ifPresent,
    log: note,
    // What runs, on stderr, so the script's own stdout is all there is to pipe.
    onScript: ({ script, line, workspace }) => {
      if (quiet) return;
      const at = workspace === undefined ? "" : `${workspace}: `;
      write("stderr", `${paint("gray", `> ${at}${script}\n> ${line}`)}\n`);
    },
  };
  if (name === undefined) {
    const lists = await listScripts(options);
    if (!selects) {
      const { file, scripts } = lists[0]!;
      if (cli.json) print(scripts);
      else if (Object.keys(scripts).length === 0) note(`no scripts in ${file}`);
      else write("stdout", list(scripts));
    } else if (cli.json) {
      print(Object.fromEntries(lists.map((top) => [top.name, top.scripts])));
    } else {
      for (const top of lists) {
        write("stdout", `${top.name}\n${list(top.scripts, "  ")}`);
      }
    }
    return 0;
  }
  let result: RunResult;
  try {
    result = await run(name, {
      ...options,
      args,
      install: true,
      registry: cli.registry,
      minReleaseAge: cli.minReleaseAge,
      before: cli.before,
      minReleaseAgeExclude: cli.minReleaseAgeExclude,
      offline: cli.offline,
      preferOffline: cli.preferOffline,
      store: cli.store,
    });
  } catch (error) {
    // No package.json to find a script in, so `upm nope` is a typo in the command. A
    // package.json that is there but broken is still the news, and so is a --dir that is not.
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cli.implied && !selects && cli.dir === undefined && cause?.code === "ENOENT") {
      return (await installedBin(cli, name, args)) ?? usage(`unknown command "${name}"`);
    }
    throw error;
  }
  const own = result.results[0];
  if (selects || cli.ifPresent || !own?.missing) return result.code;
  const names = Object.keys((await listScripts({ dir: cli.dir }))[0]!.scripts);
  const have = names.length > 0 ? ` — the scripts are ${names.join(", ")}` : "";
  if (cli.implied) {
    const code = await installedBin(cli, name, args);
    if (code !== undefined) return code;
    return usage(`unknown command "${name}", and no such script in ${own.file}${have}`);
  }
  fail(`missing script "${name}" in ${own.file}${have} (ENOSCRIPT)`);
  return 1;
}

/**
 * `upm vitest` with no such script: a bin already in a `node_modules/.bin` above, as pnpm
 * runs one. Never the registry, so a typo stays an unknown command.
 */
async function installedBin(cli: Cli, name: string, args: string[]): Promise<number | undefined> {
  const { localBin, selfBin } = await import("./exec.ts");
  const dir = builtin.path.resolve(cli.dir ?? globalThis.process.cwd());
  if (!((await selfBin(dir, name)) ?? (await localBin(dir, name)))) return undefined;
  return await execCommand({ ...cli, specs: [name, ...args] });
}

async function execCommand(cli: Cli): Promise<number> {
  const [command = cli.call!, ...args] = cli.specs;
  const resolvePool = cli.resolvePool === RESOLVE_POOL_DEFAULT ? undefined : cli.resolvePool;
  const { code } = await exec(command!, {
    dir: cli.dir,
    registry: cli.registry,
    minReleaseAge: cli.minReleaseAge,
    before: cli.before,
    minReleaseAgeExclude: cli.minReleaseAgeExclude,
    offline: cli.offline,
    preferOffline: cli.preferOffline,
    store: cli.store,
    packages: cli.packages,
    call: cli.call !== undefined,
    args,
    log: note,
    experimental: { resolvePool, linkPool: cli.linkPool },
  });
  return code;
}

function print(value: unknown): void {
  write("stdout", `${JSON.stringify(value, undefined, 2)}\n`);
}

/** The scripts, one per line with its command under it. */
function list(scripts: Record<string, string>, indent = ""): string {
  return Object.keys(scripts)
    .map(
      (n) =>
        `${indent}${paint("cyan", n, "stdout")}\n${indent}  ${paint("gray", scripts[n]!, "stdout")}\n`,
    )
    .join("");
}

function fetchedLock(cli: Cli, added: Fetched[]): string {
  if (cli.json) return JSON.stringify(added, undefined, 2);
  const cached = added.filter((result) => result.cached).length;
  const files = added.reduce((total, result) => total + result.files, 0);
  const bytes = added.reduce((total, result) => total + result.bytes, 0);
  return `${added.length} packages  ${files} files  ${size(bytes)}  ${cached} cache hits, ${added.length - cached} downloaded`;
}

function fetched(cli: Cli, added: Fetched[]): string {
  if (cli.json) return JSON.stringify(added, undefined, 2);
  return added
    .map(({ name, version, files, bytes, cached }) => {
      const state = cached ? "cache hit" : "downloaded";
      return `${name}@${version}  ${files} files  ${size(bytes)}  ${state}`;
    })
    .join("\n");
}

function report(picked: Manifest[], json: boolean): string {
  return json
    ? JSON.stringify(picked, undefined, 2)
    : picked.map((manifest) => format(manifest)).join("\n");
}

function size(bytes: number): string {
  const kb = bytes / 1000;
  return kb < 1000 ? `${kb.toFixed(1)} kB` : `${(kb / 1000).toFixed(1)} MB`;
}

/** `UPM_DEBUG`: one form, like every other switch here; `UPM_DEBUG=0` is not "on". */
const DEBUG = new Set(["1", "on"]);

/** `-s`, `-q` or a low `--loglevel`: `note` keeps only warnings. */
let quiet = false;

/** Summaries go to stderr, so `--json` keeps stdout clean. `debug` only under `UPM_DEBUG`. */
function note(message: string, level: LogLevel = "info"): void {
  if (quiet && level === "info") return;
  if (level === "debug") {
    if (!DEBUG.has(globalThis.process?.env?.UPM_DEBUG ?? "")) return;
    write("stderr", `${paint("gray", `upm: ${message}`)}\n`);
  } else if (level === "warn") {
    write("stderr", `${paint("yellow", "upm:")} ${paint("yellow", message)}\n`);
  } else {
    write("stderr", `${paint("gray", "upm:")} ${message}\n`);
  }
}

function fail(message: string): void {
  write("stderr", `${paint(["red", "bold"], "upm:")} ${paint("red", message)}\n`);
}

function usage(message: string): number {
  fail(message);
  write("stderr", `\n${help("stderr")}\n`);
  return 2;
}

/** The usage text with its section headings in bold. */
function help(to: Output): string {
  return USAGE.replace(/^[A-Z][a-z]+$/gm, (heading) => paint("bold", heading, to));
}

type Style = Parameters<typeof import("node:util").styleText>[0];
type Output = "stdout" | "stderr";

/** The progress line on stderr, while a command draws one. */
let bar: Bar | undefined;

/** `onProgress` for a progress line on a terminal, unless `--silent` or `--no-progress`. */
async function progress(cli: Cli): Promise<((progress: Progress) => void) | undefined> {
  const stderr = globalThis.process?.stderr;
  if (quiet || cli.noProgress || !stderr?.isTTY) return;
  const { startBar } = await import("./progress.ts");
  bar = startBar(stderr, (text) => paint("gray", text));
  return bar?.hear;
}

/** Where there is no `process`, as in a browser, the console stands in for both streams. */
function write(to: Output, text: string): void {
  // Cleared first, so a note is not written over it; the next tick draws it under the note.
  bar?.clear();
  const stream = globalThis.process?.[to];
  if (stream) stream.write(text);
  else (to === "stdout" ? console.log : console.error)(text.replace(/\n$/, ""));
}

/** `node:util`'s `styleText`, found on first use; `undefined` where there is none. */
let styleText: typeof import("node:util").styleText | undefined | null = null;

/**
 * `styleText` checks the stream: plain text unless it is a terminal that takes color, and
 * NO_COLOR or FORCE_COLOR decide over that. Without `node:util` or the stream, text stays plain.
 */
function paint(style: Style, text: string, to: Output = "stderr"): string {
  if (styleText === null) {
    try {
      styleText = builtin.util.styleText;
    } catch {
      styleText = undefined;
    }
  }
  const stream = globalThis.process?.[to];
  return styleText && stream ? styleText(style, text, { stream }) : text;
}

function format(manifest: Manifest): string {
  const { dist } = manifest;
  const parts = [`${manifest.name}@${manifest.version}`, dist.tarball, digest(dist)];
  const line = parts.filter(Boolean).join("  ");
  if (!manifest.deprecated) return line;
  const warning = `! deprecated: ${manifest.deprecated}`;
  return `${line}\n  ${paint("yellow", warning, "stdout")}`;
}

function digest(dist: Manifest["dist"]): string {
  const value = dist.integrity ?? (dist.shasum && `sha1-${dist.shasum}`) ?? "";
  return value.length > 24 ? `${value.slice(0, 24)}…` : value;
}

/** What the `upm` bin runs: `main` over the process's arguments, its code as the exit code. */
export async function start(argv: string[], bin?: number[]): Promise<void> {
  if (tracing) {
    const { stamp } = await import("./trace.ts");
    if (bin) {
      stamp("bin", bin[0]!);
      stamp("cache", bin[1]!);
    }
  }
  trace("cli");
  const code = await main(argv);
  trace("main");
  if (globalThis.process) exit(code);
}

/**
 * Exit once the output is out (the empty writes call back after it), rather than let Node take
 * the environment apart object by object: 5 ms of a cold teardown, and nothing waits on what
 * is left — a prefetched tarball the tree dropped, at most. A turn later and with no code of
 * its own, so a write that failed (`> /dev/full`) still reports and sets the exit code first.
 */
function exit(code: number): void {
  const { stdout, stderr } = globalThis.process!;
  globalThis.process!.exitCode = code;
  stdout.write("", () => stderr.write("", () => setImmediate(() => globalThis.process!.exit())));
}

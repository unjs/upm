// `upm exec`'s lookups: which installed bin a command means, which bin a package runs, and
// where a package installs; and `resolvex`'s: which import it takes and how it resolves it.
// Its own module, loaded by `exec` and `resolvex` alone: no other command pays for it at startup.
import { normalizeBin } from "./normalize-bin.ts";
import { builtin } from "./builtin.ts";
import { binDirs } from "./run.ts";
import { satisfies } from "./semver.ts";
import { parseSpec } from "./spec.ts";
import type { Spec } from "./spec.ts";

/**
 * Where exec installs for the project at `root`: its `node_modules/.upm/.exec`, so the packages
 * go with that tree and can import what the project installed, or `~/.upm/exec` when it has none.
 */
export function execHome(root: string): string {
  const { join } = builtin.path;
  const tree = builtin.fs.statSync(join(root, "node_modules"), { throwIfNoEntry: false });
  if (tree?.isDirectory() && builtin.fs.existsSync(join(root, "package.json"))) {
    // Dotted: the sweep of `.upm` entries leaves it alone.
    return join(root, "node_modules", ".upm", ".exec");
  }
  return join(builtin.os.homedir(), ".upm", "exec");
}

/**
 * The command as a bin of the nearest package.json above `dir`: what `npx my-cli` means inside
 * my-cli. Nothing links a project's own bins, so a file without an executable bit runs in node.
 */
export async function selfBin(dir: string, command: string): Promise<string[] | undefined> {
  const { dirname, join } = builtin.path;
  for (let at = dir; ; at = dirname(at)) {
    const file = join(at, "package.json");
    if (await isFile(file)) {
      const bins = normalizeBin((await readJson(file).catch(() => undefined)) ?? {});
      if (!Object.hasOwn(bins, command)) return undefined;
      const target = join(at, bins[command]!);
      const { mode } = await builtin.fsp.stat(target);
      const runs = globalThis.process.platform !== "win32" && (mode & 0o111) !== 0;
      return runs ? [target] : [globalThis.process.execPath, target];
    }
    if (dirname(at) === at) return undefined;
  }
}

/**
 * The bin the command runs where it is installed, nearest first: a bin of that name, or the bin
 * of the package the spec names, where that bin is linked. As npm: a bare name takes what is
 * there, a version or range what fits, and a tag always asks the registry. As a path, so a
 * nearer bin of the same name from another package is not the one that runs.
 */
export async function localBin(dir: string, command: string): Promise<string[] | undefined> {
  const { dirname, join } = builtin.path;
  // A bin name is one path segment.
  const bin = /^[^\\/]+$/.test(command) && command !== "." && command !== "..";
  let spec: Spec | undefined;
  try {
    spec = parseSpec(command);
  } catch {} // not a package, and install will say so
  // On Windows a bin is its shims, and the `.cmd` one is what cmd runs.
  const win = globalThis.process.platform === "win32";
  for (const bins of binDirs(dir)) {
    const shim = (name: string) => join(bins, win ? `${name}.cmd` : name);
    if (bin && (await isFile(shim(command)))) return [shim(command)];
    if (spec === undefined) continue;
    const pkg = await readJson(join(dirname(bins), spec.name, "package.json")).catch(
      () => undefined,
    );
    if (!pkg || !fits(spec, (pkg as { version?: unknown }).version)) continue;
    let own: string;
    try {
      own = pickBin(pkg, spec.name);
    } catch {
      continue; // a library of that name, or one with no clear bin: look further up
    }
    if (await isFile(shim(own))) return [shim(own)];
  }
  return undefined;
}

/** As npm: a bare name takes what is installed, a version or range what fits, a tag nothing. */
function fits(spec: Spec, version: unknown): boolean {
  if (spec.raw === spec.name) return true;
  if (typeof version !== "string") return false;
  const ranged = spec.type === "version" || spec.type === "range";
  return ranged && spec.name === spec.fetchName && satisfies(version, spec.fetchSpec);
}

/**
 * `[npm:]name[@version][/subpath]` as the registry spec to install and the subpath to import.
 * Anything else is refused, `jsr:` and other schemes, paths, git, tarballs and aliases among them.
 */
export function parseImport(specifier: string): { spec: Spec; subpath: string } {
  const raw = specifier.startsWith("npm:") ? specifier.slice(4) : specifier;
  // The name is one segment, or two under a scope.
  const end = raw.indexOf("/", raw.startsWith("@") ? raw.indexOf("/") + 1 : 0);
  let spec: Spec | undefined;
  if (!/^[a-z][\w+.-]*:|^[./\\]/i.test(raw)) {
    try {
      spec = parseSpec(end < 0 ? raw : raw.slice(0, end));
    } catch {} // refused below, with the form it takes
  }
  // A tag never starts as a path does, but `pkg@./x.tgz` cut at its first `/` would be one.
  const path = spec?.type === "tag" && /^[.~]/.test(spec.fetchSpec);
  const registry = spec && !path && ["version", "range", "tag"].includes(spec.type);
  if (!registry || spec!.name !== spec!.fetchName) {
    const message = `${specifier} is not a package as [npm:]name[@version][/subpath]`;
    throw Object.assign(new Error(message), { code: "EINVALIDSPEC" });
  }
  return { spec: spec!, subpath: end < 0 ? "" : raw.slice(end) };
}

/**
 * The directory an import is resolved from: `from` as a directory, or a module's path or
 * `file://` url, else `dir`.
 */
export function startDir(from: string | URL | undefined, dir: string): string {
  const { path } = builtin;
  if (from === undefined) return path.resolve(dir);
  const file = typeof from === "string" && !from.startsWith("file:");
  const at = file ? path.resolve(from) : builtin.url.fileURLToPath(from);
  return builtin.fs.statSync(at, { throwIfNoEntry: false })?.isFile() ? path.dirname(at) : at;
}

/**
 * Whether an import from `dir` finds the spec's package in a version it takes. Node takes the
 * nearest `node_modules` directory of the name, whatever is in it, so only that one is asked.
 */
export async function hasPackage(dir: string, spec: Spec): Promise<boolean> {
  const { dirname, join } = builtin.path;
  for (let at = dir; ; at = dirname(at)) {
    const home = join(at, "node_modules", spec.name);
    if (builtin.fs.existsSync(home)) {
      const pkg = await readJson(join(home, "package.json")).catch(() => undefined);
      return pkg !== undefined && fits(spec, (pkg as { version?: unknown }).version);
    }
    if (dirname(at) === at) return false;
  }
}

type Resolve = (id: string, dir: string) => string;
let resolveIn: Resolve | undefined;

/**
 * How this runtime resolves `id` as an import from a module in `dir`, found and tried before
 * anything is installed: Node.js 22.15+ through a resolve hook, Bun with its own resolver.
 */
export async function resolver(): Promise<Resolve> {
  if (resolveIn) return resolveIn;
  const unsupported = () =>
    Object.assign(new Error("resolvex and importx need Node.js 22.15+ or Bun"), {
      code: "ENOBUILTIN",
    });
  const bun = (globalThis as { Bun?: { resolveSync(id: string, dir: string): string } }).Bun;
  const { registerHooks } = builtin.module;
  let found: Resolve;
  if (bun) {
    found = (id, dir) => builtin.url.pathToFileURL(bun.resolveSync(id, dir)).href;
  } else if (typeof registerHooks === "function") {
    // A module of its own: an app that bundles upm to CommonJS leaves upm no `import.meta`. Its
    // url is no literal, or a bundler would make it a chunk with `import.meta` in it again.
    const code = "export default (id) => import.meta.resolve(id)";
    const helper = new URL(`data:text/javascript,${code}`).href;
    const resolve: (id: string) => string = (await import(helper)).default;
    found = (id, dir) => {
      // A name of our own for the hook to point at `id`, new each time: node keeps what a
      // name resolved to.
      const name = `upm-resolvex:${globalThis.crypto.randomUUID()}`;
      const parentURL = builtin.url.pathToFileURL(`${dir}${builtin.path.sep}`).href;
      let hooked = false;
      const hooks = registerHooks({
        resolve: (specifier, context, next) => {
          if (specifier !== name) return next(specifier, context);
          hooked = true;
          return next(id, { ...context, parentURL });
        },
      });
      try {
        const url = resolve(name);
        if (hooked) return url;
      } catch (error) {
        if (hooked) throw error;
      } finally {
        hooks.deregister();
      }
      throw unsupported();
    };
    // Deno has `registerHooks`, but its `import.meta.resolve` never calls them.
    found("node:path", builtin.os.tmpdir());
  } else {
    throw unsupported();
  }
  return (resolveIn = found);
}

/** A file, or a link to one: a directory of that name is no bin. */
async function isFile(path: string): Promise<boolean> {
  return await builtin.fsp.stat(path).then(
    (found) => found.isFile(),
    () => false,
  );
}

/**
 * As npm picks: the one bin, or several that are one file under other names; else the one named
 * after the package without its scope.
 */
export function pickBin(pkg: object, name: string): string {
  const bins = normalizeBin({ name, ...pkg });
  const names = Object.keys(bins);
  if (new Set(Object.values(bins)).size === 1) return names[0]!;
  const short = name.slice(name.indexOf("/") + 1);
  if (Object.hasOwn(bins, short)) return short;
  const why =
    names.length === 0 ? "has no bin" : `has bins ${names.join(", ")} and none is ${short}`;
  throw fail(`${name} ${why}`, "ENOBIN");
}

export async function readJson(file: string): Promise<object> {
  const value: unknown = JSON.parse(await builtin.fsp.readFile(file, "utf8"));
  if (value === null || typeof value !== "object")
    throw fail(`${file} is not a JSON object`, "EMANIFEST");
  return value;
}

function fail(message: string, code: "ENOBIN" | "EMANIFEST"): Error {
  return Object.assign(new Error(message), { code });
}

// `upm exec`'s lookups: which installed bin a command means, which bin a package runs, and
// where a package installs; and `resolvex`'s, which resolves an import from there.
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
 * `pkg`, `npm:pkg@rc`, `pkg@^1/sub` or `@org/name/sub@1` as the spec to install and the subpath
 * to import from it.
 */
export function splitImport(specifier: string): { spec: string; subpath: string } {
  const raw = specifier.startsWith("npm:") ? specifier.slice(4) : specifier;
  // The name is one segment, or two under a scope.
  const end = raw.indexOf("/", raw.startsWith("@") ? raw.indexOf("/") + 1 : 0);
  if (end < 0) return { spec: raw, subpath: "" };
  const name = raw.slice(0, end);
  const subpath = raw.slice(end);
  const at = subpath.lastIndexOf("@");
  if (name.includes("@", 1) || at < 0 || subpath.includes("/", at)) return { spec: name, subpath };
  return { spec: `${name}${subpath.slice(at)}`, subpath: subpath.slice(0, at) };
}

/**
 * Whether an import from `dir` finds the spec's package in a version it takes. Node takes the
 * nearest `node_modules` that has the name, so only that one is asked.
 */
export async function hasPackage(dir: string, spec: Spec): Promise<boolean> {
  const { dirname, join } = builtin.path;
  for (let at = dir; ; at = dirname(at)) {
    const file = join(at, "node_modules", spec.name, "package.json");
    const pkg = await readJson(file).catch(() => undefined);
    if (pkg) return fits(spec, (pkg as { version?: unknown }).version);
    if (dirname(at) === at) return false;
  }
}

/**
 * The url `id` resolves to from a module in `dir`, as node resolves an import. A resolve hook
 * points a name of our own at it, so no file is written for it to start from.
 */
export function resolveFrom(id: string, dir: string): string {
  const { registerHooks } = builtin.module;
  if (typeof registerHooks !== "function") {
    throw Object.assign(new Error("resolvex and importx need Node.js 22.15+ (registerHooks)"), {
      code: "ENOBUILTIN",
    });
  }
  const parentURL = builtin.url.pathToFileURL(`${dir}${builtin.path.sep}`).href;
  // Each call a name of its own: node keeps what a name resolved to.
  const name = `upm-resolvex:${globalThis.crypto.randomUUID()}`;
  const hooks = registerHooks({
    resolve: (specifier, context, next) =>
      specifier === name ? next(id, { ...context, parentURL }) : next(specifier, context),
  });
  try {
    return import.meta.resolve(name);
  } finally {
    hooks.deregister();
  }
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

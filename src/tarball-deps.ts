// What the commands do with tarball dependencies: read one into the store for the resolver,
// name one `add` was given alone, and check the local ones against the lockfile; and a `link:`
// directory's package.json. Its own module, loaded by a command that meets one of them, so no
// other pays for it at startup.
import { builtin } from "./builtin.ts";
import { normalizeBin } from "./normalize-bin.ts";
import { LOCKFILE } from "./lock.ts";
import type { Lockfile } from "./lock.ts";
import { parseManifest } from "./package-json.ts";
import { GROUPS } from "./resolve.ts";
import type { Resolution, ResolveOptions } from "./resolve.ts";
import { parse } from "./semver.ts";
import { tarballSource } from "./spec.ts";
import { sameStamp, stampOf } from "./state.ts";
import type { InstallState, Stamp, TarballStamp } from "./state.ts";
import type { PackageIndex, Store, Tarball } from "./store.ts";
import type { Manifest } from "./types.ts";
import { describe } from "./util.ts";

type Read = NonNullable<ResolveOptions["tarball"]>;

/**
 * A tarball dependency's package.json, with `dist` naming the source and the integrity of its
 * bytes: into the store under their own hash, so the install that follows finds them there.
 */
export async function readTarball(
  store: Store,
  at: Tarball,
  source: string,
  pinned?: string,
): Promise<Manifest> {
  let read: { index: PackageIndex; integrity: string };
  try {
    // The bytes the lock pinned, when it did: the store's, or the source's only if they match.
    read =
      pinned === undefined
        ? await store.adopt(at)
        : { index: (await store.add(at, pinned, true)).index, integrity: pinned };
  } catch (error) {
    throw stale(error, source);
  }
  const where = `package.json of ${source}`;
  const file = read.index.files.find((entry) => entry.path === "package.json");
  if (!file) throw fail(`${source} has no package.json`, "EMANIFEST");
  const text = await builtin.fsp.readFile(store.blobPath(file), "utf8");
  // Written by hand, not checked by a registry: a peer range has to be a string to be read,
  // and npm takes a bare string for a platform list.
  const m = parseManifest(text, where, [...GROUPS, "peerDependencies"]) as Manifest;
  for (const field of ["os", "cpu", "libc"] as const) {
    const list: unknown = m[field];
    if (typeof list === "string") m[field] = [list];
    else if (
      list !== undefined &&
      !(Array.isArray(list) && list.every((x) => typeof x === "string"))
    ) {
      throw fail(`${where}: ${field} is not a list of names`, "EMANIFEST");
    }
  }
  // The store names the entry by it, so it has to be a version and nothing else.
  const exact = typeof m.version === "string" ? parse(m.version)?.version : undefined;
  if (!exact) throw fail(`${where} has no valid version`, "EMANIFEST");
  return { ...m, version: exact, dist: { tarball: source, integrity: read.integrity } };
}

/**
 * The lockfile's local tarballs (`sources`, key -> source) whose file is no longer the bytes it
 * pinned. One with the stamp the last install recorded, checked then against the integrity the
 * lockfile pins now, is taken as the same; any other is read with `read`, once for the command,
 * so a resolve that follows finds it read. One that is gone is left to the store: the lockfile
 * still says what it held. `stamped` learns each stamp taken here that a later check can trust.
 */
export async function movedTarballs(
  dir: string,
  lock: Lockfile,
  sources: Map<string, string>,
  read: Read,
  recorded: Record<string, TarballStamp | null>,
  stamped: Map<string, TarballStamp>,
  log: (message: string) => void,
): Promise<string[]> {
  const moved: string[] = [];
  const checks = [...sources].map(async ([key, source]) => {
    const stamp = stampOf(builtin.path.resolve(dir, source.slice("file:".length)));
    if (!stamp) return;
    const { integrity } = lock.packages[key]!;
    if (sameTarball(stamp, recorded[source], integrity)) {
      stamped.set(source, [...stamp, integrity]);
      return;
    }
    if ((await read(source)).dist.integrity === integrity) return;
    log(`${source} changed since ${LOCKFILE} locked it`);
    moved.push(key);
  });
  await Promise.all(checks);
  return moved.sort();
}

/** Whether a local tarball still has `recorded`'s stamp, taken when its bytes were `integrity`. */
function sameTarball(
  stamp: Stamp | undefined,
  recorded: TarballStamp | null | undefined,
  integrity: string | undefined,
): boolean {
  if (recorded?.[4] === undefined || recorded[4] !== integrity) return false;
  return sameStamp(stamp, recorded.slice(0, 4) as Stamp);
}

/**
 * The name a tarball `add` was given alone calls itself. `file` is the package.json it goes
 * in, under the root `dir`, which a path in `fetchSpec` is read from.
 */
export async function nameOf(
  read: Read,
  dir: string,
  file: string,
  raw: string,
  fetchSpec: string,
): Promise<string> {
  const { dirname, relative } = builtin.path;
  const base = relative(dir, dirname(file)).replaceAll("\\", "/");
  const { name } = await read(tarballSource(fetchSpec, base));
  if (typeof name !== "string" || !name) {
    throw fail(`${raw} has no name in its package.json: add it as <name>@${raw}`, "EINVALIDSPEC");
  }
  return name;
}

/**
 * A path `add` is given is the shell's, read from cwd. The package.json `file` keeps it from its
 * own directory, which is where a path written there is read from. A `link:` directory too.
 */
export function fromCwd(file: string, fetchSpec: string): string {
  const prefix = /^(?:file|link):/.exec(fetchSpec)?.[0];
  if (!prefix) return fetchSpec;
  const { basename, dirname, join, relative, resolve } = builtin.path;
  const at = resolve(fetchSpec.slice(prefix.length));
  // Both ends as the disk has them: cwd is always the real path, so a project reached through
  // a link (macOS's /var is /private/var) would otherwise save a detour through the link.
  const real = (path: string) => {
    try {
      return builtin.fs.realpathSync(path);
    } catch {
      return path;
    }
  };
  const path = join(relative(real(dirname(file)), real(dirname(at))), basename(at));
  return `${prefix}${path.replaceAll("\\", "/")}`;
}

/**
 * A `link:` dependency's version and bins, off its package.json now: the lockfile keeps only
 * the edge, as pnpm's does. A directory without one, or not there yet, links with no bins.
 * Each package.json's stamp from just before it was read, null when there is none, is what
 * the no-op install holds them to; `missing` the keys of those that are no directory at all.
 */
export async function readLinks(
  dir: string,
  resolution: Resolution,
): Promise<{ stamps: NonNullable<InstallState["links"]>; missing: string[] }> {
  const stamps: NonNullable<InstallState["links"]> = {};
  const missing: string[] = [];
  const links = Object.entries(resolution.packages).filter(([, pkg]) => pkg.link);
  await Promise.all(
    links.map(async ([key, pkg]) => {
      const at = builtin.path.join(dir, pkg.local!);
      const file = builtin.path.join(at, "package.json");
      stamps[pkg.local!] = stampOf(file) ?? null;
      const m = await builtin.fsp
        .readFile(file, "utf8")
        .then((text) => JSON.parse(text) as Manifest)
        .catch(() => undefined);
      if (!m) {
        if (!builtin.fs.statSync(at, { throwIfNoEntry: false })?.isDirectory()) missing.push(key);
        return;
      }
      if (typeof m.version === "string" && parse(m.version)?.version === m.version) {
        pkg.version = m.version;
      }
      pkg.bin = normalizeBin(m);
    }),
  );
  return { stamps, missing: missing.sort() };
}

/** A tarball dependency whose bytes are not the ones the lockfile pinned: say which, and the way out. */
export function stale(error: unknown, source: string): unknown {
  if ((error as { code?: string }).code !== "EINTEGRITY") return error;
  const why = `${source} changed since ${LOCKFILE} locked it (${describe(error)})`;
  const message = `${why}; remove it and add it again to lock the new one`;
  return Object.assign(new Error(message), { code: "EINTEGRITY", cause: error });
}

function fail(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

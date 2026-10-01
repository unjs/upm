// Where a peer may land on an alias or a tarball: only a tree where something installs one
// needs it, so it is loaded on first use.
import { builtin } from "./builtin.ts";
import { allDeps } from "./resolve.ts";
import type { ResolvedPackage } from "./resolve.ts";
import type { PackageIndex, Store } from "./store.ts";
import { aliasesOf, misdeclared, misdeclaredIn, mismatch } from "./util.ts";

type Reader = Pick<Store, "index" | "blobPath">;

const GROUPS = ["peerDependencies", "dependencies", "optionalDependencies"] as const;

const realOf = (dep: ResolvedPackage) => dep.source ?? dep.fetchName ?? dep.name;

/**
 * Why a package's doubted peers, name -> id, are not what it may have, or nothing. The lock may
 * call any edge a peer, so each must be one its package.json makes a peer alone; `index` is its
 * own, checked already, and a workspace has none, since `sameTree` holds its peers. One no top's
 * edge put there must also be `walk`ed to, once every tarball has `landed`.
 */
export function vouched(
  reached: Set<string>,
  packages: Record<string, ResolvedPackage>,
  linked: (id: string) => boolean,
  store: Reader,
  landed: () => Promise<unknown>,
): (doubted: Record<string, string>, index?: PackageIndex) => Promise<string | undefined> {
  let walked: Promise<Set<string>> | undefined;
  return async (doubted, index) => {
    const seen = Object.values(doubted).every((id) => reached.has(id))
      ? reached
      : await (walked ??= landed().then(() => walk(reached, packages, linked, store)));
    const json = index && manifestOf(index, store);
    const left: Record<string, string> = {};
    for (const [name, id] of Object.entries(doubted)) {
      const peer =
        !json ||
        (Object.hasOwn(json.peerDependencies, name) &&
          !Object.hasOwn(json.dependencies, name) &&
          !Object.hasOwn(json.optionalDependencies, name));
      if (!peer || !seen.has(id)) left[name] = realOf(packages[id]!);
    }
    return index ? misdeclaredIn(index, store.blobPath, left) : misdeclared({}, left);
  };
}

/**
 * What `reached` leads to through edges each package's own package.json declares: a package
 * the tree must hold put each there. A lock can add an edge no package.json names, so only
 * these are followed, and only from a package `linked` that is the package it is linked as.
 */
function walk(
  reached: Set<string>,
  packages: Record<string, ResolvedPackage>,
  linked: (id: string) => boolean,
  store: Reader,
): Set<string> {
  const seen = new Set(reached);
  const queue = [...reached];
  for (let i = 0; i < queue.length; i++) {
    const pkg = packages[queue[i]!];
    if (!pkg || !linked(queue[i]!)) continue; // a workspace's edges are in `reached` already
    const index = store.index(pkg.integrity);
    const want = { name: pkg.fetchName ?? pkg.name, version: pkg.version };
    if (!index || (pkg.source === undefined && mismatch(index, want))) continue;
    const json = manifestOf(index, store);
    const declared: Record<string, string> = {};
    for (const group of GROUPS) {
      for (const name of Object.keys(json[group])) declared[name] = name;
    }
    Object.assign(declared, aliasesOf(json));
    for (const [name, version] of Object.entries(allDeps(pkg))) {
      const id = `${name}@${version}`;
      const dep = packages[id];
      if (seen.has(id) || !dep || declared[name] !== realOf(dep)) continue;
      seen.add(id);
      queue.push(id);
    }
  }
  return seen;
}

/** Its package.json's dependency groups, each empty when it has none it can read. */
function manifestOf(index: PackageIndex, store: Reader): Record<(typeof GROUPS)[number], object> {
  const file = index.files.find((entry) => entry.path === "package.json");
  let json: Record<string, unknown> | undefined;
  try {
    json =
      file &&
      JSON.parse(builtin.fs.readFileSync(store.blobPath(file), "utf8").replace(/^\uFEFF/, ""));
  } catch {}
  const out = {} as Record<(typeof GROUPS)[number], object>;
  for (const group of GROUPS) {
    const deps = json?.[group];
    out[group] = typeof deps === "object" && deps !== null ? deps : {};
  }
  return out;
}

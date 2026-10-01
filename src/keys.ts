// Store entry keys. Files are keyed by content (store.ts); entries are keyed by *subgraph*, so
// two packages sharing a name and version but differing downstream never share a directory.
// IDEA.md 5.4. npm's `getKey()` recurses over a materialized subtree; our graph has real cycles
// and heavy sharing, so we hash bottom-up over the SCC condensation instead: linear, iterative.
import { shortHash } from "./runtime.ts";
import { allDeps } from "./resolve.ts";
import type { Resolution, ResolvedPackage } from "./resolve.ts";

export { shortHash };

type Packages = Record<string, ResolvedPackage>;
type Graph = Map<string, string[]>;

/**
 * `<name>@<version>-<hash>`, the directory name of a `.upm` entry.
 *
 * **Invariant: the result is always one path segment.** A scoped name's `/` is escaped to `+`
 * (pnpm's `.pnpm` convention), so `@scope/pkg` lands at `.upm/@scope+pkg@1.2.3-<hash>` and the
 * store stays flat: the linker never nests, and stage 6's GC is one `readdir`. `+` is not a legal
 * character in an npm package name, and the hash covers the unescaped name regardless.
 */
export async function storeKey(packages: Packages, key: string): Promise<string> {
  const found = packages[key];
  if (!found) throw Object.assign(new Error(`${key} is not in the resolution`), { code: "ENOKEY" });
  if (found.local !== undefined) {
    throw Object.assign(new Error(`${key} is a workspace, not a store entry`), { code: "ENOKEY" });
  }
  return format(found, (await digestsOf(packages)).get(key)!);
}

/**
 * Every package's store key, computed in one pass. Keys are the `name@version` ids. A workspace
 * has none: it is linked from its own directory, never placed in `.upm`.
 */
export async function storeKeys(packages: Packages): Promise<Record<string, string>> {
  const digests = await digestsOf(packages);
  const out: Record<string, string> = {};
  for (const [key, found] of Object.entries(packages)) {
    if (found.local === undefined) out[key] = format(found, digests.get(key)!);
  }
  return out;
}

/**
 * One hash over the whole resolution, for stage 6's incremental check. Root name and version are
 * left out on purpose — bumping your own version must not invalidate an installed tree.
 */
export function graphHash(resolution: Resolution): Promise<string> {
  const { root, packages } = resolution;
  const lines = Object.values(packages).map(lineOf);
  lines.push(`::root::${edges(root.dependencies)}`);
  // A workspace's own edges, the way the root's are: they place links in its `node_modules`,
  // and `lineOf` leaves them out on purpose.
  for (const found of Object.values(packages)) {
    if (found.local !== undefined && !found.link) {
      lines.push(`::top:${found.local}::${edges(allDeps(found))}`);
    }
  }
  return hash(lines);
}

function format(found: ResolvedPackage, digest: string): string {
  return `${found.name.replaceAll("/", "+")}@${found.version}-${digest}`;
}

/** Canonical description of one node: identity, content, and who it resolves its deps to. */
function lineOf(found: ResolvedPackage): string {
  // A workspace is a leaf: its path is its identity. Its own edges land in its own
  // `node_modules`, so a consumer's key must not move when they do — graphHash covers them.
  if (found.local !== undefined) return `${found.name}@link:${found.local}::local`;
  // integrity, not the url: a republished tarball is different content at the same name, and
  // without this the old entry keeps its key and is reused forever. The url would only add
  // which registry served those exact bytes, and hashing that would give one project two
  // store entries for one tarball just for switching to a mirror.
  return `${found.name}@${found.version}::${found.integrity}::${edges(allDeps(found))}`;
}

function edges(dependencies: Record<string, string>): string {
  return Object.entries(dependencies)
    .map(([name, version]) => `${name}@${version}`)
    .sort()
    .join(",");
}

/** Sorted, so neither insertion order nor the walk's starting point can reach the digest. */
function hash(lines: string[]): Promise<string> {
  return shortHash([...lines].sort().join("\n"));
}

/**
 * A digest per package, Merkle-style over the strongly connected components. Tarjan yields
 * components sinks first, so when one is reached every component below it already has a digest and
 * hashing its own lines plus those digests covers its whole closure — every node and edge is
 * touched once, where materializing the closures was quadratic. The members of a cycle share one
 * digest, which is correct: their closures are identical.
 *
 * Components are hashed a round at a time (`rounds`), every hash of a round in flight together:
 * on Node each is a settled promise either way, off Node each is a hop to the crypto thread that
 * would otherwise go one at a time. The lines a component hashes do not depend on the grouping.
 */
async function digestsOf(packages: Packages): Promise<Map<string, string>> {
  const graph = graphOf(packages);
  const digests = new Map<string, string>();
  for (const round of rounds(graph)) {
    const hashes = await Promise.all(
      round.map((group) => {
        const lines = group.map((node) => lineOf(packages[node]!));
        for (const node of group) {
          for (const child of graph.get(node) ?? []) {
            const below = digests.get(child); // a child inside the group has none yet
            if (below !== undefined) lines.push(`>${below}`); // ">" cannot start a line
          }
        }
        return hash(lines);
      }),
    );
    round.forEach((group, i) => {
      for (const node of group) digests.set(node, hashes[i]!);
    });
  }
  return digests;
}

/**
 * The components in rounds: round 0 is every component with no edge out of itself, round n every
 * component whose children outside it were all in earlier rounds. A round's hashes need nothing
 * from each other. Tarjan is sinks first, so each child's round is known before its parent's.
 */
function rounds(graph: Graph): string[][][] {
  const round = new Map<string, number>();
  const out: string[][][] = [];
  for (const group of components(graph)) {
    let at = 0;
    for (const node of group) {
      for (const child of graph.get(node) ?? []) {
        const below = round.get(child); // a child inside the group has none yet
        if (below !== undefined) at = Math.max(at, below + 1);
      }
    }
    for (const node of group) round.set(node, at);
    (out[at] ??= []).push(group);
  }
  return out;
}

/** Adjacency by id, dropping edges to packages the resolver left out. */
function graphOf(packages: Packages): Graph {
  const graph: Graph = new Map();
  for (const [key, found] of Object.entries(packages)) {
    const kids: string[] = [];
    if (found.local !== undefined) {
      graph.set(key, kids); // a leaf, as `lineOf` describes it
      continue;
    }
    for (const [name, version] of Object.entries(allDeps(found))) {
      if (`${name}@${version}` in packages) kids.push(`${name}@${version}`);
    }
    graph.set(key, kids);
  }
  return graph;
}

/** Tarjan, iterative. Strongly connected components, sinks first. */
function components(graph: Graph): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const open = new Set<string>();
  const path: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    const work: [node: string, next: number][] = [[start, 0]];
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const [node, next] = frame;
      if (next === 0) {
        index.set(node, counter);
        low.set(node, counter++);
        path.push(node);
        open.add(node);
      }
      const kids = graph.get(node) ?? [];
      if (next < kids.length) {
        frame[1]++;
        const kid = kids[next]!;
        if (!index.has(kid)) work.push([kid, 0]);
        else if (open.has(kid)) low.set(node, Math.min(low.get(node)!, index.get(kid)!));
        continue;
      }
      work.pop();
      const parent = work.at(-1)?.[0];
      if (parent !== undefined) low.set(parent, Math.min(low.get(parent)!, low.get(node)!));
      if (low.get(node) !== index.get(node)) continue;
      const group: string[] = [];
      let member: string;
      do {
        member = path.pop()!;
        open.delete(member);
        group.push(member);
      } while (member !== node);
      out.push(group);
    }
  }
  return out;
}

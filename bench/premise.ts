// Premise check: before benchmarking a fix for repeated work, count how often that work
// repeats in real lockfiles. See ../.agents/perf.md.
//
//   node bench/premise.ts <lockfile> [...]
//
// Reads upm.lock, npm package-lock.json (v2+) and vlt-lock.json.

import { builtin } from "../src/builtin.ts";

export interface Counts {
  total: number;
  distinct: number;
  repeats: number;
}

export interface Premise {
  /** Tarball integrity per placed package: a repeat places one store entry twice. */
  store: Counts;
  /** `name spec` per dependency edge: a repeat asks the resolver the same thing twice. */
  asks: Counts;
  /** upm.lock pins package deps to versions, which merges asks: `asks` is an upper bound. */
  pinned: boolean;
}

type Deps = Record<string, string>;

interface Entry {
  integrity?: string;
  specs?: Entry;
  dependencies?: Deps;
  devDependencies?: Deps;
  optionalDependencies?: Deps;
  peerDependencies?: Deps;
}

interface Lock {
  lockfileVersion?: number;
  root?: Entry;
  workspaces?: Record<string, Entry>;
  packages?: Record<string, Entry>;
  nodes?: Record<string, [flags: number, name: string, integrity?: string]>;
  edges?: Record<string, string>;
}

const GROUPS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

export function premise(text: string): Premise {
  let lock: Lock | undefined;
  try {
    lock = JSON.parse(text);
  } catch {}
  const integrities: string[] = [];
  const asks: string[] = [];
  // Registry packages never install their own dev deps, so only tops pass `dev`.
  const ask = (entry: Entry | undefined, dev = false) => {
    for (const group of dev ? [...GROUPS, "devDependencies" as const] : GROUPS) {
      for (const [name, spec] of Object.entries(entry?.[group] ?? {})) asks.push(`${name} ${spec}`);
    }
  };
  if (lock?.nodes && lock.edges) {
    // vlt-lock.json: an edge is `"<from> <name>": "<type> <spec> <to>"`, and a spec may hold spaces.
    for (const node of Object.values(lock.nodes)) if (node[2]) integrities.push(node[2]);
    for (const [key, value] of Object.entries(lock.edges)) {
      const spec = value.slice(value.indexOf(" ") + 1, value.lastIndexOf(" "));
      asks.push(`${key.slice(key.indexOf(" ") + 1)} ${spec}`);
    }
  } else if (lock?.root && lock.packages) {
    // upm.lock: a top keeps its specs apart from its resolved deps.
    for (const top of [lock.root, ...Object.values(lock.workspaces ?? {})]) {
      ask(top.specs, true);
      ask({ peerDependencies: top.peerDependencies });
    }
    for (const entry of Object.values(lock.packages)) {
      if (entry.integrity) integrities.push(entry.integrity);
      ask(entry);
    }
  } else if (lock?.packages && (lock.lockfileVersion ?? 0) >= 2) {
    // npm: "" is the root and a path outside node_modules/ is a workspace.
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (entry.integrity) integrities.push(entry.integrity);
      ask(entry, !path.includes("node_modules/"));
    }
  } else {
    throw new Error("not a upm.lock, npm package-lock.json (v2+) or vlt-lock.json");
  }
  return { store: count(integrities), asks: count(asks), pinned: !!lock.root };
}

function count(keys: string[]): Counts {
  const distinct = new Set(keys).size;
  return { total: keys.length, distinct, repeats: keys.length - distinct };
}

function line(label: string, unit: string, { total, distinct, repeats }: Counts): string {
  const percent = total ? ((repeats / total) * 100).toFixed(1) : "0.0";
  return `  ${label} ${total} ${unit}, ${distinct} distinct, ${repeats} repeats (${percent}%)`;
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("Usage: node bench/premise.ts <lockfile> [...]");
    process.exitCode = 1;
  }
  for (const file of files) {
    try {
      const { store, asks, pinned } = premise(builtin.fs.readFileSync(file, "utf8"));
      console.log(file);
      console.log(line("store entries:", "placed", store));
      console.log(line("spec asks:    ", "edges", asks) + (pinned ? ", upper bound" : ""));
    } catch (error) {
      console.error(`premise: ${file}: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

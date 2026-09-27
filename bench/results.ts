import { builtin } from "../src/builtin.ts";

export const PHASES = ["cold", "warm", "repeat"] as const;
export const METRICS = ["min", "max", "median", "mean"] as const;
export const MEASURES = ["time", "memory", "cpu"] as const;
export type Phase = (typeof PHASES)[number];
export type Metric = (typeof METRICS)[number];
export type Measure = (typeof MEASURES)[number];
export const PHASE_BLURB: Record<Phase, string> = {
  cold: "empty cache, no lockfile",
  warm: "cache + lockfile kept",
  repeat: "nothing removed",
};
const RUNNERS = ["upm", "npm", "pnpm11", "pnpm12", "yarn1", "yarn4", "bun", "deno", "aube", "nub"];
const FIXTURES = ["nitro", "nuxt", "next"];

export interface Run {
  runner: string;
  version: string;
  fixture: string;
  phase: Phase;
  iter: number;
  ms: number;
  ok: boolean;
  packages?: number;
  bytes?: number;
  cache_bytes?: number;
  runner_bytes?: number;
  // The manager's files as a CI cache would pack them: tar through zstd.
  runner_packed_bytes?: number;
  // Peak of the summed RSS of the install's process tree, sampled.
  rss_bytes?: number;
  // Peak RSS of its largest single process, exact.
  rss_process_bytes?: number;
  // CPU time summed over the whole tree.
  user_ms?: number;
  sys_ms?: number;
  ts?: string;
}

export interface Runner {
  name: string;
  version: string;
  // Apparent size of the manager itself on disk.
  bytes?: number;
  // The same files packed as a CI cache, tar through zstd.
  packedBytes?: number;
}

// Values of the aggregated measure: install time unless another measure was asked for.
export interface Summary {
  times: number[];
  failedTimes: number[];
  value: number | null;
  failedValue: number | null;
  samples: number;
  suspect: boolean;
  packages: number[];
}

export interface Benchmark {
  rows: Run[];
  runners: Runner[];
  fixtures: string[];
  phases: Phase[];
  metric: Metric;
  measure: Measure;
  groups: Map<string, Summary>;
  best: Map<string, number>;
}

export function parseRows(text: string, source = "results"): Run[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new Error("expected an object");
      for (const key of ["runner", "version", "fixture"]) {
        if (typeof row[key] !== "string" || !row[key].trim()) throw new Error(`invalid ${key}`);
      }
      if (!PHASES.includes(row.phase)) throw new Error("invalid phase");
      if (typeof row.ok !== "boolean") throw new Error("invalid ok");
      if (!Number.isFinite(row.ms) || row.ms < 0 || row.ms > Number.MAX_SAFE_INTEGER) {
        throw new Error("invalid ms: expected a finite, non-negative duration");
      }
      if (!Number.isSafeInteger(row.iter) || row.iter < 1) throw new Error("invalid iter");
      for (const key of [
        "packages",
        "bytes",
        "cache_bytes",
        "runner_bytes",
        "runner_packed_bytes",
        "rss_bytes",
        "rss_process_bytes",
        "user_ms",
        "sys_ms",
      ]) {
        if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || row[key] < 0)) {
          throw new Error(`invalid ${key}`);
        }
      }
      return [row as Run];
    } catch (error) {
      throw new Error(`${source}:${index + 1}: ${(error as Error).message}`);
    }
  });
}

export function load(paths: string[]): Run[] {
  return paths.flatMap((path) => parseRows(builtin.fs.readFileSync(path, "utf8"), path));
}

export function pick(values: number[], metric: Metric): number | null {
  if (!values.length) return null;
  if (metric === "mean")
    return values.reduce((mean, value, i) => mean + (value - mean) / (i + 1), 0);
  const sorted = [...values].sort((a, b) => a - b);
  if (metric === "min") return sorted[0]!;
  if (metric === "max") return sorted.at(-1)!;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function fmt(ms: number | null): string {
  if (ms === null) return "not run";
  if (ms > 0 && ms < 1) return `${Number(ms.toPrecision(3))} ms`;
  const rounded = Math.round(ms);
  if (rounded >= 10_000) return `${(rounded / 1000).toFixed(1)} s`;
  if (rounded >= 1000) return `${(rounded / 1000).toFixed(2)} s`;
  return `${rounded} ms`;
}

export function fmtBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1000 && i < units.length - 1) {
    bytes /= 1000;
    i++;
  }
  return `${Number(bytes.toPrecision(3))} ${units[i]}`;
}

export const MEASURE: Record<
  Measure,
  { label: string; value: (row: Run) => number | undefined; format: (value: number) => string }
> = {
  time: { label: "install time", value: (row) => row.ms, format: fmt },
  memory: { label: "peak memory", value: (row) => row.rss_bytes, format: fmtBytes },
  cpu: {
    label: "CPU time",
    value: (row) =>
      row.user_ms === undefined || row.sys_ms === undefined ? undefined : row.user_ms + row.sys_ms,
    format: fmt,
  },
};

export function key(phase: Phase, runner: Runner, fixture: string): string {
  return JSON.stringify([phase, runner.name, runner.version, fixture]);
}

export function bestKey(phase: Phase, fixture: string): string {
  return JSON.stringify([phase, fixture]);
}

function ordered(values: string[], preferred: readonly string[]): string[] {
  const unique = new Set(values);
  return [...preferred.filter((value) => unique.delete(value)), ...[...unique].sort()];
}

export function aggregate(
  rows: Run[],
  metric: Metric = "median",
  phases: readonly Phase[] = PHASES,
  measure: Measure = "time",
): Benchmark {
  rows = rows.filter((row) => phases.includes(row.phase));
  if (!rows.length) throw new Error("no results for the selected phases");
  // Older results have no memory or CPU; those rows drop out of that measure only.
  const value = MEASURE[measure].value;
  rows = rows.filter((row) => value(row) !== undefined);
  if (!rows.length) throw new Error(`no ${MEASURE[measure].label} in these results`);
  const names = ordered(
    rows.map((row) => row.runner),
    RUNNERS,
  );
  const runners = names.flatMap((name) =>
    [...new Set(rows.filter((row) => row.runner === name).map((row) => row.version))]
      .sort()
      .map((version) => {
        const runner: Runner = { name, version };
        const mine = rows.filter((row) => row.runner === name && row.version === version);
        const bytes = mine.find((row) => row.runner_bytes)?.runner_bytes;
        if (bytes) runner.bytes = bytes;
        const packed = mine.find((row) => row.runner_packed_bytes)?.runner_packed_bytes;
        if (packed) runner.packedBytes = packed;
        return runner;
      }),
  );
  const groups = new Map<string, Summary>();
  for (const row of rows) {
    const id = key(row.phase, { name: row.runner, version: row.version }, row.fixture);
    let entry = groups.get(id);
    if (!entry) {
      entry = {
        times: [],
        failedTimes: [],
        value: null,
        failedValue: null,
        samples: 0,
        suspect: false,
        packages: [],
      };
      groups.set(id, entry);
    }
    (row.ok ? entry.times : entry.failedTimes).push(value(row)!);
    entry.samples++;
    entry.suspect ||=
      (row.phase === "cold" &&
        row.ok &&
        row.cache_bytes !== undefined &&
        row.cache_bytes < 1_000_000) ||
      // Every fixture installs something: nothing in the project means it went elsewhere.
      (row.ok && row.packages === 0);
    if (row.ok && row.packages !== undefined) entry.packages.push(row.packages);
  }
  for (const entry of groups.values()) {
    entry.value = pick(entry.times, metric);
    entry.failedValue = pick(entry.failedTimes, metric);
  }
  const shown = PHASES.filter((phase) => rows.some((row) => row.phase === phase));
  const fixtures = ordered(
    rows.map((row) => row.fixture),
    FIXTURES,
  );
  const best = new Map<string, number>();
  for (const phase of shown) {
    for (const fixture of fixtures) {
      for (const runner of runners) {
        const entry = groups.get(key(phase, runner, fixture));
        if (!entry || entry.value === null || entry.failedTimes.length || entry.suspect) continue;
        const id = bestKey(phase, fixture);
        best.set(id, Math.min(best.get(id) ?? Infinity, entry.value));
      }
    }
  }
  return { rows, runners, fixtures, phases: shown, metric, measure, groups, best };
}

export function isBest(data: Benchmark, phase: Phase, fixture: string, entry: Summary): boolean {
  return (
    !entry.failedTimes.length &&
    !entry.suspect &&
    entry.value === data.best.get(bestKey(phase, fixture))
  );
}

// A ranked manager has a clean time for every phase and project: no failed
// samples, no cache warning and above zero. Its score is the geometric mean of
// its time over the best ranked time for each case, so every case weighs the
// same and the order of two managers never depends on a third. Other managers
// are unranked with a reason instead of an invented time.
export type Score = { value: number } | { value: null; reason: string };

export function scores(data: Benchmark): Map<Runner, Score> {
  const cases = data.phases.flatMap((phase) =>
    data.fixtures.map((fixture) => ({ phase, fixture })),
  );
  const result = new Map<Runner, Score>();
  const ranked = new Map<Runner, number[]>();
  for (const runner of data.runners) {
    const counts = { "not run": 0, failed: 0, "cache warning": 0, "zero time": 0 };
    const times = cases.map(({ phase, fixture }) => {
      const entry = data.groups.get(key(phase, runner, fixture));
      if (!entry) counts["not run"]++;
      else if (entry.value === null || entry.failedTimes.length) counts.failed++;
      else if (entry.suspect) counts["cache warning"]++;
      else if (entry.value <= 0) counts["zero time"]++;
      else return entry.value;
      return 0;
    });
    const issues = Object.entries(counts).filter(([, count]) => count);
    if (!cases.length) result.set(runner, { value: null, reason: "no results" });
    else if (issues.length)
      result.set(runner, {
        value: null,
        reason: issues.map(([issue, count]) => `${count} ${issue}`).join(", "),
      });
    else ranked.set(runner, times);
  }
  const best = cases.map((_, i) => Math.min(...[...ranked.values()].map((times) => times[i]!)));
  for (const [runner, times] of ranked) {
    const logs = times.reduce((sum, time, i) => sum + Math.log(time / best[i]!), 0);
    result.set(runner, { value: Math.exp(logs / cases.length) });
  }
  return new Map(data.runners.map((runner) => [runner, result.get(runner)!]));
}

export function caption(entry?: Summary, format: (value: number) => string = fmt): string {
  if (!entry) return "not run";
  if (entry.value === null) return `failed · ${format(entry.failedValue!)}`;
  return (
    format(entry.value) +
    (entry.failedTimes.length ? ` (${entry.failedTimes.length}/${entry.samples} failed)` : "") +
    (entry.suspect ? " ▲" : "")
  );
}

export function sampleCounts(data: Benchmark): string {
  return data.phases
    .map((phase) => {
      const counts = data.runners.flatMap((runner) =>
        data.fixtures.flatMap((fixture) => {
          const entry = data.groups.get(key(phase, runner, fixture));
          return entry ? [entry.samples] : [];
        }),
      );
      return `${phase} n=${range(counts)}`;
    })
    .join(" · ");
}

export function range(values: number[]): string {
  if (!values.length) return "—";
  const min = Math.min(...values),
    max = Math.max(...values);
  return min === max ? String(min) : `${min}–${max}`;
}

export function warnings(data: Benchmark): string[] {
  const suspect = data.runners.flatMap((runner) =>
    data.fixtures.flatMap((fixture) =>
      PHASES.some((phase) => data.groups.get(key(phase, runner, fixture))?.suspect)
        ? [`${runner.name} ${runner.version}/${fixture}`]
        : [],
    ),
  );
  return suspect.length
    ? [
        `▲ A small private cache after a cold run, or no packages in the project; check isolation: ${suspect.join(", ")}.`,
      ]
    : [];
}

export interface Options {
  results: string[];
  phases: Phase[];
  metric: Metric;
  measure?: Measure;
  out?: string;
  size: boolean;
  help: boolean;
}

export function parseArgs(args: string[], chart = false): Options {
  const options: Options = {
    results: [],
    phases: [],
    metric: "median",
    size: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      options.results.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (chart && arg === "--size") {
      options.size = true;
      continue;
    }
    if (
      arg === "--metric" ||
      arg === "--phase" ||
      arg === "--measure" ||
      (chart && (arg === "--out" || arg === "-o"))
    ) {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(`missing value for ${arg}`);
      if (arg === "--metric") {
        if (!METRICS.includes(value as Metric)) throw new Error(`invalid metric: ${value}`);
        options.metric = value as Metric;
      } else if (arg === "--measure") {
        if (!MEASURES.includes(value as Measure)) throw new Error(`invalid measure: ${value}`);
        options.measure = value as Measure;
      } else if (arg === "--phase") {
        if (!PHASES.includes(value as Phase)) throw new Error(`invalid phase: ${value}`);
        if (!options.phases.includes(value as Phase)) options.phases.push(value as Phase);
      } else options.out = value;
    } else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else options.results.push(arg);
  }
  if (!options.phases.length) options.phases = [...PHASES];
  return options;
}

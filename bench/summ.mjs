#!/usr/bin/env node
// summ.mjs <rows-file>... — medians per (fixture, build) and paired differences vs the first
// build, for rows written by ab.sh. Paired diff = new - first, per pair; reports median
// paired diff, how many pairs favored new (wins), and the spread (min..max). A pair is its
// index within one run (a `#` header), so several files or an appended AB_OUT do not mix.
import { readFileSync } from "node:fs";

const rows = [];
let run = 0;
for (const file of process.argv.slice(2)) {
  run++;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("#")) run++;
    if (!line || line.startsWith("#")) continue;
    const [fx, label, i, ...kv] = line.split(" ");
    const r = { fx, label, i: `${run}:${i}` };
    for (const p of kv) {
      const [k, v] = p.split("=");
      r[k] = v === "NA" ? NaN : Number(v);
    }
    rows.push(r);
  }
}
const med = (a) => {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return s.length
    ? s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    : NaN;
};
const fmt = (v, unit) =>
  !Number.isFinite(v)
    ? "NA"
    : unit === "ms"
      ? `${Math.round(v)} ms`
      : unit === "MB"
        ? `${(v / 1048576).toFixed(0)} MB`
        : `${(v / 1000).toFixed(0)} ms`;
const labels = [...new Set(rows.map((r) => r.label))];
const fixtures = [...new Set(rows.map((r) => r.fx))];
const base = labels[0];
for (const fx of fixtures) {
  console.log(`\n## ${fx}`);
  console.log(
    `| build | n | ok | wall med | rss med | cpu med | Δwall med (wins) | Δwall range | Δrss med | Δcpu med |`,
  );
  console.log(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  const by = (l) => rows.filter((r) => r.fx === fx && r.label === l);
  for (const l of labels) {
    const rs = by(l);
    const okRs = rs.filter((r) => r.ok === 0);
    let d = "",
      dr = "",
      drss = "",
      dcpu = "";
    if (l !== base) {
      const b = new Map(
        by(base)
          .filter((r) => r.ok === 0)
          .map((r) => [r.i, r]),
      );
      const pairs = okRs.filter((r) => b.has(r.i));
      const dw = pairs.map((r) => r.ms - b.get(r.i).ms);
      const wins = dw.filter((x) => x < 0).length;
      d = `${fmt(med(dw), "ms")} (${wins}/${dw.length})`;
      dr = dw.length ? `${Math.min(...dw)}..${Math.max(...dw)}` : "";
      drss = fmt(med(pairs.map((r) => r.rss - b.get(r.i).rss)), "MB");
      dcpu = fmt(med(pairs.map((r) => r.cpu_us - b.get(r.i).cpu_us)), "us");
    }
    console.log(
      `| ${l} | ${rs.length} | ${okRs.length} | ${fmt(med(okRs.map((r) => r.ms)), "ms")} | ${fmt(med(okRs.map((r) => r.rss)), "MB")} | ${fmt(med(okRs.map((r) => r.cpu_us)), "us")} | ${d} | ${dr} | ${drss} | ${dcpu} |`,
    );
  }
  const entries = new Set(
    rows.filter((r) => r.fx === fx && r.ok === 0).map((r) => `${r.label}:${r.entries}`),
  );
  console.log(`entries: ${[...entries].join(" ")}`);
}

#!/usr/bin/env node
import type { Dirent } from "node:fs";
import { builtin } from "../src/builtin.ts";
import { ICONS } from "./icons.ts";
import {
  aggregate,
  caption,
  fmtBytes,
  key,
  load,
  MEASURE,
  parseArgs,
  range,
  sampleCounts,
  scores,
  warnings,
} from "./results.ts";
import type { Benchmark, Measure, Metric, Phase, Runner, Score, Summary } from "./results.ts";

const METRIC_LABEL: Record<Metric, string> = {
  median: "Median",
  mean: "Average",
  min: "Fastest",
  max: "Slowest",
};
// Fastest and slowest only make sense for time.
const AMOUNT_LABEL: Record<Metric, string> = { ...METRIC_LABEL, min: "Lowest", max: "Highest" };
const MEASURE_NOTE: Record<Measure, string> = {
  time: "",
  memory: "Peak memory: the install and its child processes together.",
  cpu: "CPU time: user + system, child processes included.",
};
const PHASE_LABEL: Record<Phase, string> = { cold: "Cold", warm: "Warm", repeat: "Repeat" };
const PHASE_TEXT: Record<Phase, string> = {
  cold: "no cache or lockfile",
  warm: "cached, lockfile kept",
  repeat: "already installed, nothing changed",
};
const COLOR: Record<Phase, string> = { cold: "#1d4f9e", warm: "#e0661a", repeat: "#a4267d" };
const SURFACE = "#fcfcfb",
  INK = "#20252c",
  MUTED = "#606974",
  GRID = "#e2e5e8",
  BORDER = "#d7dce1",
  STRIPE = "#f3f5f6",
  UPM_ROW = "#edf3fc",
  BAR = "#8c96a1";
const BAD = "#b42332",
  WARN = "#915800";
// Colors are drawn in light as attributes, so static renderers get a whole chart. A viewer
// that prefers dark gets these instead, from style rules that match the attribute value.
const DARK: Record<string, string> = {
  [SURFACE]: "#16181d",
  [INK]: "#e4e7eb",
  [MUTED]: "#9aa3ad",
  [GRID]: "#30353c",
  [BORDER]: "#343a42",
  [STRIPE]: "#1d2026",
  [UPM_ROW]: "#1a2538",
  [BAR]: "#6b7480",
  [COLOR.cold]: "#6b9cf0",
  [COLOR.warm]: "#f28a44",
  [COLOR.repeat]: "#dc6cb8",
  [BAD]: "#f06470",
  [WARN]: "#e0a73a",
};
const THEME_STYLE = `<style>
@media (prefers-color-scheme: dark) {
${Object.entries(DARK)
  .map(
    ([light, dark]) =>
      `[fill="${light}"] { fill: ${dark} } [stroke="${light}"] { stroke: ${dark} }`,
  )
  .join("\n")}
}
</style>`;
const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const PAD = 16,
  DOT = 3.5,
  ICON = 14;
// Every chart has this canvas so they tile in a grid. Only a chart too tall for it grows.
const WIDTH = 1120,
  HEIGHT = 720;

// What each manager runs on: a JavaScript runtime, or a native Rust binary.
type Runtime = "node" | "rust" | "bun" | "deno";
const RUNTIME: Record<string, Runtime> = {
  upm: "node",
  npm: "node",
  pnpm11: "node",
  pnpm12: "rust",
  yarn1: "node",
  yarn4: "node",
  aube: "rust",
  nub: "rust",
  vlt: "node",
  bun: "bun",
  deno: "deno",
};
const RUNTIME_LABEL: Record<Runtime, string> = {
  node: "Node",
  rust: "Rust",
  bun: "Bun",
  deno: "Deno",
};
const RUNTIME_COLOR: Record<Runtime, string> = {
  node: "#5fa04e",
  rust: INK,
  bun: INK,
  // Kept dark in both themes: the logo draws it on its own white disc.
  deno: "#000",
};

export function esc(value: unknown): string {
  const text = [...String(value).toWellFormed()]
    .map((char) => {
      const code = char.codePointAt(0)!;
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 0xfffe || code === 0xffff
        ? "�"
        : char;
    })
    .join("");
  return text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!,
  );
}

export function textWidth(text: string, size: number): number {
  return [...text].reduce(
    (width, char) =>
      width +
      (" ilI.,:;'|!".includes(char)
        ? 0.34
        : "MW@%▲".includes(char)
          ? 0.95
          : char.codePointAt(0)! > 127
            ? 1
            : 0.65) *
        size,
    0,
  );
}

export function wrap(text: string, width: number, size: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && textWidth(`${line} ${word}`, size) > width) {
      lines.push(line);
      line = "";
    }
    if (line) line += " ";
    for (const char of word) {
      if (line && textWidth(line + char, size) > width) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

class Svg {
  parts: string[] = [];
  add(tag: string, attrs: Record<string, string | number | undefined>, body?: string) {
    const pairs = Object.entries(attrs)
      .filter(([, value]) => value !== undefined)
      .map(
        ([name, value]) =>
          `${name.replaceAll("_", "-")}="${esc(typeof value === "number" ? Math.round(value * 100) / 100 : value)}"`,
      )
      .join(" ");
    this.parts.push(
      body === undefined ? `<${tag} ${pairs}/>` : `<${tag} ${pairs}>${body}</${tag}>`,
    );
  }
  text(x: number, y: number, text: string, size = 12, fill = INK, anchor = "start", weight = 400) {
    this.add(
      "text",
      { x, y, font_size: size, fill, text_anchor: anchor, font_weight: weight },
      esc(text),
    );
  }
  // Text with some parts in bold.
  rich(x: number, y: number, parts: [string, boolean][], size = 12, fill = INK, anchor = "start") {
    this.add(
      "text",
      { x, y, font_size: size, fill, text_anchor: anchor },
      parts
        .map(([text, bold]) => (bold ? `<tspan font-weight="700">${esc(text)}</tspan>` : esc(text)))
        .join(""),
    );
  }
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, opacity = 1) {
    this.add("line", { x1, y1, x2, y2, stroke, stroke_opacity: opacity });
  }
}

// The nearest 1, 2 or 5 × 10ⁿ at or above value.
function nice(value: number): number {
  const unit = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((n) => Number((n * unit).toPrecision(12))).find((n) => n >= value)!;
}

interface Tick {
  value: number;
  x: number;
  label: string;
  anchor: string;
}

const timeLabel = (value: number) =>
  `${Number((value >= 1000 ? value / 1000 : value).toPrecision(3))} ${value >= 1000 ? "s" : "ms"}`;

// A linear axis from zero, ending on a round step above the largest value.
export class Axis {
  hi: number;
  step: number;
  width: number;
  label: (value: number) => string;
  constructor(values: number[], width: number, label = timeLabel) {
    if (!Number.isFinite(width) || width <= 0) throw new Error("axis is too narrow");
    if (values.some((v) => !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER))
      throw new Error("invalid axis duration");
    const max = Math.max(0, ...values) * 1.04 || 1;
    this.step = nice(max / Math.max(1, Math.min(10, Math.floor(width / 90))));
    this.hi = Math.ceil(max / this.step) * this.step;
    this.width = width;
    this.label = label;
  }
  x(value: number): number {
    if (!Number.isFinite(value) || value < 0 || value > this.hi)
      throw new Error(`duration outside axis: ${value}`);
    return (this.width * value) / this.hi;
  }
  ticks(): Tick[] {
    const kept: Tick[] = [];
    let right = -Infinity;
    for (let i = 0; i * this.step <= this.hi * (1 + 1e-9); i++) {
      const value = Number((i * this.step).toPrecision(12));
      const x = this.x(Math.min(value, this.hi));
      const label = this.label(value);
      const anchor = i === 0 ? "start" : x >= this.width - 0.001 ? "end" : "middle";
      const width = textWidth(label, 10);
      const left = x - (anchor === "end" ? width : anchor === "middle" ? width / 2 : 0);
      if (left < right + 5) continue;
      right = left + width;
      kept.push({ value, x, label, anchor });
    }
    return kept;
  }
}

export interface Point {
  x: number;
  fixture: number;
  entry: Summary;
  dy: number;
}

export function stagger(points: Point[]): Point[] {
  const sorted = points
    .map((point) => ({ ...point }))
    .sort((a, b) => a.x - b.x || a.fixture - b.fixture);
  const spacing = points.some((point) => point.fixture >= 3) ? 22 : 10;
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end]!.x - sorted[end - 1]!.x < spacing) end++;
    for (let i = start; i < end; i++) sorted[i]!.dy = (i - start - (end - start - 1) / 2) * spacing;
    start = end;
  }
  return sorted;
}

function marker(
  s: Svg,
  fixture: number,
  x: number,
  y: number,
  fill: string,
  stroke: string,
  title?: string,
) {
  const attrs = { fill, stroke, stroke_width: 1.2 };
  const body = title ? `<title>${esc(title)}</title>` : undefined;
  switch (fixture % 3) {
    case 0:
      s.add("circle", { ...attrs, cx: x, cy: y, r: DOT }, body);
      break;
    case 1:
      s.add(
        "rect",
        { ...attrs, x: x - DOT, y: y - DOT, width: DOT * 2, height: DOT * 2, rx: 0.5 },
        body,
      );
      break;
    case 2:
      s.add("path", { ...attrs, d: `M${x} ${y - 4.5}l4.5 4.5-4.5 4.5-4.5-4.5z` }, body);
      break;
  }
  if (fixture >= 3) s.text(x, y - 7, String(fixture + 1), 9, INK, "middle", 700);
}

// The runtime's logo fitted into an ICON px square centered on (x, y).
function runtimeIcon(s: Svg, runtime: Runtime, x: number, y: number, title?: string) {
  const { width, height, svg } = ICONS[runtime];
  const scale = ICON / Math.max(width, height);
  s.add(
    "g",
    {
      fill: RUNTIME_COLOR[runtime],
      transform: `translate(${(x - (width * scale) / 2).toFixed(2)} ${(y - (height * scale) / 2).toFixed(2)}) scale(${scale.toFixed(4)})`,
    },
    (title ? `<title>${esc(title)}</title>` : "") + svg,
  );
}

// Under the version: what the manager itself takes on disk, when the run recorded it, and
// in the warm chart what restoring it from a CI cache would cost.
function sizeLabel(runner: Runner, ci: boolean): string {
  const size = runner.bytes ? `${fmtBytes(runner.bytes)} on disk` : "";
  const restore = ci && runner.packedBytes ? ciLabel(runner.packedBytes) : "";
  return [size, restore].filter(Boolean).join(" · ");
}

function ciMissing(runners: Runner[]): string {
  const missing = runners.filter((runner) => !runner.packedBytes);
  return missing.length
    ? ` No CI estimate: ${missing.map((runner) => `${runner.name} ${runner.version}`).join(", ")}.`
    : "";
}

// The row order shows the ranking; only an unranked manager says why.
function scoreLabel(score: Score): string {
  return score.value === null ? `unranked: ${score.reason}` : "";
}

export function build(data: Benchmark): string {
  const measure = MEASURE[data.measure];
  const isTime = data.measure === "time";
  const ci = showsCi(data) && data.runners.some((runner) => runner.packedBytes);
  const score = scores(data);
  const order = (runner: Runner) => score.get(runner)!.value ?? Infinity;
  data = { ...data, runners: data.runners.toSorted((a, b) => order(a) - order(b)) };
  const details = (runner: Runner) => [
    scoreLabel(score.get(runner)!),
    runner.version,
    sizeLabel(runner, ci),
  ];
  const entries = [...data.groups.values()];
  const values = entries.map((entry) => entry.value ?? entry.failedValue!);
  const series = data.runners.map((runner) =>
    data.phases.map((phase) =>
      data.fixtures.flatMap((fixture, i) => {
        const entry = data.groups.get(key(phase, runner, fixture));
        return entry ? [{ fixture: i, entry }] : [];
      }),
    ),
  );
  // In the warm chart the animation adds each manager's CI restore, so the axis fits both.
  const restore = (runner: Runner) =>
    ci && runner.packedBytes ? restoreMs(runner.packedBytes) : 0;
  const withRestore = data.runners.flatMap((runner, ri) =>
    series[ri]!.flat().map(({ entry }) => (entry.value ?? entry.failedValue!) + restore(runner)),
  );
  const labelWidth = Math.max(
    104,
    Math.min(
      160,
      Math.max(
        ...data.runners.map(
          (runner) =>
            Math.max(
              textWidth(runner.name, 13) + (RUNTIME[runner.name] ? ICON + 6 : 0),
              ...details(runner).map((line) => textWidth(line, 10)),
            ) + 12,
        ),
      ),
    ),
  );
  // A chart of one phase needs no run column.
  const single = data.phases.length === 1;
  const phaseWidth = single ? 0 : 48,
    plotX = PAD + labelWidth + phaseWidth;
  const width = WIDTH,
    plotWidth = width - plotX - PAD;
  const axis = new Axis(
    [...values, ...withRestore],
    plotWidth,
    data.measure === "memory" ? fmtBytes : timeLabel,
  );
  const legendStart = plotX + 112;
  let legendX = legendStart,
    legendY = 0,
    legendRowHeight = 28;
  const fixtureLegend = data.fixtures.map((fixture, i) => {
    const text = wrap(fixture, plotWidth - 138, 11);
    const itemWidth = Math.max(...text.map((line) => textWidth(line, 11))) + 26;
    if (legendX > legendStart && legendX + itemWidth > width - PAD) {
      legendX = legendStart;
      legendY += legendRowHeight;
      legendRowHeight = 28;
    }
    const item = { fixture: i, text, x: legendX, y: legendY };
    legendX += itemWidth;
    legendRowHeight = Math.max(legendRowHeight, text.length * 14 + 14);
    return item;
  });
  const lines = series.map((row) =>
    row.map((points) =>
      stagger(
        points.map(({ fixture, entry }) => ({
          x: plotX + axis.x(entry.value ?? entry.failedValue!),
          fixture,
          entry,
          dy: 0,
        })),
      ),
    ),
  );
  const phaseHeights = lines.map((row) =>
    row.map((points) =>
      Math.max(
        16,
        ...points.map((point) => Math.abs(point.dy) * 2 + (point.fixture >= 3 ? 28 : 12)),
      ),
    ),
  );
  const contentHeights = phaseHeights.map((row) => row.reduce((sum, height) => sum + height, 0));
  const fitHeights = data.runners.map((runner, i) =>
    Math.max(
      contentHeights[i]! + 6,
      wrap(runner.name, labelWidth - 12, 13).length * 16 +
        details(runner).flatMap((line) => wrap(line, labelWidth - 12, 10)).length * 13 +
        10,
    ),
  );
  const title = `Package manager benchmarks${single ? ` · ${PHASE_LABEL[data.phases[0]!]} install` : ""}${isTime ? "" : ` · ${measure.label}`}`;
  const subtitle = `${(isTime ? METRIC_LABEL : AMOUNT_LABEL)[data.metric]} ${measure.label} · lower is better · ranked by overall score`;
  const subtitleLines = wrap(subtitle, width - PAD * 2, 12);
  const legend = data.phases.map((phase) => `${PHASE_LABEL[phase]}: ${PHASE_TEXT[phase]}`);
  const legendLines = wrap(legend.join("   ·   "), width - PAD * 2, 12);
  const headerTop = PAD + 57 + subtitleLines.length * 16 + legendLines.length * 15;
  const plotTop = headerTop + legendY + legendRowHeight - 28;
  const missing = data.runners.flatMap((runner) =>
    data.phases.flatMap((phase) => {
      const fixtures = data.fixtures.filter(
        (fixture) => !data.groups.has(key(phase, runner, fixture)),
      );
      return fixtures.length
        ? [`${runner.name} ${runner.version}/${phase}: ${fixtures.join(", ")}`]
        : [];
    }),
  );
  const runs = single
    ? range(entries.map((entry) => entry.samples))
    : sampleCounts(data).replaceAll(" n=", " ");
  // Kept to a few short lines: the charts get shared on their own, to readers new to upm.
  const notes = [
    ...(entries.some((entry) => entry.failedTimes.length)
      ? ["Red outline: some runs failed. Hollow: all runs failed."]
      : []),
    ...(isTime ? [] : [MEASURE_NOTE[data.measure]]),
    `Score: times the ${isTime ? "fastest" : "lowest"} result per project, averaged. Runs per project: ${runs}.`,
    ...(missing.length ? [`Not run: ${missing.join("; ")}`] : []),
    ...(ci
      ? [
          `CI: the animation adds the estimated time to restore the manager from GitHub's cache, once per job, as a dashed line. Not scored; npm ships with Node.${ciMissing(data.runners)}`,
        ]
      : []),
    ...warnings(data),
  ].flatMap((note) =>
    wrap(note, width - PAD * 2, 10).map((text) => ({ text, warning: note.startsWith("▲") })),
  );
  const runtimes = [...new Set(data.runners.flatMap((runner) => RUNTIME[runner.name] ?? []))];
  const footHeight = (notes.length + (runtimes.length ? 1 : 0)) * 15 + PAD - 4;
  const fitHeight = fitHeights.reduce((sum, n) => sum + n, 0);
  const spare = Math.max(0, HEIGHT - plotTop - fitHeight - 36 - footHeight);
  const rowHeights = fitHeights.map((n) => n + spare / fitHeights.length);
  const plotBottom = plotTop + fitHeight + spare;
  const footTop = plotBottom + 36;
  const height = footTop + footHeight;
  const s = new Svg();
  open(
    s,
    width,
    height,
    title,
    `${data.metric} ${isTime ? "install times" : measure.label} for ${data.runners.map((r) => `${r.name} ${r.version}`).join(", ")}; fixtures: ${data.fixtures.join(", ")}. ${subtitle}. ${data.rows.length} timed runs. Shapes identify projects; exact values are in marker tooltips. Managers with a clean time in every case are ranked by score, the geometric mean of their time over the best ranked time per run and project; the rest follow as unranked. Logos next to manager names show what each runs on; the size under a version is the manager itself on disk${ci ? ", then its estimated CI cache restore" : ""}. Overlapping markers are separated vertically without changing their time.`,
  );
  s.text(PAD, PAD + 19, title, 21, INK, "start", 700);
  subtitleLines.forEach((line, i) => s.text(PAD, PAD + 40 + i * 16, line, 12, MUTED));
  legendLines.forEach((line, i) =>
    s.text(PAD, PAD + 42 + subtitleLines.length * 16 + i * 15, line, 12, MUTED),
  );
  s.text(PAD, headerTop - 13, "MANAGER", 10, MUTED, "start", 600);
  if (!single) s.text(PAD + labelWidth, headerTop - 13, "RUN", 10, MUTED, "start", 600);
  s.text(plotX, headerTop - 13, "PROJECT", 10, MUTED, "start", 600);
  if (ci) {
    s.parts.push(CI_STYLE);
    const y = headerTop - 13;
    s.parts.push(`<g class="ci-out">`);
    s.text(width - PAD, y, "Install only (measured)", 12, COLOR.warm, "end", 700);
    s.parts.push(`</g><g class="ci-in">`);
    // Faded dashes in the text itself key the restore line.
    s.add(
      "text",
      { x: width - PAD, y, font_size: 12, fill: INK, text_anchor: "end", font_weight: 700 },
      `<tspan fill="${COLOR.warm}" fill-opacity="0.45">– –</tspan> In CI: + restoring the manager (estimated)`,
    );
    s.parts.push(`</g>`);
  }
  for (const item of fixtureLegend) {
    marker(s, item.fixture, item.x + 4, headerTop - 17 + item.y, MUTED, MUTED);
    item.text.forEach((line, i) =>
      s.text(item.x + 15, headerTop - 13 + item.y + i * 14, line, 11, INK),
    );
  }
  let top = plotTop;
  data.runners.forEach((runner, i) => {
    if (runner.name === "upm" || i % 2 === 0)
      s.add("rect", {
        x: PAD - 10,
        y: top,
        width: width - PAD * 2 + 20,
        height: rowHeights[i]!,
        rx: 4,
        fill: runner.name === "upm" ? UPM_ROW : STRIPE,
      });
    top += rowHeights[i]!;
    s.line(PAD - 10, top, width - PAD + 10, top, GRID, 0.7);
  });
  for (const tick of axis.ticks()) {
    s.line(plotX + tick.x, plotTop, plotX + tick.x, plotBottom, GRID);
    s.text(plotX + tick.x, plotBottom + 20, tick.label, 10, MUTED, tick.anchor);
  }
  top = plotTop;
  data.runners.forEach((runner, ri) => {
    const runtime = RUNTIME[runner.name];
    const nameLines = wrap(runner.name, labelWidth - 12 - (runtime ? ICON + 6 : 0), 13);
    const versions = details(runner).flatMap((line) => wrap(line, labelWidth - 12, 10));
    let nameY = top + (rowHeights[ri]! - nameLines.length * 16 - versions.length * 13) / 2 + 12;
    nameLines.forEach((line, i) => {
      s.text(PAD, nameY, line, 13, INK, "start", runner.name === "upm" ? 700 : 600);
      if (runtime && i === nameLines.length - 1)
        runtimeIcon(
          s,
          runtime,
          PAD + textWidth(line, 13) + 6 + ICON / 2,
          nameY - 4.5,
          `${runner.name}: ${RUNTIME_LABEL[runtime]}`,
        );
      nameY += 16;
    });
    const size = runner.bytes ? fmtBytes(runner.bytes) : "";
    for (const line of versions) {
      if (size && line === sizeLabel(runner, ci))
        s.rich(
          PAD,
          nameY,
          [
            [size, true],
            [line.slice(size.length), false],
          ],
          10,
          MUTED,
        );
      else s.text(PAD, nameY, line, 10, MUTED);
      nameY += 13;
    }
    let phaseTop = top + (rowHeights[ri]! - contentHeights[ri]!) / 2;
    data.phases.forEach((phase, pi) => {
      const height = phaseHeights[ri]![pi]!;
      const cy = phaseTop + height / 2;
      phaseTop += height;
      if (!single) s.text(PAD + labelWidth, cy + 4, PHASE_LABEL[phase], 11, COLOR[phase]);
      const points = lines[ri]![pi]!;
      const shift = points.length ? axis.x(restore(runner)) : 0;
      // The row's line stretches by the restore: this piece grows out of the first marker just
      // as fast as the markers move away from it.
      if (shift) {
        const x = points[0]!.x;
        s.add("line", {
          class: "ci-grow",
          x1: x,
          y1: cy,
          x2: x + shift,
          y2: cy,
          stroke: COLOR[phase],
          stroke_opacity: 0.45,
          stroke_width: 0.8,
          stroke_dasharray: "4 3",
        });
        s.parts.push(`<g class="ci-move" style="--dx:${Math.round(shift * 100) / 100}px">`);
      }
      if (points.length > 1) s.line(points[0]!.x, cy, points.at(-1)!.x, cy, COLOR[phase], 0.55);
      for (const point of points) {
        const failed = point.entry.failedTimes.length > 0;
        if (point.dy) s.line(point.x, cy, point.x, cy + point.dy, COLOR[phase], 0.55);
        const { times } = point.entry;
        const range = times.length
          ? `${measure.format(Math.min(...times))}–${measure.format(Math.max(...times))}`
          : "none";
        const title = `${runner.name} ${runner.version} · ${phase} · ${data.fixtures[point.fixture]}: ${caption(point.entry, measure.format)}; ${times.length}/${point.entry.samples} successful runs; successful range ${range}`;
        marker(
          s,
          point.fixture,
          point.x,
          cy + point.dy,
          point.entry.value === null ? SURFACE : COLOR[phase],
          failed ? BAD : SURFACE,
          title,
        );
      }
      if (shift) s.parts.push("</g>");
      // The row's range across projects, after its last marker, or before its measured first
      // if no room.
      const rangeLabel = (add: number, prefix: string, cls?: string) => {
        const [lo, hi] = [points[0]!, points.at(-1)!].map((point) =>
          measure.format((point.entry.value ?? point.entry.failedValue!) + add),
        );
        const label = prefix + (lo === hi ? lo! : `${lo} – ${hi}`);
        if (cls) s.parts.push(`<g class="${cls}">`);
        const after = points.at(-1)!.x + axis.x(add) + 9;
        if (after + textWidth(label, 10) <= width - PAD) s.text(after, cy + 3.5, label, 10, MUTED);
        else s.text(points[0]!.x - 9, cy + 3.5, label, 10, MUTED, "end");
        if (cls) s.parts.push("</g>");
      };
      if (points.length) rangeLabel(0, "", shift ? "ci-out" : undefined);
      if (shift) rangeLabel(restore(runner), "~", "ci-in");
    });
    top += rowHeights[ri]!;
  });
  notes.forEach((note, i) =>
    s.text(PAD, footTop + i * 15, note.text, 10, note.warning ? WARN : MUTED),
  );
  runtimeLegend(s, runtimes, footTop + notes.length * 15);
  s.parts.push("</svg>");
  return s.parts.join("\n") + "\n";
}

// A footer line naming the runtime logos that appear.
function runtimeLegend(s: Svg, runtimes: Runtime[], y: number) {
  if (!runtimes.length) return;
  s.text(PAD, y, "Runtime:", 10, MUTED);
  let x = PAD + textWidth("Runtime:", 10) + 4;
  for (const runtime of runtimes) {
    runtimeIcon(s, runtime, x + ICON / 2, y - 3.5);
    x += ICON + 4;
    s.text(x, y, RUNTIME_LABEL[runtime], 10, MUTED);
    x += textWidth(RUNTIME_LABEL[runtime], 10) + 14;
  }
}

function open(s: Svg, width: number, height: number, title: string, description: string) {
  s.parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" font-family="${esc(FONT)}" role="img" aria-labelledby="title description">`,
  );
  s.add("title", { id: "title" }, esc(title));
  s.add("desc", { id: "description" }, esc(description));
  s.parts.push(THEME_STYLE);
  s.add("rect", { width, height, rx: 8, fill: SURFACE });
  s.add("rect", {
    x: 0.5,
    y: 0.5,
    width: width - 1,
    height: height - 1,
    rx: 8,
    fill: "none",
    stroke: BORDER,
  });
}

// A GitHub Actions cache restore step, fitted to actions/cache on ubuntu-latest: a fixed cost
// for the step and key lookup, a round trip per doubling while the download ramps up, then
// bandwidth.
const RESTORE = { baseMs: 490, doublingMs: 50, fromBytes: 16_000, mbps: 110 };
const restoreMs = (packed: number) =>
  RESTORE.baseMs +
  RESTORE.doublingMs * Math.log2(Math.max(packed, RESTORE.fromBytes) / RESTORE.fromBytes) +
  packed / (RESTORE.mbps * 1000);
// The warm chart loops between measured installs and installs after a CI restore. Without
// animation (reduced motion, static renderers) it stays on the measured view.
const CI_STYLE = `<style>
.ci-move { animation: ci-move 8s ease-in-out infinite }
.ci-grow { transform: scaleX(0); transform-box: fill-box; transform-origin: left center; animation: ci-grow 8s ease-in-out infinite }
.ci-in { opacity: 0; animation: ci-in 8s ease-in-out infinite }
.ci-out { animation: ci-out 8s ease-in-out infinite }
@keyframes ci-move { 0%, 35% { transform: translateX(0) } 50%, 85% { transform: translateX(var(--dx)) } 100% { transform: translateX(0) } }
@keyframes ci-grow { 0%, 35% { transform: scaleX(0) } 50%, 85% { transform: scaleX(1) } 100% { transform: scaleX(0) } }
@keyframes ci-in { 0%, 40% { opacity: 0 } 50%, 85% { opacity: 1 } 92%, 100% { opacity: 0 } }
@keyframes ci-out { 0%, 35% { opacity: 1 } 42%, 90% { opacity: 0 } 100% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .ci-move, .ci-grow, .ci-in, .ci-out { animation: none } }
</style>`;
// One decimal: runners varied 2.5× and the fit is off by up to 0.2 s.
const ciLabel = (packed: number) => `~${(restoreMs(packed) / 1000).toFixed(1)} s CI`;
// Only the warm time chart is the CI case: cache and lockfile restored, installed fresh.
const showsCi = (data: Benchmark) =>
  data.measure === "time" && data.phases.length === 1 && data.phases[0] === "warm";

// Each manager's own size on disk as a horizontal bar, smallest first, with what it costs
// to restore from a CI cache under it.
export function buildSize(data: Benchmark): string {
  const runners = data.runners
    .filter((runner) => runner.bytes)
    .toSorted((a, b) => a.bytes! - b.bytes!);
  if (!runners.length) throw new Error("no manager sizes in these results");
  const missing = data.runners.filter((runner) => !runner.bytes);
  // Ratios are against upm when it is charted, else the smallest.
  const base = (runners.find((runner) => runner.name === "upm") ?? runners[0]!).bytes!;
  const ratio = (bytes: number) => {
    const n = bytes / base;
    return `${n >= 10 ? Math.round(n) : Number(n.toFixed(1))}×`;
  };
  const valueLabel = (runner: Runner) => `${fmtBytes(runner.bytes!)} · ${ratio(runner.bytes!)}`;
  const restoreLabel = (runner: Runner) =>
    runner.packedBytes
      ? `${fmtBytes(runner.packedBytes)} packed (${ciLabel(runner.packedBytes)})`
      : "";
  const labelWidth =
    Math.max(
      92,
      ...runners.map((runner) =>
        Math.max(
          textWidth(runner.name, 13) + (RUNTIME[runner.name] ? ICON + 6 : 0),
          textWidth(runner.version, 10),
        ),
      ),
    ) + 12;
  const plotX = PAD + labelWidth;
  const valueWidth =
    Math.max(
      ...runners.map((runner) =>
        Math.max(textWidth(valueLabel(runner), 11), textWidth(restoreLabel(runner), 10)),
      ),
    ) + 8;
  const width = WIDTH,
    plotWidth = width - plotX - valueWidth - PAD;
  const axis = new Axis(
    runners.map((runner) => runner.bytes!),
    plotWidth,
    fmtBytes,
  );
  const title = "Package manager size";
  const subtitle = runners.some((runner) => runner.packedBytes)
    ? "Size on disk and estimated CI cache restore · smaller is better"
    : "Size on disk · smaller is better";
  const notes = [
    "Each manager's own files on disk. Bun and Deno include their runtime.",
    ...(runners.some((runner) => runner.packedBytes)
      ? [
          "Packed: as tar.zst, the way GitHub's actions/cache stores it. CI: estimated time to restore it, fitted to measured restores.",
        ]
      : []),
    ...(missing.length
      ? [
          `No size recorded: ${missing.map((runner) => `${runner.name} ${runner.version}`).join(", ")}`,
        ]
      : []),
  ].flatMap((note) => wrap(note, width - PAD * 2, 10));
  const runtimes = [...new Set(runners.flatMap((runner) => RUNTIME[runner.name] ?? []))];
  const footHeight = (notes.length + (runtimes.length ? 1 : 0)) * 15 + PAD - 4;
  const plotTop = PAD + 64;
  const rowHeight = Math.max(34, (HEIGHT - plotTop - 44 - footHeight) / runners.length),
    bar = Math.round(rowHeight * 0.4);
  const plotBottom = plotTop + runners.length * rowHeight;
  const footTop = plotBottom + 44;
  const height = footTop + footHeight;
  const s = new Svg();
  open(
    s,
    width,
    height,
    title,
    `On-disk size of ${runners.map((runner) => `${runner.name} ${runner.version}: ${fmtBytes(runner.bytes!)}`).join(", ")}. ${subtitle}.`,
  );
  s.text(PAD, PAD + 19, title, 21, INK, "start", 700);
  s.text(PAD, PAD + 40, subtitle, 12, MUTED);
  runners.forEach((runner, i) => {
    const top = plotTop + i * rowHeight;
    if (runner.name === "upm" || i % 2 === 0)
      s.add("rect", {
        x: PAD - 10,
        y: top,
        width: width - PAD * 2 + 20,
        height: rowHeight,
        rx: 4,
        fill: runner.name === "upm" ? UPM_ROW : STRIPE,
      });
  });
  for (const tick of axis.ticks()) {
    s.line(plotX + tick.x, plotTop, plotX + tick.x, plotBottom, GRID);
    s.text(plotX + tick.x, plotBottom + 20, tick.label, 10, MUTED, tick.anchor);
  }
  runners.forEach((runner, i) => {
    const cy = plotTop + i * rowHeight + rowHeight / 2;
    const upm = runner.name === "upm";
    s.text(PAD, cy - 1, runner.name, 13, INK, "start", upm ? 700 : 600);
    const runtime = RUNTIME[runner.name];
    if (runtime)
      runtimeIcon(
        s,
        runtime,
        PAD + textWidth(runner.name, 13) + 6 + ICON / 2,
        cy - 5.5,
        `${runner.name}: ${RUNTIME_LABEL[runtime]}`,
      );
    s.text(PAD, cy + 12, runner.version, 10, MUTED);
    // At least 2 px, so the smallest manager still shows a bar.
    const length = Math.max(2, axis.x(runner.bytes!));
    s.add(
      "rect",
      {
        x: plotX,
        y: cy - bar / 2,
        width: length,
        height: bar,
        rx: 2,
        fill: upm ? COLOR.cold : BAR,
      },
      `<title>${esc(`${runner.name} ${runner.version}: ${[`${fmtBytes(runner.bytes!)} on disk`, restoreLabel(runner)].filter(Boolean).join(", ")}`)}</title>`,
    );
    const restore = restoreLabel(runner);
    s.text(
      plotX + length + 6,
      restore ? cy - 1 : cy + 4,
      valueLabel(runner),
      11,
      upm ? INK : MUTED,
      "start",
      upm ? 700 : 400,
    );
    if (restore) s.text(plotX + length + 6, cy + 12, restore, 10, MUTED);
  });
  notes.forEach((note, i) => s.text(PAD, footTop + i * 15, note, 10, MUTED));
  runtimeLegend(s, runtimes, footTop + notes.length * 15);
  s.parts.push("</svg>");
  return s.parts.join("\n") + "\n";
}

export function newestResults(dir: string | URL = new URL("./results/", import.meta.url)): string {
  let entries: Dirent[];
  try {
    entries = builtin.fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = [];
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const path = builtin.path.join(entry.parentPath, entry.name);
      return { path, mtime: builtin.fs.statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? 1 : -1));
  if (!files.length) throw new Error("no results in bench/results/ — run bench/bench.sh first");
  return files[0]!.path;
}

// One chart per phase: phases differ by orders of magnitude, which a linear axis cannot share.
export function main(args = process.argv.slice(2)) {
  const options = parseArgs(args, true);
  if (options.help) {
    console.log(
      "Usage: node bench/chart.ts [results.jsonl ...] [-o out.svg] [--metric min|max|median|mean] [--phase cold|warm|repeat] [--measure time|memory|cpu] [--size]\nDefaults to the newest bench/results/*.jsonl and install time. --phase is repeatable.\nWrites one chart per phase: <stamp>.<phase>.svg, or <stamp>.<phase>.memory.svg and .cpu.svg.\nWith -o and one phase, writes that file; with several, inserts the phase before .svg.\nWith -o <dir>/, writes <dir>/<phase>.svg and the like, for charts at a fixed path.\n--size writes one chart of each manager's size on disk instead: <stamp>.size.svg, -o as given, or <dir>/size.svg.",
    );
    return;
  }
  const sources = options.results.length ? options.results : [newestResults()];
  const measure = options.measure ?? "time";
  const rows = load(sources);
  const dir = options.out && /[\\/]$/.test(options.out) ? options.out : undefined;
  const base = options.out ?? sources[0]!;
  const stem = base.slice(0, base.length - builtin.path.extname(base).length);
  let charts: { out: string; svg: () => string }[];
  if (options.size) {
    charts = [
      {
        out: dir ? builtin.path.join(dir, "size.svg") : (options.out ?? `${stem}.size.svg`),
        svg: () => buildSize(aggregate(rows, options.metric, options.phases)),
      },
    ];
  } else {
    const { phases } = aggregate(rows, options.metric, options.phases, measure);
    const suffix = measure === "time" ? ".svg" : `.${measure}.svg`;
    charts = phases.map((phase) => ({
      out: dir
        ? builtin.path.join(dir, phase + suffix)
        : options.out && phases.length === 1
          ? options.out
          : `${stem}.${phase}${suffix}`,
      svg: () => build(aggregate(rows, options.metric, [phase], measure)),
    }));
  }
  if (dir) builtin.fs.mkdirSync(dir, { recursive: true });
  for (const { out } of charts) {
    const target = builtin.fs.statSync(out, { throwIfNoEntry: false });
    if (
      sources.some((source) => {
        const input = builtin.fs.statSync(source);
        return (
          builtin.path.resolve(source) === builtin.path.resolve(out) ||
          (target && input.dev === target.dev && input.ino === target.ino)
        );
      })
    )
      throw new Error("output must not overwrite a results file");
  }
  for (const { out, svg } of charts) {
    builtin.fs.writeFileSync(out, svg());
    console.log(out);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`chart: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

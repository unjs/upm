// The progress line `cli.ts` draws on a terminal. Loaded only when one can be drawn.
import type { Progress } from "./api.ts";

/** What each phase last reported. */
export type Seen = Partial<Record<Progress["phase"], Progress>>;

export interface Bar {
  hear: (progress: Progress) => void;
  /** Takes the line off the screen; the next tick draws it again. */
  clear: () => void;
  stop: () => void;
}

/** A command under this long never draws, so a fast one prints its summary alone. */
const DELAY = 1000;
const WIDTH = 20;

/**
 * What it hears is kept, and drawn a second in, then every 100 ms it changes. Never in CI or
 * on a terminal that cannot move the cursor.
 */
export function startBar(
  stream: NodeJS.WriteStream,
  gray: (text: string) => string,
  env: Record<string, string | undefined> = globalThis.process.env,
): Bar | undefined {
  if ((env.CI !== undefined && env.CI !== "false") || env.TERM === "dumb") return undefined;
  const seen: Seen = {};
  let shown = "";
  const draw = () => {
    const line = barLine(seen, (stream.columns || 80) - 1, gray);
    if (line === shown) return;
    stream.write(`\r${line}\x1b[K`);
    shown = line;
  };
  // Either handle clears with `clearTimeout`.
  let timer = setTimeout(() => {
    timer = setInterval(draw, 100).unref();
    draw();
  }, DELAY).unref();
  const clear = () => {
    if (shown) stream.write("\r\x1b[K");
    shown = "";
  };
  return {
    hear: (progress) => void (seen[progress.phase] = progress),
    clear,
    stop: () => {
      clearTimeout(timer);
      clear();
    },
  };
}

/**
 * Fetch and link each fill half the bar: they overlap, and the link finishes last. Past
 * `columns` the line would wrap and `\r` would redraw only its tail, so the bar goes first.
 */
export function barLine(
  { resolve, fetch, link }: Seen,
  columns: number,
  gray = (text: string) => text,
): string {
  if (!fetch && !link) return resolve ? `resolving ${resolve.done} packages`.slice(0, columns) : "";
  const linked = link?.done ?? 0;
  const counts = fetch
    ? `${fetch.done}/${fetch.total} fetched, ${linked} linked`
    : `${linked}/${link!.total} linked`;
  if (counts.length + WIDTH + 1 > columns) return counts.slice(0, columns);
  const done = fetch ? (fetch.done + linked) / (2 * fetch.total!) : linked / link!.total!;
  const full = Math.min(WIDTH, Math.round(done * WIDTH));
  const rest = full < WIDTH ? gray("░".repeat(WIDTH - full)) : "";
  return `${"█".repeat(full)}${rest} ${counts}`;
}

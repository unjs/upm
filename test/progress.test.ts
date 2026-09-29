import { afterEach, describe, expect, it, vi } from "vitest";
import { barLine, startBar } from "../src/progress.ts";

describe("progress bar", () => {
  afterEach(() => void vi.useRealTimers());

  it("counts picks while resolving, then fills half each for fetch and link", () => {
    expect(barLine({}, 80)).toBe("");
    expect(barLine({ resolve: { phase: "resolve", done: 12 } }, 80)).toBe("resolving 12 packages");
    const fetch = { phase: "fetch", done: 10, total: 10 } as const;
    const link = { phase: "link", done: 5, total: 10 } as const;
    expect(barLine({ fetch, link }, 80)).toBe(
      `${"━".repeat(15)}${"─".repeat(5)} 10/10 fetched, 5 linked`,
    );
    expect(barLine({ link }, 80)).toBe(`${"━".repeat(10)}${"─".repeat(10)} 5/10 linked`);
    // Too narrow for the bar: the counts alone, cut to fit, so the line never wraps.
    expect(barLine({ fetch, link }, 30)).toBe("10/10 fetched, 5 linked");
    expect(barLine({ fetch, link }, 10)).toBe("10/10 fetc");
  });

  it("draws nothing in the first half second and clears its line when stopped", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const bar = startBar({ columns: 80, write } as unknown as NodeJS.WriteStream, (t) => t, {})!;
    bar.hear({ phase: "resolve", done: 3 });
    vi.advanceTimersByTime(400);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenLastCalledWith("\rresolving 3 packages\x1b[K");
    // Unchanged, so not drawn again.
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledTimes(1);
    bar.hear({ phase: "resolve", done: 4 });
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenLastCalledWith("\rresolving 4 packages\x1b[K");
    bar.stop();
    expect(write).toHaveBeenLastCalledWith("\r\x1b[K");
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("never starts in CI or on a dumb terminal", () => {
    const stream = { columns: 80, write: vi.fn() } as unknown as NodeJS.WriteStream;
    expect(startBar(stream, (t) => t, { CI: "true" })).toBeUndefined();
    expect(startBar(stream, (t) => t, { CI: "1" })).toBeUndefined();
    expect(startBar(stream, (t) => t, { TERM: "dumb" })).toBeUndefined();
    startBar(stream, (t) => t, { CI: "false" })!.stop();
  });

  it("stopped within half a second, never writes at all", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const bar = startBar({ columns: 80, write } as unknown as NodeJS.WriteStream, (t) => t, {})!;
    bar.hear({ phase: "fetch", done: 1, total: 2 });
    vi.advanceTimersByTime(400);
    bar.stop();
    vi.advanceTimersByTime(2000);
    expect(write).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import {
  NODEBOX_ORIGIN,
  isRunnable,
  nodeboxHeight,
  nodeboxPlaceholder,
  nodeboxSrc,
} from "./nodebox.ts";

async function decodeShareCode(query: string): Promise<unknown> {
  const base64 = query.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return JSON.parse(await new Response(inflated).text());
}

function placeholderSource(html: string): string {
  const attribute = /data-nodebox="([^"]*)"/.exec(html)![1]!;
  return attribute
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("isRunnable", () => {
  it("runs plain JavaScript fences in any case", () => {
    for (const lang of ["js", "javascript", "JS", "mjs", "cjs", "node"]) {
      expect(isRunnable(lang)).toBe(true);
    }
  });

  it("leaves shell, TypeScript, JSX, JSON and unlabeled fences as code", () => {
    for (const lang of ["sh", "bash", "ts", "typescript", "jsx", "tsx", "json", ""]) {
      expect(isRunnable(lang)).toBe(false);
    }
  });
});

describe("nodeboxHeight", () => {
  it("clamps to Nodebox's 6 to 16 visible lines", () => {
    expect(nodeboxHeight("a")).toBe(Math.round(6 * 22.3 + 70));
    expect(nodeboxHeight("a\n".repeat(9) + "a")).toBe(Math.round(10 * 22.3 + 70));
    expect(nodeboxHeight("a\n".repeat(99))).toBe(Math.round(16 * 22.3 + 70));
  });
});

describe("nodeboxPlaceholder", () => {
  it("keeps the source in an escaped attribute next to the highlighted code", () => {
    const code = `const a = "<b>" && '&'`;
    const html = nodeboxPlaceholder(code, "<pre>x</pre>");
    expect(placeholderSource(html)).toBe(code);
    expect(html.endsWith("<pre>x</pre></div>")).toBe(true);
  });
});

describe("nodeboxSrc", () => {
  const code = "const _ = require('lodash')\nreturn _.chunk([1, 2, 3, 4], 2)\n// ✓ ünïcode";

  it("points at the embed with the code in Nodebox's share format", async () => {
    const url = new URL(await nodeboxSrc(code, "light"));
    expect(url.origin + url.pathname).toBe(`${NODEBOX_ORIGIN}/e`);
    expect(url.searchParams.get("q")).toMatch(/^[\w-]+$/);
    expect(await decodeShareCode(url.searchParams.get("q")!)).toEqual({
      files: { "index.js": code },
    });
  });

  it("runs on load only when the reader asked to run it", async () => {
    expect(new URL(await nodeboxSrc(code, "light")).searchParams.has("autorun")).toBe(false);
    expect(
      new URL(await nodeboxSrc(code, "light", { autorun: false })).searchParams.has("autorun"),
    ).toBe(false);
    expect(
      new URL(await nodeboxSrc(code, "dark", { autorun: true })).searchParams.get("autorun"),
    ).toBe("1");
  });

  it("matches the README's light and dark code backgrounds", async () => {
    const light = new URL(await nodeboxSrc(code, "light")).searchParams;
    const dark = new URL(await nodeboxSrc(code, "dark")).searchParams;
    expect([light.get("theme"), light.get("background")]).toEqual(["microlink", "ffffff"]);
    expect([dark.get("theme"), dark.get("background")]).toEqual(["vercel", "18181b"]);
  });
});

import type { Scheme } from "../theme.ts";

export const NODEBOX_ORIGIN = "https://nodebox.microlink.io";

const NODE_FENCE_LANGUAGES = new Set(["js", "javascript", "mjs", "cjs", "node", "nodejs"]);

const NODEBOX_ENTRY_FILE = "index.js";

const APPEARANCE_BY_SCHEME: Record<Scheme, Record<string, string>> = {
  light: { theme: "microlink", background: "ffffff", accent: "b45309" },
  dark: { theme: "vercel", background: "18181b", accent: "fbbf24" },
};

const NODEBOX_LINE_HEIGHT = 22.3;
const NODEBOX_MIN_LINES = 6;
const NODEBOX_MAX_LINES = 16;
const NODEBOX_HEADER_AND_FOOTER_HEIGHT = 28 + 40 + 2;

export function isRunnable(lang: string): boolean {
  return NODE_FENCE_LANGUAGES.has(lang.toLowerCase());
}

export function nodeboxHeight(code: string): number {
  const lines = Math.min(Math.max(code.split("\n").length, NODEBOX_MIN_LINES), NODEBOX_MAX_LINES);
  return Math.round(lines * NODEBOX_LINE_HEIGHT + NODEBOX_HEADER_AND_FOOTER_HEIGHT);
}

export function nodeboxPlaceholder(code: string, highlighted: string): string {
  return `<div class="nodebox" data-nodebox="${escapeAttribute(code)}">${highlighted}</div>`;
}

export async function nodeboxSrc(code: string, scheme: Scheme): Promise<string> {
  const url = new URL("/e", NODEBOX_ORIGIN);
  url.searchParams.set("q", await encodeShareCode(code));
  for (const [key, value] of Object.entries(APPEARANCE_BY_SCHEME[scheme])) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

async function encodeShareCode(code: string): Promise<string> {
  const payload = JSON.stringify({ files: { [NODEBOX_ENTRY_FILE]: code } });
  const deflated = new Blob([payload]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return toBase64Url(new Uint8Array(await new Response(deflated).arrayBuffer()));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (char) => ATTRIBUTE_ESCAPES[char]!);
}

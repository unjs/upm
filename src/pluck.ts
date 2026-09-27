// One member out of a packument's bytes without parsing the rest. A corgi document carries
// every version ever published, and the walk wants one of them (the pinned version, or the
// tagged one when it fits the range): on `nuxt` 79% of the 58 MB read is documents whose one
// wanted version is a few KB.
//
// The member is reached the way `JSON.parse` would reach it — the root's members to
// `versions`, then its members to the key — so nothing a manifest's own content holds can
// stand in for it. Skipping bytes by structure is a third of parsing them, and only the
// member is decoded and parsed; on anything unexpected the caller parses the document whole.
import type { Manifest } from "./types.ts";

export const QUOTE = 0x22;
const BACKSLASH = 0x5c;
export const COLON = 0x3a;
export const OPEN = 0x7b;

/** Byte class: 1 a quote, 2 opens an object or array, 3 closes one, 4 whitespace. */
export const CLASS = new Uint8Array(256);
CLASS[QUOTE] = 1;
CLASS[OPEN] = CLASS[0x5b] = 2;
CLASS[0x7d] = CLASS[0x5d] = 3;
CLASS[0x20] = CLASS[0x0a] = CLASS[0x0d] = CLASS[0x09] = 4;

export function space(bytes: Uint8Array, i: number): number {
  while (CLASS[bytes[i]!] === 4) i++;
  return i;
}

/** The index after the string opening at `i`, or -1 when it never closes. */
export function stringEnd(bytes: Uint8Array, i: number): number {
  const short = Math.min(bytes.length, i + 256);
  for (i++; i < short; i++) {
    const c = bytes[i];
    if (c === QUOTE) return i + 1;
    if (c === BACKSLASH) i++;
  }
  // A long one, a readme say: the next quote by native search, then whether it is escaped.
  for (;;) {
    const quote = bytes.indexOf(QUOTE, i);
    if (quote < 0) return -1;
    let slash = quote - 1;
    while (slash >= i && bytes[slash] === BACKSLASH) slash--;
    if ((quote - slash) % 2 === 1) return quote + 1; // after an even run of backslashes
    i = quote + 1;
  }
}

/** The index after the object opening at `i`, or -1. Structure only, nothing is checked. */
export function objectEnd(bytes: Uint8Array, i: number): number {
  for (let depth = 0; i < bytes.length; i++) {
    const k = CLASS[bytes[i]!];
    if (k === 1) {
      i = stringEnd(bytes, i) - 1;
      if (i < 0) return -1;
    } else if (k === 2) depth++;
    else if (k === 3 && --depth === 0) return i + 1;
  }
  return -1;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Whether `needle` is written at `i`. A helper, not a closure: a closed-over `i` would live on the heap and slow the loop. */
export function at(bytes: Uint8Array, i: number, needle: Uint8Array): boolean {
  for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) return false;
  return true;
}

/**
 * Where the value under `key` starts in the object opening at `from`, or -1. A string one
 * level in, followed by a colon, is a key of that object and nothing else; keys are compared
 * as written, so one the registry escaped is not found and the caller parses whole.
 */
function member(bytes: Uint8Array, from: number, key: string): number {
  const needle = encoder.encode(`"${key}"`);
  let i = space(bytes, from);
  if (bytes[i] !== OPEN) return -1;
  for (let depth = 1; ++i < bytes.length;) {
    const k = CLASS[bytes[i]!];
    if (k === 1) {
      const end = stringEnd(bytes, i);
      if (end === -1) return -1;
      if (depth === 1 && end - i === needle.length && at(bytes, i, needle)) {
        const value = space(bytes, end);
        if (bytes[value] === COLON) return space(bytes, value + 1);
      }
      i = end - 1;
    } else if (k === 2) depth++;
    else if (k === 3 && --depth === 0) return -1;
  }
  return -1;
}

/** The object value starting at `at`, parsed; anything else is undefined. */
function parseObject(bytes: Uint8Array, at: number): Record<string, unknown> | undefined {
  if (at < 0 || bytes[at] !== OPEN) return undefined;
  const end = objectEnd(bytes, at);
  if (end < 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes.subarray(at, end)));
  } catch {
    return undefined;
  }
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The top-level `dist-tags`: the second member on npmjs, so the walk to it is short. */
export function pluckTags(bytes: Uint8Array): Record<string, string> | undefined {
  const tags = parseObject(bytes, member(bytes, 0, "dist-tags"));
  return tags && Object.values(tags).every((v) => typeof v === "string")
    ? (tags as Record<string, string>)
    : undefined;
}

/** The manifest under `versions[version]`, skipping the versions before it. */
export function pluckVersion(bytes: Uint8Array, version: string): Manifest | undefined {
  // A key JSON would escape is not searched for: how it was written is not known.
  if (JSON.stringify(version) !== `"${version}"`) return undefined;
  const versions = member(bytes, 0, "versions");
  return versions < 0
    ? undefined
    : (parseObject(bytes, member(bytes, versions, version)) as Manifest | undefined);
}

/** The top-level `time` of a full packument: each version's publish date. */
export function pluckTimes(bytes: Uint8Array): Record<string, string> | undefined {
  return parseObject(bytes, member(bytes, 0, "time")) as Record<string, string> | undefined;
}

/**
 * The top-level `modified`, when it is the document's last member as on npmjs: read off the
 * tail, not the megabytes before it. A `,` or `{` right before its quote cannot sit inside a
 * string, where that quote would be escaped, and the final `}` closes the root.
 */
export function pluckModified(bytes: Uint8Array): string | undefined {
  const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 96)));
  return /[,{]\s*"modified"\s*:\s*"([^"\\]*)"\s*\}\s*$/.exec(tail)?.[1];
}

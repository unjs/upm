// Members out of a packument's bytes without parsing the rest. A corgi document carries every
// version ever published, and the walk wants one or a few of them: on `nuxt` 79% of the 58 MB
// read is documents whose one wanted version is a few KB.
//
// A member is reached the way `JSON.parse` would reach it — the root's members to `versions`,
// then its members — so nothing a manifest's own content holds can stand in for it. Skipping
// bytes by structure is half the cost of parsing them, so the versions are found once
// (`indexVersions`) and kept with the document (`src/metadata.ts`); only a wanted version is
// then decoded and parsed. On anything unexpected the caller parses the document whole.

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
export const OPEN = 0x7b;
const CLOSE = 0x7d;
const COMMA = 0x2c;

/** Byte class: 1 a quote, 2 opens an object or array, 3 closes one, 4 whitespace. */
const CLASS = new Uint8Array(256);
CLASS[QUOTE] = 1;
CLASS[OPEN] = CLASS[0x5b] = 2;
CLASS[CLOSE] = CLASS[0x5d] = 3;
CLASS[0x20] = CLASS[0x0a] = CLASS[0x0d] = CLASS[0x09] = 4;

function space(bytes: Uint8Array, i: number): number {
  while (CLASS[bytes[i]!] === 4) i++;
  return i;
}

/** The index after the string opening at `i`, or -1 when it never closes. */
function stringEnd(bytes: Uint8Array, i: number): number {
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
function objectEnd(bytes: Uint8Array, i: number): number {
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

/** The index after the value starting at `i`, or -1. */
export function valueEnd(bytes: Uint8Array, i: number): number {
  const k = CLASS[bytes[i]!];
  if (k === 1) return stringEnd(bytes, i);
  if (k === 2) return objectEnd(bytes, i);
  // A number, `true`, `false` or `null`: up to what follows it.
  const from = i;
  while (i < bytes.length && bytes[i] !== COMMA && CLASS[bytes[i]!]! < 3) i++;
  return i > from ? i : -1;
}

/**
 * Each member of the object opening at `from`: `each` is given its key's bounds and where its
 * value starts, and says where the value ends (-1 when it is not well formed). The index after
 * the object, or -1.
 */
export function members(
  bytes: Uint8Array,
  from: number,
  each: (start: number, keyEnd: number, value: number) => number,
): number {
  let i = space(bytes, from);
  if (bytes[i] !== OPEN) return -1;
  i = space(bytes, i + 1);
  if (bytes[i] === CLOSE) return i + 1;
  for (;;) {
    if (bytes[i] !== QUOTE) return -1;
    const keyEnd = stringEnd(bytes, i);
    if (keyEnd < 0) return -1;
    let value = space(bytes, keyEnd);
    if (bytes[value] !== COLON) return -1;
    value = space(bytes, value + 1);
    const end = each(i, keyEnd, value);
    if (end < 0) return -1;
    i = space(bytes, end);
    if (bytes[i] === CLOSE) return i + 1;
    if (bytes[i] !== COMMA) return -1;
    i = space(bytes, i + 1);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Whether `needle` is written at `i`. A helper, not a closure: a closed-over `i` would live on the heap and slow the loop. */
export function at(bytes: Uint8Array, i: number, needle: Uint8Array): boolean {
  for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) return false;
  return true;
}

/**
 * Where each version's manifest sits in a packument's bytes: `[version, start, end, ...]`, in
 * document order.
 */
export type VersionIndex = (string | number)[];

const VERSIONS = encoder.encode('"versions"');

/**
 * The versions of a packument, found by structure in one pass. Undefined when there is no
 * `versions` object of objects, or it or a key in it is escaped, not plain ASCII or there twice
 * (`JSON.parse` keeps the last of two): the caller then parses whole.
 */
export function indexVersions(bytes: Uint8Array): VersionIndex | undefined {
  let index: VersionIndex | undefined;
  let ok = true;
  const root = members(bytes, 0, (start, keyEnd, value) => {
    if (keyEnd - start !== VERSIONS.length || !at(bytes, start, VERSIONS)) {
      return valueEnd(bytes, value);
    }
    if (index) ok = false;
    const found: VersionIndex = (index = []);
    const seen = new Set<string>();
    return members(bytes, value, (from, to, manifest) => {
      const key = plain(bytes, from + 1, to - 1);
      if (key === undefined || seen.has(key)) ok = false;
      else seen.add(key);
      const end = bytes[manifest] === OPEN ? objectEnd(bytes, manifest) : -1;
      found.push(key!, manifest, end);
      return end;
    });
  });
  return root >= 0 && ok && space(bytes, root) === bytes.length ? index : undefined;
}

/** The text of a key with no escape, control or non-ASCII byte in it: a version has none. */
function plain(bytes: Uint8Array, from: number, to: number): string | undefined {
  let text = "";
  for (let i = from; i < to; i++) {
    const c = bytes[i]!;
    if (c < 0x20 || c > 0x7e || c === BACKSLASH) return undefined;
    text += String.fromCharCode(c);
  }
  return text;
}

/** The object from `start` to `end`, parsed; anything else is undefined. */
export function parseSlice(
  bytes: Uint8Array,
  start: number,
  end: number,
): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes.subarray(start, end)));
  } catch {
    return undefined;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Where the value under `key` starts in the root object, or -1. Keys are compared as written,
 * so one the registry escaped is not found and the caller parses whole.
 */
function member(bytes: Uint8Array, key: string): number {
  const needle = encoder.encode(`"${key}"`);
  let found = -1;
  members(bytes, 0, (start, keyEnd, value) => {
    if (keyEnd - start !== needle.length || !at(bytes, start, needle))
      return valueEnd(bytes, value);
    found = value;
    return -1; // found: the rest is not walked
  });
  return found;
}

/** The object value starting at `at`, parsed; anything else is undefined. */
function parseObject(bytes: Uint8Array, at: number): Record<string, unknown> | undefined {
  if (at < 0 || bytes[at] !== OPEN) return undefined;
  const end = objectEnd(bytes, at);
  return end < 0 ? undefined : parseSlice(bytes, at, end);
}

/** The top-level `dist-tags`: the second member on npmjs, so the walk to it is short. */
export function pluckTags(bytes: Uint8Array): Record<string, string> | undefined {
  const tags = parseObject(bytes, member(bytes, "dist-tags"));
  return tags && Object.values(tags).every((v) => typeof v === "string")
    ? (tags as Record<string, string>)
    : undefined;
}

/** The top-level `time` of a full packument: each version's publish date. */
export function pluckTimes(bytes: Uint8Array): Record<string, string> | undefined {
  return parseObject(bytes, member(bytes, "time")) as Record<string, string> | undefined;
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

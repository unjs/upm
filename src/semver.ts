// Minimal semver: parse, compare and npm range matching.

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
  build: string[];
  version: string;
}

const NUM = String.raw`0|[1-9]\d*`;
const ID = String.raw`(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)`;
const PRE = String.raw`${ID}(?:\.${ID})*`;
const BUILD = String.raw`[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*`;

const VERSION_RE = new RegExp(
  String.raw`^(${NUM})\.(${NUM})\.(${NUM})(?:-(${PRE}))?(?:\+(${BUILD}))?$`,
);

// Same shape but minor/patch optional and each part may be a wildcard.
const PART = String.raw`(${NUM}|[xX*])`;
const PARTIAL_RE = new RegExp(
  String.raw`^${PART}(?:\.${PART})?(?:\.${PART})?(?:-(${PRE}))?(?:\+${BUILD})?$`,
);

const OP_RE = /^(~>|[<>]=?|[~^]|=)?(.*)$/;

function ids(s: string): (string | number)[] {
  return s.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

export function parse(v: string): Version | undefined {
  if (typeof v !== "string") return undefined;
  const m = VERSION_RE.exec(v.trim().replace(/^[\s=v]+/, ""));
  if (!m) return undefined;
  const [, major, minor, patch, pre, build] = m as unknown as (string | undefined)[];
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre ? ids(pre) : [],
    build: build ? build.split(".") : [],
    version: `${major}.${minor}.${patch}${pre ? `-${pre}` : ""}`,
  };
}

function toVersion(v: string | Version): Version | undefined {
  return typeof v === "string" ? parse(v) : v;
}

function must(v: string | Version): Version {
  const p = toVersion(v);
  if (!p) throw new TypeError(`Invalid version: ${String(v)}`);
  return p;
}

function cmpNum(a: number, b: number): -1 | 0 | 1 {
  return a === b ? 0 : a < b ? -1 : 1;
}

function cmpPre(a: (string | number)[], b: (string | number)[]): -1 | 0 | 1 {
  if (a.length === 0 || b.length === 0) {
    return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  }
  for (let i = 0; ; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return y === undefined ? 0 : -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
}

export function compare(a: string | Version, b: string | Version): -1 | 0 | 1 {
  const x = must(a);
  const y = must(b);
  return (
    cmpNum(x.major, y.major) ||
    cmpNum(x.minor, y.minor) ||
    cmpNum(x.patch, y.patch) ||
    cmpPre(x.prerelease, y.prerelease)
  );
}

export function rcompare(a: string | Version, b: string | Version): -1 | 0 | 1 {
  return compare(b, a);
}

/** Unparseable entries are dropped: registry version lists are not trusted. */
export function sort(versions: string[]): string[] {
  return versions.filter((v) => parse(v)).sort(compare);
}

export function rsort(versions: string[]): string[] {
  return versions.filter((v) => parse(v)).sort(rcompare);
}

type Op = "<" | "<=" | ">" | ">=" | "=";
interface Comparator {
  op: Op;
  v: Version;
}

// A partial version; undefined fields are wildcards.
interface Partial {
  M?: number;
  m?: number;
  p?: number;
  pre: (string | number)[];
}

function mk(M: number, m: number, p: number, pre: (string | number)[] = []): Version {
  return {
    major: M,
    minor: m,
    patch: p,
    prerelease: pre,
    build: [],
    version: `${M}.${m}.${p}${pre.length > 0 ? `-${pre.join(".")}` : ""}`,
  };
}

function ge(M: number, m: number, p: number, pre?: (string | number)[]): Comparator {
  return { op: ">=", v: mk(M, m, p, pre) };
}

// Upper bounds end in `-0` so no prerelease of the excluded version slips in.
function lt(M: number, m: number, p: number): Comparator {
  return { op: "<", v: mk(M, m, p, [0]) };
}

function parsePartial(s: string): Partial | undefined {
  const m = PARTIAL_RE.exec(s.trim().replace(/^[=v]+/, ""));
  if (!m) return undefined;
  const num = (x: string | undefined) =>
    x === undefined || /^[xX*]$/.test(x) ? undefined : Number(x);
  const [M, mi, p] = [m[1], m[2], m[3]].map(num);
  // A concrete part may not follow a wildcard one.
  const gap =
    M === undefined ? mi !== undefined || p !== undefined : mi === undefined && p !== undefined;
  if (gap) return undefined;
  // A prerelease needs all three parts, so `v2-latest` stays a tag rather than a range.
  if (m[4] !== undefined && p === undefined) return undefined;
  return { M, m: mi, p, pre: m[4] ? ids(m[4]) : [] };
}

// `incPr` lowers derived bounds to `-0` so prereleases fall inside them.
function expand(op: string, q: Partial, incPr: boolean): Comparator[] {
  const { M, m, p } = q;
  // Only bounds derived from a partial version get lowered.
  const partial = m === undefined || p === undefined;
  const pre = q.pre.length > 0 ? q.pre : incPr && partial ? [0] : [];
  if (M === undefined) {
    // `*` matches anything; `>*` / `<*` match nothing.
    return op === ">" || op === "<" ? [lt(0, 0, 0)] : [];
  }
  if (op === "^" || op === "~") {
    const low = ge(M, m ?? 0, p ?? 0, pre);
    if (m === undefined) return [low, lt(M + 1, 0, 0)];
    if (op === "~") return [low, lt(M, m + 1, 0)];
    if (M !== 0) return [low, lt(M + 1, 0, 0)];
    // Caret on 0.x pins the minor, on 0.0.x the patch.
    return m === 0 && p !== undefined ? [low, lt(0, 0, p + 1)] : [low, lt(0, m + 1, 0)];
  }
  if (m === undefined || p === undefined) {
    if (op === "" || op === "=") {
      return m === undefined
        ? [ge(M, 0, 0, pre), lt(M + 1, 0, 0)]
        : [ge(M, m, 0, pre), lt(M, m + 1, 0)];
    }
    // A comparator against a partial version shifts to the next whole range.
    let major = M;
    let minor = m ?? 0;
    let o = op;
    if (op === ">" || op === "<=") {
      o = op === ">" ? ">=" : "<";
      if (m === undefined) major++;
      else minor++;
    }
    return [{ op: o as Op, v: mk(major, minor, 0, o === "<" ? [0] : pre) }];
  }
  return [{ op: (op || "=") as Op, v: mk(M, m, p, q.pre) }];
}

function hyphen(a: Partial, b: Partial, incPr: boolean): Comparator[] {
  const out: Comparator[] = [];
  const low = a.pre.length > 0 ? a.pre : incPr ? [0] : [];
  if (a.M !== undefined) out.push(ge(a.M, a.m ?? 0, a.p ?? 0, low));
  if (b.M !== undefined) {
    if (b.m === undefined) out.push(lt(b.M + 1, 0, 0));
    else if (b.p === undefined) out.push(lt(b.M, b.m + 1, 0));
    else if (b.pre.length === 0 && incPr) out.push(lt(b.M, b.m, b.p + 1));
    else out.push({ op: "<=", v: mk(b.M, b.m, b.p, b.pre) });
  }
  return out;
}

function parseSet(branch: string, incPr: boolean): Comparator[] | undefined {
  const tokens = branch
    .trim()
    .replace(/(~>|[<>]=?|[~^]|=)\s+/g, "$1")
    .split(/\s+/)
    .filter(Boolean);
  const set: Comparator[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i + 1] === "-") {
      const a = parsePartial(tokens[i] as string);
      const b = parsePartial(tokens[i + 2] ?? "");
      if (!a || !b) return undefined;
      set.push(...hyphen(a, b, incPr));
      i += 2;
      continue;
    }
    const m = OP_RE.exec(tokens[i] as string);
    const q = m && parsePartial(m[2] ?? "");
    if (!m || !q) return undefined;
    set.push(...expand(m[1] === "~>" ? "~" : (m[1] ?? ""), q, incPr));
  }
  return set;
}

// Ranking a packument tests one range against every version it has; the parse is the same
// each time, so it is kept. Comparators are never written to after this.
const ranges = new Map<string, Comparator[][] | undefined>();

function parseRange(range: string, incPr: boolean): Comparator[][] | undefined {
  if (typeof range !== "string") return undefined;
  const key = `${incPr ? "p" : "-"}${range}`;
  if (ranges.has(key)) return ranges.get(key);
  let sets: Comparator[][] | undefined = [];
  for (const branch of range.split("||")) {
    const set = parseSet(branch, incPr);
    if (!set) {
      sets = undefined;
      break;
    }
    sets.push(set);
  }
  ranges.set(key, sets);
  return sets;
}

function holds(r: -1 | 0 | 1, op: Op): boolean {
  if (r === 0) return op !== "<" && op !== ">";
  return r < 0 ? op === "<" || op === "<=" : op === ">" || op === ">=";
}

function testSet(v: Version, set: Comparator[], includePrerelease: boolean): boolean {
  for (const c of set) {
    if (!holds(compare(v, c.v), c.op)) return false;
  }
  // A prerelease only matches if some comparator opts into that exact tuple.
  if (v.prerelease.length > 0 && !includePrerelease) {
    return set.some(
      (c) =>
        c.v.prerelease.length > 0 &&
        c.v.major === v.major &&
        c.v.minor === v.minor &&
        c.v.patch === v.patch,
    );
  }
  return true;
}

export function validRange(range: string): boolean {
  return parseRange(range, false) !== undefined;
}

export function satisfies(
  version: string | Version,
  range: string,
  includePrerelease = false,
): boolean {
  const v = toVersion(version);
  const sets = parseRange(range, includePrerelease);
  if (!v || !sets) return false;
  return sets.some((set) => testSet(v, set, includePrerelease));
}

/** `satisfies` for one range and many versions: the range is looked up once. */
export function inRange(range: string, includePrerelease = false): (version: Version) => boolean {
  const sets = parseRange(range, includePrerelease);
  return (v) => !!sets && sets.some((set) => testSet(v, set, includePrerelease));
}

/**
 * Whether a version as written is a prerelease, told without parsing it: a `-` before any `+`.
 * Without a `-` in a range no prerelease is in it, so one can be dropped unparsed: most of a
 * document like `react`'s thousands of canaries.
 */
export function prerelease(version: string): boolean {
  const dash = version.indexOf("-");
  return dash >= 0 && version.lastIndexOf("+", dash) < 0;
}

export function maxSatisfying(
  versions: readonly string[],
  range: string,
  includePrerelease = false,
): string | undefined {
  const sets = parseRange(range, includePrerelease);
  if (!sets) return undefined;
  const plain = !includePrerelease && !range.includes("-");
  let best: Version | undefined;
  let raw: string | undefined;
  for (const candidate of versions) {
    if (plain && prerelease(candidate)) continue;
    const v = parse(candidate);
    if (!v || !sets.some((set) => testSet(v, set, includePrerelease))) continue;
    if (!best || compare(v, best) > 0) {
      best = v;
      raw = candidate;
    }
  }
  return raw;
}

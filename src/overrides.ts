// The root's overrides: npm's `overrides`, yarn's `resolutions` and `pnpm.overrides`, read into
// one map the resolver applies to the edges of installed packages. Portable: no Node here.
import { tarballUrl } from "./registry.ts";
import type { BaseFor } from "./registry.ts";
import type { PeerKind, ResolvedPackage } from "./resolve.ts";
import { parse, satisfies, validRange } from "./semver.ts";
import { parseDep } from "./spec.ts";
import type { Spec } from "./spec.ts";

/**
 * Selector -> what a matching edge takes instead: a spec, or `-` to drop the edge (pnpm's).
 * A selector is pnpm's `[parent[@range]>]name[@range]`, whatever field it was written in,
 * and a `$name` value is already the root's own range for that name.
 */
export type Overrides = Record<string, string>;

export interface Rule {
  name: string;
  /** Matches when the version the edge would take without the rule is in this range. */
  range?: string;
  /** Only an edge of a package of this name, whose version is in `parentRange` when given. */
  parent?: string;
  parentRange?: string;
  value: string;
}

/** A package a rule can be scoped to: a registry package, a tarball or a workspace. */
export interface Parent {
  name: string;
  version: string;
}

/** What `overrider` needs of the resolve it serves. */
export interface Walk {
  /** The package at a key, a rule's parent; nothing for the root, which only unscoped rules reach. */
  parent: (from: string) => Parent | undefined;
  /** The version a spec takes without the rules. */
  take: (spec: Spec) => Promise<string>;
  /** What the resolve keeps from its lock, of which `touched` names what the rules moved. */
  locked: Record<string, ResolvedPackage>;
  baseFor: BaseFor;
}

/**
 * The root's overrides applied over one resolve, `before` being those its lock was made under.
 * Kept apart from the resolver so a project without overrides never loads this.
 */
export function overrider(manifest: object, before: Overrides | undefined, walk: Walk) {
  const { overrides } = readOverrides(manifest);
  const rules = compileOverrides(overrides);
  const changed = changedTargets(before, overrides);

  /**
   * What the rules make of an edge of `from`: the spec it takes, or nothing when a `-` drops it.
   * A rule with a range matches by the version the edge would take without it, so that is
   * picked first.
   */
  async function edge(from: string, name: string, range: string): Promise<string | undefined> {
    const parent = walk.parent(from);
    let would: Promise<string | undefined> | undefined;
    for (const rule of rules.get(name) ?? []) {
      if (!reaches(rule, parent)) continue;
      if (rule.range) {
        const version = await (would ??= wouldTake(name, range));
        if (version === undefined || !satisfies(version, rule.range)) continue;
      }
      return rule.value === "-" ? undefined : rule.value;
    }
    return range;
  }

  /** The version an edge would take, as far as the lock or the registry says; nothing on failure. */
  async function wouldTake(name: string, range: string): Promise<string | undefined> {
    try {
      const spec = parseDep(name, range);
      if (spec.type === "version") return parse(spec.fetchSpec)?.version;
      if (spec.type !== "range" && spec.type !== "tag") return undefined;
      return await walk.take(spec);
    } catch {
      return undefined;
    }
  }

  /**
   * The rules over a package's peer ranges, written into its record: the tree settles its peers
   * against them, and `unmetPeers` checks them. A `-` takes the peer away.
   */
  async function peers(
    key: string,
    found: ResolvedPackage,
    kinds: Record<string, PeerKind>,
  ): Promise<void> {
    const declared = found.peerDependencies;
    if (!declared) return;
    await Promise.all(
      Object.entries(declared).map(async ([name, range]) => {
        const to = await edge(key, name, range);
        if (to !== undefined) return void (declared[name] = to);
        delete declared[name];
        delete kinds[name];
      }),
    );
    if (Object.keys(declared).length === 0) delete found.peerDependencies;
  }

  /**
   * Whether a locked package has an edge the changed rules may move, so it is walked again. An
   * edge a `-` dropped is in no entry, so taking a `-` away reaches every package.
   */
  function touched(key: string): boolean {
    const { dependencies, optionalDependencies, peerDependencies } = walk.locked[key]!;
    const edges = Object.entries({ ...dependencies, ...optionalDependencies });
    // An edge to what the lock no longer keeps, such as a local tarball an override names that
    // changed on disk, chooses again.
    if (changed.all || edges.some(([n, v]) => !walk.locked[`${n}@${v}`])) return true;
    if (changed.names.size === 0) return false;
    return [dependencies, optionalDependencies, peerDependencies].some(
      (map) => map && Object.keys(map).some((name) => changed.names.has(name)),
    );
  }

  /**
   * The spec a locked registry package is fetched again by. An alias's name is only in its
   * tarball url, which is written down since it is not the one its own name derives.
   */
  function specOf({ name, version, resolved }: ResolvedPackage): string {
    if (resolved === tarballUrl(walk.baseFor(name), name, version)) return version;
    // `<name>/-/<file>`, the file under its scope on some registries (`/-/@s/a-1.0.0.tgz`).
    const found = /\/((?:@[^/]+(?:\/|%2f))?[^/]+)\/-\/(?:@[^/]+\/)?[^/]+$/i.exec(resolved)?.[1];
    let real = name;
    try {
      if (found) real = decodeURIComponent(found);
    } catch {}
    return real === name ? version : `npm:${real}@${version}`;
  }

  const has = (name: string) => rules.has(name);
  const gives = (name: string, range: string) => !!rules.get(name)?.some((r) => r.value === range);
  return { overrides, has, gives, edge, peers, touched, specOf };
}

/**
 * The values of the rules that can reach a top's edge to `name`: `sameTree` lets a top pin what
 * one of them gives, where it otherwise holds the pin to the range the top declares.
 */
export function valuesFor(
  overrides: Overrides,
): (top: Parent | undefined, name: string) => string[] {
  const rules = compileOverrides(overrides);
  return (top, name) =>
    (rules.get(name) ?? [])
      .filter((rule) => rule.value !== "-" && reaches(rule, top))
      .map((rule) => rule.value);
}

/** Whether a rule reaches the edges of `parent`, or of the root when there is none. */
function reaches(rule: Rule, parent: Parent | undefined): boolean {
  if (rule.parent === undefined) return true;
  if (!parent || rule.parent !== parent.name) return false;
  return !rule.parentRange || satisfies(parent.version, rule.parentRange);
}

/** The root groups a `$name` value can name, as npm reads them. */
const GROUPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

interface Fields {
  overrides?: unknown;
  resolutions?: unknown;
  pnpm?: { overrides?: unknown };
  [group: string]: unknown;
}

/**
 * What the root's package.json overrides, and the entries it holds that upm cannot apply —
 * named by where they are, such as `overrides.a.b.c` — for the caller to say. A package has
 * one set of edges in the tree, so a rule scoped to a parent reaches that parent's own
 * dependencies, not deeper; a value upm cannot install, such as git or yarn's `patch:`, is
 * not a rule either. A value that is not a string, a `$name` the root does not depend on, or
 * two fields that disagree, fail.
 */
export function readOverrides(manifest: object): { overrides: Overrides; skipped: string[] } {
  const m = manifest as Fields;
  const found = new Map<string, [value: string, from: string]>();
  const skipped: string[] = [];
  const put = (selector: string | undefined, value: unknown, from: string) => {
    if (selector === undefined) return void skipped.push(from);
    if (typeof value !== "string") throw fail(`${from} must be a string`);
    const [name, rule] = [targetOf(selector), value.trim()];
    const spec = normalValue(name, rule.startsWith("$") ? reference(m, rule, from) : rule);
    if (spec === undefined) return void skipped.push(from);
    const other = found.get(selector);
    if (other && other[0] !== spec) throw fail(`${other[1]} and ${from} disagree`);
    found.set(selector, [spec, from]);
  };
  for (const [key, value] of entries(m.resolutions, "resolutions")) {
    put(yarnSelector(key), value, `resolutions[${JSON.stringify(key)}]`);
  }
  for (const [key, value] of entries(m.overrides, "overrides")) {
    const at = `overrides.${key}`;
    if (typeof value === "string") {
      put(selector(key), value, at);
      continue;
    }
    // A nested object: `.` is the parent's own override, the rest its dependencies'.
    const parent = selector(key);
    for (const [child, inner] of entries(value, at)) {
      const where = `${at}.${child}`;
      if (typeof inner !== "string") skipped.push(where);
      else if (child === ".") put(parent, inner, where);
      else put(parent && under(parent, child), inner, where);
    }
  }
  for (const [key, value] of entries(m.pnpm?.overrides, "pnpm.overrides")) {
    const at = cut(key);
    const [parent, name] = [key.slice(0, at), key.slice(at + 1)];
    // One `>` at most: a rule two levels down is not one upm can keep.
    const found = at < 0 ? selector(key) : cut(name) < 0 ? under(parent, name) : undefined;
    put(found, value, `pnpm.overrides[${JSON.stringify(key)}]`);
  }
  const overrides: Overrides = {};
  for (const key of [...found.keys()].sort()) overrides[key] = found.get(key)![0];
  return { overrides, skipped };
}

/**
 * The rules of each name an edge can be to, most specific first: a parent, one of a version of
 * it, then a range of the target.
 */
export function compileOverrides(overrides: Overrides): Map<string, Rule[]> {
  const out = new Map<string, Rule[]>();
  for (const [selector, value] of Object.entries(overrides)) {
    const at = cut(selector);
    const target = split(selector.slice(at + 1));
    const parent = at < 0 ? undefined : split(selector.slice(0, at));
    const rule: Rule = {
      ...target,
      ...(parent && { parent: parent.name, parentRange: parent.range }),
      value,
    };
    out.set(rule.name, [...(out.get(rule.name) ?? []), rule]);
  }
  const rank = (r: Rule) => (r.parent ? 0 : 4) + (r.parentRange ? 0 : 2) + (r.range ? 0 : 1);
  for (const rules of out.values()) rules.sort((a, b) => rank(a) - rank(b));
  return out;
}

/**
 * The names whose rules differ between two maps: edges to them are the ones to walk again.
 * `all` when a `-` went, since the edge it dropped is not there to find.
 */
export function changedTargets(
  before: Overrides = {},
  after: Overrides = {},
): { names: Set<string>; all: boolean } {
  const names = new Set<string>();
  let all = false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = Object.hasOwn(before, key) ? before[key] : undefined;
    const now = Object.hasOwn(after, key) ? after[key] : undefined;
    if (was === now) continue;
    names.add(targetOf(key));
    if (was === "-") all = true;
  }
  return { names, all };
}

/** `name` or `name@range`, as a selector spells it, or nothing when it is not one. */
function selector(key: string): string | undefined {
  try {
    const { name, range } = split(key.trim());
    return range ? `${name}@${range}` : name;
  } catch {
    return undefined;
  }
}

/**
 * yarn's key, a path of names. A name alone, or after `**`, is a rule for every edge to it;
 * `parent/name` is one for any `parent`'s own edge, as yarn's berry reads it. A longer path is
 * not a rule here.
 */
function yarnSelector(key: string): string | undefined {
  const parts: string[] = [];
  for (const part of key.trim().split("/")) {
    const last = parts.at(-1);
    if (last?.startsWith("@") && !last.includes("/")) parts[parts.length - 1] = `${last}/${part}`;
    else parts.push(part);
  }
  if (parts[0] === "**") parts.shift();
  if (parts.length === 1) return selector(parts[0]!);
  if (parts.length !== 2 || parts.includes("**")) return undefined;
  return under(parts[0]!, parts[1]!);
}

/** `name` under `parent`, both as a selector spells them, or nothing when either is not one. */
function under(parent: string, name: string): string | undefined {
  const [p, n] = [selector(parent), selector(name)];
  return p && n && `${p}>${n}`;
}

/** A selector's name and range, checked. `*` and yarn's `npm:` prefix say nothing more. */
function split(key: string): { name: string; range?: string } {
  const at = key.indexOf("@", 1);
  const name = at < 0 ? key : key.slice(0, at);
  let range = at < 0 ? undefined : key.slice(at + 1).replace(/^npm:/, "");
  parseDep(name, "*"); // a valid name
  if (range === "*" || range === "") range = undefined;
  if (range !== undefined && !validRange(range) && !parse(range)) {
    throw fail(`override ${key} has a range upm cannot read`);
  }
  return { name, ...(range && { range }) };
}

function targetOf(selector: string): string {
  return split(selector.slice(cut(selector) + 1)).name;
}

/**
 * Where a selector's parent ends, or -1: a `>` after a name or a version, as pnpm finds it, so
 * the `>` of a range (`semver@>=7 <7.5.2`, `a@^1 || >2`) is never taken for one.
 */
function cut(selector: string): number {
  const at = /[^ |@]>/.exec(selector)?.index;
  return at === undefined ? -1 : at + 1;
}

/** npm's `$name`: the range the root declares for `name`. */
function reference(m: Fields, value: string, from: string): string {
  const name = value.slice(1);
  for (const group of GROUPS) {
    const map = m[group] as Record<string, unknown> | undefined;
    const range = map && Object.hasOwn(map, name) ? map[name] : undefined;
    if (typeof range === "string") return range;
  }
  throw fail(`${from} is ${value}, and the root does not depend on ${name}`);
}

/**
 * The value as a spec of `name`, a local tarball's path as the root's; nothing when it is not
 * one upm installs from an override, which a workspace is not.
 */
function normalValue(name: string, value: string): string | undefined {
  if (value === "-") return value;
  try {
    const spec = parseDep(name, value);
    if (spec.type !== "workspace") return spec.type === "tarball" ? spec.fetchSpec : value;
  } catch {}
  return undefined;
}

function entries(value: unknown, at: string): [string, unknown][] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fail(`${at} in package.json must be an object`);
  }
  return Object.entries(value);
}

function fail(message: string): Error {
  return Object.assign(new Error(message), { code: "EMANIFEST" });
}

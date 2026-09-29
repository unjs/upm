// Smaller `npm-pick-manifest`: a packument in, one manifest out. Pure, no I/O.
import { compare, inRange, maxSatisfying, parse, satisfies } from "./semver.ts";
import type { Version } from "./semver.ts";
import type { Spec } from "./spec.ts";
import type { Manifest, Packument } from "./types.ts";

/**
 * A packument read a member at a time. The registry hands one out over the document's text
 * so that a pick parses the manifests it looks at and not the thousand others; `whole()` is
 * the document, parsed once, for everything else.
 */
export interface PackumentView {
  tags(): Record<string, string>;
  version(version: string): Manifest | undefined;
  /** Every version, in the document's order, when known without parsing the document. */
  versions?(): readonly string[] | undefined;
  whole(): Packument;
}

/** A parsed document as a view. */
export function viewOf(packument: Packument): PackumentView {
  return {
    tags: () => packument["dist-tags"] ?? {},
    version: (version) => packument.versions?.[version],
    whole: () => packument,
  };
}

export interface PickOptions {
  /** Tag consulted for the fast path and for a bare `*` spec. */
  defaultTag?: string;
  /** Deprecated versions are always selectable; this stops them being ranked last. */
  includeDeprecated?: boolean;
}

/**
 * `engines.node` only. `os`/`cpu`/`libc` are the resolver's call, not ours. Off Node there is
 * no version to test against, so every engine passes.
 */
function engineOk(manifest: Manifest): boolean {
  const range = manifest.engines?.node;
  const version = globalThis.process?.version;
  return !range || !version || satisfies(version, range, true);
}

/**
 * The packument as it stood at `before` (epoch ms), as npm's `before` reads it: a version
 * published later is gone, and a tag on one moves to the highest version at or below it that
 * is left. A version with no publish date passes.
 */
export function asOf(
  packument: Packument,
  times: Record<string, string>,
  before: number,
): Packument {
  const versions: Record<string, Manifest> = {};
  for (const [v, m] of Object.entries(packument.versions ?? {})) {
    if (!(Date.parse(times[v] ?? "") > before)) versions[v] = m;
  }
  const tags = tagsAsOf(packument["dist-tags"] ?? {}, Object.keys(versions));
  return { ...packument, versions, "dist-tags": tags, before: new Date(before).toISOString() };
}

/** `asOf` over a view that lists its versions, parsing none of them to filter them. */
export function viewAsOf(
  view: PackumentView,
  times: Record<string, string>,
  before: number,
): PackumentView {
  const all = view.versions?.();
  if (!all) return viewOf(asOf(view.whole(), times, before));
  const kept = all.filter((v) => !(Date.parse(times[v] ?? "") > before));
  const has = new Set(kept);
  let tags: Record<string, string> | undefined;
  let whole: Packument | undefined;
  return {
    tags: () => (tags ??= tagsAsOf(view.tags(), kept, has)),
    version: (version) => (has.has(version) ? view.version(version) : undefined),
    versions: () => kept,
    whole: () => (whole ??= asOf(view.whole(), times, before)),
  };
}

/** Each tag on a version still there, or moved to the highest one at or below it. */
function tagsAsOf(
  tags: Record<string, string>,
  kept: string[],
  has = new Set(kept),
): Record<string, string> {
  const moved: Record<string, string> = {};
  for (const [tag, v] of Object.entries(tags)) {
    const found = has.has(v) ? v : maxSatisfying(kept, `<=${v}`);
    if (found) moved[tag] = found;
  }
  return moved;
}

/**
 * The versions in `range`, parsed, in the list's order. Without a `-` in the range no
 * prerelease is in it, so one is dropped unparsed: most of a document like `react`'s thousands
 * of canaries.
 */
function matching(keys: readonly string[], range: string): [Version, string][] {
  const plain = !range.includes("-");
  const fits = inRange(range);
  const found: [Version, string][] = [];
  for (const key of keys) {
    const dash = key.indexOf("-");
    if (plain && dash >= 0 && key.lastIndexOf("+", dash) < 0) continue;
    const v = parse(key);
    if (v && fits(v)) found.push([v, key]);
  }
  return found;
}

/** A miss in a document with no versions at all is the document's fault, not the spec's. */
function fail(packument: Packument, spec: Spec): Error {
  if (packument.before) {
    const message = `No version of ${spec.raw} published before ${packument.before} (min-release-age; see min-release-age-exclude)`;
    return Object.assign(new Error(message), { code: "ETARGET", wanted: spec.fetchSpec });
  }
  const code = Object.keys(packument.versions ?? {}).length === 0 ? "ENOVERSIONS" : "ETARGET";
  const message =
    code === "ENOVERSIONS"
      ? `No versions available for ${packument.name}`
      : `No matching version found for ${spec.raw}`;
  // Stage 4 tells these from network errors to keep optional deps non-fatal.
  return Object.assign(new Error(message), { code, wanted: spec.fetchSpec });
}

/** A JSON document never has a function in it. */
const isView = (source: Packument | PackumentView): source is PackumentView =>
  typeof (source as PackumentView).whole === "function";

export function pickManifest(
  source: Packument | PackumentView,
  spec: Spec,
  options: PickOptions = {},
): Manifest {
  const view = isView(source) ? source : viewOf(source);
  const defaultTag = options.defaultTag ?? "latest";
  const tags = view.tags();
  const fresh = (m: Manifest) => options.includeDeprecated === true || !m.deprecated;

  // A tag or an exact version resolves to one key, or to nothing.
  if (spec.type === "tag" || spec.type === "version") {
    const wanted = spec.type === "tag" ? tags[spec.fetchSpec] : spec.fetchSpec;
    // `=1.2.3` and `v1.2.3` are valid specs but never packument keys.
    const key = wanted === undefined ? undefined : parse(wanted)?.version;
    const manifest = key === undefined ? undefined : view.version(key);
    if (!manifest) throw fail(view.whole(), spec);
    return manifest;
  }

  const range = spec.fetchSpec;

  // Fast path: the default tag usually wins, and skips both parsing and sorting the list.
  const tagged = tags[defaultTag];
  if (tagged !== undefined && (range === "*" || satisfies(tagged, range))) {
    const manifest = view.version(tagged);
    if (manifest && fresh(manifest) && engineOk(manifest)) return manifest;
  }

  // Otherwise the matches, newest first (a stable sort, so a tie keeps the document's order):
  // the first both fresh and engine-ok wins, so only the manifests up to it are read.
  const keys = view.versions?.() ?? Object.keys(view.whole().versions ?? {});
  const read: Manifest[] = [];
  for (const [, key] of matching(keys, range).sort(([a], [b]) => compare(b, a))) {
    const manifest = view.version(key);
    if (!manifest) continue;
    if (fresh(manifest) && engineOk(manifest)) return manifest;
    read.push(manifest);
  }
  // None is both: engine-ok ranks above fresh, and the newest of either wins.
  const best = read.find(engineOk) ?? read.find(fresh) ?? read[0];
  if (!best) throw fail(view.whole(), spec);
  return best;
}

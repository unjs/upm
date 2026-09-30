// What `add` and `remove` do to package.json: pure over the parsed object, and written back
// the way the file already was.
import { GROUPS, sorted } from "./resolve.ts";
import type { RootManifest } from "./resolve.ts";
import type { Spec } from "./spec.ts";

export type Group = (typeof GROUPS)[number];

export interface Added {
  name: string;
  range: string;
  group: Group;
}

/**
 * The range `add` saves for a spec that resolved to `version`. What was typed is what is
 * saved — `foo@^1` saves `^1` and `foo@1.2.3` saves `1.2.3` — so only a bare name, `*` or a
 * tag has to become a range, and that is a caret on the resolved version.
 */
export function saveRange(spec: Spec, version: string, exact = false): string {
  // `workspace:` is saved as typed: it names a workspace, and the range is the protocol's.
  if (spec.type === "workspace") return spec.raw.slice(spec.name.length + 1);
  const derived = spec.type === "tag" || spec.fetchSpec === "*";
  const range = derived ? (exact ? version : `^${version}`) : spec.fetchSpec;
  return spec.fetchName === spec.name ? range : `npm:${spec.fetchName}@${range}`;
}

/** Refuse a package.json an edit could not put back: a non-object root, or a group that is not a string map. */
export function checkManifest(
  manifest: unknown,
  file: string,
  groups: readonly (Group | "peerDependencies")[] = GROUPS,
): asserts manifest is RootManifest {
  const object = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(manifest)) throw fail(`${file} is not a JSON object`);
  for (const group of groups) {
    const map = (manifest as RootManifest)[group];
    if (map === undefined) continue;
    if (!object(map) || Object.values(map).some((range) => typeof range !== "string")) {
      throw fail(`${file}: ${group} is not a map of ranges`);
    }
  }
}

/** A package.json's text, parsed and checked by `checkManifest`. */
export function parseManifest(
  raw: string,
  file: string,
  groups?: readonly (Group | "peerDependencies")[],
): RootManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw fail(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  checkManifest(manifest, file, groups);
  return manifest;
}

/** Put each dep in its group, out of any other group it was in. Groups stay sorted. */
export function addDeps(manifest: RootManifest, added: Added[]): void {
  for (const { name, range, group } of added) {
    for (const other of GROUPS) if (other !== group) drop(manifest, other, name);
    manifest[group] = sorted({ ...manifest[group], [name]: range });
  }
}

/** Take each name out of every group. Names in no group are returned, not ignored. */
export function removeDeps(manifest: RootManifest, names: string[]): string[] {
  const missing: string[] = [];
  for (const name of names) {
    let found = false;
    for (const group of GROUPS) found = drop(manifest, group, name) || found;
    if (!found) missing.push(name);
  }
  return missing;
}

/** Serialize with the indent and line ending the file already uses, so an edit is one line of diff. */
export function formatManifest(manifest: RootManifest, raw: string): string {
  const indent = /^([ \t]+)"/m.exec(raw)?.[1] ?? "  ";
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const text = JSON.stringify(manifest, undefined, indent).replaceAll("\n", eol);
  return raw.endsWith("\n") ? `${text}${eol}` : text;
}

/**
 * The root fields that change the tree another manager installs, which upm does not apply.
 * Said so the tree is not quietly other than the one they ask for.
 */
export function unapplied(manifest: RootManifest): string[] {
  const m = manifest as Record<string, unknown> & { pnpm?: Record<string, unknown> };
  const set = (value: unknown) =>
    value !== null && typeof value === "object" && Object.keys(value).length > 0;
  return [
    ...(set(m.patchedDependencies) ? ["patchedDependencies"] : []),
    ...["packageExtensions", "patchedDependencies"]
      .filter((key) => set(m.pnpm?.[key]))
      .map((key) => `pnpm.${key}`),
  ];
}

/** A group that ends up empty goes with its last name, rather than staying as `{}`. */
function drop(manifest: RootManifest, group: Group, name: string): boolean {
  const map = manifest[group];
  if (!map || !Object.hasOwn(map, name)) return false;
  delete map[name];
  if (Object.keys(map).length === 0) delete manifest[group];
  return true;
}

function fail(message: string): Error {
  return Object.assign(new Error(message), { code: "EMANIFEST" });
}

// Which file of a package an import of it names, as Node.js reads `exports`. Pure, so it runs
// wherever the resolver does.

/** Node.js's conditions for an import; `default` always matches. */
export const IMPORT_CONDITIONS: readonly string[] = ["node", "import", "module-sync"];

/**
 * The target `exports` maps `subpath` (`.` or `./x`) to, its `*` filled in: a path relative to
 * the package, starting `./`. Undefined when the package does not export it. Throws, with
 * `EMANIFEST`, where the target it takes is not a path inside the package.
 */
export function exportsTarget(
  exports: unknown,
  subpath: string,
  conditions = IMPORT_CONDITIONS,
): string | undefined {
  const map = exports !== null && typeof exports === "object" && !Array.isArray(exports);
  const keys = map ? Object.keys(exports) : [];
  // Keys that start with `.` are subpaths; any others are conditions of `.` alone.
  if (!keys.some((key) => key.startsWith("."))) {
    return subpath === "." ? (pick(exports, undefined, conditions) ?? undefined) : undefined;
  }
  const subpaths = exports as Record<string, unknown>;
  if (Object.hasOwn(subpaths, subpath) && !subpath.includes("*")) {
    return pick(subpaths[subpath], undefined, conditions) ?? undefined;
  }
  let best: string | undefined;
  for (const key of keys) {
    const star = key.indexOf("*");
    if (star < 0 || key.includes("*", star + 1)) continue;
    const base = key.slice(0, star);
    const trailer = key.slice(star + 1);
    if (!subpath.startsWith(base) || subpath === base) continue;
    if (trailer && !(subpath.endsWith(trailer) && subpath.length >= key.length)) continue;
    if (best === undefined || before(key, best)) best = key;
  }
  if (best === undefined) return undefined;
  const star = best.indexOf("*");
  const filled = subpath.slice(star, subpath.length - (best.length - star - 1));
  if (SEGMENT.test(filled)) return undefined;
  return pick(subpaths[best], filled, conditions) ?? undefined;
}

/** Node.js's order of patterns: the longer part before `*` first, then the longer key. */
function before(a: string, b: string): boolean {
  const [x, y] = [a.indexOf("*"), b.indexOf("*")];
  return x === y ? a.length > b.length : x > y;
}

/** A segment that would leave the package or reach into another, as Node.js refuses. */
const SEGMENT = /(^|[\\/])(\.\.?|node_modules)([\\/]|$)/i;

/** A target's path; null where `exports` holds the subpath back, undefined where nothing fits. */
function pick(
  target: unknown,
  star: string | undefined,
  conditions: readonly string[],
): string | null | undefined {
  if (typeof target === "string") {
    if (!target.startsWith("./") || SEGMENT.test(target.slice(2))) throw invalid(target);
    return star === undefined ? target : target.replaceAll("*", star);
  }
  if (target === null) return null;
  if (typeof target !== "object") throw invalid(target);
  if (Array.isArray(target)) {
    // As Node.js: an invalid target or a null in a list is passed over, and the last of them
    // decides when nothing after fits. An empty list holds the subpath back.
    if (target.length === 0) return null;
    let last: Error | null | undefined;
    for (const choice of target) {
      try {
        const found = pick(choice, star, conditions);
        if (found === null) last = null;
        else if (found !== undefined) return found;
      } catch (error) {
        last = error as Error;
      }
    }
    if (last) throw last;
    return last;
  }
  for (const [key, value] of Object.entries(target)) {
    if (key !== "default" && !conditions.includes(key)) continue;
    const found = pick(value, star, conditions);
    if (found !== undefined) return found;
  }
  return undefined;
}

function invalid(target: unknown): Error {
  const message = `exports names ${JSON.stringify(target)}, which is not a path in the package`;
  return Object.assign(new Error(message), { code: "EMANIFEST" });
}

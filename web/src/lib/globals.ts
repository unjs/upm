// After an install, each of the project's dependencies as a global of this tab, to try in the
// devtools console: `yaml.parse("a: 1")` once `yaml` is installed. Loaded only after an install.
import { resolvex } from "upm/src/api.ts";
import { fromFileURL, toFileURL } from "upm/src/runtime.ts";
import { createLoader } from "./modules.ts";
import { globalName } from "./scan.ts";
import { fs } from "./node.ts";

/** The globals the last install set: the next one takes them away first. */
const ours = new Set<string>();

/** Imports each of `names`, installed in `dir`, as a global. Logs, never throws. */
export async function exposeDependencies(names: string[], dir: string): Promise<void> {
  const loader = createLoader(fs, (code, type) => URL.createObjectURL(new Blob([code], { type })));
  const page = globalThis as Record<string, unknown>;
  for (const key of ours) delete page[key];
  ours.clear();
  const shown: string[] = [];
  const taken: string[] = [];
  for (const name of names) {
    // Types only: nothing to import.
    if (name.startsWith("@types/")) continue;
    const key = globalName(name);
    if (!key || key in page) {
      taken.push(key ?? name);
      continue;
    }
    try {
      // upm's own `resolvex`, with a browser's conditions in place of Node.js's.
      const url = await resolvex(name, {
        dir,
        resolve: (id, parentURL) => toFileURL(loader.resolve(id, fromFileURL(parentURL))),
      });
      let value: unknown;
      try {
        value = await loader.load(fromFileURL(url));
      } catch (error) {
        // Blob urls cannot express an import cycle; the package's CommonJS build may still load.
        try {
          value = loader.require(name, dir);
        } catch {
          throw error;
        }
      }
      const [picked, what] = useful(value);
      page[key] = picked;
      ours.add(key);
      shown.push(`${key}${key === name ? "" : ` = ${name}`} (${what})`);
    } catch (error) {
      console.warn(`upm: could not import ${name} in this tab:`, error);
    }
  }
  if (shown.length === 0 && taken.length === 0) return;
  const rest = taken.length > 0 ? `; not set, as the name is taken: ${taken.join(", ")}` : "";
  console.info(`upm: try in this console: ${shown.join(", ") || "nothing"}${rest}`);
}

/**
 * What is most useful to type: the default export when it is all there is, or when it carries
 * every named export too (`yaml`, `axios`); else the module's namespace. CommonJS's
 * `module.exports` as it is.
 */
function useful(value: unknown): [unknown, string] {
  const module = value as { [Symbol.toStringTag]?: unknown; __esModule?: unknown } | null;
  // A CommonJS build of an ES module reads as one.
  if (module?.[Symbol.toStringTag] !== "Module" && !module?.__esModule) {
    return [value, "module.exports"];
  }
  const keys = Object.keys(value as object).filter((key) => key !== "__esModule");
  const main = (value as { default?: unknown }).default;
  const holder = main !== null && (typeof main === "object" || typeof main === "function");
  const all = keys.every((key) => key === "default" || (holder && key in (main as object)));
  return keys.includes("default") && all ? [main, "default export"] : [value, "module namespace"];
}

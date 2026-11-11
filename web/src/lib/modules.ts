// Loads installed packages in this tab. A browser cannot `import()` a file of ./node.ts's
// in-memory fs, so each file becomes a url of its own (a Blob url in a tab), its imports
// rewritten to the urls of the files they name. Relative imports resolve from its path, bare
// ones through the package's `exports` with a browser's conditions. A CommonJS file runs in a
// function, as Node.js wraps it, and an ES module imports it through a small module of its exports.
//
// Not a bundler: imports are found with patterns, not a parser, and an import cycle between
// ES modules cannot be written as urls that each name the other's content.

import { exportsTarget } from "upm/src/exports.ts";
import { toFileURL } from "upm/src/runtime.ts";
import { path } from "./node.ts";
import { findImports, looksLikeESM } from "./scan.ts";

/** The `fs` calls the loader makes: ./node.ts's `fs` has them, and so does Node's. */
export interface Files {
  readFileSync(path: string, encoding: "utf8"): unknown;
  existsSync(path: string): boolean;
  statSync(path: string): { isFile(): boolean };
  realpathSync(path: string): string;
}

/** A url `import()` loads `code` from, with `type` as its MIME type. */
export type MakeURL = (code: string, type: string) => string;

type Pkg = { type?: unknown; exports?: unknown; imports?: unknown } & Record<string, unknown>;

// A browser's conditions, as a bundler that targets one picks: Node.js builds often need `node:` builtins.
const IMPORT = ["browser", "import", "module"];
const REQUIRE = ["browser", "require"];
const ENDS = ["", ".js", ".mjs", ".cjs", ".json", "/index.js", "/index.mjs", "/index.json"];
/** What a `browser` field maps to `false`: an empty module. */
const EMPTY = "upm:empty";
/** Where the small modules of a CommonJS file's or a builtin's exports find them. */
const SHARED = Symbol.for("upm.modules");

export function createLoader(fs: Files, makeURL: MakeURL) {
  const urls = new Map<string, string>();
  const building = new Set<string>();
  const commonjs = new Map<string, { exports: unknown }>();
  const scopes = new Map<string, { dir: string; pkg: Pkg } | undefined>();
  const shared = ((globalThis as Record<symbol, unknown[]>)[SHARED] ??= []);

  const read = (file: string) => String(fs.readFileSync(file, "utf8"));
  const isFile = (file: string) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const readJson = (file: string): Pkg => {
    try {
      return JSON.parse(read(file)) as Pkg;
    } catch {
      return {};
    }
  };
  /** The real path of the first file of `base` and the ends tried after it. */
  const fileOf = (base: string, ends = ENDS) => {
    for (const end of ends) if (isFile(base + end)) return fs.realpathSync(base + end);
  };

  /** The nearest package.json at or above `dir`: its `type` and `imports` apply below it. */
  function scope(dir: string): { dir: string; pkg: Pkg } | undefined {
    if (scopes.has(dir)) return scopes.get(dir);
    const file = path.join(dir, "package.json");
    const found = isFile(file)
      ? { dir, pkg: readJson(file) }
      : dir === "/"
        ? undefined
        : scope(path.dirname(dir));
    scopes.set(dir, found);
    return found;
  }

  function formatOf(file: string, code: string): "esm" | "cjs" | "json" {
    if (file.endsWith(".json")) return "json";
    if (file.endsWith(".mjs")) return "esm";
    if (file.endsWith(".cjs")) return "cjs";
    if (scope(path.dirname(file))?.pkg.type === "module") return "esm";
    // Packages for bundlers ship ES modules as `.js` without `"type": "module"`, and Node.js
    // now looks at the code too.
    return looksLikeESM(code) ? "esm" : "cjs";
  }

  /**
   * The file `id` names from a module in `dir`; `node:<name>` for a builtin, EMPTY for what the
   * `browser` field of the package leaves out. That field's map swaps a bare name for the
   * importer's package, and a file for the package it is in.
   */
  function resolve(id: string, dir: string, conditions = IMPORT): string {
    if (id.startsWith("node:")) return id;
    const own = scope(dir);
    const swaps = browserMap(own);
    if (swaps && Object.hasOwn(swaps, id)) return swapped(own!.dir, swaps[id]);
    const file = find(id, dir, conditions);
    if (file.startsWith("node:")) return file;
    const at = scope(path.dirname(file));
    const map = browserMap(at);
    const key = at && `./${file.slice(at.dir.length + 1)}`;
    for (const name of map && key ? [key, key.replace(/\.js$/, "")] : []) {
      if (Object.hasOwn(map!, name)) return swapped(at!.dir, map![name]);
    }
    return file;
  }

  function swapped(dir: string, to: unknown): string {
    if (to === false) return EMPTY;
    const found = typeof to === "string" ? fileOf(path.join(dir, to)) : undefined;
    if (!found) throw new Error(`the browser field in ${dir} names no file for ${String(to)}`);
    return found;
  }

  function find(id: string, dir: string, conditions: string[]): string {
    if (/^\.{0,2}(\/|$)/.test(id)) {
      const found = fileOf(path.join(id.startsWith("/") ? "/" : dir, id));
      if (!found) throw new Error(`cannot find ${id} from ${dir}`);
      return found;
    }
    if (id.startsWith("#")) return imported(id, dir, conditions);
    try {
      return bare(id, dir, conditions);
    } catch (error) {
      // As Node.js: a builtin's name without `node:`, when no package of that name is there.
      if (/^[a-z_]+(\/[a-z_]+)?$/.test(id) && builtin(id) !== undefined) return `node:${id}`;
      throw error;
    }
  }

  function bare(id: string, dir: string, conditions: string[]): string {
    const end = id.indexOf("/", id.startsWith("@") ? id.indexOf("/") + 1 : 0);
    const name = end < 0 ? id : id.slice(0, end);
    const subpath = end < 0 ? "." : `.${id.slice(end)}`;
    let home = path.join(dir, "node_modules", name);
    for (let at = dir; !fs.existsSync(home); home = path.join(at, "node_modules", name)) {
      if (at === "/") throw new Error(`${name} is not installed above ${dir}`);
      at = path.dirname(at);
    }
    const pkg = readJson(path.join(home, "package.json"));
    if (pkg.exports !== undefined) {
      const target = exportsTarget(pkg.exports, subpath, conditions);
      const found = target === undefined ? undefined : fileOf(path.join(home, target), [""]);
      if (!found) throw new Error(`${name} exports no file for ${subpath} here`);
      return found;
    }
    if (subpath !== ".") {
      const found = fileOf(path.join(home, subpath));
      if (!found) throw new Error(`${id} names no file in ${home}`);
      return found;
    }
    // The fields a bundler reads for a browser: `module` is an ES module, `browser` a build for one.
    const fields = conditions === IMPORT ? ["module", "browser", "main"] : ["browser", "main"];
    for (const field of fields) {
      const value = pkg[field];
      const found = typeof value === "string" && value && fileOf(path.join(home, value));
      if (found) return found;
    }
    const found = fileOf(path.join(home, "index"));
    if (!found) throw new Error(`${name} names no file to import in ${home}`);
    return found;
  }

  /** `#name`, from the `imports` of the nearest package.json: read as `exports` are. */
  function imported(id: string, dir: string, conditions: string[]): string {
    const at = scope(dir);
    const imports = at?.pkg.imports;
    const map =
      imports && typeof imports === "object"
        ? Object.fromEntries(Object.entries(imports).map(([key, value]) => [`.${key}`, value]))
        : {};
    const target = exportsTarget(map, `.${id}`, conditions);
    const found = target === undefined ? undefined : fileOf(path.join(at!.dir, target), [""]);
    if (!found) throw new Error(`${id} is not in the imports of ${at?.dir ?? dir}`);
    return found;
  }

  const browserMap = (at: { pkg: Pkg } | undefined) => {
    const map = at?.pkg.browser;
    return map && typeof map === "object" ? (map as Record<string, unknown>) : undefined;
  };

  /** A small module of `value`'s exports: its default, and each own key as a named export. */
  function facade(value: unknown, default_ = value): string {
    const index = shared.push(value, default_) - 2;
    const object = value !== null && (typeof value === "object" || typeof value === "function");
    const keys = object ? Object.keys(value).filter((key) => /^[A-Za-z_$][\w$]*$/.test(key)) : [];
    const named = keys.filter((key) => key !== "default");
    const ref = `globalThis[Symbol.for("upm.modules")]`;
    return makeURL(
      [
        `const m = ${ref}[${index}];`,
        `export default ${ref}[${index + 1}];`,
        named.length > 0
          ? `const { ${named.map((key, i) => `${key}: _${i}`).join(", ")} } = m;`
          : "",
        named.length > 0
          ? `export { ${named.map((key, i) => `_${i} as ${key}`).join(", ")} };`
          : "",
      ].join("\n"),
      "text/javascript",
    );
  }

  /** The url an ES module imports `target` by, its own imports rewritten the same way. */
  function urlOf(target: string): string {
    let url = urls.get(target);
    if (url) return url;
    if (target === EMPTY || target.startsWith("node:")) {
      url = facade(need(target));
    } else {
      const code = read(target);
      const format = formatOf(target, code);
      if (format === "json") {
        // Imported `with { type: "json" }`, as an ES module must.
        url = makeURL(code, "application/json");
      } else if (format === "cjs") {
        const exports = requireFile(target);
        // As bundlers read a module compiled from an ES module.
        const esm = (exports as { __esModule?: unknown } | null)?.__esModule;
        url = facade(exports, esm ? (exports as { default?: unknown }).default : exports);
      } else {
        if (building.has(target)) {
          throw new Error(`${target} is in an import cycle, which Blob urls cannot express`);
        }
        building.add(target);
        try {
          url = makeURL(
            `${rewrite(code, target)}\n//# sourceURL=${toFileURL(target)}`,
            "text/javascript",
          );
        } finally {
          building.delete(target);
        }
      }
    }
    urls.set(target, url);
    return url;
  }

  /** `code` with each import it makes pointed at that module's url. */
  function rewrite(code: string, file: string): string {
    const dir = path.dirname(file);
    let out = "";
    let last = 0;
    for (const { start, end, specifier, dynamic } of findImports(code)) {
      let url: string;
      try {
        url = urlOf(resolve(specifier, dir));
      } catch (error) {
        // A dynamic import may sit behind a check; it fails when it runs, if it ever does.
        if (dynamic) continue;
        throw new Error(`${file} imports ${specifier}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      out += code.slice(last, start) + url;
      last = end;
    }
    // A map named by a relative path would be looked for beside the file:// name, and is not there.
    return (out + code.slice(last))
      .replace(/^#!.*/, "")
      .replace(/^\/\/# sourceMappingURL=(?!data:).*$/gm, "");
  }

  /** A CommonJS file's `module.exports`, run once. */
  function requireFile(target: string): unknown {
    if (target === EMPTY || target.startsWith("node:")) return need(target);
    const cached = commonjs.get(target);
    if (cached) return cached.exports;
    const code = read(target);
    const format = formatOf(target, code);
    const module = { exports: {} as unknown };
    commonjs.set(target, module);
    try {
      if (format === "json") module.exports = JSON.parse(code);
      else if (format === "esm") throw new Error(`require() of the ES module ${target}`);
      else {
        const dir = path.dirname(target);
        const require = (id: string) => requireFile(resolve(id, dir, REQUIRE));
        // As Node.js wraps a CommonJS file, with its `global` too; the name shows in stack
        // traces and devtools.
        const run = new Function(
          "exports",
          "require",
          "module",
          "__filename",
          "__dirname",
          "global",
          `${code.replace(/^#!.*/, "")}\n//# sourceURL=${toFileURL(target)}`,
        );
        run.call(module.exports, module.exports, require, module, target, dir, globalThis);
      }
    } catch (error) {
      commonjs.delete(target);
      throw error;
    }
    return module.exports;
  }

  return {
    /** The file `id` names, imported from a module in `dir`. */
    resolve: (id: string, dir: string) => resolve(id, dir),
    /** The module at `file`: an ES module's namespace, a CommonJS file's `module.exports`. */
    async load(file: string): Promise<unknown> {
      const real = fs.realpathSync(file);
      if (formatOf(real, read(real)) !== "esm") return requireFile(real);
      return await import(/* @vite-ignore */ urlOf(real));
    },
    /** `require(id)` from a module in `dir`: CommonJS has no trouble with a cycle. */
    require: (id: string, dir: string) => requireFile(resolve(id, dir, REQUIRE)),
  };
}

/** A Node.js builtin this runtime hands out: in a tab, ./node.ts's `fs`, `path` and `os`. */
const builtin = (id: string): unknown =>
  (
    globalThis.process as { getBuiltinModule?: (id: string) => unknown } | undefined
  )?.getBuiltinModule?.(id.replace(/^node:/, ""));

function need(id: string): unknown {
  if (id === EMPTY) return {};
  const found = builtin(id);
  if (found === undefined)
    throw new Error(`${id} is a Node.js builtin, which this tab does not have`);
  return found;
}

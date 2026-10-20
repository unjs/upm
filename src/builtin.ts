// Node builtins, fetched on first use instead of imported.
//
// Two reasons. `import "node:zlib"` at the top of the bundle loads zlib before the CLI has even
// read its arguments, and most commands never gunzip anything: a `--help` used to bring up 81
// native modules and now brings up 21, which is 38 ms down to 27. And a static `node:` import
// is a hard dependency on Node — routing every one of them through here leaves a single place
// that has to answer differently when there is no `process` at all.

export interface Builtin {
  readonly child_process: typeof import("node:child_process");
  readonly crypto: typeof import("node:crypto");
  readonly dns: typeof import("node:dns");
  readonly fs: typeof import("node:fs");
  readonly fsp: typeof import("node:fs/promises");
  readonly os: typeof import("node:os");
  readonly path: typeof import("node:path");
  readonly stream: typeof import("node:stream");
  readonly url: typeof import("node:url");
  readonly util: typeof import("node:util");
  readonly workers: typeof import("node:worker_threads");
  readonly zlib: typeof import("node:zlib");
}

const MODULES: Record<keyof Builtin, string> = {
  child_process: "node:child_process",
  crypto: "node:crypto",
  dns: "node:dns",
  fs: "node:fs",
  fsp: "node:fs/promises",
  os: "node:os",
  path: "node:path",
  stream: "node:stream",
  url: "node:url",
  util: "node:util",
  workers: "node:worker_threads",
  zlib: "node:zlib",
};

/**
 * `builtin.zlib` loads `node:zlib` the first time it is read. The getter then replaces itself
 * with the module it found, so every read after the first is an ordinary property — a hot loop
 * calling `builtin.fs.linkSync` pays nothing for going through here.
 */
export const builtin = {} as Builtin;

for (const [name, id] of Object.entries(MODULES)) {
  Object.defineProperty(builtin, name, {
    configurable: true,
    enumerable: true,
    get: () => {
      const found = globalThis.process?.getBuiltinModule?.(id);
      if (!found) {
        throw Object.assign(new Error(`upm needs ${id}, and this runtime has no ${id}`), {
          code: "ENOBUILTIN",
        });
      }
      Object.defineProperty(builtin, name, { value: found, enumerable: true });
      return found;
    },
  });
}

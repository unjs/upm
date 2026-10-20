#!/usr/bin/env node
// The `upm` bin, and only that: the rest is `cli.ts`, loaded once the V8 compile cache is on.
// An `import` at the top would load before this line runs and miss the cache; through it,
// every module after this one comes back compiled — 3 ms of a 30 ms `--help`. Builtins are
// asked for directly rather than through `builtin.ts`, which would be that first import.
// The cache sits in upm's own cache directory, not in `os.tmpdir()`, where a shared `/tmp` can
// already hold that directory owned by someone else. `NODE_DISABLE_COMPILE_CACHE=1` turns it off.
const proc = globalThis.process;

// Only when invoked as the entry, so nothing runs on an import. Node resolves the main module
// to its realpath, so a `.bin` symlink does not match without this.
if (proc?.argv?.[1] && isEntry(proc.argv[1])) {
  // Under `UPM_PHASES`, when this file ran and when the cache was on, for the phase marks.
  const phases = proc.env.UPM_PHASES ? [performance.now()] : undefined;
  const at = cacheHome();
  if (at) proc.getBuiltinModule("node:module")?.enableCompileCache?.(at);
  phases?.push(performance.now());
  const { start } = await import("./cli.ts");
  await start(proc.argv.slice(2), phases);
}

/** `upmHome("cache")` of `util.ts`, with its compile cache. */
function cacheHome(): string | undefined {
  const home = proc.getBuiltinModule("node:os")?.homedir();
  if (!home) return;
  const { isAbsolute, join } = proc.getBuiltinModule("node:path");
  const own = join(home, ".upm");
  const set = proc.env.XDG_CACHE_HOME;
  const kept = () =>
    proc.getBuiltinModule("node:fs").statSync(join(own, "store"), { throwIfNoEntry: false });
  const dir =
    set && isAbsolute(set)
      ? join(set, "upm")
      : kept()?.isDirectory() || proc.platform === "darwin" || proc.platform === "win32"
        ? own
        : join(home, ".cache", "upm");
  return join(dir, "compile-cache");
}

function isEntry(entry: string): boolean {
  try {
    return proc.getBuiltinModule("node:fs").realpathSync(entry) === import.meta.filename;
  } catch {
    return false;
  }
}

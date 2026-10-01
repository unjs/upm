// Worker entry for the link pool. One shard of an entry in, its link and copy counts out. The
// loop is the same sync `linkSync` the main thread runs without a pool, on another core.
import { builtin } from "./builtin.ts";
import type { Shard, ShardResult } from "./link.ts";
import type { PackageIndex } from "./store.ts";
import { keepAliases } from "./index-upgrade.ts";
import { sameIntegrity } from "./integrity.ts";
import { isIndex, linkArgs, misdeclaredIn, mismatch } from "./util.ts";

/** An Error does not survive structured clone, so the two fields callers read travel by hand. */
export interface ShardReply {
  /** -1 is the worker saying it loaded: the pool hands it work only from then on. */
  id: number;
  done?: ShardResult;
  failed?: { message: string; code?: string };
}

/** link() failing this way is a property of the two directories, never of one file. */
const NO_LINKS = new Set(["EXDEV", "EPERM", "ENOSYS", "EOPNOTSUPP", "ENOTSUP", "EACCES"]);

/**
 * Decided once per thread, on the first link() that proves the store and the project cannot
 * share inodes — the same rule the main thread's `place` applies.
 */
export interface Linker {
  copyOnly: boolean;
}

/** Directories, then hardlinks, then symlinks, all sync: this thread has nothing else to do. */
export function runShard(shard: Shard, linker: Linker): ShardResult {
  const { copyFileSync, linkSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } = builtin.fs;
  const { sep } = builtin.path;
  let { dirs, paths, blobs } = shard;
  // A small entry: the files are in the index, read here rather than sent.
  if (shard.index !== undefined) {
    const { files } = readIndex(shard);
    dirs = [...dirs, ...prefixes(files).map((p) => `${shard.dir}${sep}${p}`)];
    paths = files.map((file) => file.path);
    blobs = files.map((file) => file.blob);
  }
  for (const dir of dirs) {
    try {
      mkdirSync(dir);
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
  }
  let linked = 0;
  let copied = 0;
  let again = -1; // the one file given a second link, so a name that stays taken fails
  const unlinked = (path: string) => {
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < paths.length; i++) {
    const from = `${shard.blobDir}${sep}${blobs[i]}`;
    const to = `${shard.dir}${sep}${paths[i]}`;
    if (!linker.copyOnly) {
      try {
        linkSync(from, to);
        linked++;
        continue;
      } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (NO_LINKS.has(code)) linker.copyOnly = true;
        // A case-insensitive disk folds `A.js` onto `a.js`: the later wins, as in `place`.
        else if (code === "EEXIST" && again !== i && unlinked(to)) {
          again = i--;
          continue;
        }
        // EMLINK is this one file exhausting the inode's link count; the rest still link.
        else if (code !== "EMLINK") throw fail(`cannot link ${to}: ${reason(error)}`);
      }
    }
    try {
      copyFileSync(from, to);
      copied++;
    } catch (error) {
      throw fail(`cannot copy ${to}: ${reason(error)}`);
    }
  }
  for (let i = 0; i < shard.symlinks.length; i += 2) {
    const target = shard.symlinks[i]!;
    const at = shard.symlinks[i + 1]!;
    const [to, type] = linkArgs(target, at);
    try {
      symlinkSync(to, at, type);
    } catch (error) {
      // Nothing can be there under a fresh temp dir — except on a case-insensitive disk, where
      // two bins spelled `Foo` and `foo` are one name; then the last wins, as in npm.
      if ((error as { code?: string }).code !== "EEXIST") {
        throw fail(`cannot symlink ${at} -> ${target}: ${reason(error)}`);
      }
      unlinkSync(at);
      symlinkSync(to, at, type);
    }
  }
  const shims = shard.shims ?? [];
  for (let i = 0; i < shims.length; i += 2) {
    try {
      writeFileSync(shims[i]!, shims[i + 1]!);
    } catch (error) {
      throw fail(`cannot write ${shims[i]}: ${reason(error)}`);
    }
  }
  return { linked, copied };
}

/**
 * A small entry's store index, checked as the main thread checks one: missing, torn or another
 * tarball's is ELINK, and the tarball of another package is EMISMATCH.
 */
function readIndex({ index: file, integrity, want, edges, blobDir }: Shard): PackageIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(builtin.fs.readFileSync(file!, "utf8"));
  } catch (error) {
    throw fail(`cannot read ${file}: ${reason(error)}`);
  }
  if (
    !isIndex(parsed) ||
    (integrity !== undefined && !sameIntegrity(parsed.integrity, integrity))
  ) {
    throw fail(`${file} is not the package index it should be`);
  }
  const { sep } = builtin.path;
  const aged: PackageIndex[] = [];
  const wrong =
    (want && mismatch(parsed, want)) ||
    (edges && misdeclaredIn(parsed, (at) => `${blobDir}${sep}${at.blob}`, edges, aged));
  const what = want ? `${want.name}@${want.version}` : file;
  if (wrong) throw fail(`${what} cannot be installed: ${wrong}`, "EMISMATCH");
  // Here, on the thread that read it, which has nothing else to do meanwhile.
  if (aged.length > 0) keepAliases(file!, parsed);
  return parsed;
}

/** Every directory the files need, shallowest first, spelled from the package directory: as link.ts. */
function prefixes(files: PackageIndex["files"]): string[] {
  const levels: Set<string>[] = [];
  for (const { path } of files) {
    let depth = 0;
    for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
      (levels[depth++] ??= new Set()).add(path.slice(0, i));
    }
  }
  return levels.flatMap((level) => [...level]);
}

const port = builtin.workers.parentPort;
if (port) {
  const linker: Linker = { copyOnly: false };
  port.postMessage({ id: -1 } satisfies ShardReply);
  port.on("message", ({ id, shard }: { id: number; shard: Shard }) => {
    try {
      port.postMessage({ id, done: runShard(shard, linker) } satisfies ShardReply);
    } catch (error) {
      const { message, code } = error as { message?: string; code?: string };
      port.postMessage({ id, failed: { message: String(message ?? error), code } });
    }
  });
}

function reason(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

function fail(message: string, code = "ELINK"): Error {
  return Object.assign(new Error(message), { code });
}

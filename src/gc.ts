// Reclaiming space. Two address spaces, so two jobs (IDEA.md 5.5): the `.upm` entries of one
// project, and the content store every project shares. Mark and sweep, never refcounts — a
// refcount survives neither a second upm running nor `rm -rf node_modules`.
import { builtin } from "./builtin.ts";
import { createStore, isIndex } from "./store.ts";
import { alive, exists, list } from "./util.ts";
import type { PackageIndex } from "./store.ts";

export interface EntrySweep {
  removed: number;
  bytes: number;
}

export interface StorePrune {
  blobs: number;
  indexes: number;
  bytes: number;
}

/**
 * Nothing written in the last hour is removed. `store.add` writes a package's content before the
 * index that names it, so in between the content looks unreferenced; an hour is far longer than
 * one tarball takes, and it costs only blobs a running install just wrote.
 */
export const GRACE_MS = 60 * 60 * 1000;

/**
 * Drop `<dir>/node_modules/.upm` entries this install no longer wants. `keep` holds store keys
 * (`storeKeys()` in keys.ts). Entry files are hardlinks, so this reclaims far less than its size.
 */
export async function sweepEntries(dir: string, keep: Set<string>): Promise<EntrySweep> {
  const storeDir = builtin.path.join(dir, "node_modules", ".upm");
  const out: EntrySweep = { removed: 0, bytes: 0 };
  // An entry younger than the grace period may belong to an install that started after the
  // caller read its state, and whose keys are therefore missing from `keep`.
  const cutoff = Date.now() - GRACE_MS;
  // Keys are one flat path segment — a scoped `/` is escaped to `+`, see keys.ts — so unlike
  // npm's `#cleanOrphanedStoreEntries` there is no `@scope` level to descend into.
  for (const found of await list(storeDir)) {
    const { name } = found;
    // `.tmp-*` is where a concurrent install stages its next entry. Nothing dotted is ours,
    // and `node_modules` is the hoisted names, never an entry: a key always holds an `@`.
    if (!found.isDirectory() || name.startsWith(".") || name === "node_modules") continue;
    if (keep.has(name)) continue;
    const at = builtin.path.join(storeDir, name);
    const made = await builtin.fsp.stat(at).then(
      (found) => found.mtimeMs,
      () => Number.POSITIVE_INFINITY,
    );
    if (made > cutoff) continue;
    out.bytes += await freedBy(at);
    await remove(at, true);
    out.removed++;
  }
  return out;
}

/** Mark and sweep the content store: drop every blob no readable index still names. */
export async function pruneStore(storeDir: string): Promise<StorePrune> {
  // The one function that knows where a blob is. Constructing a store costs nothing.
  const { blobPath } = createStore({ dir: storeDir });
  const cutoff = Date.now() - GRACE_MS;
  const out: StorePrune = { blobs: 0, indexes: 0, bytes: 0 };

  const files = builtin.path.join(storeDir, "files");
  const indexes = builtin.path.join(storeDir, "index");
  // Blobs are listed first on purpose: content written after this moment is not a candidate at
  // all, whatever the index walk below sees.
  const blobs = await shards(files);
  const live = new Set<string>();
  for (const file of await shards(indexes)) {
    const index = await parse(file);
    const paths = index?.files.map((entry) => blobPath(entry));
    // An index we cannot read, or one naming content that is gone, can never be replayed —
    // store.ts already treats it as a miss and re-downloads. Its remaining blobs go with it.
    if (!paths || !(await Promise.all(paths.map(exists))).every(Boolean)) {
      await drop(file, cutoff, out, "indexes");
      continue;
    }
    for (const path of paths) live.add(path);
  }

  for (const blob of blobs) {
    if (!live.has(blob)) await drop(blob, cutoff, out, "blobs");
  }
  await sweepSpool(files, cutoff, out);
  await compact(files);
  await compact(indexes);
  return out;
}

/**
 * A big file is spooled to `files/<pid>-<token>-<n>.tmp` while its tarball inflates, and moved
 * to its blob once the tarball verifies. A process killed in between leaves the temp; one whose
 * pid is dead and which is past the grace period is abandoned, by the same rule as `.tmp-*`
 * entries under `.upm`. A live pid, or one this machine cannot see (another pid namespace
 * sharing the store), is left alone.
 */
async function sweepSpool(files: string, cutoff: number, out: StorePrune): Promise<void> {
  for (const found of await list(files)) {
    if (!found.isFile() || !found.name.endsWith(".tmp")) continue;
    const pid = Number(found.name.split("-")[0]);
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
    await drop(builtin.path.join(files, found.name), cutoff, out, "blobs");
  }
}

/** Remove one store file unless the grace period still covers it. */
async function drop(
  path: string,
  cutoff: number,
  out: StorePrune,
  kind: "blobs" | "indexes",
): Promise<void> {
  const info = await builtin.fsp.stat(path).catch(() => undefined);
  if (!info || info.mtimeMs > cutoff) return; // gone already, or too young to judge
  // Blobs are 0444/0555, which does not matter: unlink asks the *directory* for permission.
  await remove(path, false);
  out[kind]++;
  out.bytes += info.size;
}

/**
 * Blocks a removal really returns, which is not its apparent size. Entry files are hardlinks into
 * the content store, so dropping one frees nothing while the blob or another project's link
 * survives — only the last link to an inode gives its blocks back. What is left over is real:
 * copies from the EXDEV fallback, the symlinks, and the directories themselves.
 */
async function freedBy(path: string): Promise<number> {
  const info = await builtin.fsp.lstat(path).catch(() => undefined);
  if (!info) return 0; // removed under us, which frees nothing we can claim
  if (!info.isDirectory()) return info.nlink === 1 ? info.blocks * 512 : 0;
  let bytes = info.blocks * 512;
  for (const found of await list(path)) bytes += await freedBy(builtin.path.join(path, found.name));
  return bytes;
}

/** Every file in a `<root>/<shard>/<name>` tree — the store layout is exactly two levels deep. */
async function shards(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const shard of await list(root)) {
    if (!shard.isDirectory()) continue;
    for (const found of await list(builtin.path.join(root, shard.name))) {
      // `*.tmp` is a store write in flight; it is neither a blob nor ours to remove.
      if (found.isFile() && !found.name.endsWith(".tmp"))
        out.push(builtin.path.join(root, shard.name, found.name));
    }
  }
  return out;
}

/** Drop the shard directories the sweep emptied. ENOTEMPTY simply means one is still in use. */
async function compact(root: string): Promise<void> {
  for (const shard of await list(root)) {
    if (shard.isDirectory())
      await builtin.fsp.rmdir(builtin.path.join(root, shard.name)).catch(() => {});
  }
}

async function parse(file: string): Promise<PackageIndex | undefined> {
  try {
    // The store's own check, so a prune can never trust an index the store would reject.
    const parsed: unknown = JSON.parse(await builtin.fsp.readFile(file, "utf8"));
    return isIndex(parsed) ? parsed : undefined;
  } catch {
    return undefined; // unreadable or unparseable, which is the same verdict
  }
}

async function remove(path: string, recursive: boolean): Promise<void> {
  try {
    // force: a concurrent GC winning the race is fine. Windows fails the loser with EPERM
    // while the winner's delete is still pending, so retry until it is gone.
    await builtin.fsp.rm(path, { recursive, force: true, maxRetries: 3 });
  } catch (error) {
    if (!(await exists(path))) return;
    const { message } = error as Error;
    throw Object.assign(new Error(`Cannot remove ${path}: ${message}`), { code: "EGC" });
  }
}

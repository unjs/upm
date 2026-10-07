// upm's own `install`, run in this tab: ./node.ts stands in for Node's `process`, and its
// filesystem holds the project and the store. The project is made fresh for each run; the
// store's content is kept on OPFS (./opfs.ts) across runs, tabs and visits, and upm asks it
// before a download. Those, and upm's commands, load on the first install.
import type { InstallResult } from "upm/src/api.ts";
import { fraction, type Seen } from "upm/src/progress.ts";
import type { TarEntry } from "upm/src/tar.ts";
import { blobKey, indexKey } from "upm/src/store-backend.ts";
import type { BackendIndex } from "upm/src/store-backend.ts";
import { opfsBackend, persist } from "./opfs.ts";
import { allowedSource } from "./route.ts";

const PROJECT = "/project";
const HOME = "/home/user";

/** A file of the installed tree, or a symlink: then `data` is its target. */
export type InstalledFile = TarEntry & { link?: string };

export interface Installed {
  /**
   * Tree path -> entry, from the project root, and the store as `~/.upm/store/…`. The root's own
   * dependency links are shown opened, as an editor shows a linked folder, so a package's files
   * keep the paths they had before the install: `node_modules/<name>/…`.
   */
  files: Map<string, InstalledFile>;
  /** Those opened links: their tree path -> target. */
  links: Map<string, string>;
  result: InstallResult;
  ms: number;
}

let running: Promise<unknown> = Promise.resolve();
let shim: typeof import("./node.ts") | undefined;

/** The shim in place as this tab's `process`, loaded on first use. */
async function ready(): Promise<typeof import("./node.ts")> {
  shim ??= await import("./node.ts");
  shim.installShim({ cwd: PROJECT, home: HOME });
  if (typeof globalThis.process?.getBuiltinModule !== "function") {
    throw new Error("This page has a `process` of its own, so upm's cannot be put in place");
  }
  return shim;
}

/**
 * A tarball's files as the store kept them from an earlier install, or undefined when it has
 * not got them all: this tab's store first, then OPFS. Reads only those files.
 */
export async function storedFiles(integrity: string): Promise<TarEntry[] | undefined> {
  try {
    const node = await ready();
    const { isIndex, storeDir } = await import("upm/src/store.ts");
    const { createWriter } = await import("upm/src/unpack.ts");
    const writer = createWriter(storeDir());
    let listed: { path: string; size: number; exec: boolean; read(): Promise<unknown> }[];
    const raw = readSync(node, writer.indexPath(integrity));
    const index: unknown = raw && JSON.parse(new TextDecoder().decode(raw));
    if (isIndex(index)) {
      listed = index.files.map((file) => ({
        ...file,
        exec: file.blob.endsWith("-exec"),
        read: async () => readSync(node, writer.blobPath(file.blob)),
      }));
    } else {
      const backend = await opfsBackend();
      const options = { signal: new AbortController().signal, alive: () => {} };
      const data = await backend?.get(indexKey(integrity), options);
      if (!backend || !data) return undefined;
      const kept = JSON.parse(new TextDecoder().decode(data)) as BackendIndex;
      const got = backend.getMany!(
        kept.files.map((file) => blobKey(file.hash)),
        options,
      );
      listed = kept.files.map((file, i) => ({ ...file, read: async () => (await got)[i] }));
    }
    const blobs = await Promise.all(listed.map((file) => file.read()));
    const files: TarEntry[] = [];
    for (const [i, file] of listed.entries()) {
      const data = blobs[i];
      if (!(data instanceof Uint8Array) || data.length !== file.size) return undefined;
      files.push({ path: file.path, mode: file.exec ? 0o755 : 0o644, size: file.size, data });
    }
    return files;
  } catch {
    return undefined;
  }
}

function readSync(node: typeof import("./node.ts"), path: string): Uint8Array | undefined {
  try {
    return node.fs.readFileSync(path) as Uint8Array;
  } catch {
    return undefined;
  }
}

/** The project's package.json, as the install writes it and the tree shows it before then. */
export function manifestOf(dependencies: Record<string, string>): InstalledFile {
  const manifest = { name: "project", version: "0.0.0", dependencies };
  const data = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return { path: "package.json", mode: 0o644, size: data.length, data };
}

const STORE = `${HOME}/.upm/store/`;

/** What the running install last reported of each phase, through `onProgress`. */
let seen: Seen = {};

/** How far the running install has got, 0 to 1, as the CLI's bar draws it; undefined before. */
export function installProgress(): number | undefined {
  return fraction(seen);
}

/**
 * Install `dependencies` into a fresh `/project`. One run at a time: they share the filesystem.
 * With the walk's `lockfile` as its `upm.lock`, upm installs what the walk picked, resolving
 * nothing again. Its registry requests go through `logged`, when given.
 */
export function installInTab(
  dependencies: Record<string, string>,
  registry: string,
  log: (message: string, level: string) => void,
  lockfile?: string,
  logged?: typeof fetch,
): Promise<Installed> {
  const run = running.then(async () => {
    const node = await ready();
    const storeBackend = await opfsBackend();
    if (!storeBackend?.set) log("the store is in memory only: OPFS cannot be written here", "warn");
    node.fs.rmSync(PROJECT, { recursive: true, force: true });
    node.fs.mkdirSync(PROJECT, { recursive: true });
    node.fs.writeFileSync(`${PROJECT}/package.json`, manifestOf(dependencies).data);
    if (lockfile) node.fs.writeFileSync(`${PROJECT}/upm.lock`, lockfile);
    seen = {};
    const { install } = await import("upm/src/api.ts");
    const start = performance.now();
    // No release age: the same picks as the resolve beside it, which asks for none.
    // The unpack and link pools always say this in a tab (./node.ts starts only registry threads),
    // which reads as if nothing ran on threads.
    const quiet = (message: string, level: string) => {
      if (!message.startsWith("worker threads unavailable")) log(message, level);
    };
    // upm takes no `fetch`: it calls the global one, so that is swapped for the run, for the
    // registry and the allowed tarball hosts. Its registry threads have their own, but with the
    // walk's lockfile they never start. One run at a time, so no other install swaps it meanwhile.
    const page = globalThis.fetch;
    const origin = new URL(registry).origin;
    if (logged) {
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const own = new URL(url, location.href).origin === origin || allowedSource(url);
        return (own ? logged : page)(input, init);
      };
    }
    let result: InstallResult;
    try {
      result = await install({
        dir: PROJECT,
        registry,
        minReleaseAge: 0,
        storeBackend,
        log: quiet,
        onProgress: (progress) => void (seen[progress.phase] = progress),
      });
    } finally {
      globalThis.fetch = page;
    }
    const ms = performance.now() - start;
    // The store now holds something worth keeping.
    if (storeBackend?.set) persist();
    const files = new Map<string, InstalledFile>();
    const links = new Map<string, string>();
    const top = /^node_modules\/(@[^/]+\/)?[^/.@][^/]*$/;
    const list = (root: string, shown: string) => {
      for (const [path, entry] of node.walk(root)) {
        const at = shown + path.slice(root.length + 1);
        if (entry.kind === "file") {
          files.set(at, { path: at, mode: entry.mode, size: entry.data.length, data: entry.data });
        } else if (entry.kind === "link" && shown === "" && top.test(at)) {
          links.set(at, entry.target);
          list(path, `${at}/`);
        } else if (entry.kind === "link") {
          const data = new TextEncoder().encode(entry.target);
          files.set(at, { path: at, mode: 0o777, size: data.length, data, link: entry.target });
        }
      }
    };
    list(PROJECT, "");
    list(STORE.slice(0, -1), "~/.upm/store/");
    return { files, links, result, ms };
  });
  running = run.catch(() => {});
  return run;
}

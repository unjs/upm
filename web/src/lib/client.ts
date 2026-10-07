// What the app asks of upm: all of it runs in the browser, from `../src`.
import {
  createRegistry,
  formatLockfile,
  parseSpec,
  resolveTree,
  toLockfile,
  type Manifest,
  type Registry,
  type Resolution,
  type ResolvedPackage,
} from "upm/resolver";
import { createVerifier } from "upm/src/integrity.ts";
import { integrityOf } from "upm/src/resolve.ts";
import { createHasher, toBase64 } from "upm/src/runtime.ts";
import { extractTar, type TarEntry } from "upm/src/tar.ts";
import { storedFiles } from "./install.ts";
import { cachedFetch } from "./opfs.ts";
import { SOURCE_HOSTS, allowedSource, sourceOf } from "./route.ts";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

// The page's own, taken at load: while an install runs, the global one leads back to a client's
// `fetch` (./install.ts).
const pageFetch = globalThis.fetch;

export interface RequestEntry {
  id: number;
  url: string;
  status: number;
  /** `performance.now()` when it was sent. */
  start: number;
  /** From the request to its headers. */
  ms: number;
  /** From the request to its last byte, or its failure; 0 until then. */
  end: number;
  /** Body bytes read so far; the registry client may stop reading early. */
  bytes: number;
  done: boolean;
}

/** The package's own manifest: more than `Manifest` types, since the full route has it all. */
export type FullManifest = Manifest & {
  description?: string;
  license?: string;
  homepage?: string;
  repository?: string | { url?: string; directory?: string };
  /** The commit it was published from: the registry's copy has it, the tarball's does not. */
  gitHead?: string;
};

export interface Resolved {
  resolution: Resolution;
  lockfile: string;
  ms: number;
}

/** The version the spec picks, as the resolver would record it. */
export type Top = Pick<
  ResolvedPackage,
  "name" | "version" | "resolved" | "integrity" | "dependencies"
>;

/**
 * One query, as independent promises so each part shows the moment it lands. `top` is the
 * spec's pick; the manifest and the tarball start from it. The tree waits for `resolve`.
 */
export interface Run {
  name: string;
  /** The root's dependencies: what the resolve walks, and what an install installs. */
  dependencies: Record<string, string>;
  top: Promise<Top>;
  manifest: Promise<FullManifest>;
  tarball: Promise<Tarball>;
  /**
   * The package's `README.md`, as soon as the tarball's stream yields it, before the rest lands
   * and before its integrity is checked. Undefined when the tarball has none.
   */
  readme: Promise<TarEntry | undefined>;
  /** Walks the whole tree, on the first call; later calls get the same walk. */
  resolve(onPick: (pkg: ResolvedPackage, from: string, size?: Size) => void): Promise<Resolved>;
}

export interface Tarball {
  url: string;
  integrity: string;
  /** Bytes downloaded; 0 when the files came from the store. */
  bytes: number;
  /** Read from upm's store, which an earlier install filled: no request was made. */
  stored: boolean;
  files: TarEntry[];
  ms: number;
}

/** What the registry says a version unpacks to. Older publishes do not say. */
export interface Size {
  files: number;
  bytes: number;
}

export interface Client {
  registry: Registry;
  requests: RequestEntry[];
  /** `fetch` whose every request lands in `requests`. */
  fetch: typeof fetch;
  /** `after`: when to start; the parts stay pending until then. */
  run(spec: string, after?: Promise<unknown>): Run;
}

/** A client whose every request lands in `requests`, `onChange` told of each move. */
export function createClient(registryUrl: string, onChange: () => void): Client {
  const requests: RequestEntry[] = [];
  let ids = 0;

  const logged: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const start = performance.now();
    const entry: RequestEntry = {
      id: ids++,
      url,
      status: 0,
      start,
      ms: 0,
      end: 0,
      bytes: 0,
      done: false,
    };
    requests.push(entry);
    onChange();
    let response: Response;
    try {
      response = await pageFetch(input, init);
    } catch (error) {
      entry.done = true;
      entry.ms = entry.end = performance.now() - start;
      onChange();
      throw error;
    }
    entry.status = response.status;
    entry.ms = performance.now() - start;
    onChange();
    if (!response.body) {
      entry.done = true;
      entry.end = entry.ms;
      return response;
    }
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          entry.bytes += chunk.byteLength;
          controller.enqueue(chunk);
          onChange();
        },
        flush() {
          entry.done = true;
          entry.end = performance.now() - start;
          onChange();
        },
      }),
    );
    return new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  // Documents the last load read answer again while fresh, and are not requests.
  const registry = createRegistry({ registry: registryUrl, fetch: cachedFetch(logged) });
  // Each pick's size as its manifest says, by tarball url: an estimate of the install to come.
  const sizes = new Map<string, Size>();
  // Tarball urls read, for the run and its walk.
  const sources = new Map<string, Promise<Tarball>>();
  const pick = registry.pick!;
  registry.pick = async (spec, pinned, options) => {
    const m = await pick(spec, pinned, options);
    const { fileCount, unpackedSize } = m.dist as { fileCount?: number; unpackedSize?: number };
    if (fileCount && unpackedSize) {
      sizes.set(m.dist.tarball, { files: fileCount, bytes: unpackedSize });
    }
    return m;
  };

  return {
    registry,
    requests,
    fetch: logged,

    run(raw, after) {
      // A bare url on an allowed host is named by its path, as `name@url` would name it.
      const bare = sourceOf(raw.trim());
      const spec = parseSpec(bare ? `${bare.name}@${bare.url}` : raw.trim());
      if (
        spec.type === "workspace" ||
        (spec.type === "tarball" && !allowedSource(spec.fetchSpec))
      ) {
        const hosts = SOURCE_HOSTS.join(", ");
        throw new Error(`Only registry specs here, or a tarball url on ${hosts}, not: ${raw}`);
      }
      if (spec.type === "tarball") return runSource(spec.name, spec.fetchSpec, after);
      const range =
        spec.name === spec.fetchName ? spec.fetchSpec : `npm:${spec.fetchName}@${spec.fetchSpec}`;
      const dependencies = { [spec.name]: range };
      // One pick, as the walk's first: the walk finds its document already read.
      const top = (async (): Promise<Top> => {
        await after;
        const m = await registry.pick!(spec);
        return {
          name: spec.name,
          version: m.version,
          resolved: m.dist.tarball,
          integrity: integrityOf(m),
          dependencies: m.dependencies ?? {},
        };
      })();
      const resolve = resolver(dependencies);
      // What an earlier install left in the store answers both, with no request.
      const stored = top.then((pkg) => (pkg.integrity ? storedFiles(pkg.integrity) : undefined));
      // The record's name is what it installs as; an alias is asked for by its real name.
      const manifest = top.then(async (pkg) => {
        const files = await stored;
        return (
          (files && manifestOf(files)) ??
          (registry.manifest(spec.fetchName, pkg.version) as Promise<FullManifest>)
        );
      });
      // npm packs the README near the start, so it shows well before a large tarball is in.
      let found!: (entry: TarEntry | undefined) => void;
      const readme = new Promise<TarEntry | undefined>((resolve) => (found = resolve));
      const tarball = top.then((pkg) => {
        if (!pkg.integrity) throw new Error(`${pkg.resolved} has no integrity`);
        return fetchTarball(pkg.resolved, pkg.integrity, stored, (entry) => {
          if (isReadme(entry)) found(entry);
        });
      });
      tarball.then(
        () => found(undefined),
        () => found(undefined),
      );
      for (const promise of [top, stored, manifest, tarball]) promise.catch(() => {});
      return { name: spec.name, dependencies, top, manifest, tarball, readme, resolve };
    },
  };

  /**
   * A run of a tarball url on an allowed host. Its bytes come first: the version, integrity and
   * dependencies are all in them. Not looked for in the store, which is keyed by the integrity.
   */
  function runSource(name: string, url: string, after?: Promise<unknown>): Run {
    const dependencies = { [name]: url };
    let found!: (entry: TarEntry | undefined) => void;
    const readme = new Promise<TarEntry | undefined>((resolve) => (found = resolve));
    const tarball = (async () => {
      await after;
      return readSource(url, (entry) => {
        if (isReadme(entry)) found(entry);
      });
    })();
    tarball.then(
      () => found(undefined),
      () => found(undefined),
    );
    const manifest = tarball.then((t) => sourceManifest(url, t));
    const top = manifest.then((m): Top => ({
      name,
      version: m.version,
      resolved: url,
      integrity: m.dist.integrity!,
      dependencies: m.dependencies ?? {},
    }));
    for (const promise of [top, manifest, tarball]) promise.catch(() => {});
    return { name, dependencies, top, manifest, tarball, readme, resolve: resolver(dependencies) };
  }

  /** Walks the whole tree from `dependencies`, on the first call; later calls get the same walk. */
  function resolver(dependencies: Record<string, string>): Run["resolve"] {
    let resolved: Promise<Resolved> | undefined;
    return (onPick) =>
      (resolved ??= (async () => {
        const start = performance.now();
        const resolution = await resolveTree(
          { name: "project", version: "0.0.0", dependencies },
          {
            registry,
            onPick: (pkg, from) => onPick(pkg, from, sizes.get(pkg.resolved)),
            tarball: async (source) => sourceManifest(source, await readSource(source)),
          },
        );
        const ms = performance.now() - start;
        const lockfile = formatLockfile(toLockfile(resolution, registry.baseFor));
        return { resolution, ms, lockfile };
      })());
  }

  /** A tarball url's files, once per url: a run's own and the walk's share one download. */
  function readSource(url: string, onEntry: (entry: TarEntry) => void = () => {}) {
    let hit = sources.get(url);
    if (!hit) {
      hit = allowedSource(url)
        ? fetchTarball(url, undefined, undefined, onEntry)
        : Promise.reject(new Error(`Only tarballs on ${SOURCE_HOSTS.join(", ")} here, not ${url}`));
      sources.set(url, hit);
    }
    return hit;
  }

  /** A tarball url's package.json, as the resolver reads a tarball dependency. */
  function sourceManifest(url: string, tarball: Tarball): FullManifest {
    const m = manifestOf(tarball.files);
    if (!m) throw new Error(`${url} has no package.json`);
    if (typeof m.version !== "string") throw new Error(`${url} has no version`);
    return { ...m, dist: { tarball: url, integrity: tarball.integrity } };
  }

  /**
   * The package's own package.json, as the panel shows it. What only the registry adds is not
   * in it: `deprecated`, and `hasInstallScript`, which is worked out here as npm does.
   */
  function manifestOf(files: TarEntry[]): FullManifest | undefined {
    const file = files.find((f) => f.path === "package.json");
    if (!file) return undefined;
    try {
      const manifest = JSON.parse(new TextDecoder().decode(file.data)) as FullManifest & {
        scripts?: Record<string, string>;
      };
      const scripts = manifest.scripts ?? {};
      manifest.hasInstallScript = !!(
        scripts.preinstall ||
        scripts.install ||
        scripts.postinstall ||
        files.some((f) => f.path === "binding.gyp")
      );
      return manifest;
    } catch {
      return undefined;
    }
  }

  /** A tarball's files, checked against `integrity`, or hashed to learn it when there is none. */
  async function fetchTarball(
    url: string,
    integrity: string | undefined,
    fromStore: Promise<TarEntry[] | undefined> | undefined,
    onEntry: (entry: TarEntry) => void,
  ): Promise<Tarball> {
    const start = performance.now();
    // The store is keyed by integrity and every file by its own hash: nothing to check again.
    const stored = await fromStore;
    if (stored && integrity) {
      stored.sort((a, b) => a.path.localeCompare(b.path));
      return {
        url,
        integrity,
        bytes: 0,
        stored: true,
        files: stored,
        ms: performance.now() - start,
      };
    }
    const response = await logged(url);
    if (!response.ok || !response.body)
      throw new Error(`Registry returned ${response.status} for ${url}`);
    const verifier = integrity ? createVerifier(integrity) : createHasher("sha512");
    const reader = response.body.getReader();
    let bytes = 0;
    const read = async () => {
      const { done, value } = await reader.read();
      if (done) return undefined;
      bytes += value.byteLength;
      verifier.update(value);
      return value;
    };
    async function* body() {
      for (let chunk = await read(); chunk; chunk = await read()) yield chunk;
    }
    const files: TarEntry[] = [];
    for await (const entry of extractTar(body())) {
      files.push(entry);
      onEntry(entry);
    }
    // The archive can end before the bytes do; the integrity covers them all.
    while (await read());
    if ("verify" in verifier) await verifier.verify();
    else integrity = `sha512-${toBase64(await verifier.digest())}`;
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      url,
      integrity: integrity!,
      bytes,
      stored: false,
      files,
      ms: performance.now() - start,
    };
  }
}

const isReadme = (entry: TarEntry) => /^readme\.(md|markdown)$/i.test(entry.path);

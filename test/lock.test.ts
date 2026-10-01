import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatLockfile,
  fromCheckedLockfile,
  fromLockfile,
  LOCKFILE,
  lockCounts,
  parseLockfile,
  readLockfile,
  sameSpecs,
  sameTree,
  toLockfile,
  writeLockfile,
} from "../src/lock.ts";
import { hosts, registryBase, tarballUrl } from "../src/registry.ts";
import type { BaseFor } from "../src/registry.ts";
import type { Lockfile } from "../src/lock.ts";
import { valuesFor } from "../src/overrides.ts";
import type { Overrides } from "../src/overrides.ts";
import { filterPlatform } from "../src/resolve.ts";
import type { Resolution, ResolvedPackage, RootManifest } from "../src/resolve.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "upm-lock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** mulberry32 — a seeded generator, so a failing property test is reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A resolution shaped like one `resolveTree` would return: many packages, optional
 * flags, bins, platform fields, and dependency edges that all point at real packages. */
function generate(seed: number, count = 60): Resolution {
  const rnd = prng(seed);
  const ids = Array.from({ length: count }, (_, i) => ({
    name: rnd() < 0.3 ? `@scope${i % 3}/pkg${i}` : `pkg${i}`,
    version: `${1 + (i % 4)}.${i % 7}.${i % 11}${rnd() < 0.2 ? "-beta.1" : ""}`,
  }));
  const packages: Record<string, ResolvedPackage> = {};
  for (const { name, version } of ids) {
    const dependencies: Record<string, string> = {};
    for (const other of ids) if (rnd() < 3 / count) dependencies[other.name] = other.version;
    const pkg: ResolvedPackage = {
      name,
      version,
      resolved: `https://registry.test/${name}/-/${name.split("/").pop()}-${version}.tgz`,
      integrity: `sha512-${createHash("sha512").update(`${name}@${version}`).digest("base64")}`,
      dependencies,
      // Both replaced below: they are reachability, not a free choice.
      optional: true,
      dev: true,
      bin: rnd() < 0.3 ? { [name.split("/").pop() as string]: "bin/cli.js" } : {},
    };
    if (rnd() < 0.2) pkg.os = ["linux", "darwin"];
    if (rnd() < 0.2) pkg.cpu = ["x64"];
    if (rnd() < 0.1) pkg.libc = ["glibc"];
    if (rnd() < 0.2) pkg.peerDependencies = { react: "^18", "@scope0/pkg0": "*" };
    // An optional edge is a separate map, so it has to survive the trip as one.
    const spare = ids.find((other) => !(other.name in pkg.dependencies) && other.name !== name);
    if (spare && rnd() < 0.3) pkg.optionalDependencies = { [spare.name]: spare.version };
    packages[`${name}@${version}`] = pkg;
  }
  const groups = ["dependencies", "devDependencies", "optionalDependencies"] as const;
  const specs: NonNullable<Resolution["root"]["specs"]> = {};
  const root: Resolution["root"] = { name: "demo", version: "1.0.0", specs, dependencies: {} };
  for (const id of ids) {
    if (rnd() >= 0.2) continue;
    root.dependencies[id.name] = id.version;
    // Every root dep is declared somewhere, the way a real package.json declares it.
    const group = groups[Math.floor(rnd() * groups.length)]!;
    (specs[group] ??= {})[id.name] = `^${id.version}`;
  }
  return markFlags({ root, packages, warnings: [] });
}

/**
 * `dev` and `optional` are both reachability, so a fixture has to agree with its own graph:
 * `dev` is "no non-dev root edge reaches it", `optional` is "no all-required path reaches it".
 */
function markFlags(resolution: Resolution): Resolution {
  const walk = (seed: (name: string) => boolean, optionalEdges: boolean): Set<string> => {
    const seen = new Set<string>();
    const queue: string[] = [];
    const push = (key: string): void => {
      if (seen.has(key) || !resolution.packages[key]) return;
      seen.add(key);
      queue.push(key);
    };
    for (const [name, version] of Object.entries(resolution.root.dependencies)) {
      if (seed(name)) push(`${name}@${version}`);
    }
    for (const key of queue) {
      const pkg = resolution.packages[key]!;
      const maps = optionalEdges
        ? [pkg.dependencies, pkg.optionalDependencies ?? {}]
        : [pkg.dependencies];
      for (const map of maps) {
        for (const [name, version] of Object.entries(map)) push(`${name}@${version}`);
      }
    }
    return seen;
  };
  const rootOptional = new Set(Object.keys(resolution.root.specs?.optionalDependencies ?? {}));
  const prod = new Set([
    ...Object.keys(resolution.root.specs?.dependencies ?? {}),
    ...rootOptional,
  ]);
  const shipped = walk((name) => prod.has(name), true);
  const required = walk((name) => !rootOptional.has(name), false);
  for (const [key, pkg] of Object.entries(resolution.packages)) {
    pkg.dev = !shipped.has(key);
    pkg.optional = !required.has(key);
  }
  return resolution;
}

/** A minimal `ResolvedPackage`; `dev` is filled in by `markDev`. */
function entry(
  name: string,
  version: string,
  dependencies: Record<string, string> = {},
): ResolvedPackage {
  return {
    name,
    version,
    resolved: `https://x/${name}.tgz`,
    integrity: `sha512-${name}`,
    dependencies,
    optional: false,
    dev: true,
    bin: {},
  };
}

function base(): Lockfile {
  return {
    lockfileVersion: 1,
    root: {
      name: "demo",
      version: "1.0.0",
      specs: { dependencies: { a: "^1" } },
      dependencies: { a: "1.0.0" },
    },
    packages: {
      "a@1.0.0": {
        resolved: "https://registry.test/a/-/a-1.0.0.tgz",
        integrity: "sha512-aaa",
        dependencies: { b: "2.0.0" },
      },
      "b@2.0.0": { resolved: "https://registry.test/b/-/b-2.0.0.tgz", integrity: "sha512-bbb" },
    },
  };
}

/** Hand-edited lockfiles hold anything, so damage cases need an untyped view. */
function loose(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** The thrown error, so both its code and its message can be asserted. */
function thrown(run: () => unknown): { code?: string; message: string } {
  try {
    run();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("expected a throw");
}

describe("toLockfile / fromLockfile", () => {
  it("round-trips a generated resolution exactly", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const resolution = generate(seed);
      expect(Object.keys(resolution.packages).length).toBeGreaterThan(50);
      // Against the registry the urls name, or they would be told as off it.
      const at = hosts("https://registry.test");
      expect(fromLockfile(toLockfile(resolution, at), at)).toEqual(resolution);
    }
  });

  it("counts packages and their flags as the conversion derives them", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const lock = toLockfile(generate(seed));
      const all = Object.values(fromCheckedLockfile(lock).packages).filter((p) => !p.local);
      expect(lockCounts(lock)).toEqual({
        packages: all.length,
        optional: all.filter((p) => p.optional).length,
        dev: all.filter((p) => p.dev).length,
      });
    }
  });

  it("converts a parsed lockfile the same with and without the check", () => {
    const lock = parseLockfile(formatLockfile(toLockfile(generate(5))));
    expect(fromCheckedLockfile(lock)).toEqual(fromLockfile(lock));
  });

  it("survives a second round-trip byte for byte", () => {
    const once = toLockfile(generate(7));
    const twice = toLockfile(fromLockfile(once));
    expect(formatLockfile(twice)).toBe(formatLockfile(once));
  });

  it("keeps the root name, version and direct dependencies", () => {
    const lock = toLockfile(generate(3));
    expect(lock.root.name).toBe("demo");
    expect(lock.root.version).toBe("1.0.0");
    for (const [name, version] of Object.entries(lock.root.dependencies)) {
      expect(lock.packages).toHaveProperty([`${name}@${version}`]);
    }
  });

  it("has no warnings to give back", () => {
    const resolution = { ...generate(5), warnings: ["unmet peer dependency react@^18"] };
    const at = hosts("https://registry.test");
    expect(fromLockfile(toLockfile(resolution, at), at).warnings).toEqual([]);
  });

  it("fills the maps a lockfile omits", () => {
    const lock: Lockfile = {
      lockfileVersion: 1,
      root: { specs: { dependencies: { a: "^1" } }, dependencies: { a: "1.0.0" } },
      packages: { "a@1.0.0": { resolved: "https://x/a.tgz", integrity: "sha512-aaa" } },
    };
    expect(fromLockfile(lock).packages["a@1.0.0"]).toEqual({
      name: "a",
      offRegistry: true, // npmjs is not at x
      version: "1.0.0",
      resolved: "https://x/a.tgz",
      integrity: "sha512-aaa",
      dependencies: {},
      optional: false,
      dev: false,
      bin: {},
    });
  });

  it("splits a scoped key at the version, not the scope", () => {
    const lock: Lockfile = {
      lockfileVersion: 1,
      root: { dependencies: {} },
      packages: { "@scope/a@1.0.0-beta.1": { resolved: "https://x/a.tgz", integrity: "sha512-a" } },
    };
    const pkg = fromLockfile(lock).packages["@scope/a@1.0.0-beta.1"];
    expect(pkg).toMatchObject({ name: "@scope/a", version: "1.0.0-beta.1" });
  });

  it("rejects a malformed lockfile instead of half-resolving it", () => {
    const broken = { ...base(), lockfileVersion: 2 } as unknown as Lockfile;
    expect(thrown(() => fromLockfile(broken)).code).toBe("ELOCK");
  });
});

describe("derivable resolved urls", () => {
  const NPM = "https://registry.npmjs.org";
  const MIRROR = "https://npm.corp.internal/api/npm";

  function one(name: string, version: string, resolved: string): Resolution {
    return {
      root: {
        specs: { dependencies: { [name]: `^${version}` } },
        dependencies: { [name]: version },
      },
      packages: {
        [`${name}@${version}`]: {
          name,
          version,
          resolved,
          integrity: "sha512-aaa",
          dependencies: {},
          optional: false,
          dev: false,
          bin: {},
        },
      },
      warnings: [],
    };
  }

  it("builds the url every registry serves a tarball at", () => {
    expect(tarballUrl(NPM, "nanoid", "5.0.9")).toBe(`${NPM}/nanoid/-/nanoid-5.0.9.tgz`);
    // The scope is in the path but not in the file name.
    expect(tarballUrl(NPM, "@vue/shared", "3.5.13")).toBe(`${NPM}/@vue/shared/-/shared-3.5.13.tgz`);
    expect(tarballUrl(MIRROR, "@a/b", "1.0.0-beta.1")).toBe(`${MIRROR}/@a/b/-/b-1.0.0-beta.1.tgz`);
  });

  it("omits the url when it is the shape the registry would produce", () => {
    const lock = toLockfile(one("nanoid", "5.0.9", `${NPM}/nanoid/-/nanoid-5.0.9.tgz`), hosts(NPM));
    expect(lock.packages["nanoid@5.0.9"]).not.toHaveProperty("resolved");
    expect(formatLockfile(lock)).not.toContain("resolved");
  });

  it("names an alias's package, and reads one a lock of before named only by its url", () => {
    const url = (base: string) => `${base}/string-width/-/string-width-4.2.3.tgz`;
    const alias = one("str", "4.2.3", url(NPM));
    alias.packages["str@4.2.3"]!.fetchName = "string-width";
    const lock = toLockfile(alias, hosts(NPM));
    // The url too, for an upm that knows the alias by it alone.
    expect(lock.packages["str@4.2.3"]).toEqual({
      name: "string-width",
      resolved: url(NPM),
      integrity: "sha512-aaa",
    });
    expect(parseLockfile(formatLockfile(lock))).toEqual(lock);
    expect(fromLockfile(lock, hosts(NPM)).packages["str@4.2.3"]).toMatchObject({
      name: "str",
      fetchName: "string-width",
      resolved: url(NPM),
    });
    // Named without a url, it is fetched where its package is.
    const bare = { ...lock, packages: { "str@4.2.3": { name: "string-width", integrity: "x" } } };
    expect(fromLockfile(bare, hosts(MIRROR)).packages["str@4.2.3"]?.resolved).toBe(url(MIRROR));
    // As a lock from before names were kept holds it: the url alone says which package.
    const before = { ...lock, packages: { "str@4.2.3": { resolved: url(NPM), integrity: "x" } } };
    expect(fromLockfile(before, hosts(NPM)).packages["str@4.2.3"]).toMatchObject({
      fetchName: "string-width",
      resolved: url(NPM),
    });
    // Or in JSR's and GitHub's, a scoped name before the version; never a path that only ends so.
    for (const [resolved, real] of [
      ["https://npm.jsr.io/~/11/@jsr/std__path/4.2.3.tgz", "@jsr/std__path"],
      ["https://npm.pkg.github.com/download/@o/p/4.2.3/5f5b4a", "@o/p"],
      [`${NPM}/@types%2fnode/-/node-4.2.3.tgz`, "@types/node"],
      ["https://cdn.example.com/files/4.2.3.tgz", undefined],
      [`${NPM}/lodash-es/-/lodash-4.2.3.tgz`, undefined],
    ] as const) {
      const old = { ...lock, packages: { "str@4.2.3": { resolved, integrity: "x" } } };
      expect(fromLockfile(old, hosts(NPM)).packages["str@4.2.3"]?.fetchName, resolved).toBe(real);
    }
    // Written again, it is named.
    expect(toLockfile(fromLockfile(before, hosts(NPM)), hosts(NPM)).packages["str@4.2.3"]).toEqual({
      name: "string-width",
      resolved: url(NPM),
      integrity: "x",
    });
  });

  it("refuses a name an alias entry cannot have", () => {
    const lock = toLockfile(one("str", "4.2.3", `${NPM}/str/-/str-4.2.3.tgz`), hosts(NPM));
    const named = (name: unknown) => ({
      ...lock,
      packages: { "str@4.2.3": { name, integrity: "sha512-aaa" } },
    });
    expect(() => fromLockfile(named("string-width") as never)).not.toThrow();
    for (const bad of ["str", "", "../x", "@scope", 1]) {
      expect(() => fromLockfile(named(bad) as never), String(bad)).toThrow(/\.name must be/);
    }
  });

  it("keeps the url when the tarball is served from somewhere else", () => {
    const odd = "https://cdn.example.com/blobs/nanoid.tgz";
    const lock = toLockfile(one("nanoid", "5.0.9", odd), hosts(NPM));
    expect(lock.packages["nanoid@5.0.9"]?.resolved).toBe(odd);
    expect(fromLockfile(lock, hosts(MIRROR)).packages["nanoid@5.0.9"]?.resolved).toBe(odd);
  });

  it("rebuilds the url against whichever registry is installing", () => {
    // The point of the whole exercise: a lock written against a mirror installs from npmjs.
    const lock = toLockfile(one("@a/b", "1.0.0", `${MIRROR}/@a/b/-/b-1.0.0.tgz`), hosts(MIRROR));
    expect(lock.packages["@a/b@1.0.0"]).not.toHaveProperty("resolved");
    expect(fromLockfile(lock, hosts(NPM)).packages["@a/b@1.0.0"]?.resolved).toBe(
      `${NPM}/@a/b/-/b-1.0.0.tgz`,
    );
    expect(fromLockfile(lock, hosts(MIRROR)).packages["@a/b@1.0.0"]?.resolved).toBe(
      `${MIRROR}/@a/b/-/b-1.0.0.tgz`,
    );
  });

  it("derives a scoped name's url from its scope's registry, and says nothing of it", () => {
    // The generator scopes some names `@scope0`..`@scope2`; one of those lives elsewhere.
    const acme = "https://npm.acme.test/registry";
    const at = hosts(NPM, { "@scope1": `${acme}/` });
    const resolution = generate(6);
    for (const pkg of Object.values(resolution.packages)) {
      pkg.resolved = tarballUrl(at(pkg.name), pkg.name, pkg.version);
    }
    const names = Object.keys(resolution.packages);
    expect(names.some((key) => key.startsWith("@scope1/"))).toBe(true);
    const lock = toLockfile(resolution, at);
    expect(Object.values(lock.packages).every((e) => e.resolved === undefined)).toBe(true);
    expect(formatLockfile(lock)).not.toContain("acme.test");
    // Read back under the same .npmrc, every url is where it was; under none, npmjs.
    const back = fromLockfile(parseLockfile(formatLockfile(lock)), at);
    for (const [key, pkg] of Object.entries(resolution.packages)) {
      expect(back.packages[key]?.resolved).toBe(pkg.resolved);
    }
    const key = names.find((k) => k.startsWith("@scope1/")) as string;
    const [name, version] = [
      key.slice(0, key.lastIndexOf("@")),
      key.slice(key.lastIndexOf("@") + 1),
    ];
    expect(fromLockfile(lock, hosts(NPM)).packages[key]?.resolved).toBe(
      tarballUrl(NPM, name, version),
    );
    expect(fromLockfile(lock, at).packages[key]?.resolved).toBe(tarballUrl(acme, name, version));
  });

  it("keeps the url of an alias, whose key is not where its tarball lives", () => {
    // `string-width-cjs@npm:string-width@^4` installs under the alias, so the derived url
    // would name a package that does not exist. This is the case the field is there for.
    const lock = toLockfile(
      one("string-width-cjs", "4.2.3", `${NPM}/string-width/-/string-width-4.2.3.tgz`),
      hosts(NPM),
    );
    expect(lock.packages["string-width-cjs@4.2.3"]?.resolved).toBe(
      `${NPM}/string-width/-/string-width-4.2.3.tgz`,
    );
  });

  it("round-trips a generated resolution through the default registry", () => {
    const resolution = generate(11);
    for (const pkg of Object.values(resolution.packages)) {
      pkg.resolved = tarballUrl(NPM, pkg.name, pkg.version);
    }
    const lock = toLockfile(resolution, hosts(NPM));
    expect(Object.values(lock.packages).every((e) => e.resolved === undefined)).toBe(true);
    const back = fromLockfile(parseLockfile(formatLockfile(lock)), hosts(NPM));
    for (const [key, pkg] of Object.entries(resolution.packages)) {
      expect(back.packages[key]?.resolved).toBe(pkg.resolved);
    }
  });

  it("agrees with the client on a base url that has a trailing slash", () => {
    const resolved = `${MIRROR}/nanoid/-/nanoid-5.0.9.tgz`;
    const lock = toLockfile(one("nanoid", "5.0.9", resolved), hosts(registryBase(`${MIRROR}///`)));
    expect(lock.packages["nanoid@5.0.9"]).not.toHaveProperty("resolved");
  });
});

describe("resolved urls off the registry", () => {
  const NPM = "https://registry.npmjs.org";
  const MIRROR = "https://npm.corp.internal/api/npm";

  /** The keys a lockfile fetches from a host that is none of its registries'. */
  const elsewhere = (lock: Lockfile, at: BaseFor) =>
    Object.entries(fromLockfile(lock, at).packages)
      .filter(([, pkg]) => pkg.offRegistry)
      .map(([key]) => key);

  /** Each key a direct dependency, fetched from its url. */
  function locked(resolved: Record<string, string>): Lockfile {
    const split = (key: string) => [
      key.slice(0, key.lastIndexOf("@")),
      key.slice(key.lastIndexOf("@") + 1),
    ];
    return {
      lockfileVersion: 1,
      root: {
        specs: {
          dependencies: Object.fromEntries(Object.keys(resolved).map((k) => [split(k)[0], "*"])),
        },
        dependencies: Object.fromEntries(Object.keys(resolved).map(split)),
      },
      packages: Object.fromEntries(
        Object.entries(resolved).map(([key, url]) => [
          key,
          { resolved: url, integrity: "sha512-a" },
        ]),
      ),
    };
  }

  it("marks the packages a lockfile fetches from another host", () => {
    const lock = locked({
      "a@1.0.0": "https://evil.test/a.tgz",
      "b@1.0.0": "https://evil.test/b.tgz",
      "c@1.0.0": "http://other.test/c.tgz",
    });
    expect(elsewhere(lock, hosts(MIRROR))).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0"]);
  });

  it("marks no url under the registry, npmjs, or a scope's registry", () => {
    const acme = "https://npm.acme.test/registry";
    const lock = locked({
      "a@1.0.0": `${MIRROR}/a/-/a-1.0.0.tgz?odd`,
      "b@1.0.0": `${NPM}/b/-/b-1.0.0.tgz`,
      "@acme/c@1.0.0": `${acme}/download/c/1.0.0`,
      // The scheme and the host's case are not a different registry.
      "d@1.0.0": "http://NPM.corp.internal/api/npm/d.tgz",
      // A scoped name's `/` encoded, and the scope in the file name, as GitLab and others serve.
      "@acme/e@1.0.0": `${acme}/@acme%2fe/-/@acme%2Fe-1.0.0.tgz`,
      "@acme/f@1.0.0-rc.1": `${acme}/projects/7/@acme/f/-/f-1.0.0-rc.1.tgz`,
    });
    expect(elsewhere(lock, hosts(MIRROR, { "@acme": acme }))).toEqual([]);
  });

  it("marks a url in a registry's layout that names another package or version", () => {
    // A registry serves anyone's tarball there, and a tarball may say it is any package.
    const lock = locked({
      "a@1.0.0": `${NPM}/evil/-/evil-2.0.0.tgz`,
      "b@1.0.0": `${NPM}/b/-/b-0.9.0.tgz`,
      "c@1.0.0": `${MIRROR}/c/-/odd-1.0.0.tgz`,
      "d@1.0.0": `${NPM}/@evil%2fx/-/d-1.0.0.tgz`,
      "@s/e@1.0.0": `${NPM}/@s/other/-/e-1.0.0.tgz`,
      // What a server might read as another path.
      "f@1.0.0": `${NPM}/evil/-/evil-2.0.0.tgz%3f/f/-/f-1.0.0.tgz`,
      "g@1.0.0": `${NPM}/evil%2f-%2fevil-2.0.0.tgz/g/-/g-1.0.0.tgz`,
      "h@1.0.0": `${NPM}/h/-/h-1.0.0.tgz/../../../evil/-/evil-2.0.0.tgz`,
      "i@1.0.0": `${NPM}/i/-/i-1.0.0.tgz/`,
    });
    expect(elsewhere(lock, hosts(MIRROR))).toEqual(Object.keys(lock.packages));
  });

  it("marks no alias fetched from the registry of the package it names", () => {
    const jsr = "https://npm.jsr.io";
    const github = "https://npm.pkg.github.com";
    const lock = locked({
      // `@std/path: npm:@jsr/std__path@^1`: the alias is read from npmjs, its package from JSR.
      "@std/path@1.0.8": `${jsr}/~/11/@jsr/std__path/1.0.8.tgz`,
      // `lib: npm:@owner/lib@^1`, the scope on GitHub Packages.
      "lib@1.0.0": `${github}/download/@owner/lib/1.0.0/0123abcd`,
      // `@acme/lodash: npm:lodash@^4`: an unscoped package, from the mirror.
      "@acme/lodash@4.17.21": `${MIRROR}/lodash/-/lodash-4.17.21.tgz`,
    });
    const at = hosts(MIRROR, { "@jsr": jsr, "@owner": github, "@acme": "https://acme.test" });
    expect(elsewhere(lock, at)).toEqual([]);
  });

  it("marks a url it cannot read, rather than fail on it", () => {
    const lock = locked({ "a@1.0.0": "https://" });
    expect(elsewhere(lock, hosts(MIRROR))).toEqual(["a@1.0.0"]);
  });

  it("goes by the registry's host, not its path, and not another's", () => {
    // GitLab's instance registry names each project's own endpoint.
    const gitlab = "https://gitlab.test/api/v4/packages/npm";
    const project = locked({
      "@g/a@1.0.0": "https://gitlab.test/api/v4/projects/7/packages/npm/@g/a/-/@g/a-1.0.0.tgz",
    });
    expect(elsewhere(project, hosts(MIRROR, { "@g": gitlab }))).toEqual([]);
    const lock = locked({ "a@1.0.0": "https://npm.corp.internal.test/api/npm/a.tgz" });
    expect(elsewhere(lock, hosts(MIRROR))).toHaveLength(1);
    // A scope sent elsewhere does not vouch for an unscoped name.
    const acme = "https://npm.acme.test";
    const other = locked({ "b@1.0.0": `${acme}/b.tgz` });
    expect(elsewhere(other, hosts(MIRROR, { "@acme": acme }))).toHaveLength(1);
    // Nor does npmjs, or the default registry, for a scope sent elsewhere: anyone may hold
    // `@acme` there. Nor another scope's host named in the path.
    const confused = locked({
      "@acme/x@1.0.0": `${NPM}/@acme/x/-/x-1.0.0.tgz`,
      "@acme/y@1.0.0": `${MIRROR}/@acme/y/-/y-1.0.0.tgz`,
      "c@1.0.0": `${acme}/@acme/../c/-/c-1.0.0.tgz`,
    });
    expect(elsewhere(confused, hosts(MIRROR, { "@acme": acme }))).toEqual([
      "@acme/x@1.0.0",
      "@acme/y@1.0.0",
      "c@1.0.0",
    ]);
  });

  it("leaves tarball dependencies alone: their key says where they are", () => {
    const lock: Lockfile = {
      lockfileVersion: 1,
      root: {
        specs: { dependencies: { t: "https://files.test/t.tgz" } },
        dependencies: { t: "https://files.test/t.tgz" },
      },
      packages: { "t@https://files.test/t.tgz": { version: "1.0.0", integrity: "sha512-a" } },
    };
    expect(elsewhere(lock, hosts(NPM))).toEqual([]);
  });
});

describe("diff churn", () => {
  /** Three dependents on `dep@1.0.0`, plus the root, so a bump has somewhere to ripple. */
  function tree(version: string): Resolution {
    const dep = entry("dep", version);
    dep.integrity = `sha512-dep-${version}`; // a bump is new content, so this moves too
    const packages: Record<string, ResolvedPackage> = { [`dep@${version}`]: dep };
    for (const name of ["a", "b", "c"])
      packages[`${name}@1.0.0`] = entry(name, "1.0.0", { dep: version });
    return markFlags({
      root: {
        specs: { dependencies: { a: "^1", b: "^1", c: "^1", dep: "^1" } },
        dependencies: { a: "1.0.0", b: "1.0.0", c: "1.0.0", dep: version },
      },
      warnings: [],
      packages,
    });
  }

  it("costs one line per edge pointing at it, plus the entry's own two", () => {
    // Resolved edges cost diff churn in exchange for installs without version selection.
    const before = formatLockfile(toLockfile(tree("1.0.0"))).split("\n");
    const after = formatLockfile(toLockfile(tree("1.1.0"))).split("\n");
    expect(after).toHaveLength(before.length); // a bump never adds or removes a line
    const changed = before.filter((line, i) => line !== after[i]);
    // Its key line and its integrity, then one line each for the root edge and a, b, c.
    const edges = changed.filter((line) => line.includes('"dep": "1.0.0"'));
    expect(edges).toHaveLength(4);
    expect(changed).toHaveLength(2 + edges.length);
  });
});

describe("dev packages", () => {
  /** `tool` is the root's only dep; `dev` follows from which group declares it. */
  const lock = (dev: boolean): Lockfile =>
    toLockfile({
      root: {
        specs: dev ? { devDependencies: { tool: "^1" } } : { dependencies: { tool: "^1" } },
        dependencies: { tool: "1.0.0" },
      },
      warnings: [],
      packages: {
        "tool@1.0.0": {
          name: "tool",
          version: "1.0.0",
          resolved: "https://x/tool.tgz",
          integrity: "sha512-t",
          dependencies: {},
          optional: false,
          dev,
          bin: {},
        },
      },
    });

  it("is never written to an entry", () => {
    // `root.specs.devDependencies` still names it; no `packages` entry carries a flag.
    expect(lock(true).packages["tool@1.0.0"]).not.toHaveProperty("dev");
    expect(lock(false).packages["tool@1.0.0"]).not.toHaveProperty("dev");
    expect(formatLockfile(lock(true))).not.toContain('"dev"');
  });

  it("comes back from which root.specs group declared it", () => {
    expect(fromLockfile(lock(true)).packages["tool@1.0.0"]?.dev).toBe(true);
    expect(fromLockfile(lock(false)).packages["tool@1.0.0"]?.dev).toBe(false);
  });

  it("keeps a dev package in root.dependencies, since one lockfile describes both installs", () => {
    expect(lock(true).root.dependencies).toEqual({ tool: "1.0.0" });
  });

  it("spreads down the graph: a prod root dep makes its whole subtree prod", () => {
    const deep = fromLockfile(
      toLockfile(
        markFlags({
          root: {
            specs: { dependencies: { app: "^1" }, devDependencies: { tool: "^1" } },
            dependencies: { app: "1.0.0", tool: "1.0.0" },
          },
          warnings: [],
          packages: {
            "app@1.0.0": entry("app", "1.0.0", { shared: "1.0.0" }),
            "tool@1.0.0": entry("tool", "1.0.0", { onlydev: "1.0.0" }),
            "shared@1.0.0": entry("shared", "1.0.0"),
            "onlydev@1.0.0": entry("onlydev", "1.0.0"),
          },
        }),
      ),
    );
    expect(deep.packages["app@1.0.0"]?.dev).toBe(false);
    expect(deep.packages["shared@1.0.0"]?.dev).toBe(false); // reached through a prod edge
    expect(deep.packages["tool@1.0.0"]?.dev).toBe(true);
    expect(deep.packages["onlydev@1.0.0"]?.dev).toBe(true);
  });

  it("follows an optional edge too, so a prod optional build is not dev", () => {
    const pkg = entry("app", "1.0.0");
    pkg.optionalDependencies = { binding: "1.0.0" };
    const out = fromLockfile(
      toLockfile(
        markFlags({
          root: { specs: { dependencies: { app: "^1" } }, dependencies: { app: "1.0.0" } },
          warnings: [],
          packages: { "app@1.0.0": pkg, "binding@1.0.0": entry("binding", "1.0.0") },
        }),
      ),
    );
    expect(out.packages["binding@1.0.0"]?.dev).toBe(false);
  });

  it("rejects a root dep that no root.specs group declares", () => {
    // Without a group there is nothing to read the flag off, and it would silently be dev.
    const text = JSON.stringify({
      lockfileVersion: 1,
      root: { specs: { dependencies: { b: "^1" } }, dependencies: { a: "1.0.0" } },
      packages: { "a@1.0.0": { integrity: "sha512-a" } },
    });
    const error = thrown(() => parseLockfile(text));
    expect(error.code).toBe("ELOCK");
    expect(error.message).toMatch(/root\.dependencies\["a"\] is in no root\.specs group/);
  });
});

describe("the optional flag", () => {
  it("comes back from which map holds the edge, not from a field", () => {
    const host = entry("host", "1.0.0", { need: "1.0.0" });
    host.optionalDependencies = { binding: "1.0.0" };
    const lock = toLockfile(
      markFlags({
        root: { specs: { dependencies: { host: "^1" } }, dependencies: { host: "1.0.0" } },
        warnings: [],
        packages: {
          "host@1.0.0": host,
          "need@1.0.0": entry("need", "1.0.0"),
          "binding@1.0.0": entry("binding", "1.0.0"),
        },
      }),
    );
    expect(formatLockfile(lock)).not.toContain('"optional"');
    const back = fromLockfile(lock).packages;
    expect(back["host@1.0.0"]?.optional).toBe(false);
    expect(back["need@1.0.0"]?.optional).toBe(false);
    expect(back["binding@1.0.0"]?.optional).toBe(true);
  });

  it("clears on one all-required path, even when an optional edge also reaches it", () => {
    // "Both flags are reachability, not inheritance" — one path that avoids the edge clears it.
    const a = entry("a", "1.0.0", { shared: "1.0.0" });
    const b = entry("b", "1.0.0");
    b.optionalDependencies = { shared: "1.0.0" };
    const back = fromLockfile(
      toLockfile(
        markFlags({
          root: {
            specs: { dependencies: { a: "^1", b: "^1" } },
            dependencies: { a: "1.0.0", b: "1.0.0" },
          },
          warnings: [],
          packages: {
            "a@1.0.0": a,
            "b@1.0.0": b,
            "shared@1.0.0": entry("shared", "1.0.0"),
          },
        }),
      ),
    ).packages;
    expect(back["shared@1.0.0"]?.optional).toBe(false);
  });

  it("makes a root optionalDependency optional, and everything under it", () => {
    const back = fromLockfile(
      toLockfile(
        markFlags({
          root: {
            specs: { optionalDependencies: { binding: "^1" } },
            dependencies: { binding: "1.0.0" },
          },
          warnings: [],
          packages: {
            "binding@1.0.0": entry("binding", "1.0.0", { helper: "1.0.0" }),
            "helper@1.0.0": entry("helper", "1.0.0"),
          },
        }),
      ),
    ).packages;
    expect(back["binding@1.0.0"]?.optional).toBe(true);
    expect(back["helper@1.0.0"]?.optional).toBe(true);
  });

  it("cannot disagree with the edges the way a stored flag could", () => {
    // An older upm wrote locks with platform bindings flagged optional while they sat in a
    // required `dependencies` map. `filterPlatform` would then drop a package the root needs
    // in silence; with the flag derived, that lockfile cannot be expressed.
    const text = JSON.stringify({
      lockfileVersion: 1,
      root: { specs: { dependencies: { host: "^1" } }, dependencies: { host: "1.0.0" } },
      packages: {
        "host@1.0.0": { integrity: "sha512-h", dependencies: { binding: "1.0.0" } },
        // A hand-written `"optional": true` here is ignored, not obeyed.
        "binding@1.0.0": { integrity: "sha512-b", optional: true, os: ["darwin"] },
      },
    });
    const out = fromLockfile(parseLockfile(text));
    expect(out.packages["binding@1.0.0"]?.optional).toBe(false);
    // So a platform it does not run on is loud, not silent.
    expect(() => filterPlatform(out, { os: "linux", cpu: "x64", libc: "glibc" })).toThrow(
      expect.objectContaining({ code: "EBADPLATFORM" }),
    );
  });
});

describe("optionalDependencies", () => {
  const withOptional = (): Lockfile => ({
    ...base(),
    packages: {
      ...base().packages,
      "a@1.0.0": { ...base().packages["a@1.0.0"]!, optionalDependencies: { b: "2.0.0" } },
    },
  });

  it("round-trips through format and parse", () => {
    const lock = withOptional();
    const back = parseLockfile(formatLockfile(lock));
    expect(back.packages["a@1.0.0"]?.optionalDependencies).toEqual({ b: "2.0.0" });
    expect(back.packages["a@1.0.0"]?.dependencies).toEqual({ b: "2.0.0" });
  });

  it("survives fromLockfile onto the resolution", () => {
    const out = fromLockfile(withOptional());
    expect(out.packages["a@1.0.0"]?.optionalDependencies).toEqual({ b: "2.0.0" });
  });

  it("is left out when there is nothing in it", () => {
    expect(formatLockfile(base())).not.toContain("optionalDependencies");
  });

  it("is written right after the required edges", () => {
    const text = formatLockfile(withOptional());
    expect(text).toMatch(/"dependencies": \{[^}]*\},\s*"optionalDependencies": \{/);
  });

  it("rejects an edge pointing at a package that is not there", () => {
    const damaged = withOptional();
    damaged.packages["a@1.0.0"]!.optionalDependencies = { ghost: "9.9.9" };
    expect(thrown(() => parseLockfile(JSON.stringify(damaged))).message).toMatch(
      /optionalDependencies\["ghost"\] points at ghost@9\.9\.9/,
    );
  });

  it("rejects a map that is not strings", () => {
    const damaged = loose(withOptional());
    (damaged.packages as Record<string, Record<string, unknown>>)["a@1.0.0"]!.optionalDependencies =
      { b: 2 };
    expect(thrown(() => parseLockfile(JSON.stringify(damaged))).code).toBe("ELOCK");
  });
});

describe("root.specs", () => {
  const withSpecs = (specs: Lockfile["root"]["specs"]): Lockfile => ({
    lockfileVersion: 1,
    root: { specs, dependencies: {} },
    packages: {},
  });

  it("round-trips through format and parse", () => {
    const lock = withSpecs({ dependencies: { a: "^1" }, devDependencies: { b: "*" } });
    expect(parseLockfile(formatLockfile(lock)).root.specs).toEqual(lock.root.specs);
  });

  it("sorts the ranges and drops empty groups", () => {
    const lock = withSpecs({ dependencies: { z: "^2", a: "^1" }, optionalDependencies: {} });
    expect(formatLockfile(lock)).toContain(
      '"specs": {\n      "dependencies": {\n        "a": "^1",',
    );
    expect(formatLockfile(lock)).not.toContain("optionalDependencies");
  });

  it("writes specs before the resolved dependencies", () => {
    const text = formatLockfile(withSpecs({ dependencies: { a: "^1" } }));
    expect(text.indexOf('"specs"')).toBeLessThan(text.indexOf('"dependencies": {}'));
  });

  it("omits specs entirely when every group is empty", () => {
    expect(formatLockfile(withSpecs({ dependencies: {} }))).not.toContain("specs");
  });

  it("rejects specs that are not string maps", () => {
    const damaged = { ...withSpecs(undefined), root: { specs: { dependencies: 1 }, deps: {} } };
    expect(thrown(() => parseLockfile(JSON.stringify(damaged))).code).toBe("ELOCK");
    const notAnObject = JSON.stringify({
      lockfileVersion: 1,
      root: { specs: [], dependencies: {} },
      packages: {},
    });
    expect(thrown(() => parseLockfile(notAnObject)).message).toMatch(/root\.specs must be/);
    const notAMap = JSON.stringify({
      lockfileVersion: 1,
      root: { specs: { devDependencies: { a: 1 } }, dependencies: {} },
      packages: {},
    });
    expect(thrown(() => parseLockfile(notAMap)).message).toMatch(/root\.specs\.devDependencies/);
  });
});

describe("sameSpecs", () => {
  it("ignores key and group order", () => {
    expect(
      sameSpecs(
        { devDependencies: { b: "*" }, dependencies: { z: "^2", a: "^1" } },
        { dependencies: { a: "^1", z: "^2" }, devDependencies: { b: "*" } },
      ),
    ).toBe(true);
  });

  it("treats undefined and every-group-empty as the same", () => {
    expect(sameSpecs(undefined, { dependencies: {}, devDependencies: {} })).toBe(true);
  });

  it("sees a range that changed", () => {
    expect(sameSpecs({ dependencies: { a: "^1" } }, { dependencies: { a: "^2" } })).toBe(false);
  });

  it("sees a name that moved into optionalDependencies", () => {
    // The lockfile still resolves `a` to the same version, so comparing versions would miss it.
    expect(sameSpecs({ dependencies: { a: "^1" } }, { optionalDependencies: { a: "^1" } })).toBe(
      false,
    );
  });

  it("sees a skipped optional whose range changed", () => {
    // `a` never made it into root.dependencies, so only the specs record the change.
    expect(
      sameSpecs({ optionalDependencies: { a: "^2" } }, { optionalDependencies: { a: "^1" } }),
    ).toBe(false);
  });

  it("sees a name added or removed", () => {
    expect(sameSpecs({ dependencies: { a: "^1" } }, { dependencies: { a: "^1", b: "^1" } })).toBe(
      false,
    );
    expect(sameSpecs({ dependencies: { a: "^1" } }, undefined)).toBe(false);
  });
});

describe("formatLockfile", () => {
  it("is byte-stable across serializations", () => {
    const lock = toLockfile(generate(11));
    expect(formatLockfile(lock)).toBe(formatLockfile(lock));
  });

  it("does not depend on key insertion order", () => {
    const forward = base();
    const backward: Lockfile = {
      lockfileVersion: 1,
      root: {
        dependencies: forward.root.dependencies,
        specs: forward.root.specs,
        version: forward.root.version,
        name: forward.root.name,
      },
      packages: Object.fromEntries(Object.entries(forward.packages).reverse()),
    };
    expect(formatLockfile(backward)).toBe(formatLockfile(forward));
  });

  it("sorts package and dependency keys", () => {
    const lock = base();
    lock.packages["a@1.0.0"]!.dependencies = { z: "2.0.0", b: "2.0.0" };
    lock.packages["z@2.0.0"] = { resolved: "https://x/z.tgz", integrity: "sha512-zzz" };
    const text = formatLockfile(lock);
    expect(text.indexOf('"a@1.0.0"')).toBeLessThan(text.indexOf('"b@2.0.0"'));
    expect(text.indexOf('"b@2.0.0"')).toBeLessThan(text.indexOf('"z@2.0.0"'));
    expect(text.indexOf('"b": "2.0.0"')).toBeLessThan(text.indexOf('"z": "2.0.0"'));
  });

  it("omits empty and false fields", () => {
    const lock: Lockfile = {
      lockfileVersion: 1,
      root: { dependencies: {} },
      packages: {
        "a@1.0.0": {
          resolved: "https://x/a.tgz",
          integrity: "sha512-aaa",
          dependencies: {},
          bin: {},
          os: [],
          cpu: [],
          libc: [],
          peerDependencies: {},
        },
      },
    };
    // root.dependencies is the one map that stays, empty or not.
    expect(formatLockfile(lock)).toBe(`{
  "lockfileVersion": 1,
  "root": {
    "dependencies": {}
  },
  "packages": {
    "a@1.0.0": {
      "resolved": "https://x/a.tgz",
      "integrity": "sha512-aaa"
    }
  }
}
`);
  });

  it("never writes optional: it is which map the edge is in", () => {
    const pkg = entry("a", "1.0.0");
    pkg.optional = true;
    const lock = toLockfile({
      root: { dependencies: {} },
      warnings: [],
      packages: { "a@1.0.0": pkg },
    });
    expect(formatLockfile(lock)).not.toContain('"optional"');
  });

  it("indents by two and ends with a newline", () => {
    const text = formatLockfile(base());
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "lockfileVersion": 1,');
    expect(text).toContain('\n  "packages": {');
  });
});

describe("parseLockfile", () => {
  it("round-trips its own output", () => {
    const lock = toLockfile(generate(2));
    expect(parseLockfile(formatLockfile(lock))).toEqual(lock);
  });

  const cases: [string, unknown | string, RegExp][] = [
    ["not JSON", "{ nope", /not valid JSON/],
    ["not an object", "42", /must be an object/],
    ["an array", "[]", /must be an object/],
    ["a missing version", { root: { dependencies: {} }, packages: {} }, /lockfileVersion/],
    ["a future version", { ...base(), lockfileVersion: 3 }, /lockfileVersion 3/],
    ["a string version", { ...base(), lockfileVersion: "1" }, /lockfileVersion "1"/],
    ["no root", { lockfileVersion: 1, packages: {} }, /root must be an object/],
    [
      "root deps that are not an object",
      { lockfileVersion: 1, root: { dependencies: [] }, packages: {} },
      /root\.dependencies must be an object/,
    ],
    ["no packages", { lockfileVersion: 1, root: { dependencies: {} } }, /packages must be/],
    [
      "packages as an array",
      { lockfileVersion: 1, root: { dependencies: {} }, packages: [] },
      /packages must be/,
    ],
  ];

  for (const [what, value, message] of cases) {
    it(`rejects ${what}`, () => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const error = thrown(() => parseLockfile(text));
      expect(error.code).toBe("ELOCK");
      expect(error.message).toMatch(message);
    });
  }

  const entryCases: [string, (lock: Lockfile) => void, RegExp][] = [
    [
      "a key with no version",
      (lock) => {
        lock.packages["lodash"] = { resolved: "https://x/l.tgz", integrity: "sha512-l" };
      },
      /"lodash" is not name@version/,
    ],
    [
      "a scoped key with no version",
      (lock) => {
        lock.packages["@scope/pkg"] = { resolved: "https://x/p.tgz", integrity: "sha512-p" };
      },
      /"@scope\/pkg" is not name@version/,
    ],
    [
      "a key ending in @",
      (lock) => {
        lock.packages["pkg@"] = { resolved: "https://x/p.tgz", integrity: "sha512-p" };
      },
      /is not name@version/,
    ],
    [
      "an entry that is not an object",
      (lock) => {
        loose(lock.packages)["c@1.0.0"] = "nope";
      },
      /must be an object/,
    ],
    [
      "a missing integrity",
      (lock) => {
        delete (lock.packages["b@2.0.0"] as Partial<Lockfile["packages"][string]>).integrity;
      },
      /\.integrity must be a non-empty string/,
    ],
    [
      "an empty resolved",
      (lock) => {
        lock.packages["b@2.0.0"]!.resolved = "";
      },
      /\.resolved must be a non-empty string/,
    ],
    [
      "a non-string integrity",
      (lock) => {
        loose(lock.packages["b@2.0.0"])["integrity"] = 512;
      },
      /\.integrity must be a non-empty string/,
    ],
    [
      "a dangling dependency reference",
      (lock) => {
        lock.packages["a@1.0.0"]!.dependencies = { b: "9.9.9" };
      },
      /points at b@9\.9\.9, which is not in packages/,
    ],
    [
      "a dangling root reference",
      (lock) => {
        lock.root.dependencies["ghost"] = "1.0.0";
      },
      /root\.dependencies\["ghost"\] points at ghost@1\.0\.0/,
    ],
    [
      "a dependency version that is not a string",
      (lock) => {
        loose(lock.packages["a@1.0.0"])["dependencies"] = { b: 2 };
      },
      /\["b"\] must be a string/,
    ],
    [
      "os that is not a list of strings",
      (lock) => {
        loose(lock.packages["b@2.0.0"])["os"] = "linux";
      },
      /\.os must be an array of strings/,
    ],
    [
      "a bin value that is not a string",
      (lock) => {
        loose(lock.packages["b@2.0.0"])["bin"] = { b: 1 };
      },
      /\.bin\["b"\] must be a string/,
    ],
    [
      "a peer kind that is neither",
      (lock) => {
        loose(lock.packages["a@1.0.0"])["peerDependencies"] = { b: "^2" };
        loose(lock.packages["a@1.0.0"])["peers"] = { b: "maybe" };
      },
      /\.peers\["b"\] must be required or optional/,
    ],
    [
      "a settled peer that is not a declared one",
      (lock) => {
        loose(lock.packages["a@1.0.0"])["peers"] = { b: "required" };
      },
      /\.peers\["b"\] is not in packages\["a@1.0.0"\]\.peerDependencies/,
    ],
  ];

  for (const [what, damage, message] of entryCases) {
    it(`rejects ${what}`, () => {
      const lock = base();
      damage(lock);
      const error = thrown(() => parseLockfile(JSON.stringify(lock)));
      expect(error.code).toBe("ELOCK");
      expect(error.message).toMatch(message);
    });
  }

  it("accepts a truncated file only as an error", () => {
    const text = formatLockfile(toLockfile(generate(4)));
    const error = thrown(() => parseLockfile(text.slice(0, Math.floor(text.length / 2))));
    expect(error.code).toBe("ELOCK");
  });
});

describe("readLockfile / writeLockfile", () => {
  it("returns undefined when there is no lockfile", async () => {
    expect(await readLockfile(dir)).toBeUndefined();
  });

  it("writes and reads back the same lockfile", async () => {
    const lock = toLockfile(generate(9));
    await writeLockfile(dir, lock);
    expect(await readLockfile(dir)).toEqual(lock);
  });

  it("writes atomically and leaves no temp file", async () => {
    const lock = base();
    await writeLockfile(dir, lock);
    await writeLockfile(dir, lock);
    expect(await readdir(dir)).toEqual([LOCKFILE]);
    expect(await readFile(join(dir, LOCKFILE), "utf8")).toBe(formatLockfile(lock));
  });

  it("writes the same bytes for the same resolution", async () => {
    const resolution = generate(6);
    await writeLockfile(dir, toLockfile(resolution));
    const first = await readFile(join(dir, LOCKFILE));
    await writeLockfile(dir, toLockfile(resolution));
    expect(await readFile(join(dir, LOCKFILE))).toEqual(first);
  });

  it("throws ELOCK when the lockfile is present but broken", async () => {
    await writeFile(join(dir, LOCKFILE), '{"lockfileVersion":9}');
    await expect(readLockfile(dir)).rejects.toMatchObject({ code: "ELOCK" });
  });

  it.each([
    ["traversal", "../evil@1.0.0"],
    ["a path separator", "a/b@1.0.0"],
    ["a reserved name", "node_modules@1.0.0"],
    ["a leading hyphen", "-rf@1.0.0"],
    ["a range instead of a version", "a@^1.0.0"],
  ])("rejects a package key with %s", (_label, key) => {
    // Stage 5 turns both halves of the key into path segments.
    const text = JSON.stringify({
      lockfileVersion: 1,
      root: { dependencies: {} },
      packages: { [key]: { resolved: "https://r/x.tgz", integrity: "sha512-x" } },
    });

    expect(() => parseLockfile(text)).toThrow(/package key/);
  });

  it.each([["@scope/pkg@1.0.0"], ["JSONStream@1.3.5"]])("accepts the real key %s", (key) => {
    const text = JSON.stringify({
      lockfileVersion: 1,
      root: { dependencies: {} },
      packages: { [key]: { resolved: "https://r/x.tgz", integrity: "sha512-x" } },
    });

    expect(Object.keys(parseLockfile(text).packages)).toEqual([key]);
  });

  it("refuses to serialize a lockfile its own reader would reject", () => {
    const lock: Lockfile = {
      lockfileVersion: 1,
      root: { dependencies: {} },
      packages: {
        "a@1.0.0": {
          resolved: "https://r/a.tgz",
          integrity: "sha512-x",
          dependencies: { ghost: "1.0.0" },
        },
      },
    };

    // Otherwise `lock` writes a file `fetch --lock` can never read.
    expect(() => formatLockfile(lock)).toThrow(/ghost/);
  });

  it.each([
    ["a key that climbs out", { "../../../victim": "index.js" }],
    ["a target that climbs out", { pwn: "../../../../etc/passwd" }],
    ["an absolute target", { pwn: "/etc/passwd" }],
  ])("rejects %s in bin", (_label, bin) => {
    // The linker rm -rf's the bin path before symlinking, so this is arbitrary deletion.
    const text = JSON.stringify({
      lockfileVersion: 1,
      root: { dependencies: {} },
      packages: { "a@1.0.0": { resolved: "https://r/a.tgz", integrity: "sha512-x", bin } },
    });

    expect(() => parseLockfile(text)).toThrow(/escapes the package directory/);
  });

  it.each([
    ["a data url", "data:application/octet-stream;base64,H4sIAAAA"],
    ["a file url", "file:///etc/passwd"],
    ["a bare path", "/tmp/evil.tgz"],
  ])("rejects %s as resolved", (_label, resolved) => {
    // A lockfile must name content a registry served, not carry a payload of its own.
    const text = JSON.stringify({
      lockfileVersion: 1,
      root: { dependencies: {} },
      packages: { "a@1.0.0": { resolved, integrity: "sha512-x" } },
    });

    expect(() => parseLockfile(text)).toThrow(/http or https/);
  });
});

describe("workspaces", () => {
  const nanoid = (): ResolvedPackage => ({
    name: "nanoid",
    version: "5.0.0",
    resolved: tarballUrl(registryBase(), "nanoid", "5.0.0"),
    integrity: "sha512-nnn",
    dependencies: {},
    optional: false,
    dev: false,
    bin: { nanoid: "bin/nanoid.js" },
  });
  const tap = (): ResolvedPackage => ({
    name: "tap",
    version: "1.0.0",
    resolved: tarballUrl(registryBase(), "tap", "1.0.0"),
    integrity: "sha512-ttt",
    dependencies: {},
    optional: false,
    dev: true,
    bin: {},
  });
  const local = (
    name: string,
    path: string,
    extra: Partial<ResolvedPackage> = {},
  ): ResolvedPackage => ({
    name,
    version: "1.0.0",
    resolved: "",
    integrity: "",
    local: path,
    dependencies: {},
    optional: false,
    dev: false,
    bin: {},
    ...extra,
  });
  /** The root depends on a; a depends on b and nanoid, tests with tap; b is a leaf nobody uses. */
  const tree = (): Resolution => ({
    root: {
      name: "mono",
      specs: { dependencies: { a: "^1" } },
      dependencies: { a: "link:packages/a" },
      workspaces: ["packages/*"],
    },
    packages: {
      "a@link:packages/a": local("a", "packages/a", {
        specs: { dependencies: { b: "workspace:*", nanoid: "^5" }, devDependencies: { tap: "^1" } },
        dependencies: { b: "link:packages/b", nanoid: "5.0.0", tap: "1.0.0" },
        bin: { a: "cli.js" },
      }),
      "b@link:packages/b": local("b", "packages/b"),
      "nanoid@5.0.0": nanoid(),
      "tap@1.0.0": tap(),
    },
    warnings: [],
  });

  it("counts neither a workspace nor what only its devDependencies reach as shipped", () => {
    expect(lockCounts(toLockfile(tree()))).toEqual({ packages: 2, optional: 0, dev: 1 });
  });

  it("writes local entries under workspaces, by path, with no tarball fields", () => {
    const lock = toLockfile(tree());
    expect(lock.root.workspaces).toEqual(["packages/*"]);
    expect(Object.keys(lock.packages)).toEqual(["nanoid@5.0.0", "tap@1.0.0"]);
    expect(lock.workspaces).toEqual({
      "packages/a": {
        name: "a",
        version: "1.0.0",
        specs: { dependencies: { b: "workspace:*", nanoid: "^5" }, devDependencies: { tap: "^1" } },
        dependencies: { b: "link:packages/b", nanoid: "5.0.0", tap: "1.0.0" },
        bin: { a: "cli.js" },
      },
      "packages/b": { name: "b", version: "1.0.0" },
    });
    expect(JSON.stringify(lock)).not.toContain('integrity":""');
  });

  it("round-trips, byte for byte the second time", () => {
    const once = toLockfile(tree());
    expect(fromLockfile(once)).toEqual(tree());
    const text = formatLockfile(once);
    expect(formatLockfile(toLockfile(fromLockfile(parseLockfile(text))))).toBe(text);
    expect(fromCheckedLockfile(parseLockfile(text))).toEqual(fromLockfile(parseLockfile(text)));
  });

  it("writes workspaces between root and packages, sorted by path, fields in order", () => {
    const resolution = tree();
    resolution.packages["z@link:apps/z"] = local("z", "apps/z", {
      peerDependencies: { nanoid: "^5" },
      peers: { nanoid: "required" },
      dependencies: { nanoid: "5.0.0" },
    });
    const text = formatLockfile(toLockfile(resolution));
    const at = (needle: string) => text.indexOf(needle);
    expect(at('"root"')).toBeLessThan(at('"workspaces": {'));
    expect(at('"workspaces": {')).toBeLessThan(at('"packages": {'));
    expect(at('"apps/z"')).toBeLessThan(at('"packages/a"'));
    expect(at('"packages/a"')).toBeLessThan(at('"packages/b"'));
    expect(text).toContain(
      '"apps/z": {\n      "name": "z",\n      "version": "1.0.0",\n      "dependencies": {\n        "nanoid": "5.0.0"\n      },\n      "peerDependencies": {\n        "nanoid": "^5"\n      },\n      "peers": {\n        "nanoid": "required"\n      }\n    }',
    );
    expect(parseLockfile(text).packages["nanoid@5.0.0"]).not.toHaveProperty("local");
  });

  it("omits the section and the patterns when there are none", () => {
    const text = formatLockfile(
      toLockfile({ ...generate(1), root: { ...generate(1).root, workspaces: [] } }),
    );
    expect(text).not.toContain("workspaces");
    expect(parseLockfile(text).root.workspaces).toBeUndefined();
  });

  it("derives dev and optional per top", () => {
    const out = fromLockfile(toLockfile(tree()));
    expect(out.packages["a@link:packages/a"]).toMatchObject({
      dev: false,
      optional: false,
      local: "packages/a",
    });
    expect(out.packages["b@link:packages/b"]).toMatchObject({
      dev: false,
      optional: false,
      local: "packages/b",
    });
    expect(out.packages["nanoid@5.0.0"]).toMatchObject({ dev: false, optional: false });
    expect(out.packages["tap@1.0.0"]).toMatchObject({ dev: true, optional: false });
    // A workspace's optionalDependencies edge is optional; a peer ships, unless it is also dev.
    const lock = toLockfile(tree());
    lock.workspaces!["packages/b"] = {
      name: "b",
      version: "1.0.0",
      specs: { optionalDependencies: { tap: "^1" } },
      optionalDependencies: { tap: "1.0.0" },
      peerDependencies: { nanoid: "^5" },
      dependencies: { nanoid: "5.0.0" },
    };
    lock.workspaces!["packages/a"]!.specs = { devDependencies: { nanoid: "^5" } };
    lock.workspaces!["packages/a"]!.dependencies = { nanoid: "5.0.0" };
    expect(fromLockfile(lock).packages["tap@1.0.0"]).toMatchObject({ dev: false, optional: true });
    expect(fromLockfile(lock).packages["nanoid@5.0.0"]?.dev).toBe(false);
    lock.workspaces!["packages/b"]!.specs = { devDependencies: { nanoid: "^5" } };
    lock.workspaces!["packages/b"]!.dependencies = {};
    lock.workspaces!["packages/b"]!.peerDependencies = undefined;
    lock.workspaces!["packages/b"]!.optionalDependencies = undefined;
    lock.workspaces!["packages/b"]!.specs = { devDependencies: { nanoid: "^5" } };
    expect(fromLockfile(lock).packages["nanoid@5.0.0"]?.dev).toBe(true);
  });

  it("reads a name every object has as any other", () => {
    const lock = (peerDependencies: object) =>
      JSON.stringify({
        lockfileVersion: 1,
        root: {
          specs: { dependencies: { constructor: "^1" } },
          dependencies: { constructor: "1.0.0" },
          workspaces: ["packages/*"],
        },
        workspaces: {
          "packages/w": {
            name: "w",
            version: "1.0.0",
            peerDependencies: { toString: "^1" },
            peers: { toString: "required" },
            dependencies: { toString: "1.0.0" },
          },
        },
        packages: {
          "constructor@1.0.0": { integrity: "sha512-a" },
          "toString@1.0.0": {
            integrity: "sha512-b",
            peerDependencies,
            peers: { valueOf: "optional" },
          },
        },
      });
    // A required edge of the root, a workspace's peer that ships, and a peer of any range.
    const out = fromLockfile(parseLockfile(lock({ valueOf: "" }))).packages;
    expect(out["constructor@1.0.0"]).toMatchObject({ optional: false, dev: false });
    expect(out["toString@1.0.0"]).toMatchObject({ optional: false, dev: false });
    // A peer is still one its entry declares.
    expect(thrown(() => parseLockfile(lock({}))).message).toMatch(/peers\["valueOf"\] is not in/);
  });

  it("filters platforms with every workspace as a seed", () => {
    const out = filterPlatform(fromLockfile(toLockfile(tree())), { os: "linux", cpu: "x64" });
    expect(Object.keys(out.packages)).toEqual([
      "a@link:packages/a",
      "b@link:packages/b",
      "nanoid@5.0.0",
      "tap@1.0.0",
    ]);
    expect(out.packages["tap@1.0.0"]?.dev).toBe(true);
    expect(out.packages["b@link:packages/b"]?.dev).toBe(false);
  });

  describe("validation", () => {
    const withWorkspace = (path: string, ws: unknown, packages: object = {}) => ({
      lockfileVersion: 1,
      root: { dependencies: {} },
      workspaces: { [path]: ws },
      packages,
    });
    const check = (lock: unknown) => thrown(() => parseLockfile(JSON.stringify(lock)));

    it("links a root or workspace edge to either map, a package edge to packages only", () => {
      const lock = toLockfile(tree());
      expect(() => formatLockfile(lock)).not.toThrow();
      lock.packages["nanoid@5.0.0"]!.dependencies = { b: "link:packages/b" };
      expect(check(lock).message).toMatch(
        /packages\["nanoid@5.0.0"\].dependencies\["b"\] points at b@link:packages\/b, which is not in packages/,
      );
    });

    it("rejects a dangling workspace reference, and a link under another name", () => {
      const lock = toLockfile(tree());
      delete lock.workspaces!["packages/b"];
      expect(check(lock).message).toMatch(
        /workspaces\["packages\/a"\].dependencies\["b"\] points at b@link:packages\/b, which is not in workspaces/,
      );
      const root = toLockfile(tree());
      root.root.dependencies = { c: "link:packages/b" };
      root.root.specs = { dependencies: { c: "^1" } };
      expect(check(root).message).toMatch(/root.dependencies\["c"\] points at c@link:packages\/b/);
      const version = toLockfile(tree());
      version.root.dependencies = { a: "1.0.0" };
      expect(check(version).message).toMatch(
        /root.dependencies\["a"\] points at a@1.0.0, which is not in packages/,
      );
    });

    it("takes a link: edge with no workspace only where the top's own spec is link:", () => {
      const lock = (specs: object, version = "link:../lib") => ({
        lockfileVersion: 1,
        root: { specs: { devDependencies: specs }, dependencies: { lib: version } },
        packages: {},
      });
      const out = fromLockfile(parseLockfile(JSON.stringify(lock({ lib: "link:../lib" }))));
      expect(out.packages["lib@link:../lib"]).toMatchObject({
        local: "../lib",
        link: true,
        dev: true,
      });
      expect(toLockfile(out)).toEqual(lock({ lib: "link:../lib" }));
      expect(check(lock({ lib: "^1" })).message).toMatch(/points at lib@link:\.\.\/lib/);
      // Declared twice, the edge is the one the resolver walks: here the range's.
      const twice = lock({ lib: "link:../lib" });
      Object.assign(twice.root.specs, { dependencies: { lib: "^1" } });
      expect(check(twice).message).toMatch(/points at lib@link:\.\.\/lib/);
      expect(check(lock({ lib: "link:../lib" }, "link:a/../../lib")).message).toMatch(
        /points at lib@link:a\/\.\.\/\.\.\/lib/,
      );
    });

    it("rejects a link: version in packages", () => {
      const lock = { ...base(), packages: { "a@link:packages/a": { integrity: "sha512-a" } } };
      expect(check(lock).message).toMatch(
        /package key "a@link:packages\/a" does not end in an exact/,
      );
    });

    it.each([
      ["a missing version", { name: "b", version: "" }, /is not name@version/],
      ["a range for a version", { name: "b", version: "^1" }, /exact version/],
      ["a number for a name", { name: 1, version: "1.0.0" }, /must be strings/],
      ["a bad name", { name: ".b", version: "1.0.0" }, /not a valid package name/],
      ["not an object", [], /must be an object/],
    ])("rejects %s", (_label, ws, message) => {
      const error = check(withWorkspace("packages/b", ws));
      expect(error.code).toBe("ELOCK");
      expect(error.message).toMatch(message);
    });

    it.each([
      "",
      "/srv/b",
      "../b",
      "packages/../b",
      "./b",
      "packages//b",
      "packages\\b",
      "packages/b/",
    ])("rejects the path %j", (path) => {
      expect(check(withWorkspace(path, { name: "b", version: "1.0.0" })).message).toMatch(
        /is not a relative path inside the project/,
      );
    });

    it("rejects two workspaces of one name, and a workspace that depends on itself", () => {
      const twice = {
        ...base(),
        workspaces: {
          "packages/a": { name: "a", version: "1.0.0" },
          "packages/b": { name: "a", version: "2.0.0" },
        },
      };
      expect(check(twice).message).toBe(
        'workspaces["packages/a"] and workspaces["packages/b"] are both named a',
      );
      for (const map of ["dependencies", "optionalDependencies"]) {
        const self = withWorkspace("packages/a", {
          name: "a",
          version: "1.0.0",
          specs: { [map]: { a: "*" } },
          [map]: { a: "link:packages/a" },
        });
        expect(check(self).message).toBe('workspaces["packages/a"] depends on itself');
      }
    });

    it("keeps a workspace and a registry package of one name and version apart", () => {
      const lock = toLockfile(tree());
      lock.packages["b@1.0.0"] = { integrity: "sha512-b" };
      lock.packages["nanoid@5.0.0"]!.dependencies = { b: "1.0.0" };
      const out = fromLockfile(parseLockfile(formatLockfile(lock)));
      expect(out.packages["b@1.0.0"]).toMatchObject({ integrity: "sha512-b", dev: false });
      expect(out.packages["b@link:packages/b"]).toMatchObject({ local: "packages/b" });
      expect(formatLockfile(toLockfile(out))).toBe(formatLockfile(lock));
    });

    it("checks a workspace's specs, bin and peers like the root's and a package's", () => {
      const ws = (extra: object) => withWorkspace("p", { name: "p", version: "1.0.0", ...extra });
      expect(check(ws({ specs: [] })).message).toMatch(/workspaces\["p"\].specs must be an object/);
      expect(check(ws({ specs: { dependencies: { a: 1 } } })).message).toMatch(
        /specs.dependencies\["a"\]/,
      );
      expect(check(ws({ bin: { p: "../x" } })).message).toMatch(/escapes the package directory/);
      expect(check(ws({ peers: { react: "required" } })).message).toMatch(
        /is not in workspaces\["p"\].peerDependencies/,
      );
      expect(
        check(ws({ peers: { react: "maybe" }, peerDependencies: { react: "*" } })).message,
      ).toMatch(/required or optional/);
      const nanoid = { "nanoid@5.0.0": { integrity: "sha512-n" } };
      const undeclared = withWorkspace(
        "p",
        { name: "p", version: "1.0.0", dependencies: { nanoid: "5.0.0" } },
        nanoid,
      );
      expect(check(undeclared).message).toMatch(/is in no workspaces\["p"\].specs group/);
      const peer = withWorkspace(
        "p",
        {
          name: "p",
          version: "1.0.0",
          dependencies: { nanoid: "5.0.0" },
          peerDependencies: { nanoid: "^5" },
        },
        nanoid,
      );
      expect(() => parseLockfile(JSON.stringify(peer))).not.toThrow();
    });

    it("rejects patterns that are not strings", () => {
      const lock = { ...base(), root: { ...base().root, workspaces: [1] } };
      expect(check(lock).message).toMatch(/root.workspaces must be an array of strings/);
      expect(check({ ...base(), workspaces: [] }).message).toMatch(/workspaces must be an object/);
    });
  });

  describe("sameTree", () => {
    const manifest: RootManifest = {
      name: "mono",
      workspaces: ["packages/*"],
      dependencies: { a: "^1" },
    };
    type Found = { path: string; name: string; version: string; manifest: RootManifest };
    const found = (): Found[] => [
      {
        path: "packages/a",
        name: "a",
        version: "1.0.0",
        manifest: {
          dependencies: { b: "workspace:*", nanoid: "^5" },
          devDependencies: { tap: "^1" },
          bin: { a: "cli.js" },
        },
      },
      { path: "packages/b", name: "b", version: "1.0.0", manifest: {} },
    ];

    it("is true for the tree the lockfile was made from", () => {
      expect(sameTree(toLockfile(tree()), manifest, found())).toBe(true);
    });

    it("sees the overrides move, whatever order they are in", () => {
      const lock = toLockfile(tree());
      lock.root.overrides = { "a>b": "1.0.0", c: "^2" };
      const over = (overrides: Overrides) => ({ overrides, values: valuesFor(overrides) });
      expect(sameTree(lock, manifest, found(), over({ c: "^2", "a>b": "1.0.0" }))).toBe(true);
      expect(sameTree(lock, manifest, found(), over({ c: "^2" }))).toBe(false);
      expect(sameTree(lock, manifest, found())).toBe(false);
      expect(sameTree(toLockfile(tree()), manifest, found(), over({ c: "^2" }))).toBe(false);
    });

    it("takes a top's pin that an override reaching its edge allows, and no other", () => {
      const pinned = (overrides: Overrides) => {
        const lock = toLockfile(tree());
        lock.workspaces!["packages/a"]!.dependencies!.nanoid = "4.0.0";
        lock.root.overrides = overrides;
        return sameTree(lock, manifest, found(), { overrides, values: valuesFor(overrides) });
      };
      expect(pinned({ nanoid: "^4" })).toBe(true);
      expect(pinned({ "a@1>nanoid": "4.0.0" })).toBe(true);
      expect(pinned({ "a@2>nanoid": "4.0.0" })).toBe(false);
      expect(pinned({ "other>nanoid": "4.0.0" })).toBe(false);
      expect(pinned({ nanoid: "^3" })).toBe(false);
      expect(pinned({ nanoid: "-" })).toBe(false);
    });

    it("sees the patterns move", () => {
      expect(
        sameTree(toLockfile(tree()), { ...manifest, workspaces: ["packages/**"] }, found()),
      ).toBe(false);
      expect(
        sameTree(
          toLockfile(tree()),
          { ...manifest, workspaces: { packages: ["packages/*"] } },
          found(),
        ),
      ).toBe(true);
      expect(sameTree(toLockfile(tree()), { ...manifest, workspaces: undefined }, found())).toBe(
        false,
      );
    });

    it("sees the root's ranges move", () => {
      expect(
        sameTree(toLockfile(tree()), { ...manifest, dependencies: { a: "^2" } }, found()),
      ).toBe(false);
    });

    it("sees a workspace added, removed, moved, renamed or bumped", () => {
      const lock = toLockfile(tree());
      expect(sameTree(lock, manifest, found().slice(0, 1))).toBe(false);
      expect(
        sameTree(lock, manifest, [
          ...found(),
          { path: "packages/c", name: "c", version: "1.0.0", manifest: {} },
        ]),
      ).toBe(false);
      expect(
        sameTree(
          lock,
          manifest,
          found().map((ws) => (ws.name === "b" ? { ...ws, path: "libs/b" } : ws)),
        ),
      ).toBe(false);
      expect(
        sameTree(
          lock,
          manifest,
          found().map((ws) => (ws.name === "b" ? { ...ws, name: "c" } : ws)),
        ),
      ).toBe(false);
      expect(
        sameTree(
          lock,
          manifest,
          found().map((ws) => (ws.name === "b" ? { ...ws, version: "1.0.1" } : ws)),
        ),
      ).toBe(false);
    });

    it("sees a pin its unchanged range does not allow, as `pickManifest` reads the range", () => {
      const pinned = (
        specs: Record<string, Record<string, string>>,
        version: string,
        name?: string,
      ) => {
        const lock = toLockfile(tree());
        lock.root.specs = specs;
        lock.root.dependencies = { ...lock.root.dependencies, nanoid: version };
        lock.packages[`nanoid@${version}`] ??= { integrity: "sha512-x" };
        if (name) lock.packages[`nanoid@${version}`]!.name = name;
        return sameTree(lock, { ...manifest, ...specs }, found());
      };
      const deps = (spec: string) => ({ dependencies: { a: "^1", nanoid: spec } });
      expect(pinned(deps("^5"), "5.1.0")).toBe(true);
      expect(pinned(deps("^5"), "6.0.0")).toBe(false);
      expect(pinned(deps("^5"), "5.1.0-beta.1")).toBe(false);
      expect(pinned(deps("5.0.0"), "5.0.1")).toBe(false);
      expect(pinned(deps("=5.0.0"), "5.0.0")).toBe(true);
      // `*` takes the default tag, prerelease or not; a tag names no range to hold it to.
      expect(pinned(deps("*"), "6.0.0-beta.1")).toBe(true);
      expect(pinned(deps("latest"), "0.0.1")).toBe(true);
      // An alias pins the aliased package's version, of an entry that is that package.
      expect(pinned(deps("npm:other@^5"), "5.2.0", "other")).toBe(true);
      expect(pinned(deps("npm:other@^5"), "4.0.0", "other")).toBe(false);
      expect(pinned(deps("npm:other@^5"), "5.3.0")).toBe(false);
      expect(pinned(deps("npm:other@^5"), "5.4.0", "evil")).toBe(false);
      expect(pinned(deps("npm:other@latest"), "5.5.0", "evil")).toBe(false);
      // A plain name never pins an alias's entry.
      expect(pinned(deps("^5"), "5.6.0", "other")).toBe(false);
      // A name in several groups is held to the range the resolver walks: optional, then prod.
      const both = { dependencies: { a: "^1", nanoid: "^5" }, devDependencies: { nanoid: "^4" } };
      expect(pinned(both, "5.0.0")).toBe(true);
      expect(pinned(both, "4.0.0")).toBe(false);
      const optional = { ...both, optionalDependencies: { nanoid: "^4" } };
      expect(pinned(optional, "4.0.0")).toBe(true);
      // A tarball spec pins its own source, a workspace spec a workspace, and nothing else does.
      const url = "https://x/nanoid.tgz";
      expect(pinned(deps(url), url)).toBe(true);
      expect(pinned(deps(url), "https://x/other.tgz")).toBe(false);
      expect(pinned(deps(url), "5.0.0")).toBe(false);
      expect(pinned(deps("file:./n.tgz"), "file:n.tgz")).toBe(true);
      expect(pinned(deps("workspace:*"), "5.0.0")).toBe(false);
      // A workspace's own pins; its tarball is where its own package.json says.
      const lock = toLockfile(tree());
      lock.workspaces!["packages/a"]!.dependencies!.nanoid = "4.0.0";
      expect(sameTree(lock, manifest, found())).toBe(false);
      lock.workspaces!["packages/a"]!.dependencies!.nanoid = url;
      lock.packages[`nanoid@${url}`] = { version: "5.0.0", integrity: "sha512-x" };
      expect(sameTree(lock, manifest, found())).toBe(false);
      // A path is read from the workspace, and kept from the root.
      const local = found();
      const dependencies = { b: "workspace:*", nanoid: "file:../n.tgz" };
      local[0]!.manifest = { ...local[0]!.manifest, dependencies };
      const ws = lock.workspaces!["packages/a"]!;
      ws.specs = { ...ws.specs, dependencies };
      ws.dependencies!.nanoid = "file:packages/n.tgz";
      expect(sameTree(lock, manifest, local)).toBe(true);
      ws.dependencies!.nanoid = "file:n.tgz";
      expect(sameTree(lock, manifest, local)).toBe(false);
    });

    it("sees a workspace's ranges or peers move", () => {
      const lock = toLockfile(tree());
      const edited = found();
      edited[0]!.manifest = {
        ...edited[0]!.manifest,
        dependencies: { b: "workspace:^", nanoid: "^5" },
      };
      expect(sameTree(lock, manifest, edited)).toBe(false);
      const peer = found();
      peer[1]!.manifest = { peerDependencies: { nanoid: "^5" } };
      expect(sameTree(lock, manifest, peer)).toBe(false);
    });

    it("sees a workspace's bins move, as the linker would place them", () => {
      const lock = toLockfile(tree());
      const more = found();
      more[0]!.manifest = { ...more[0]!.manifest, bin: { a: "cli.js", a2: "cli2.js" } };
      expect(sameTree(lock, manifest, more)).toBe(false);
      const gone = found();
      gone[0]!.manifest = { ...gone[0]!.manifest, bin: undefined };
      expect(sameTree(lock, manifest, gone)).toBe(false);
      // The same bins in another spelling normalise to the entry's.
      const spelled = found();
      spelled[0]!.manifest = { ...spelled[0]!.manifest, name: "a", bin: "./cli.js" };
      expect(sameTree(lock, manifest, spelled)).toBe(true);
    });

    it("sees a peer's optional flag move, which only peerDependenciesMeta holds", () => {
      const withPeer = tree();
      withPeer.packages["b@link:packages/b"] = local("b", "packages/b", {
        peerDependencies: { nanoid: "^5" },
        peers: { nanoid: "optional" },
      });
      const lock = toLockfile(withPeer);
      const optional = found();
      optional[1]!.manifest = {
        peerDependencies: { nanoid: "^5" },
        peerDependenciesMeta: { nanoid: { optional: true } },
      };
      expect(sameTree(lock, manifest, optional)).toBe(true);
      const required = found();
      required[1]!.manifest = { peerDependencies: { nanoid: "^5" } };
      expect(sameTree(lock, manifest, required)).toBe(false);
    });

    it("ignores order and empty groups", () => {
      const lock = toLockfile(tree());
      const shuffled = found().reverse();
      shuffled[1]!.manifest = {
        devDependencies: { tap: "^1" },
        dependencies: { nanoid: "^5", b: "workspace:*" },
        optionalDependencies: {},
        bin: { a: "cli.js" },
      };
      expect(sameTree(lock, manifest, shuffled)).toBe(true);
    });

    it("keeps a workspace directory named __proto__ as a key, on both sides", () => {
      const resolution = tree();
      resolution.packages["p@link:__proto__"] = local("p", "__proto__");
      const lock = toLockfile(resolution);
      expect(Object.hasOwn(lock.workspaces!, "__proto__")).toBe(true);
      const text = formatLockfile(lock);
      const read = parseLockfile(text);
      expect(Object.keys(read.workspaces!)).toEqual(["__proto__", "packages/a", "packages/b"]);
      expect(fromLockfile(read).packages["p@link:__proto__"]).toMatchObject({ local: "__proto__" });
      expect(formatLockfile(toLockfile(fromLockfile(read)))).toBe(text);
      const proto: Found = { path: "__proto__", name: "p", version: "1.0.0", manifest: {} };
      expect(sameTree(read, manifest, [proto, ...found()])).toBe(true);
      expect(sameTree(toLockfile(tree()), manifest, [proto, ...found()])).toBe(false);
    });

    it("is false for a lockfile without workspaces when some are found", () => {
      expect(sameTree(toLockfile(generate(1)), { name: "demo" }, found())).toBe(false);
      expect(sameTree(toLockfile(generate(1)), { name: "demo" }, [])).toBe(false); // specs differ
    });
  });
});

describe("tarball entries", () => {
  // An `@` past the name, as a registry's own tarball url for a scoped package has.
  const url = "https://t.test/@s/a/-/a-1.0.0.tgz";
  const lockOf = (packages: Record<string, unknown>, dependencies: Record<string, string>) =>
    JSON.stringify({
      lockfileVersion: 1,
      root: { specs: { dependencies }, dependencies },
      packages,
    });

  it("reads the source off the key and the version off the entry", () => {
    const text = lockOf(
      {
        [`a@${url}`]: { version: "1.0.0", integrity: "sha512-a", dependencies: { c: "3.0.0" } },
        "@s/b@file:../vendor/@s/b.tgz": { version: "2.0.0", integrity: "sha512-b" },
        // A registry package may depend on a tarball, as npm allows.
        "c@3.0.0": { integrity: "sha512-c", dependencies: { "@s/b": "file:../vendor/@s/b.tgz" } },
      },
      { a: url, "@s/b": "file:../vendor/@s/b.tgz" },
    );
    const { packages } = fromLockfile(parseLockfile(text));
    expect(packages[`a@${url}`]).toMatchObject({
      name: "a",
      version: "1.0.0",
      resolved: url,
      source: url,
      dependencies: { c: "3.0.0" },
    });
    expect(packages["@s/b@file:../vendor/@s/b.tgz"]).toMatchObject({
      name: "@s/b",
      version: "2.0.0",
      resolved: "file:../vendor/@s/b.tgz",
      source: "file:../vendor/@s/b.tgz",
    });
    expect(packages["c@3.0.0"]?.source).toBeUndefined();
    // Written back as read: sorted, but nothing added or dropped.
    const formatted = formatLockfile(parseLockfile(text));
    expect(JSON.parse(formatted)).toEqual(JSON.parse(text));
    expect(formatLockfile(parseLockfile(formatted))).toBe(formatted);
  });

  it.each([
    ["no version", `a@${url}`, { integrity: "sha512-a" }, /\.version must be an exact version/],
    ["a range", `a@${url}`, { version: "^1", integrity: "sha512-a" }, /exact version/],
    [
      "a resolved url",
      `a@${url}`,
      { version: "1.0.0", resolved: url, integrity: "sha512-a" },
      /resolved is its key's to say/,
    ],
    [
      "a version on a registry entry",
      "a@1.0.0",
      { version: "1.0.0", integrity: "sha512-a" },
      /version is only for a tarball/,
    ],
    [
      "a path spelled another way",
      "a@file:./vendor/a.tgz",
      { version: "1.0.0", integrity: "sha512-a" },
      /does not name its tarball as a lockfile does/,
    ],
    [
      "an absolute path",
      "a@file:/etc/a.tgz",
      { version: "1.0.0", integrity: "sha512-a" },
      /is not a valid/,
    ],
    [
      "a directory",
      "a@file:vendor/a",
      { version: "1.0.0", integrity: "sha512-a" },
      /is not a valid/,
    ],
  ])("refuses %s", (_label, key, entry, message) => {
    const version = key.slice(key.indexOf("@", 1) + 1);
    const text = lockOf({ [key]: entry }, { a: version });
    expect(() => parseLockfile(text)).toThrow(message);
  });

  it("refuses a workspace versioned by a url", () => {
    const text = JSON.stringify({
      lockfileVersion: 1,
      root: { dependencies: {} },
      workspaces: { "packages/a": { name: "a", version: url } },
      packages: {},
    });
    expect(() => parseLockfile(text)).toThrow(/version must be an exact version/);
  });
});

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedPackage, Resolution } from "../src/resolve.ts";
import {
  STATE_FILE,
  clearState,
  inputsHash,
  readState,
  stateHash,
  statePath,
  writeState,
} from "../src/state.ts";

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "upm-state-"));
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

const STORE = "/tmp/upm-store";
const FLAGS = { production: false, store: STORE };

describe("stateHash", () => {
  it("is stable for the same resolution", async () => {
    expect(await stateHash(tree(), FLAGS)).toBe(await stateHash(tree(), FLAGS));
  });

  it("ignores the order packages were inserted in", async () => {
    const forwards = tree();
    const backwards = tree();
    backwards.packages = Object.fromEntries(Object.entries(backwards.packages).reverse());
    expect(await stateHash(backwards, FLAGS)).toBe(await stateHash(forwards, FLAGS));
  });

  it("changes when the graph does", async () => {
    const before = await stateHash(tree(), FLAGS);
    const added = tree();
    added.packages["c@1.0.0"] = pkg("c", "1.0.0");
    added.root.dependencies.c = "1.0.0";
    expect(await stateHash(added, FLAGS)).not.toBe(before);

    const bumped = tree();
    bumped.packages["b@1.0.0"]!.version = "1.0.1";
    expect(await stateHash(bumped, FLAGS)).not.toBe(before);

    const rewired = tree();
    rewired.packages["a@1.0.0"]!.dependencies = {};
    expect(await stateHash(rewired, FLAGS)).not.toBe(before);
  });

  it("changes when production flips", async () => {
    expect(await stateHash(tree(), { ...FLAGS, production: true })).not.toBe(
      await stateHash(tree(), FLAGS),
    );
  });

  it("changes when a dev flag flips", async () => {
    const flipped = tree();
    flipped.packages["b@1.0.0"]!.dev = true;
    expect(await stateHash(flipped, FLAGS)).not.toBe(await stateHash(tree(), FLAGS));
  });

  it("changes when an optional flag flips", async () => {
    const flipped = tree();
    flipped.packages["b@1.0.0"]!.optional = true;
    expect(await stateHash(flipped, FLAGS)).not.toBe(await stateHash(tree(), FLAGS));
  });

  it("changes when the store moves", async () => {
    expect(await stateHash(tree(), { ...FLAGS, store: "/tmp/other" })).not.toBe(
      await stateHash(tree(), FLAGS),
    );
  });

  it("reads a relative store path against the current directory", async () => {
    const absolute = { production: false, store: join(process.cwd(), "store") };
    expect(await stateHash(tree(), { production: false, store: "store" })).toBe(
      await stateHash(tree(), absolute),
    );
  });

  it("does not change when only the root's own name and version do", async () => {
    const renamed = tree();
    renamed.root.name = "something-else";
    renamed.root.version = "9.9.9";
    expect(await stateHash(renamed, FLAGS)).toBe(await stateHash(tree(), FLAGS));
  });

  it("covers a workspace's path, bins and own deps", async () => {
    const ws = (extra: Partial<ResolvedPackage> = {}): Resolution => {
      const out = tree();
      out.packages["w@link:packages/w"] = pkg("w", "1.0.0", {
        resolved: "",
        integrity: "",
        local: "packages/w",
        dependencies: { b: "1.0.0" },
        ...extra,
      });
      return out;
    };
    const base = await stateHash(ws(), FLAGS);
    expect(await stateHash(ws(), FLAGS)).toBe(base);
    expect(base).not.toBe(await stateHash(tree(), FLAGS));
    expect(await stateHash(ws({ local: "libs/w" }), FLAGS)).not.toBe(base);
    expect(await stateHash(ws({ bin: { w: "cli.js" } }), FLAGS)).not.toBe(base);
    expect(await stateHash(ws({ dependencies: {} }), FLAGS)).not.toBe(base);
  });
});

describe("readState", () => {
  it("is undefined when there is no file", async () => {
    expect(await readState(project)).toBeUndefined();
  });

  it("round-trips what writeState wrote", async () => {
    const state = {
      version: 1 as const,
      hash: "abc",
      entries: ["a@1.0.0-x"],
      complete: true,
      store: STORE,
    };
    await writeState(project, state);
    expect(await readState(project)).toEqual(state);
    expect(statePath(project)).toBe(join(project, "node_modules", STATE_FILE));
  });

  it("refuses a state whose inputs come without the summary and links they stand for", async () => {
    const state = { version: 1, hash: "a", entries: [], complete: true, store: STORE };
    await put(JSON.stringify({ ...state, inputs: "x" }));
    expect(await readState(project)).toBeUndefined();
    const whole = {
      ...state,
      inputs: "x",
      summary: { packages: 1, otherPlatforms: 0, warnings: [] },
      root: { links: { a: "../x" }, bins: ["a"] },
    };
    await put(JSON.stringify(whole));
    expect(await readState(project)).toEqual(whole);
    await put(JSON.stringify({ ...whole, root: { links: { a: 1 }, bins: [] } }));
    expect(await readState(project)).toBeUndefined();
    // Each workspace's links, the same shape as the root's.
    const tops = { "packages/a": { links: { b: "../b" }, bins: [] } };
    await put(JSON.stringify({ ...whole, tops }));
    expect(await readState(project)).toEqual({ ...whole, tops });
    for (const bad of [[], { "packages/a": { links: {} } }, { "packages/a": { bins: [] } }]) {
      await put(JSON.stringify({ ...whole, tops: bad }));
      expect(await readState(project), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("changes the inputs with a workspace's path or manifest, and not without workspaces", async () => {
    const inputs = {
      lock: "l",
      manifest: {},
      production: false,
      store: STORE,
      hosts: [],
      platform: [],
    };
    const alone = await inputsHash(inputs);
    expect(await inputsHash({ ...inputs, workspaces: [] })).toBe(alone);
    const one = await inputsHash({ ...inputs, workspaces: [["packages/a", { name: "a" }]] });
    expect(one).not.toBe(alone);
    expect(await inputsHash({ ...inputs, workspaces: [["packages/b", { name: "a" }]] })).not.toBe(
      one,
    );
    expect(await inputsHash({ ...inputs, workspaces: [["packages/a", { name: "b" }]] })).not.toBe(
      one,
    );
  });

  it("reads the local tarballs' stamps, and refuses any that is not one", async () => {
    const state = { version: 1, hash: "a", entries: [], complete: true, store: STORE };
    const stamp = ["1", "2", "3", "4"];
    const tarballs = { "file:a.tgz": stamp, "file:b.tgz": null };
    await put(JSON.stringify({ ...state, tarballs }));
    expect(await readState(project)).toEqual({ ...state, tarballs });
    for (const bad of [[], { "file:a.tgz": ["1", "2"] }, { "file:a.tgz": "x" }]) {
      await put(JSON.stringify({ ...state, tarballs: bad }));
      expect(await readState(project), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("is undefined when the file predates the complete flag", async () => {
    // An older state cannot say whether its tree was whole, so it must not be trusted.
    await put(JSON.stringify({ version: 1, hash: "a", entries: [], store: STORE }));
    expect(await readState(project)).toBeUndefined();
  });

  it("is undefined for a torn file, never a throw", async () => {
    await put('{"version":1,"hash":"a","entr');
    expect(await readState(project)).toBeUndefined();
  });

  it("is undefined for the wrong shape", async () => {
    for (const bad of [
      "null",
      '"a string"',
      "[]",
      '{"version":2,"hash":"a","entries":[],"store":"/s"}',
      '{"hash":"a","entries":[],"store":"/s"}',
      '{"version":1,"entries":[],"store":"/s"}',
      '{"version":1,"hash":"a","entries":{},"store":"/s"}',
      '{"version":1,"hash":"a","entries":[1],"store":"/s"}',
      '{"version":1,"hash":"a","entries":[]}',
    ]) {
      await put(bad);
      expect(await readState(project), bad).toBeUndefined();
    }
  });

  it("is undefined when the path is not a readable file", async () => {
    await mkdir(statePath(project), { recursive: true });
    expect(await readState(project)).toBeUndefined();
  });
});

describe("writeState", () => {
  it("creates node_modules and leaves no temp file behind", async () => {
    await writeState(project, { version: 1, hash: "h", entries: [], complete: true, store: STORE });
    const found = await readdir(join(project, "node_modules"));
    expect(found).toEqual([STATE_FILE]);
  });

  it("replaces an existing state in one step", async () => {
    await writeState(project, {
      version: 1,
      hash: "one",
      entries: [],
      complete: true,
      store: STORE,
    });
    await writeState(project, {
      version: 1,
      hash: "two",
      entries: ["k"],
      complete: true,
      store: STORE,
    });
    expect((await readState(project))?.hash).toBe("two");
    expect(await readdir(join(project, "node_modules"))).toEqual([STATE_FILE]);
  });

  it("is readable as JSON on disk", async () => {
    await writeState(project, {
      version: 1,
      hash: "h",
      entries: ["k"],
      complete: true,
      store: STORE,
    });
    expect(JSON.parse(await readFile(statePath(project), "utf8"))).toMatchObject({ hash: "h" });
  });

  it("fails with ESTATE when it cannot write", async () => {
    await mkdir(join(project, "node_modules"), { recursive: true });
    await mkdir(statePath(project), { recursive: true });
    await expect(
      writeState(project, { version: 1, hash: "h", entries: [], complete: true, store: STORE }),
    ).rejects.toMatchObject({ code: "ESTATE" });
  });
});

describe("clearState", () => {
  it("removes the file", async () => {
    await writeState(project, { version: 1, hash: "h", entries: [], complete: true, store: STORE });
    await clearState(project);
    expect(await readState(project)).toBeUndefined();
  });

  it("fails with ESTATE when the path cannot be removed", async () => {
    await mkdir(statePath(project), { recursive: true }); // a directory sitting on the name
    await expect(clearState(project)).rejects.toMatchObject({ code: "ESTATE" });
  });

  it("is fine when there is nothing to remove", async () => {
    await expect(clearState(project)).resolves.toBeUndefined();
  });
});

async function put(body: string): Promise<void> {
  await mkdir(join(project, "node_modules"), { recursive: true });
  await writeFile(statePath(project), body);
}

function pkg(name: string, version: string, extra: Partial<ResolvedPackage> = {}): ResolvedPackage {
  return {
    name,
    version,
    resolved: `https://reg/${name}-${version}.tgz`,
    integrity: `sha512-${name}`,
    dependencies: {},
    optional: false,
    dev: false,
    bin: {},
    ...extra,
  };
}

/** A fresh copy each call, so a test may edit one without reaching the next. */
function tree(): Resolution {
  return {
    root: { name: "root", version: "1.0.0", dependencies: { a: "1.0.0" } },
    packages: {
      "a@1.0.0": pkg("a", "1.0.0", { dependencies: { b: "1.0.0" } }),
      "b@1.0.0": pkg("b", "1.0.0"),
    },
    warnings: [],
  };
}

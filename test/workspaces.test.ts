import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RootManifest } from "../src/resolve.ts";
import { findRoot, findWorkspaces, listWorkspaces, workspacePatterns } from "../src/workspaces.ts";
import type { Workspace, WorkspaceProof } from "../src/workspaces.ts";
import { writeState } from "../src/state.ts";
import type { InstallState } from "../src/state.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "upm-ws-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A package.json at `path` under the root; a null manifest makes the directory only. */
async function pkg(path: string, manifest: Record<string, unknown> | null = {}): Promise<void> {
  await mkdir(join(root, path), { recursive: true });
  if (manifest) await writeFile(join(root, path, "package.json"), JSON.stringify(manifest));
}

async function found(manifest: RootManifest): Promise<[string, string, string][]> {
  const list = await findWorkspaces(root, manifest);
  return list.map((ws) => [ws.path, ws.name, ws.version]);
}

describe("workspacePatterns", () => {
  it("takes an array or { packages }, and nothing else", () => {
    expect(workspacePatterns({})).toEqual({ patterns: [], negated: [] });
    expect(workspacePatterns({ workspaces: ["packages/*"] }).patterns).toEqual(["packages/*"]);
    expect(workspacePatterns({ workspaces: { packages: ["apps/*"] } }).patterns).toEqual([
      "apps/*",
    ]);
    for (const workspaces of ["packages/*", {}, { packages: "x" }, [1], null]) {
      expect(() => workspacePatterns({ workspaces } as unknown as RootManifest)).toThrow(
        expect.objectContaining({ code: "EWORKSPACE" }),
      );
    }
  });

  it("negates on an odd number of ! and strips a leading ./ or /", () => {
    expect(
      workspacePatterns({ workspaces: ["./packages/*", "/apps/*", "!!tools", "!skip"] }),
    ).toEqual({ patterns: ["packages/*", "apps/*", "tools"], negated: ["skip"] });
    expect(workspacePatterns({ workspaces: ["!./packages/skip", "!!!/other"] }).negated).toEqual([
      "packages/skip",
      "other",
    ]);
  });

  it("lets a later pattern undo a negation it matches, then drops patterns a negation covers", () => {
    expect(
      workspacePatterns({ workspaces: ["packages/**", "!packages/b/**", "packages/b/a"] }),
    ).toEqual({ patterns: ["packages/**", "packages/b/a"], negated: [] });
    expect(workspacePatterns({ workspaces: ["packages/*", "packages/b", "!packages/*"] })).toEqual({
      patterns: [],
      negated: ["packages/*"],
    });
  });
});

describe("findWorkspaces", () => {
  it("finds nothing when nothing is declared", async () => {
    await pkg("packages/a", { name: "a" });
    expect(await findWorkspaces(root, {})).toEqual([]);
  });

  it("expands packages/* to the directories holding a package.json", async () => {
    await pkg("packages/b", { name: "b", version: "2.0.0" });
    await pkg("packages/a", { name: "a", version: "1.0.0" });
    await pkg("packages/empty", null);
    await writeFile(join(root, "packages", "file.txt"), "");
    const list = await findWorkspaces(root, { workspaces: ["packages/*"] });
    expect(list.map((ws) => [ws.path, ws.name, ws.version])).toEqual([
      ["packages/a", "a", "1.0.0"],
      ["packages/b", "b", "2.0.0"],
    ]);
    expect(list[0]).toMatchObject({
      dir: join(root, "packages", "a"),
      manifest: { name: "a", version: "1.0.0" },
    });
  });

  it("walks packages/** but never node_modules", async () => {
    await pkg("packages/a", { name: "a" });
    await pkg("packages/a/nested", { name: "nested" });
    await pkg("packages/a/node_modules/dep", { name: "dep" });
    await pkg("node_modules/x/packages/y", { name: "y" });
    expect(await found({ workspaces: ["packages/**"] })).toEqual([
      ["packages/a", "a", "0.0.0"],
      ["packages/a/nested", "nested", "0.0.0"],
    ]);
  });

  it("leaves out what a negated pattern matches", async () => {
    await pkg("packages/a", { name: "a" });
    await pkg("packages/skip", { name: "skip" });
    expect(await found({ workspaces: ["packages/*", "!packages/skip"] })).toEqual([
      ["packages/a", "a", "0.0.0"],
    ]);
    expect(await found({ workspaces: { packages: ["packages/*", "!./packages/a"] } })).toEqual([
      ["packages/skip", "skip", "0.0.0"],
    ]);
  });

  it("orders by pattern, then by name within one, each directory once", async () => {
    await pkg("packages/z", { name: "z" });
    await pkg("packages/a", { name: "a" });
    await pkg("apps/web", { name: "web" });
    await pkg("apps/api", { name: "api" });
    expect(await found({ workspaces: ["packages/*", "apps/*", "packages/a"] })).toEqual([
      ["packages/a", "a", "0.0.0"],
      ["packages/z", "z", "0.0.0"],
      ["apps/api", "api", "0.0.0"],
      ["apps/web", "web", "0.0.0"],
    ]);
    expect(await found({ workspaces: ["packages/z", "packages/*"] })).toEqual([
      ["packages/z", "z", "0.0.0"],
      ["packages/a", "a", "0.0.0"],
    ]);
  });

  it("names a workspace after its folder when the manifest has no name", async () => {
    await pkg("packages/folder", { version: "3.0.0" });
    await pkg("packages/other", { name: "" });
    expect(await found({ workspaces: ["packages/*"] })).toEqual([
      ["packages/folder", "folder", "3.0.0"],
      ["packages/other", "other", "0.0.0"],
    ]);
  });

  it("follows a symlink to a directory", async () => {
    await pkg("elsewhere/a", { name: "a" });
    await mkdir(join(root, "packages"));
    await symlink(join(root, "elsewhere", "a"), join(root, "packages", "a"));
    expect(await found({ workspaces: ["packages/*"] })).toEqual([["packages/a", "a", "0.0.0"]]);
  });

  it("refuses two workspaces with one name", async () => {
    await pkg("packages/a", { name: "same" });
    await pkg("packages/b", { name: "same" });
    await expect(findWorkspaces(root, { workspaces: ["packages/*"] })).rejects.toThrow(
      expect.objectContaining({
        code: "EWORKSPACE",
        message: "workspaces packages/a and packages/b are both named same",
      }),
    );
  });

  it("refuses a package.json it cannot use", async () => {
    await pkg("packages/a", null);
    await writeFile(join(root, "packages", "a", "package.json"), "{");
    await expect(findWorkspaces(root, { workspaces: ["packages/*"] })).rejects.toThrow(
      expect.objectContaining({ code: "EMANIFEST" }),
    );
    await pkg("packages/a", { dependencies: ["x"] });
    await expect(findWorkspaces(root, { workspaces: ["packages/*"] })).rejects.toThrow(
      expect.objectContaining({ code: "EMANIFEST" }),
    );
  });

  it("refuses a pattern that reaches above the root before it globs", async () => {
    for (const pattern of ["../outside", "../*", "packages/../../outside", "!../outside"]) {
      await expect(findWorkspaces(root, { workspaces: [pattern] })).rejects.toThrow(
        expect.objectContaining({
          code: "EWORKSPACE",
          message: `workspace pattern ${pattern} reaches outside the project`,
        }),
      );
    }
  });

  it("does not take the root for its own workspace", async () => {
    await pkg(".", { name: "root", workspaces: ["**"] });
    await pkg("packages/a", { name: "a" });
    expect(await found({ workspaces: ["**"] })).toEqual([["packages/a", "a", "0.0.0"]]);
  });
});

describe("listWorkspaces", () => {
  afterEach(() => void vi.restoreAllMocks());

  /** Node's own glob, watched: the proof is there so that it does not run. */
  function globs() {
    return vi.spyOn(process.getBuiltinModule("node:fs/promises"), "glob");
  }

  /**
   * The clock moved on, so the stamps taken so far count as settled. A change after one must
   * then wait out the timestamp's tick itself, 30 ms here: not enough where a tick is 1 s.
   */
  function later(): void {
    const real = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => real.call(Date) + 60_000);
  }

  async function proof(manifest: RootManifest, known?: WorkspaceProof): Promise<WorkspaceProof> {
    return (await listWorkspaces(root, manifest, known)).proof!;
  }

  const paths = (listed: { workspaces: Workspace[] }) => listed.workspaces.map((ws) => ws.path);
  const ws = { workspaces: ["packages/*"] };

  it("finds the set again without a glob, and the manifests the same once their stamps settle", async () => {
    await pkg("packages/a", { name: "a" });
    await pkg("packages/b", { name: "b", version: "1.0.0" });
    await pkg("packages/empty", null);
    const first = await listWorkspaces(root, ws);
    expect(first).toMatchObject({ proof: { paths: ["packages/a", "packages/b"] }, proven: false });
    // Fresh stamps are not trusted: the same set, but its manifests are to be read as new.
    const glob = globs();
    const again = await listWorkspaces(root, ws, first.proof);
    // Nothing to learn yet, so the state keeps what it has.
    expect(again).toEqual({ ...first, proof: first.proof, learned: false });
    expect(glob.mock.calls).toHaveLength(0);
    later();
    const settled = await listWorkspaces(root, ws, again.proof);
    expect(settled).toMatchObject({ proven: false, learned: true });
    expect(settled.proof!.files["packages/a/package.json"]).toHaveLength(4);
    const same = await listWorkspaces(root, ws, settled.proof);
    expect(same).toEqual({
      workspaces: await findWorkspaces(root, ws),
      proof: settled.proof,
      proven: true,
      learned: false,
    });
    expect(glob.mock.calls).toHaveLength(1); // the findWorkspaces just above
  });

  it("globs again once a workspace or its package.json is added, removed or renamed", async () => {
    const changes: [string, () => Promise<unknown>][] = [
      ["a workspace added", () => pkg("packages/c", { name: "c" })],
      ["a workspace removed", () => rm(join(root, "packages", "b"), { recursive: true })],
      ["a workspace renamed", () => rename(join(root, "packages/b"), join(root, "packages/d"))],
      ["a package.json added", () => pkg("packages/empty", { name: "e" })],
      ["a package.json removed", () => rm(join(root, "packages", "a", "package.json"))],
      ["the patterns folder moved", () => rename(join(root, "packages"), join(root, "old"))],
    ];
    later();
    for (const [change, apply] of changes) {
      await rm(root, { recursive: true, force: true });
      await pkg("packages/a", { name: "a" });
      await pkg("packages/b", { name: "b" });
      await pkg("packages/empty", null);
      // Every stamp settled, as only the moved clock allows: the tick is waited out, so a change
      // after it still moves the stamp, as it would past a real settled one.
      const known = await proof(ws, await proof(ws));
      await new Promise((done) => setTimeout(done, 30));
      await apply();
      const glob = globs();
      const listed = await listWorkspaces(root, ws, known);
      expect(glob.mock.calls.length, change).toBeGreaterThan(0);
      expect(listed.proven, change).toBe(false);
      expect(listed.workspaces, change).toEqual(await findWorkspaces(root, ws));
      glob.mockRestore();
    }
  });

  it("reads an edited package.json again without a glob", async () => {
    await pkg("packages/a", { name: "a" });
    later();
    const known = await proof(ws, await proof(ws));
    await new Promise((done) => setTimeout(done, 30)); // past the stamp's tick
    await pkg("packages/a", { name: "z" }); // the same size: only its stamp can tell
    const glob = globs();
    const listed = await listWorkspaces(root, ws, known);
    expect(glob.mock.calls).toHaveLength(0);
    expect(listed).toMatchObject({ workspaces: [{ name: "z" }], proven: false });
  });

  it("globs again when a patterns folder appears, or the patterns change", async () => {
    await pkg("packages/a", { name: "a" });
    const both = { workspaces: ["packages/*", "apps/*"] };
    const known = await proof(both);
    expect(known.lists.apps).toEqual([null, ""]);
    // Still missing: the same proof, not one to write again.
    expect((await listWorkspaces(root, both, known)).proof).toBe(known);
    await pkg("apps/web", { name: "web" });
    expect(paths(await listWorkspaces(root, both, known))).toEqual(["packages/a", "apps/web"]);
    const listed = await listWorkspaces(root, both, await proof(ws));
    expect(paths(listed)).toEqual(["packages/a", "apps/web"]);
  });

  it("leaves a workspace's own folders out of packages/*", async () => {
    await pkg("packages/a", { name: "a" });
    const known = await proof(ws);
    expect(Object.keys(known.lists)).toEqual(["packages"]);
    expect(Object.keys(known.files)).toEqual(["packages/a/package.json"]);
    // A build's output, or the install's own node_modules, is no workspace's business.
    await pkg("packages/a/dist", { name: "dist" });
    await pkg("packages/a/node_modules/dep", { name: "dep" });
    const glob = globs();
    expect(paths(await listWorkspaces(root, ws, known))).toEqual(["packages/a"]);
    expect(glob.mock.calls).toHaveLength(0);
  });

  it("reads every folder under ** as deep as it goes, past node_modules and dot folders", async () => {
    const deep = { workspaces: ["packages/**"] };
    await pkg("packages/a", { name: "a" });
    await pkg("packages/a/src/lib", null);
    await pkg("packages/a/node_modules/dep", { name: "dep" });
    await pkg("packages/a/.cache/x", { name: "x" });
    const known = await proof(deep);
    expect(Object.keys(known.lists).sort()).toEqual([
      "packages",
      "packages/a",
      "packages/a/src",
      "packages/a/src/lib",
    ]);
    // A node_modules is never a workspace, so a package.json there changes nothing.
    await writeFile(join(root, "packages", "a", "node_modules", "package.json"), "{}");
    const glob = globs();
    expect(paths(await listWorkspaces(root, deep, known))).toEqual(["packages/a"]);
    expect(glob.mock.calls).toHaveLength(0);
    await pkg("packages/a/src/lib/nested", { name: "nested" });
    const listed = await listWorkspaces(root, deep, known);
    expect(paths(listed)).toEqual(["packages/a", "packages/a/src/lib/nested"]);
    expect(glob.mock.calls).toHaveLength(1);
  });

  it("follows a symlinked workspace, but proves nothing where ** would have to", async () => {
    await pkg("elsewhere/x", { name: "x" });
    await pkg("elsewhere/y", { name: "y" });
    await mkdir(join(root, "packages"));
    await symlink(join(root, "elsewhere", "x"), join(root, "packages", "a"));
    const known = await proof(ws);
    // Its target's package.json edited, then the link pointed elsewhere.
    await pkg("elsewhere/x", { name: "q" });
    const glob = globs();
    expect(await listWorkspaces(root, ws, known)).toMatchObject({ workspaces: [{ name: "q" }] });
    expect(glob.mock.calls).toHaveLength(0);
    await rm(join(root, "packages", "a"));
    await symlink(join(root, "elsewhere", "y"), join(root, "packages", "a"));
    expect(await listWorkspaces(root, ws, known)).toMatchObject({ workspaces: [{ name: "y" }] });
    expect(glob.mock.calls).toHaveLength(1);

    const deep = await listWorkspaces(root, { workspaces: ["packages/**"] });
    expect(deep.proof).toBeUndefined();
    expect(paths(deep)).toEqual(["packages/a"]);
  });

  it("sees a link that led nowhere, or to a file, once it leads to a workspace", async () => {
    await pkg("packages/a", { name: "a" });
    await writeFile(join(root, "file"), "");
    await symlink(join(root, "later"), join(root, "packages", "dangling"));
    await symlink(join(root, "file"), join(root, "packages", "to-file"));
    later();
    const known = await proof(ws, await proof(ws));
    await new Promise((done) => setTimeout(done, 30));
    await pkg("later", { name: "later" });
    await rm(join(root, "file"));
    await pkg("file", { name: "file" });
    const listed = await listWorkspaces(root, ws, known);
    expect(paths(listed)).toEqual(["packages/a", "packages/dangling", "packages/to-file"]);
    // Under `**` any link is one to follow with no depth to stop at: no proof.
    expect((await listWorkspaces(root, { workspaces: ["packages/**"] })).proof).toBeUndefined();
  });

  it("proves a folder named __proto__ like any other", async () => {
    const all = { workspaces: ["**"] };
    await pkg("__proto__/a", { name: "a" });
    later();
    const known = await proof(all, await proof(all));
    expect(Object.keys(known.lists)).toContain("__proto__");
    await new Promise((done) => setTimeout(done, 30));
    await pkg("__proto__/b", { name: "b" });
    expect(paths(await listWorkspaces(root, all, known))).toEqual(["__proto__/a", "__proto__/b"]);
  });

  it("keeps a proof where a folder matches only as a folder: packages/** takes packages", async () => {
    await pkg("packages", { name: "top" });
    await pkg("packages/a", { name: "a" });
    const listed = await listWorkspaces(root, { workspaces: ["packages/**"] });
    expect(paths(listed)).toEqual(["packages", "packages/a"]);
    expect(listed.proof?.paths).toEqual(["packages", "packages/a"]);
  });

  it("globs rather than trust a proof off a state edited by hand", async () => {
    await pkg("packages/a", { name: "a" });
    const known = await proof(ws);
    const forged = ["../outside", "/abs", "packages/../x", "packages//a", "C:/x"].map((path) => ({
      ...known,
      paths: [...known.paths, path],
      files: { ...known.files, [`${path}/package.json`]: true },
    }));
    const torn = [
      { ...known, lists: [] },
      { ...known, files: { x: 1 } },
      { ...known, paths: "a" },
    ];
    for (const bad of [...forged, ...torn] as WorkspaceProof[]) {
      const glob = globs();
      expect(paths(await listWorkspaces(root, ws, bad)), JSON.stringify(bad.paths)).toEqual([
        "packages/a",
      ]);
      expect(glob).toHaveBeenCalled();
      glob.mockRestore();
    }
  });

  it("proves nothing when its reading of the folders is not what the glob found", async () => {
    // The glob never goes into an excluded folder; the proof would, and find `b/c`.
    await pkg("packages/a", { name: "a" });
    await pkg("packages/b/c", { name: "c" });
    const listed = await listWorkspaces(root, { workspaces: ["packages/**", "!packages/b"] });
    expect(paths(listed)).toEqual(["packages/a"]);
    expect(listed.proof).toBeUndefined();
  });
});

describe("findRoot", () => {
  beforeEach(async () => {
    await pkg(".", { name: "root", workspaces: ["packages/*"] });
    await pkg("packages/a", { name: "a", version: "1.0.0" });
    await pkg("packages/a/src", null);
    await pkg("other", { name: "other" });
    await pkg("plain", null);
  });

  it("finds the root from inside a workspace, and names the workspace", async () => {
    for (const from of ["packages/a", "packages/a/src"]) {
      const { dir, manifest, workspaces, workspace } = await findRoot(join(root, from));
      expect(dir).toBe(root);
      expect(workspace).toMatchObject({ path: "packages/a", name: "a", version: "1.0.0" });
      // What it read of the root comes along, so the caller need not read it again.
      expect(manifest).toEqual({ name: "root", workspaces: ["packages/*"] });
      expect(workspaces).toEqual([workspace]);
    }
  });

  it("takes the root's set off the proof its state keeps, unless told not to", async () => {
    const manifest = { name: "root", workspaces: ["packages/*"] };
    const { proof } = await listWorkspaces(root, manifest);
    const state = { version: 1, hash: "h", entries: [], complete: true, store: "/store" };
    await writeState(root, { ...state, workspaces: proof } as InstallState);
    const glob = vi.spyOn(process.getBuiltinModule("node:fs/promises"), "glob");
    const found = await findRoot(join(root, "packages", "a"));
    expect(found).toMatchObject({ dir: root, workspace: { path: "packages/a" } });
    expect(found.listed?.proof).toEqual(proof);
    expect(glob).not.toHaveBeenCalled();
    expect(await findRoot(join(root, "packages", "a"), false)).toMatchObject({ dir: root });
    expect(glob).toHaveBeenCalledTimes(1);
    glob.mockRestore();
  });

  it("is the root itself from the root or a plain subdirectory", async () => {
    const manifest = { name: "root", workspaces: ["packages/*"] };
    expect(await findRoot(root)).toEqual({ dir: root, manifest });
    expect(await findRoot(join(root, "plain"))).toEqual({ dir: root, manifest });
  });

  it("stops at a package.json the root does not list as a workspace", async () => {
    expect(await findRoot(join(root, "other"))).toEqual({
      dir: join(root, "other"),
      manifest: { name: "other" },
    });
  });

  it("is cwd when no package.json is anywhere above", async () => {
    const bare = await mkdtemp(join(tmpdir(), "upm-ws-bare-"));
    try {
      expect(await findRoot(bare)).toEqual({ dir: bare });
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("passes over a package.json it cannot parse on the way up", async () => {
    await writeFile(join(root, "package.json"), "{");
    expect(await findRoot(join(root, "packages", "a"))).toEqual({
      dir: join(root, "packages", "a"),
      manifest: { name: "a", version: "1.0.0" },
    });
  });

  it("passes over an ancestor whose workspaces cannot be listed, unless it is the root", async () => {
    // Bad shape, two of one name, a pattern above the root: none of them is `other`'s problem.
    const bad = [
      { workspaces: "packages/*" },
      { workspaces: ["packages/*", "dup/*"] },
      { workspaces: ["../*"] },
    ];
    await pkg("dup/a", { name: "a" });
    for (const manifest of bad) {
      await pkg(".", { name: "root", ...manifest });
      expect(await findRoot(join(root, "other"))).toEqual({
        dir: join(root, "other"),
        manifest: { name: "other" },
      });
      // From the root itself the listing is not run here, so the error surfaces later.
      expect(await findRoot(root)).toEqual({ dir: root, manifest: { name: "root", ...manifest } });
    }
  });
});

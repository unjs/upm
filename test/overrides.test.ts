import { describe, expect, it } from "vitest";
import {
  changedTargets,
  compileOverrides,
  intersects,
  pnpmOverrides,
  readOverrides,
} from "../src/overrides.ts";

const read = (manifest: object) => readOverrides(manifest);

describe("readOverrides", () => {
  it("reads npm's overrides, a nested object as the parent's own edges", () => {
    const overrides = {
      a: "1.0.0",
      b: { ".": "2.0.0", c: "^3" },
      "d@^1": { e: "4.0.0" },
      f: { g: { h: "1.0.0" }, i: "1.0.0" },
    };
    expect(read({ overrides })).toEqual({
      overrides: { a: "1.0.0", b: "2.0.0", "b>c": "^3", "d@^1>e": "4.0.0", "f>i": "1.0.0" },
      // A package has one set of edges, so a rule two levels down is not one upm can keep.
      skipped: ["overrides.f.g"],
    });
  });

  it("reads yarn's resolutions as paths of names", () => {
    const resolutions = {
      a: "1.0.0",
      "**/b": "2.0.0",
      "c/d": "3.0.0",
      "@s/e/@s/f": "4.0.0",
      "g@npm:^1": "1.2.0",
      "h/**/i": "1.0.0",
      "j/k/l": "1.0.0",
    };
    expect(read({ resolutions })).toEqual({
      overrides: {
        "@s/e>@s/f": "4.0.0",
        a: "1.0.0",
        b: "2.0.0",
        "c>d": "3.0.0",
        "g@^1": "1.2.0",
      },
      skipped: ['resolutions["h/**/i"]', 'resolutions["j/k/l"]'],
    });
  });

  it("reads pnpm's overrides, a `-` included", () => {
    const pnpm = { overrides: { a: "-", "b@1>c@^2": "2.1.0", "d>e>f": "1.0.0" } };
    expect(read({ pnpm })).toEqual({
      overrides: { a: "-", "b@1>c@^2": "2.1.0" },
      skipped: ['pnpm.overrides["d>e>f"]'],
    });
  });

  it("reads `$name` as the root's own range for it", () => {
    const manifest = {
      dependencies: { a: "^1.2.0" },
      devDependencies: { b: "~2.0.0" },
      overrides: { a: "$a", c: { b: "$b" } },
    };
    expect(read(manifest).overrides).toEqual({ a: "^1.2.0", "c>b": "~2.0.0" });
    expect(() => read({ overrides: { a: "$a" } })).toThrow(
      expect.objectContaining({ code: "EMANIFEST", message: expect.stringContaining("$a") }),
    );
  });

  it("merges the fields, and refuses two that disagree", () => {
    const manifest = { overrides: { a: "1.0.0" }, resolutions: { "**/a": "1.0.0", b: "2.0.0" } };
    expect(read(manifest).overrides).toEqual({ a: "1.0.0", b: "2.0.0" });
    const other = { overrides: { a: "1.0.0" }, pnpm: { overrides: { a: "1.0.1" } } };
    expect(() => read(other)).toThrow(
      expect.objectContaining({
        code: "EMANIFEST",
        message: 'overrides.a and pnpm.overrides["a"] disagree',
      }),
    );
  });

  it("keeps a value as a spec: aliases and urls as written, a local path as the root's", () => {
    const overrides = { a: "npm:b@^1", c: "file:./vendor/../c.tgz", d: "https://x/d.tgz" };
    expect(read({ overrides }).overrides).toEqual({
      a: "npm:b@^1",
      c: "file:c.tgz",
      d: "https://x/d.tgz",
    });
  });

  it("refuses a value that is not a string, and a field that is not an object", () => {
    const code = expect.objectContaining({ code: "EMANIFEST" });
    expect(() => read({ overrides: { a: 1 } })).toThrow(code);
    expect(() => read({ resolutions: ["a"] })).toThrow(code);
    expect(() => read({ overrides: { a: { b: 1 } } })).not.toThrow();
  });

  it("skips a value upm does not install, as yarn's patches and git off a known host", () => {
    const resolutions = { a: "patch:a@npm%3A1.0.0#./a.patch", b: "portal:../b", c: "1.0.0" };
    const overrides = { d: "git+ssh://x", e: "workspace:*", f: "github:u/f" };
    expect(read({ resolutions, overrides })).toEqual({
      // A git spec on a known host is its archive's url.
      overrides: { c: "1.0.0", f: "https://codeload.github.com/u/f/tar.gz/HEAD" },
      skipped: ['resolutions["a"]', 'resolutions["b"]', "overrides.d", "overrides.e"],
    });
  });

  it("never takes the `>` of a range for a parent", () => {
    const manifest = {
      overrides: { "semver@>=7.0.0 <7.5.2": "7.5.2", "b@>1.0.0": "1.0.0", "c@>=1": { d: "2" } },
      pnpm: { overrides: { "e@>=1.0.0": "2", "f@^1 || >2>g@>3": "4", "h>i>j": "1" } },
    };
    const { overrides, skipped } = read(manifest);
    expect(overrides).toEqual({
      "b@>1.0.0": "1.0.0",
      "c@>=1>d": "2",
      "e@>=1.0.0": "2",
      "f@^1 || >2>g@>3": "4",
      "semver@>=7.0.0 <7.5.2": "7.5.2",
    });
    expect(skipped).toEqual(['pnpm.overrides["h>i>j"]']);
    const rules = compileOverrides(overrides);
    expect(rules.get("semver")).toEqual([
      { name: "semver", range: ">=7.0.0 <7.5.2", value: "7.5.2" },
    ]);
    expect(rules.get("b")).toEqual([{ name: "b", range: ">1.0.0", value: "1.0.0" }]);
    expect(rules.get("g")).toEqual([
      { name: "g", range: ">3", parent: "f", parentRange: "^1 || >2", value: "4" },
    ]);
    expect(changedTargets({}, overrides).names).toEqual(new Set(["b", "d", "e", "g", "semver"]));
  });

  it("says nothing of a manifest with no overrides", () => {
    expect(read({ dependencies: { a: "^1" } })).toEqual({ overrides: {}, skipped: [] });
  });
});

describe("pnpmOverrides", () => {
  it("reads the overrides block of a pnpm-workspace.yaml a person wrote, and nothing else", () => {
    const text = [
      "# pnpm settings",
      "packages:",
      "- packages/*",
      "overrides:",
      "  ms: 2.1.1 # pinned for a reason",
      '  "ansi-styles@>=4.3.0": 4.2.1',
      "  'debug>ms': '-'",
      '  hash: "a # b"',
      "",
      "  semver: ^7",
      "catalog:",
      "  react: ^18",
    ].join("\r\n");
    expect(pnpmOverrides(text)).toEqual({
      ms: "2.1.1",
      "ansi-styles@>=4.3.0": "4.2.1",
      "debug>ms": "-",
      hash: "a # b",
      semver: "^7",
    });
    expect(pnpmOverrides("overrides: { ms: 2.1.1, 'a>b': '-' }\n")).toEqual({
      ms: "2.1.1",
      "a>b": "-",
    });
    expect(pnpmOverrides("packages:\n  - a\n")).toBeUndefined();
    expect(pnpmOverrides("overrides:\n")).toEqual({});
  });

  it("joins package.json's rules, named by the file they came from", () => {
    const manifest = { overrides: { ms: "2.1.1" } };
    const pnpm = { "debug>ms": "-", ms: "2.1.1" };
    expect(read(manifest)).toEqual({ overrides: { ms: "2.1.1" }, skipped: [] });
    expect(readOverrides(manifest, pnpm)).toEqual({
      overrides: { "debug>ms": "-", ms: "2.1.1" },
      skipped: [],
    });
    expect(() => readOverrides(manifest, { ms: "2.1.2" })).toThrow(
      'overrides.ms and pnpm-workspace.yaml overrides["ms"] disagree',
    );
    expect(() => readOverrides({}, ["ms"])).toThrow("must be an object");
  });
});

describe("compileOverrides", () => {
  it("puts a rule for a version of a parent before one for any of it", () => {
    const rules = compileOverrides({ "a>b": "1.0.0", "a@1>b": "1.2.0" });
    expect(rules.get("b")!.map((rule) => rule.value)).toEqual(["1.2.0", "1.0.0"]);
  });

  it("puts a parent's rule first, then one with a range", () => {
    const rules = compileOverrides({ a: "1", "a@^2": "2", "p>a": "3", "p@1>a@^4": "4" });
    expect(rules.get("a")!.map((rule) => rule.value)).toEqual(["4", "3", "2", "1"]);
    expect(rules.get("a")![0]).toEqual({
      name: "a",
      range: "^4",
      parent: "p",
      parentRange: "1",
      value: "4",
    });
  });
});

describe("intersects", () => {
  it("is true when some version is in both ranges", () => {
    const yes: [string, string][] = [
      ["^4.1.0", "<4.2.0"],
      ["^4.1.0", ">=4.3.0"],
      ["1.2.3", "<2"],
      ["<=1.0.0", ">=1.0.0"],
      ["*", "<1"],
      ["^1 || ^3", ">=3"],
      [">1.0.0 <1.0.2", "1.0.1"],
    ];
    const no: [string, string][] = [
      ["^4.1.0", ">=5"],
      ["^1", "<1.0.0"],
      ["~1.2.0", "1.3.x"],
      ["<1.0.0", ">=1.0.0"],
      [">1.0.0 <1.0.2", "1.0.2"],
      ["^1", "not a range"],
    ];
    for (const [a, b] of yes) expect([a, b, intersects(a, b)]).toEqual([a, b, true]);
    for (const [a, b] of no) expect([a, b, intersects(a, b)]).toEqual([a, b, false]);
  });
});

describe("changedTargets", () => {
  it("names the targets of rules that came, went or moved", () => {
    const before = { a: "1", "p>b": "2", c: "3" };
    const after = { a: "1", "p>b": "3", d: "4" };
    expect(changedTargets(before, after)).toEqual({ names: new Set(["b", "c", "d"]), all: false });
  });

  it("reaches every package when a `-` goes, since its edge is in no lock entry", () => {
    expect(changedTargets({ a: "-" }, {}).all).toBe(true);
    expect(changedTargets({}, { a: "-" }).all).toBe(false);
  });
});

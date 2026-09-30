import { describe, expect, it } from "vitest";
import { changedTargets, compileOverrides, readOverrides } from "../src/overrides.ts";

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

  it("refuses a value that is not a spec, a workspace, and a field that is not an object", () => {
    const code = expect.objectContaining({ code: "EMANIFEST" });
    expect(() => read({ overrides: { a: 1 } })).toThrow(code);
    expect(() => read({ overrides: { a: "git+ssh://x" } })).toThrow(code);
    expect(() => read({ overrides: { a: "workspace:*" } })).toThrow(code);
    expect(() => read({ resolutions: ["a"] })).toThrow(code);
    expect(() => read({ overrides: { a: { b: 1 } } })).not.toThrow();
  });

  it("says nothing of a manifest with no overrides", () => {
    expect(read({ dependencies: { a: "^1" } })).toEqual({ overrides: {}, skipped: [] });
  });
});

describe("compileOverrides", () => {
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

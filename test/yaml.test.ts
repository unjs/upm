import { describe, expect, it } from "vitest";
import { yaml } from "../src/yaml.ts";

describe("yaml", () => {
  it("reads the explicit key form pnpm uses for long keys", () => {
    expect(yaml("snapshots:\n  ? pathe@2.0.3\n  : {}\n")).toEqual({
      snapshots: { "pathe@2.0.3": {} },
    });
  });

  it("reads an explicit key with a quoted name, a nested block value and its siblings", () => {
    expect(
      yaml(
        "snapshots:\n  ? 'long-package-name'\n  : dependencies:\n      helper: 1.0.0\n    optionalDependencies:\n      opt: 1.0.0\n  other@1.0.0: {}\n",
      ),
    ).toEqual({
      snapshots: {
        "long-package-name": {
          dependencies: { helper: "1.0.0" },
          optionalDependencies: { opt: "1.0.0" },
        },
        "other@1.0.0": {},
      },
    });
  });

  it("reads a compact mapping whose first key is quoted", () => {
    expect(
      yaml(
        "snapshots:\n  ? pkg@1.0.0\n  : 'dependencies':\n      helper: 1.0.0\n  other@1.0.0: {}\n",
      ),
    ).toEqual({
      snapshots: {
        "pkg@1.0.0": { dependencies: { helper: "1.0.0" } },
        "other@1.0.0": {},
      },
    });
  });

  it("reads a compact mapping whose first key and value are both quoted", () => {
    expect(yaml("a:\n  ? k\n  : 'x: y': 'z: w'\n    b: c\n  d: e\n")).toEqual({
      a: { k: { "x: y": "z: w", b: "c" }, d: "e" },
    });
  });

  it("keeps a quoted scalar on the separator line", () => {
    expect(yaml("a:\n  ? k\n  : 'text: here'\n")).toEqual({ a: { k: "text: here" } });
  });

  it("reads nested block maps", () => {
    expect(yaml("packages:\n  a@1.0.0:\n    dependencies:\n      b: 1.0.0\n")).toEqual({
      packages: { "a@1.0.0": { dependencies: { b: "1.0.0" } } },
    });
  });
});

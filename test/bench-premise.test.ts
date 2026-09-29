import { describe, expect, it } from "vitest";

import { premise } from "../bench/premise.ts";

const counts = (total: number, distinct: number) => ({
  total,
  distinct,
  repeats: total - distinct,
});

describe("premise", () => {
  it("reads upm.lock specs for tops and pinned deps for packages", () => {
    const result = premise(
      JSON.stringify({
        lockfileVersion: 1,
        root: {
          specs: { devDependencies: { a: "^1.0.0" } },
          dependencies: { a: "1.0.0" },
        },
        workspaces: {
          web: { specs: { dependencies: { a: "^1.0.0" } }, dependencies: { a: "1.0.0" } },
        },
        packages: {
          "a@1.0.0": { integrity: "sha512-a", dependencies: { b: "2.0.0" } },
          "b@2.0.0": { integrity: "sha512-b", devDependencies: { c: "^3.0.0" } },
        },
      }),
    );
    expect(result).toEqual({ store: counts(2, 2), asks: counts(3, 2), pinned: true });
  });

  it("reads npm package-lock dev deps only for the root and workspaces", () => {
    const result = premise(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { devDependencies: { a: "^1.0.0" } },
          web: { devDependencies: { a: "^1.0.0" } },
          "node_modules/web": { link: true },
          "node_modules/a": { integrity: "sha512-a", devDependencies: { c: "^3.0.0" } },
          "node_modules/b": { integrity: "sha512-b", dependencies: { a: "^1.0.0" } },
          "node_modules/b/node_modules/a": { integrity: "sha512-b" },
        },
      }),
    );
    expect(result).toEqual({ store: counts(3, 2), asks: counts(3, 1), pinned: false });
  });

  it("reads vlt-lock.json nodes and edges, keeping spaces in a spec", () => {
    const result = premise(
      JSON.stringify({
        nodes: {
          "~npm~a@1.0.0": [0, "a", "sha512-x"],
          "~npm~b@1.0.0": [0, "b", "sha512-x"],
          "file~.": [0, "root"],
        },
        edges: {
          "file~. a": "prod ^1 || ^2 ~npm~a@1.0.0",
          "~npm~b@1.0.0 a": "prod ^1 ~npm~a@1.0.0",
          "~npm~c@1.0.0 a": "peer ^1 ~npm~a@1.0.0",
        },
      }),
    );
    expect(result).toEqual({ store: counts(2, 1), asks: counts(3, 2), pinned: false });
  });

  it("rejects YAML and unknown shapes instead of counting zero", () => {
    for (const text of ["# yarn lockfile v1\n\nfoo@^1:\n", "lockfileVersion: '9.0'\n", "{}"]) {
      expect(() => premise(text)).toThrow(/not a upm.lock/);
    }
  });
});

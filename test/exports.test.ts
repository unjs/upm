import { describe, expect, it } from "vitest";
import { exportsTarget } from "../src/exports.ts";

describe("exportsTarget", () => {
  it("reads `.` given as a string, an array or conditions", () => {
    expect(exportsTarget("./a.js", ".")).toBe("./a.js");
    expect(exportsTarget("./a.js", "./b")).toBeUndefined();
    expect(exportsTarget(["./a.js", "./b.js"], ".")).toBe("./a.js");
    expect(exportsTarget({ require: "./a.cjs", import: "./a.mjs" }, ".")).toBe("./a.mjs");
    expect(exportsTarget({ types: "./a.d.ts", default: "./a.js" }, ".")).toBe("./a.js");
  });

  it("takes the first condition that is set, in the package's order", () => {
    const nested = { node: { import: "./node.mjs", require: "./node.cjs" }, default: "./x.js" };
    expect(exportsTarget(nested, ".")).toBe("./node.mjs");
    expect(exportsTarget({ browser: "./b.js", default: "./x.js" }, ".")).toBe("./x.js");
    expect(exportsTarget({ default: "./x.js", import: "./a.mjs" }, ".")).toBe("./x.js");
    expect(exportsTarget({ browser: "./b.js" }, ".", ["browser"])).toBe("./b.js");
    expect(exportsTarget({ require: "./a.cjs" }, ".")).toBeUndefined();
  });

  it("maps subpaths, exactly first, then by the most specific pattern", () => {
    const exports = {
      ".": "./index.js",
      "./package.json": "./package.json",
      "./*": "./dist/*.js",
      "./utils/*": "./dist/utils/*.mjs",
      "./utils/*.css": "./css/*.css",
      "./utils/exact": "./exact.js",
      "./a/*/b": "./dist/a/*/b.js",
    };
    expect(exportsTarget(exports, ".")).toBe("./index.js");
    expect(exportsTarget(exports, "./package.json")).toBe("./package.json");
    expect(exportsTarget(exports, "./utils/exact")).toBe("./exact.js");
    expect(exportsTarget(exports, "./utils/x/y")).toBe("./dist/utils/x/y.mjs");
    expect(exportsTarget(exports, "./utils/x.css")).toBe("./css/x.css");
    expect(exportsTarget(exports, "./a/1/2/b")).toBe("./dist/a/1/2/b.js");
    expect(exportsTarget(exports, "./other")).toBe("./dist/other.js");
    expect(exportsTarget({ ".": "./i.js" }, "./other")).toBeUndefined();
    // A pattern needs something in place of its `*`.
    expect(exportsTarget({ "./utils/*": "./u/*.js" }, "./utils/")).toBeUndefined();
  });

  it("holds back what a null target names", () => {
    const exports = { "./*": "./dist/*.js", "./internal/*": null };
    expect(exportsTarget(exports, "./internal/x")).toBeUndefined();
    expect(exportsTarget({ ".": { import: null, default: "./a.js" } }, ".")).toBeUndefined();
    expect(exportsTarget({ ".": [null, "./a.js"] }, ".")).toBeUndefined();
  });

  it("passes over targets outside the package", () => {
    expect(exportsTarget("a.js", ".")).toBeUndefined();
    expect(exportsTarget(["../a.js", "./b.js"], ".")).toBe("./b.js");
    expect(exportsTarget({ ".": 1 }, ".")).toBeUndefined();
  });
});

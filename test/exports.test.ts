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
    expect(exportsTarget({ ".": ["./a.cjs", null] }, ".")).toBe("./a.cjs");
    expect(exportsTarget({ ".": [{ require: "./a.cjs" }, null] }, ".")).toBeUndefined();
    // In a list, a null is passed over as Node.js does.
    expect(exportsTarget({ ".": [null, "./a.js"] }, ".")).toBe("./a.js");
    expect(exportsTarget({ ".": [[null], { import: "./a.mjs" }] }, ".")).toBe("./a.mjs");
  });

  it("refuses a target that is not a path inside the package, as Node.js does", () => {
    const invalid = expect.objectContaining({ code: "EMANIFEST" });
    for (const target of ["a.js", "../a.js", "./a/../../b.js", "./node_modules/x/a.js", 1, true]) {
      expect(() => exportsTarget({ ".": target }, "."), String(target)).toThrow(invalid);
    }
    // In a condition too: Node.js does not go on to the next.
    const conditions = { import: "pkg/a.js", default: "./a.js" };
    expect(() => exportsTarget(conditions, ".")).toThrow(invalid);
    // A target never taken is never read.
    expect(exportsTarget({ require: "../a.cjs", default: "./a.js" }, ".")).toBe("./a.js");
    expect(exportsTarget({ ".": "./a.js", "./x": "../x.js" }, ".")).toBe("./a.js");
  });

  it("passes over an invalid target in a list, unless it is the last word", () => {
    const invalid = expect.objectContaining({ code: "EMANIFEST" });
    expect(exportsTarget(["../a.js", "./b.js"], ".")).toBe("./b.js");
    expect(exportsTarget([{ import: 1 }, "./b.js"], ".")).toBe("./b.js");
    expect(() => exportsTarget([{ require: "./a.cjs" }, "../b.js"], ".")).toThrow(invalid);
    expect(exportsTarget(["../b.js", null], ".")).toBeUndefined();
    expect(() => exportsTarget([null, "../b.js"], ".")).toThrow(invalid);
    expect(exportsTarget({ ".": [] }, ".")).toBeUndefined();
  });

  it("does not fill a `*` with a segment that leaves the package", () => {
    const exports = { "./x*": "./dist/*.js" };
    expect(exportsTarget(exports, "./xa")).toBe("./dist/a.js");
    expect(exportsTarget(exports, "./x./y")).toBeUndefined();
    expect(exportsTarget(exports, "./x/../y")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { splitImport } from "../src/exec.ts";

describe("splitImport", () => {
  it.each([
    ["pkg", "pkg", ""],
    ["npm:pkg", "pkg", ""],
    ["npm:pkg@rc", "pkg@rc", ""],
    ["pkg@^1/sub/file.js", "pkg@^1", "/sub/file.js"],
    ["pkg/sub@1", "pkg@1", "/sub"],
    ["@org/name", "@org/name", ""],
    ["@org/name@2", "@org/name@2", ""],
    ["@org/name/sub", "@org/name", "/sub"],
    ["@org/name/sub@next", "@org/name@next", "/sub"],
    ["npm:@org/name@1/sub", "@org/name@1", "/sub"],
    // An `@` inside the subpath is no version.
    ["pkg/@types/x", "pkg", "/@types/x"],
    ["pkg@1/a@b", "pkg@1", "/a@b"],
  ])("%s", (specifier, spec, subpath) => {
    expect(splitImport(specifier)).toEqual({ spec, subpath });
  });
});

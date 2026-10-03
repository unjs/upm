import { describe, expect, it } from "vitest";
import { parseImport } from "../src/exec.ts";

describe("parseImport", () => {
  it.each([
    ["pkg", "pkg", ""],
    ["npm:pkg", "pkg", ""],
    ["npm:pkg@rc", "pkg@rc", ""],
    ["pkg@^1/sub/file.js", "pkg@^1", "/sub/file.js"],
    ["@org/name", "@org/name", ""],
    ["@org/name@2", "@org/name@2", ""],
    ["@org/name/sub", "@org/name", "/sub"],
    ["npm:@org/name@1/sub", "@org/name@1", "/sub"],
    // A version goes after the name only: an `@` in the subpath is part of it.
    ["pkg/file@2.js", "pkg", "/file@2.js"],
    ["pkg/@types/x", "pkg", "/@types/x"],
  ])("%s", (specifier, raw, subpath) => {
    const { spec, subpath: sub } = parseImport(specifier);
    expect({ raw: spec.raw, sub }).toEqual({ raw, sub: subpath });
  });

  it.each([
    "jsr:@std/path",
    "node:fs",
    "https://example.com/x.js",
    "npm:npm:pkg",
    "./x.js",
    "/x.js",
    "C:\\x.js",
    "pkg@git+https://github.com/a/b.git",
    "pkg@github:a/b",
    "pkg@./x.tgz",
    "pkg@file:x",
    "pkg@link:../x",
    "pkg@workspace:*",
    "pkg@npm:other@1",
    "Bad Name",
    "",
  ])("refuses %s", (specifier) => {
    expect(() => parseImport(specifier)).toThrow(
      expect.objectContaining({
        code: "EINVALIDSPEC",
        message: expect.stringContaining("[npm:]name[@version][/subpath]"),
      }),
    );
  });
});

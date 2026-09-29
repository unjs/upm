import { describe, expect, it } from "vitest";
import {
  compare,
  intersect,
  maxSatisfying,
  parse,
  rcompare,
  rsort,
  satisfies,
  sort,
  validRange,
} from "../src/semver.ts";

describe("parse", () => {
  const valid: [string, string][] = [
    ["1.2.3", "1.2.3"],
    ["v1.2.3", "1.2.3"],
    ["=1.2.3", "1.2.3"],
    ["=v1.2.3", "1.2.3"],
    ["  1.2.3  ", "1.2.3"],
    ["0.0.0", "0.0.0"],
    ["10.20.30", "10.20.30"],
    ["1.2.3-alpha", "1.2.3-alpha"],
    ["1.2.3-alpha.1", "1.2.3-alpha.1"],
    ["1.2.3-0.3.7", "1.2.3-0.3.7"],
    ["1.2.3-x.7.z.92", "1.2.3-x.7.z.92"],
    ["1.2.3-alpha-beta", "1.2.3-alpha-beta"],
    ["1.2.3+build.1", "1.2.3"],
    ["1.2.3-beta+exp.sha.5114f85", "1.2.3-beta"],
  ];
  it.each(valid)("parses %j", (input, version) => {
    expect(parse(input)?.version).toBe(version);
  });

  const invalid = [
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-",
    "1.2.3+",
    "1.2.x",
    "1.2.3-beta_1",
    "1.2.3 4.5.6",
    "a.b.c",
    "-1.2.3",
    "1.2.3-alpha..1",
    "^1.2.3",
    "latest",
  ];
  it.each(invalid)("rejects %j", (input) => {
    expect(parse(input)).toBeUndefined();
  });

  it("does not throw on non-string input", () => {
    expect(parse(undefined as unknown as string)).toBeUndefined();
    expect(parse(42 as unknown as string)).toBeUndefined();
  });

  it("splits every field", () => {
    expect(parse("1.2.3-alpha.7.beta+exp.sha")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["alpha", 7, "beta"],
      build: ["exp", "sha"],
      version: "1.2.3-alpha.7.beta",
    });
  });

  it("keeps numeric prerelease ids as numbers", () => {
    expect(parse("1.0.0-0.a.10")?.prerelease).toEqual([0, "a", 10]);
  });
});

describe("compare", () => {
  // Ascending, per the semver spec.
  const ordered = [
    "0.0.0",
    "0.0.1",
    "0.1.0",
    "1.0.0-0",
    "1.0.0-0.1",
    "1.0.0-1",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
    "10.0.0",
  ];

  it("orders every pair", () => {
    for (const [i, a] of ordered.entries()) {
      for (const [j, b] of ordered.entries()) {
        expect(compare(a, b), `${a} vs ${b}`).toBe(Math.sign(i - j));
      }
    }
  });

  it("ignores build metadata", () => {
    expect(compare("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(compare("1.0.0-beta+a", "1.0.0-beta+b")).toBe(0);
  });

  it("accepts parsed versions and normalizes prefixes", () => {
    expect(compare(parse("1.2.3")!, "v1.2.3")).toBe(0);
    expect(compare("=1.2.3", "1.2.4")).toBe(-1);
  });

  it("drops unparseable entries when sorting", () => {
    expect(sort(["2.0.0", "nope", "1.0.0"])).toEqual(["1.0.0", "2.0.0"]);
    expect(rsort(["2.0.0", "nope", "1.0.0"])).toEqual(["2.0.0", "1.0.0"]);
  });

  it("throws on invalid input", () => {
    expect(() => compare("not-a-version", "1.0.0")).toThrow(TypeError);
  });

  it("rcompare reverses", () => {
    expect(rcompare("1.0.0", "2.0.0")).toBe(1);
    expect(rcompare("2.0.0", "1.0.0")).toBe(-1);
    expect(rcompare("1.0.0", "1.0.0")).toBe(0);
  });

  it("sorts ascending and descending without mutating", () => {
    const input = ["2.0.0", "1.0.0-rc.1", "1.0.0", "1.0.0-beta"];
    expect(sort(input)).toEqual(["1.0.0-beta", "1.0.0-rc.1", "1.0.0", "2.0.0"]);
    expect(rsort(input)).toEqual(["2.0.0", "1.0.0", "1.0.0-rc.1", "1.0.0-beta"]);
    expect(input[0]).toBe("2.0.0");
  });
});

describe("satisfies", () => {
  const cases: [string, string, boolean][] = [
    // exact and bare
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["1.2.3", "=1.2.3", true],
    ["1.2.3", "v1.2.3", true],
    ["1.2.3", "1.2.3+build", true],

    // comparators
    ["1.2.4", ">1.2.3", true],
    ["1.2.3", ">1.2.3", false],
    ["1.2.3", ">=1.2.3", true],
    ["1.2.2", "<1.2.3", true],
    ["1.2.3", "<1.2.3", false],
    ["1.2.3", "<=1.2.3", true],
    ["1.2.3", ">= 1.2.3", true],
    ["1.3.0", ">=1.2", true],
    ["1.1.9", ">=1.2", false],
    ["1.3.0", ">1.2", true],
    ["1.2.9", ">1.2", false],
    ["1.2.9", "<=1.2", true],
    ["1.3.0", "<=1.2", false],
    ["1.9.9", "<2", true],
    ["2.0.0", "<2", false],
    ["2.0.0", ">1", true],
    ["1.9.9", ">1", false],

    // caret
    ["1.2.3", "^1.2.3", true],
    ["1.9.9", "^1.2.3", true],
    ["1.2.2", "^1.2.3", false],
    ["2.0.0", "^1.2.3", false],
    ["1.3.0", "^1.2", true],
    ["1.2.0", "^1", true],
    ["0.2.3", "^0.2.3", true],
    ["0.2.9", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["0.2.2", "^0.2.3", false],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["0.0.9", "^0.0.x", true],
    ["0.1.0", "^0.0.x", false],
    ["0.9.9", "^0", true],
    ["1.0.0", "^0", false],

    // tilde
    ["1.2.3", "~1.2.3", true],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.2.0", "~1.2", true],
    ["1.2.9", "~1.2", true],
    ["1.3.0", "~1.2", false],
    ["1.0.0", "~1", true],
    ["1.9.9", "~1", true],
    ["2.0.0", "~1", false],
    ["1.2.9", "~>1.2.3", true],
    ["1.3.0", "~>1.2.3", false],

    // x-ranges
    ["1.2.3", "*", true],
    ["1.2.3", "", true],
    ["1.2.3", "x", true],
    ["1.2.3", "1.x", true],
    ["2.0.0", "1.x", false],
    ["1.2.9", "1.2.*", true],
    ["1.3.0", "1.2.*", false],
    ["1.9.9", "1", true],
    ["1.2.9", "1.2", true],
    ["1.3.0", "1.2", false],
    ["1.0.0", "1.x.x", true],

    // hyphen
    ["1.2.3", "1.2.3 - 2.3.4", true],
    ["2.3.4", "1.2.3 - 2.3.4", true],
    ["2.3.5", "1.2.3 - 2.3.4", false],
    ["1.2.2", "1.2.3 - 2.3.4", false],
    ["1.2.0", "1.2 - 2.3.4", true],
    ["1.1.9", "1.2 - 2.3.4", false],
    ["2.3.9", "1.2.3 - 2.3", true],
    ["2.4.0", "1.2.3 - 2.3", false],
    ["2.9.9", "1 - 2", true],
    ["3.0.0", "1 - 2", false],

    // AND / OR
    ["1.5.0", ">=1.2.3 <2.0.0", true],
    ["2.0.0", ">=1.2.3 <2.0.0", false],
    ["1.5.0", "^1.0.0 || ^2.0.0", true],
    ["2.5.0", "^1.0.0 || ^2.0.0", true],
    ["3.0.0", "^1.0.0 || ^2.0.0", false],
    ["1.5.0", "<1.0.0 || >=2.0.0", false],
    ["2.0.0", "<1.0.0 || >=2.0.0", true],
    ["1.2.3", "  1.2.3   ||   2.3.4  ", true],
  ];
  it.each(cases)("%j satisfies %j -> %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it("returns false for invalid versions or ranges", () => {
    expect(satisfies("nope", "^1.0.0")).toBe(false);
    expect(satisfies("1.0.0", "not a range")).toBe(false);
    expect(satisfies("1.0.0", ">=")).toBe(false);
  });
});

describe("prerelease exclusion", () => {
  const cases: [string, string, boolean][] = [
    // Only a comparator on the same tuple opts a prerelease in.
    ["1.2.3-beta.1", "^1.0.0", false],
    ["2.0.0-beta.1", "^1.0.0", false],
    ["1.0.0-beta.1", "*", false],
    ["1.0.0-beta.1", "", false],
    ["1.0.0-beta.1", ">=0.0.0", false],
    ["1.2.3-beta.1", "1.2.3 - 2.3.4", false],
    ["1.2.3-beta.1", "^1.2.3-alpha", true],
    ["1.2.3-beta.1", "^1.2.3-beta.2", false],
    ["1.2.4-beta.1", "^1.2.3-alpha", false],
    ["1.2.3-beta.1", ">=1.2.3-alpha", true],
    ["1.2.4-beta.1", ">=1.2.3-alpha", false],
    ["1.2.3-beta.1", "~1.2.3-alpha", true],
    ["1.2.3-beta.1", "1.2.3-alpha - 2.0.0", true],
    ["1.2.3-beta.1", ">=1.2.3-alpha <1.2.3", true],
    ["1.2.3", ">=1.2.3-alpha", true],
    ["2.0.0-beta.1", "^1.0.0 || ^2.0.0", false],
    ["2.0.0-beta.1", "^1.0.0 || ^2.0.0-alpha", true],
  ];
  it.each(cases)("%j satisfies %j -> %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  const included: [string, string, boolean][] = [
    ["2.0.0-beta.1", "^1.0.0", false],
    ["1.2.3-beta.1", "^1.0.0", true],
    ["1.0.0-beta.1", "*", true],
    ["1.0.0-beta.1", "1.x", true],
    ["1.2.3-beta.1", "^1.2.3", false],
    ["1.2.4-beta.1", "^1.2.3", true],
    ["1.2.3-beta.1", "1.2.3 - 2.3.4", true],
    ["2.3.4-beta.1", "1.2.3 - 2.3.4", true],
    ["1.0.0-beta.1", ">=1", true],
    ["1.0.0-beta.1", ">=1.0.0", false],
  ];
  it.each(included)("includePrerelease: %j satisfies %j -> %s", (version, range, expected) => {
    expect(satisfies(version, range, true)).toBe(expected);
  });
});

describe("validRange", () => {
  const valid = [
    "",
    "*",
    "x",
    "1",
    "1.2",
    "1.2.3",
    "=1.2.3",
    "v1.2.3",
    "^1.2.3",
    "~1.2.3",
    "~>1.2.3",
    ">=1.2.3 <2.0.0",
    "1.2.3 - 2.3.4",
    "1.2 - 2.3",
    "^1.0.0 || ^2.0.0",
    ">= 1.2.3",
    "1.2.3-beta.1",
    "^0.0.x",
  ];
  it.each(valid)("accepts %j", (range) => {
    expect(validRange(range)).toBe(true);
  });

  const invalid = [
    "not-a-range",
    "blerg",
    "^^1.2.3",
    "^>1.2.3",
    ">=",
    "-",
    "1.2.3 -",
    "- 1.2.3",
    "1.2.3.4",
    "01.2.3",
    "1.2.03",
    "*.1.2",
    "1.x.2",
    "x.x.3",
    "x.2.3",
    "*.*.3",
    "1.2.3-beta_1",
    "<>1.2.3",
  ];
  it.each(invalid)("rejects %j", (range) => {
    expect(validRange(range)).toBe(false);
  });
});

describe("intersect", () => {
  const versions = ["1.0.0", "1.5.0", "2.0.0", "2.5.0", "3.0.0"];

  it.each([
    [[">=1.0.0 <2.1.0", ">=1.0.0"], "2.0.0"],
    [["^1 || ^2", "^2 || ^3"], "2.5.0"],
    [["1.0.0 - 2.0.0", ">=1.5.0"], "2.0.0"],
    [[">=1.0.0", "<=1.0.0"], "1.0.0"],
    [["*", "~1.5.0"], "1.5.0"],
  ] as [string[], string][])("%j -> %s", (list, expected) => {
    const range = intersect(list);
    expect(range).toBeDefined();
    expect(maxSatisfying(versions, range!)).toBe(expected);
  });

  it("drops the branches that exclude each other", () => {
    expect(intersect(["^1 || ^2", "^2 || ^3"])).toBe("^2 ^2");
  });

  it("gives nothing when no version meets them all, or one is not a range", () => {
    expect(intersect(["^1", "^2"])).toBeUndefined();
    expect(intersect([">1.0.0", "<=1.0.0"])).toBeUndefined();
    expect(intersect(["^1", "latest"])).toBeUndefined();
  });
});

describe("maxSatisfying", () => {
  const versions = [
    "0.9.0",
    "1.0.0",
    "1.2.0",
    "1.2.3",
    "1.3.0-rc.1",
    "1.3.0",
    "2.0.0-beta.1",
    "2.0.0",
  ];

  it.each([
    ["^1.0.0", "1.3.0"],
    ["~1.2.0", "1.2.3"],
    ["<1.3.0", "1.2.3"],
    ["*", "2.0.0"],
    ["1.x", "1.3.0"],
    ["0.9.0 - 1.2.3", "1.2.3"],
    ["^3.0.0", undefined],
    ["garbage", undefined],
  ] as [string, string | undefined][])("%j -> %s", (range, expected) => {
    expect(maxSatisfying(versions, range)).toBe(expected);
  });

  it("honours includePrerelease", () => {
    expect(maxSatisfying(versions, "^1.0.0", true)).toBe("1.3.0");
    expect(maxSatisfying(["1.3.0-rc.1", "1.2.0"], "^1.0.0", true)).toBe("1.3.0-rc.1");
    expect(maxSatisfying(["1.3.0-rc.1", "1.2.0"], "^1.0.0")).toBe("1.2.0");
  });

  it("skips unparseable entries and returns the original string", () => {
    expect(maxSatisfying(["1.0.0", "oops", "v1.1.0"], "^1.0.0")).toBe("v1.1.0");
    expect(maxSatisfying([], "*")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { findImports, globalName, looksLikeESM, mask } from "./scan.ts";

const specifiers = (code: string) =>
  findImports(code).map(({ specifier, dynamic }) => (dynamic ? `(${specifier})` : specifier));

describe("findImports", () => {
  it("finds static, re-exported and dynamic imports, minified too", () => {
    const code = [
      `import a from "./a.js";`,
      `import * as b from './b.js'`,
      `import c, { d as e,\n  f } from "c"`,
      `import "side-effect";`,
      `export * from "./re.js"; export { g } from "@scope/g/sub";`,
      `import{h}from"./h.js";export*from"./i.js"`,
      `const j = await import("./lazy.js");`,
      `import data from "./x.json" with { type: "json" };`,
    ].join("\n");
    expect(specifiers(code)).toEqual([
      "./a.js",
      "./b.js",
      "c",
      "side-effect",
      "./re.js",
      "@scope/g/sub",
      "./h.js",
      "./i.js",
      "(./lazy.js)",
      "./x.json",
    ]);
  });

  it("gives offsets that cut the specifier out of the code", () => {
    const code = `import x from "yaml";\nimport("./y.js")`;
    for (const { start, end, specifier } of findImports(code)) {
      expect(code.slice(start, end)).toBe(specifier);
    }
  });

  it("passes over imports in comments, strings, templates and regexes", () => {
    const code = [
      `// import a from "a"`,
      `/* export * as default from "b" */`,
      `/** @example import { c } from 'c' */`,
      `throw new Error("'import' and 'export' may only appear at the top level");`,
      'const t = `import x from "d"`;',
      `const r = /import x from "e"/;`,
      `x.import("f"); const notImport = 1; foo.export;`,
      `import real from "./real.js"; // import "g"`,
    ].join("\n");
    expect(specifiers(code)).toEqual(["./real.js"]);
  });

  it("tells a regex from a division", () => {
    expect(specifiers(`const a = b / 2; import "x"; c = d / 3`)).toEqual(["x"]);
    expect(specifiers(`return /"/.test(s)\nimport "y"`)).toEqual(["y"]);
    expect(specifiers(`const u = "https://example.com"; import "z"`)).toEqual(["z"]);
  });
});

describe("mask", () => {
  it("keeps the length, the lines and the quotes", () => {
    const code = `a("x // y") // c\n/* d\ne */ 'f'`;
    const masked = mask(code);
    expect(masked).toHaveLength(code.length);
    expect(masked).toBe(`a("      ")     \n    \n     ' '`);
  });
});

describe("looksLikeESM", () => {
  it("sees import and export statements, not CommonJS", () => {
    expect(looksLikeESM(`import x from "x"`)).toBe(true);
    expect(looksLikeESM(`const a = 1;\nexport { a }`)).toBe(true);
    expect(looksLikeESM(`export default 1`)).toBe(true);
    expect(looksLikeESM(`exports.a = 1; module.exports = require("x")`)).toBe(false);
    expect(looksLikeESM(`importScripts("x"); const m = import("./m.js")`)).toBe(false);
    expect(looksLikeESM(`// export default 1\nmodule.exports = 1`)).toBe(false);
  });
});

describe("globalName", () => {
  it("camel-cases a package's name", () => {
    expect(globalName("yaml")).toBe("yaml");
    expect(globalName("lodash-es")).toBe("lodashEs");
    expect(globalName("@vue/shared")).toBe("vueShared");
    expect(globalName("lodash.get")).toBe("lodashGet");
    expect(globalName("7zip")).toBe("_7zip");
    expect(globalName("delete")).toBeUndefined();
  });
});

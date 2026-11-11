// Reading JavaScript without a parser, for ./modules.ts, and a package's name as a global's for
// ./globals.ts. No imports, so it is tested on its own.

/** Each import `code` makes with a string: static, `export … from`, and `import("…")`. */
export function findImports(
  code: string,
): { start: number; end: number; specifier: string; dynamic: boolean }[] {
  const masked = mask(code);
  const found = [];
  for (const [pattern, dynamic] of [
    [STATIC, false],
    [DYNAMIC, true],
  ] as const) {
    for (const match of masked.matchAll(pattern)) {
      const end = match.index + match[0].length - 1;
      const start = end - match[2]!.length;
      found.push({ start, end, specifier: code.slice(start, end), dynamic });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

// `import x from "y"`, `import "y"`, `export * from "y"`, `import{a as b}from"y"`.
const STATIC = /(?<![\w$.])(?:import|export)\s*(?:[\w$\s{},*]*?\bfrom\s*)?(["'])([^"'\n]*)\1/g;
const DYNAMIC = /(?<![\w$.])import\s*\(\s*(["'])([^"'\n]*)\1/g;
const ESM =
  /(?:^|[;}\n])\s*(?:import\s*[{*"']|import\s+[\w$]|export\s*[{*]|export\s+(?:default|const|let|var|function|class|async)\b)/;

/** Whether `code` has an `import` or `export` statement, outside comments and strings. */
export const looksLikeESM = (code: string): boolean => ESM.test(mask(code));

// After one of these, or of the words, a `/` starts a regex, not a division.
const BEFORE_REGEX = new Set("(,=:[!&|?{};+-*%<>~^");
const WORDS = new Set(
  "return typeof case do else in of void yield await delete new throw instanceof".split(" "),
);
const WORD = /[\w$]+/y;
const blank = (text: string) => text.replace(/[^\n]/g, " ");

/**
 * `code` with its comments, and what its strings, templates and regexes hold, as spaces: the
 * same length, so offsets still match, and an `import` in a string is not taken for one. A `/`
 * is taken for a regex where a tokenizer would guess one.
 */
export function mask(code: string): string {
  let out = "";
  let from = 0;
  let prev = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (c === "/" && (next === "/" || next === "*")) {
      let stop = next === "/" ? code.indexOf("\n", i) : code.indexOf("*/", i + 2) + 2;
      if (stop < (next === "/" ? 0 : 2)) stop = code.length;
      out += code.slice(from, i) + blank(code.slice(i, stop));
      i = from = stop;
    } else if (
      c === '"' ||
      c === "'" ||
      c === "`" ||
      (c === "/" && (prev === "" || BEFORE_REGEX.has(prev) || WORDS.has(prev)))
    ) {
      const stop = skip(code, i, c);
      // The closing quote stays, when there is one.
      const inner = stop - 1 > i && code[stop - 1] === c ? stop - 1 : stop;
      out += code.slice(from, i + 1) + blank(code.slice(i + 1, inner));
      from = inner;
      i = stop;
      prev = c;
    } else if (/[\w$]/.test(c)) {
      WORD.lastIndex = i;
      prev = WORD.exec(code)![0];
      i += prev.length;
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out + code.slice(from);
}

/** Past the string, template or regex that starts at `i`; a quote or regex ends at a line's end. */
function skip(code: string, i: number, quote: string): number {
  let inClass = false;
  for (let j = i + 1; j < code.length; j++) {
    const c = code[j];
    if (c === "\\") j++;
    else if (c === "\n" && quote !== "`") return j;
    else if (quote === "/" && c === "[") inClass = true;
    else if (quote === "/" && c === "]") inClass = false;
    else if (c === quote && !inClass) return j + 1;
  }
  return code.length;
}

/**
 * A global's name for a package: `lodash-es` is `lodashEs`, `@vue/shared` is `vueShared`.
 * Undefined when no name can be made, as for a name that is a reserved word.
 */
export function globalName(name: string): string | undefined {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const id = words
    .map((word, i) => (i === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join("");
  const named = /^\d/.test(id) ? `_${id}` : id;
  return named && !RESERVED.has(named) ? named : undefined;
}

const RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return static super switch this throw true try typeof var void while with yield await".split(
    " ",
  ),
);

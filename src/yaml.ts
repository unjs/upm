// The YAML pnpm writes: block maps, block lists, flow `{}` and `[]`, quoted and plain scalars.
// Nothing else appears in its lockfile. Loaded only by what reads one of pnpm's files.

export function yaml(text: string): unknown {
  const lines = text.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  const indentOf = (l: string) => l.length - l.trimStart().length;
  let i = 0;
  function block(indent: number): unknown {
    if (lines[i]?.trim().startsWith("- ")) {
      const out: unknown[] = [];
      while (
        i < lines.length &&
        indentOf(lines[i]!) === indent &&
        lines[i]!.trim().startsWith("- ")
      ) {
        out.push(scalar(lines[i++]!.trim().slice(2)));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    while (i < lines.length && indentOf(lines[i]!) === indent) {
      const line = lines[i++]!.trim();
      const colon = keyEnd(line);
      const key = unquote(line.slice(0, colon));
      const rest = line.slice(colon + 1).trim();
      const next = lines[i];
      if (rest !== "") out[key] = scalar(rest);
      else out[key] = next !== undefined && indentOf(next) > indent ? block(indentOf(next)) : {};
    }
    return out;
  }
  return block(indentOf(lines[0] ?? ""));
}

/**
 * Index of the `:` that ends a key. A quoted key ends at its quote; a plain one may hold colons
 * of its own (`name@file:path:`), so it ends at the first `: ` or a trailing `:`.
 */
function keyEnd(line: string): number {
  const quote = line[0];
  if (quote === '"' || quote === "'") {
    for (let j = 1; j < line.length; j++) {
      if (line[j] === "\\") j++;
      else if (line[j] === quote && line[j + 1] === ":") return j + 1;
    }
  }
  const sep = line.indexOf(": ");
  if (sep >= 0) return sep;
  return line.endsWith(":") ? line.length - 1 : line.indexOf(":");
}

function scalar(text: string): unknown {
  const v = text.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("{") && v.endsWith("}")) {
    const out: Record<string, unknown> = {};
    for (const part of splitFlow(v.slice(1, -1))) {
      const item = part.trim();
      const colon = keyEnd(item);
      out[unquote(item.slice(0, colon))] = scalar(item.slice(colon + 1));
    }
    return out;
  }
  if (v.startsWith("[") && v.endsWith("]")) return splitFlow(v.slice(1, -1)).map((p) => unquote(p));
  return unquote(v);
}

/** Split a flow collection's body on the commas at its own level. */
function splitFlow(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let j = 0; j < text.length; j++) {
    const ch = text[j]!;
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, j));
      start = j + 1;
    }
  }
  if (text.slice(start).trim()) out.push(text.slice(start));
  return out;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replaceAll("''", "'");
  }
  return v;
}

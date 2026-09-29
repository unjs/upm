// A bin on Windows, as npm and pnpm write one with `cmd-shim`. A symlink needs a privilege
// there, and cmd.exe and PowerShell find a command only by its extension, so a bin is three
// small scripts: `<name>.cmd` for cmd, `<name>.ps1` for PowerShell and `<name>` for Git Bash
// and Cygwin. Each runs the program the target's `#!` line names, on the target's path from
// `.bin`, so the tree still works when moved. Loaded on Windows alone: nothing else pays for it.
import { builtin } from "./builtin.ts";
import { pid } from "./runtime.ts";
import { replaceFile } from "./util.ts";

/** `#!/usr/bin/env node`, `#!/usr/bin/env -S node --flag`, `#!/bin/sh -e`. Env settings are dropped. */
const SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?(?:[^\s=]+=[^\s=]+\s+)*)?(\S+)(.*)$/;

/**
 * The shims for a bin whose file is `target`, spelled from `.bin`, and starts with `head`
 * (undefined when it cannot be read): each file's suffix and text.
 */
export function shimsOf(target: string, head: string | undefined): [string, string][] {
  const path = target.replaceAll("\\", "/");
  // A lockfile can name the target, and a shim is a script: what its quotes cannot hold would run.
  if (/["%$`!\p{Cc}]/u.test(path)) {
    const message = `refusing to shim a bin at ${JSON.stringify(target)}: it cannot be quoted`;
    throw Object.assign(new Error(message), { code: "EBIN" });
  }
  const program = programOf(path, head);
  const run = program && [`"${program[0]}"`, program[1]].filter(Boolean).join(" ");
  const cmdPath = `"%dp0%\\${path.replaceAll("/", "\\")}"`;
  const cmd = [
    "@ECHO off",
    "GOTO start",
    // %~dp0 read in a subroutine: in the main body it can be wrong when the shim was called
    // quoted from another directory.
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    run
      ? // The failed goto ends the batch before the program runs, so Ctrl+C asks no
        // "Terminate batch job?"; without `.JS` in PATHEXT, a `node.js` in the cwd is not node.
        "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & " +
        `set PATHEXT=%PATHEXT:;.JS;=;% & ${run} ${cmdPath} %*`
      : `${cmdPath} %*`,
    "",
  ].join("\r\n");
  const sh = [
    "#!/bin/sh",
    `basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")`,
    'basedir_win="$basedir"',
    // A Windows program needs a Windows path for its script; Cygwin will not convert one.
    "case `uname` in",
    "  *CYGWIN*|*MINGW*|*MSYS*)",
    "    if command -v cygpath > /dev/null 2>&1; then",
    '      basedir_win=`cygpath -w "$basedir"`',
    "    fi",
    "  ;;",
    "esac",
    run ? `exec ${run} "$basedir_win/${path}" "$@"` : `exec "$basedir/${path}" "$@"`,
    "",
  ].join("\n");
  // `node.exe`, not `node`: PowerShell would take a `node.ps1` or `node.cmd` on PATH first.
  const ps1Run = program && [`"${program[0]}$exe"`, program[1]].filter(Boolean).join(" ");
  const ps1Line = `${ps1Run ? `& ${ps1Run}` : "&"} "$basedir/${path}" $args`;
  const ps1 = [
    "#!/usr/bin/env pwsh",
    "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
    '$exe=""',
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
    '  $exe=".exe"',
    "}",
    // Pipeline input goes on to the program.
    "if ($MyInvocation.ExpectingInput) {",
    `  $input | ${ps1Line}`,
    "} else {",
    `  ${ps1Line}`,
    "}",
    "exit $LASTEXITCODE",
    "",
  ].join("\n");
  return [
    ["", sh],
    [".cmd", cmd],
    [".ps1", ps1],
  ];
}

/**
 * The program and its arguments: the `#!` line's, the program by its name alone, as `/usr/bin/node`
 * is `node` on PATH. Without one, a script is node's by its extension, as pnpm has it, so a
 * workspace bin not built yet still gets the right shim. Anything else runs itself.
 */
function programOf(path: string, head: string | undefined): [string, string] | undefined {
  const line = head?.trimStart().split(/\r*\n/, 1)[0] ?? "";
  const found = SHEBANG.exec(line);
  if (found) return [found[1]!.slice(found[1]!.lastIndexOf("/") + 1), found[2]!.trim()];
  return /\.[cm]?js$/i.test(path) ? ["node", ""] : undefined;
}

/** Whether each bin's shims in `dir` say what `shims` does. */
export async function shimsStand(
  dir: string,
  shims: Map<string, [string, string][]>,
): Promise<boolean> {
  for (const [name, files] of shims) {
    for (const [suffix, text] of files) {
      if ((await readText(builtin.path.join(dir, name + suffix))) !== text) return false;
    }
  }
  return true;
}

/**
 * Write each bin's shims in `dir`, each file unless it already says the same. `fresh`: under a
 * temp dir or a `node_modules` made just now, so nothing is there. Otherwise never written in
 * place: a link there — an older upm's bin — would carry the write into the store it leads to,
 * so a temp file is renamed in.
 */
export async function placeShims(
  dir: string,
  shims: Map<string, [string, string][]>,
  fresh: boolean,
): Promise<void> {
  const { rm, writeFile } = builtin.fsp;
  for (const [name, files] of shims) {
    for (const [suffix, text] of files) {
      const file = builtin.path.join(dir, name + suffix);
      if (fresh) await writeFile(file, text);
      else if ((await readText(file)) !== text) {
        // A dot name, so a sweep of `.bin` by a concurrent install leaves it alone.
        const temp = builtin.path.join(
          dir,
          `.${name}${suffix}.tmp-${pid}-${globalThis.crypto.randomUUID().slice(0, 8)}`,
        );
        await writeFile(temp, text);
        await replaceFile(temp, file).catch(async (error: unknown) => {
          await rm(temp, { force: true });
          const message = `cannot write ${file}: ${(error as Error)?.message ?? error}`;
          throw Object.assign(new Error(message), { code: "ELINK" });
        });
      }
    }
  }
}

/** A file's first bytes, enough for a `#!` line; undefined when it cannot be read. */
export async function readHead(file: string): Promise<string | undefined> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await builtin.fsp.open(file, "r");
    const { buffer, bytesRead } = await handle.read(new Uint8Array(1024), 0, 1024, 0);
    return new TextDecoder().decode(buffer.subarray(0, bytesRead));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readText(file: string): Promise<string | undefined> {
  return await builtin.fsp.readFile(file, "utf8").catch(() => undefined);
}

/**
 * Whether cmd.exe runs `word` as a batch file, a bin's `.cmd` shim, whose `%*` reads the
 * arguments a second time. It looks in `cwd`, then along PATH, and tries each PATHEXT
 * extension unless the name already has one: the first file found is what runs.
 */
export function isBatch(
  word: string,
  cwd: string,
  env: Record<string, string | undefined>,
): boolean {
  const { delimiter, extname, resolve } = builtin.path;
  const pathext = env[envKey(env, "PATHEXT")] ?? ".COM;.EXE;.BAT;.CMD";
  const exts = pathext.toLowerCase().split(";").filter(Boolean);
  const names = exts.includes(extname(word).toLowerCase()) ? [word] : exts.map((e) => word + e);
  const path = env[envKey(env, "PATH")] ?? "";
  const dirs = /[\\/]/.test(word) ? [cwd] : [cwd, ...path.split(delimiter).filter(Boolean)];
  for (const dir of dirs) {
    for (const name of names) {
      if (isFile(resolve(dir, name))) return /\.(?:bat|cmd)$/i.test(name);
    }
  }
  return false;
}

/** The first word of a command line, unquoted: what the shell will run. */
export function firstWord(line: string): string {
  return (/^\s*((?:"[^"]*"|[^\s"])+)/.exec(line)?.[1] ?? "").replaceAll('"', "");
}

/** A variable as `env` spells it: Windows spells PATH `Path`. */
function envKey(env: Record<string, string | undefined>, name: string): string {
  return Object.keys(env).find((key) => key.toUpperCase() === name) ?? name;
}

function isFile(path: string): boolean {
  try {
    return builtin.fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

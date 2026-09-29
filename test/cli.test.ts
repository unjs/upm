import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgv } from "../src/cli.ts";
import type { Cli } from "../src/cli.ts";
import { hashOf } from "./hash.ts";
import { makeTarball } from "./tarball.ts";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/upm.ts", import.meta.url));
const ENTRY = fileURLToPath(new URL("../upm", import.meta.url));

describe("parseArgv", () => {
  it("reads a command and its specs", () => {
    expect(parseArgv(["resolve", "vue@^3", "nanoid"])).toEqual({
      command: "resolve",
      specs: ["vue@^3", "nanoid"],
      json: false,
      help: false,
    });
  });

  it("reads i as install", () => {
    expect(parseArgv(["i", "--frozen-lockfile"])).toMatchObject({
      command: "install",
      frozen: true,
    });
    expect(parseArgv(["i", "--offline"])).toMatchObject({ command: "install", offline: true });
    expect(parseArgv(["add", "x", "--prefer-offline"]).preferOffline).toBe(true);
    expect(parseArgv(["i", "vue"])).toMatchObject({ command: "install", specs: ["vue"] });
  });

  it("reads flags in any position", () => {
    const cli = parseArgv(["--json", "resolve", "--registry", "https://r.test", "vue"]);
    expect(cli).toMatchObject({
      command: "resolve",
      specs: ["vue"],
      json: true,
      registry: "https://r.test",
    });
  });

  it("accepts --registry=<url>", () => {
    expect(parseArgv(["--registry=https://r.test"]).registry).toBe("https://r.test");
  });

  it("reports a missing --registry value", () => {
    expect(parseArgv(["resolve", "vue", "--registry"]).error).toBeTruthy();
  });

  it("reads --min-release-age as days, and refuses what is not", () => {
    expect(parseArgv(["i", "--min-release-age", "3"]).minReleaseAge).toBe(3);
    expect(parseArgv(["i", "--min-release-age=0"]).minReleaseAge).toBe(0);
    for (const bad of ["--min-release-age=", "--min-release-age=x", "--min-release-age=-1"]) {
      expect(parseArgv(["i", bad]).error).toBe("--min-release-age takes a number of days");
    }
    expect(parseArgv(["i", "--min-release-age"]).error).toBeTruthy();
  });

  it("reports an unknown flag", () => {
    expect(parseArgv(["resolve", "--nope"]).error).toBe('unknown flag "--nope"');
  });

  it("does not read a package named like an Object method as a flag", () => {
    expect(parseArgv(["add", "constructor", "--dir", "/x"])).toMatchObject({
      command: "add",
      specs: ["constructor"],
      dir: "/x",
    });
    expect(parseArgv(["remove", "__proto__"]).specs).toEqual(["__proto__"]);
  });

  it("hands run everything after the script name, less a first --", () => {
    expect(parseArgv(["run", "--dir", "/x", "test", "--watch", "--dir", "y"])).toMatchObject({
      command: "run",
      specs: ["test", "--watch", "--dir", "y"],
      dir: "/x",
    });
    expect(parseArgv(["run", "test", "--", "--watch", "--"]).specs).toEqual([
      "test",
      "--watch",
      "--",
    ]);
    expect(parseArgv(["run", "--json"])).toMatchObject({ command: "run", specs: [], json: true });
  });

  it("reads a first word that is not a command as run, and nothing after it", () => {
    expect(parseArgv(["--dir", "/x", "test", "--watch", "--dir", "y"])).toMatchObject({
      command: "run",
      implied: true,
      specs: ["test", "--watch", "--dir", "y"],
      dir: "/x",
    });
    expect(parseArgv(["test", "--", "--watch"]).specs).toEqual(["test", "--watch"]);
  });

  it("stops reading flags at --", () => {
    expect(parseArgv(["run", "--", "-x", "--dir", "y"])).toMatchObject({
      command: "run",
      specs: ["-x", "--dir", "y"],
    });
    expect(parseArgv(["--", "-x"])).toMatchObject({ command: "run", implied: true, specs: ["-x"] });
    expect(parseArgv(["run", "--"])).toMatchObject({ command: "run", specs: [] });
    expect(parseArgv(["run", "a", "--", "--", "b"]).specs).toEqual(["a", "--", "b"]);
  });

  it("hands exec everything after the command, -- included, and collects every -p", () => {
    expect(
      parseArgv(["exec", "-p", "a", "--package=b@1", "--dir", "/x", "tsc", "--", "--dir", "y"]),
    ).toMatchObject({
      command: "exec",
      packages: ["a", "b@1"],
      specs: ["tsc", "--", "--dir", "y"],
      dir: "/x",
    });
    expect(parseArgv(["exec", "--", "-x", "--"]).specs).toEqual(["-x", "--"]);
    expect(parseArgv(["exec", "-p"]).error).toBe("-p needs a value");
    expect(parseArgv(["exec", "-p", "a", "-c", "x && y"])).toMatchObject({
      command: "exec",
      packages: ["a"],
      call: "x && y",
      specs: [],
    });
    expect(parseArgv(["exec", "--call=x"]).call).toBe("x");
    expect(parseArgv(["exec", "-c"]).error).toBe("-c needs a value");
  });

  it("hands npm's commands every word after the name", () => {
    expect(parseArgv(["--dir", "/x", "publish", "--tag", "next", "--", "--dir"])).toMatchObject({
      command: "publish",
      specs: ["--tag", "next", "--", "--dir"],
      dir: "/x",
    });
    expect(parseArgv(["run", "version"])).toMatchObject({ command: "run", specs: ["version"] });
    expect(parseArgv(["add", "pack"])).toMatchObject({ command: "add", specs: ["pack"] });
  });

  it("treats -h and --help as help", () => {
    expect(parseArgv(["--help"]).help).toBe(true);
    expect(parseArgv(["-h"]).help).toBe(true);
  });

  it("collects every -w, and reads the other workspace flags", () => {
    expect(
      parseArgv(["run", "-w", "a", "-w=packages/b", "--workspace", "c", "--if-present", "build"]),
    ).toMatchObject({
      command: "run",
      workspace: ["a", "packages/b", "c"],
      ifPresent: true,
      specs: ["build"],
    });
    expect(parseArgv(["run", "--workspaces", "--include-workspace-root"])).toMatchObject({
      workspaces: true,
      includeRoot: true,
    });
    expect(parseArgv(["add", "x", "-w"]).error).toBe("-w needs a value");
  });
});

describe("npm's spellings", () => {
  it("reads npm's command names", () => {
    expect(parseArgv(["ci"])).toMatchObject({ command: "install", frozen: true });
    expect(parseArgv(["clean-install"])).toMatchObject({ command: "install", frozen: true });
    for (const name of ["uninstall", "rm", "r", "un"]) {
      expect(parseArgv([name, "vue"])).toMatchObject({ command: "remove", specs: ["vue"] });
    }
    expect(parseArgv(["run-script", "build", "-x"])).toMatchObject({
      command: "run",
      specs: ["build", "-x"],
    });
    expect(parseArgv(["t", "--watch"])).toMatchObject({
      command: "run",
      specs: ["test", "--watch"],
    });
    expect(parseArgv(["tst"])).toMatchObject({ command: "run", specs: ["test"] });
    expect(parseArgv(["tst"]).implied).toBeUndefined();
  });

  it("reads npm's save flags as upm's", () => {
    expect(parseArgv(["add", "x", "--save-dev", "--save-exact"])).toMatchObject({
      dev: true,
      exact: true,
    });
    expect(parseArgv(["add", "x", "--save-optional"]).optional).toBe(true);
  });

  it("reads --omit=dev as --production, and --include=dev over it in any order", () => {
    expect(parseArgv(["ci", "--omit=dev"]).production).toBe(true);
    expect(parseArgv(["ci", "--omit", "dev"]).production).toBe(true);
    expect(parseArgv(["ci", "--include=dev", "--omit=dev"]).production).toBeUndefined();
    expect(parseArgv(["ci", "--production", "--include", "dev"]).production).toBeUndefined();
    expect(parseArgv(["ci", "--include=optional"]).error).toBeUndefined();
    expect(parseArgv(["ci", "--omit=optional"]).error).toBe("--omit takes dev");
    expect(parseArgv(["ci", "--omit"]).error).toBe("--omit takes dev");
    expect(parseArgv(["ci", "--include=all"]).error).toBe(
      "--include takes dev, prod, optional or peer",
    );
  });

  it("reads --prefix and -C as --dir", () => {
    expect(parseArgv(["--prefix", "/x", "ci"]).dir).toBe("/x");
    expect(parseArgv(["-C", "/x", "ci"]).dir).toBe("/x");
    expect(parseArgv(["ci", "--prefix=/y"]).dir).toBe("/y");
  });

  it("reads --before as a date and every --min-release-age-exclude", () => {
    expect(parseArgv(["ci", "--before", "2024-01-02"]).before).toBe("2024-01-02");
    expect(parseArgv(["ci", "--before=someday"]).error).toBe("--before takes a date");
    expect(parseArgv(["ci", "--before"]).error).toBe("--before takes a date");
    const cli = parseArgv([
      "ci",
      "--min-release-age-exclude",
      "a",
      "--min-release-age-exclude=@b/*",
    ]);
    expect(cli.minReleaseAgeExclude).toEqual(["a", "@b/*"]);
  });

  it("accepts npm's flags for what upm already does, and nothing else", () => {
    const noops = ["--ignore-scripts", "--no-audit", "--no-fund"];
    noops.push("--legacy-peer-deps", "--force", "-S", "--save", "-P");
    noops.push("--save-prod");
    expect(parseArgv(["add", "x", ...noops])).toEqual({
      command: "add",
      specs: ["x"],
      json: false,
      help: false,
    });
    expect(parseArgv(["ci", "--no-save"]).error).toBe('unknown flag "--no-save"');
    expect(parseArgv(["ci", "--no-progress"]).noProgress).toBe(true);
  });

  it("turns one field on for each switch, spelled exactly", () => {
    const switches: Record<string, keyof Cli> = {
      "-y": "yes",
      "--yes": "yes",
      "--workspaces": "workspaces",
      "--include-workspace-root": "includeRoot",
      "--if-present": "ifPresent",
      "-h": "help",
      "--json": "json",
      "--production": "production",
      "--lock": "lock",
      "--offline": "offline",
      "--prefer-offline": "preferOffline",
      "--frozen-lockfile": "frozen",
      "--verify": "verify",
      "--dev": "dev",
      "-D": "dev",
      "-O": "optional",
      "--optional": "optional",
      "--exact": "exact",
      "-E": "exact",
    };
    for (const [flag, field] of Object.entries(switches)) {
      const cli = parseArgv(["add", "x", flag]);
      expect(cli[field]).toBe(true);
      expect(cli.specs).toEqual(["x"]);
      expect(parseArgv(["add", "x", `${flag}=true`]).error).toBe(`unknown flag "${flag}=true"`);
    }
    expect(parseArgv(["add", "toString"]).specs).toEqual(["toString"]);
  });

  it("reads -s, -q and a low --loglevel as quiet", () => {
    for (const flag of ["-s", "--silent", "-q", "--quiet", "--loglevel=warn"]) {
      expect(parseArgv(["ci", flag]).quiet).toBe(true);
    }
    expect(parseArgv(["ci", "--loglevel", "error"]).quiet).toBe(true);
    expect(parseArgv(["ci", "--loglevel", "verbose"]).quiet).toBeUndefined();
    expect(parseArgv(["ci", "--loglevel", "loud"]).error).toMatch(/^--loglevel takes silent/);
    // After the script name, as ever, it is the script's.
    expect(parseArgv(["run", "build", "-s"])).toMatchObject({ specs: ["build", "-s"] });
  });
});

describe("cli process", () => {
  it("prints usage and exits 0 with no args", async () => {
    const { stdout } = await run(process.execPath, [CLI]);
    expect(stdout).toContain("upm resolve <spec>...");
  });

  it("exits 2 on a word that is neither a command nor a script", async () => {
    // realpath: macOS tmpdir is a symlink, and the error names the resolved path.
    const dir = await realpath(await mkdtemp(join(tmpdir(), "upm-cli-")));
    try {
      const nope = () =>
        run(process.execPath, [CLI, "nope"], { cwd: dir }).catch(
          (e: { code: number; stderr: string }) => e,
        );
      const bare = await nope();
      expect(bare).toMatchObject({ code: 2 });
      expect(bare.stderr).toContain(`unknown command "nope"\n`);

      // A --dir that was typed is the news, not the word.
      const missing = await run(process.execPath, [CLI, "--dir", join(dir, "x"), "nope"]).catch(
        (e: { code: number; stderr: string }) => e,
      );
      expect(missing).toMatchObject({ code: 1 });
      expect(missing.stderr).toContain(`cannot read ${join(dir, "x", "package.json")}`);

      await writeFile(join(dir, "package.json"), '{ "scripts": { "hi": "echo hi" } }');
      const typo = await nope();
      expect(typo).toMatchObject({ code: 2 });
      expect(typo.stderr).toContain(`unknown command "nope", and no such script in ${dir}`);

      // A package.json that is there but broken is the news, not the command.
      await writeFile(join(dir, "package.json"), "{");
      const broken = await nope();
      expect(broken).toMatchObject({ code: 1 });
      expect(broken.stderr).toContain("is not valid JSON");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs an installed bin for a word that is no script", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "upm-cli-")));
    try {
      // A node bin behind both shims, as upm links one: `sh` runs `hi`, cmd runs `hi.cmd`.
      const bins = join(dir, "node_modules", ".bin");
      await mkdir(join(dir, "node_modules", "hi"), { recursive: true });
      await mkdir(bins);
      await writeFile(
        join(dir, "node_modules", "hi", "cli.js"),
        "console.log(JSON.stringify(process.argv.slice(2)))",
      );
      const sh = '#!/bin/sh\nexec node "$(dirname "$0")/../hi/cli.js" "$@"\n';
      await writeFile(join(bins, "hi"), sh, { mode: 0o755 });
      await writeFile(join(bins, "hi.cmd"), '@"node" "%~dp0..\\hi\\cli.js" %*\r\n');
      const hi = async (...args: string[]) =>
        (await run(process.execPath, [CLI, ...args], { cwd: dir })).stdout;

      // No package.json: the bin is still there to run.
      expect(JSON.parse(await hi("hi", "a b", "x&y"))).toEqual(["a b", "x&y"]);

      // A script of the same name comes first.
      await writeFile(join(dir, "package.json"), '{ "scripts": { "hi": "echo script" } }');
      expect(await hi("-s", "hi")).toMatch(/^script\r?\n$/);

      await writeFile(join(dir, "package.json"), "{}");
      expect(JSON.parse(await hi("hi", "x"))).toEqual(["x"]);

      // `run` names a script, so only the bare word falls back.
      const named = await hi("run", "hi").catch((e: { code: number }) => e);
      expect(named).toMatchObject({ code: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 on an unknown flag", async () => {
    const error = await run(process.execPath, [CLI, "resolve", "--nope"]).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 2 });
    expect(String((error as { stderr: string }).stderr)).toContain("unknown flag");
  });

  it("exits 1 with a one-line error on a bad spec", async () => {
    // An unreachable registry keeps this test off the network.
    const error = await run(process.execPath, [
      CLI,
      "resolve",
      "../evil",
      "--registry",
      "http://127.0.0.1:1",
    ]).catch((e: unknown) => e);
    const stderr = String((error as { stderr: string }).stderr);
    expect(error).toMatchObject({ code: 1 });
    expect(stderr).toContain("EINVALIDSPEC");
    expect(stderr.trim().split("\n")).toHaveLength(1);
  });
});

describe("colors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function help(): Promise<string> {
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += chunk), true));
    vi.resetModules();
    const { main } = await import("../src/cli.ts");
    expect(await main(["--help"])).toBe(0);
    return out;
  }

  it("styles the help where the stream takes color", async () => {
    vi.stubEnv("FORCE_COLOR", "1");
    expect(await help()).toContain("\u001B[1mUsage\u001B[22m");
  });

  it("prints plain text where there is no node:util", async () => {
    vi.stubEnv("FORCE_COLOR", "1");
    const real = process.getBuiltinModule.bind(process);
    vi.spyOn(process, "getBuiltinModule").mockImplementation(((id: string) =>
      id === "node:util" ? undefined : real(id)) as typeof process.getBuiltinModule);
    const out = await help();
    expect(out).toContain("\nUsage\n");
    expect(out).not.toContain("\u001B[");
  });

  it("runs with no process at all, writing to the console", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
    vi.stubGlobal("process", undefined);
    try {
      vi.resetModules();
      const { main } = await import("../src/cli.ts");
      expect(await main(["--help"])).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^upm — a minimal[\s\S]*\nUsage\n/);
    expect(lines[0]).toContain("\nOptions\n");
    expect(lines[0]).toContain("\nExamples\n");
  });
});

describe("install --verify reports unmet peers", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "upm-cli-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** `a` depends on react 17 and peers on ^18, so its own edge undercuts its declared range. */
  const lock = {
    lockfileVersion: 1,
    root: {
      name: "demo",
      version: "1.0.0",
      specs: { dependencies: { a: "^1" } },
      dependencies: { a: "1.0.0" },
    },
    packages: {
      "a@1.0.0": {
        integrity: "sha512-aaa",
        dependencies: { react: "17.0.0" },
        peerDependencies: { react: "^18" },
      },
      "react@17.0.0": { integrity: "sha512-rrr" },
    },
  };

  async function install(...flags: string[]): Promise<string> {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { a: "^1" } }),
    );
    await writeFile(join(dir, "upm.lock"), `${JSON.stringify(lock, undefined, 2)}\n`);
    // The store fill after the check has nowhere to fetch from, so this always exits 1 —
    // what is under test is the line printed before it gets there.
    const result = await run(process.execPath, [
      CLI,
      "install",
      "--frozen-lockfile",
      "--dir",
      dir,
      "--store",
      join(dir, "store"),
      "--registry",
      "http://127.0.0.1:1",
      ...flags,
    ]).catch((e: unknown) => e as { stderr: string });
    return String(result.stderr);
  }

  it("names the consumer and both ranges under --verify", async () => {
    expect(await install("--verify")).toContain(
      "unmet peer — a@1.0.0 needs peer react@^18, and the tree installs react@17.0.0",
    );
  });

  it("says nothing about peers without --verify", async () => {
    expect(await install()).not.toContain("unmet peer");
  });
});

describe("the ./upm entry", () => {
  it("turns the compile cache on and still runs the cli", async () => {
    const { stdout } = await run(process.execPath, [ENTRY, "--help"]);
    expect(stdout).toContain("upm resolve <spec>...");
  });

  // The entry's `await import` keeps the process alive past the write, so a reader that has
  // gone away delivers EPIPE instead of being missed on the way out. `| head` is not a failure.
  it("says nothing when the reader closes the pipe", async () => {
    const child = spawn(process.execPath, [ENTRY, "--help"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  });

  // The write's failure arrives a turn after the write, and the entry exits itself once the
  // output is out: it has to give that turn its say, or a full disk looks like success.
  it.skipIf(process.platform === "win32")("fails when the output cannot be written", async () => {
    const full = await open("/dev/full", "w").catch(() => undefined);
    if (!full) return;
    try {
      const child = spawn(process.execPath, [ENTRY, "--help"], {
        stdio: ["ignore", full.fd, "pipe"],
      });
      let stderr = "";
      child.stderr!.on("data", (chunk) => (stderr += chunk));
      const code = await new Promise((resolve) => child.on("close", resolve));
      expect(code).toBe(1);
      expect(stderr).toContain("ENOSPC");
    } finally {
      await full.close();
    }
  });
});

describe("run", () => {
  let dir: string;
  /** A command line nothing else on the machine has, exactly. */
  const MARKER = `sleep 30.${process.pid}`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "upm-run-"));
    // A bin of its own, so PATH is what finds it — and it reports what it was given.
    const bin = join(dir, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "hello"),
      `#!/bin/sh\necho "hello $@ event=$npm_lifecycle_event name=$npm_package_name"\nexit 3\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { hi: "hello one", pwd: "pwd" } }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const upm = (...args: string[]) =>
    run(process.execPath, [CLI, "run", "--dir", dir, ...args], { cwd: tmpdir() }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );

  it.skipIf(process.platform === "win32")(
    "finds .bin on PATH, passes its arguments, and exits as the script did",
    async () => {
      const result = await upm("hi", "--", "two", "a b");
      expect(result.code).toBe(3);
      expect(result.stdout).toBe("hello one two a b event=hi name=demo\n");
      expect(result.stderr).toBe("> hi\n> hello one two 'a b'\n");
    },
  );

  it.skipIf(process.platform === "win32")("runs from the project directory", async () => {
    const result = await upm("pwd");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(await realpath(dir));
  });

  it.skipIf(process.platform === "win32")("is what a bare script name does", async () => {
    const result = await run(process.execPath, [CLI, "--dir", dir, "hi", "-x", "--dir"], {
      cwd: tmpdir(),
    }).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (error: { code: number; stdout: string }) => error,
    );
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("hello one -x --dir event=hi name=demo\n");
  });

  it.skipIf(process.platform === "win32")("passes a signal on to the script", async () => {
    // `exec`, so the shell is the sleep: what the signal reaches is what has to die. A
    // `sleep` the shell waits on would be left running, as with npm.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { wait: `exec ${MARKER}` } }),
    );
    const child = spawn(process.execPath, [CLI, "--dir", dir, "wait"], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    // The banner means the shell is running; it must not outlive upm.
    await new Promise<void>((resolve) => child.stderr.on("data", () => resolve()));
    const alive = () =>
      run("pgrep", ["-xf", MARKER]).then(
        ({ stdout }) => stdout.trim() !== "",
        () => false,
      );
    const until = async (state: boolean) => {
      for (let i = 0; i < 50 && (await alive()) !== state; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return await alive();
    };
    expect(await until(true)).toBe(true);
    child.kill("SIGTERM");
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).toBe(143);
    expect(await until(false)).toBe(false);
    expect(stderr).toContain("> wait");
  });

  it("lists the scripts without a name", async () => {
    expect(await upm()).toMatchObject({ code: 0, stdout: "hi\n  hello one\npwd\n  pwd\n" });
    expect(JSON.parse((await upm("--json")).stdout)).toEqual({ hi: "hello one", pwd: "pwd" });
  });

  it("passes over a missing script under --if-present", async () => {
    expect(await upm("--if-present", "nope")).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });

  it.skipIf(process.platform === "win32")("prints no banner under -s", async () => {
    const result = await upm("-s", "pwd");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.trim()).toBe(await realpath(dir));
  });

  it("names the scripts there are when one is missing", async () => {
    const result = await upm("nope");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('missing script "nope"');
    expect(result.stderr).toContain("hi, pwd");
  });
});

describe("exec", () => {
  let dir: string;
  let server: Server;
  let registry: string;
  let requests: string[];

  /**
   * `hi` prints what it was run with; `multi` has two bins, neither named after it; `twin` has
   * two names for one file.
   */
  const published: Record<string, { versions: string[]; bin: unknown; files: string[] }> = {
    hi: { versions: ["1.0.0", "1.1.0"], bin: "hi.js", files: ["hi.js"] },
    multi: { versions: ["1.0.0"], bin: { x: "hi.js", y: "y.js" }, files: ["hi.js", "y.js"] },
    twin: { versions: ["1.0.0"], bin: { "twin-a": "hi.js", "twin-b": "hi.js" }, files: ["hi.js"] },
    lib: { versions: ["1.0.0"], bin: undefined, files: [] },
  };
  const script = (name: string, version: string) =>
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({ at: "${name}@${version}", args: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exitCode = Number(process.env.EXIT ?? 0);\n`;
  const tarballs = new Map<string, Uint8Array>();
  for (const [name, { versions, files }] of Object.entries(published)) {
    for (const version of versions) {
      const entries = files.map((path) => ({ path, data: script(name, version), mode: 0o755 }));
      const data = `module.exports = "${name}";\n`;
      const json = JSON.stringify({ name, version, bin: published[name]!.bin });
      tarballs.set(
        `${name}-${version}.tgz`,
        makeTarball([{ path: "package.json", data: json }, { path: "index.js", data }, ...entries]),
      );
    }
  }

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "upm-exec-")));
    requests = [];
    server = createServer(answer);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await mkdir(join(dir, "home"));
    await mkdir(join(dir, "work"));
  });

  /** The registry, at whichever address it was asked on. */
  function answer(request: IncomingMessage, response: ServerResponse): void {
    requests.push(request.url ?? "");
    const [, name, ...rest] = (request.url ?? "").split("/");
    const pkg = published[name ?? ""];
    const tarball = tarballs.get(rest[1] ?? "");
    if (rest[0] === "-" && tarball) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(tarball));
      return;
    }
    if (!pkg || rest.length > 0) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"Not found"}');
      return;
    }
    const manifest = (version: string) => ({
      name,
      version,
      bin: pkg.bin,
      dist: {
        tarball: `http://${request.headers.host}/${name}/-/${name}-${version}.tgz`,
        integrity: hashOf(tarballs.get(`${name}-${version}.tgz`)!),
      },
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: pkg.versions.at(-1) },
        versions: Object.fromEntries(pkg.versions.map((v) => [v, manifest(v)])),
        // Older than min-release-age: no full document is asked for its dates.
        modified: "2020-01-01T00:00:00.000Z",
      }),
    );
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  /** Under a home of its own, and none of this machine's npm config: `npm test` sets some. */
  function upm(
    entry: string,
    args: string[],
    env: Record<string, string> = {},
    flags = ["--dir", join(dir, "work"), "--store", join(dir, "store"), "--registry", registry],
    cwd = tmpdir(),
  ) {
    const home = join(dir, "home");
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^npm_config_|^prefix$/i.test(name)),
    );
    return run(process.execPath, [entry, ...flags, ...args], {
      cwd,
      env: {
        ...clean,
        HOME: home,
        USERPROFILE: home,
        npm_config_globalconfig: join(dir, "no"),
        ...env,
      },
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
  }
  const exec = (...args: string[]) => upm(CLI, ["exec", ...args]);
  const ran = (result: { stdout: string }) => JSON.parse(result.stdout);

  // On Windows the bin is a `.cmd` shim, whose `%*` puts the arguments through cmd twice.
  it("installs a package once per version, then runs its bin with every argument", async () => {
    const args = ["--", "a b", "$X", "--dir", "x&y", "%PATH%", 'say "hi"', "a^b"];
    const first = await exec("hi", ...args);
    expect(first).toMatchObject({ code: 0, stderr: "upm: installed hi@1.1.0\n" });
    expect(ran(first)).toEqual({ at: "hi@1.1.0", args, cwd: join(dir, "work") });
    const installed = await readdir(join(dir, "home", ".upm", "exec"));
    expect(installed).toHaveLength(1);

    // A tag is picked from the document the first run kept: read since the release cutoff,
    // it lacks no version the cutoff lets through. Without a cutoff it is asked for again.
    requests = [];
    const again = await exec("hi");
    expect(again).toMatchObject({ code: 0, stderr: "" });
    expect(requests).toEqual([]);
    const flags = [
      "--dir",
      join(dir, "work"),
      "--store",
      join(dir, "store"),
      "--registry",
      registry,
    ];
    const uncut = await upm(CLI, ["exec", "hi"], { npm_config_min_release_age: "0" }, flags);
    expect(uncut).toMatchObject({ code: 0, stderr: "" });
    expect(requests).toEqual(["/hi"]);
    // A tag written out asks what it points at now.
    requests = [];
    expect(await exec("hi@latest")).toMatchObject({ code: 0, stderr: "" });
    expect(requests).toEqual(["/hi"]);

    // An exact version installed once asks nothing, and the command's exit code is upm's.
    expect(ran(await exec("hi@1.0.0")).at).toBe("hi@1.0.0");
    requests = [];
    const exact = await upm(CLI, ["exec", "hi@1.0.0"], { EXIT: "7" });
    expect(exact.code).toBe(7);
    expect(ran(exact).at).toBe("hi@1.0.0");
    expect(requests).toEqual([]);
    expect(await readdir(join(dir, "home", ".upm", "exec"))).toHaveLength(2);
  });

  it("is what upx does", async () => {
    const upx = fileURLToPath(new URL("../src/upx.ts", import.meta.url));
    expect(ran(await upm(upx, ["hi@1.0.0", "x"]))).toMatchObject({ at: "hi@1.0.0", args: ["x"] });
    const none = await run(process.execPath, [upx]).catch(
      (e: { code: number; stderr: string }) => e,
    );
    expect(none).toMatchObject({ code: 2 });
    expect(none.stderr).toContain("exec needs a command");
  });

  it.skipIf(process.platform === "win32")(
    "runs a bare name already installed above the directory, and asks nothing",
    async () => {
      const bin = join(dir, "node_modules", ".bin");
      await mkdir(join(dir, "work", "node_modules"), { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "hi"), `#!/bin/sh\necho "local $@"\n`, { mode: 0o755 });
      expect(await exec("hi", "x")).toMatchObject({ code: 0, stdout: "local x\n" });
      // A package there by that name runs its own bin.
      const pkg = join(dir, "node_modules", "@s", "tool");
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@s/tool", bin: "t.js" }));
      await writeFile(join(bin, "tool"), `#!/bin/sh\necho "tool $@"\n`, { mode: 0o755 });
      expect(await exec("@s/tool", "y")).toMatchObject({ code: 0, stdout: "tool y\n" });
      expect(requests).toEqual([]);
      // A bin that is no package name is still a bin.
      await writeFile(join(bin, "_hi"), `#!/bin/sh\necho "under $@"\n`, { mode: 0o755 });
      expect(await exec("_hi", "z")).toMatchObject({ code: 0, stdout: "under z\n" });
      expect(requests).toEqual([]);
      // A version is a package to install, whatever is local.
      expect(ran(await exec("hi@1.0.0")).at).toBe("hi@1.0.0");
      // So is a local package of that name with no bin to run.
      await rm(join(bin, "hi"));
      await mkdir(join(dir, "work", "node_modules", "hi"));
      await writeFile(join(dir, "work", "node_modules", "hi", "package.json"), '{"name":"hi"}');
      expect(ran(await exec("-y", "hi")).at).toBe("hi@1.1.0");

      // A range takes a local version that fits it; a tag always asks the registry.
      const hi = join(dir, "work", "node_modules", "hi");
      await writeFile(
        join(hi, "package.json"),
        JSON.stringify({ name: "hi", version: "1.0.0", bin: "hi.js" }),
      );
      await mkdir(join(dir, "work", "node_modules", ".bin"));
      const near = join(dir, "work", "node_modules", ".bin", "hi");
      await writeFile(near, `#!/bin/sh\necho "near $@"\n`, { mode: 0o755 });
      expect(await exec("hi@^1.0.0", "w")).toMatchObject({ code: 0, stdout: "near w\n" });
      expect(ran(await exec("hi@latest")).at).toBe("hi@1.1.0");
      expect(ran(await exec("hi@1.1.0")).at).toBe("hi@1.1.0");

      // The project's own bin comes before all of it, and runs in node when not executable.
      await writeFile(join(dir, "work", "package.json"), JSON.stringify({ bin: { hi: "cli.js" } }));
      await writeFile(join(dir, "work", "cli.js"), "console.log('self', process.argv[2]);\n");
      requests = [];
      expect(await exec("hi", "v")).toMatchObject({ code: 0, stdout: "self v\n" });
      expect(requests).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "installs from the project's registry, once per registry, and never the cwd's dependencies",
    async () => {
      // No --dir: the project is found from cwd, and its dependencies are not exec's.
      const work = join(dir, "work");
      await writeFile(join(work, ".npmrc"), `registry=${registry}/\n`);
      await writeFile(join(work, "package.json"), JSON.stringify({ dependencies: { lib: "1" } }));
      const store = ["--store", join(dir, "store")];
      const first = await upm(CLI, ["exec", "hi@1.0.0"], {}, store, work);
      expect(ran(first)).toMatchObject({ at: "hi@1.0.0", cwd: work });
      expect(requests).toContain("/hi/-/hi-1.0.0.tgz");
      expect(requests.some((url) => url.startsWith("/lib"))).toBe(false);
      const [project] = await readdir(join(dir, "home", ".upm", "exec"));
      const installed = join(dir, "home", ".upm", "exec", project!, "node_modules");
      expect((await readdir(installed)).sort()).toEqual([
        ".bin",
        ".upm",
        ".upm.json",
        ".upm.lock",
        "hi",
      ]);
      expect(await readdir(work)).not.toContain("node_modules");

      // The same versions from another registry are another project, and that registry is asked.
      const other = createServer(answer);
      await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
      try {
        const port = (other.address() as AddressInfo).port;
        requests = [];
        const flags = [...store, "--registry", `http://127.0.0.1:${port}`];
        expect(ran(await upm(CLI, ["exec", "hi@v1.0.0"], {}, flags, work)).at).toBe("hi@1.0.0");
        // Its metadata, that is: the tarball's integrity is one the store already holds.
        expect(requests).toContain("/hi");
        expect(await readdir(join(dir, "home", ".upm", "exec"))).toHaveLength(2);
        // `v1.0.0` and `1.0.0` are one version, so one project.
        requests = [];
        expect(ran(await upm(CLI, ["exec", "hi@1.0.0"], {}, flags, work)).at).toBe("hi@1.0.0");
        expect(requests).toEqual([]);
        expect(await readdir(join(dir, "home", ".upm", "exec"))).toHaveLength(2);
      } finally {
        await new Promise<void>((resolve) => other.close(() => resolve()));
      }
    },
  );

  it("installs under the root's node_modules/.upm/.exec, which its install leaves alone", async () => {
    const work = join(dir, "work");
    const manifest = { workspaces: ["packages/*"], dependencies: { lib: "1" } };
    await writeFile(join(work, "package.json"), JSON.stringify(manifest));
    await mkdir(join(work, "packages", "a"), { recursive: true });
    await writeFile(join(work, "packages", "a", "package.json"), '{"name":"a"}');
    await mkdir(join(work, "node_modules"));
    // No --dir: from inside a workspace, the root is found, and its node_modules is the one.
    const inside = join(work, "packages", "a");
    const flags = ["--store", join(dir, "store"), "--registry", registry];
    const first = await upm(CLI, ["exec", "hi@1.0.0"], {}, flags, inside);
    expect(ran(first)).toMatchObject({ at: "hi@1.0.0", cwd: inside });
    const projects = await readdir(join(work, "node_modules", ".upm", ".exec"));
    expect(projects).toHaveLength(1);
    await expect(readdir(join(dir, "home", ".upm", "exec"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(join(work, "packages", "a"))).toEqual(["package.json"]);

    const install = await upm(CLI, ["install"], {}, ["--dir", work, ...flags]);
    expect(install.code).toBe(0);
    expect(await readdir(join(work, "node_modules", ".upm", ".exec"))).toEqual(projects);
    requests = [];
    expect(ran(await upm(CLI, ["exec", "hi@1.0.0"], {}, flags, inside)).at).toBe("hi@1.0.0");
    expect(requests).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "runs a call line in the shell, with --package bins or only local ones on PATH",
    async () => {
      const both = await upm(CLI, ["exec", "-p", "hi@1.0.0", "-c", 'hi "a b" && echo "$MARK"'], {
        MARK: "marked",
      });
      expect(both.code).toBe(0);
      const [line, mark] = both.stdout.trim().split("\n");
      expect(JSON.parse(line!)).toMatchObject({ at: "hi@1.0.0", args: ["a b"] });
      expect(mark).toBe("marked");

      // Without packages, nothing is installed or asked for: the local bins are on PATH.
      const bin = join(dir, "node_modules", ".bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "near"), `#!/bin/sh\necho "near $@"\n`, { mode: 0o755 });
      requests = [];
      expect(await exec("-c", "near x | tr x y; exit 4")).toMatchObject({
        code: 4,
        stdout: "near y\n",
      });
      expect(requests).toEqual([]);

      expect((await exec("-c", "near", "hi")).stderr).toContain("--call is the whole command line");
      expect(await exec("-p", "hi", "-c", "near", "--", "x")).toMatchObject({ code: 2 });
      expect((await upm(CLI, ["run", "-c", "x"])).stderr).toContain(
        "--package, --call and --yes only apply to exec",
      );
    },
  );

  it("runs any command with --package bins first, and refuses a bin it cannot pick", async () => {
    const both = await exec("-p", "multi", "-p", "hi@1.0.0", "y", "z");
    expect(both).toMatchObject({ code: 0, stderr: "upm: installed hi@1.0.0, multi@1.0.0\n" });
    expect(ran(both)).toMatchObject({ at: "multi@1.0.0", args: ["z"] });

    expect(ran(await exec("twin")).at).toBe("twin@1.0.0");
    const several = await exec("multi");
    expect(several.code).toBe(1);
    expect(several.stderr).toContain("multi has bins x, y and none is multi (ENOBIN)");
    const none = await exec("lib");
    expect(none.stderr).toContain("lib has no bin (ENOBIN)");
    expect(await exec("-p", "hi")).toMatchObject({ code: 2 });
    expect((await upm(CLI, ["run", "-p", "hi", "x"])).stderr).toContain(
      "--package, --call and --yes only apply to exec",
    );
    expect((await exec("--json", "hi")).stderr).toContain("--json does not apply to exec");
  });

  it.skipIf(process.platform === "win32")(
    "runs npm's commands through the npm exec finds, with only --dir before them",
    async () => {
      const bin = join(dir, "work", "node_modules", ".bin");
      await mkdir(bin, { recursive: true });
      const npm = `#!/bin/sh\necho "npm $@ in $PWD, workspaces-update=$npm_config_workspaces_update"\n`;
      await writeFile(join(bin, "npm"), npm, { mode: 0o755 });
      const flags = ["--dir", join(dir, "work")];
      expect(await upm(CLI, ["publish", "--tag", "next", "--dir", "x"], {}, flags)).toEqual({
        code: 0,
        stdout: `npm publish --tag next --dir x in ${join(dir, "work")}, workspaces-update=false\n`,
        stderr: "",
      });
      expect(requests).toEqual([]);
      // npm's `start` is not one of them: a word npm would expand to it is a script.
      expect(await upm(CLI, ["star"], {}, flags)).toMatchObject({ code: 1, stdout: "" });
      const before = await upm(CLI, ["whoami"], {}, [...flags, "--registry", registry]);
      expect(before.code).toBe(2);
      expect(before.stderr).toContain("only --dir goes before whoami");
      const json = await upm(CLI, ["--json", "view", "hi"], {}, flags);
      expect(json).toMatchObject({ code: 2, stderr: expect.stringContaining("before view") });
    },
  );
});

describe("startup budget", () => {
  type Code = (filename: string, source: string) => { code: string };

  /** The rolldown obuild bundles with: its oxc transform and minifier. */
  async function oxc(): Promise<{ minifySync: Code; transformSync: Code }> {
    const obuild = createRequire(import.meta.url).resolve("obuild");
    return await import(pathToFileURL(createRequire(obuild).resolve("rolldown/utils")).href);
  }

  /**
   * Every `src/*.ts` reachable from `upm.ts`, which is what Node strips types off per run, by
   * its size minified on its own: comments and long names cost nothing, code does.
   */
  async function reachable(): Promise<Map<string, number>> {
    const { minifySync, transformSync } = await oxc();
    const out = new Map<string, number>();
    const queue = ["upm.ts", "cli.ts"]; // the bin, and the module it loads once the cache is on
    for (const name of queue) {
      if (out.has(name)) continue;
      const text = await readFile(
        fileURLToPath(new URL(`../src/${name}`, import.meta.url)),
        "utf8",
      );
      const js = transformSync(name, text).code;
      out.set(name, minifySync(name.replace(/\.ts$/, ".js"), js).code.length);
      // A module in a subdirectory, or loaded for its side effects only, would go uncounted:
      // `src/store/` did, for as long as it existed.
      expect(text, name).not.toMatch(/from "\.\/[\w-]+\/|^import "\./m);
      // `import type` is stripped, so what it names is never loaded.
      const imports = /^(?:import|export)(\s+type)?\s[^;]*?from "\.\/([\w-]+\.ts)"/gm;
      for (const [, type, file] of text.matchAll(imports)) if (!type) queue.push(file!);
    }
    return out;
  }

  it("keeps the startup module graph within its budget", async () => {
    // Without a compile-cache hit, every reachable source module needs type stripping.
    // Re-measure startup before raising this budget. Pools should load only when used.
    // 138,791 minified bytes over 27 modules when the count moved from source bytes (437,989);
    // 141,619 with the registry's version index and the lockfile kept in node_modules,
    // `--help` unchanged cached and uncached (40/41 and 106/106 ms); 142,074 with the progress
    // hooks and `--no-progress`, the bar itself lazy, `--help` unchanged (50/47 and 122/121 ms).
    const modules = await reachable();
    const bytes = [...modules.values()].reduce((total, size) => total + size, 0);
    expect(modules.size).toBeLessThanOrEqual(27); // `upm.ts` is the bin, `cli.ts` the program
    expect(bytes).toBeLessThanOrEqual(142_500);
    // Found through `import()` by the commands that read a project, like the pools: each holds
    // its worker's whole code in the build.
    const lazy = [
      "workspaces.ts",
      "exec.ts",
      "foreign-lock.ts",
      "tarball-deps.ts",
      "link-pool.ts",
      "registry-pool.ts",
      "unpack-pool.ts",
      "progress.ts",
    ];
    for (const name of lazy) {
      expect(modules.has(name)).toBe(false);
    }
  });
});

describe("install recovers a store that lost content", () => {
  let dir: string;
  let server: Server;
  let registry: string;
  let served: number;

  // Only tarballs: --frozen-lockfile means no packument is ever asked for, and the url the
  // lockfile implies is `<registry>/<name>/-/<name>-<version>.tgz`.
  const tarball = makeTarball([{ path: "index.js", data: "module.exports = 1;\n" }]);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "upm-relink-"));
    served = 0;
    server = createServer((request, response) => {
      if (!request.url?.endsWith("/-/a-1.0.0.tgz")) {
        response.writeHead(404).end("no");
        return;
      }
      served++;
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(tarball));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { a: "^1" } }),
    );
    await writeFile(
      join(dir, "upm.lock"),
      `${JSON.stringify(
        {
          lockfileVersion: 1,
          root: {
            name: "demo",
            version: "1.0.0",
            specs: { dependencies: { a: "^1" } },
            dependencies: { a: "1.0.0" },
          },
          packages: { "a@1.0.0": { integrity: hashOf(tarball) } },
        },
        undefined,
        2,
      )}\n`,
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const store = () => join(dir, "store");

  async function install(...flags: string[]): Promise<void> {
    await run(process.execPath, [
      CLI,
      "install",
      "--frozen-lockfile",
      "--dir",
      dir,
      "--store",
      store(),
      "--registry",
      registry,
      ...flags,
    ]);
  }

  /** The one content blob in a store holding a single one-file package. */
  async function blob(): Promise<string> {
    const files = join(store(), "files");
    const bucket = (await readdir(files))[0] as string;
    const name = (await readdir(join(files, bucket)))[0] as string;
    return join(files, bucket, name);
  }

  it("refetches content a prune took, without being asked to verify", async () => {
    await install();
    const content = await blob();
    expect(served).toBe(1);

    // What a concurrent `prune` does: the index still promises this file, the file is gone.
    await rm(content);
    await rm(join(dir, "node_modules"), { recursive: true });

    // No --verify. Nothing stats the store up front any more, so the index is believed, the
    // link fails on the missing blob, and that failure is what has to turn into a refetch.
    await install();

    expect(served).toBe(2);
    expect(await readFile(content, "utf8")).toBe("module.exports = 1;\n");
    expect(await readFile(join(dir, "node_modules", "a", "index.js"), "utf8")).toBe(
      "module.exports = 1;\n",
    );
  });
});

describe("add and remove", () => {
  let dir: string;
  let server: Server;
  let registry: string;
  let requests: string[];

  /**
   * `a` at 1.0.0 and 1.1.0 (latest), `b` at 1.0.0, each one file that names its version.
   * `d` depends on `ghost`, which the registry does not have; `e` depends on `a@^1`. `win`
   * is a win32 build that depends on `wasm`, which declares no platform; `w32` is a wasm32
   * build (no os, so its libc is read like a linux build's) that depends on `b`; `gnu` and
   * `musl` are this machine's os and cpu with a libc each.
   */
  const published: Record<string, string[]> = {
    a: ["1.0.0", "1.1.0"],
    b: ["1.0.0"],
    d: ["1.0.0"],
    e: ["1.0.0"],
    win: ["1.0.0"],
    w32: ["1.0.0"],
    gnu: ["1.0.0"],
    musl: ["1.0.0"],
    wasm: ["1.0.0"], // declares no platform; only `win` depends on it
  };
  const platform = { os: [process.platform], cpu: [process.arch] };
  const tarballs = new Map<string, Uint8Array>();
  for (const [name, versions] of Object.entries(published)) {
    for (const version of versions) {
      const data = `module.exports = "${name}@${version}";\n`;
      tarballs.set(`${name}-${version}.tgz`, makeTarball([{ path: "index.js", data }]));
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "upm-add-"));
    requests = [];
    server = createServer((request, response) => {
      requests.push(request.url ?? "");
      const [, name, ...rest] = (request.url ?? "").split("/");
      const versions = published[name ?? ""];
      const tarball = tarballs.get(rest[1] ?? "");
      if (rest[0] === "-" && tarball) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from(tarball));
        return;
      }
      if (!versions || (rest.length > 0 && !versions.includes(rest[0]!))) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"Not found"}');
        return;
      }
      const manifest = (version: string) => ({
        name,
        version,
        ...(name === "d" && { dependencies: { ghost: "^1" } }),
        ...(name === "e" && { dependencies: { a: "^1" } }),
        ...(name === "win" && { os: ["win32"], dependencies: { wasm: "^1" } }),
        ...(name === "w32" && { cpu: ["wasm32"], dependencies: { b: "^1" } }),
        ...(name === "gnu" && { ...platform, libc: ["glibc"] }),
        ...(name === "musl" && { ...platform, libc: ["musl"] }),
        dist: {
          tarball: `${registry}/${name}/-/${name}-${version}.tgz`,
          integrity: hashOf(tarballs.get(`${name}-${version}.tgz`)!),
        },
      });
      const body =
        rest.length > 0
          ? manifest(rest[0]!)
          : {
              name,
              "dist-tags": { latest: versions.at(-1) },
              versions: Object.fromEntries(versions.map((v) => [v, manifest(v)])),
            };
      response.writeHead(200, { "content-type": "application/json" });
      // The wasm32 build's full document, read for its libc, lands after its child's document
      // would, as a big packument does behind a CDN hit.
      const wait = name === "w32" && rest.length > 0 ? 250 : 0;
      setTimeout(() => response.end(JSON.stringify(body)), wait);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await writeFile(join(dir, "package.json"), '{\n\t"name": "demo",\n\t"version": "1.0.0"\n}\n');
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  async function upm(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const flags = ["--dir", dir, "--store", join(dir, "store"), "--registry", registry];
    return await run(process.execPath, [CLI, ...args, ...flags], {
      env: { ...process.env, ...env },
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
  }

  /** Extra environment for the next runs; a test that sets it puts it back. */
  let env: Record<string, string> = {};
  const manifest = async () => JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const installed = (name: string) => readFile(join(dir, "node_modules", name, "index.js"), "utf8");

  it("saves a caret on what a bare name resolved to, then installs it", async () => {
    const result = await upm("add", "a");
    expect(result).toMatchObject({ code: 0 });
    expect(result.stderr).toContain("+ a@^1.1.0 in dependencies");
    expect(await manifest()).toEqual({
      name: "demo",
      version: "1.0.0",
      dependencies: { a: "^1.1.0" },
    });
    expect(await installed("a")).toBe('module.exports = "a@1.1.0";\n');
    const lock = JSON.parse(await readFile(join(dir, "upm.lock"), "utf8"));
    expect(lock.root.specs).toEqual({ dependencies: { a: "^1.1.0" } });
  });

  it("keeps the file's indent", async () => {
    await upm("add", "a");
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(
      '{\n\t"name": "demo",\n\t"version": "1.0.0",\n\t"dependencies": {\n\t\t"a": "^1.1.0"\n\t}\n}\n',
    );
  });

  it("saves what was typed, into the group asked for, and moves a name between groups", async () => {
    expect(await upm("add", "--dev", "a@1.0.0", "b@^1")).toMatchObject({ code: 0 });
    expect((await manifest()).devDependencies).toEqual({ a: "1.0.0", b: "^1" });
    expect(await installed("a")).toBe('module.exports = "a@1.0.0";\n');

    expect(await upm("add", "-E", "a")).toMatchObject({ code: 0 });
    const moved = await manifest();
    expect(moved.dependencies).toEqual({ a: "1.1.0" });
    expect(moved.devDependencies).toEqual({ b: "^1" });
    expect(await installed("a")).toBe('module.exports = "a@1.1.0";\n');
  });

  it("is what install <spec> does", async () => {
    expect(await upm("install", "b")).toMatchObject({ code: 0 });
    expect((await manifest()).dependencies).toEqual({ b: "^1.0.0" });
  });

  it("leaves package.json alone when a spec does not resolve", async () => {
    const before = await readFile(join(dir, "package.json"), "utf8");
    const result = await upm("add", "a", "nope");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nope");
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(before);
  });

  it("leaves package.json alone when the tree does not resolve", async () => {
    const before = await readFile(join(dir, "package.json"), "utf8");
    const result = await upm("add", "d");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ghost");
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(before);
    expect(await readdir(dir)).not.toContain("upm.lock");
  });

  it("refuses one name given twice, and a package.json it could not write back", async () => {
    const twice = await upm("add", "a@1.0.0", "a@^1");
    expect(twice.code).toBe(1);
    expect(twice.stderr).toContain("a is given more than once");
    expect(await manifest()).not.toHaveProperty("dependencies");

    await writeFile(join(dir, "package.json"), '{ "dependencies": "oops" }');
    const bad = await upm("add", "a");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("dependencies is not a map of ranges (EMANIFEST)");
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe('{ "dependencies": "oops" }');
  });

  it("removes from package.json and from node_modules, once per name", async () => {
    await upm("add", "a", "b");
    const result = await upm("remove", "a", "a");
    expect(result).toMatchObject({ code: 0 });
    expect(result.stderr).toContain("- a");
    expect((await manifest()).dependencies).toEqual({ b: "^1.0.0" });
    expect(await readdir(join(dir, "node_modules"))).not.toContain("a");
    expect(await installed("b")).toBe('module.exports = "b@1.0.0";\n');
  });

  it("refuses to remove what is not a dependency, and writes nothing", async () => {
    await upm("add", "a");
    const before = await readFile(join(dir, "package.json"), "utf8");
    const result = await upm("remove", "a", "nope");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nope");
    expect(result.stderr).toContain("ENODEP");
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(before);
  });

  it("keeps what the lockfile has where the range still fits", async () => {
    // Locked before 1.1.0 was published, as far as this project is concerned.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { a: "^1" } }),
    );
    await writeFile(
      join(dir, "upm.lock"),
      `${JSON.stringify({
        lockfileVersion: 1,
        root: { specs: { dependencies: { a: "^1" } }, dependencies: { a: "1.0.0" } },
        packages: { "a@1.0.0": { integrity: hashOf(tarballs.get("a-1.0.0.tgz")!) } },
      })}\n`,
    );
    expect(await upm("add", "b")).toMatchObject({ code: 0 });
    expect(await installed("a")).toBe('module.exports = "a@1.0.0";\n');
    expect((await manifest()).dependencies).toEqual({ a: "^1", b: "^1.0.0" });
    // Its tarball, yes — the store was empty. Its packument, never.
    expect(requests.filter((url) => url.startsWith("/a"))).toEqual(["/a/-/a-1.0.0.tgz"]);

    // Moving the range is what asks again.
    expect(await upm("add", "a@^1.1")).toMatchObject({ code: 0 });
    expect(await installed("a")).toBe('module.exports = "a@1.1.0";\n');
  });

  describe("prefetch", () => {
    const tgz = (url: string) => url.endsWith(".tgz");
    const deps = (deps: Record<string, unknown>) =>
      writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", ...deps }));

    it("starts a tarball as soon as the walk picks its package, and fills from that", async () => {
      await deps({ dependencies: { e: "^1" } });
      expect(await upm("install")).toMatchObject({ code: 0 });
      // `e` is picked, and its tarball asked for, before `a` — its dependency — is looked up.
      expect(requests.indexOf("/e/-/e-1.0.0.tgz")).toBeLessThan(requests.indexOf("/a"));
      // Once each: the fill found the prefetch in flight or done.
      expect(requests.filter(tgz).sort()).toEqual(["/a/-/a-1.1.0.tgz", "/e/-/e-1.0.0.tgz"]);
      expect(await installed("e")).toBe('module.exports = "e@1.0.0";\n');
    });

    it("never fetches a tarball for lock or resolve", async () => {
      await deps({ dependencies: { e: "^1" } });
      expect(await upm("lock")).toMatchObject({ code: 0 });
      expect(await upm("resolve", "e", "a@^1")).toMatchObject({ code: 0 });
      expect(requests.filter(tgz)).toEqual([]);
    });

    it("survives a pick the walk drops", async () => {
      // `d` is picked and its tarball started, then its subtree fails and it is dropped.
      await deps({ dependencies: { a: "^1" }, optionalDependencies: { d: "^1" } });
      const result = await upm("install");
      expect(result).toMatchObject({ code: 0 });
      expect(result.stderr).toContain("skipped optional d@^1");
      expect(requests).toContain("/d/-/d-1.0.0.tgz");
      expect(await installed("a")).toBe('module.exports = "a@1.1.0";\n');
      expect(await readdir(join(dir, "node_modules"))).not.toContain("d");
    });

    it("fetches this platform's builds only", async () => {
      await deps({ optionalDependencies: { win: "^1", w32: "^1", gnu: "^1", musl: "^1" } });
      // Documents read here, not on threads still booting: the wasm32 build's child is then
      // picked well before the build's own libc read (delayed above) is in.
      env = { UPM_RESOLVE_POOL: "off" };
      const result = await upm("install").finally(() => (env = {}));
      expect(result).toMatchObject({ code: 0 });
      const fetched = requests.filter(tgz);
      // The win32 build, and what only it reaches, platform-neutral as that is: on win32 only.
      // The wasm32 build's libc is read after it is picked; its child must still wait for it.
      const win = process.platform === "win32";
      expect(fetched.includes("/win/-/win-1.0.0.tgz")).toBe(win);
      expect(fetched.includes("/wasm/-/wasm-1.0.0.tgz")).toBe(win);
      // The wasm32 build, and `b`, which only it reaches: nowhere.
      expect(fetched.includes("/w32/-/w32-1.0.0.tgz")).toBe(false);
      expect(fetched.includes("/b/-/b-1.0.0.tgz")).toBe(false);
      // One libc or the other on linux; off it neither build can be trusted, so neither.
      expect(fetched).toHaveLength(process.platform === "linux" ? 1 : win ? 2 : 0);
      const linked: string[] = await readdir(join(dir, "node_modules")).catch(() => []);
      for (const name of ["gnu", "musl"]) {
        expect(fetched.includes(`/${name}/-/${name}-1.0.0.tgz`)).toBe(linked.includes(name));
      }
    });

    it("does not prefetch under --production, where dev is not known until the walk ends", async () => {
      await deps({ dependencies: { a: "^1" }, devDependencies: { b: "^1" } });
      expect(await upm("install", "--production")).toMatchObject({ code: 0 });
      expect(requests.filter(tgz)).toEqual(["/a/-/a-1.1.0.tgz"]);
    });
  });

  it("dedupes a tree that came to hold two versions of a name, then installs", async () => {
    // `e` was locked with a@1.0.0; the root now wants 1.1.0, which the first pass brings in
    // and the second moves e onto.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { a: "1.1.0", e: "^1" } }),
    );
    const entry = (file: string, extra = {}) => ({
      integrity: hashOf(tarballs.get(file)!),
      ...extra,
    });
    await writeFile(
      join(dir, "upm.lock"),
      `${JSON.stringify({
        lockfileVersion: 1,
        root: {
          specs: { dependencies: { a: "^1", e: "^1" } },
          dependencies: { a: "1.0.0", e: "1.0.0" },
        },
        packages: {
          "a@1.0.0": entry("a-1.0.0.tgz"),
          "e@1.0.0": entry("e-1.0.0.tgz", { dependencies: { a: "1.0.0" } }),
        },
      })}\n`,
    );
    const result = await upm("dedupe");
    expect(result).toMatchObject({ code: 0 });
    expect(result.stderr).toContain("wrote upm.lock");
    const lock = JSON.parse(await readFile(join(dir, "upm.lock"), "utf8"));
    expect(Object.keys(lock.packages)).toEqual(["a@1.1.0", "e@1.0.0"]);
    expect(lock.packages["e@1.0.0"].dependencies).toEqual({ a: "1.1.0" });
    expect(await installed("a")).toBe('module.exports = "a@1.1.0";\n');
    // By version only, never the packument; the second pass read nothing.
    expect(requests.filter((url) => url.startsWith("/a")).sort()).toEqual([
      "/a/-/a-1.1.0.tgz",
      "/a/1.0.0",
      "/a/1.1.0",
    ]);

    const again = await upm("dedupe");
    expect(again.stderr).toContain("nothing to dedupe");
    expect(again.stderr).not.toContain("wrote upm.lock");
    expect(await upm("dedupe", "--frozen-lockfile")).toMatchObject({ code: 2 });
    expect(await upm("dedupe", "a")).toMatchObject({ code: 2 });
  });

  it("reports what changed under --json", async () => {
    const added = JSON.parse((await upm("add", "a", "--json")).stdout);
    expect(added.manifest).toEqual({
      added: [{ name: "a", range: "^1.1.0", group: "dependencies" }],
    });
    expect(added.packages).toBe(1);
    const removed = JSON.parse((await upm("remove", "a", "--json")).stdout);
    expect(removed).toMatchObject({ manifest: { removed: ["a"] }, packages: 0 });
  });

  it("rejects flags that cannot go with add or remove", async () => {
    expect(await upm("add", "a", "--frozen-lockfile")).toMatchObject({ code: 2 });
    expect(await upm("install", "a", "--frozen-lockfile")).toMatchObject({ code: 2 });
    expect(await upm("add", "a", "--dev", "--optional")).toMatchObject({ code: 2 });
    expect(await upm("add", "a", "--dev", "--production")).toMatchObject({ code: 2 });
    expect(await upm("add", "a", "--lock")).toMatchObject({ code: 2 });
    expect(await upm("remove", "a", "--dev")).toMatchObject({ code: 2 });
    expect(await upm("add")).toMatchObject({ code: 2 });
    expect(await upm("remove")).toMatchObject({ code: 2 });
  });
});

describe("a private scope from .npmrc", () => {
  let dir: string;
  let home: string;
  let servers: Server[];
  let registry: string;
  let publicRegistry: string;
  let refused: string[];
  /** The `authorization` the public registry was shown, per url. */
  let leaked: Map<string, string | undefined>;
  /** Tarball requests the private registry served. */
  let tarballs: number;

  const tarball = makeTarball([{ path: "index.js", data: "module.exports = 'private';\n" }]);
  const integrity = hashOf(tarball);
  const publicTarball = makeTarball([{ path: "index.js", data: "module.exports = 'public';\n" }]);

  /**
   * `@acme/a` depends on `@acme/b`, `@acme/c` and `pub`, from the public registry: enough
   * names to start the registry threads, and one that must never see the token.
   */
  const packument = (base: string, name: string, dependencies: Record<string, string>) => ({
    name,
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": {
        name,
        version: "1.0.0",
        dependencies,
        dist: {
          tarball: `${base}/${name}/-/${name.replace(/^@.*\//, "")}-1.0.0.tgz`,
          integrity: base === registry ? integrity : hashOf(publicTarball),
        },
      },
    },
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "upm-npmrc-"));
    home = join(dir, "home");
    await mkdir(home);
    servers = [];
    refused = [];
    leaked = new Map();
    tarballs = 0;
    const answer = (base: string, url: string, response: ServerResponse) => {
      if (url.endsWith(".tgz")) {
        if (base === registry) tarballs++;
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from(base === registry ? tarball : publicTarball));
        return;
      }
      const name = decodeURIComponent(url.slice(1)).split("/1.0.0")[0]!;
      const deps: Record<string, string> =
        name === "@acme/a" ? { "@acme/b": "^1", "@acme/c": "^1", pub: "^1" } : {};
      response.writeHead(200, { "content-type": "application/json" });
      const doc = packument(base, name, deps);
      response.end(JSON.stringify(url.endsWith("/1.0.0") ? doc.versions["1.0.0"] : doc));
    };
    registry = await serve((request, response) => {
      // Every route, document or tarball, wants the token.
      if (request.headers.authorization !== "Bearer s3cret") {
        refused.push(request.url ?? "");
        response.writeHead(401).end("no");
        return;
      }
      answer(registry, request.url ?? "", response);
    });
    publicRegistry = await serve((request, response) => {
      leaked.set(request.url ?? "", request.headers.authorization);
      answer(publicRegistry, request.url ?? "", response);
    });

    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
    // The scope in the project file, the token in the user file, from the environment.
    await writeFile(
      join(dir, ".npmrc"),
      `registry=${publicRegistry}\n@acme:registry=${registry}/\nsave-exact=true\n`,
    );
    await writeFile(
      join(home, ".npmrc"),
      `//${registry.slice("http://".length)}/:_authToken=\${ACME_TOKEN}\n`,
    );
  });

  afterEach(async () => {
    for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  });

  function upm(args: string[], env: Record<string, string | undefined> = {}) {
    const merged: Record<string, string | undefined> = { ...process.env };
    // `npm test` sets npm_config_userconfig to the real file, and a CI image may set the
    // global one in capitals: none of this machine's files is to take part.
    for (const name of Object.keys(merged)) {
      if (/^(npm_config_(globalconfig|userconfig|prefix)|prefix)$/i.test(name)) delete merged[name];
    }
    Object.assign(merged, {
      HOME: home,
      USERPROFILE: home, // os.homedir() on Windows
      npm_config_globalconfig: join(dir, "no-global-npmrc"),
      ACME_TOKEN: "s3cret",
      ...env,
    });
    for (const [name, value] of Object.entries(merged))
      if (value === undefined) delete merged[name];
    return run(process.execPath, [CLI, ...args, "--dir", dir, "--store", join(dir, "store")], {
      env: merged,
    });
  }

  it("adds, locks and installs through the scope's registry with its token", async () => {
    await upm(["add", "@acme/a"], { UPM_RESOLVE_POOL: "2" });
    expect(refused).toEqual([]);
    expect(await readFile(join(dir, "node_modules", "@acme", "a", "index.js"), "utf8")).toBe(
      "module.exports = 'private';\n",
    );
    // The public registry answered for `pub` and its tarball, shown no credential doing it.
    expect([...leaked.keys()]).toContain("/pub");
    expect([...leaked.keys()]).toContain("/pub/-/pub-1.0.0.tgz");
    expect([...leaked.values()]).toEqual([...leaked.keys()].map(() => undefined));
    expect(tarballs).toBe(1); // the three private packages share one content
    // save-exact: the version, not a caret range.
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "@acme/a": "1.0.0" });
    // The lockfile derives every tarball url from its scope's registry, so it names neither.
    const lock = await readFile(join(dir, "upm.lock"), "utf8");
    expect(lock).not.toContain("127.0.0.1");
    expect(Object.keys(JSON.parse(lock).packages).sort()).toEqual([
      "@acme/a@1.0.0",
      "@acme/b@1.0.0",
      "@acme/c@1.0.0",
      "pub@1.0.0",
    ]);

    // A frozen install from that lockfile: tarballs only, still with the token.
    await rm(join(dir, "node_modules"), { recursive: true });
    await rm(join(dir, "store"), { recursive: true });
    tarballs = 0;
    await upm(["install", "--frozen-lockfile"]);
    expect(refused).toEqual([]);
    expect(tarballs).toBe(1);
    expect(await readFile(join(dir, "node_modules", "@acme", "a", "index.js"), "utf8")).toBe(
      "module.exports = 'private';\n",
    );
  });

  it("is refused without the token, or with its variable unset, and says so", async () => {
    // Unset, the variable stays as written, as with npm: the registry is what says no.
    let result = await upm(["add", "@acme/a"], { ACME_TOKEN: undefined }).catch((e) => e);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("401");
    expect(refused).toEqual(["/@acme%2fa"]);

    await rm(join(home, ".npmrc"));
    result = await upm(["add", "@acme/a"]).catch((error) => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("401");
  });

  it("refuses a credential that is not keyed by a registry", async () => {
    await writeFile(join(home, ".npmrc"), "_authToken=s3cret\n");
    const result = await upm(["add", "@acme/a"]).catch((error) => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("_authToken in .npmrc must be keyed by its registry");
    expect(refused).toEqual([]);
  });
});

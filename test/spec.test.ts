import { describe, expect, it } from "vitest";
import { bareTarball, escapeName, isGit, parseDep, parseSpec, tarballSource } from "../src/spec.ts";

describe("parseSpec", () => {
  it("bare name becomes the * range", () => {
    expect(parseSpec("foo")).toEqual({
      raw: "foo",
      name: "foo",
      fetchName: "foo",
      scope: undefined,
      type: "range",
      fetchSpec: "*",
      escapedName: "foo",
    });
  });

  it("exact version wins over range", () => {
    const spec = parseSpec("foo@1.2.3");
    expect(spec.type).toBe("version");
    expect(spec.fetchSpec).toBe("1.2.3");
    expect(spec.raw).toBe("foo@1.2.3");
  });

  it("prerelease is still a version", () => {
    expect(parseSpec("foo@1.2.3-beta.1").type).toBe("version");
  });

  it.each([
    ["foo@^1.2", "^1.2"],
    ["foo@~1.0.0", "~1.0.0"],
    ["foo@>=1 <2", ">=1 <2"],
    ["foo@1.x", "1.x"],
  ])("%s is a range", (arg, fetchSpec) => {
    const spec = parseSpec(arg);
    expect(spec.type).toBe("range");
    expect(spec.fetchSpec).toBe(fetchSpec);
  });

  it.each(["latest", "next", "beta-2"])("%s is a tag", (tag) => {
    const spec = parseSpec(`foo@${tag}`);
    expect(spec.type).toBe("tag");
    expect(spec.fetchSpec).toBe(tag);
  });

  it.each(["foo@", "foo@*", "@scope/foo@"])("%s resolves to the * range", (arg) => {
    const spec = parseSpec(arg);
    expect(spec.type).toBe("range");
    expect(spec.fetchSpec).toBe("*");
  });

  describe("scoped names", () => {
    it("splits on the second @", () => {
      expect(parseSpec("@scope/foo@~1.0.0")).toEqual({
        raw: "@scope/foo@~1.0.0",
        name: "@scope/foo",
        fetchName: "@scope/foo",
        scope: "@scope",
        type: "range",
        fetchSpec: "~1.0.0",
        escapedName: "@scope%2ffoo",
      });
    });

    it("escapes only the slash", () => {
      expect(parseSpec("@scope/foo").escapedName).toBe("@scope%2ffoo");
    });

    it("leaves an unscoped name alone", () => {
      expect(parseSpec("foo").escapedName).toBe("foo");
      expect(parseSpec("foo").scope).toBeUndefined();
    });
  });

  describe("names npm accepts", () => {
    // npm only warns on these; published packages depend on them.
    it.each(["JSONStream", "Base64", "CSSselect", "Sortable"])("accepts %s", (name) => {
      expect(parseDep(name, "^1.0.0").name).toBe(name);
    });

    it("accepts a name longer than 214 characters", () => {
      const name = "a".repeat(215);
      expect(parseDep(name, "1.0.0").name).toBe(name);
    });
  });

  describe("invalid names", () => {
    it.each([
      ["empty", "@1.2.3"],
      ["leading dot", ".foo@1.2.3"],
      ["leading underscore", "_foo@1.2.3"],
      ["space", "foo bar@1.2.3"],
      ["slash without a scope", "a/b@1.2.3"],
      ["scope with no name", "@scope/@1.2.3"],
      ["scope with no scope", "@/foo@1.2.3"],
      ["leading hyphen", "-rf@1.2.3"],
      ["reserved name", "node_modules@1.2.3"],
    ])("rejects %s", (_label, arg) => {
      expect(() => parseSpec(arg)).toThrow(/Invalid package name/);
    });

    it("rejects a bare scope", () => {
      expect(() => parseSpec("@scope")).toThrow(/Invalid package name/);
    });

    it("tags errors with a code", () => {
      expect(() => parseSpec(".foo@1.2.3")).toThrow(
        expect.objectContaining({ code: "EINVALIDSPEC" }),
      );
    });

    it("includes where in the message", () => {
      expect(() => parseSpec(".foo@1.2.3", "/app/package.json")).toThrow(/at \/app\/package\.json/);
    });
  });

  it("rejects a url-unsafe tag", () => {
    expect(() => parseSpec("foo@a/../../etc")).toThrow(/Invalid tag/);
  });
});

describe("escapeName", () => {
  it("escapes a name as parseDep does", () => {
    for (const name of ["foo", "@scope/foo", "Foo.Bar", "@s/.x"]) {
      expect(escapeName(name)).toBe(parseDep(name, "").escapedName);
    }
    expect(escapeName("@scope/foo")).toBe("@scope%2ffoo");
  });

  it("refuses a bad name with parseDep's error", () => {
    for (const name of ["", ".foo", "a/b", "@s", "node_modules", "@s/%"]) {
      let expected: Error | undefined;
      try {
        parseDep(name, "");
      } catch (error) {
        expected = error as Error;
      }
      expect(expected).toBeDefined();
      expect(() => escapeName(name)).toThrow(
        expect.objectContaining({ message: expected!.message, code: "EINVALIDSPEC" }),
      );
    }
    expect(() => escapeName("a/b")).toThrow(
      'Invalid package name "a/b" of package "a/b": name is malformed',
    );
  });
});

describe("parseDep", () => {
  it("does not re-split the name on @", () => {
    expect(parseDep("@scope/foo", "^1.0.0")).toEqual({
      raw: "@scope/foo@^1.0.0",
      name: "@scope/foo",
      fetchName: "@scope/foo",
      scope: "@scope",
      type: "range",
      fetchSpec: "^1.0.0",
      escapedName: "@scope%2ffoo",
    });
  });

  it("keeps a scoped name whole when the spec is empty", () => {
    const spec = parseDep("@scope/foo", "");
    expect(spec.name).toBe("@scope/foo");
    expect(spec.scope).toBe("@scope");
    expect(spec.fetchSpec).toBe("*");
  });

  it("rejects a url-unsafe tag", () => {
    expect(() => parseDep("foo", "beta@2")).toThrow(/Invalid tag/);
  });

  it("classifies like parseSpec", () => {
    expect(parseDep("foo", "1.0.0").type).toBe("version");
    expect(parseDep("foo", "^1.0.0").type).toBe("range");
    expect(parseDep("foo", "latest").type).toBe("tag");
  });

  it.each(["", "*"])("empty-ish spec %j becomes the * range", (dep) => {
    const spec = parseDep("foo", dep);
    expect(spec.type).toBe("range");
    expect(spec.fetchSpec).toBe("*");
  });

  it("raw is just the name when the spec is empty", () => {
    expect(parseDep("foo", "").raw).toBe("foo");
  });
});

describe("alias specs", () => {
  it("installs the target under the declared name", () => {
    expect(parseDep("string-width-cjs", "npm:string-width@^4.2.0")).toEqual({
      raw: "string-width-cjs@npm:string-width@^4.2.0",
      name: "string-width-cjs",
      fetchName: "string-width",
      scope: undefined,
      type: "range",
      fetchSpec: "^4.2.0",
      escapedName: "string-width",
    });
  });

  it("classifies the target spec like any other", () => {
    expect(parseDep("a", "npm:b@1.2.3").type).toBe("version");
    expect(parseDep("a", "npm:b@^1").type).toBe("range");
    expect(parseDep("a", "npm:b@next").type).toBe("tag");
  });

  it.each(["npm:b", "npm:b@", "npm:b@*"])("%j is the * range on b", (spec) => {
    expect(parseDep("a", spec)).toMatchObject({ fetchName: "b", type: "range", fetchSpec: "*" });
  });

  it("takes the registry path from the target, not the alias", () => {
    const spec = parseDep("cliui", "npm:@scope/cliui@^1");
    expect(spec.fetchName).toBe("@scope/cliui");
    expect(spec.scope).toBe("@scope");
    expect(spec.escapedName).toBe("@scope%2fcliui");
    // The alias itself is unscoped: only `name` keeps it.
    expect(spec.name).toBe("cliui");
  });

  it("aliases a scoped name onto a scoped target", () => {
    expect(parseDep("@me/x", "npm:@you/y@~2")).toMatchObject({
      name: "@me/x",
      fetchName: "@you/y",
      fetchSpec: "~2",
    });
  });

  it("allows an alias to a differently-ranged copy of itself", () => {
    expect(parseDep("foo", "npm:foo@^1")).toMatchObject({ name: "foo", fetchName: "foo" });
  });

  it("parses an alias given as one CLI argument", () => {
    expect(parseSpec("wrap-ansi-cjs@npm:wrap-ansi@^7.0.0")).toMatchObject({
      name: "wrap-ansi-cjs",
      fetchName: "wrap-ansi",
      fetchSpec: "^7.0.0",
      type: "range",
    });
  });

  it("keeps the whole alias in raw, so errors name the real spec", () => {
    expect(() => parseDep("a", "npm:b@../../etc")).toThrow(
      /Invalid tag "\.\.\/\.\.\/etc" of package "a@npm:b@\.\.\/\.\.\/etc"/,
    );
  });

  it.each([
    ["no target", "npm:"],
    ["target is a path segment", "npm:../evil"],
    ["target starts with a dot", "npm:.evil@1"],
    ["reserved target", "npm:node_modules@1"],
    ["url-unsafe target", "npm:e vil@1"],
    // The target becomes a registry path segment and a directory name, so it gets the
    // same checks as any other name.
    ["scoped target that is a path segment", "npm:@scope/..@1"],
    ["scoped target with an unsafe scope", "npm:@sc ope/x@1"],
  ])("rejects %s", (_label, spec) => {
    expect(() => parseDep("a", spec)).toThrow(/Invalid package name/);
  });

  it("rejects an alias pointing at another alias", () => {
    expect(() => parseDep("a", "npm:b@npm:c@1")).toThrow(/an alias cannot point at an alias/);
  });

  it("tags a bad alias with EINVALIDSPEC", () => {
    expect(() => parseDep("a", "npm:")).toThrow(expect.objectContaining({ code: "EINVALIDSPEC" }));
    expect(() => parseDep("a", "npm:b@npm:c@1")).toThrow(
      expect.objectContaining({ code: "EINVALIDSPEC" }),
    );
  });

  it("treats a bare npm: prefix on the name as an ordinary invalid name", () => {
    // `npm:foo` as a *name* is not an alias; only the spec half carries one.
    expect(() => parseDep("npm:foo", "^1")).toThrow(/Invalid package name/);
  });
});

describe("link: specs", () => {
  it.each([
    ["link:../lib", "../lib"],
    ["link:./lib/", "lib"],
    ["link:vendor\\lib", "vendor/lib"],
    ["link: ../a/../b ", "../b"],
  ])("%s is a clean relative directory", (spec, fetchSpec) => {
    expect(parseDep("lib", spec)).toMatchObject({ name: "lib", type: "link", fetchSpec });
  });

  it("parses one as a CLI argument", () => {
    expect(parseSpec("@s/lib@link:../lib")).toMatchObject({
      name: "@s/lib",
      type: "link",
      fetchSpec: "../lib",
    });
  });

  it.each([
    ["an absolute path", "link:/srv/lib", /give it relative to package.json/],
    ["a home path", "link:~/lib", /give it relative to package.json/],
    ["a drive", "link:C:\\lib", /give it relative to package.json/],
    ["no directory", "link:.", /it names no directory/],
    ["an alias of one", "npm:lib@link:../lib", /cannot point at an alias/],
  ])("refuses %s", (_, spec, message) => {
    expect(() => parseDep("lib", spec)).toThrow(message);
  });
});

describe("workspace: specs", () => {
  it.each(["workspace:", "workspace:*", "workspace:^", "workspace:~", "workspace: * "])(
    "%s takes any version of the workspace",
    (spec) => {
      expect(parseDep("b", spec)).toEqual({
        raw: `b@${spec}`,
        name: "b",
        fetchName: "b",
        scope: undefined,
        type: "workspace",
        fetchSpec: "*",
        escapedName: "b",
      });
    },
  );

  it.each([
    ["workspace:^2", "^2"],
    ["workspace:~1.2.0", "~1.2.0"],
    ["workspace:1.0.0", "1.0.0"],
    ["workspace:>=1 <3", ">=1 <3"],
  ])("%s keeps the range", (spec, fetchSpec) => {
    expect(parseDep("b", spec)).toMatchObject({ type: "workspace", fetchSpec, fetchName: "b" });
  });

  it("names another workspace the way npm: names another package", () => {
    expect(parseDep("foo", "workspace:b@^1")).toMatchObject({
      name: "foo",
      fetchName: "b",
      type: "workspace",
      fetchSpec: "^1",
    });
    expect(parseDep("foo", "workspace:@scope/b@*")).toMatchObject({
      fetchName: "@scope/b",
      scope: "@scope",
      escapedName: "@scope%2fb",
      fetchSpec: "*",
    });
    expect(parseDep("foo", "workspace:b@")).toMatchObject({ fetchName: "b", fetchSpec: "*" });
    expect(parseDep("foo", "workspace:b@^")).toMatchObject({ fetchName: "b", fetchSpec: "*" });
  });

  it("parses one as a CLI argument", () => {
    expect(parseSpec("b@workspace:^")).toMatchObject({ name: "b", type: "workspace" });
  });

  it.each([
    ["a path", "workspace:./packages/b", /named, not given by path/],
    ["an absolute path", "workspace:/srv/b", /named, not given by path/],
    ["a tag", "workspace:latest", /not a range/],
    ["an alias inside", "workspace:npm:b@1", /Invalid package name/],
    ["a bad workspace name", "workspace:.b@1", /Invalid package name/],
  ])("rejects %s", (_label, spec, message) => {
    expect(() => parseDep("b", spec)).toThrow(message);
    expect(() => parseDep("b", spec)).toThrow(expect.objectContaining({ code: "EINVALIDSPEC" }));
  });

  it("rejects an alias pointing at a workspace", () => {
    expect(() => parseDep("a", "npm:b@workspace:*")).toThrow(/an alias cannot point at an alias/);
  });
});

describe("tarball specs", () => {
  it.each([
    ["https://t.test/a/-/a-1.0.0.tgz", "https://t.test/a/-/a-1.0.0.tgz"],
    ["http://127.0.0.1:4873/a.tgz", "http://127.0.0.1:4873/a.tgz"],
    // Any url: a server may name a tarball any way it likes.
    ["https://codeload.test/u/a/tar.gz/main", "https://codeload.test/u/a/tar.gz/main"],
    ["file:vendor/a.tgz", "file:vendor/a.tgz"],
    ["file:./vendor/a.tgz", "file:vendor/a.tgz"],
    ["./vendor//a.tar.gz", "file:vendor/a.tar.gz"],
    ["../x/./a.TAR", "file:../x/a.TAR"],
    [".\\vendor\\a.tgz", "file:vendor/a.tgz"],
    ["file:vendor/../../a.tgz", "file:../a.tgz"],
  ])("%s is a tarball at %s", (spec, fetchSpec) => {
    expect(parseDep("a", spec)).toEqual({
      raw: `a@${spec}`,
      name: "a",
      fetchName: "a",
      scope: undefined,
      type: "tarball",
      fetchSpec,
      escapedName: "a",
    });
  });

  it("splits a CLI argument on the name's @, not the url's", () => {
    const spec = parseSpec("@s/a@https://t.test/@s/a/-/a-1.0.0.tgz");
    expect(spec).toMatchObject({ name: "@s/a", type: "tarball", scope: "@s" });
    expect(spec.fetchSpec).toBe("https://t.test/@s/a/-/a-1.0.0.tgz");
  });

  it.each([
    ["file:/etc/a.tgz", /give it relative to package.json/],
    ["file:~/a.tgz", /give it relative to package.json/],
    ["file:C:\\a.tgz", /give it relative to package.json/],
    ["/abs/a.tgz", /give it relative to package.json/],
    ["~/a.tgz", /give it relative to package.json/],
    ["file:../lib", /only a tarball/],
    ["./vendor/a", /only a tarball/],
    ["https://[bad/a.tgz", /Invalid url/],
  ])("refuses %s", (spec, message) => {
    expect(() => parseDep("a", spec)).toThrow(message);
    expect(() => parseDep("a", spec)).toThrow(expect.objectContaining({ code: "EINVALIDSPEC" }));
  });

  it("never reads an alias or a workspace: spec as a path", () => {
    expect(() => parseDep("a", "npm:b@./b.tgz")).toThrow(/Invalid tag/);
    expect(() => parseDep("a", "workspace:./a")).toThrow(/a workspace is named/);
  });

  it.each([
    ["https://t.test/a.tgz", "https://t.test/a.tgz"],
    ["file:vendor/a.tgz", "file:vendor/a.tgz"],
    ["./a-1.0.0.tgz", "file:a-1.0.0.tgz"],
    ["a-1.0.0.tgz", "file:a-1.0.0.tgz"],
    ["vendor/a-1.0.0.tgz", "file:vendor/a-1.0.0.tgz"],
  ])("takes %s on its own as a tarball", (arg, fetchSpec) => {
    expect(bareTarball(arg)).toBe(fetchSpec);
  });

  it.each(["a", "a@1.0.0", "a@https://t.test/a.tgz", "@s/a@./a.tgz", "a@latest"])(
    "leaves %s to parseSpec",
    (arg) => {
      expect(bareTarball(arg)).toBeUndefined();
    },
  );

  it("puts a path under the directory of the package.json that declared it", () => {
    expect(tarballSource("file:../../vendor/a.tgz", "packages/w")).toBe("file:vendor/a.tgz");
    expect(tarballSource("file:a.tgz", "")).toBe("file:a.tgz");
    expect(tarballSource("file:../a.tgz", "")).toBe("file:../a.tgz");
    expect(tarballSource("https://t.test/a.tgz", "packages/w")).toBe("https://t.test/a.tgz");
  });
});

describe("git specs", () => {
  const gh = "https://codeload.github.com/u/r/tar.gz";
  it.each([
    ["github:u/r", `${gh}/HEAD`],
    ["github:u/r#v1.2.0", `${gh}/v1.2.0`],
    ["GitHub:u/r.git#", `${gh}/HEAD`],
    ["u/r", `${gh}/HEAD`],
    ["u/r#feat/x", `${gh}/feat%2Fx`],
    ["u.js/r_x-1#0a1b2c3", "https://codeload.github.com/u.js/r_x-1/tar.gz/0a1b2c3"],
    ["git://github.com/u/r.git#main", `${gh}/main`],
    ["git+https://github.com/u/r.git", `${gh}/HEAD`],
    ["git+https://user:token@github.com/u/r", `${gh}/HEAD`],
    ["git+ssh://git@github.com/u/r.git#main", `${gh}/main`],
    ["git+ssh://git@github.com:u/r.git#main", `${gh}/main`],
    ["git+ssh://git@github.com:22/u/r.git", `${gh}/HEAD`],
    ["git@github.com:u/r.git", `${gh}/HEAD`],
    ["https://github.com/u/r.git#main", `${gh}/main`],
    [
      "gitlab:g/sub/r#v1",
      "https://gitlab.com/api/v4/projects/g%2Fsub%2Fr/repository/archive.tar.gz?sha=v1",
    ],
    [
      "git+https://gitlab.com/g/r.git",
      "https://gitlab.com/api/v4/projects/g%2Fr/repository/archive.tar.gz?sha=HEAD",
    ],
    ["bitbucket:u/r#main", "https://bitbucket.org/u/r/get/main.tar.gz"],
  ])("%s is a tarball at %s", (spec, fetchSpec) => {
    expect(parseDep("a", spec)).toMatchObject({ raw: `a@${spec}`, type: "tarball", fetchSpec });
  });

  it("splits a CLI argument on the name's @, not the git url's", () => {
    expect(parseSpec("@s/a@git@github.com:u/r.git")).toMatchObject({
      name: "@s/a",
      type: "tarball",
      fetchSpec: `${gh}/HEAD`,
    });
    expect(parseSpec("a@u/r#main").fetchSpec).toBe(`${gh}/main`);
  });

  it.each([
    ["git+https://example.com/u/r.git", /only from GitHub, GitLab or Bitbucket/],
    ["git+file:///tmp/r", /only from GitHub, GitLab or Bitbucket/],
    ["https://example.com/u/r.git", /only from GitHub, GitLab or Bitbucket/],
    ["gist:abc123", /only github, gitlab, bitbucket shortcuts install/],
    ["github:u/r#semver:^1.0.0", /only a commit, branch or tag/],
    ["github:u/r#main::path:packages/a", /only a commit, branch or tag/],
    ["github:u", /no user\/repo/],
    ["git+https://github.com/u/r/tree/main", /no user\/repo/],
    ["github:u/r%20x", /user\/repo is malformed/],
    ["github:u/..", /user\/repo is malformed/],
  ])("refuses %s", (spec, message) => {
    expect(() => parseDep("a", spec)).toThrow(message);
    expect(() => parseDep("a", spec)).toThrow(expect.objectContaining({ code: "EINVALIDSPEC" }));
  });

  it.each([
    ["github:u/r#main", `${gh}/main`],
    ["u/r", `${gh}/HEAD`],
    ["git@github.com:u/r.git", `${gh}/HEAD`],
    ["git+ssh://git@github.com/u/r.git", `${gh}/HEAD`],
  ])("takes %s on its own as a tarball", (arg, fetchSpec) => {
    expect(bareTarball(arg)).toBe(fetchSpec);
  });

  it.each([
    "a",
    "@s/a",
    "a@1.0.0",
    "a@npm:b@1",
    "vendor/a-1.0.0.tgz",
    "./u/r",
    "https://t.test/a.tgz",
    "https://codeload.github.com/u/r/tar.gz/main",
  ])("%s is not git", (arg) => {
    expect(isGit(arg)).toBe(false);
  });
});

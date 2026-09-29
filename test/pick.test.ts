import { describe, expect, it } from "vitest";
import { asOf, pickManifest, viewAsOf } from "../src/pick.ts";
import type { PackumentView } from "../src/pick.ts";
import { parseSpec } from "../src/spec.ts";
import type { Manifest, Packument } from "../src/types.ts";

type Fixture = Record<string, Partial<Manifest>>;

function pkg(versions: Fixture, tags: Record<string, string> = {}): Packument {
  const out: Record<string, Manifest> = {};
  for (const [version, extra] of Object.entries(versions)) {
    out[version] = {
      name: "foo",
      version,
      dist: { tarball: `https://registry.npmjs.org/foo/-/foo-${version}.tgz` },
      ...extra,
    };
  }
  return { name: "foo", "dist-tags": tags, versions: out };
}

/** A node range the current runtime can never satisfy. */
const BAD_ENGINE = { engines: { node: ">=99" } };

/** A view that lists its versions, as the registry's does: the pick then reads only matches. */
function listed(packument: Packument): PackumentView {
  const keys = Object.keys(packument.versions ?? {});
  return {
    tags: () => packument["dist-tags"] ?? {},
    version: (version) => packument.versions?.[version],
    versions: () => keys,
    whole: () => packument,
  };
}

/** Every pick is made over the parsed document and over a listing view, with one outcome. */
function pick(
  source: Packument | PackumentView,
  arg: string,
  options?: Parameters<typeof pickManifest>[2],
) {
  const spec = parseSpec(arg);
  const outcome = (from: Packument | PackumentView) => {
    try {
      return { found: pickManifest(from, spec, options) };
    } catch (error) {
      const { message, code } = error as { message: string; code?: string };
      return { failed: { message, code }, error };
    }
  };
  const whole = outcome("whole" in source ? source.whole() : source);
  const { error: _, ...seen } = outcome("whole" in source ? source : listed(source as Packument));
  const { error, ...expected } = whole;
  expect(seen).toEqual(expected);
  if (error) throw error;
  return whole.found!;
}

describe("fast path", () => {
  const doc = pkg({ "1.0.0": {}, "2.0.0": {}, "3.0.0": {} }, { latest: "2.0.0" });

  it("prefers the default tag over the highest version", () => {
    expect(pick(doc, "foo").version).toBe("2.0.0");
    expect(pick(doc, "foo@*").version).toBe("2.0.0");
  });

  it("takes the tag only when it satisfies the range", () => {
    expect(pick(doc, "foo@^3").version).toBe("3.0.0");
    expect(pick(doc, "foo@<2").version).toBe("1.0.0");
  });

  it("honours a custom defaultTag", () => {
    const custom = pkg({ "1.0.0": {}, "2.0.0": {} }, { latest: "2.0.0", legacy: "1.0.0" });
    expect(pick(custom, "foo", { defaultTag: "legacy" }).version).toBe("1.0.0");
  });
});

describe("dist-tags", () => {
  const doc = pkg({ "1.0.0": {}, "2.0.0-beta.1": {} }, { latest: "1.0.0", next: "2.0.0-beta.1" });

  it("resolves a tag to its version", () => {
    expect(pick(doc, "foo@next").version).toBe("2.0.0-beta.1");
  });

  it("returns a tagged version even if deprecated or engine-incompatible", () => {
    const odd = pkg({ "1.0.0": { deprecated: "old", ...BAD_ENGINE } }, { next: "1.0.0" });
    expect(pick(odd, "foo@next").version).toBe("1.0.0");
  });

  it("throws ETARGET for a missing tag", () => {
    expect(() => pick(doc, "foo@nope")).toThrow(/No matching version/);
  });

  it("throws ETARGET when a tag points at a missing version", () => {
    const stale = pkg({ "1.0.0": {} }, { latest: "9.9.9" });
    expect(() => pick(stale, "foo@latest")).toThrow(/No matching version/);
  });
});

describe("exact versions", () => {
  const doc = pkg({ "1.2.3": {}, "2.0.0": {} }, { latest: "2.0.0" });

  it.each(["foo@1.2.3", "foo@=1.2.3", "foo@v1.2.3", "foo@ =v1.2.3 "])(
    "%s resolves to 1.2.3",
    (arg) => {
      expect(pick(doc, arg).version).toBe("1.2.3");
    },
  );

  it("throws ETARGET for an unpublished version", () => {
    expect(() => pick(doc, "foo@1.2.4")).toThrow(/No matching version/);
  });
});

describe("ranges", () => {
  const doc = pkg({ "1.0.0": {}, "1.2.0": {}, "1.9.1": {}, "2.0.0": {} }, { latest: "2.0.0" });

  it("picks the highest match", () => {
    expect(pick(doc, "foo@^1").version).toBe("1.9.1");
    expect(pick(doc, "foo@1.x").version).toBe("1.9.1");
    expect(pick(doc, "foo@~1.2").version).toBe("1.2.0");
    expect(pick(doc, "foo@>=1.2 <2").version).toBe("1.9.1");
  });

  it("excludes prereleases unless the range opts in", () => {
    const pre = pkg({ "1.0.0": {}, "2.0.0-rc.1": {} }, { latest: "1.0.0" });
    expect(pick(pre, "foo@^1 || ^2").version).toBe("1.0.0");
    expect(pick(pre, "foo@^2.0.0-rc.1").version).toBe("2.0.0-rc.1");
  });

  it("throws ETARGET when nothing satisfies", () => {
    expect(() => pick(doc, "foo@^5")).toThrow(/No matching version found for foo@\^5/);
  });

  it("lets a `-` in a range, and only then, take a prerelease", () => {
    const pre = pkg({
      "1.0.0": {},
      "1.1.0-rc.1": {},
      "1.1.0": { deprecated: "x" },
      "2.0.0-rc.1": {},
      "2.0.0+build-1": {},
    });
    expect(pick(pre, "foo@^1").version).toBe("1.0.0");
    expect(pick(pre, "foo@1.0.0 - 1.5").version).toBe("1.0.0");
    expect(pick(pre, "foo@>=1.1.0-rc.1 <1.1.0").version).toBe("1.1.0-rc.1");
    expect(pick(pre, "foo@^2.0.0-rc.1").version).toBe("2.0.0+build-1");
    expect(pick(pre, "foo@<=2.0.0-rc.1").version).toBe("2.0.0-rc.1");
    expect(pick(pre, "foo@2").version).toBe("2.0.0+build-1"); // a `-` in build metadata only
  });

  it("breaks a tie between builds of one version by the document's order", () => {
    const builds = pkg({ "1.0.0+b": {}, "1.0.0+a": {}, "0.9.0": {} });
    expect(pick(builds, "foo@^1").version).toBe("1.0.0+b");
    const unusable = pkg({ "1.0.0+b": BAD_ENGINE, "1.0.0+a": BAD_ENGINE, "1.0.0+c": {} });
    expect(pick(unusable, "foo@*").version).toBe("1.0.0+c");
  });

  it("reads every match, newest first, when none is usable", () => {
    const old = pkg({
      "1.0.0": { deprecated: "x", ...BAD_ENGINE },
      "1.1.0": BAD_ENGINE,
      "1.2.0": { deprecated: "x" },
      "1.3.0": { deprecated: "x", ...BAD_ENGINE },
    });
    expect(pick(old, "foo@^1").version).toBe("1.2.0");
    const read: string[] = [];
    const view = listed(old);
    const counted = { ...view, version: (v: string) => (read.push(v), view.version(v)) };
    pickManifest(counted, parseSpec("foo@^1"));
    expect(read).toEqual(["1.3.0", "1.2.0", "1.1.0", "1.0.0"]);
    read.length = 0;
    pickManifest(counted, parseSpec("foo@<1.3"));
    expect(read).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
  });

  it("reads only the newest usable match", () => {
    const read: string[] = [];
    const view = listed(doc);
    const counted = { ...view, version: (v: string) => (read.push(v), view.version(v)) };
    expect(pickManifest(counted, parseSpec("foo@^1")).version).toBe("1.9.1");
    expect(read).toEqual(["1.9.1"]);
  });
});

describe("deprecated", () => {
  it("ranks below a healthy version", () => {
    const doc = pkg({ "1.0.0": {}, "2.0.0": { deprecated: "gone" } }, { latest: "2.0.0" });
    expect(pick(doc, "foo").version).toBe("1.0.0");
  });

  it("is still selected when it is the only match", () => {
    const doc = pkg({ "1.0.0": { deprecated: "gone" }, "2.0.0": {} }, { latest: "2.0.0" });
    expect(pick(doc, "foo@^1").version).toBe("1.0.0");
  });

  it("includeDeprecated drops the penalty", () => {
    const doc = pkg({ "1.0.0": {}, "2.0.0": { deprecated: "gone" } }, { latest: "2.0.0" });
    expect(pick(doc, "foo", { includeDeprecated: true }).version).toBe("2.0.0");
  });
});

describe("engines", () => {
  it("deprioritizes a node mismatch", () => {
    const doc = pkg({ "1.0.0": {}, "2.0.0": BAD_ENGINE }, { latest: "2.0.0" });
    expect(pick(doc, "foo").version).toBe("1.0.0");
  });

  it("returns a mismatch when nothing else fits", () => {
    const doc = pkg({ "1.0.0": {}, "2.0.0": BAD_ENGINE }, { latest: "2.0.0" });
    expect(pick(doc, "foo@^2").version).toBe("2.0.0");
  });

  it("engine-ok outranks not-deprecated", () => {
    const doc = pkg({
      "2.0.0": BAD_ENGINE,
      "3.0.0": { deprecated: "gone" },
    });
    expect(pick(doc, "foo@*").version).toBe("3.0.0");
  });

  it("healthy outranks both", () => {
    const doc = pkg({ "1.0.0": {}, "2.0.0": BAD_ENGINE, "3.0.0": { deprecated: "gone" } });
    expect(pick(doc, "foo@*").version).toBe("1.0.0");
  });

  it("ignores os, cpu and libc", () => {
    const doc = pkg(
      { "1.0.0": {}, "2.0.0": { os: ["aix"], cpu: ["mips"], libc: ["musl"] } },
      { latest: "2.0.0" },
    );
    expect(pick(doc, "foo").version).toBe("2.0.0");
  });
});

describe("errors", () => {
  it("ENOVERSIONS when the packument is empty", () => {
    const doc = pkg({}, { latest: "1.0.0" });
    expect(() => pick(doc, "foo")).toThrow(/No versions available for foo/);
    try {
      pick(doc, "foo");
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe("ENOVERSIONS");
    }
  });

  it.each(["foo@^9", "foo@9.9.9", "foo@nope"])("ETARGET carries the code for %s", (arg) => {
    const doc = pkg({ "1.0.0": {} }, { latest: "1.0.0" });
    try {
      pick(doc, arg);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as { code: string }).code).toBe("ETARGET");
      expect((error as { wanted: string }).wanted).toBeTruthy();
    }
  });
});

// Trimmed from `curl -H 'Accept: application/vnd.npm.install-v1+json' registry.npmjs.org/nanoid`.
const nanoid: Packument = {
  name: "nanoid",
  "dist-tags": { legacy: "3.3.18", latest: "6.0.1" },
  versions: {
    "2.1.11": {
      name: "nanoid",
      version: "2.1.11",
      dist: { tarball: "https://registry.npmjs.org/nanoid/-/nanoid-2.1.11.tgz" },
    },
    "3.3.18": {
      name: "nanoid",
      version: "3.3.18",
      engines: { node: "^10 || ^12 || ^13.7 || ^14 || >=15.0.1" },
      bin: { nanoid: "bin/nanoid.cjs" },
      dist: { tarball: "https://registry.npmjs.org/nanoid/-/nanoid-3.3.18.tgz" },
    },
    "4.0.2": {
      name: "nanoid",
      version: "4.0.2",
      engines: { node: "^14 || ^16 || >=18" },
      bin: { nanoid: "bin/nanoid.js" },
      dist: { tarball: "https://registry.npmjs.org/nanoid/-/nanoid-4.0.2.tgz" },
    },
    "5.1.6": {
      name: "nanoid",
      version: "5.1.6",
      engines: { node: "^18 || >=20" },
      bin: { nanoid: "bin/nanoid.js" },
      dist: { tarball: "https://registry.npmjs.org/nanoid/-/nanoid-5.1.6.tgz" },
    },
    "6.0.0": {
      name: "nanoid",
      version: "6.0.0",
      engines: { node: "^22 || ^24 || >=26" },
      bin: { nanoid: "bin/nanoid.js" },
      dist: { tarball: "https://registry.npmjs.org/nanoid/-/nanoid-6.0.0.tgz" },
    },
    "6.0.1": {
      name: "nanoid",
      version: "6.0.1",
      engines: { node: "^22 || ^24 || >=26" },
      bin: { nanoid: "bin/nanoid.js" },
      dist: { tarball: "https://registry.npmjs.org/nanoid/-/nanoid-6.0.1.tgz" },
    },
  },
};

describe("real packument", () => {
  it("bare spec takes latest", () => {
    expect(pick(nanoid, "nanoid").version).toBe("6.0.1");
  });

  it("legacy tag", () => {
    expect(pick(nanoid, "nanoid@legacy").version).toBe("3.3.18");
    expect(pick(nanoid, "nanoid", { defaultTag: "legacy" }).version).toBe("3.3.18");
  });

  it("range narrows to the highest in the major", () => {
    expect(pick(nanoid, "nanoid@^3").version).toBe("3.3.18");
    expect(pick(nanoid, "nanoid@^5.1.0").version).toBe("5.1.6");
    expect(pick(nanoid, "nanoid@>=4 <6").version).toBe("5.1.6");
  });

  it("keeps dist and bin on the picked manifest", () => {
    const manifest = pick(nanoid, "nanoid@5");
    expect(manifest.dist.tarball).toContain("nanoid-5.1.6.tgz");
    expect(manifest.bin).toEqual({ nanoid: "bin/nanoid.js" });
  });

  it("a version with no engines field is fine", () => {
    expect(pick(nanoid, "nanoid@2.1.11").version).toBe("2.1.11");
  });
});

describe("asOf", () => {
  const doc = pkg(
    { "1.0.0": {}, "1.1.0": {}, "2.0.0": {}, "2.1.0-beta.1": {} },
    { latest: "2.0.0", next: "2.1.0-beta.1", old: "1.0.0" },
  );
  const times = {
    "1.0.0": "2026-01-01T00:00:00.000Z",
    "1.1.0": "2026-02-01T00:00:00.000Z",
    "2.0.0": "2026-03-01T00:00:00.000Z",
    "2.1.0-beta.1": "2026-03-02T00:00:00.000Z",
  };
  const cutoff = Date.parse("2026-02-15T00:00:00.000Z");

  it("drops later versions and moves a tag on one to the highest at or below it", () => {
    const aged = asOf(doc, times, cutoff);
    expect(Object.keys(aged.versions)).toEqual(["1.0.0", "1.1.0"]);
    expect(aged["dist-tags"]).toEqual({ latest: "1.1.0", next: "1.1.0", old: "1.0.0" });
    expect(aged.before).toBe("2026-02-15T00:00:00.000Z");
    expect(pick(aged, "foo").version).toBe("1.1.0");
    expect(pick(aged, "foo@latest").version).toBe("1.1.0");
    expect(pick(aged, "foo@^1.0.0").version).toBe("1.1.0");
  });

  it("keeps a version with no date, and drops a tag with nothing left under it", () => {
    const { "1.0.0": _, ...rest } = times;
    const aged = asOf(doc, rest, Date.parse("2025-01-01T00:00:00.000Z"));
    expect(Object.keys(aged.versions)).toEqual(["1.0.0"]);
    expect(aged["dist-tags"]).toEqual({ latest: "1.0.0", next: "1.0.0", old: "1.0.0" });
    expect(asOf(doc, times, 0)["dist-tags"]).toEqual({});
  });

  it("reads one tag as all of them are read, a document's own `__proto__` tag too", () => {
    const text = JSON.stringify(doc).replace('"dist-tags":{', '"dist-tags":{"__proto__":"1.0.0",');
    const own: Packument = JSON.parse(text);
    for (const at of [0, cutoff]) {
      const names = ["latest", "__proto__", "constructor", "none"];
      const one = names.map((t) => viewAsOf(listed(own), times, at).tag!(t));
      expect(one).toEqual(names.map((t) => viewAsOf(listed(own), times, at).tags()[t]));
    }
  });

  it("says a miss is the cutoff's, not the spec's", () => {
    const aged = asOf(doc, times, cutoff);
    expect(() => pick(aged, "foo@^2.0.0")).toThrow(
      "No version of foo@^2.0.0 published before 2026-02-15T00:00:00.000Z",
    );
    expect(() => pick(asOf(doc, times, 0), "foo")).toThrow(
      expect.objectContaining({ code: "ETARGET" }),
    );
  });

  it("is the same over a view that lists its versions, parsing none of them", () => {
    const read: string[] = [];
    const view = listed(doc);
    const counted = { ...view, version: (v: string) => (read.push(v), view.version(v)) };
    for (const at of [0, cutoff, Date.parse("2026-03-01T12:00:00.000Z"), Date.now()]) {
      const aged = viewAsOf(counted, times, at);
      // One tag at a time, before the rest are worked out and after.
      const tags = asOf(doc, times, at)["dist-tags"];
      const names = ["latest", "next", "old", "none", "constructor", "__proto__"];
      const each = () => names.map((t) => aged.tag!(t));
      const expected = names.map((t) => tags[t]);
      expect(each()).toEqual(expected);
      expect(aged.tags()).toEqual(tags);
      expect(each()).toEqual(expected);
      expect(aged.versions!()).toEqual(Object.keys(asOf(doc, times, at).versions));
    }
    expect(read).toEqual([]);
    const aged = viewAsOf(counted, times, cutoff);
    for (const arg of ["foo", "foo@latest", "foo@next", "foo@^1.0.0", "foo@^2.0.0", "foo@2.0.0"]) {
      expect(() => pick(aged, arg)).not.toThrow(/Expected/);
    }
    expect(aged.version("2.0.0")).toBeUndefined(); // too young, though the document has it
  });
});

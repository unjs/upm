import { describe, expect, it } from "vitest";
import { indexVersions, parseSlice, pluckModified, pluckTags, pluckTimes } from "../src/pluck.ts";

/** A version's manifest where the index says it is, as the registry's view reads it. */
function pluckVersion(bytes: Uint8Array, version: string) {
  const index = indexVersions(bytes);
  for (let i = 0; index && i < index.length; i += 3) {
    if (index[i] === version)
      return parseSlice(bytes, index[i + 1] as number, index[i + 2] as number);
  }
  return undefined;
}

const manifest = (name: string, version: string, extra: object = {}) => ({
  name,
  version,
  dist: { tarball: `https://r/${name}/-/${name}-${version}.tgz` },
  ...extra,
});
const bytes = (value: unknown, space?: number) =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value, null, space));

const doc = {
  name: "foo",
  "dist-tags": { latest: "2.0.0", next: "3.0.0-beta.1" },
  versions: {
    "1.0.0": manifest("foo", "1.0.0", { deprecated: 'use "2.0.0": {} instead' }),
    "2.0.0": manifest("foo", "2.0.0", { dependencies: { "1.0.0": "1.0.0", bar: "^1.0.0" } }),
    "3.0.0-beta.1": manifest("foo", "3.0.0-beta.1", {
      peerDependenciesMeta: { "2.0.0": { optional: true } },
    }),
  },
  modified: "2026-01-01T00:00:00.000Z",
};
const text = JSON.stringify(doc);

describe("indexVersions", () => {
  it("finds each version's manifest, equal to the whole parse, in the document's order", () => {
    for (const version of Object.keys(doc.versions)) {
      expect(pluckVersion(bytes(doc), version)).toEqual(JSON.parse(text).versions[version]);
    }
    const index = indexVersions(bytes(doc))!;
    expect(index.filter((_, i) => i % 3 === 0)).toEqual(Object.keys(doc.versions));
  });

  it("gives up on keys it cannot read as written, or one there twice", () => {
    // `JSON.parse` would keep the last of two; an escaped key is not the text it spells.
    const twice = '{"versions":{"1.0.0":{"a":1},"1.0.0":{"a":2}}}';
    expect(indexVersions(bytes(twice))).toBeUndefined();
    expect(indexVersions(bytes('{"versions":{"1.0\\u002e0":{}}}'))).toBeUndefined();
    expect(indexVersions(bytes({ versions: { "1.0.0-ü": {} } }))).toBeUndefined();
    expect(indexVersions(bytes({ versions: { "1.0.0": {} } }))).toEqual(["1.0.0", 21, 23]);
    expect(indexVersions(bytes({ name: "foo", versions: {} }))).toEqual([]);
    // One `versions` at the top is read; a second is skipped by structure, not taken.
    expect(indexVersions(bytes('{"versions":{},"versions":{"1.0.0":{}}}'))).toEqual([]);
  });

  it("is not fooled by the version in strings, in a dependency map or in peer meta", () => {
    // "1.0.0" is a dependency name and a range in 2.0.0; "2.0.0" sits in a string in 1.0.0 and
    // keys an object in 3.0.0's peer meta. Each has to come out as its own manifest.
    expect(pluckVersion(bytes(doc), "1.0.0")?.deprecated).toBe('use "2.0.0": {} instead');
    expect(pluckVersion(bytes(doc), "2.0.0")?.dependencies).toEqual({
      "1.0.0": "1.0.0",
      bar: "^1.0.0",
    });
  });

  it("takes the member of `versions`, never a look-alike a manifest carries", () => {
    // A later publish can put a whole fake manifest for an older version under any map the
    // registry keeps verbatim (`peerDependencies`, or a field hoisted to the top of a full
    // document). Pinning the older version must still get the registry's own entry.
    const real = manifest("foo", "1.0.0", { dist: { integrity: "sha512-real" } });
    const fake = manifest("foo", "1.0.0", { dist: { integrity: "sha512-fake" } });
    const spoofed = {
      name: "foo",
      "dist-tags": { latest: "1.0.1" },
      versions: {
        "0.9.0": manifest("foo", "0.9.0", { peerDependencies: { "1.0.0": fake } }),
        "1.0.0": real,
        "1.0.1": manifest("foo", "1.0.1", { peerDependencies: { "1.0.0": fake } }),
      },
      repository: { "1.0.0": fake },
      modified: "2026-01-01T00:00:00.000Z",
    };
    for (const space of [undefined, 2]) {
      expect(pluckVersion(bytes(spoofed, space), "1.0.0")).toEqual(real);
      expect(pluckVersion(bytes(spoofed, space), "1.0.1")).toEqual(spoofed.versions["1.0.1"]);
    }
    // No `versions` at the top means no version, whatever else holds one.
    expect(
      pluckVersion(bytes({ name: "foo", repository: { "1.0.0": fake } }), "1.0.0"),
    ).toBeUndefined();
    expect(
      pluckVersion(bytes({ nested: { versions: { "1.0.0": fake } } }), "1.0.0"),
    ).toBeUndefined();
  });

  it("reads pretty-printed JSON", () => {
    expect(pluckVersion(bytes(doc, 2), "2.0.0")).toEqual(doc.versions["2.0.0"]);
    expect(pluckTags(bytes(doc, 2))).toEqual(doc["dist-tags"]);
  });

  it("misses a version the document lacks, and indexes no document with one that is not an object", () => {
    expect(pluckVersion(bytes(doc), "9.9.9")).toBeUndefined();
    expect(indexVersions(bytes({ versions: { "1.0.0": {}, "2.0.0": "gone" } }))).toBeUndefined();
    expect(indexVersions(bytes({ versions: [] }))).toBeUndefined();
    expect(indexVersions(bytes({ name: "foo" }))).toBeUndefined();
    expect(pluckVersion(bytes(doc), '1.0.0"')).toBeUndefined();
    expect(pluckVersion(bytes(doc), "")).toBeUndefined();
  });

  it("gives up on bytes that are not JSON", () => {
    expect(
      indexVersions(bytes('{"versions":{"1.0.0":{"name":"foo","version":"1.0.0"')),
    ).toBeUndefined();
    expect(pluckVersion(bytes('{"versions":{"1.0.0":{oops}}}'), "1.0.0")).toBeUndefined();
    expect(indexVersions(bytes('{"versions":{"1.0.0":{"a":"unterminated'))).toBeUndefined();
    expect(indexVersions(bytes('{"versions":{"1.0.0":{}} trailing'))).toBeUndefined();
    expect(indexVersions(bytes("<html>"))).toBeUndefined();
  });

  it("reads past escaped quotes and non-ASCII text before the key", () => {
    const odd = {
      readme: 'say \\"1.0.0": {} — ünïcödé 🎉 \\\\',
      versions: { "1.0.0": manifest("foo", "1.0.0", { description: "naïve — 🎉" }) },
    };
    expect(pluckVersion(bytes(odd), "1.0.0")).toEqual(odd.versions["1.0.0"]);
  });
});

describe("pluckTags", () => {
  it("reads the top-level dist-tags", () => {
    expect(pluckTags(bytes(doc))).toEqual(doc["dist-tags"]);
  });

  it("skips over members before it, versions included", () => {
    const { "dist-tags": tags, ...rest } = doc;
    expect(pluckTags(bytes({ ...rest, "dist-tags": tags }))).toEqual(tags);
  });

  it("returns nothing for no tags, tags that are not strings, or bytes that are not an object", () => {
    expect(pluckTags(bytes({ name: "foo", versions: {} }))).toBeUndefined();
    expect(pluckTags(bytes({ "dist-tags": { latest: 1 } }))).toBeUndefined();
    expect(pluckTags(bytes({ "dist-tags": [] }))).toBeUndefined();
    expect(pluckTags(bytes({ versions: { "dist-tags": { latest: "1.0.0" } } }))).toBeUndefined();
    expect(pluckTags(bytes("[1]"))).toBeUndefined();
    expect(pluckTags(bytes("<html>"))).toBeUndefined();
    expect(pluckTags(bytes('{"name":"foo",'))).toBeUndefined();
  });
});

describe("pluckTimes", () => {
  it("reads a full document's publish dates past its versions", () => {
    const time = { created: "2020-01-01T00:00:00.000Z", "1.0.0": "2020-01-02T00:00:00.000Z" };
    expect(pluckTimes(bytes({ ...doc, time }))).toEqual(time);
    expect(pluckTimes(bytes(doc))).toBeUndefined();
  });
});

describe("pluckModified", () => {
  it("reads the last member off the tail, pretty-printed or not", () => {
    expect(pluckModified(bytes(doc))).toBe(doc.modified);
    expect(pluckModified(bytes(doc, 2))).toBe(doc.modified);
    expect(pluckModified(bytes({ modified: "x" }))).toBe("x");
  });

  it("leaves a document whose last member is something else to the whole parse", () => {
    const { modified, ...rest } = doc;
    expect(pluckModified(bytes({ modified, ...rest }))).toBeUndefined();
    // One level in: the tail is `"}}`, never the root's own member.
    expect(pluckModified(bytes({ ...rest, other: { modified } }))).toBeUndefined();
    // Inside a string its quotes are escaped, so no `,` or `{` stands before one.
    expect(pluckModified(bytes({ ...rest, readme: `,"modified":"${modified}"` }))).toBeUndefined();
  });
});

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createSbom } from "../src/sbom.ts";
import type { Resolution, ResolvedPackage } from "../src/resolve.ts";

function pkg(name: string, version = "1.0.0"): ResolvedPackage {
  return {
    name,
    version,
    resolved: `https://registry.test/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64, 0xa5).toString("base64")}`,
    dependencies: {},
    optional: false,
    dev: false,
    bin: {},
  };
}

const resolution: Resolution = {
  root: { name: "project", version: "0.0.0", dependencies: { demo: "1.0.0" } },
  packages: {
    "demo@1.0.0": {
      ...pkg("demo"),
      dependencies: { alias: "1.2.3+build.1", shared: "1.0.0" },
      optionalDependencies: { native: "1.0.0" },
    },
    "alias@1.2.3+build.1": {
      ...pkg("alias", "1.2.3+build.1"),
      fetchName: "@scope/package",
      dependencies: { demo: "1.0.0", shared: "2.0.0" },
      peerDependencies: { shared: "^2" },
      peers: { shared: "required" },
    },
    "shared@1.0.0": pkg("shared"),
    "shared@2.0.0": pkg("shared", "2.0.0"),
    "native@1.0.0": { ...pkg("native"), optional: true, os: ["win32"], cpu: ["arm64"] },
  },
  warnings: [],
};

describe("SBOM", () => {
  it("describes the package rather than the synthetic project, preserving identities and edges", () => {
    const bom = createSbom(resolution, "demo");
    expect(bom.specVersion).toBe("1.7");
    expect(bom.metadata.component).toMatchObject({
      "bom-ref": "demo@1.0.0",
      name: "demo",
      purl: "pkg:npm/demo@1.0.0",
      externalReferences: [
        {
          type: "distribution",
          url: resolution.packages["demo@1.0.0"]!.resolved,
          hashes: [{ alg: "SHA-512", content: "a5".repeat(64) }],
        },
      ],
    });
    expect(bom.components.map((component) => component["bom-ref"]).sort()).toEqual([
      "alias@1.2.3+build.1",
      "native@1.0.0",
      "shared@1.0.0",
      "shared@2.0.0",
    ]);
    expect(
      bom.components.find((component) => component["bom-ref"] === "alias@1.2.3+build.1"),
    ).toMatchObject({
      group: "@scope",
      name: "package",
      purl: "pkg:npm/%40scope/package@1.2.3%2Bbuild.1",
    });
    expect(
      Object.fromEntries(bom.dependencies.map(({ ref, dependsOn }) => [ref, dependsOn.sort()])),
    ).toEqual({
      "demo@1.0.0": ["alias@1.2.3+build.1", "native@1.0.0", "shared@1.0.0"],
      "alias@1.2.3+build.1": ["demo@1.0.0", "shared@2.0.0"],
      "shared@1.0.0": [],
      "shared@2.0.0": [],
      "native@1.0.0": [],
    });
    expect(bom.metadata.properties).toEqual([
      { name: "upm:sbom:scope", value: "resolved dependency tree, all platforms" },
    ]);
  });

  it.each(["1.6", "1.7"] as const)("emits the %s document header", (version) => {
    const bom = createSbom(resolution, "demo", { specVersion: version });
    expect(bom).toMatchObject({
      $schema: `https://cyclonedx.org/schema/bom-${version}.schema.json`,
      bomFormat: "CycloneDX",
      specVersion: version,
      version: 1,
      metadata: { lifecycles: [{ phase: "pre-build" }] },
    });
  });

  it("exports an explicit target with matching metadata and no dangling edges", () => {
    const bom = createSbom(resolution, "demo", {
      specVersion: "1.6",
      target: { os: "linux", cpu: "x64", libc: "musl" },
    });
    expect(bom.metadata.properties).toEqual([
      { name: "upm:sbom:scope", value: "resolved dependency tree, target platform" },
      { name: "upm:sbom:target", value: "linux/x64/musl" },
    ]);
    expect(bom.components.map((component) => component["bom-ref"]).sort()).toEqual([
      "alias@1.2.3+build.1",
      "shared@1.0.0",
      "shared@2.0.0",
    ]);
    expect(bom.dependencies.find(({ ref }) => ref === "demo@1.0.0")?.dependsOn.sort()).toEqual([
      "alias@1.2.3+build.1",
      "shared@1.0.0",
    ]);
    expect(bom.dependencies.some(({ ref }) => ref === "native@1.0.0")).toBe(false);
  });

  it("rejects a target incompatible with a required package", () => {
    const packages = {
      ...resolution.packages,
      "demo@1.0.0": { ...resolution.packages["demo@1.0.0"]!, os: ["win32"] },
    };
    expect(() =>
      createSbom({ ...resolution, packages }, "demo", {
        target: { os: "linux", cpu: "x64", libc: "glibc" },
      }),
    ).toThrow(expect.objectContaining({ code: "EBADPLATFORM" }));
  });

  it("keeps other platforms' optional packages with unusable archive hashes", () => {
    const native = { ...resolution.packages["native@1.0.0"]!, integrity: "sha512-invalid" };
    const bom = createSbom(
      { ...resolution, packages: { ...resolution.packages, "native@1.0.0": native } },
      "demo",
    );
    const entry = bom.components.find((component) => component["bom-ref"] === "native@1.0.0");
    expect(entry?.externalReferences).toEqual([{ type: "distribution", url: native.resolved }]);
    expect(bom.dependencies.find(({ ref }) => ref === "demo@1.0.0")?.dependsOn).toContain(
      "native@1.0.0",
    );
  });

  it("omits the distribution of a package without an archive", () => {
    const shared = {
      ...resolution.packages["shared@1.0.0"]!,
      resolved: "",
      integrity: "",
      local: "packages/shared",
    };
    const bom = createSbom(
      { ...resolution, packages: { ...resolution.packages, "shared@1.0.0": shared } },
      "demo",
    );
    const entry = bom.components.find((component) => component["bom-ref"] === "shared@1.0.0");
    expect(entry).toMatchObject({ name: "shared", version: "1.0.0" });
    expect(entry).not.toHaveProperty("externalReferences");
  });

  it("exports legacy archive hashes without Node or Buffer", async () => {
    const legacy: Resolution = {
      root: resolution.root,
      packages: {
        "demo@1.0.0": {
          ...pkg("demo"),
          integrity: `sha1-${Buffer.alloc(20, 0x3c).toString("base64")}`,
        },
      },
      warnings: [],
    };
    vi.resetModules();
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("Buffer", undefined);
    let bom: ReturnType<typeof createSbom>;
    try {
      const web = await import("../src/sbom.ts");
      bom = web.createSbom(legacy, "demo", { target: { os: "linux", cpu: "x64", libc: "glibc" } });
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
    expect(bom.metadata.component?.externalReferences?.[0]?.hashes).toEqual([
      { alg: "SHA-1", content: "3c".repeat(20) },
    ]);
  });
});

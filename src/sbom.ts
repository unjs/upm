import { parseIntegrity } from "./integrity.ts";
import { fromBase64 } from "./runtime.ts";
import { filterPlatform, type Platform, type Resolution, type ResolvedPackage } from "./resolve.ts";

export const SBOM = "bom.json";

/** The inspected package's resolved dependency tree. */
export function createSbom(
  resolution: Resolution,
  name: string,
  { specVersion = "1.7", target }: { specVersion?: "1.6" | "1.7"; target?: Platform } = {},
) {
  if (target) resolution = filterPlatform(resolution, target);
  const root = `${name}@${resolution.root.dependencies[name]}`;
  let subject: ReturnType<typeof component> | undefined;
  const components: ReturnType<typeof component>[] = [];
  const dependencies: { ref: string; dependsOn: string[] }[] = [];
  for (const [key, pkg] of Object.entries(resolution.packages)) {
    const value = component(key, pkg);
    if (key === root) subject = value;
    else components.push(value);
    const edges = Object.entries(pkg.dependencies);
    if (pkg.optionalDependencies) edges.push(...Object.entries(pkg.optionalDependencies));
    dependencies.push({ ref: key, dependsOn: edges.map(([n, v]) => `${n}@${v}`) });
  }
  return {
    $schema: `https://cyclonedx.org/schema/bom-${specVersion}.schema.json`,
    bomFormat: "CycloneDX",
    specVersion,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      lifecycles: [{ phase: "pre-build" }],
      tools: { components: [{ type: "application", name: "upm" }] },
      component: subject,
      properties: [
        {
          name: "upm:sbom:scope",
          value: target
            ? "resolved dependency tree, target platform"
            : "resolved dependency tree, all platforms",
        },
        ...(target
          ? [
              {
                name: "upm:sbom:target",
                value: [target.os, target.cpu, target.libc].filter(Boolean).join("/"),
              },
            ]
          : []),
      ],
    },
    components,
    dependencies,
  };
}

function component(key: string, pkg: ResolvedPackage) {
  const name = pkg.fetchName ?? pkg.name;
  const slash = name.indexOf("/");
  let hash: { alg: string; content: string } | undefined;
  // Other platforms' optional archives may have unusable integrity metadata.
  try {
    const { algorithm, digest } = parseIntegrity(pkg.integrity);
    hash = {
      alg: `SHA-${algorithm.slice(3)}`,
      content: Array.from(fromBase64(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ),
    };
  } catch {}
  return {
    "bom-ref": key,
    type: "library",
    ...(slash >= 0 && { group: name.slice(0, slash) }),
    name: name.slice(slash + 1),
    version: pkg.version,
    purl: `pkg:npm/${name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(pkg.version)}`,
    // Workspaces and links have no archive to point to.
    ...(pkg.resolved && {
      externalReferences: [
        {
          type: "distribution",
          url: pkg.resolved,
          ...(hash && { hashes: [hash] }),
        },
      ],
    }),
  };
}

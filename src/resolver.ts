// `upm/resolver`: the registry client, the resolver and the lockfile in memory. Portable: no
// Node needed, and nothing here may import the commands. Experimental: shapes may change in
// any release.
export { createRegistry } from "./registry.ts";
export type { BaseFor, Registry, RegistryOptions } from "./registry.ts";
export { resolveTree } from "./resolve.ts";
export type {
  PeerKind,
  ResolvedPackage,
  Resolution,
  ResolveOptions,
  RootManifest,
  RootSpecs,
} from "./resolve.ts";
export { formatLockfile, fromLockfile, parseLockfile, toLockfile } from "./lock.ts";
export type { Overrides } from "./overrides.ts";
export type { LockEntry, Lockfile, WorkspaceEntry } from "./lock.ts";
export { parseSpec } from "./spec.ts";
export type { PackumentView, PickOptions } from "./pick.ts";
export type { Spec } from "./spec.ts";
export type { Dist, Manifest, Packument } from "./types.ts";

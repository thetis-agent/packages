// Packages: the manifest a package ships, what an installed package looks like, and the registry record.
import type { JsonSchema } from "./messages.js";

export const SYSTEM_SCOPE = "@thetis";

export interface StepDecl {
  id: string;
  phase: string;
  export: string;
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: JsonSchema;
  export: string;
}

/** The package a fork was copied from, as it was at the time of the copy. */
export interface ForkOrigin {
  name: string;
  version: string;
}

export interface PackageSource {
  kind: "system" | "local" | "git";
  ref: string;
}

export interface ThetisField {
  type: string;
  steps?: StepDecl[];
  tools?: ToolDecl[];
  export?: string;
  /** A long-running process the userspace agent starts when the fence opens and stops on uninstall. */
  service?: { export: string };
  publish?: { port: number; to: string }[];
  /** Set on a fork. Installing a fork replaces its origin in the userspace when the origin is installed there. */
  forkedFrom?: ForkOrigin;
}

export interface Manifest {
  name: string;
  version: string;
  /** One sentence on what the package does. Shown wherever the package is listed. */
  description?: string;
  main?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  thetis: ThetisField;
}

export interface PackageInfo {
  name: string;
  version: string;
  type: string;
  description: string;
  root: string;
  thetis: ThetisField;
  /** True when every person gets this package: it is in `systemPackages["*"]`, promoted, or marked for everyone. */
  everyone?: boolean;
  forkedFrom?: ForkOrigin;
  /** The package this fork displaced in the userspace. An uninstall of the fork puts it back. */
  replaced?: string;
}

export interface PackageRecord {
  name: string;
  version: string;
  type: string;
  owner: string;
  source: PackageSource;
  userspaces: string[];
  /** A shipped system package an admin made the default: every new person's userspace is seeded with it. */
  everyone?: boolean;
  forkedFrom?: ForkOrigin;
  /** What this fork displaced, and where that came from, so an uninstall of the fork restores it exactly. */
  replaced?: string;
  replacedSource?: PackageSource;
}

/** The result of deleting a package: what went, where its files were, and what came back in its place. */
export interface DeletedPackage {
  name: string;
  path: string;
  restored?: string;
}

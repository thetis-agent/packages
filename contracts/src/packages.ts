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

export interface ThetisField {
  type: string;
  steps?: StepDecl[];
  tools?: ToolDecl[];
  export?: string;
  /** A long-running process the userspace agent starts when the fence opens and stops on uninstall. */
  service?: { export: string };
  publish?: { port: number; to: string }[];
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
}

export interface PackageRecord {
  name: string;
  version: string;
  type: string;
  owner: string;
  source: { kind: "system" | "local" | "git"; ref: string };
  userspaces: string[];
  /** A shipped system package an admin made the default: every new person's userspace is seeded with it. */
  everyone?: boolean;
}

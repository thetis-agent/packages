// The index file: the contract between the mirror and whoever searches. It lives at
// `<shared>/marketplace/index.json`: the shared directory is written by the system userspace, where the
// service runs, and read by every fence, where the gateways run. Nothing has to import this module.

export interface Registry {
  name: string;
  url: string;
}

export interface RegistryState extends Registry {
  /** The commit the mirror holds, when the last refresh succeeded. */
  commit?: string;
  /** Why the last refresh failed, when it did. The packages of the previous refresh are kept. */
  error?: string;
}

export interface IndexedPackage {
  name: string;
  version: string;
  type: string;
  description: string;
  keywords: string[];
  registry: string;
  url: string;
  /** Directory of the package inside the registry repository. */
  dir: string;
  /** The install source: `<url>#<dir>`. */
  source: string;
  steps: { id: string; phase: string }[];
  tools: string[];
  service: boolean;
}

export interface MarketplaceIndex {
  version: 1;
  updatedAt: string;
  registries: RegistryState[];
  packages: IndexedPackage[];
}

export const INDEX_FILE = "marketplace/index.json";

/** The file operations the mirror and the readers need. `StepEnv` from the kernel satisfies it. */
export interface FileEnv {
  shared: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export function indexPath(env: FileEnv): string {
  return `${env.shared.replace(/\/$/, "")}/${INDEX_FILE}`;
}

export async function readIndex(env: FileEnv): Promise<MarketplaceIndex | undefined> {
  let text: string;
  try {
    text = await env.readFile(indexPath(env));
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as MarketplaceIndex;
    return parsed && parsed.version === 1 && Array.isArray(parsed.packages) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeIndex(env: FileEnv, index: MarketplaceIndex): Promise<void> {
  return env.writeFile(indexPath(env), JSON.stringify(index, null, 2) + "\n");
}

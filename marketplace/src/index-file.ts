// The index file: the contract between the mirror and whoever searches. It lives at
// `marketplace/index.json` under the home of the userspace that runs the service (the system userspace).
// Any package or gateway in that userspace can read it by path; none has to import this module.

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

export const INDEX_PATH = "marketplace/index.json";

/** The file operations the mirror and the readers need. `StepEnv` from the kernel satisfies it. */
export interface FileEnv {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export async function readIndex(env: FileEnv): Promise<MarketplaceIndex | undefined> {
  let text: string;
  try {
    text = await env.readFile(INDEX_PATH);
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
  return env.writeFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
}

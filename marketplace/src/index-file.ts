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
  /** The commit this entry was read from. The index always shows the latest; this is what an install pins. */
  commit: string;
  /** The install source, pinned: `<url>#<dir>@<commit>`. */
  source: string;
  steps: { id: string; phase: string }[];
  tools: string[];
  service: boolean;
  /** Benchmark suites the package runs. This is how a comparison finds its peers without cloning a registry. */
  bench?: { suites: string[]; corpus?: string; peerGroup?: string };
  /** The package directory holds a `README.md`; a copy sits at `readmePath`. False or absent when it does not. */
  readme?: boolean;
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

// README copies: `<shared>/marketplace/readme/<registry>/<dir>.md`. The mirror clone lives in the system
// userspace, which no other fence can read, so a README crosses through the shared directory as the index does.

export const README_DIR = "marketplace/readme";
/** A copy holds at most this many bytes; a longer README is cut there and its last line says so. */
export const README_CAP = 262144;
export const README_TRUNCATED = "\n\n[README truncated at 256 KiB]";

/** The file name of one package's copy. A `dir` may be two levels deep; `__` keeps the copy one file. */
export const readmeFile = (dir: string): string => `${dir.replace(/\//g, "__")}.md`;

export function readmeDir(env: FileEnv, registry: string): string {
  return `${env.shared.replace(/\/$/, "")}/${README_DIR}/${registry}`;
}

export function readmePath(env: FileEnv, entry: Pick<IndexedPackage, "registry" | "dir">): string {
  return `${readmeDir(env, entry.registry)}/${readmeFile(entry.dir)}`;
}

/** The README copy of an index entry, or undefined when the entry has none or the copy cannot be read. */
export async function readReadme(env: FileEnv, entry: Pick<IndexedPackage, "registry" | "dir" | "readme">): Promise<string | undefined> {
  if (!entry.readme) return undefined;
  try {
    return await env.readFile(readmePath(env, entry));
  } catch {
    return undefined;
  }
}

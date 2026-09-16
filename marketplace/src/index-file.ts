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
  /** The local images the README shows, as written in it (`bench/x/chart.svg`); each has a copy at `readmeAssetPath`. */
  readmeAssets?: string[];
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

// README assets: the `.svg` and `.png` files a README shows with `![alt](relative path)`, copied beside the
// README copy so a package page can draw them. Same directory, the path folded into the name the way `dir` is.

/** At most this many images per README are copied; the rest render as their alt text. */
export const README_ASSET_LIMIT = 12;
/** An image above this many bytes is not copied. */
export const README_ASSET_CAP = 524288;

const IMAGE_REF = /!\[[^\]\n]*\]\(([^)\s]+)\)/g;

/**
 * A path the mirror may copy: relative, inside the package, and a picture. No scheme, no leading `/`, no
 * `..` or empty segment; the extension decides the type. Anything else is not an asset and is left alone.
 */
export function isReadmeAssetPath(path: string): boolean {
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/") || path.includes("\\")) return false;
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  return /\.(svg|png)$/i.test(path);
}

/** The local images a README refers to, in order of first appearance, deduplicated, at most `README_ASSET_LIMIT`. */
export function readmeAssetsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMAGE_REF)) {
    const path = m[1] as string;
    if (isReadmeAssetPath(path) && !out.includes(path)) out.push(path);
    if (out.length >= README_ASSET_LIMIT) break;
  }
  return out;
}

/** The media type of an asset, by its extension. */
export const readmeAssetType = (path: string): "image/svg+xml" | "image/png" => (/\.png$/i.test(path) ? "image/png" : "image/svg+xml");

/** The file name of one asset copy: `nested/memo` with `img/a.png` is `nested__memo__img__a.png`. */
export const readmeAssetFile = (dir: string, path: string): string => `${dir.replace(/\//g, "__")}__${path.replace(/\//g, "__")}`;

export function readmeAssetPath(env: FileEnv, entry: Pick<IndexedPackage, "registry" | "dir">, path: string): string {
  return `${readmeDir(env, entry.registry)}/${readmeAssetFile(entry.dir, path)}`;
}

export interface ReadmeAsset {
  type: "image/svg+xml" | "image/png";
  /** The SVG text, or the PNG as base64. */
  data: string;
}

/**
 * One asset copy of an index entry, or undefined when the entry does not list it or the copy cannot be read.
 * An SVG copy is its text; a PNG copy is stored as base64 text, because the env writes text, and is handed
 * back as it is stored.
 */
export async function readReadmeAsset(env: FileEnv, entry: Pick<IndexedPackage, "registry" | "dir" | "readmeAssets">, path: string): Promise<ReadmeAsset | undefined> {
  if (!entry.readmeAssets?.includes(path)) return undefined;
  try {
    return { type: readmeAssetType(path), data: await env.readFile(readmeAssetPath(env, entry, path)) };
  } catch {
    return undefined;
  }
}

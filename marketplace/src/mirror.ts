// Mirrors every configured registry into `marketplace/repos/<slug>` and indexes the packages it holds.
// A registry is a git repository with package directories at its first or second level. The clone runs
// through the fence's `exec`, so the mirror never leaves the userspace.

import type { ExecOptions } from "@thetis/runtime/contracts";
import { mirrorCommand, pinnedSource } from "@thetis/runtime/lib/pkg-fs";
import {
  readIndex, readmeAssetFile, readmeAssetPath, readmeAssetsOf, readmeAssetType, readmeDir, readmeFile, readmePath, README_ASSET_CAP, README_CAP, README_TRUNCATED, writeIndex,
  type FileEnv, type IndexedPackage, type MarketplaceIndex, type Registry, type RegistryState,
} from "./index-file.js";

export interface MirrorEnv extends FileEnv {
  exec(cmd: string, opts?: ExecOptions): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const REPOS_DIR = "marketplace/repos";

/** Refreshes every registry and writes the index. A registry that fails keeps its previous packages and records the error. */
export async function refresh(env: MirrorEnv, registries: Registry[]): Promise<MarketplaceIndex> {
  const previous = await readIndex(env);
  const states: RegistryState[] = [];
  const packages: IndexedPackage[] = [];
  for (const registry of registries) {
    try {
      const commit = await mirror(env, registry);
      packages.push(...(await scan(env, registry, commit)));
      states.push({ ...registry, commit });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      packages.push(...(previous?.packages ?? []).filter((p) => p.registry === registry.name));
      states.push({ ...registry, commit: previous?.registries.find((r) => r.name === registry.name)?.commit, error: message });
    }
  }
  const index: MarketplaceIndex = { version: 1, updatedAt: new Date().toISOString(), registries: states, packages };
  await writeIndex(env, index);
  return index;
}

export function slugOf(url: string): string {
  return url.replace(/\/+$/, "").split("/").pop()!.replace(/\.git$/, "").replace(/[^a-z0-9._-]/gi, "-") || "registry";
}

async function mirror(env: MirrorEnv, registry: Registry): Promise<string> {
  const dir = `${REPOS_DIR}/${slugOf(registry.url)}`;
  await run(env, `mkdir -p ${q(REPOS_DIR)} && ${mirrorCommand(registry.url, dir)}`);
  // The mirror checks out manifests alone. Widening the sparse set afterwards brings the READMEs down too, and
  // only those: a partial clone fetches the blobs it now needs and nothing else.
  await run(env, `git -C ${q(dir)} sparse-checkout add --no-cone '/*/README.md' '/*/*/README.md'`);
  return (await run(env, `git -C ${q(dir)} rev-parse HEAD`)).trim();
}

/** Every package.json with a `thetis` field at the first or second level of the clone, each with its README copied beside the index. */
async function scan(env: MirrorEnv, registry: Registry, commit: string): Promise<IndexedPackage[]> {
  const dir = `${REPOS_DIR}/${slugOf(registry.url)}`;
  const listing = await run(env, `find ${q(dir)} -mindepth 2 -maxdepth 3 \\( -name package.json -o -name README.md \\) -not -path '*/node_modules/*' | sort`);
  const files = listing.split("\n").filter(Boolean);
  // `find -name` is exact, so a `readme.md` is not a README: the copy is what a package page renders, and one name is the rule.
  const readmes = new Set(files.filter((f) => f.endsWith("/README.md")));
  const out: IndexedPackage[] = [];
  const assets: { entry: IndexedPackage; paths: string[] }[] = [];
  for (const file of files.filter((f) => f.endsWith("/package.json"))) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await env.readFile(file)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const entry = describe(manifest, registry, file.slice(dir.length + 1, -"/package.json".length), commit);
    if (!entry) continue;
    const readme = `${dir}/${entry.dir}/README.md`;
    const wanted = readmes.has(readme) ? await copyReadme(env, readme, entry) : null;
    entry.readme = Array.isArray(wanted);
    if (Array.isArray(wanted) && wanted.length) assets.push({ entry, paths: wanted });
    out.push(entry);
  }
  await copyAssets(env, dir, assets);
  await dropStaleReadmes(env, registry, out);
  return out;
}

/**
 * Copies one README into the shared directory, capped, and answers the local images it shows, which are
 * copied after the checkout has been widened to them. A README that cannot be read leaves its entry without
 * one rather than failing the registry.
 */
async function copyReadme(env: MirrorEnv, from: string, entry: IndexedPackage): Promise<string[] | false> {
  try {
    const text = capReadme(await env.readFile(from));
    await env.writeFile(readmePath(env, entry), text);
    return readmeAssetsOf(text);
  } catch {
    return false;
  }
}

/**
 * The images the READMEs of one registry show, brought down in one widening of the sparse checkout (only
 * those blobs are fetched) and copied beside the README copies. One that is missing, too large, or unreadable
 * is skipped, and the entry lists only what was copied, so a page knows which paths it can draw.
 */
async function copyAssets(env: MirrorEnv, dir: string, wanted: { entry: IndexedPackage; paths: string[] }[]): Promise<void> {
  if (!wanted.length) return;
  const files = wanted.flatMap(({ entry, paths }) => paths.map((path) => `${entry.dir}/${path}`));
  try {
    await run(env, `git -C ${q(dir)} sparse-checkout add --no-cone ${files.map((f) => q(`/${f}`)).join(" ")}`);
  } catch {
    return;
  }
  // One stat for the lot: a line per file that exists, `<bytes> <path>`; a missing one prints nothing.
  const sizes = new Map<string, number>();
  const listing = await run(env, `cd ${q(dir)} && stat -c '%s %n' -- ${files.map(q).join(" ")} 2>/dev/null || true`);
  for (const line of listing.split("\n")) {
    const at = line.indexOf(" ");
    if (at > 0) sizes.set(line.slice(at + 1), Number(line.slice(0, at)));
  }
  for (const { entry, paths } of wanted) {
    const copied: string[] = [];
    for (const path of paths) {
      const size = sizes.get(`${entry.dir}/${path}`);
      if (size === undefined || size > README_ASSET_CAP) continue;
      const from = `${dir}/${entry.dir}/${path}`;
      try {
        // The env writes text. An SVG is text; a PNG crosses as base64 and is read back as it was written.
        const body = readmeAssetType(path) === "image/png" ? (await run(env, `base64 -w0 -- ${q(from)}`)).trim() : await env.readFile(from);
        await env.writeFile(readmeAssetPath(env, entry, path), body);
        copied.push(path);
      } catch {
        continue;
      }
    }
    if (copied.length) entry.readmeAssets = copied;
  }
}

/** The first 256 KiB of a README, with a last line saying it was cut. The cap is in bytes: it bounds the file, not the text. */
export function capReadme(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.byteLength > README_CAP ? bytes.subarray(0, README_CAP).toString("utf8") + README_TRUNCATED : text;
}

/** Removes the copies of packages this registry no longer holds. The env has no directory operations, so the listing and the removal go through `exec`. */
async function dropStaleReadmes(env: MirrorEnv, registry: Registry, entries: IndexedPackage[]): Promise<void> {
  const dir = readmeDir(env, registry.name);
  const keep = new Set(entries.filter((e) => e.readme).flatMap((e) => [readmeFile(e.dir), ...(e.readmeAssets ?? []).map((p) => readmeAssetFile(e.dir, p))]));
  let listing: string;
  try {
    listing = await run(env, `[ -d ${q(dir)} ] && ls -1 ${q(dir)} || true`);
  } catch {
    return;
  }
  const stale = listing.split("\n").filter((f) => f && !keep.has(f));
  if (stale.length) await run(env, `rm -f ${stale.map((f) => q(`${dir}/${f}`)).join(" ")}`).catch(() => undefined);
}

/** One index entry from a manifest, or undefined when it is not a Thetis package. */
export function describe(m: Record<string, unknown>, registry: Registry, dir: string, commit: string): IndexedPackage | undefined {
  const thetis = m.thetis as
    | {
        type?: unknown;
        steps?: { id: string; phase: string }[];
        tools?: { name: string }[];
        service?: unknown;
        bench?: { suites?: string[]; corpus?: string; peerGroup?: string };
      }
    | undefined;
  if (typeof m.name !== "string" || typeof m.version !== "string" || !thetis || typeof thetis.type !== "string") return undefined;
  // A storage driver runs on the host and is chosen in the configuration, so it is never installable and is not offered.
  if (thetis.type === "storage") return undefined;
  return {
    name: m.name,
    version: m.version,
    type: thetis.type,
    description: typeof m.description === "string" ? m.description : "",
    keywords: Array.isArray(m.keywords) ? m.keywords.filter((k): k is string => typeof k === "string") : [],
    registry: registry.name,
    url: registry.url,
    dir,
    commit,
    // Pinned, not floating: the index is the latest, and what you installed stays what you installed.
    source: pinnedSource(registry.url, dir, commit),
    steps: (thetis.steps ?? []).map((s) => ({ id: s.id, phase: s.phase })),
    tools: (thetis.tools ?? []).map((t) => t.name),
    service: !!thetis.service,
    ...(thetis.bench?.suites?.length
      ? {
          bench: {
            suites: thetis.bench.suites,
            ...(thetis.bench.corpus ? { corpus: thetis.bench.corpus } : {}),
            ...(thetis.bench.peerGroup ? { peerGroup: thetis.bench.peerGroup } : {}),
          },
        }
      : {}),
  };
}

async function run(env: MirrorEnv, cmd: string): Promise<string> {
  const r = await env.exec(cmd, { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 500));
  return r.stdout;
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

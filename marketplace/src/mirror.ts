// Mirrors every configured registry into `marketplace/repos/<slug>` and indexes the packages it holds.
// A registry is a git repository with package directories at its first or second level. The clone runs
// through the fence's `exec`, so the mirror never leaves the userspace.

import type { ExecOptions } from "@thetis/contracts";
import { mirrorCommand, pinnedSource } from "@thetis/lib/pkg-fs";
import { readIndex, readmeDir, readmeFile, readmePath, README_CAP, README_TRUNCATED, writeIndex, type FileEnv, type IndexedPackage, type MarketplaceIndex, type Registry, type RegistryState } from "./index-file.js";

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
    entry.readme = readmes.has(readme) ? await copyReadme(env, readme, entry) : false;
    out.push(entry);
  }
  await dropStaleReadmes(env, registry, out);
  return out;
}

/** Copies one README into the shared directory, capped. A README that cannot be read leaves its entry without one rather than failing the registry. */
async function copyReadme(env: MirrorEnv, from: string, entry: IndexedPackage): Promise<boolean> {
  try {
    await env.writeFile(readmePath(env, entry), capReadme(await env.readFile(from)));
    return true;
  } catch {
    return false;
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
  const keep = new Set(entries.filter((e) => e.readme).map((e) => readmeFile(e.dir)));
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

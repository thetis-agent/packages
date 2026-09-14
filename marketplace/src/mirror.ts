// Mirrors every configured registry into `marketplace/repos/<slug>` and indexes the packages it holds.
// A registry is a git repository with package directories at its first or second level. The clone runs
// through the fence's `exec`, so the mirror never leaves the userspace.

import type { ExecOptions } from "@thetis/kernel";
import { readIndex, writeIndex, type FileEnv, type IndexedPackage, type MarketplaceIndex, type Registry, type RegistryState } from "./index-file.js";

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
      packages.push(...(await scan(env, registry)));
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
  await run(env, `rm -rf ${q(dir)} && mkdir -p ${q(REPOS_DIR)} && git clone --quiet --depth 1 ${q(registry.url)} ${q(dir)}`);
  return (await run(env, `git -C ${q(dir)} rev-parse HEAD`)).trim();
}

/** Every package.json with a `thetis` field at the first or second level of the clone. */
async function scan(env: MirrorEnv, registry: Registry): Promise<IndexedPackage[]> {
  const dir = `${REPOS_DIR}/${slugOf(registry.url)}`;
  const listing = await run(env, `find ${q(dir)} -mindepth 2 -maxdepth 3 -name package.json -not -path '*/node_modules/*' | sort`);
  const out: IndexedPackage[] = [];
  for (const file of listing.split("\n").filter(Boolean)) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await env.readFile(file)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const entry = describe(manifest, registry, file.slice(dir.length + 1, -"/package.json".length));
    if (entry) out.push(entry);
  }
  return out;
}

/** One index entry from a manifest, or undefined when it is not a Thetis package. */
export function describe(m: Record<string, unknown>, registry: Registry, dir: string): IndexedPackage | undefined {
  const thetis = m.thetis as { type?: unknown; steps?: { id: string; phase: string }[]; tools?: { name: string }[]; service?: unknown } | undefined;
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
    source: `${registry.url}#${dir}`,
    steps: (thetis.steps ?? []).map((s) => ({ id: s.id, phase: s.phase })),
    tools: (thetis.tools ?? []).map((t) => t.name),
    service: !!thetis.service,
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

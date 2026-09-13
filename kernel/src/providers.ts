import type { KernelConfig } from "./config.js";
import type { FencePool } from "./fence/pool.js";
import type { PackageManager } from "./packages/manager.js";
import { SYSTEM_USER, type ModelDescriptor, type PackageInfo, type ProviderCall, type ProviderEvent, type Userspace } from "./types.js";
import { KernelError } from "./util.js";
import type { UserspaceManager } from "./userspaces.js";

export interface ResolvedProvider {
  userspace: Userspace;
  pkg: PackageInfo;
}

const MODELS_TTL_MS = 5 * 60_000;

/**
 * Aggregates what every installed provider advertises and routes a call to the userspace
 * the provider runs in: the caller's own fence for user providers, the system fence otherwise.
 */
export class ProviderRegistry {
  private readonly models = new Map<string, { at: number; list: ModelDescriptor[] }>();

  constructor(
    private readonly config: KernelConfig,
    private readonly packages: PackageManager,
    private readonly userspaces: UserspaceManager,
    private readonly fences: FencePool,
  ) {}

  /** Providers visible to a userspace: its own first, then the system userspace's. */
  candidates(us: Userspace): ResolvedProvider[] {
    const spaces = us.id === SYSTEM_USER ? [us] : [us, this.userspaces.pathFor(SYSTEM_USER)];
    const seen = new Set<string>();
    const out: ResolvedProvider[] = [];
    for (const space of spaces) {
      if (!this.userspaces.exists(space.id)) continue;
      for (const pkg of this.packages.installed(space)) {
        if (pkg.type === "provider" && !seen.has(pkg.name)) {
          seen.add(pkg.name);
          out.push({ userspace: space, pkg });
        }
      }
    }
    return out;
  }

  async listModels(us: Userspace): Promise<ModelDescriptor[]> {
    const all: ModelDescriptor[] = [];
    for (const p of this.candidates(us)) all.push(...(await this.modelsOf(p)).map((m) => ({ ...m, provider: p.pkg.name })));
    return all;
  }

  async resolve(us: Userspace, model: string): Promise<ResolvedProvider> {
    const candidates = this.candidates(us);
    if (candidates.length === 0) throw new KernelError("no provider package is installed", "provider");
    for (const p of candidates) if ((await this.modelsOf(p)).some((m) => m.id === model)) return p;
    for (const p of candidates) if ((await this.modelsOf(p)).some((m) => m.id === "*")) return p;
    throw new KernelError(`no installed provider serves model "${model}"`, "provider");
  }

  async call(p: ResolvedProvider, call: ProviderCall, onEvent: (e: ProviderEvent) => void, signal?: AbortSignal): Promise<void> {
    await this.fences.request(p.userspace, "provider.call", this.payload(p, { call }), (e) => onEvent(e as ProviderEvent), signal);
  }

  private async modelsOf(p: ResolvedProvider): Promise<ModelDescriptor[]> {
    const key = `${p.userspace.id}:${p.pkg.name}`;
    const cached = this.models.get(key);
    if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.list;
    const list = (await this.fences.request(p.userspace, "provider.models", this.payload(p, {}))) as ModelDescriptor[];
    this.models.set(key, { at: Date.now(), list: Array.isArray(list) ? list : [] });
    return this.models.get(key)!.list;
  }

  private payload(p: ResolvedProvider, extra: Record<string, unknown>): Record<string, unknown> {
    return { package: p.pkg.name, export: p.pkg.thetis.export ?? "createProvider", config: this.config.packages[p.pkg.name] ?? {}, ...extra };
  }
}

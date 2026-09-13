import type { KernelConfig } from "./config.js";
import type { FenceHandle } from "./fence/fence.js";
import type { FencePool } from "./fence/pool.js";
import type { PackageManager } from "./packages/manager.js";
import type { PackageInfo, Userspace } from "./types.js";
import type { UserStore } from "./users.js";
import type { UserspaceManager } from "./userspaces.js";

/**
 * Starts the services that installed packages declare, inside the fence of the userspace that holds them.
 * Armed by `boot()` only, so one-shot commands never start a gateway. A service lives as long as its fence:
 * the pool calls `opened` whenever a fence opens, which covers both boot and a restart after a crash.
 */
export class ServiceSupervisor {
  private enabled = false;

  constructor(
    private readonly config: KernelConfig,
    private readonly users: UserStore,
    private readonly userspaces: UserspaceManager,
    private readonly packages: PackageManager,
    private readonly fences: FencePool,
    private readonly log: (line: string) => void,
  ) {}

  get active(): boolean {
    return this.enabled;
  }

  /** Arms the supervisor and starts every declared service, opening fences as needed. Starting twice is harmless: the agent keeps one instance per package. */
  async boot(): Promise<void> {
    this.enabled = true;
    for (const user of this.users.list()) {
      if (!this.userspaces.exists(user.id)) continue;
      const us = this.userspaces.pathFor(user.id);
      if (this.packages.installed(us).some((p) => p.thetis.service)) await this.opened(us, await this.fences.handle(us));
    }
  }

  /** Fence hook: starts every service of the userspace on the handle that just opened. */
  async opened(us: Userspace, handle: FenceHandle): Promise<void> {
    if (!this.enabled) return;
    for (const pkg of this.packages.installed(us)) if (pkg.thetis.service) await this.start(us, pkg, handle);
  }

  /** Package hook: a service package installed while the supervisor runs starts at once. */
  async installed(us: Userspace, pkg: PackageInfo): Promise<void> {
    if (this.enabled && pkg.thetis.service) await this.start(us, pkg);
  }

  /** Package hook: an uninstalled service stops before its link disappears. */
  async uninstalled(us: Userspace, pkg: PackageInfo): Promise<void> {
    if (!this.enabled || !pkg.thetis.service) return;
    await this.fences.request(us, "service.stop", { package: pkg.name }).catch((err) => this.log(`[services] ${pkg.name} in ${us.id} did not stop: ${(err as Error).message}`));
  }

  private async start(us: Userspace, pkg: PackageInfo, handle?: FenceHandle): Promise<void> {
    const payload = { package: pkg.name, export: pkg.thetis.service!.export, config: this.config.packages[pkg.name] ?? {} };
    try {
      const result = await (handle ? handle.request("service.start", payload) : this.fences.request(us, "service.start", payload));
      if (result === "started") this.log(`[services] started ${pkg.name} in ${us.id}`);
    } catch (err) {
      this.log(`[services] ${pkg.name} in ${us.id} failed to start: ${(err as Error).message}`);
    }
  }
}

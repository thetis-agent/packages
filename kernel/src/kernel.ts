import type { Fences, StoreDriver } from "@thetis/contracts";
import type { Journal } from "@thetis/lib/journal";
import type { MountStore } from "@thetis/lib/mounts";
import type { SshStore } from "@thetis/lib/ssh";
import type { RestartLatch } from "@thetis/lib/restart";
import type { UserspaceLayout } from "@thetis/lib/userspace-layout";
import type { AuthService } from "./auth.js";
import type { KernelConfig } from "./config.js";
import type { PackageManager } from "./packages/manager.js";
import type { PackageRegistry } from "./packages/registry.js";
import type { ProviderRegistry } from "./providers.js";
import type { ServiceSupervisor } from "./services.js";
import type { SessionApi } from "./sessions/api.js";
import type { ConfigService } from "./settings.js";
import type { UserStore } from "./users.js";

/**
 * One running kernel, as the operator table and the gateways see it. The composition root that builds
 * it lives outside this package, so the kernel never depends on the code that wires it.
 */
export interface KernelServices {
  config: KernelConfig;
  users: UserStore;
  auth: AuthService;
  services: ServiceSupervisor;
  userspaces: UserspaceLayout;
  /** The host paths an admin has granted into each person's fence. */
  mounts: MountStore;
  ssh: SshStore;
  packages: PackageManager;
  registry: PackageRegistry;
  providers: ProviderRegistry;
  sessions: SessionApi;
  /** Per-package configuration: the layers, who may set what, and what a package's code receives. */
  settings: ConfigService;
  /** The service plane's document store. The kernel holds the driver's interface only; the host loaded it. */
  store: StoreDriver;
  fences: Fences;
  journal: Journal;
  /** The latch behind a restart Thetis can ask for. Arming is not restarting: only the serving daemon acts on it. */
  restart: RestartLatch;
  /** What the deployed systemd unit says a clean exit means, or null when that could not be read. A host fact, injected. */
  restartPolicy(): string | null;
  /** Removes the user, closes its fence, forgets its packages, and deletes its userspace directory. */
  removeUser(id: string): Promise<void>;
  /** Closes every fence, writes out every record, and closes the store. */
  shutdown(): Promise<void>;
}

import { AuthService } from "./auth.js";
import { Container, token } from "./container.js";
import type { KernelConfig } from "./config.js";
import { createControlHandler } from "./control.js";
import type { Fence, KernelRpc } from "./fence/fence.js";
import { ProcessFence } from "./fence/process-fence.js";
import { FencePool } from "./fence/pool.js";
import { PackageManager } from "./packages/manager.js";
import { PackageRegistry } from "./packages/registry.js";
import { Enumerator } from "./pipeline/enumerator.js";
import { ProviderCallStep } from "./pipeline/provider-call.js";
import { PipelineRunner } from "./pipeline/runner.js";
import { ProviderRegistry } from "./providers.js";
import { createRpcHandler } from "./rpc.js";
import { ServiceSupervisor } from "./services.js";
import { SessionApi } from "./sessions/api.js";
import { SessionStore } from "./sessions/store.js";
import { SYSTEM_USER } from "./types.js";
import { mkdirSync } from "node:fs";
import { UserStore } from "./users.js";
import { UserspaceManager } from "./userspaces.js";

/** Tokens for every kernel service. Bind a different factory to replace a component. */
export const T = {
  config: token<KernelConfig>("config"),
  log: token<(line: string) => void>("log"),
  users: token<UserStore>("users"),
  auth: token<AuthService>("auth"),
  services: token<ServiceSupervisor>("services"),
  userspaces: token<UserspaceManager>("userspaces"),
  fence: token<Fence>("fence"),
  fences: token<FencePool>("fences"),
  registry: token<PackageRegistry>("registry"),
  packages: token<PackageManager>("packages"),
  providers: token<ProviderRegistry>("providers"),
  sessionStore: token<SessionStore>("sessionStore"),
  enumerator: token<Enumerator>("enumerator"),
  providerCall: token<ProviderCallStep>("providerCall"),
  runner: token<PipelineRunner>("runner"),
  sessions: token<SessionApi>("sessions"),
};

export interface Kernel {
  config: KernelConfig;
  users: UserStore;
  auth: AuthService;
  services: ServiceSupervisor;
  userspaces: UserspaceManager;
  packages: PackageManager;
  providers: ProviderRegistry;
  sessions: SessionApi;
  fences: FencePool;
  container: Container;
  removeUser(id: string): Promise<void>;
  shutdown(): Promise<void>;
}

/** Composition root. `configure` may rebind any token before services are resolved. */
export function createKernel(config: KernelConfig, configure?: (c: Container) => void): Kernel {
  const c = new Container();
  c.bind(T.config, () => config);
  c.bind(T.log, () => (line: string) => process.stderr.write(line + "\n"));
  c.bind(T.users, (c) => new UserStore(c.get(T.config).home));
  c.bind(T.auth, (c) => new AuthService(c.get(T.config).home, c.get(T.users)));
  c.bind(T.userspaces, (c) => new UserspaceManager(c.get(T.config).home));
  c.bind(T.fence, (c) => {
    const cfg = c.get(T.config);
    return new ProcessFence({ agentPath: cfg.agentPath, sandbox: cfg.fence.sandbox, readOnly: cfg.fence.readOnly, hidden: cfg.fence.hidden, requestTimeoutMs: cfg.requestTimeoutMs, log: c.get(T.log) });
  });
  // The operator table is the control handler's; the RPC handler admits it to the system fence for admins only.
  const operator: KernelRpc = (method, args, emit) => createControlHandler(kernel)(method, args, emit);
  c.bind(T.fences, (c) => new FencePool(c.get(T.fence), (us) => createRpcHandler(us, c.get(T.users), c.get(T.packages), c.get(T.sessions), c.get(T.auth), operator), (us, h) => c.get(T.services).opened(us, h)));
  c.bind(T.services, (c) => new ServiceSupervisor(c.get(T.config), c.get(T.users), c.get(T.userspaces), c.get(T.packages), c.get(T.fences), c.get(T.log)));
  c.bind(T.registry, (c) => new PackageRegistry(c.get(T.config).home));
  c.bind(T.packages, (c) => new PackageManager(c.get(T.config), c.get(T.registry), c.get(T.fences)));
  c.bind(T.providers, (c) => new ProviderRegistry(c.get(T.config), c.get(T.packages), c.get(T.userspaces), c.get(T.fences)));
  c.bind(T.sessionStore, () => new SessionStore());
  c.bind(T.enumerator, (c) => new Enumerator(c.get(T.config), c.get(T.fences)));
  c.bind(T.providerCall, (c) => new ProviderCallStep(c.get(T.config), c.get(T.providers), c.get(T.fences)));
  c.bind(T.runner, (c) => new PipelineRunner(c.get(T.config), c.get(T.enumerator), c.get(T.providerCall), c.get(T.packages), c.get(T.fences), c.get(T.sessionStore)));
  c.bind(T.sessions, (c) => new SessionApi(c.get(T.users), c.get(T.userspaces), c.get(T.packages), c.get(T.sessionStore), c.get(T.runner)));
  configure?.(c);

  const users = c.get(T.users);
  const sessions = c.get(T.sessions);
  c.get(T.packages).observe(c.get(T.services));
  mkdirSync(config.promotedPackagesDir, { recursive: true });
  sessions.userspaceFor(users.authorize(SYSTEM_USER));

  const kernel: Kernel = {
    config,
    users,
    auth: c.get(T.auth),
    services: c.get(T.services),
    userspaces: c.get(T.userspaces),
    packages: c.get(T.packages),
    providers: c.get(T.providers),
    sessions,
    fences: c.get(T.fences),
    container: c,
    async removeUser(id) {
      users.remove(id);
      await c.get(T.fences).close(id);
      c.get(T.registry).forgetUserspace(id);
      c.get(T.userspaces).remove(id);
    },
    shutdown: () => c.get(T.fences).close(),
  };
  return kernel;
}

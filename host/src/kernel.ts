import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { SYSTEM_USER, type Fence, type KernelRpc, type SessionRecord, type Userspace } from "@thetis/contracts";
import {
  AuthService, createControlHandler, createRpcHandler, Enumerator, PackageManager, PackageRegistry, PipelineRunner, ProviderCallStep,
  ProviderRegistry, ServiceSupervisor, SessionApi, SESSION_ID, UserStore, type KernelConfig, type KernelServices,
} from "@thetis/kernel";
import { Container, token } from "@thetis/lib/container";
import { Journal } from "@thetis/lib/journal";
import { JsonDirStore } from "@thetis/lib/json-store";
import { MountStore } from "@thetis/lib/mounts";
import { RestartLatch } from "@thetis/lib/restart";
import { UserspaceLayout } from "@thetis/lib/userspace-layout";
import { Cgroups, FencePool, ProcessFence } from "@thetis/sandbox";
import { deployedRestartPolicy } from "./policy.js";

/** Tokens for every service. Bind a different factory to replace a component. */
export const T = {
  config: token<KernelConfig>("config"),
  log: token<(line: string) => void>("log"),
  users: token<UserStore>("users"),
  auth: token<AuthService>("auth"),
  services: token<ServiceSupervisor>("services"),
  userspaces: token<UserspaceLayout>("userspaces"),
  mounts: token<MountStore>("mounts"),
  fence: token<Fence>("fence"),
  fences: token<FencePool>("fences"),
  registry: token<PackageRegistry>("registry"),
  packages: token<PackageManager>("packages"),
  providers: token<ProviderRegistry>("providers"),
  sessionStore: token<JsonDirStore<SessionRecord>>("sessionStore"),
  enumerator: token<Enumerator>("enumerator"),
  providerCall: token<ProviderCallStep>("providerCall"),
  runner: token<PipelineRunner>("runner"),
  sessions: token<SessionApi>("sessions"),
  journal: token<Journal>("journal"),
  restart: token<RestartLatch>("restart"),
  cgroups: token<Cgroups | undefined>("cgroups"),
};

export interface Kernel extends KernelServices {
  /** The container, for tests and tools that look inside. */
  container: Container;
}

/** Composition root. `configure` may rebind any token before services are resolved. */
export function createKernel(config: KernelConfig, configure?: (c: Container) => void): Kernel {
  const c = new Container();
  bindServices(c, config);
  configure?.(c);
  const kernel = kernelOf(c);
  kernel.packages.observe(kernel.services);
  mkdirSync(config.promotedPackagesDir, { recursive: true });
  mkdirSync(config.sharedDir, { recursive: true });
  kernel.sessions.userspaceFor(kernel.users.authorize(SYSTEM_USER));
  return { ...kernel, container: c };
}

function bindServices(c: Container, config: KernelConfig): void {
  c.bind(T.config, () => config);
  c.bind(T.log, () => (line: string) => process.stderr.write(line + "\n"));
  c.bind(T.users, (c) => new UserStore(c.get(T.config).home));
  c.bind(T.auth, (c) => new AuthService(c.get(T.config).home, c.get(T.users)));
  c.bind(T.mounts, (c) => new MountStore(c.get(T.config).home));
  // Every Userspace the layout hands out carries its mounts, so the fence binds them wherever it is opened from.
  c.bind(T.userspaces, (c) => new UserspaceLayout(c.get(T.config).home, (id) => c.get(T.mounts).get(id)));
  c.bind(T.journal, (c) => new Journal(c.get(T.config).home));
  c.bind(T.cgroups, (c) => (c.get(T.config).fence.sandbox === "none" ? undefined : Cgroups.detect(c.get(T.log))));
  c.bind(T.fence, (c) => processFence(c));
  c.bind(T.fences, (c) => new FencePool(c.get(T.fence), (us) => rpcFor(c, us), (us, h) => c.get(T.services).opened(us, h)));
  c.bind(T.services, (c) => {
    return new ServiceSupervisor(c.get(T.config), c.get(T.users), c.get(T.userspaces), c.get(T.packages), c.get(T.fences), c.get(T.log), c.get(T.journal));
  });
  c.bind(T.registry, (c) => new PackageRegistry(c.get(T.config).home));
  c.bind(T.packages, (c) => new PackageManager(c.get(T.config), c.get(T.registry), c.get(T.fences)));
  c.bind(T.providers, (c) => new ProviderRegistry(c.get(T.config), c.get(T.packages), c.get(T.userspaces), c.get(T.fences)));
  c.bind(T.sessionStore, () => new JsonDirStore<SessionRecord>(SESSION_ID));
  c.bind(T.enumerator, (c) => new Enumerator(c.get(T.config), c.get(T.fences)));
  c.bind(T.providerCall, (c) => new ProviderCallStep(c.get(T.config), c.get(T.providers), c.get(T.fences)));
  c.bind(T.runner, (c) => {
    return new PipelineRunner(c.get(T.config), c.get(T.enumerator), c.get(T.providerCall), c.get(T.packages), c.get(T.fences), c.get(T.sessionStore), c.get(T.journal));
  });
  c.bind(T.sessions, (c) => new SessionApi(c.get(T.users), c.get(T.userspaces), c.get(T.packages), c.get(T.sessionStore), c.get(T.runner)));
  // Armed here, fired nowhere: only `serve()` registers a handler, and the latch refuses to arm without one,
  // so a kernel built by `thetis send`, `thetis chat` or the bench cannot be talked into killing its command.
  // The deployed policy is a host fact and is read here, in the daemon: a tool inside a fence sees neither the
  // cgroup it is in nor systemd, and would have to take the unit file in the checkout on trust.
  c.bind(T.restart, (c) => new RestartLatch({ config: c.get(T.config).control, inFlight: () => c.get(T.sessions).inFlight(), policy: deployedRestartPolicy }));
}

/** The process fence, configured from `config.fence`. The resolver file lives next to the rest of the data. */
function processFence(c: Container): ProcessFence {
  const cfg = c.get(T.config);
  return new ProcessFence({
    agentPath: cfg.agentPath,
    sandbox: cfg.fence.sandbox,
    network: cfg.fence.network,
    limits: cfg.fence.limits,
    readOnly: cfg.fence.readOnly,
    hidden: cfg.fence.hidden,
    sharedDir: cfg.sharedDir,
    resolvConf: resolve(cfg.home, "fence-resolv.conf"),
    cgroups: () => c.get(T.cgroups),
    requestTimeoutMs: cfg.requestTimeoutMs,
    log: c.get(T.log),
  });
}

/**
 * The kernel as one fence sees it. The services are resolved when the fence opens, not when the pool is
 * built, which breaks the cycle between the pool and the session API. The operator table is admitted to
 * an admin's fence by the RPC handler; the kernel checks the role.
 */
function rpcFor(c: Container, us: Userspace): KernelRpc {
  const operator = createControlHandler(kernelOf(c));
  const models = async (space: Userspace) => ({ model: c.get(T.config).model, models: await c.get(T.providers).listModels(space) });
  return createRpcHandler(us, c.get(T.users), c.get(T.packages), c.get(T.sessions), c.get(T.auth), operator, models);
}

/** Every service of one container, as the kernel interface. Resolving them here is what boots the kernel. */
function kernelOf(c: Container): KernelServices {
  return {
    config: c.get(T.config),
    users: c.get(T.users),
    auth: c.get(T.auth),
    services: c.get(T.services),
    userspaces: c.get(T.userspaces),
    mounts: c.get(T.mounts),
    packages: c.get(T.packages),
    registry: c.get(T.registry),
    providers: c.get(T.providers),
    sessions: c.get(T.sessions),
    fences: c.get(T.fences),
    journal: c.get(T.journal),
    restart: c.get(T.restart),
    restartPolicy: deployedRestartPolicy,
    async removeUser(id) {
      c.get(T.users).remove(id);
      await c.get(T.fences).close(id);
      c.get(T.registry).forgetUserspace(id);
      c.get(T.mounts).set(id, []);
      c.get(T.userspaces).remove(id);
    },
    shutdown: () => c.get(T.fences).close(),
  };
}

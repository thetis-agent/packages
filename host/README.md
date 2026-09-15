# @thetis/host

The composition root: what a process that runs Thetis needs. `createKernel` wires the kernel's classes to the sandbox through a small container, and `controlSocketPath` and `ControlServer` give the command line its socket. It runs in the host process. `@thetis/gateway-cli` and the bench runner build their kernel with it.

## What it provides

A library: nothing in `thetis`. Not installable.

The layering rule: `host` is the top of the service plane and imports `@thetis/contracts`, `@thetis/lib`, `@thetis/sandbox`, and `@thetis/kernel`. Nothing in the service plane imports the host; `@thetis/gateway-cli` and `@thetis/bench` do. The test `packages/kernel/test/boundaries.test.ts` enforces the rule.

The exports: `createKernel`, the token table `T`, the type `Kernel`, `controlSocketPath`, `ControlServer` (the `RpcSocketServer` of `@thetis/lib`), and, re-exported from the kernel so a host process need not import it, `defaultConfig`, `configPath`, `loadConfig`, and `KernelConfig`.

The tokens in `T`: `config`, `log`, `users`, `auth`, `services`, `userspaces`, `mounts`, `fence`, `fences`, `registry`, `packages`, `providers`, `sessionStore`, `enumerator`, `providerCall`, `runner`, `sessions`, `journal`, `cgroups`.

`createKernel(config, configure?)` binds every token, runs `configure`, resolves the services, creates the promoted and shared directories, and makes sure the system userspace exists. It returns a `Kernel`: the `KernelServices` of the kernel (`config`, `users`, `auth`, `services`, `userspaces`, `mounts`, `packages`, `registry`, `providers`, `sessions`, `fences`, `journal`, `removeUser`, `shutdown`) plus `container`. `removeUser(id)` deletes the user record, closes its fence, forgets its packages and mounts, and deletes its userspace directory, sessions and packages included. `shutdown()` closes every fence.

## Use

Replace a component by rebinding its token before the services resolve:

```ts
import { createKernel, T } from "@thetis/host";

const kernel = createKernel(config, (c) => {
  c.bind(T.fence, () => new MyMicroVmFence());
  c.bind(T.log, () => (line) => logger.info(line));
});
```

Serve the control socket and start every installed service, the way `thetis serve` does:

```ts
import { ControlServer, controlSocketPath, createKernel, loadConfig } from "@thetis/host";
import { createControlHandler } from "@thetis/kernel";

const config = loadConfig(home, projectRoot);
const kernel = createKernel(config);
const control = new ControlServer(controlSocketPath(config.home), createControlHandler(kernel));
await control.listen();
await kernel.services.boot();
```

The socket is `$THETIS_HOME/thetis.sock`, mode `0600`. Anyone who can open it is an operator.

## Files

| File | Content |
|---|---|
| `src/kernel.ts` | `createKernel`, `T`, `Kernel`. The bindings, the process fence from `config.fence`, and the RPC handler a fence gets when it opens. |
| `src/control.ts` | `controlSocketPath`. |
| `src/index.ts` | Re-exports, and `ControlServer`. |
| `test/e2e.test.ts` | The end-to-end suite. |
| `test/fixtures/` | `provider-echo`, a deterministic provider, and the `ui-good`, `ui-bad`, and `ui-dup` packages the web gateway's tests use. |

## Tests

`npm test` from the runtime root builds and runs every suite. The suite of this package is `packages/host/test/e2e.test.ts`: a real kernel with the real `ProcessFence` and userspace agent and the echo provider, no network. It covers seeding, the prompt and tool steps, the tool loop, a package written into the userspace and live on the next turn, scope and visibility between users, promotion, git installs, operator methods from a fence, cancel, RPC identity, the control socket, suspension, fence isolation, forks, and mounts. To run it alone after `npm run build`: `node --test packages/host/dist/test/e2e.test.js`. Set `THETIS_TEST_SANDBOX=none` to run it without bubblewrap.

See docs/02-kernel.md in the runtime repository.

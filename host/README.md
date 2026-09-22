# @thetis/host

The composition root: what a process that runs Thetis needs. `createKernel` wires the kernel's classes to the sandbox through a small container, loads the storage driver and the host packages, and `controlSocketPath` and `ControlServer` give the command line its socket. It runs in the host process. It is a daemon package: loaded once, held for the process's life, and changed only for its own bugs. `@thetis/gateway-cli` and the bench runner build their kernel with it.

## What it provides

A library: nothing in `thetis`. Not installable.

The layering rule: `host` is the top of the service plane and imports `@thetis/contracts`, `@thetis/lib`, `@thetis/sandbox`, and `@thetis/kernel`. Nothing in the service plane imports the host; `@thetis/gateway-cli` and `@thetis/bench` do. The test `packages/kernel/test/boundaries.test.ts` enforces the rule.

The exports: `createKernel`, the token table `T`, the type `Kernel`, `controlSocketPath`, `ControlServer` (the `RpcSocketServer` of `@thetis/lib`), `loadStoreDriver`, `loadHostPackage`, `openRecords`, `Records`, `migrateStore`, `assertMigrated`, `LEGACY_FILES`, `MigrationReport`, and, re-exported from the kernel so a host process need not import it, `defaultConfig`, `configPath`, `loadConfig`, and `KernelConfig`.

The tokens in `T`: `config`, `log`, `store`, `records`, `env`, `settings`, `users`, `auth`, `services`, `userspaces`, `mounts`, `fence`, `fences`, `registry`, `packages`, `providers`, `sessionStore`, `enumerator`, `runner`, `sessions`, `journal`, `restart`, `cgroups`, `hostExtensions`. `store` is the storage driver, unbound until `createKernel` loads the package `storage.driver` names; a test binds `memoryStore()` from `@thetis/lib/store` instead. `records` holds the `StoreMirror`s (`users`, `credentials`, `tokens`, `registry`, `mounts`, `ssh`). `env` is the `EnvFile` the configuration references resolve against; `settings` the `ConfigService`.

`createKernel(config, configure?)` is asynchronous. It refuses to run while a legacy record file is in the home (`assertMigrated`), binds every token, runs `configure`, loads and probes the driver when `T.store` is still unbound (`loadStoreDriver`: the package is found among the shipped and the promoted packages, its type must be `storage`, and one write and read under `<home>/store/_probe` must succeed), opens the records, binds `hostExtensions` (the `HostExtensions` service the kernel's control handler dispatches `host.<name>.<export>` to: `loadHostPackage(name)` finds a package of type `host` among the shipped and the promoted packages by its `thetis.host.name`, never in a userspace, imports its entry with a modification-time query so an edit is live on its next call, and hands each export the `HostEnv` built from the records, the journal and the fences), resolves the services, wires the package listeners (the supervisor; a hook that clears a deleted package's configuration layer and `env.storage()` documents; a hook that copies the system-layer configuration on promote) and the configuration listener (forget the userspace's providers, restart the affected services in place), creates the promoted and shared directories, and makes sure the system userspace exists. It returns a `Kernel`: the `KernelServices` of the kernel (`config`, `users`, `auth`, `services`, `userspaces`, `mounts`, `packages`, `registry`, `providers`, `sessions`, `settings`, `store`, `fences`, `journal`, `restart`, `restartPolicy`, `removeUser`, `shutdown`) plus `container`. `removeUser(id)` deletes the user record, forgets its password and every token it had (`auth.forget`), closes its fence, forgets its packages, mounts and ssh grants, clears its configuration namespaces and its `userspaces/<id>` store tree, deletes its userspace directory, sessions and packages included, deletes the two host directories keyed by the id (`fence-ssh/<id>` and the private keys under `fence-keys/<id>`), and drops the cached model list. Nothing keyed to the id survives it, because the id can be added again and whoever is given it next is a different person. `shutdown()` closes every fence, flushes the record mirrors, and closes the driver.

## Use

Replace a component by rebinding its token before the services resolve:

```ts
import { createKernel, T } from "@thetis/host";

const kernel = await createKernel(config, (c) => {
  c.bind(T.fence, () => new MyMicroVmFence());
  c.bind(T.log, () => (line) => logger.info(line));
});
```

Serve the control socket and start every installed service, the way `thetis serve` does:

```ts
import { ControlServer, controlSocketPath, createKernel, loadConfig } from "@thetis/host";
import { createControlHandler } from "@thetis/kernel";

const config = loadConfig(home, projectRoot);
const kernel = await createKernel(config);
const control = new ControlServer(controlSocketPath(config.home), createControlHandler(kernel));
await control.listen();
await kernel.services.boot();
```

The socket is `$THETIS_HOME/thetis.sock`, mode `0600`. Anyone who can open it is an operator.

## Files

| File | Content |
|---|---|
| `src/kernel.ts` | `createKernel`, `T`, `Kernel`. The bindings, the process fence from `config.fence`, the RPC handler a fence gets when it opens, the package and configuration listeners. |
| `src/store.ts` | `loadStoreDriver`, `loadHostPackage`, `openRecords`, `flushRecords`, `Records`. The storage driver and the host packages are loaded here, on the host; the kernel holds only their interfaces. |
| `src/migrate.ts` | `assertMigrated`, `migrateStore`, `LEGACY_FILES`: the four JSON record files into the store, each renamed `.migrated`. |
| `src/control.ts` | `controlSocketPath`. |
| `src/index.ts` | Re-exports, and `ControlServer`. |
| `test/e2e.test.ts` | The end-to-end suite. |
| `test/fixtures/` | `provider-echo`, a deterministic provider, and the `ui-good`, `ui-bad`, and `ui-dup` packages the web gateway's tests use. |

## Tests

`npm test` from the runtime root builds and runs every suite. The suite of this package is `packages/host/test/e2e.test.ts`: a real kernel with the real `ProcessFence` and userspace agent and the echo provider, no network. It covers seeding, the prompt and tool steps, the tool loop, a package written into the userspace and live on the next turn, scope and visibility between users, promotion, git installs, operator methods from a fence, cancel, RPC identity, the control socket, suspension, fence isolation, forks, mounts, a live `config.set` reaching a provider and restarting a service in place, `env.storage()` with its clearing on delete and on user removal, a removal taking the password, the tokens and the held keys with it so the id comes back with no password, a secret reaching a tool and nothing else, a fork inheriting its origin's key, the `0600` modes under `store/auth` and `store/secrets`, and `migrate`. To run it alone after `npm run build`: `node --test packages/host/dist/test/e2e.test.js`. Set `THETIS_TEST_SANDBOX=none` to run it without bubblewrap.

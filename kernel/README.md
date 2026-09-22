# @thetis/kernel

The daemon's authority: who may do what, and the fixed seams everything else crosses. It runs in the host process, is loaded once, and is held for the process's life.

## What the daemon is, and is not

The daemon is identity, package authority, the fence, the pipe, the record, the port, the latch:

| Part | What it holds |
|---|---|
| Identity | Users, roles, passwords, tokens; every call is authorized against a user. |
| Package authority | Which packages a userspace has, who may install what, promotion, forks. |
| The fence | One sandbox per userspace, opened and closed by the kernel, never entered by it. |
| The pipe | The steps of a turn, sent into the caller's fence in order, their results validated and applied, their events relayed. |
| The record | Sessions, configuration layers, grants, the journal. |
| The port | The door for browsers and the control socket for the command line. |
| The latch | The daemon's own quiet-wait restart, `thetis restart`, under systemd, without sudo. |

It runs steps and relays their events. It never makes a model call, never runs a tool, never interprets a `ProviderCall`, and never knows a package by name: the model-call loop is the `call` step of `@thetis/harness-core` in the `execute` phase, a tool runs inside that step, a provider request goes through the fence-to-kernel method `providers.call` and is routed by `call.model` to the provider's fence, and every per-package default is declared in that package's manifest. `defaultConfig().packages` is `{}`.

Every seam has a fixed shape and opaque contents, and is extended only by optional fields the daemon passes through. The frozen seams:

| Seam | The list |
|---|---|
| Fence operations, kernel to agent | `ping`, `exec`, `step`, `enumerate`, `service.start`, `service.stop`, `shutdown`, `provider.models`, `provider.call`. |
| Fence-to-kernel methods | The cases of `createRpcHandler` in `src/rpc.ts`: `packages.*`, `sessions.*` (`delete` included), `models`, `providers.call`, `store.*` under the fence's own namespace, `config.*` at the fence's own layer, `auth.*`. |
| Control methods | The cases of `createControlHandler` in `src/control.ts`: `users.*`, `packages.*`, `config.*`, `sessions.*`, `fence.reload`, `restart.*`, `status`, `journal.tail`, `models`, `ping`, and the `default` branch, which dispatches `host.<package>.<export>` to a host package. |
| The door's routes | `/`, `/login*`, `/logout`, `/<user>/*`. |
| The shapes | `StepContext`, `StepResult`, `ProviderCall`, `ToolSpec`, `TurnEvent`. |

`packages/kernel/test/boundaries.test.ts` snapshots these lists, so a change to any of them is a deliberate edit of a list and never a side effect.

How a new need is met:

- A capability (a tool, a step, a provider, a service, a page) is a package. The next call has it; a service's module graph or a provider needs `thetis reload --user <id>`.
- A setting is a manifest declaration under `thetis.config`, read live; a change to `thetis.config.json` is `thetis config reload`.
- An admin feature that needs the host itself (its filesystem, its key store, the grant records) is a package of type `host`, such as `@thetis/host-grants`, which the host loads by `thetis.host.name` from the checkout or the promoted packages and re-imports whenever its entry changes; it answers `host.<name>.<export>` over the operator channel, and an edit to it is live on its next call.
- A new daemon process is for the daemon's own bugs only, and the daemon does it itself: `thetis restart`.

A feature that seems to need the daemon is a feature in the wrong package.

## What it provides

A library: nothing in `thetis`. Not installable. The kernel must stay under the line count its guard sets, stated only in `test/loc.test.ts`, and the guard ratchets down: the kernel may shrink and not grow.

The layering rule: `kernel` imports `@thetis/contracts` and `@thetis/lib`, never `@thetis/sandbox` or `@thetis/host`. It depends on the interface `Fences` from the contracts; the host binds the sandbox to it. Only `@thetis/host` and `@thetis/gateway-cli` may import the kernel. The test `packages/kernel/test/boundaries.test.ts` enforces the rule.

| Class or export | Responsibility |
|---|---|
| `UserStore` | User records in the store namespace `users`, and `authorize`. |
| `AuthService` | Passwords (scrypt) and login tokens in the private store namespaces `auth/credentials` and `auth/tokens`. |
| `ConfigService`, `Settings` | Per-package configuration: the four layers along the fork chain, who may set what, secrets, the journal rows, and which fences a change reaches. `Settings` is the one method a dispatch site needs, `effective`. |
| `ServiceSupervisor` | Starts, stops, and restarts in place the services that packages declare. |
| `PackageRegistry`, `PackageManager`, `readManifest`, `validateManifest` | Package records, ownership and peer checks, seeding, promotion, install and uninstall, forks. |
| `ProviderRegistry` | Provider discovery and model resolution: which fence serves `call.model`. |
| `SessionApi` | The session API for gateways. Every call is authorized against a user. |
| `Enumerator`, `PipelineRunner` | The step list, and one turn: each step into the caller's fence, its result validated and applied, its events relayed. |
| `createRpcHandler` | The methods a fence can call on the kernel, `providers.call`, `store.*` under the fence's own namespace and `config.*` at the fence's own layer included. |
| `createControlHandler`, `redact` | The operator methods of the control socket, also reachable from an admin's fence as `operator.<method>`, and the dispatch of `host.<package>.<export>` to a host package. |
| `KernelError` | `CodedError` from `@thetis/lib/error`, with a `code` such as `invalid`, `unauthorized`, `not-found`, `busy`, `cancelled`, `fence`, `package`, `provider`, `step`, `tool`, `rpc`, `storage`. |

## Configuration

`KernelConfig` is loaded by `loadConfig(home, projectRoot)`: the defaults from `defaultConfig`, then `$THETIS_HOME/thetis.config.json` over them, then every `${NAME}` in a string replaced from the environment, except under `packages`, which keeps its references for the config service to resolve at read time. The fields are `model`, `phases` (default `["history", "prompt", "tools", "call", "execute", "after"]`), `enumerator`, `systemPackages`, `packages` (the file layer of per-package configuration; the defaults are `{}`), `storage` (`{ driver }`), `fence`, `door`, `control`, and `requestTimeoutMs`, plus the derived paths `home`, `systemPackagesDir`, `promotedPackagesDir`, `sharedDir`, `agentPath`, and `envFile`. `packagesLayer(home)` reads the `packages` layer again for `config.reload`. `saveConfig` writes the file without the derived paths; only `thetis init` calls it.

`CONFIG_TIERS` declares per key what a change takes: `dispatch` keys are live on `thetis config reload`, `fence` keys reopen every fence, `boot` keys (`door`, `storage`) want a new process. The `RestartLatch` reads `control` through the configuration reference on each use, so `control.*` is live too.

A package's code receives `ConfigService.effective(userspace, name)`: the declared defaults from the manifest, the file layer, the system layer and the person's layer merged along the fork chain, secrets included, `${NAME}` references resolved from the process environment and the `.env` file as they are now. Plain-object values merge one level deep across layers, so a file layer `embeddings: { baseUrl }` keeps a declared `embeddings.apiKey`; arrays and scalars replace. The layers live in the store (`config/*`, `secrets/*`); `LayeredConfig` in `@thetis/lib/config` is the mechanism and this package decides who may write which layer. The declaration fields are in `packages/contracts/src/config.ts`.

## Use

A host process builds a kernel through `@thetis/host` and reaches this package's classes on it:

```ts
import { createKernel } from "@thetis/host";
import { loadConfig } from "@thetis/kernel";

const kernel = await createKernel(loadConfig(home, projectRoot));
const ref = kernel.sessions.create("alice");
for await (const event of kernel.sessions.send("alice", ref.id, "hello")) {
  if (event.type === "text") process.stdout.write(event.delta);
}
await kernel.shutdown();
```

`SessionApi`: `create(userId, { parent? })`, `send(userId, sessionId, input)` as an `AsyncIterable<TurnEvent>`, `ask` for the final text, `cancel`, `delete`, `inspect`, `list`. A session runs one turn at a time; a second `send` fails with the code `busy`. A session is found only in the caller's own userspace.

The rules the kernel enforces on every call: an unknown or suspended user is rejected; RPC from a fence acts as the fence's own user and no argument can name another; `auth.login` is answered only for the system userspace; a user installs only into `@<own id>/*` and only admins install `@thetis/*`; an operator method from a fence needs an admin, except `fence.reload` naming the caller's own id, which anyone may ask for; a `host.*` call needs an admin or the control socket and is journalled without its arguments.

`status` answers `{ daemon, restart, workspaces }`. A workspace entry is `{ user, openedAt, codeAt, stale, services, changed }`, and `changed` is `[{ name, loaded, onDisk }]`: every installed package whose open fence read a version other than the one on disk now. It is empty when none differ and when no fence is open. The same fact rides on each package a caller is listed (`packages.list`, from the control socket or from a fence) as `PackageInfo.loadedVersion`, which the pool records when a fence opens and forgets when it closes, and which is never set on the system-wide registry record. This is what makes a change to a package shipped with the service visible: its files are installed the moment they land, so nothing is behind a registry, and what puts the new version into service is a workspace reload.

## Files

| File | Content |
|---|---|
| `src/kernel.ts` | `KernelServices`, the interface of one running kernel. |
| `src/config.ts` | `KernelConfig`, `defaultConfig`, `loadConfig`, `saveConfig`, `configPath`, `packagesLayer`, `CONFIG_TIERS`. |
| `src/settings.ts` | `ConfigService`, `Settings`, `ConfigChange`, `Affected`, `ConfigTarget`. |
| `src/users.ts`, `src/auth.ts` | `UserStore`, `AuthService`, over `StoreMirror` namespaces. |
| `src/services.ts` | `ServiceSupervisor`. |
| `src/packages/manifest.ts`, `registry.ts`, `manager.ts` | Manifest validation, the package records, the package manager. |
| `src/providers.ts` | `ProviderRegistry`. |
| `src/sessions/api.ts` | `SessionApi`, `SESSION_ID`. |
| `src/pipeline/enumerator.ts`, `runner.ts` | `Enumerator`, `PipelineRunner`. |
| `src/rpc.ts`, `src/control.ts` | `createRpcHandler`, `createControlHandler`, `redact`. |
| `src/index.ts` | The public API. |

## Tests

`npm test` from the runtime root builds and runs every suite. This package has three, under `packages/kernel/test/`: `loc.test.ts` counts the lines of code and fails at the `LIMIT` in that file, not counting imports, re-exports, blank lines, comment-only lines or tests; `boundaries.test.ts` checks the import layers of every package and snapshots the seams above, the runtime exports of `@thetis/contracts`, the keys of `CONFIG_TIERS`, and that `defaultConfig().packages` is empty; `unit.test.ts` covers the user store, the auth service, manifest validation, the enumerator, the configuration, redaction, the service restart, the config service, the `store.*` and `config.*` RPC handling, and the refusal of a storage driver at install. The model-call loop's tests (cancel mid-stream, dangling tool calls closed, unknown tool refused, withheld honoured, partial text kept) live with `@thetis/harness-core`. To run one alone after `npm run build`: `node --test packages/kernel/dist/test/loc.test.js`.

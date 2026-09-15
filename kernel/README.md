# @thetis/kernel

The trusted service plane: who may do what. Users, passwords and tokens, sessions, the pipeline, package ownership, providers, the RPC table a fence may call, and the operator table the command line uses. It runs in the host process. It holds authority, not mechanism, and it has no opinions: prompts, tools, memory, and providers are packages that run in a fence. The kernel must stay under 1,200 lines of code.

## What it provides

A library: nothing in `thetis`. Not installable.

The layering rule: `kernel` imports `@thetis/contracts` and `@thetis/lib`, never `@thetis/sandbox` or `@thetis/host`. It depends on the interface `Fences` from the contracts; the host binds the sandbox to it. Only `@thetis/host` and `@thetis/gateway-cli` may import the kernel. The test `packages/kernel/test/boundaries.test.ts` enforces the rule.

| Class or export | Responsibility |
|---|---|
| `UserStore` | User records in `$THETIS_HOME/users.json` and `authorize`. |
| `AuthService` | Passwords (scrypt) and login tokens in `$THETIS_HOME/auth.json`, mode `0600`. |
| `ServiceSupervisor` | Starts and stops the services that packages declare. |
| `PackageRegistry`, `PackageManager`, `readManifest`, `validateManifest` | Package records, ownership and peer checks, seeding, promotion, install and uninstall, forks. |
| `ProviderRegistry` | Provider discovery, model resolution, provider calls. |
| `SessionApi` | The session API for gateways. Every call is authorized against a user. |
| `Enumerator`, `ProviderCallStep`, `PipelineRunner` | The step list, the built-in call step with the tool loop, one turn. |
| `createRpcHandler` | The methods a fence can call on the kernel. |
| `createControlHandler`, `redact` | The operator methods of the control socket, also reachable from an admin's fence as `operator.<method>`. |
| `KernelError` | `CodedError` from `@thetis/lib/error`, with a `code` such as `invalid`, `unauthorized`, `not-found`, `busy`, `cancelled`, `fence`, `package`, `provider`, `step`, `tool`, `rpc`. |

## Configuration

`KernelConfig` is loaded by `loadConfig(home, projectRoot)`: the defaults from `defaultConfig`, then `$THETIS_HOME/thetis.config.json` over them, then every `${NAME}` in a string replaced from the environment. The fields are `model`, `phases`, `callPhase`, `enumerator`, `systemPackages`, `packages` (per-package configuration, sent only to that package's steps, tools, and service), `fence`, `door`, and `requestTimeoutMs`, plus the derived paths `home`, `systemPackagesDir`, `promotedPackagesDir`, `sharedDir`, and `agentPath`. `saveConfig` writes the file without the derived paths; only `thetis init` calls it.

## Use

A host process builds a kernel through `@thetis/host` and reaches this package's classes on it:

```ts
import { createKernel } from "@thetis/host";
import { loadConfig } from "@thetis/kernel";

const kernel = createKernel(loadConfig(home, projectRoot));
const ref = kernel.sessions.create("alice");
for await (const event of kernel.sessions.send("alice", ref.id, "hello")) {
  if (event.type === "text") process.stdout.write(event.delta);
}
await kernel.shutdown();
```

`SessionApi`: `create(userId, { parent? })`, `send(userId, sessionId, input)` as an `AsyncIterable<TurnEvent>`, `ask` for the final text, `cancel`, `inspect`, `list`. A session runs one turn at a time; a second `send` fails with the code `busy`. A session is found only in the caller's own userspace.

The rules the kernel enforces on every call: an unknown or suspended user is rejected; RPC from a fence acts as the fence's own user and no argument can name another; `auth.login` is answered only for the system userspace; a user installs only into `@<own id>/*` and only admins install `@thetis/*`; an operator method from a fence needs an admin.

## Files

| File | Content |
|---|---|
| `src/kernel.ts` | `KernelServices`, the interface of one running kernel. |
| `src/config.ts` | `KernelConfig`, `defaultConfig`, `loadConfig`, `saveConfig`, `configPath`. |
| `src/users.ts`, `src/auth.ts` | `UserStore`, `AuthService`. |
| `src/services.ts` | `ServiceSupervisor`. |
| `src/packages/manifest.ts`, `registry.ts`, `manager.ts` | Manifest validation, the package records, the package manager. |
| `src/providers.ts` | `ProviderRegistry`. |
| `src/sessions/api.ts` | `SessionApi`, `SESSION_ID`. |
| `src/pipeline/enumerator.ts`, `provider-call.ts`, `runner.ts` | `Enumerator`, `ProviderCallStep`, `PipelineRunner`. |
| `src/rpc.ts`, `src/control.ts` | `createRpcHandler`, `createControlHandler`, `redact`. |
| `src/index.ts` | The public API. |

## Tests

`npm test` from the runtime root builds and runs every suite. This package has three, under `packages/kernel/test/`: `loc.test.ts` counts the lines of code and fails at 1,200 or more; `boundaries.test.ts` checks the import layers of every package; `unit.test.ts` covers the user store, the auth service, manifest validation, the enumerator, the configuration, and redaction. To run one alone after `npm run build`: `node --test packages/kernel/dist/test/loc.test.js`.

See docs/02-kernel.md in the runtime repository.

# @thetis/contracts

The types and constants every part of Thetis agrees on: messages, the pipeline, packages, identity, the fence, host packages, and what package code sees inside it. The package holds no code: types, and a few string constants. Nothing here carries policy; a regular expression or a default that a package needs lives in that package. It is imported everywhere: by the service plane in the host process, by the userspace agent inside each fence, and by every package that implements a step, a tool, a service, or a provider.

## What it provides

A library: nothing in `thetis`. It cannot be installed into a userspace; packages depend on it for their types.

The layering rule of the service plane: `contracts` imports nothing from `@thetis`; `lib` imports `contracts`; `sandbox` and `kernel` import `contracts` and `lib`; `host` imports all four. Every other package may import `@thetis/contracts`. The test `packages/kernel/test/boundaries.test.ts` enforces the rule.

The constants:

| Constant | Value | Meaning |
|---|---|---|
| `SYSTEM_USER` | `_system` | The user that owns the system userspace. |
| `SYSTEM_SCOPE` | `@thetis` | The scope of system packages. |
| `STORAGE_TYPE` | `storage` | The package type of a storage driver, loaded by the host. |
| `HOST_TYPE` | `host` | The package type of a host package, loaded by the host and answering `host.<name>.<export>`. |

`packages/kernel/test/boundaries.test.ts` snapshots this list: the runtime exports of this package are these strings and nothing else.

## Use

A step, a tool, and a service are exported functions typed from here:

```ts
import type { Step, Tool, Service } from "@thetis/contracts";

export const prompt: Step = async (ctx) => ({
  call: { ...ctx.call, system: "Answer briefly." },
});

export const shout: Tool = async (args, env) => String(args.text).toUpperCase();

export const startService: Service = async (env) => {
  env.log("started");
  return { stop: async () => {} };
};
```

A step receives a `PackageStepContext`: `session`, `turn`, `conversation`, `call`, `harness`, `config`, a `packages` query, `env`, `emit` (a turn event streamed to whoever watches the turn; the kernel relays it and reads only `usage` and `error`) and `signal` (aborted when the turn is stopped). It returns a `StepResult` with any of `conversation`, `call`, and `harness`, or nothing. A tool receives its arguments and a `ToolEnv`. Code in the fence reaches the kernel through `env.kernel`, a `KernelClient`; every call acts as the fence's own user. `kernel.providers.call(call, onEvent, signal)` is how a harness's call step sends a `ProviderCall`: the kernel routes it by `call.model` to the provider's fence and streams the `ProviderEvent`s back, so the calling fence never sees the key.

A host package exports `HostMethod`s, `(args, env: HostEnv) => Promise<unknown>`, and declares `"thetis": { "type": "host", "host": { "name": "grants" } }`. `HostEnv` gives it the home, the users, the grant records (`mounts`, `ssh`) with `get`, `all` and `set`, `journal`, `reloadFence(user)` and `log`. The host process loads it the way it loads a storage driver and re-imports its entry when the file changes.

The fence side is the pair `Fence` and `FenceHandle`, and the pool `Fences`. The kernel depends on these interfaces; `@thetis/sandbox` implements them. A different isolation technology implements `Fence` and replaces the binding in `@thetis/host`.

## Files

| File | Content |
|---|---|
| `src/messages.ts` | `Message`, `ToolCall`, `ToolSpec`, `ProviderCall`, `ProviderEvent`, `ModelDescriptor`, `ModelChoices`. |
| `src/pipeline.ts` | `StepRef`, `StepContext`, `StepResult`, `TurnEvent`, `TurnOptions`, `HarnessState`. |
| `src/packages.ts` | `Manifest`, `ThetisField`, `StepDecl`, `ToolDecl`, `UiDecl`, `PackageSource`, `ForkOrigin`, `PackageInfo`, `PackageRecord`, `DeletedPackage`, `SYSTEM_SCOPE`. |
| `src/identity.ts` | `UserRecord`, `AuthUser`, `Mount`, `SshGrant`, `Userspace`, `SessionInfo`, `SessionRecord`, `SessionSummaryRef`, `SYSTEM_USER`. |
| `src/guest.ts` | What package code sees: `StepEnv`, `KernelClient`, `PackageQuery`, `Step`, `Tool`, `ToolEnv`, `Service`, `ServiceEnv`, `Provider`, `UiCommand`, `EnumeratorContext`. |
| `src/fence.ts` | `Fence`, `FenceHandle`, `Fences`, `KernelRpc`, `EventSink`, `ExecResult`. |
| `src/bench.ts` | What a package declares to be benchmarked and what it reports: `BenchDecl`, `BenchClaim`, `Corpus`, `CapabilityRecord`. |
| `src/storage.ts` | `Store`, `StoreDriver`, `STORAGE_TYPE`. |
| `src/config.ts` | `ConfigDecl`, `ConfigKeyState`, `ConfigReport`, `ConfigLayer`: the declaration fields and the report shape. |
| `src/host.ts` | `HostEnv`, `HostMethod`, `GrantRecords`, `HOST_TYPE`. |
| `src/index.ts` | Re-exports all of the above. |

## Tests

The package has no tests of its own. `packages/kernel/test/boundaries.test.ts` checks that its sources import nothing from `@thetis` and that its runtime exports are the four strings above. Run every test with `npm test` from the runtime root.

# @thetis/contracts

The types and constants every part of Thetis agrees on: messages, the pipeline, packages, identity, the fence, and what package code sees inside it. The package holds no code beyond four string constants. It is imported everywhere: by the service plane in the host process, by the userspace agent inside each fence, and by every package that implements a step, a tool, a service, or a provider.

## What it provides

A library: nothing in `thetis`. It cannot be installed into a userspace; packages depend on it for their types.

The layering rule of the service plane: `contracts` imports nothing from `@thetis`; `lib` imports `contracts`; `sandbox` and `kernel` import `contracts` and `lib`; `host` imports all four. Every other package may import `@thetis/contracts`. The test `packages/kernel/test/boundaries.test.ts` enforces the rule.

The constants:

| Constant | Value | Meaning |
|---|---|---|
| `SYSTEM_USER` | `_system` | The user that owns the system userspace. |
| `SYSTEM_SCOPE` | `@thetis` | The scope of system packages. |
| `KERNEL_PACKAGE` | `@thetis/kernel` | The package name the built-in provider call step is scheduled under. |
| `PROVIDER_CALL_STEP` | `provider-call` | The export name of that step. |

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

A step receives a `PackageStepContext`: `session`, `turn`, `conversation`, `call`, `harness`, `config`, a `packages` query, and `env`. It returns a `StepResult` with any of `conversation`, `call`, and `harness`, or nothing. A tool receives its arguments and a `ToolEnv`. Code in the fence reaches the kernel through `env.kernel`, a `KernelClient`; every call acts as the fence's own user.

The fence side is the pair `Fence` and `FenceHandle`, and the pool `Fences`. The kernel depends on these interfaces; `@thetis/sandbox` implements them. A different isolation technology implements `Fence` and replaces the binding in `@thetis/host`.

## Files

| File | Content |
|---|---|
| `src/messages.ts` | `Message`, `ToolCall`, `ToolSpec`, `ProviderCall`, `ProviderEvent`, `ModelDescriptor`, `ModelChoices`. |
| `src/pipeline.ts` | `StepRef`, `StepContext`, `StepResult`, `TurnEvent`, `TurnOptions`, `HarnessState`, `KERNEL_PACKAGE`, `PROVIDER_CALL_STEP`. |
| `src/packages.ts` | `Manifest`, `ThetisField`, `StepDecl`, `ToolDecl`, `UiDecl`, `PackageSource`, `ForkOrigin`, `PackageInfo`, `PackageRecord`, `DeletedPackage`, `SYSTEM_SCOPE`. |
| `src/identity.ts` | `UserRecord`, `AuthUser`, `Mount`, `Userspace`, `SessionInfo`, `SessionRecord`, `SessionSummaryRef`, `SYSTEM_USER`. |
| `src/guest.ts` | What package code sees: `StepEnv`, `KernelClient`, `PackageQuery`, `Step`, `Tool`, `ToolEnv`, `Service`, `ServiceEnv`, `Provider`, `UiCommand`, `EnumeratorContext`. |
| `src/fence.ts` | `Fence`, `FenceHandle`, `Fences`, `KernelRpc`, `EventSink`, `ExecResult`. |
| `src/bench.ts` | What a package declares to be benchmarked and what it reports: `BenchDecl`, `BenchClaim`, `Corpus`, `CapabilityRecord`. |
| `src/index.ts` | Re-exports all of the above. |

## Tests

The package has no tests of its own. `packages/kernel/test/boundaries.test.ts` checks that its sources import nothing from `@thetis`. Run every test with `npm test` from the runtime root.

See docs/02-kernel.md in the runtime repository.

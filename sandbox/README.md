# @thetis/sandbox

The process fence: one long-lived userspace agent per userspace, under bubblewrap, with cgroup limits and outbound-only networking. It runs in the host process next to the kernel. It builds the fence; it does not decide who may cross it. The kernel sees only the interfaces `Fence`, `FenceHandle`, and `Fences` from `@thetis/contracts`; `@thetis/host` binds this package to them.

## What it provides

A library: nothing in `thetis`. Not installable.

The layering rule: `sandbox` imports `@thetis/contracts` and `@thetis/lib`. Only `@thetis/host` imports it; the kernel never does. The test `packages/kernel/test/boundaries.test.ts` enforces the rule.

In mode `bwrap` the agent sees the operating system read-only, its own userspace root read-write, the shared directory (writable for the system userspace, read-only for everyone else), the package tree and the promoted packages read-only, and its mounts. It has its own user, PID, IPC, and UTS namespaces, no capabilities, cannot make a nested user namespace, and dies with the kernel. It does not see `$THETIS_HOME`, other userspaces, `/home`, or the host `/tmp`.

| Option | Values | Meaning |
|---|---|---|
| `sandbox` | `auto`, `bwrap`, `none` | `auto` uses `bwrap` when `bwrap --ro-bind / / --unshare-pid -- true` succeeds, else `none`. `none` starts the agent directly, with no isolation. |
| `network` | `auto`, `egress`, `none`, `host` | `egress` is a private network namespace with outbound NAT through `slirp4netns`: no host loopback, no host ports. `none` has no interface. `auto` picks `egress` when `/usr/bin/slirp4netns` exists and the sandbox is `bwrap`. |
| `limits` | `memoryMb`, `pids`, `cpuPercent` | A cgroup v2 group per fence. Needs the kernel process in a delegated cgroup; otherwise the fences run unlimited and the kernel logs `[fence] resource limits off` once. |

The agent gets this environment and nothing else: `PATH`, `HOME`, `LANG`, `THETIS_USERSPACE`, `THETIS_HOME_DIR`, `THETIS_STORE`, `THETIS_SHARED`, `THETIS_USER`, and `THETIS_MOUNTS`. The kernel's own environment does not reach the fence.

Each request has a timer of `requestTimeoutMs` milliseconds. On timeout the request fails with the code `fence`, the pool drops the handle, and the next request opens a new agent.

## Configuration

`config.fence` holds `sandbox`, `network`, `limits`, `readOnly`, and `hidden`; `config.agentPath` names the agent the fence starts; `config.requestTimeoutMs` is the request timer. The host passes them to `ProcessFence`.

## Use

The host binds the fence to the token `T.fence`. A different isolation technology replaces the binding:

```ts
import { createKernel, T } from "@thetis/host";

const kernel = createKernel(config, (c) => {
  c.bind(T.fence, () => new MyMicroVmFence());
});
```

Resource limits apply when the kernel runs in a delegated cgroup. For a development run:

```sh
systemd-run --user --scope -p Delegate=yes node bin/thetis.js serve
```

The systemd unit `deploy/thetis-runtime.service` sets `Delegate=yes`.

## Files

| File | Content |
|---|---|
| `src/process-fence.ts` | `ProcessFence`. Resolves the sandbox and network modes, spawns the agent, opens the launch gate. `mode` and `networkMode` report what was resolved. |
| `src/bwrap.ts` | The bubblewrap arguments and the launcher command around the gate. |
| `src/handle.ts` | `ProcessHandle`. One agent process: requests out, RPC in, the request timer, cancel, and a close that kills an agent still there two seconds after `SIGTERM`. |
| `src/pool.ts` | `FencePool`. Implements `Fences`: at most one open fence per userspace, reopened after a crash. |
| `src/cgroup.ts` | `Cgroups`. Per-fence limits under the kernel's delegated cgroup. |
| `src/network.ts` | `startEgress`, `hasSlirp`. The `slirp4netns` helper. |
| `src/index.ts` | Re-exports. |

## Tests

`npm test` from the runtime root builds and runs every suite. The suite of this package is `packages/sandbox/test/handle.test.ts`: `close` waits for the agent to exit and kills one that ignores `SIGTERM`. To run it alone after `npm run build`: `node --test packages/sandbox/dist/test/handle.test.js`. The real fence runs in `packages/host/test/e2e.test.ts`; its case `fence isolation` checks that a userspace cannot read the service plane or another userspace.

See docs/03-fence.md in the runtime repository.

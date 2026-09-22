# @thetis/sandbox

The process fence: one long-lived userspace agent per userspace, under bubblewrap, with cgroup limits and outbound-only networking. It runs in the host process next to the kernel. It builds the fence; it does not decide who may cross it. The kernel sees only the interfaces `Fence`, `FenceHandle`, and `Fences` from `@thetis/contracts`; `@thetis/host` binds this package to them.

## What it provides

A library: nothing in `thetis`. Not installable.

The layering rule: `sandbox` imports `@thetis/contracts` and `@thetis/lib`. Only `@thetis/host` imports it; the kernel never does. The test `packages/kernel/test/boundaries.test.ts` enforces the rule.

In mode `bwrap` the agent sees the operating system read-only, its own userspace root read-write, the shared directory (writable for the system userspace, read-only for everyone else), the package tree and the promoted packages read-only, its mounts at the mode they were granted, its own cgroup read-only under `/sys/fs/cgroup`, and — unless `fence.docker` is `off` — the host's Docker socket. It has its own user, PID, IPC, UTS and — when the host has them — cgroup namespaces, no capabilities, cannot make a nested user namespace, and dies with the kernel. It does not see `$THETIS_HOME`, other userspaces, `/home`, the host `/tmp`, or any other fence's cgroup.

The cgroup bind is what lets an agent tell an OOM kill from a transient failure: it reads its real `memory.max`, `memory.current` and `memory.events` (`oom_kill`) instead of guessing from the host's free memory, and it is what lets a language runtime size its heap for the fence instead of for the machine. The fence gets its own cgroup namespace (`--unshare-cgroup`) and its group is bound at `/sys/fs/cgroup` itself, as in any container: the process is already in `fence-<user>` when bubblewrap unshares, so inside, `/proc/self/cgroup` reads `0::/` and the mount point is a cgroup2 filesystem holding that group's own files. A runtime resolves its group by appending that line to the mount point, and this is the layout in which the concatenation lands on the group — measured: `dotnet` then reports `TotalAvailableMemoryBytes` 6 GiB under an 8 GiB limit instead of the host's 376 GB.

`hasCgroupNamespace` asks the host rather than assuming: `/proc/self/ns/cgroup` has to exist (Linux 4.6 and later) and `bwrap --unshare-cgroup -- true` has to succeed. When it does not, the fence falls back to the layout of the previous release — no namespace, the group bound under the mount point at the full path `/proc/self/cgroup` still reports — and the agent finds it by reading that line. The two never mix: the group at the mount root without a namespace makes the concatenation name a directory that does not exist, and .NET aborts at random inside the fence (`munmap_chunk(): invalid pointer`). The bind is `--ro-bind-try`, so a kernel without a delegated cgroup, a cgroups v1 host, or mode `none` simply gets no bind and no namespace — none of this ever keeps a fence from starting. `/proc/meminfo` still reports the host's memory; that would need a FUSE layer such as `lxcfs` and is out of scope. The layout is decided in `src/cgroup.ts`.

| Option | Values | Meaning |
|---|---|---|
| `sandbox` | `auto`, `bwrap`, `none` | `auto` uses `bwrap` when `bwrap --ro-bind / / --unshare-pid -- true` succeeds, else `none`. `none` starts the agent directly, with no isolation. |
| `network` | `auto`, `egress`, `none`, `host` | `egress` is a private network namespace with outbound NAT through `slirp4netns`: no host loopback, no host ports. `none` has no interface. `auto` picks `egress` when `/usr/bin/slirp4netns` exists and the sandbox is `bwrap`. |
| `docker` | `auto`, `on`, `off` | Whether every fence gets the host's Docker socket, bound read-only at `/var/run/docker.sock` so the CLI finds it with nothing configured. `auto` binds one the kernel can use and is otherwise silent; `on` binds it whether or not the probe passes; `off` never does. **Socket access is host root** — a container with `--privileged` and `/` bound in undoes every other rule here. On by default for a single-operator installation; `off` anywhere a fence holds code not already trusted with the host. |
| `limits` | `memoryMb`, `pids`, `cpuPercent` | `memoryMb` defaults to `"auto"`: no memory ceiling, the fence may use the whole machine, and a number caps it instead. `auto` keeps the group and its accounting (`memory.current`, `memory.peak`, `oom_kill`) and drops only the ceiling; `memory.swap.max` follows, zero under a number and `max` under `auto`. A cgroup v2 group per fence, bound read-only inside it at `/sys/fs/cgroup` with a cgroup namespace, or at the path `/proc/self/cgroup` names when the host has no such namespace. Needs the kernel process in a delegated cgroup; otherwise the fences run unlimited, get no bind, and the kernel logs `[fence] resource limits off` once. |

A person's mount is a grant, and a grant is not quietly taken back. The fence binds things inside paths a person may have been granted -- `fence.readOnly` binds the checkout's `packages` and `node_modules` so the fence sees the code it runs -- and a read-only bind inside a read-write mount makes that subtree read-only with both flags still in the command line and nothing to report. It happened: a person granted `rw` over the checkout got a workspace where the two directories they most wanted to edit refused writes, while `THETIS_MOUNTS`, the project page and the system prompt all said `rw`, and an agent was the one to find out. So `resolveGrants` binds such a path read-write instead. Two kinds are left alone, because they are policy and not convenience: anything behind a `tmpfs` mask inside the grant, which is the service plane being hidden and specific things revealed through it read-only, so a grant over `/opt/zero` still cannot write the shared directory or the promoted packages; and any bind whose source is not its target, which is the fence putting some other host path somewhere (the resolver, the ssh files, the cgroup) rather than the person's own directory.

The agent gets this environment and nothing else: `PATH`, `HOME`, `LANG`, `THETIS_USERSPACE`, `THETIS_HOME_DIR`, `THETIS_STORE`, `THETIS_SHARED`, `THETIS_USER`, `THETIS_MOUNTS`, and `THETIS_DOCKER` when a Docker socket is bound. The kernel's own environment does not reach the fence.

Each request has a timer of `requestTimeoutMs` milliseconds. On timeout the request fails with the code `fence`, the pool drops the handle, and the next request opens a new agent.

The pool stamps every fence it opens with the moment it opened (`openedAt()`) and with the package versions of that userspace at that moment (`loadedVersions()`, `{ userId: { name: version } }`), read through the `versionsOf(us)` reader the host passes at construction. Both are dropped when the handle is forgotten, so a userspace with no fence open reports nothing. The pool never interprets either: the kernel compares what a fence loaded with what is on disk now.

## Configuration

`config.fence` holds `sandbox`, `network`, `limits`, `readOnly`, `hidden`, `docker`, and `dockerSocket`; `config.agentPath` names the agent the fence starts; `config.requestTimeoutMs` is the request timer. The host passes them to `ProcessFence`.

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
| `src/process-fence.ts` | `ProcessFence`. Resolves the sandbox, network and Docker modes, spawns the agent, opens the launch gate. `mode`, `networkMode` and `dockerMode` report what was resolved. |
| `src/plan.ts` | `MountIntent`, `orderIntents`, `resolveGrants`, `validateIntents`, `renderIntents`. What the fence mounts, as data: declared in any order, ordered parents-first so nothing lands on top of anything, grants resolved so nothing lands *inside* a person's mount and takes it back, checked, and rendered to flags last. |
| `src/bwrap.ts` | The bubblewrap arguments and the launcher command around the gate. | Builds the plan in `fencePlan` and renders it.
| `src/handle.ts` | `ProcessHandle`. One agent process: requests out, RPC in, the request timer, cancel, and a close that kills an agent still there two seconds after `SIGTERM`. |
| `src/pool.ts` | `FencePool`. Implements `Fences`: at most one open fence per userspace, reopened after a crash. |
| `src/cgroup.ts` | `Cgroups`, `fenceMount`, `limitValues` (one fence's limits as the control files spell them, pure so the decision can be read and tested on its own). Per-fence limits under the kernel's delegated cgroup. `fenceDir` names the group on the host, `fence` adds where the fence has to see it: the mount point itself with a cgroup namespace, and the mount point plus the group's path relative to the cgroup filesystem root without one, which is what `/proc/self/cgroup` then reports inside. Only this file spells a cgroup path. |
| `src/network.ts` | `startEgress`, `hasSlirp`. The `slirp4netns` helper. |
| `src/docker.ts` | `dockerSocket`, `FENCE_DOCKER_SOCKET`. Which host socket to bind, and why a bind that is read-only, last among the read-only binds, and independent of the network mode is the right shape. A path named in the configuration is the only candidate. |
| `src/index.ts` | Re-exports. |

## Tests

`npm test` from the runtime root builds and runs every suite. The suites of this package are `packages/sandbox/test/handle.test.ts` (`close` waits for the agent to exit and kills one that ignores `SIGTERM`) and `packages/sandbox/test/bwrap.test.ts` (the cgroup bind: the destination, where it sits in the argument list, that it is absent when limits are off, and — under a real `bwrap` — that the fence reads its own limits there, sees no sibling, cannot write them, and that `dotnet --version` runs ten times over without aborting), and `packages/sandbox/test/docker.test.ts` (which socket is chosen and that a named one is never substituted, where it is bound and that it is read-only, and — under a real `bwrap` with a real daemon — that the daemon answers from a fence with no network at all). `packages/sandbox/test/plan.test.ts` covers the plan itself: the ordering rule, a mask under a bound parent and a bind under a mask (against a real `bwrap`), the conflicts that are reported, and grants -- a read-only bind inside an `rw` mount bound read-write, a mask and a relocated bind left alone, a `ro` mount staying read-only, and, under a real `bwrap`, a granted directory writable all the way down. To run them alone after `npm run build`: `node --test "packages/sandbox/dist/test/*.test.js"`. The real fence runs in `packages/host/test/e2e.test.ts`; its case `fence isolation` checks that a userspace cannot read the service plane or another userspace.

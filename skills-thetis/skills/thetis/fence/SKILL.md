---
name: fence
description: The Thetis fence around your userspace. What bubblewrap binds read-only and read-write, the hidden paths, the environment variables the agent gets, the mounts an admin grants, the network modes egress, none, and host, the cgroup limits on memory, processes, and CPU, the request timeout, the exec output cap, and what fails inside the fence and why. Use when you ask "why is this path read-only", "why can I not see /home or $THETIS_HOME", "can I reach the network", "why did npm install fail", "why was my process killed", "what is THETIS_MOUNTS", or "what can package code reach".
metadata:
  title: The fence
  tags: [fence, sandbox, bwrap, bubblewrap, mounts, readonly, hidden, egress, network, limits, cgroup, timeout, environment, isolation, security]
  related: [thetis/using, thetis/configuration, thetis/troubleshooting]
  version: 1
---
# The fence

The fence is the boundary around one userspace. All package code runs inside a fence. The kernel is the only bridge across it. `@thetis/sandbox` builds the fence with bubblewrap. It starts one long-lived Node process per userspace, the userspace agent. Every step, tool, provider, and service of that userspace runs in that process.

## What you see

In mode `bwrap` the fence binds, in this order:

1. `/dev`, `/proc`, and an empty `/tmp`.
2. An empty tmpfs over each hidden path. The default hides `$THETIS_HOME`.
3. Read-only: `/usr`, `/etc`, `/opt`, `/bin`, `/sbin`, `/lib`, `/lib32`, `/lib64`, the Node install prefix, `<root>/packages`, `<root>/node_modules`, and the promoted packages `$THETIS_HOME/packages`.
4. The shared directory `$THETIS_HOME/shared`: read-write for the system userspace, read-only for everyone else.
5. In network mode `egress`, a resolver file at `/etc/resolv.conf`.
6. Read-write: the userspace root. The working directory is `home`.
7. Each mount of the user, at its host path, `rw` or `ro` as granted. A mount comes after the binds above, so it wins over a read-only parent.

You do not see `$THETIS_HOME`, other userspaces, `/home`, or the host `/tmp`. You have no capabilities. You cannot make a nested user namespace. The process dies with the kernel.

| Space | Access |
|---|---|
| `<userspace>/home`, `store`, `sessions`, `run` | Read and write. |
| `$THETIS_HOME/shared` | Read only. The system userspace writes it. |
| `$THETIS_HOME/packages` | Read only. |
| `<root>/packages`, `<root>/node_modules` | Read only. The shipped code. |
| The operating system | Read only. |
| A mount with mode `rw` | Read and write. |
| A mount with mode `ro` | Read only. |

In mode `none` there is no isolation. The agent runs as the host user with full access. Mode `auto` uses `bwrap` when the probe `bwrap --ro-bind / / --unshare-pid -- true` succeeds.

## Environment

The agent gets these variables and nothing else:

| Variable | Value |
|---|---|
| `PATH` | The directory of the Node binary, then the host `PATH`. |
| `HOME` | The userspace home. |
| `LANG` | The host `LANG`, or `C.UTF-8`. |
| `THETIS_USERSPACE` | The userspace root. |
| `THETIS_HOME_DIR` | The userspace home. |
| `THETIS_STORE` | The package store. |
| `THETIS_SHARED` | The shared directory. |
| `THETIS_USER` | The user id. |
| `THETIS_MOUNTS` | A JSON list of the bound mounts, each `{ "path", "mode" }`. `[]` when there is none. |

The kernel does not pass its own environment. Secrets in the host environment do not reach the fence. `OPENROUTER_API_KEY` is not in your environment.

## Mounts

A mount is an admin's grant of one host directory into one person's fence at the same path. Only an admin sets mounts: `thetis mounts add <user> <path> [--ro]`, `thetis mounts remove <user> <path>`, or the operator method `mounts.set`. The path must be absolute and normalized. A user has at most 32 mounts. A change closes the fence. The fence reopens with the new binds on the next request, and the services restart.

A mount is a hole in the fence, opened on purpose. The kernel does not check what the directory holds. The file tools and `@thetis/projects` read `THETIS_MOUNTS` to know what you can reach.

## Network

`fence.network` decides what the fence can reach:

| Value | Behavior |
|---|---|
| `auto` | `egress` when `/usr/bin/slirp4netns` exists and the sandbox is `bwrap`, else `host`. |
| `egress` | A private network namespace with outbound NAT. The fence reaches the internet and the local network. It cannot reach the host's loopback and cannot bind a host port. DNS goes to `10.0.2.3`. |
| `none` | A private network namespace with no interface. |
| `host` | The host's network namespace. |

A service binds a unix socket under `<userspace>/run`, never a port. The door on the host connects to it. In mode `egress` there is no per-package destination list.

## Limits

`fence.limits` gives each fence a cgroup v2 group: `memoryMb` (default 1024), `pids` (default 512), and `cpuPercent` (default 200, where 100 is one core). The limits apply only when the kernel runs in a delegated cgroup. Otherwise the kernel logs `[fence] resource limits off` once. There is no disk quota.

Each fence request has a timer of `requestTimeoutMs` milliseconds, default 600000. On timeout the request fails with the code `fence`, and the agent is closed. The next request opens a new agent. A tool or a subagent must end inside that time.

`exec` has a default timeout of 120000 milliseconds. Its output is capped at 30,000 characters per stream.

## What fails and why

| Attempt | Result | Why |
|---|---|---|
| Write under `$THETIS_HOME/shared` from a person's fence. | Refused. | The shared directory is read-only outside the system userspace. |
| Read `users.json`, `registry.json`, or the configuration. | Not found. | `$THETIS_HOME` is hidden by an empty tmpfs. |
| Read another person's userspace. | Not found. | Only your own root is bound. |
| Write into `<root>/packages` or a promoted package. | Refused. | Read-only binds. Fork the package instead. |
| Reach `127.0.0.1` on the host. | Refused. | In mode `egress` the fence has its own namespace. |
| `npm install` with network mode `none`. | Fails. | No interface. |
| Bind a host port from a service. | Refused. | Use a unix socket under `run/`. |
| A request longer than `requestTimeoutMs`. | The agent is killed and restarted. | The request timer. |
| A process count above `pids` or memory above `memoryMb`. | Killed. | The cgroup limit, when delegated. |
| Write to `process.stdout` from package code. | The line is logged as stray output. | `stdout` is the protocol channel. |

Identity is the fence. A call to the kernel acts as the userspace's own user. No argument can name another user. An admin's fence may call operator methods. The kernel checks the role on every call.

## Sources

- docs/03-fence.md
- docs/12-security.md
- docs/08-cli.md
- packages/sandbox/README.md
- packages/userspace-agent/src/agent.ts

# @thetis/userspace-agent

The guest side of the fence. The sandbox starts one long-lived Node process per userspace, and that process is this package: `dist/src/agent.js`, the `agentPath` of the configuration. It runs inside each fence, the system userspace fence included. It loads package modules from the userspace store and runs steps, tools, enumerators, providers, and services when the kernel asks. Package code never starts it and never talks to it directly; it sees the environment the agent builds.

## What it provides

Nothing in `thetis`. Not installable, and not a library: an executable with no exports. It imports `@thetis/contracts` for its types and `@thetis/lib/rpc-frames` for the framing.

The protocol is one JSON object per line: requests in on `stdin`, events and results out on `stdout`, logs on `stderr`. The kernel forwards each `stderr` line to its log with the prefix `[<user id>]`. The agent redirects `console.log`, `console.info`, and `console.debug` to `stderr` and exits when `stdin` closes. Package code that writes to `process.stdout` directly corrupts the protocol.

| Operation | What the agent does |
|---|---|
| `ping` | Answers `pong`. The kernel sends it once after the fence opens. |
| `exec` | Runs a command with `/bin/bash` in the home directory. Output is capped at 30,000 characters per stream. |
| `step` | Loads the export, calls it with the step context plus a `packages` query and `env`, returns `conversation`, `call`, and `harness`. |
| `tool` | Loads the export, calls it with the arguments and a `ToolEnv` (`env` plus `session` and `config`). |
| `enumerate` | Loads the export, calls it with `session`, `packages`, and `phases`. |
| `provider.models`, `provider.call` | Builds the provider once per package, export, and configuration; streams each `ProviderEvent` as an event line. |
| `service.start`, `service.stop` | Starts the export with a `ServiceEnv` (`env` plus `config` and `log`) and keeps one instance per package; `stop` calls its `stop()`. Every service exits with the agent. |

A `{ "cancel": <id> }` line aborts a request: `exec` kills its process and `provider.call` stops reading the stream.

A module is loaded from `<store>/node_modules/<package>`: `main` from its `package.json` (default `index.js`), imported with the query `?v=<modification time>`, so a changed file is a new module. The named export must be a function.

The agent reaches the kernel through RPC lines on `stdout`. The `KernelClient` it builds has `packages.install`, `uninstall`, `delete`, `list`; `sessions.create`, `ask`, `send`, `cancel`, `list`, `inspect`; `models`; `auth.login`, `authenticate`, `logout`; and `operator.call`. Every method acts as the fence's own user; the kernel authorizes it on each call.

## Use

What package code receives is the environment this agent builds. A tool:

```ts
import type { Tool } from "@thetis/contracts";

export const listPackages: Tool = async (args, env) => {
  const { code, stdout } = await env.exec("ls", { cwd: "." });
  const installed = await env.kernel.packages.list();
  return { code, stdout, installed: installed.map((p) => p.name) };
};
```

| Field of `env` | Content |
|---|---|
| `cwd`, `root`, `store`, `shared` | The home directory, the userspace root, the package store, the shared directory. From `THETIS_HOME_DIR`, `THETIS_USERSPACE`, `THETIS_STORE`, `THETIS_SHARED`. |
| `exec(cmd, opts)` | `opts.cwd` is relative to home; `opts.timeoutMs` defaults to 120000. Returns `{ code, stdout, stderr }`. |
| `readFile(path)`, `writeFile(path, content)` | UTF-8, relative to home. `writeFile` creates parent directories. |
| `kernel` | The kernel client above. |
| `session`, `config` | Tools only: `{ id, user, parent? }` and the tool's package configuration. |

A service logs with `env.log(line)`, which writes to `stderr` with the package name as prefix, and returns `{ stop }` when it has something to close.

## Files

| File | Content |
|---|---|
| `src/agent.ts` | The whole agent: the kernel client, the environment, module loading, the operations, cancel, and the frame loop. |

## Tests

The package has no tests of its own. `packages/host/test/e2e.test.ts` runs the real agent inside the real fence for every case, and `packages/gateway-web/test/gateway.test.ts` runs the login target and a gateway as its services. Run every test with `npm test` from the runtime root.

See docs/03-fence.md in the runtime repository.

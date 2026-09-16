---
name: troubleshooting
description: The failures a model meets inside Thetis and what to do. A step that throws or returns an invalid result, a tool that is refused or unknown, a package that will not install (scope, peer, build, path, manifest), a fork that is refused, a service that does not start, a provider error, a cancelled or timed out turn, a cold prompt cache, and where the logs, the session records, the journal, and the harness records are. Use when you ask "why did my turn end with an error", "why was install_package refused", "why did the tool return error:", "where are the logs", "why is my service not running", or "what does code fence mean".
metadata:
  title: Troubleshooting
  tags: [troubleshooting, errors, codes, step, tool, install, build, peer, unauthorized, service, provider, timeout, cancelled, logs, journal, sessions]
  related: [thetis/packages, thetis/pipeline, thetis/fence]
  version: 1
---
# Troubleshooting

## Error codes

Every kernel error carries a code. A turn that fails emits one `error` event with the message and the code, then `turn.end`. The session is saved with what the turn produced so far.

| Code | Meaning |
|---|---|
| `invalid` | An argument failed validation. |
| `unauthorized` | The user may not do the operation. |
| `not-found` | The session does not exist. |
| `busy` | The session already runs a turn. |
| `cancelled` | The turn or the request was cancelled. |
| `fence` | The fence request failed or timed out, or the agent exited. |
| `package` | Package code threw an error. |
| `build` | A build or clone command failed. |
| `peer` | A peer dependency is missing. |
| `provider` | No provider serves the model, or the provider reported an error. |
| `enumerator` | The enumerator returned an invalid plan. |
| `step` | A step returned invalid mutations. |
| `tool` | The model called an unknown tool. |
| `rpc` | The fence called an unknown kernel method. |

## A step throws or returns an invalid result

A thrown error in a step fails the turn with the code `package`. The message is the error and its stack. An invalid return fails the turn with the code `step`:

| Message | Fix |
|---|---|
| `step <id> returned a non-object result` | Return an object, or nothing. |
| `step <id> returned an invalid conversation` | Return an array of `{ role, content }` with a string `content`. |
| `step <id> returned an invalid call` | Return `{ ...ctx.call, ... }` with a string `model` and an array `messages`. |
| `step <id> returned an invalid harness` | Return an object, not an array. |

The variables keep the values from before the step. The step is package code. Read the message, fix the file, and send the next turn. The changed file is a new module on the next load.

A step that never runs: check the phase. A phase that is not in `config.phases` is never scheduled. `bench` is such a phase. Check the export name in `thetis.steps`. Check that the package is installed: read the package list in the system prompt.

## A tool is refused or unknown

A tool result that starts with `error:` is a refusal. The turn continues. Read the sentence. It names the next action.

| Result | Cause |
|---|---|
| `error: unknown tool: <name>` | No installed package attaches that name, or a project switched it off. See `thetis/projects`. |
| `error: <path> is outside the spaces you can reach (...)` | The path is outside home, shared, and the mounts. |
| `error: <path> is read-only (...)` | A write to shared or to an `ro` mount. |
| `error: old_text was not found in <path>. ...` | Read the file first. Whitespace must match. |
| `error: old_text appears N times in <path>. ...` | Add context, or pass `replace_all`. |
| `error: <path> exists (N lines). ...` | Use `edit_path`, or pass `overwrite`. |
| `error: the turn was stopped before this tool ran` | The person stopped the turn. |

A tool that throws gives `error: <message>`. A tool that returns nothing gives `null`.

## A package will not install

`install_package` throws. The message names the rule:

| Message | Code | Fix |
|---|---|---|
| `package name must be scoped (@scope/name): <name>` | | Name it `@<you>/<name>`. |
| `<name>: package.json needs a "thetis" field with a "type"` | | Add `"thetis": { "type": "..." }`. |
| `<name>: each step needs id, phase, export` | | Fix `thetis.steps`. |
| `<name>: each tool needs name and export`, `<name>: tool <tool> needs a description` | | Fix `thetis.tools`. |
| `<name>: user <you> may only install packages in scope @<you>/*` | `unauthorized` | Only an admin installs `@thetis/*`. Rename your package. |
| `<name> requires <peer>, which is not installed in this userspace` | `peer` | Install the peer first. |
| `command failed (<code>): <cmd>` | `build` | The `npm install` or `npm run build` failed inside the fence. Read the output. The fence may have no network. Remove the dependency or vendor it. |
| `package path must be inside the userspace: <source>` | `unauthorized` | Use a path under home. |
| `no package.json at <source>` | | Write the manifest first. |
| `<name>: main entry <main> does not exist after build` | | Create the `main` file, or fix `main`. |
| `only admins can install system packages` | `unauthorized` | Ask an admin. |

A package that installed but does not act: the change is live on the next turn, not this one. Send a message and check again.

## A fork is refused

| Message | Fix |
|---|---|
| `<name> is not installed in your userspace` | Fork only an installed package. Read the package list. |
| `as must be a plain directory name: <as>` | Use one path segment: lowercase letters, digits, `.`, `_`, `-`. |
| A target directory that exists | Delete or rename `packages/<as>` first. |

`delete_package` refuses with `<name> is not a package of <you>` for `@thetis/*`, and with `<name> does not live under the home directory; uninstall it instead` for a package installed from elsewhere.

## A service does not start

- `thetis serve` arms the supervisor. A one-shot CLI command does not. `thetis send` starts no service.
- The service starts when the fence opens and when the package is installed while the daemon runs.
- A service that throws is recorded in the journal as `service.fail`. The agent's `stderr` shows the message.
- A service must not write to `process.stdout`. Use `env.log`.
- A service listens on a unix socket under `run/`, not on a port.
- A fence closes when an admin changes the mounts. The services restart with it.

## A provider error

| Message | Fix |
|---|---|
| `no provider package is installed` | The system userspace has no provider. An operator checks `systemPackages._system`. |
| `no installed provider serves model "<model>"` | Set `config.model` to a listed id, or `call.model` in a step. `thetis models` lists the ids. |
| `OpenRouter apiKey is not configured` | `.env` needs `OPENROUTER_API_KEY`. |
| `provider error: ...` with `402 in_flight_budget_exhausted` | Set `defaults.max_tokens` in the provider configuration. |
| `the reply stopped at the output limit of N tokens (max_tokens) ...` | Raise `defaults.max_tokens`, or ask for less at once. |

The provider retries `429`, `408`, `409`, `425`, `5xx`, and a `402` that names `in_flight_budget`, 3 times by default.

## A cancelled or timed out turn

`cancelled`: the person pressed Stop. The streamed text stays. The next turn continues.

`fence`: a request ran longer than `requestTimeoutMs` (default 600000 milliseconds), or the agent exited. The agent restarts on the next request. A subagent runs inside your tool call, so a long subagent task hits this timer. Split the task.

`busy`: the session already runs a turn. Wait for `turn.end`.

## A cold prompt cache

`harness["@thetis/prompt-cache"].last.kind` says where the prefix broke. `head` means the model, the system prompt, or the tool list changed. `rewrite` means a message changed. `truncate` means the history was cut. The agent logs `prompt-cache: turn N: ...`. See the rules in `thetis/pipeline`.

## Where the records are

| Record | Where | How to read |
|---|---|---|
| The session: conversation, harness, turns | `<userspace>/sessions/<id>.json` | Inside the fence: `exec { cmd: "cat ../sessions/<id>.json" }`. The file tools do not reach it. On the host: `thetis sessions show --user <id> --session <id>`, or `/inspect` in `thetis chat`. |
| What the model received on the last call | `harness["@thetis/harness-core"].lastCall` | The Context dock, or the session file. |
| The prefix fingerprints | `harness["@thetis/prompt-cache"]` | The session file. |
| The plan and the questions | `home/plans/<id>.json`, `home/questions/<id>.json` | `read_path`. |
| Long tool output | `home/tool-output/<tool>-<time>.txt` | `read_path`, `search_files`. |
| The agent log | The kernel's `stderr`, each line with the prefix `[<user id>]` | On the host: `thetis chat --verbose`, or the daemon's log. Not readable from the fence. |
| The journal | `$THETIS_HOME/journal.jsonl` | An admin: `journal.tail` on the control socket, or the Activity section. Not readable from the fence. |
| The installed packages | The package list in the system prompt, or `env.kernel.packages.list()` | |
| The kernel registry | `$THETIS_HOME/registry.json` | On the host only: `thetis packages list --user <id>`. |

## Sources

- docs/02-kernel.md
- docs/03-fence.md
- docs/05-packages.md
- docs/07-providers.md
- docs/10-development.md
- docs/12-security.md
- docs/20-tools.md
- packages/kernel/src/packages/manager.ts
- packages/kernel/src/pipeline/runner.ts
- packages/kernel/src/pipeline/provider-call.ts
- packages/kernel/src/providers.ts
- packages/tool-exec/src/index.ts

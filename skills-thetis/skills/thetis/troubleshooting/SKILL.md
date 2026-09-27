---
name: troubleshooting
description: What fails inside Thetis and what to do: stopped replies, changes not live, refused restarts, failing steps, refused tools and installs, providers, logs. Use when a reply ends with an error, a tool returns error:, an install or restart was refused, a change is not live, or you need the logs.
metadata:
  title: Troubleshooting
  tags: [troubleshooting, errors, codes, retry, resume, interrupted, stale, apply, reload, restart, daemon, step, tool, install, build, peer, unauthorized, service, provider, timeout, cancelled, logs, journal, sessions]
  related: [thetis/packages, thetis/pipeline, thetis/fence, thetis/using]
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
| `interrupted` | Thetis stopped while the turn was running, and the next start closed the record. The turn continues by itself. |
| `yield` | The turn paused at a round boundary for a restart or an update. It continues by itself. |

## My change is not live

You changed a file and nothing behaves differently. There are three answers. Find the row before you change anything else.

| What changed | What it takes |
|---|---|
| A tool, a step, an enumerator, a UI command, a skill, a manifest, an extension setting, or any file one of those imports. A host package such as `@thetis/host-grants`, any of its files. | Nothing. It is live on the next message, or the next call. A file of the page itself shows after the page refreshes. |
| A background service, a provider, or any extension you installed, copied, switched back or edited in this reply. | It takes effect when this reply ends. The person's page applies it by itself once no reply runs ("Applied your changes to moo"), or shows **Changes ready** with **Apply** when a terminal is open or the person chose to be asked. New code for a shipped extension shows as **Updates ready** with **Update all**. Tell the person what changed. There is nothing for them to type. |
| Thetis's own core: `@thetis/runtime/kernel`, `@thetis/runtime`, `@thetis/runtime/sandbox`, `@thetis/runtime/door`, `@thetis/runtime/lib`, `@thetis/runtime/contracts`, or the `thetis` command (`@thetis/gateway-cli`). | An admin's **Update and restart**, or **Restart** when the card says "Restart to finish", on **Control panel › Overview**. (On the host: `thetis restart`.) These carry no feature; only a bug in them is a reason. |

A TypeScript package has to be built first. Every answer puts `dist/` into service, never `src/`. Run the build, then read the row.

A page applies changes only while it is open. With no page open nothing is applied, and the person's next visit shows the card. A chat driven from the command line is the same: say what is waiting, and the person applies it from the page.

**Why, for package authors.** The agent imports a package's entry with a query built from the newest modification time of the package's files, and a resolve hook carries that query to every module the entry imports inside the same package, so an edit anywhere in the package is a new module graph on the next call. The host imports a host package the same way. A service is started once, when the fence opens, and a provider instance is kept for the fence's life, so nothing short of a fence reload reads them again. Applying is that reload, in `drain` mode: a running reply stops at its next round boundary and continues by itself after. `thetis.config.json` and `.env` are the admin's: see `thetis/configuration`.

**On the host**, `thetis status` compares what is on disk against what each part loaded and names anything running older code. A workspace with no fence open is never stale: the next request opens it on whatever is there then. An admin sees the same as **Up to date**, **Update ready** or **Restart needed** under **Control panel › Extensions › All extensions** and **Advanced › Workspaces**, and applies for one person there with **Restart** (drained) or **Force…**. (On the host: `thetis reload --user <id> --drain`, or `--force` to cancel running turns at once. Both keep what the turn did and resume it.) `_system` is a legal target, and it is the one you want when the provider or the sign-in page changed.

## The restart was refused

`restart_daemon` answered with a sentence that begins `Refused, and nothing was restarted`. **Nothing was armed and nothing is going to happen.** Say what the sentence says and do not call the tool again. There is no second attempt to make. You read the sentence; the code below is what the journal and the Overview record.

| Code | The sentence says | What to do |
|---|---|---|
| `updating` | An update is installing; Thetis restarts by itself when it is done. | Nothing. The update restarts Thetis when it is done. |
| `off` | Restarts are switched off in this installation's configuration, `control.allowRestart`. | Only the operator can change it, at the host. |
| `unsupervised` | systemd did not start this daemon, so exiting would stop Thetis rather than restart it. | Ask the person to start it again themselves at the host. |
| `no-listener` | This process has no restart handler, so it is a short-lived command rather than the serving daemon. | You are inside `thetis send`, `thetis chat` or a bench run, and a restart would kill only that command. Ask for what you need in the running installation. |
| `young` | The daemon has been up for fewer seconds than `control.minUptimeSecs`, which is 60 by default. | Wait past that. If the last restart did not fix this, another one will not find it either: something else is wrong. |
| `policy` | The deployed systemd unit does not say `Restart=always`, or its `Restart=` could not be read at all. | Only the operator can put it right, at the host: `Restart=always` in the unit, then `systemctl daemon-reload`. Until then a restart would exit cleanly and stay down, taking the installation offline for good. |

Two answers that are not refusals:

- A restart is **already armed**. Asking again neither delayed it nor armed a second one. Nothing is broken. If the earlier reason no longer holds, say that an admin can call it off with **Cancel** on **Control panel › Overview** (on the host: `thetis restart cancel`).
- The account is **not an admin**: `Restarting Thetis is an operator action, and this account is not an admin, so nothing happened`. An admin does it from **Control panel › Overview** (on the host: `thetis restart`).

## A step throws or returns an invalid result

A thrown error in a step fails the turn with the code `package`. The message is the error and its stack. An invalid return fails the turn with the code `step`:

| Message | Fix |
|---|---|
| `step <id> returned a non-object result` | Return an object, or nothing. |
| `step <id> returned an invalid conversation` | Return an array of `{ role, content }` with a string `content`. |
| `step <id> returned an invalid call` | Return `{ ...ctx.call, ... }` with a string `model` and an array `messages`. |
| `step <id> returned an invalid harness` | Return an object, not an array. |

The variables keep the values from before the step. The step is package code. Read the message and fix the file. The changed file is a new module on the next call, so the person's **Retry**, or the next message, runs it.

A step that never runs: check the phase. A phase that is not in `config.phases` is never scheduled. `bench` is such a phase. Check the export name in `thetis.steps`. Check that the package is installed: call `list_packages`.

## A tool is refused or unknown

A tool result that starts with `error:` is a refusal. The turn continues. Read the sentence. It names the next action.

| Result | Cause |
|---|---|
| `error: unknown tool: <name>` | No installed package attaches that name, or a project switched it off. The `call` step of `@thetis/harness-core` resolves the name; a name in `call.hints.withheld` is run anyway. See `thetis/projects`. |
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

A package that installed but does not act: it takes effect when this reply ends, not inside it. Say so, and check again on the next message.

## A fork is refused

| Message | Fix |
|---|---|
| `<name> is not installed in your userspace` | Fork only an installed package. Call `list_packages`. |
| `as must be a plain directory name: <as>` | Use one path segment: lowercase letters, digits, `.`, `_`, `-`. |
| A target directory that exists | Delete or rename `packages/<as>` first. |

`delete_package` refuses with `<name> is not a package of <you>` for `@thetis/*`, and with `<name> does not live under the home directory; uninstall it instead` for a package installed from elsewhere.

## A service does not start

- `thetis serve` arms the supervisor. A one-shot CLI command does not. `thetis send` starts no service.
- The service starts when the fence opens and when the package is installed while the daemon runs.
- A service that throws is recorded in the journal as `service.fail`. The agent's `stderr` shows the message.
- A service must not write to `process.stdout`. Use `env.log`.
- A service listens on a unix socket under `run/`, not on a port.
- A fence closes when its mounts or its ssh grants change (`host.grants.mountsSet`, `host.grants.sshSet`): an admin changes mounts, and the person or an admin changes ssh keys, under **Control panel › Access**. The services restart with it.
- A service you edited keeps running the old code until the space applies the change, when this reply ends. See "My change is not live".

## A provider error

| Message | Fix |
|---|---|
| `no provider package is installed` | The system userspace has no provider. An operator checks `systemPackages._system`. |
| `no installed provider serves model "<model>"` | Choose a model the picker lists, or set `call.model` in a step. (On the host: `thetis models` lists the ids.) |
| `OpenRouter apiKey is not configured` | The server's `.env` needs `OPENROUTER_API_KEY`; the provider's manifest default is `${OPENROUTER_API_KEY}`, so nothing else is needed. An admin puts it there, then **Read the file again** on the extension's Settings tab (on the host: `thetis config reload`). |
| `provider error: ...` with `402 in_flight_budget_exhausted` | Set `defaults.max_tokens` in the provider's settings. |
| `the reply stopped at the output limit of N tokens (max_tokens) ...` | The round was already sent once more with twice the limit and a note to write in parts. Write large files in parts: several smaller writes or edits. Raise `defaults.max_tokens` only when the model's reasoning needs it. |

A provider failure does not throw out of the turn. The `call` step of `@thetis/harness-core` first decides whether sending the same round again could help, and does so after a growing wait (see "A reply that stopped"). When it cannot, or the tries run out, the step returns the finished rounds, marks a cut piece of text `partial` and the tool calls that never ran `notRun`, emits one `error` event of code `provider` with `kind` and `retryable`, and the `after` steps still run.

The provider tries a request again itself only before any of the reply exists: no response at all, or a `429`, `408`, `409`, `425`, `5xx`, or a `402` that names `in_flight_budget`, `retries` times (3 by default). Once the reply has started, retrying is the harness's alone.

## A cancelled or timed out turn

`cancelled`: the turn was stopped. A person's Stop leaves the streamed text, and the page offers **Continue**. A restart or an update of the space cancels with its own reason, and the turn continues by itself when the space is back.

`fence`: a request ran longer than `requestTimeoutMs` (default 600000 milliseconds), or the agent exited. The agent restarts on the next request. A helper chat runs inside your tool call, so a long helper task hits this timer. Split the task.

`busy`: the chat already runs a turn. Wait for `turn.end`. A resume that finds one running is refused the same way.

## A cold prompt cache

`harness["@thetis/prompt-cache"].last.kind` says where the prefix broke. `head` means the model, the system prompt, or the tool list changed. `rewrite` means a message changed. `truncate` means the history was cut. The agent logs `prompt-cache: turn N: ...`. See the rules in `thetis/pipeline`.

## Where the records are

| Record | Where | How to read |
|---|---|---|
| The session: conversation, harness, turns | `<userspace>/sessions/<id>.json` | Inside the fence: `shell { cmd: "cat ../sessions/<id>.json" }`. The file tools do not reach it. On the host: `thetis sessions show --user <id> --session <id>`, or `/inspect` in `thetis chat`. |
| What the model received on the last call | `harness["@thetis/harness-core"].lastCall` | The Context dock, or the session file. |
| The prefix fingerprints | `harness["@thetis/prompt-cache"]` | The session file. |
| The plan and the questions | `home/plans/<id>.json`, `home/questions/<id>.json` | `read_path`. |
| Long tool output | `home/tool-output/<tool>-<time>.txt` | `read_path`, `search_files`. |
| The agent log | The kernel's `stderr`, each line with the prefix `[<user id>]` | On the host: `thetis chat --verbose`, or the daemon's log. Not readable from the fence. |
| The journal | `$THETIS_HOME/journal.jsonl` | **Control panel › Activity**: a person sees the rows about them, an admin every row. (On the host: `journal.tail` on the control socket.) Not readable as a file from the fence. A `host.*` call is journalled without its arguments. |
| The installed packages | The `list_packages` tool, or `env.kernel.packages.list()` | |
| The kernel registry | The store, under `registry` | On the host only: `thetis packages list --user <id>`. |

## A reply that stopped

A reply that stops before its end keeps everything it finished, and the record says why in `session.interrupted.why`. Nobody types "continue", and you never ask the person to.

| `why` | What stopped it | What happens next |
|---|---|---|
| `provider` | The model's side failed, and sending the round again did not help or could not. | The row says why in one plain sentence ("The connection to the model kept dropping (5 tries), so the reply stopped here. Everything before it is kept."), with the raw words under **Details** and one **Retry** button. |
| `failed` | A step threw, or the fence died under it. | The same row, with **Retry**. |
| `restart`, `reload`, `crash` | Thetis restarted, the space applied an update, or the process died. | Continued by itself when the space is back: once, only for a top-level chat, and only within `resumeMaxAgeMs` (half an hour). The divider says "Resumed after Thetis restarted" or "Resumed after an update". |
| `yield` | A restart or an update asked the reply to pause at a round boundary. Nothing is partial. | Continued by itself, the same way. |
| none | The person pressed Stop, or a workflow's budget cut it. | A Stop shows "Stopped." with **Continue**. Nothing continues either by itself: each was somebody's decision. |

**Before the row.** A dropped or silent stream, `fetch failed`, `429`, `5xx` and an overloaded upstream are sent again by `@thetis/harness-core` up to `retryAttempts` times (5), after 2, 4, 8, 16, 32 seconds, at most `retryBudgetMs` (300000) in all. An empty reply, tool arguments that are not JSON, a content filter stop and the output limit get one more try each. The same request is sent again, so no tool of the lost round has run and the prompt cache still serves it. The page shows "The connection to the model dropped. Retrying in 8 s (2 of 5)." with **Retry now** and **Stop**, and "Reconnected after 1 retry." when it comes back. `context`, `credits`, `auth` and anything the provider called not retryable are never sent again: those need a fix, and then the person's **Retry**.

**What a resume does.** Retry, Continue and the automatic resume are one mechanism, `sessions.send(id, [])`: a turn with no input over the saved chat, so the person's message is never sent twice. A trailing piece of text marked `partial` is dropped first, and the tool calls marked `notRun` run first. Then the model answers from where the chat stands. A resume reads what is already in the chat; do not redo work that is there. A helper chat is resumed with `resume_subagent`, never by spawning a new one.

The provider's own sentences, under **Details**: `the connection closed before the reply finished, before any of it arrived` means the stream was cut before the model said anything; `... part-way through it ...` means the cut came after part of the reply; `the model returned an empty reply (finish_reason: stop)` means it finished with no text and no tool call. All three are retried as above.

## Sources

- src/kernel/packages/manager.ts
- src/kernel/pipeline/runner.ts
- packages/harness-core/src/index.ts
- src/kernel/providers.ts
- packages/tool-exec/src/index.ts
- src/lib/restart.ts
- packages/tool-operator/index.js
- packages/harness-core/README.md
- packages/gateway-web/README.md
- packages/provider-openrouter/README.md

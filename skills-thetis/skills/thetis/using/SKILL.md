---
name: using
description: Working inside Thetis day to day: sessions, subagents, the shell, file and plan tools, ask_user, tool groups, restart against reload, the home layout. Use when you ask how to read, edit or run something, hand work to a subagent, keep a plan, ask the person, find your files, or why a tool is missing.
metadata:
  title: Using Thetis
  tags: [sessions, turns, subagents, shell, terminal, files, read, edit, write, search, plan, todo, ask, home, notes, tools, groups, scoped, restart, reload, daemon]
  related: [thetis/packages, thetis/fence, thetis/troubleshooting]
  version: 1
---
# Using Thetis

## Where you are

You run inside one person's userspace. The fence is the boundary of that userspace. The paths are:

| Path | Content |
|---|---|
| `$THETIS_HOME/userspaces/<user>/` | The userspace root. Package code sees it as `env.root`. |
| `home/` | Your working directory. Package code sees it as `env.cwd`. Relative paths resolve against it. |
| `home/packages/<name>/` | The packages you write. |
| `home/plans/<session id>.json` | The plan of one conversation. |
| `home/questions/<session id>.json` | The questions you asked the person. |
| `home/tool-output/` | Long tool results that did not fit in a reply. |
| `home/projects/` | The project files. See `thetis/projects`. |
| `home/skills/` | Your own skills. See `thetis/skills`. |
| `store/node_modules/` | The installed packages. Package code sees it as `env.store`. |
| `store/src/` | Git clones of installed packages. |
| `sessions/<session id>.json` | One session record per conversation. |
| `run/` | The unix sockets of the services of this userspace. |

The shared directory `$THETIS_HOME/shared` is read-only for you. The system userspace writes it. Package code sees it as `env.shared`.

The system prompt tells you the user id and the home path. Each message from the person ends with a `[Turn context: Monday 2026-09-21 20:40 Europe/Berlin]` line that the harness adds: that is when the message was sent, in the daemon's zone unless `timeZone` is configured for `@thetis/harness-core`. The person does not see the line.

## Sessions and turns

A session is one conversation with its harness state. A turn is one pass through the pipeline. A session runs one turn at a time. The kernel saves the conversation and the harness at the end of every turn, also after an error.

The person can stop a turn. The text you streamed before the stop stays in the conversation. A tool call that did not run gets a tool message `error: the turn was stopped before this tool ran`.

## Subagents

A subagent is a session with a parent. It lives in the same userspace. It sees the same files and the same packages. It has its own conversation and its own harness.

Call `spawn_subagent` with `task` and a short `label` such as `research`. The tool creates a child session, sends the task, and returns `[subagent <session id> <label>]` on its first line and the final reply after it; `stopped: …` there means the person stopped it (what it had said so far follows), `error: …` means its turn failed. The person sees the subagent work under its label inside your conversation, so choose a label that says what it is doing. Stopping your turn stops the subagent. A subagent may call `spawn_subagent` itself. The child session persists after the reply.

The subagent turn runs inside your tool call. Your turn waits. The default request timeout is 600000 milliseconds. Give a subagent a task that ends inside that time.

Package code can do the same with `env.kernel.sessions.create(parentId)` and `env.kernel.sessions.askText(childId, text)`.

## The shell tools

`@thetis/terminal` gives you a shell session that stays open. The session keeps its working directory and its shell state between calls, so a `cd`, a virtualenv or an `ssh-agent` carries over. Your conversation gets its own session on the first command. The person can watch that session in their browser and type in it, and you are told when they do.

| Tool | What it does |
|---|---|
| `shell` | Runs a command and waits. Arguments: `cmd` (required), `session`, `cwd`, `timeoutMs` (default 120000), `background`. The reply is the exit status, the output, then any notes. |
| `shell_read` | What the session printed since your last read, and whether the command has finished. |
| `shell_send` | Raw input, for a command that is asking you something: a passphrase, a `y`, a commit message, a REPL. |
| `shell_interrupt` | Ctrl-C. Ends the command, keeps the session. |
| `shell_sessions` | This conversation's sessions, and `close` to end one. |

A command that outlives its wait **is not killed**. The answer says it is still running; collect the rest with `shell_read`, or pass `background: true` when you mean to come back for it later. A command that asks a question never ends by itself: answer it with `shell_send`, or stop it with `shell_interrupt`.

Use the shell to run programs and tests. Use the file tools to read, edit, search, and list files. The file tools cost fewer tokens, and they say when a result is partial.

`exec` was the tool for this until 2026-09-16. It is gone: it started in the home with a fresh shell every call, it had no stdin, and it killed the command it was waiting for.

## The file tools

The package `@thetis/tools-files` provides six tools.

| Tool | Arguments | Returns |
|---|---|---|
| `read_path` | `path` (required), `offset` (first line, default 1), `limit` (lines, default 400, max 2000) | Numbered lines, then a footer such as `[lines 1-400 of 2310; read on with offset 401]`. |
| `edit_path` | `path`, `old_text`, `new_text` (required), `replace_all` (default false) | A confirmation with the count of replacements and the first line, then a numbered snippet of the change. |
| `write_path` | `path`, `contents` (required), `overwrite` (default false) | `wrote <path> (N lines, M bytes)`. |
| `search_files` | `pattern` (required, a JavaScript regular expression), `path` (default home), `glob`, `mode` (`content`, `files`, or `count`), `ignore_case`, `max_results` (default 100, max 1000) | `path:line:text` lines, or paths with counts, or a total, then a tally line. |
| `find_files` | `glob` (required), `path` (default home), `max_results` (default 200) | Paths, newest first, then `N files matching <glob>`. |
| `get_directory` | `path` (default home), `depth` (default 1, max 3) | Entries, directories first with a trailing `/`, sizes for files, and a count. |

Rules:

- A path is relative to home, or absolute. You can reach home (read and write), the shared directory (read only), and each mount in `THETIS_MOUNTS` (`rw` or `ro`). A path outside these is refused with `<path> is outside the spaces you can reach (home rw, shared ro, ...)`.
- A write to a read-only root is refused. The refusal names the writable roots.
- A path with a `.git` component is protected from writes.
- `read_path` shows at most 24000 characters per window. It refuses binary files and files over 4 MiB. Lines over 500 characters are cut.
- `edit_path` needs `old_text` to match exactly once. Read the file first. Pass `replace_all` to change every occurrence.
- `write_path` refuses an existing file unless `overwrite` is true. It creates parent directories.
- `search_files`, `find_files`, and `get_directory` skip `.git`, `node_modules`, `dist`, `target`, `.cache`, `tool-output`, and binary files. They scan at most 20000 files.
- Every result passes through a bound of 32768 characters. A longer result goes to `tool-output/<tool>-<time>.txt` in home. You get the head, a line `[... N of M characters not shown here ...]`, the tail, and a footer that names the file. Read on with `read_path` or `search_files`.
- A refusal starts with `error:`.

## The plan tools

The package `@thetis/tools-plan` keeps one plan per conversation in `plans/<session id>.json`. Every `todo_*` tool returns the whole plan, one item per line, then a tally.

| Tool | Arguments | Rule |
|---|---|---|
| `todo_write` | `items`: strings or `{ text, stage, note }` | Replaces the plan. The tool mints the ids `t-1`, `t-2`, and so on. The ids keep counting across writes. At most 64 items. Text is one line of at most 200 characters. |
| `todo_add` | `items` | Appends. The call is refused when the plan would exceed 64 items. |
| `todo_mark` | `ids`, `stage` (`pending`, `active`, `done`, `dropped`) | Every id must exist. Only one item is active at a time. A second active item returns the first one to pending. |
| `todo_order` | `ids` | The listed ids come first, in that order. |
| `todo_read` | none | The plan as it is. |

Write a plan at the start of a task with more than one step. Mark an item `active` when you start it and `done` when it ends.

## Ask the person

`ask_user` takes `questions` (1 to 4 of `{ id?, question, options?, allow_multiple? }`) and `intro`. A question has at most 500 characters and 12 options of 120 characters. The tool records the questions and returns fixed text. Then end your reply with one short line that says you wait for the answers, and stop. The answers arrive as the next user message, one line per question.

Use `ask_user` when a task is ambiguous and a guess would waste work. Decide the rest yourself.

## Standing notes

Text you want in every prompt is a skill under `home/skills/` with `metadata.universal: "true"`; see `thetis/skills`. Text for one project is that project's instructions; see `thetis/projects`. The harness reads no file of yours into the prompt. Keep a universal skill stable inside a session: a change to it changes the system prompt and breaks the prompt cache prefix. See `thetis/pipeline`.

## The package tools

`install_package`, `uninstall_package`, `fork_package`, and `delete_package` come from `@thetis/tool-exec`. See `thetis/packages`.

## Tool groups and tool_search

`@thetis/tool-groups` scopes your tool list to what the conversation looks like it needs. Every package with tools is one group. The groups of the packages everyone has (the file tools, the shell, the plan tools, the package tools, the skills tools) are the core and are always in your list. The rest, your own installs and marketplace installs, are routed once, on the first message of the conversation: a group is admitted when a pinned or universal skill carries a `tool-group:<id>` tag, when one of its tags occurs in the message, or, when nothing matched, by the closest two groups in embedding space. The decision is pinned for the whole conversation and never made again, so the prompt prefix stays cached. Nothing is ever unloaded.

The system prompt tells you what is scoped under `# Tool groups`, one line per routable group, marked `[loaded]` or `[available]`. When you suspect a tool exists but cannot see it, call `tool_search`; do not work around the gap.

| Call | Effect |
|---|---|
| `tool_search {}` | The catalogue, with what is loaded. |
| `tool_search { query }` | Loads every group whose tags match the query, or the best-ranked one when none does, and lists their tools. |
| `tool_search { load: [ids] }` | Loads those groups. An unknown id is refused by name. |

A loaded group's tools are in your list from the next turn. A call to one of them by name works at once: the `call` step of `@thetis/harness-core` resolves a withheld tool against the installed packages and runs it, and its group is loaded for the rest of the conversation. A tool a project switched off stays refused. Scoping is an attention and token optimisation, never a permission boundary.

The pin is in `harness["@thetis/tool-groups"]`: `active`, `why` (`always-on`, `configured`, `skill`, `tag`, `dense`, `fusion`, `search`, `call`), `catalogue`, `mode`, `notes`.

## Restart the daemon

`restart_daemon` comes from `@thetis/tool-operator`. You have it only when that package is installed for you, and it is installed per admin, never for everyone. It takes one argument, `reason`, which is required: it is shown to everyone waiting and written to the journal, so name what changed and why a workspace reload cannot pick it up.

**It is pending, not immediate.** The call records the request and answers at once. Your turn finishes, your reply reaches the person, and only then does Thetis wait for every turn running anywhere to end, count down ten seconds where everyone can see it, and exit so that systemd starts it again. It waits two minutes at most, and then goes anyway and cuts whatever is still running. So say in that reply what is restarting, what it is for, and that it can still be called off. That reply is the only warning anyone gets.

**Prefer the reload.** A workspace reload replaces one person's service code in about a second and takes nothing else down; `thetis config reload` re-reads the configuration and `.env`; a host package is live on its next call. A restart ends every open shell session anywhere. It is only for a bug in the code the daemon read once when it started: the kernel, the host, the sandbox, the door, `@thetis/runtime/lib`, `@thetis/runtime/contracts`, the `thetis` command. Those carry no feature of yours: the model-call loop is a step of `@thetis/harness-core`, mounts and ssh keys are `@thetis/host-grants`, every default is a manifest's. A feature that seems to need a restart is in the wrong package. No tool asks for a reload: say what it needs, `thetis reload --user <id>` on the host or the Workspaces section of the control panel. See `thetis/troubleshooting` for which a change needs.

**Ask first.** Use `ask_user` before you call this, unless the person has just asked for a restart. It is their installation and their turns that end.

**A refusal means nothing happened.** The answer says what happened, why, and what to do instead. Say what it says, and do not call the tool again. A second call while one is already armed is not a refusal either: the answer says one is armed, that asking again changed nothing, and that there is no second attempt to make. `thetis/troubleshooting` lists the five reasons a restart is refused.

## Sources

- packages/terminal/index.js
- packages/tool-exec/src/index.ts
- packages/tools-files/package.json
- packages/tools-plan/package.json
- packages/tools-plan/lib/ask-user.js
- packages/harness-core/src/index.ts
- packages/tool-operator/package.json
- src/lib/restart.ts
- packages/tool-groups/README.md

---
name: using
description: How to work inside Thetis day to day. Sessions and turns, subagents with spawn_subagent, the shell session tools shell, shell_read, shell_send, shell_interrupt and shell_sessions, the six file tools read_path, edit_path, write_path, search_files, find_files, and get_directory with their exact arguments and bounds, the plan tools todo_write, todo_add, todo_mark, todo_order, and todo_read, ask_user, the home directory layout, and the standing notes in THETIS.md. Use when you ask "how do I read or edit a file", "how do I run a command", "how do I answer a command that is asking me something", "how do I hand work to a subagent", "where do my files live", "how do I keep a plan", or "how do I ask the person a question".
metadata:
  title: Using Thetis
  tags: [sessions, turns, subagents, shell, terminal, files, read, edit, write, search, plan, todo, ask, home, notes, tools]
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
| `home/THETIS.md` | Your standing notes. See below. |
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

The system prompt tells you the user id, the session id, and the home path.

## Sessions and turns

A session is one conversation with its harness state. A turn is one pass through the pipeline. A session runs one turn at a time. The kernel saves the conversation and the harness at the end of every turn, also after an error.

The person can stop a turn. The text you streamed before the stop stays in the conversation. A tool call that did not run gets a tool message `error: the turn was stopped before this tool ran`.

## Subagents

A subagent is a session with a parent. It lives in the same userspace. It sees the same files and the same packages. It has its own conversation and its own harness.

Call `spawn_subagent` with `task`. The tool creates a child session, sends the task, and returns `[subagent <session id>]` and the final reply. The child session persists after the reply.

The subagent turn runs inside your tool call. Your turn waits. The default request timeout is 600000 milliseconds. Give a subagent a task that ends inside that time.

Package code can do the same with `env.kernel.sessions.create(parentId)` and `env.kernel.sessions.ask(childId, text)`.

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

Write instructions to yourself in `home/THETIS.md`. The default harness puts its content in every system prompt under the heading *Your standing notes (home/THETIS.md)*. A package can also set `harness.notes` to a string. It appears under *Session notes*.

Keep `THETIS.md` stable inside a session. A change to it changes the system prompt and breaks the prompt cache prefix. See `thetis/pipeline`.

## The package tools

`install_package`, `uninstall_package`, `fork_package`, and `delete_package` come from `@thetis/tool-exec`. See `thetis/packages`.

## Sources

- docs/03-fence.md
- docs/06-sessions-and-users.md
- docs/20-tools.md
- packages/terminal/index.js
- packages/tool-exec/src/index.ts
- packages/tools-files/package.json
- packages/tools-plan/package.json
- packages/tools-plan/lib/ask-user.js
- packages/harness-core/src/index.ts

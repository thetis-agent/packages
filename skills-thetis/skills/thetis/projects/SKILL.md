---
name: projects
description: Projects: named workspaces with directories, instructions and switched-off tools, kept by @thetis/projects; the files, the two steps, the page commands, mounts. Use when you ask which project a conversation is in, why a tool or directory is missing, or how to add project instructions.
metadata:
  title: Projects
  tags: [projects, project, workspace, directories, instructions, mounts, tools, disable, switcher, place, sessions]
  related: [thetis/fence, thetis/web, thetis/using]
  version: 1
---
# Projects

`@thetis/projects` gives a person named workspaces in the web gateway. A project is a name, zero or more project directories, standing instructions, and a set of tools switched off. A conversation belongs to at most one project. The package is a `loader` with a `ui`. It changes no kernel code and mounts nothing.

## The files

All files are under `projects/` in home. Only this package writes them.

| File | Content |
|---|---|
| `projects/<id>.json` | `{ id, name, directories: [paths], tools: { disable: [tool names] }, skills: { disable: [] }, createdAt, updatedAt }`. |
| `projects/<id>.md` | The instructions. |
| `projects/sessions.json` | `{ "<session id>": "<project id>" }`. A session that is not listed has no project. |

An id is `p_` and 8 hexadecimal characters. A record whose `id` disagrees with its file name is ignored. An assignment to a project that no longer exists is ignored.

To find the project of your session, read `projects/sessions.json` with `read_path`. Then read `projects/<id>.json` and `projects/<id>.md`.

## The steps

| Step | Phase | Effect |
|---|---|---|
| `project-prompt` | `prompt` | Without a project, returns nothing. With one, appends to `call.system` a section `## Project: <name>`, one line per directory with `(mounted rw)`, `(mounted ro)`, or a note that the directory is not mounted and the command an admin must run, then the instructions under `### Instructions`. |
| `project-tools` | `call` | Without a project, or with nothing switched off, returns nothing. Otherwise returns `call` with the tools in `tools.disable` left out. The `call` phase runs after every `tools` step, so it sees the full list. |

The Tools dock of the web page lists the withheld tools under **Turned off right now** after the first turn.

## Project directories and mounts

A project directory does not open the fence. The fence binds a directory only when an admin mounts it: `thetis mounts add <user> <path> [--ro]`. Until then the directory is listed and marked as not mounted. The package reads what is mounted from `THETIS_MOUNTS`, the same source the file tools read.

When `read_path` refuses a project directory, do not retry. Ask the person to have an admin run the mount command the prompt section shows. A mount applies within a second. The fence closes and reopens with the new bind, and your services restart.

## The commands

The page sends these through `POST /api/ext/@thetis/projects/<verb>`. Any signed-in person may send them. Each answers `{ data }`. A refusal is `400 { error }`.

| Verb | Arguments | Answer |
|---|---|---|
| `list` | none | `{ projects: [{ id, name, directories, conversations }], assignments, current }`. |
| `get` | `{ id? }` | `{ project, directories: [{ path, mounted }], instructions, conversations, mounts, tools }`. Without `id`, the template of a new project. |
| `save` | `{ id?, name, directories?, disable?, instructions? }` | `{ project }`. Without `id`, creates. |
| `remove` | `{ id }` | `{ removed: id }`. Deletes the record, the instructions, and the assignments. |
| `assign` | `{ session, project }` | `{ session, project }`. `project` `null` takes the session out. |
| `sessions` | `{ project }` | `{ sessions: [ids] }`. |
| `mounts` | none | `{ mounts: [{ path, mode }] }`, from `THETIS_MOUNTS`. |

## The switcher and the place

The switcher sits in the sidebar under the menu button. It lists All conversations, each project, Settings, and New project. A chosen project narrows the conversation list. The choice is kept in `localStorage` under `thetis.project`. A conversation started with `+` while a project is chosen is assigned to it.

The place is the project's settings. It shows the name, the directories with a mount badge each, the instructions, and the conversation count. It shows every tool with a switch, and a Skills section. The actions are Save and Delete project. Nothing is sent until Save.

## Limits

| Limit | Value |
|---|---|
| Projects per person | 32 |
| Name | 80 characters |
| Directories per project | 64 |
| Tools switched off per project | 256 |
| Instructions | 32768 characters |

## Sources

- packages/projects/package.json
- packages/projects/README.md

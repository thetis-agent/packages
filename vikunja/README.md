# @bitmuse/vikunja

[Vikunja](https://vikunja.io)'s REST API (`/api/v1`) as Thetis tools, aimed at working kanban boards from a conversation: read a board column by column, move cards, create and edit tasks, add labels, assignees, comments and relations.

## Setup

Two settings, both in the package's Configure form or via `configure_package`:

| Key | Value |
|---|---|
| `url` | Base URL of the instance, e.g. `http://vikunja.local:3456` (with or without `/api/v1`). |
| `token` | An API token from **Settings → API Tokens** in Vikunja (starts with `tk_`). Secret. |
| `timeoutMs` | Optional; per-request timeout, default 30000. |

When creating the token, tick the permission groups the tools need. For the full set: **projects**, **project views**, **kanban buckets**, **tasks**, **task labels**, **task assignees**, **task comments**, **task relations**, **labels**, **users** (for assignee lookup) and **info**/**user** for `vikunja_health`. A 403 naming a route means the token lacks that group.

Then `vikunja_health` to confirm the URL, version and which user the token acts as.

## Vikunja's model, in one paragraph

A **project** has **views** (list, gantt, table, kanban). A kanban view has **buckets** (the columns), each with an optional WIP limit; the view knows which bucket is the *done* bucket (cards moved there are marked done) and which is the *default* bucket (new tasks land there). A **task** belongs to one project and sits in one bucket per kanban view. Labels are per user and shared across projects.

## Tools

| Tool | Does |
|---|---|
| `vikunja_health` | Version, features, whether the token works and as whom. |
| `vikunja_projects` | Project tree; with `id`, one project and its views. |
| `vikunja_project_save` / `vikunja_project_delete` | Create, rename, archive, nest, delete. |
| `vikunja_views` / `vikunja_view_save` / `vikunja_view_delete` | Views; set a view filter, the done and default buckets. |
| `vikunja_board` | **The board**: every column with its cards, one line each. `filter`, `search`, `hide_done`, `with_descriptions`, `raw`. |
| `vikunja_bucket_save` / `vikunja_bucket_delete` | Add, rename, reorder, set a WIP limit, mark done/default. |
| `vikunja_tasks` | Flat task list across projects or in one, with Vikunja filter syntax. |
| `vikunja_task_get` | One task in full, including which bucket it is in and its comments. |
| `vikunja_task_create` | New card, optionally straight into a bucket, with labels and assignees. |
| `vikunja_task_update` | Partial edit of fields, labels, assignees; move to another project. |
| `vikunja_task_move` | Move a card to another column by bucket title or id, optionally to top/bottom/after/before. |
| `vikunja_task_delete` | Delete a task. |
| `vikunja_labels` | List, search, create labels. |
| `vikunja_comments` | Read, add, edit, delete comments. |
| `vikunja_relate` | Subtask, blocking, related, … links between tasks. |
| `vikunja_request` | Any other `/api/v1` endpoint. |

Projects, views and buckets can be named by **title** wherever an id is accepted; ambiguity is answered with the candidates. The view argument is optional when a project has exactly one kanban view.

## Conventions the tools follow

- Vikunja creates with `PUT` and updates with `POST`; updates send the full object, so the tools read, merge and write back and strip read-only fields.
- Vikunja's unset date is `0001-01-01T00:00:00Z`; the tools show it as absent and accept `""` to clear a date.
- Descriptions and comments are HTML in Vikunja; plain text is wrapped, HTML passes through, and output is stripped to text.
- The token is only ever put in the `Authorization` header; it appears in no output or error.

## Development

```
node manifest.mjs   # regenerate package.json from the tool table
node test.smoke.mjs # in-memory Vikunja behind fetch, all tools
```

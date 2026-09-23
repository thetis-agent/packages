# @bitmuse/notion

The Notion API, as eleven tools for the model, sharing one client module.

| Tool | Endpoint(s) | What it's for |
|---|---|---|
| `notion_search` | `POST /v1/search` | Find a page or database by title. The discovery tool: start here for an id. |
| `notion_page_get` | `GET /v1/pages/{id}`, `GET /v1/pages/{id}/markdown` | Read a page's properties and its body as markdown. |
| `notion_page_create` | `POST /v1/pages` | Create a page, under another page or as a database row. |
| `notion_page_content` | `PATCH /v1/pages/{id}/markdown` | Edit a page's body: search-and-replace, append, prepend, or replace. |
| `notion_page_update` | `PATCH /v1/pages/{id}` | Change property values, icon, cover, lock or trash state. |
| `notion_database_list` | `POST /v1/search` | List databases the connection can see, with their data source ids. |
| `notion_database_query` | `POST /v1/data_sources/{id}/query` | Query a database's rows, filtered and sorted. |
| `notion_database_schema` | `GET /v1/data_sources/{id}` | Read a database's columns, types, and select/status options. |
| `notion_users` | `GET /v1/users`, `GET /v1/users/me` | List workspace people, or check what the token authenticates as. |
| `notion_comment_list` | `GET /v1/comments` | List unresolved comments on a page, grouped by thread. |
| `notion_comment_add` | `POST /v1/comments` | Comment on a page, a block, or reply into a thread. |

## Setup

Create an internal connection or personal access token at
<https://www.notion.so/my-integrations>, then share the pages or databases you
want it to see (open the page in Notion, ••• menu → Connections → add the
connection — Notion shares nothing by default, and children inherit access
from whatever page you share).

Give the token to this package as configuration, not as a literal in any file
committed anywhere:

```json
{
  "packages": {
    "@bitmuse/notion": { "token": "${NOTION_TOKEN}" }
  }
}
```

with `NOTION_TOKEN=ntn_...` in `.env`. Every tool in this group reads
`config.token` — set it once, all eleven work.

Optional keys on the same block: `version` (overrides the pinned
`Notion-Version` header — see below, and think twice), `beta` (sets
`Notion-Beta` for an opt-in feature), `timeoutMs` (request timeout, default
30000, clamped 5000–120000).

## Two things that trip people up

**Search matches titles only.** `notion_search` and `notion_database_list`
query Notion's title index, not page content. A page that exists but has a
title unrelated to your query will not turn up. If you expected a result and
did not get one, that is the first thing to suspect — not that the page
doesn't exist.

**A working token still gets 404 for anything not shared with it.** Notion
authorizes per-connection, per-page. `notion_users` with `whoami: true` tells
you the token is valid; it tells you nothing about what the token can *see*.
`object_not_found` from any other tool usually means: share the page with
this connection (••• menu → Connections), not that the id is wrong.

## Design notes

**One client module, not eleven copies.** The Rust/wasm version this was
built from ran each tool as an independently-compiled component with no
workspace to hold a shared library, so `notion.rs` was copied byte-for-byte
into all eleven crates and kept in sync by hand — the file said so in its own
header. A Thetis package is not compiled per-tool, so `client.js` is imported,
not copied.

**The Notion-Version header is pinned, not floating.** `client.js` sends
`Notion-Version: 2026-03-11` on every request. Notion's versioning promises
that a dated version keeps returning the same shapes forever; that promise
only pays off if the client actually names one version instead of resolving
to "latest" at request time. A floating version would mean a shape change on
Notion's side breaks parsing here with nothing committed on this side to
point at. Pinning turns an upgrade into a deliberate, reviewable one-line
change instead of an unannounced break.

**Properties are coerced to the schema.** Notion wants every property value
wrapped in a type tag (`{"select": {"name": "Done"}}`), which nobody writes by
hand from memory. `notion_page_create` and `notion_page_update` fetch the
parent data source's schema and coerce plain values (`{"Status": "Done"}`)
into the wrapped form; an already-wrapped value passes through untouched, so
the full API stays reachable.

**Ids, not just titles.** Every rendered object keeps its id on the line
right after its title, because the id is what the next call needs and titles
alone are not unique. A database id and its data source id look identical but
are not interchangeable (Notion split the two in 2025-09-03); several tools
try to recover automatically when handed the wrong one.

**Pagination never lies.** Every list ends with a footer that says either
"that is all of them" or gives the exact cursor to resume from — never a
silent truncation.

## The token, specifically

`env.config.token` is read once, in `client.js`, into a local variable used
only to build the `Authorization` header. It is never interpolated into a
returned string, an error message, or a log. `explainError` builds its hints
from Notion's own `status` and `code`, never from the client's own
configuration.

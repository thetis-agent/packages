# @thetis/canvases

Canvases for one person: boards of HTML artboards and notes on a pan-and-zoom surface, the way a design tool lays out screens. The agent makes and revises a canvas with seven tools from any conversation; the person opens it from **Canvases** in the web gateway's sidebar — above the conversations, under the project switcher — as a tab beside their chats, and there pans, zooms, focuses one artboard, moves and resizes artboards, adds notes and pages, tweaks the props an artboard declares, renames the canvas and moves it between projects. A canvas belongs to a project or is global. The package is a `tool` with a `ui` and a `skills` directory; it has no build step and one dependency, `@thetis/tools-files`, for reading a file out of the person's space into a canvas.

Each artboard is one self-contained HTML document, shown live in a sandboxed iframe at the size of its frame. The document runs its own styles and scripts and nothing of the page's: it has an opaque origin, no cookie, no way to fetch or submit, and reaches only its own files under the canvas's frame token and Google Fonts. That is the whole reason the gateway grew a `kind: "frame"` command (see `@thetis/gateway-web`): a document with an opaque origin sends no `SameSite=Strict` cookie for its pictures and fonts, so the page mints a token for the canvas and the frame fetches under it.

## What it provides

The manifest declares `type: "tool"`, `skills: "skills"`, seven `tools`, and a `ui` block with `dir: "ui"`, `entry: "index.js"`, `style: "index.css"`, a sidebar section, a tab kind and nine commands.

| Tool | Arguments | Effect |
|---|---|---|
| `canvas_create` | `title`, `project?`, `launch?`, `pages?` | An empty canvas. `project` is a project id, `"none"` for global, or omitted for the conversation's own project (from `projects/sessions.json`). Answers the id. |
| `canvas_list` | `project?` | One line per canvas: id, title, artboard count, project, last change, revision. |
| `canvas_read` | `canvas`, `sources?`, `boards?` | The index as JSON, a line per artboard (frame, size, declared props, problems), and with `sources` the HTML (all, or the `boards` named) up to 200 KB. |
| `canvas_write_board` | `canvas`, `file`, `html`, `x? y? w? h? title? page? expand? radius? props?` | Creates or replaces one artboard. New: 1440×900 unless given, placed right of the others on its page. Existing: keeps its frame and overrides unless given. Warns on a missing doctype, hosts the frame will not load, and a bad props block. At most 512 KB. |
| `canvas_layout` | `canvas` + a patch | The title, `launch`, `pages` (whole), `boards` by file (frames, title, page, expand, radius, props; null drops), `order` (the named go to the front), `notes` by id (null deletes, a new id with x, y, text creates). Never touches HTML. |
| `canvas_asset` | `canvas`, `name`, `path?` \| `base64?` | Stores a file under `assets/` from the person's space (through `@thetis/tools-files`' containment) or from bytes; at most 16 MB, 128 MB per canvas. Answers the relative reference, `assets/<name>`. |
| `canvas_delete` | `canvas`, `board?` | One artboard (file and frame; notes stay), or the whole canvas. |

`canvas` is an id (`c_` and 8 hexadecimal characters) or a canvas's exact title when exactly one has it.

| Slot | Id | Notes |
|---|---|---|
| `sidebar` (`slot: "section"`) | `canvases` | The Canvases section, order 20. Its rows are the chosen project's canvases, the global ones and the ones whose project is gone; under "All", every canvas with its project as a badge. ＋ makes one in the chosen project. Row menu: Rename, Move to a project, Make global, Delete. |
| `tabs` | `canvas` | A canvas as a tab. Toolbar: the title (click to rename), the pages, notes, zoom, fit, focus, properties, a menu. |

| Verb | Export | Arguments | Answer |
|---|---|---|---|
| `list` | `uiList` | `project?` (`"all"`, `"none"` or an id) | `{ canvases: [{ id, title, project, projectName, projectMissing, boards, updatedAt, rev }], projects: [{ id, name }] }`. |
| `get` | `uiGet` | `id` | `{ canvas, files: { <file>: { mtime, size, decl, problems } \| { missing } }, assets: [{ name, size }] }`. |
| `save` | `uiSave` | `id`, `patch`, `base?` | The patch applied on a fresh read; `{ rev, canvas, merged? }`, `merged` when `base` was not the revision found. |
| `create` | `uiCreate` | `title?`, `project?` | `{ canvas }`. |
| `remove` | `uiRemove` | `id`, `board?` | `{ removed }`. |
| `assign` | `uiAssign` | `id`, `project` (or null) | `{ id, project, rev }`. |
| `asset` | `uiAsset` | raw; `id`, `name`, `replace?` | `PUT` stores the body (`{ exists: true }` when the name is taken and `replace` was not asked); `GET` serves it. 16 MiB at most. |
| `frame` | `uiFrame` | frame; `{ canvas }` | Serves `<Board>.html` with the frame runtime put in, and `assets/<name>`; 404 for anything else. |
| `watch` | `uiWatch` | stream; `canvas?` | `{ ev: "snapshot", canvases, projects }`, then `{ ev: "changed", canvas, rev, title, project, updatedAt, files, assets }` or `{ ev: "removed", canvas }` for every change on disk whoever made it, and `{ ev: "ping" }` every twenty quiet seconds. |

## The files

Everything is under `canvases/<id>/` in the person's home, so a tool in the fence and a command in the gateway read and write the same thing, the Files place shows them, and a person can edit one by hand:

- `canvas.json`, the index: `{ v: 1, id, title, project, createdBy, launch, pages, boards, order, notes, rev, createdAt, updatedAt }`. `boards` by file: `{ x, y, w, h, title?, page?, expand?: "fill", radius?, props? }`; `order` back to front; `notes` by id: `{ x, y, text, kind?: "title1", w?, maxW?, size?, bold?, color?, fill?, page? }`; `pages`: `[{ id, name }]`; `launch`: `{ view: "canvas" }` or `{ view: "focused", file }`. Every write bumps `rev`.
- `<Board>.html`, one per artboard: letters, digits, `_ . -`, ending in `.html`.
- `assets/<name>`: png, jpg, jpeg, gif, webp, svg, css, js, json, woff, woff2, ttf, otf, mp4, webm, mp3.

Limits: 256 canvases, 64 artboards and 256 notes and 16 pages per canvas, 32 props per artboard, sizes 16 to 16384, coordinates within a million. Writes are a temporary file renamed into place; the temporary names start with a dot and the watcher skips them.

## Props and the frame runtime

An artboard may declare tweakable props in `<script type="application/json" id="canvas-props">`: an object by name of `{ editor: "color" | "text" | "number" | "select" | "toggle", default, label?, options?, min?, max?, step? }`. The page draws one field per prop; the value reaches the document live as a CSS custom property `--prop-<name>` on the root, an attribute `data-prop-<name>` on `<html>`, and the text of every `[data-prop="<name>"]` element (the `src` of an `<img>`). Overrides are kept per artboard in `boards[file].props`.

`lib/frame-runtime.js` is put into every artboard the frame serves. It reads the block, applies the values the page posts (`{ type: "props", values }`), and posts `{ type: "ready" }` on load and `{ type: "size", width, height }` when the document's size changes, which is what an `expand: "fill"` frame grows to. Messages carry the nonce the page put in the frame URL's fragment and are taken only from the parent window; the page takes only messages from that iframe's own window with that nonce. Links and forms in an artboard do nothing.

## Live sync

The page holds one `watch` subscription. The watcher in the gateway watches `canvases/` and, a moment after a change, reads that canvas again and says what it is now, with every artboard file's time. A tab reloads only the frames whose file time changed; a revision the page wrote itself (`save` answers it) is recognised as its own echo. What the person changes is applied at once, coalesced for a quarter second, and sent as one patch; the answered index is adopted when nothing else is in flight.

## Projects

`project` in the index names a project by its id. The package reads `projects/<id>.json` and `projects/sessions.json` directly, as `@thetis/workflows` does, so it works without `@thetis/projects` (everything is global then). The chosen project is `@thetis/projects`' own, read from the key it keeps in `localStorage` (`thetis.project`) in one function of `ui/model.js`; a canvas whose project was deleted shows everywhere until it is moved.

## Tests

`node --test test/*.test.js`: the store and the name rules, the completed index and its checks, the patch, the props block and the runtime's injection, the geometry, the seven tools over a temporary home (with and without project files), the commands and the frame's path matrix, the watcher (it leans on inotify), and the sidebar section over the shell's fake DOM. `test/commands.test.js` also checks that every browser module parses.

# @thetis/ui-workspace — module contract

The Workspace place (a file browser and editor over everything the fence can see), the Files dock
beside the chat, and file links in the transcript. Wireframes:
https://claude.ai/artifact/La1SngCLZ8bz86jasqCSzy. Plan: `~/.claude/plans/workspace-place.md`.

This file is the agreement between the modules while they are built in parallel. Change it before
you change a boundary, and say so in your report.

## Conventions (same as the other ui packages)

- Plain ES modules, no build step, no dependencies beyond `@thetis/tools-files` and `@thetis/projects`
  (server side only). Node 24. Tests with `node --test "test/*.test.js"`; the runtime root glob picks
  them up too, so **never leave a failing `*.test.js` on disk** — another session runs `npm test`.
- Browser modules live in `ui/`; every `ui/*.js` must pass `node --check`; `ui/index.js` exports only
  `default`. All CSS is scoped under `.ws-`; tokens, `.menu`, `.popover`, `.tree-*`, `.btn`, `.badge`,
  `.field`, `.kv`, `.card`, `.md-*` come from the shell. No inline `style=` attributes (CSP): set
  CSS variables through `el.style.setProperty` only when unavoidable.
- The gateway serves `ui/**/*.{js,css,svg,json,md}` at `ext/@thetis/ui-workspace/<path>`; the entry is
  imported as an ES module, so `import "./x.js"` between modules works. Vendored CodeMirror is under
  `ui/vendor/` (another agent produces it; read `ui/vendor/README.md` for the export names).
- Errors to people are sentences: what was believed, what happened, what to do. Reuse the exact
  tools-files wording for EROFS (`writeRefusal`).

## Server side (`index.js`, `lib/`)

Commands run in the person's own fence: `fn(args, env)` with `env: UiCommandEnv` (`cwd` = home,
`shared`, `user`, `role`, `session?`, `kernel`, `readFile`/`writeFile`, `exec`). Every path goes
through `resolveContained(env, path, {write})` from `@thetis/tools-files/lib/paths.js` (home rw,
shared ro, `THETIS_MOUNTS` at their mode; `.git` never written). Results are `{ data }`; a thrown
Error becomes a 400 with its message. **A JSON result is capped at 256 KiB and a JSON body at 1 MiB**,
hence the inline limits below.

Manifest (`package.json` → `thetis.ui`): `dir: "ui"`, `entry: "index.js"`, `style: "index.css"`,
`places: [{ id: "workspace", label: "Workspace", hint: "Your home, the shared directory, and the
directories of your projects", icon: <files path>, order: 30 }]`, `dock: [{ id: "files", label:
"Files", hint: "This project's directories, then Home and Shared", icon: <files path>, order: 40 }]`,
and the JSON commands below (`dock` order 105: after the docks that default to 100, before Skills at 110). The raw commands (`upload`, `raw`, `zip`) are **exported now but not
declared in the manifest** until the gateway grows `kind: "raw"` (see "Pending gateway seams").

| verb | export | args → data |
| --- | --- | --- |
| `roots` | `roots` | `{session?}` → `{ user, admin, home: {path, mode:"rw"}, shared: {path, mode:"ro"}, projects: [{ id, name, current, directories: [{ path, name, parent, state, mode, kind, home?, mount? }], summary: { ready, broken } }], mounts: [{path, mode}] }`. `current` is true for the project assigned to `session` (`projectOfSession`). `state` words are `stateOf`'s: `ready | empty-path | not-a-directory | skipped | unmounted`; `bound` for admins via `host.grants.mountsList`, as projects does. |
| `list` | `list` | `{path, hidden?}` → `{ path, root, mode, entries: [{ name, kind: "dir"|"file"|"symlink"|"other", size, mtime, hidden }], more }`. Directories first, then files, `localeCompare`; dotfiles only with `hidden: true`; 500 entries then `more: true`. |
| `stat` | `stat` | `{path}` → `{ path, display, root, mode, writable, mount?, kind, size, mtime, etag, language, preview, tooLarge, binary }`. `mount` is `{ path, mode }` when the file sits on a `THETIS_MOUNTS` entry (the mount root, for Copy to Home's target). `etag` = `"<mtimeMs>-<size>"`. `language` from the extension (`lib/language.js`: ts, js, jsx, tsx, json, md, html, css, py, sh, toml, yaml, plain). `preview`: `text | markdown | image | svg | pdf | audio | none`. `tooLarge` = size > 4 MiB. `binary` = NUL in the first 8 KiB (only checked when preview is text/markdown). |
| `read` | `read` | `{path, part?: "head"|"tail"}` → `{ path, etag, size, mtime, language, inline, text?, truncated, part }`. `inline` is true and `text` present when the file is ≤ 200 000 bytes; otherwise `inline: false` and the browser fetches the raw route. `part` windows a tooLarge file to its first or last 4 MiB (through raw). Refuses binary and directories with a sentence. |
| `write` | `write` | `{path, text, etag?, force?}` → `{ ok: true, path, etag, size, mtime }` (`path` absolute: a relative request resolves against home) or `{ ok: false, conflict: true, current: { etag, size, mtime, text? } }` when `etag` is given, differs from disk, and `force` is not true (`text` included when ≤ 200 000 bytes). Atomic: tmp file + rename. Creates the file when it does not exist. Text > 800 000 bytes must go through `upload`. |
| `mkdir` | `mkdir` | `{path}` → `{ path }`. |
| `rename` | `rename` | `{path, name}` → `{ path: newPath }`; same directory, refuses `/` in `name`, refuses to overwrite. |
| `delete` | `del` | `{path, dryRun?}` → dryRun: `{ files, dirs, bytes, capped }`; real: `{ removed: { files, dirs } }`. Recursive; refuses `.git` inside (whole delete refused with the sentence); refuses a root. |
| `count` | `count` | `{path}` → `{ files, dirs, bytes, capped }` (stops at 20 000 entries or 512 MiB, `capped: true`). |
| `resolve` | `resolve` | `{paths: string[], session?}` → `{ results: { [given]: { absolute, display, root, mode, kind } | null } }`. At most 64 paths; a relative path resolves against home, then against the session's project directories (first that exists). Never throws for an unreachable path: that entry is `null`. |
| `bind` | `bind` (role admin) | `{path, mode: "rw"|"ro"}` → whatever `@thetis/projects`'s `uiMount` answers. Delegate, do not reimplement. |

Raw exports (contract for the pending gateway seam):

- `upload(args, env, { body: Buffer })` with `args {dir, name, replace?}` → `{ path, size, etag, replaced }`
  or `{ exists: true, path }` when the name is taken and `replace` is not true. Cap 64 MiB
  (`MAX_UPLOAD`), enforced again here. Atomic write.
- `raw(args, env)` with `args {path, download?, part?}` → `{ status: 200, headers: { "content-type",
  "content-length"?, "content-disposition", "etag", "cache-control": "no-store" }, body: Readable }`.
  `content-disposition` is `inline` for `preview` image/svg/pdf/audio/text and `attachment;
  filename="…"` otherwise or when `download` is true. SVG and HTML are served as `text/plain` unless
  `download`. `part` windows text as in `read`.
- `zip(args, env)` with `args {path}` → `{ status: 200, headers: { "content-type": "application/zip",
  "content-disposition": attachment <name>.zip }, body: Readable }`. `lib/zip.js` writes a real zip
  (local headers, deflate via `zlib.deflateRawSync`, CRC-32 via `zlib.crc32`, central directory)
  streaming file by file; skips `.git` and `node_modules` (reported in a trailing `x-thetis-skipped`
  header is not possible once streaming starts, so the browser asks `count` first and shows the
  skip note itself). Refuses over 512 MiB or 20 000 files before starting.

Tests (`test/*.test.js`): a temp home and a temp mount dir, `THETIS_MOUNTS` set before importing
`index.js` (paths.js reads it at import), a fake env like ui-marketplace's (`user`, `role`, `cwd`,
`shared`, `readFile`, `writeFile`, `kernel.operator.call` recording calls). Cover every command,
the 200 000-byte inline edge, the conflict answer, `.git` refusal, ro refusal wording, hidden files,
the 500 cap, `resolve` with relative paths, zip round-trip (unzip with `unzip -l` if present, else
parse the central directory), and that every `ui/*.js` passes `node --check` and `ui/index.js`
exports only `default`.

## Browser side (`ui/`)

`index.js` — `export default function install(ext)`: builds `model = createModel(ext)`, registers
`ext.place("workspace", { open(root, params) })` (params `{ path?, line?, dir? }`; returns the
unmount function), `ext.dock("files", { draw() })`, and `ext.transcript(render)` from `links.js`.
Watches `ext.conversation` to redraw the dock.

`model.js` — `createModel(ext)`; one instance shared by place, dock and links. Owns:

- `roots({ session, force })` → cached `Roots` (the `roots` data) per session, refreshed on demand.
- `list(path, { force })` → cached listing; `invalidate(path)` after any write in that folder.
- `stat(path)`, `readText(path)` (JSON `read`; when `inline` is false, `fetch(ext.raw.url("raw", {path}))`
  and take `etag` from the response header), `write(path, text, { etag, force })`, `mkdir`, `rename`,
  `remove(path, { dryRun })`, `count`, `resolve(paths)`, `bind(path, mode)`.
- Explorer state: `expanded: Set<path>` (persisted in `localStorage["thetis.workspace.<user>.expanded"]`),
  `hidden: boolean` (dotfiles), `filter: string`, `selected: path | null`, explorer width
  (`localStorage["thetis.workspace.<user>.explorer"]`, default 280). `<user>` is `roots.user` from the
  first roots answer (`model.user`); before it the state is in memory, then the stored state is adopted
  once. The old unscoped keys are never read.
- Tabs: `tabs.list()` → `[{ path, name, dirty, kind: "editor"|"viewer", line? }]`, `tabs.open(path,
  { line, activate = true })`, `tabs.close(path)`, `tabs.active()`, `tabs.markDirty(path, dirty)`.
  Dirty buffers live in `sessionStorage["thetis.workspace.<user>.buffer:<path>"]` until saved or reverted.
- `watch(fn)` → unsubscribe; `fn({ kind: "roots"|"list"|"tabs"|"selection"|"explorer" , path? })`.
- Every localStorage/sessionStorage access is wrapped in try/catch.

`menu.js` — `openMenu(at, items, { onClose } = {})` → `close()`. `at` is an Element (below it) or
`{x, y}` (right-click). Builds `div.menu[role=menu]` with `button.menu-item[role=menuitem]` rows
(`span.menu-icon`, `span.menu-label`, `span.menu-key`), `"-"` → `div.menu-sep`; `.is-danger`,
`disabled`. Arrow keys wrap, Home/End, Escape and outside click close (stop propagation on the
capture phase like the shell's places menu so `#place` does not close). One menu at a time. Appended
to `document.body`, kept inside the viewport. Uses `ext.dom.el`. *(When the shell exposes
`ext.ui.menu`, this module becomes `export const openMenu = (...a) => ext.ui.menu?.(...a) ?? local(...a)`.)*

`file-menu.js` — `fileMenu(entry, host, actions)` → items for `openMenu`. `entry: { path, name,
kind: "dir"|"file", mode: "rw"|"ro", root }`, `host: "explorer"|"dock"|"chat"`. Order, by host:

- chat and dock: **Open in Workspace**, **Reveal in Files** (dock only from chat), `-`
- dir on explorer/dock: **New file** (n), **New folder**, **Upload files here…**, `-`
- all: **Download** (dir: **Download as zip**, with size from `count` filled in asynchronously), **Copy path**
- rw only: **Rename** (F2), `-`, **Delete…** (Del, danger)

`actions` is `{ open, reveal, newFile, newFolder, upload, download, copyPath, rename, remove }`
supplied by the host; items whose action is missing are omitted.

`explorer.js` — `mountExplorer(host, { model, ext, session, onOpen })` → `{ update(), reveal(path),
destroy() }`. Renders the head (title, New file, New folder, Refresh, Collapse all), the filter
`.field` with the dotfiles checkbox, and the tree with the shell's tree classes on its own rows
(`div.tree[role=tree]`, `div.tree-item[role=treeitem][aria-level][aria-expanded][data-path]`,
`span.tree-toggle`, `span.tree-label`, `div.tree-group[role=group]`) plus `.ws-row` extras: `.ws-ic`
(icon), `.ws-sub` (host parent path on a mount row), `.ws-mode.is-rw|is-ro` pill, `.ws-dot.is-ok|
is-err|is-warn|is-dirty`, `.ws-note.is-err|is-warn|is-info` rows for sentences (with the "Bind now"
button for admins and the `thetis mounts add <user> <path>` line for members), the project summary as
`.ws-note.ws-summary` directly under the project row and outside its `.tree-group` (visible when
collapsed; a project with a broken directory starts expanded), `.ws-group` for the Projects divider and
per-project headers in the dock. Bind now: a 502 / "not connected" failure is the workspace restarting
(`isRestartError`); one toast, then `model.roots({ force: true })` every 2 s for up to 90 s until
`directoryState` changes or settles after the restart, then the outcome toast (`bindOutcome`). Lazy: expanding a folder calls `model.list` and re-renders that subtree; `more`
renders a "Show all" row. Keyboard as the shell's tree (arrows, Home, End, Enter, Space, F2, Delete,
`n`). Right-click and a hover `⋯` (`button.ws-more`) open `fileMenu(entry, "explorer", …)`. Drag-over
a folder row adds `.is-drop`; drop uploads through `dialogs.upload`. Inline rename and new file/folder
use a `.field.mono` in the row; Enter commits, Escape cancels. Selection follows `model.selected`.

`tabs.js` — `mountTabs(host, { model, onActivate, onClose })` with `.ws-tabs > .ws-tab[.is-active]`
(`span.ws-tab-name`, `span.ws-tab-path`, `span.ws-tab-dirty`, `span.ws-tab-lock` on ro files, and
`button.ws-tab-close` on every tab) and a right cluster `.ws-tabs-right` the active view fills (segment
toggle, Save, Revert, Download, ⋯). Middle-click closes; closing a dirty tab asks with `ext.ui.confirm`.

`editor.js` — `createEditor(host, { ext, model, file, line })` → `{ destroy(), focus(), value(),
setValue(), goTo(line), isDirty() }`. `file` is the `stat` data plus text and etag. Imports
`./vendor/codemirror.js` on first use and the grammar file for `file.language`; passes the page nonce
(`document.querySelector('meta[name="csp-nonce"]')?.content`) to `EditorView.cspNonce`. Theme: no
CodeMirror theme extension; the editor takes colours from `index.css` (`.cm-editor` rules on the
shell tokens; `tok-*` classes from `classHighlighter`). Keys: default + history + search + indent
with Tab; Ctrl/Cmd+S → save. Save flow: `model.write(path, text, { etag })`; on `conflict` show the
banner (`.ws-banner.is-warn`: sentence + Show diff / Load theirs / Keep mine) and keep the buffer;
Keep mine → `force: true`. While the tab is visible, `stat` every 5 s; a changed etag with a clean
buffer reloads silently; with a dirty buffer shows the banner. Gutter marks changed lines vs the
loaded text (a simple line diff is enough). The poll stops for good when a stat fails with 401/403. Read-only
files render with `EditorView.editable.of(false)` and the info banner; Copy to Home writes a
home-relative target (`homeCopyPath(file, roots)`: `shared/<rel>`, `<mount name>/<rel>`, else
`copies/<name>`; never `~/`) and opens the copy by the absolute `path` the write answers. A `keydown`
listener on the editor's root stops propagation of plain printable keys so the shell's single-key
shortcuts never fire while typing.

`viewer.js` — `createViewer(host, { ext, model, file })` → `{ destroy(), mode, setMode() }`.
Markdown: Rendered (`ext.markdown(text)` with images resolved through `ext.raw.url("raw", {path})`;
without `ext.raw` the resolver answers null and the shell's `.md-img-missing` becomes a
`.ws-img-missing` box with the alt text and "Images need the raw file route, which this gateway does
not have yet." — no request,
code fences highlighted with `highlightToDom` from the vendor bundle when the grammar is loaded) or
Source (an editor). Images/svg/pdf/audio: the raw URL in `img`/`object`/`audio` with Fit / 1:1;
binary or unknown: the facts card with Download; `tooLarge` text: read-only viewer of the head with
"Show last 4 MB". The mode toggle is a `.ws-seg` in the tabs' right cluster and the last choice per
`language` is remembered in localStorage under `thetis.workspace.<user>.mode:<language>`.

`strip.js` — `mountStrip(host)` → `{ set({ path, root, mode, language, size, saved, cursor,
encoding, eol, readOnly }) }`, the 26 px `.ws-strip` in `--mono` on the statusbar tokens.

`dialogs.js` — `upload(ext, model, { dir, files, onDone })` (a `.ws-uploads` card in the place's
corner: per-file rows, progress from `ext.raw.put`'s `onProgress`, over-cap rows marked before
sending, an exists → confirm-replace step, Cancel remaining / Hide); `confirmDelete(anchor, model,
entry)` (`ext.ui.confirm` with `count` results, the running-conversation note when the roots data
says a conversation is on that project, and the folder checkbox); `downloadZip(ext, model, entry)`
(count first, refuse over the caps with the numbers, then `location.assign(ext.raw.url("zip",
{path}))` — the browser handles the save); `newEntry(explorer, dir, kind)`, `rename(explorer, entry)`.

`dock.js` — `drawDock(ext, model)` → `{ title: "Files", subtitle, body, actions }`. Body: filter,
then the tree with the current conversation's project directories first (each as a root row under
a `.ws-group` header with the project name), then Home and Shared; the same explorer module with
`compact: true` (no head). Click on a file → `ext.open.place("workspace", { path })`; folders expand
in place; `⋯`/right-click → `fileMenu(entry, "dock", …)`; drop → upload. Actions: Open the Workspace,
Refresh. Redraws on `ext.conversation.watch` and on model `roots` changes.

`links.js` — `installLinks(ext, model)`: registers `ext.transcript(render)`. The renderer **never
returns a Node** (that would replace the shell's card); it returns nothing and decorates after the
shell has drawn:

- on `tool.call` for `read_path`, `edit_path`, `write_path`, `get_directory`, `find_files`,
  `search_files` (any package): `queueMicrotask` → find `.pane[data-session="<session>"]
  .tool[data-tool="<id>"]`, wrap the path in `.tool-gist` in `a.ws-link[data-path]`, append
  `button.ws-open` ("Open") to the head; remember `path` under the run (`details.tool-run`).
- on `tool.result`: if the run has no `.ws-touched` strip yet, append one after `.tool-run-body`
  ("Files in this run:" + one `a.ws-link` per distinct path, in first-seen order).
- clicks: `ext.open.place("workspace", { path, line })`; right-click → `fileMenu(entry, "chat", …)`
  after `model.resolve([path])` says it is reachable (`entry.mode` from the answer).
- Prose linkification in message bubbles needs a shell seam (see below); until then only tool
  cards and chips are linked. Keep `linkifyText(node, resolved)` ready: it turns matching text runs
  (`(~|/)[^\s"'`)]+(:\d+)?` and `word/word.ext(:line)?` shapes) into `a.ws-link` when `resolve`
  confirmed them.

`index.css` — `.ws-place` (flex row filling `.place-body`: explorer column with a `.ws-resize`
handle, then `.ws-editor` column: tabs, banner, body, strip); phone (`max-width: 760px`): the place
stacks, `.ws-explorer-col` is the full-width list, `.ws-place.is-file` hides it and shows `.ws-editor`
full width with the `.ws-back` button ("Files") at the head of the tab bar; nothing in the file view
exceeds the viewport (`document.documentElement.scrollWidth <= 390` at 390 px: tabs scroll, names and
the strip's path ellipse). Editor tokens: `.cm-editor` background `var(--bg)`, gutter `var(--surface-1)`, active line
`var(--surface-2)`, selection `var(--accent-wash)`, cursor `var(--accent)`; `tok-keyword` accent-hot,
`tok-string` ok, `tok-comment` text-faint, `tok-heading` accent, etc. `.ws-uploads` card bottom-right.

## Pending gateway seams (built later, in gateway-web; do not edit gateway-web now)

1. `kind: "raw"` commands with `maxBytes`: `PUT|GET /api/ext/<scope>/<name>/<verb>/raw?args=<json>`;
   `ext.raw.url(verb, args)` and `ext.raw.put(verb, args, blob, { onProgress, signal })` in `ext.js`.
   Until then `ext.raw` is undefined: the browser modules must guard (`ext.raw?.url`) and show "not
   available in this gateway version" for upload, download and large files.
2. `ext.ui.menu(at, items)` lifted from `views/menu.js`.
3. A transcript decoration hook for message bubbles (`{ type: "message.rendered", node, role,
   session }` offered to renderers after the shell draws a bubble) for prose links.
4. A `tools-files` cue in the echo provider (`read: <path>` → `read_path`) for the live pass.

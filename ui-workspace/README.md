# @thetis/ui-workspace

The Workspace place of the web gateway: a file browser and editor over everything the person's fence
can see, a Files dock beside the chat, and file links in the transcript. The server half is a set of
commands that run in the person's own fence; the browser half (`ui/`) draws the place, the dock and
the links over them.

## The roots model

The explorer's top level is what the fence can reach, and nothing more:

- **Home** (`env.cwd`), read-write.
- **Shared** (`env.shared`), read-only.
- **Projects**, from `@thetis/projects`: each project with its directories, and for every directory
  the same state word the project page shows (`ready`, `empty-path`, `not-a-directory`, `skipped`,
  `unmounted`). A directory is reachable when it lies under the home or under a mount the fence took
  (`THETIS_MOUNTS`); an admin also sees the mounts written down for them, which tells `skipped` (the
  operator bound it, the host has nothing there) from `unmounted` (nobody bound it).
- **Mounts**, the raw `THETIS_MOUNTS` list, so a directory outside every project can still be named.

Every path in every command goes through `resolveContained` from `@thetis/tools-files`, so this package
sees exactly what the agent's file tools see: home rw, shared ro, each mount at its mode, `.git` never
written. A refusal is the tools-files sentence, unchanged.

## Commands

Each is `fn(args, env)` answering `{ data }`; a thrown Error is a 400 with its message.

| verb | args | answer |
| --- | --- | --- |
| `roots` | `{session?}` | `{ user, admin, home, shared, projects: [{ id, name, current, directories: [{ path, name, parent, state, mode, kind, home?, mount? }], summary: { ready, broken } }], mounts, bound? }` |
| `list` | `{path, hidden?}` | `{ path, root, mode, entries: [{ name, kind, target?, size, mtime, etag, hidden }], more }`; directories first, 500 rows, dotfiles only with `hidden` |
| `stat` | `{path}` | `{ path, display, root, mode, writable, kind, size, mtime, etag, language, preview, tooLarge, binary }` |
| `read` | `{path, part?}` | `{ path, etag, size, mtime, language, inline, text?, truncated, part }`; `text` when the file is at most 200 000 bytes, else the browser fetches `raw` |
| `write` | `{path, text, etag?, force?}` | `{ ok: true, etag, size, mtime }`, or `{ ok: false, conflict: true, current: { etag, size, mtime, text? } }` when `etag` no longer matches and `force` is not set. Atomic. Over 800 000 bytes goes through `upload` |
| `mkdir` | `{path}` | `{ path }` |
| `rename` | `{path, name}` | `{ path }`; same directory, one segment, never over something |
| `delete` | `{path, dryRun?}` | `{ files, dirs, bytes, capped }` for a dry run, else `{ removed: { files, dirs } }`; refuses a root and any tree with `.git` inside |
| `count` | `{path}` | `{ files, dirs, bytes, capped, zip: {…}, skipped: {…} }`; `zip` is what a zip would hold, `skipped` the `.git` and `node_modules` it leaves out |
| `resolve` | `{paths, session?}` | `{ results: { [given]: { absolute, display, root, mode, kind } \| null } }`; up to 64; a relative path is tried against home, then the session's project directories |
| `bind` (admin) | `{path, mode}` | what `@thetis/projects`' `uiMount` answers |

Raw exports, for the gateway's raw seam (exported now, declared in the manifest once the gateway routes
`kind: "raw"` commands): `upload(args, env, { body })` (`{dir, name, replace?}` → `{ path, size, etag,
replaced }` or `{ exists: true, path }`), `raw(args, env)` (`{path, download?, part?}` → `{ status,
headers, body }`), `zip(args, env)` (`{path}` → a streaming zip of the tree, without `.git` and
`node_modules`).

## Limits

| what | limit |
| --- | --- |
| text inline in `read` and in a conflict answer | 200 000 bytes (`INLINE_LIMIT`) |
| text in one `write` | 800 000 bytes (`WRITE_INLINE_LIMIT`) |
| a text file the editor opens whole | 4 MiB; over it `tooLarge`, and `part: "head" \| "tail"` windows 4 MiB through `raw` |
| one `upload` body | 64 MiB (`MAX_UPLOAD`) |
| a `count`, a delete's dry run, a zip | 20 000 entries or 512 MiB, then `capped: true`; a zip refuses over the caps before it starts |
| rows in one `list` | 500, then `more: true` |
| paths in one `resolve` | 64 |

Etags are `"<mtimeMs>-<size>"`. A file is binary when a NUL byte is in its first 8 KiB; that is checked
for the text kinds only. Languages come from the extension (`lib/language.js`): ts, js, jsx, tsx, json,
md, html, css, py, sh, toml, yaml, plain; previews are `text`, `markdown`, `image`, `svg`, `pdf`,
`audio` or `none`.

Tests: `node --test "test/*.test.js"` in this directory.

## Browser

The package has three surfaces in the web gateway, all drawn from one model (`ui/model.js`) that
caches roots and listings, keeps the explorer's state, and holds the open tabs with their unsaved
buffers in the browser session.

**The Workspace place.** "Workspace" in the ≡ menu (order 30) takes over the main pane with the
sidebar kept: an explorer column on the left (resizable, width remembered) and the editor column on
the right with a tab bar, a banner slot, the view and a 26 px strip. The explorer shows exactly what
the fence can see: Home (rw), Shared (ro), then one group per project with each project directory as
a mount row (host parent path in grey, a mode pill). The state of every directory comes from the
server with the tree, in the same words the project page and the prompt use, and a broken one gets a
sentence in the row, not a badge: "Not mounted. An agent cannot read this directory." with **Bind now**
for admins or the exact `thetis mounts add <user> <path>` command for members (`--ro` for read-only),
plus a project-level summary directly under the project row, outside the collapsible group, so it reads
even when the group is closed; a project with a broken directory opens on the first visit. Bind now
closes the person's fence, so its request normally dies with a 502: the explorer treats that as the
workspace restarting, says so once, asks the roots every 2 s for up to 90 s until the row's state
changes, redraws, and names the outcome; a real refusal shows its sentence. Folders load lazily; dotfiles hide behind a checkbox; the filter narrows the
loaded tree by name. Right-click or the row's ⋯ opens the file menu; drag files from the desktop onto
a folder to upload; F2 renames and Delete deletes in place; `n` starts a new file. On a phone the same
tree is the list and a file opens full width with a Back button.

**Editor.** A file opens in CodeMirror 6 from `ui/vendor/` (core plus one grammar file per language,
loaded on demand and cached; `plain` loads none). The editor carries no CodeMirror theme:
`editor.css` dresses `.cm-*` with the shell's tokens and colours the `tok-*` classes of
`classHighlighter`, so the palette follows the light and dark schemes like everything else, and the
page nonce goes to `EditorView.cspNonce` so its own stylesheet passes the CSP. Keys are the defaults
plus history, search (Ctrl+F) and Tab indentation; Ctrl/Cmd+S saves through `write` with the etag
captured at open. A 3 px bar in the gutter marks every line that differs from the text on disk, the
tab shows the dirty dot, and the unsaved text lives in the browser session until it is saved or
reverted, so a reload restores it. While a tab is visible the file is stat-polled every 5 s: a change
on disk under a clean buffer reloads silently; under a dirty buffer, or when a save meets a newer
file, the warn banner says when the file changed (and which conversation wrote it, when the server
says so) and offers Show diff, Load theirs and Keep mine (a forced write). The poll stops for good when a
stat answers 401 or 403 (the session is gone). Files on a read-only root open with `editable` off and an
info banner whose Copy to Home writes a copy under the home at a home-relative path (`shared/<path under
the shared root>`, `<mount name>/<path under the mount>`, else `copies/<name>`; never `~/`, which the
server does not expand), opens the copy by the absolute path the write answers, and drops the listing of
every directory on the way so the tree shows the new folder at once. The same notice and Copy to Home
appear on the Rendered view of a markdown file on a read-only root. A file read-only for its size alone
(over 4 MB, opened as a window) gets the large-file banner by itself: no read-only-root notice and no
Copy to Home, and the strip says Read-only. A character typed in
the editor never reaches the shell's single-key shortcuts. A read-only tab keeps its lock glyph and closes
like any other.

**Viewer.** What a tab shows depends on the `preview` word from `stat`. Markdown starts Rendered (the
shell's own renderer, with relative images resolved against the file's directory through the raw
route, or, without the raw route, drawn as a placeholder box with the alt text and no request; an image
the raw route refuses becomes the same box on its one error, "The image was not found at <path>.", and is
never asked for again; and code fences coloured by the same grammars as the editor) and a Rendered | Source segment in
the tab bar switches to the editor; the last choice per language is remembered. Images and SVGs show
on a checkerboard with Fit | 1:1, PDFs inline, audio with controls, each with a facts line. Anything
binary or unknown gets a facts card with Download. A text file over 4 MB opens read-only on its first
4 MB with a "Show last 4 MB" button. The strip under the view reads path, root and mode, language,
size, the saved state ("Saved 3 min ago", "Unsaved changes", "Read-only"), then cursor, encoding and
line ends. On a gateway older than 0.12.0 (no raw command kind), previews, uploads and downloads say so in a
sentence instead of failing.

**The Files dock.** The rail's Files button (dock order 105, after the shell's own docks and before
Skills) opens a 360 px dock: the same explorer in compact mode,
with the current conversation's project directories first (each under a header with the project
name), then Home and Shared. The subtitle names the project and how many of its directories are
ready; without a project it reads "Home and Shared". Clicking a file opens the Workspace place at that
path, folders expand in place, and a right-click or ⋯ offers the same file menu. The two header
actions open the Workspace and refresh the roots. The rail, and so the Files button, is hidden while a
place is open (a place takes the main, rail and dock columns); open the dock from the chat.

**Links in the transcript.** A transcript renderer never replaces the shell's tool card: it declines
every event and, a microtask later, decorates the card the shell drew. For `read_path`, `edit_path`,
`write_path`, `get_directory`, `find_files` and `search_files` the path in the card's gist becomes a
link pill (the full path on `data-path` even when the gist cut it short, a read's `offset` as the
line) and an Open pill joins the head; once a run has a result, a "Files in this run" strip under it
lists every distinct path the run touched, in first-seen order. A click opens the Workspace at the
path and line; a right-click asks `resolve` whether the path is reachable and, if so, opens the file
menu. Paths in message bubbles (the person's and the model's) become links too: when the shell offers a
settled bubble through `message.rendered`, the candidates are collected text node by text node (never
inside code fences or existing links), confirmed with one `resolve` call per bubble, and only the
reachable ones are linked; a made-up path stays plain text.

**One file menu.** `ui/file-menu.js` builds the item list once for every host (explorer, dock, chat)
from the entry's kind and mode, and `ui/menu.js` opens it (through the shell's `ext.ui.menu` when
present, else its own popover with the shell's `.menu` classes): Open in Workspace and Reveal in Files
away from the place, New file / New folder / Upload here on folders, Download (as zip for folders,
with the size counted in), Copy path, and Rename / Delete only where the root is writable.

**Dialogs.** Uploads go one at a time into a card in the corner of the place with a progress bar per
file; a file over 64 MB is marked and never sent, a name already taken asks "Replace?" first, and
Cancel remaining stops the queue. Delete opens the shell's confirm with the server's dry-run count and
size, the sentence that there is no trash, a note when a conversation is running on that project, and,
for folders, a checkbox the Delete button waits on. Download as zip counts first and refuses over
20,000 files or 512 MB with the numbers; `.git` and `node_modules` are left out and the toast says how
many files that was.

Storage keys, all guarded and scoped to the person the `roots` answer names (`<user>`), so two people
on one browser never share open folders, tabs or unsaved text: `localStorage`
`thetis.workspace.<user>.expanded`, `.hidden`, `.explorer`, `.mode:<language>`; `sessionStorage`
`thetis.workspace.<user>.tabs`, `.buffer:<path>`. Until the user is known the state is held in memory,
then the stored state is read once and merged; the old unscoped keys are never read, and the first run
with a known user deletes them. On a phone the tab bar's right cluster wraps under the tabs so Download
and ⋯ stay on screen, and a tree row's name ellipses so its pills stay visible.

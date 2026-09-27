---
name: web
description: How a package adds to the web page: the thetis.ui field, the slots, the commands a page sends, GET /api/ui, the /ext route, the ext seam, notices. Use when you add a dock, a place, a panel section or a notice, call your package from a page, or a ui was refused.
metadata:
  title: The web page
  tags: [web, gateway, ui, dock, place, panel, chip, sidebar, shelf, statusbar, notice, command, verb, ext, browser, extension, seam, developer]
  related: [thetis/packages, thetis/projects, thetis/marketplace]
  version: 1
---
# The web page

`@thetis/gateway-web` serves one person's page from that person's own fence, on `run/web.sock`. A package can add to the page. It declares what it adds in the `ui` field of its manifest. The gateway reads the field from `kernel.packages.list()` on each request. The kernel never reads it.

## The declaration

```json
"thetis": {
  "type": "ui",
  "ui": {
    "dir": "ui",
    "entry": "index.js",
    "style": "index.css",
    "dock":     [ { "id": "todo", "label": "Todo", "icon": "M5 5h10v10H5z", "hint": "The plan", "wide": false } ],
    "panel":    [ { "id": "people", "label": "People", "note": "Who can sign in.", "role": "admin" } ],
    "chips":    [ { "id": "todo" } ],
    "commands": [ { "verb": "plan", "export": "uiPlan", "label": "Read the plan" } ]
  }
}
```

| Key | Meaning |
|---|---|
| `dir` | The directory of browser files, relative to the package root. Default `ui`. It must not leave the package. |
| `entry` | An ES module, relative to `dir`. The page imports it and calls its default export `install(ext)`. Optional. A `.js` file inside `dir`. |
| `style` | A stylesheet, relative to `dir`. The page links it once. Optional. A `.css` file inside `dir`. |
| `dock`, `panel`, `places`, `sidebar`, `chips`, `composer`, `shelf`, `statusbar` | Slot entries. Each entry has an `id` that matches `^[a-z][a-z0-9_-]{0,31}$`. It can have `label`, `icon`, `hint`, `note`, `wide`, `role`, and `order` (default 100). |
| `commands` | The verbs the package's own page may send. `verb` matches the id pattern. `export` names a function export of the package's `main`. `role` is the least role that may send it. Default: any signed-in person. |

The slots:

| Slot | Where it shows |
|---|---|
| `dock` | A button in the rail. It opens a panel beside the transcript, 360px wide, or 620px with `wide: true`. |
| `panel` | A section of the control panel. Panel ids are namespaced by package. |
| `places` | An item in the sidebar's menu. It takes over the main pane. |
| `sidebar` | Today only `{ id: "head" }`: a slot at the top of the sidebar. |
| `chips` | A chip in the chat bar. |
| `composer` | A control beside the model picker. |
| `shelf` | A drawer above the composer. |
| `statusbar` | An item in the status bar. |

`icon` is SVG path data for a 20 by 20 viewBox. `wide` is for docks. `note` is for panel sections.

## Composition

`GET /api/ui` answers `{ extensions, refused }`. There is one entry per package with a valid `ui`, in install order. The rules:

- A package without `ui` is skipped.
- Every value is checked. A missing, empty, or too long string refuses the package. So does an id that does not match the pattern. So does an entry or verb declared twice. So does a `dir`, `entry`, or `style` that leaves its directory or does not exist.
- A `dock`, `places`, `sidebar`, `chips`, `composer`, `shelf`, or `statusbar` id belongs to the first installed package that declares it. A later package with the same id is refused.
- A refusal is `{ package, message }`. The rest still composes.
- Entries and commands with a `role` above the person's role are left out. Hidden entries are named in `hidden` as `<slot>:<id>`.

## Files

`GET /ext/<scope>/<name>/<path>` serves `<store>/node_modules/<scope>/<name>/<dir>/<path>`. Only `.js`, `.css`, `.svg`, `.json`, and `.md` are served. The route answers `404` for a path that leaves `dir`. The page is served with a Content Security Policy that allows only same-origin scripts and styles. Inline scripts do not run.

## Commands

The page sends `POST /api/ext/<scope>/<name>/<verb>` with a body `{ session?, args? }`. The checks, in order:

| Check | Refusal |
|---|---|
| The package is installed here, its `ui` is valid, and it declares `verb`. | `404` |
| The person's role clears the command's `role`. | `403` |
| `session`, when given, names one of the person's own sessions. | `404` |
| `args`, when given, is an object. | `400` |
| The package's `main` exports the function. | `500` |
| The export answers within 30000 milliseconds. | `504` |
| The answer, as JSON, is at most 262144 bytes. | `502` |

The gateway calls the export with `(args, env)`. `env` is the fence environment (`cwd`, `root`, `store`, `shared`, `exec`, `readFile`, `writeFile`, `kernel`) plus `user`, `role`, and `session` when one was named. The handler runs in the person's own fence, as the person. It does not get the package's configuration.

A string result becomes `{ text }`. Nothing becomes `{}`. An object is passed as `{ text?, data? }`. A thrown error answers `400 { error }` with its message.

An admin's command reaches the operator table through `env.kernel.operator.call(method, args)`. The kernel checks the role again on every call.

## The browser seam

The page imports `entry` and calls `install(ext)`. `ext` is bound to the one package. It offers one registration function per slot. It offers `transcript` for a renderer and `request(verb, { session, args })` for the package's own verbs. It also offers the shell's `dom`, `ui`, `markdown`, `toast`, `conversation`, `sessions`, `events`, `redraw`, and `open`. The full table is in [references/ext-seam.md](references/ext-seam.md).

Five members serve the page's life across updates and restarts, and are the one implementation every package uses:

- `ext.notice(id, spec)`: a persistent card in the bottom-right corner, one per id, replaced in place. The Updates ready card, the admin's Thetis update card and the restart countdown are notices.
- `ext.awaitReturn()`: waits for Thetis to go away and come back after an apply or a restart. Do not write your own reconnect loop.
- `ext.developer()` and `ext.onDeveloper(fn)`: the person's **Developer details** switch. Raw dumps, problem lists and internal rows show only while it is on.
- `ext.turns.running()` and `ext.turns.onIdle(fn)`: whether a reply runs. Wait for idle before anything that restarts the person's space.
- `ext.build`: the build id the page was loaded with. The page refreshes itself on a changed build and keeps what is typed in the composer.

Words a person reads come from the page's vocabulary: see the table in `thetis`. Say "your space", "extension", "apply" and "Restart Thetis", never fence, reload or daemon, and put raw error text under a **Details** fold.

A registration whose id is not in the declaration is ignored. A throwing `draw`, `mount`, `open`, or `render` is caught and reported once per package per slot. Build DOM nodes with `ext.dom.el(tag, props, ...children)`. Do not use `innerHTML`. A module must define `install` and do nothing else at import time.

## Add a dock

1. Declare `"dock": [{ "id": "notes", "label": "Notes", "hint": "Your notes" }]` and `"commands": [{ "verb": "notes", "export": "uiNotes" }]`.
2. Export `uiNotes(args, env)` from `main`. Read files with `env.readFile`. Return `{ data }`.
3. Write `ui/index.js`:

```js
export default function install(ext) {
  const { el } = ext.dom;
  let text = "";
  ext.dock("notes", {
    draw: () => ({ title: "Notes", body: el("pre", {}, text) }),
  });
  async function refresh() {
    const session = ext.conversation.current;
    if (!session) return;
    const { data } = await ext.request("notes", { session });
    text = JSON.stringify(data, null, 2);
    ext.redraw("notes");
  }
  ext.conversation.watch(refresh);
  ext.events.watch((m) => { if (m.event?.type === "turn.end") refresh(); });
  refresh();
}
```

4. Install the package. When the reply ends, the page applies it and refreshes itself, and the rail shows the button.

`draw` runs on open and on `ext.redraw()`. `ext.conversation.current` is the id of the open conversation, or nothing. Do not send a request from `draw`.

## Add a place

1. Declare `"places": [{ "id": "reports", "label": "Reports", "icon": "..." }]`.
2. Register it:

```js
export default function install(ext) {
  ext.place("reports", {
    open: (root, params) => {
      root.append(ext.dom.el("p", {}, `Report ${params?.name ?? "index"}`));
      return () => {};
    },
  });
}
```

The shell draws the header and the close button. `open` returns an unmount function. The sidebar's ≡ menu lists the place after **Control panel**, **Extensions** and **Files**. `ext.open.place("reports", { name })` opens it from your own code.

## Shipped extensions

| Package | Fills |
|---|---|
| `@thetis/tools-plan` | The Todo dock, the todo chip, the transcript renderers for `todo_*` and `ask_user`, the commands `plan` and `mark`. |
| `@thetis/ui-tools` | The Tools dock, with a `reads only` or `can change things` badge from each tool's `reads`. Command `tools`. |
| `@thetis/ui-context` | The Context dock. Commands `context` and `context-page`. |
| `@thetis/ui-skills` | The Skills dock. Its problem list shows only with developer details on. |
| `@thetis/ui-admin` | The control panel's Overview, People, Models, Access (Mounts, SSH keys), Activity, Account and Advanced (Workspaces, Extensions by person, Server settings) sections, one page per extension under the built-in Extensions section, and the admin's Thetis update notice. Everyone sees Models, Access, Activity and Account, each about themselves. The rest are for an admin. |
| `@thetis/ui-marketplace` | The **Extensions** place (its id stays `marketplace`), the **Updates ready** card on every page, and twenty-nine commands, `updates` and `fence-reload` (apply updates to the person's own space, always drained) among them. |
| `@thetis/ui-workspace` | The **Files** place (id `workspace`) and the Files dock. |
| `@thetis/terminal` | The terminal drawer (`shelf`) and its chip. |
| `@thetis/compaction` | The `ctx` chip, the Compaction dock and the transcript card of a compaction. |
| `@thetis/projects` | The sidebar head switcher and the Project place. |
| `@thetis/effort` | The Effort pill beside the model picker (`composer` slot). Commands `effort-state`, `effort-set`, `effort-models`. |
| `@thetis/harness-core` | No page files. The command `retry-now`, which the transcript's **Retry now** sends while a round waits to be sent again. |

The gateway itself draws the failure row with **Retry** or **Continue** (`POST /api/sessions/<id>/resume`), the retry row, the "Resumed after…" divider, the reconnect loop, and the restart countdown every person sees.

## Sources

- packages/gateway-web/README.md
- packages/gateway-web/src/ui.ts
- packages/gateway-web/assets/lib/ext.js
- packages/ui-context/ui/index.js

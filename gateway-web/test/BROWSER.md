# Browser checklist for the web gateway

The browser code has no automated test. This checklist is driven through the Playwright MCP browser
against a throwaway data directory (`docs/15-web-gateway.md` §10), and its result goes into the commit
message of any phase that touches `assets/`. Each step names the DOM it expects, by id or class, so it
can be checked with a snapshot or `document.querySelector` rather than by eye.

## Setup

```sh
THETIS_HOME=.devhome node bin/thetis.js init
# .devhome/thetis.config.json: "door": {"host":"127.0.0.1","port":8799},
#   packages["@thetis/gateway-login"] = {"secure": false},
#   packages["@thetis/provider-openrouter"].apiKey = <a key> (only needed to send a message)
THETIS_HOME=.devhome node bin/thetis.js users add dev --admin
echo devpass123 | THETIS_HOME=.devhome node bin/thetis.js users passwd dev
THETIS_HOME=.devhome nohup node bin/thetis.js serve > .devhome/serve.log 2>&1 &
```

Open `http://127.0.0.1:8799/login` at a viewport of at least 1000px wide (under 860px the chat-bar chips
are hidden by design; under 760px the sidebar becomes a drawer). Stop the daemon by killing the pid whose
listening socket is `.devhome/thetis.sock` (`ss -lxp | grep devhome/thetis.sock`), then delete `.devhome`.

## Steps

1. **Sign in** as `dev` / `devpass123`. Expect the page at `/dev/`: `#sidebar` with `#session-list`
   showing "No conversations yet", `#sidebar-places` holding one `.foot-action[data-place="@thetis/gateway-web#panel"]`
   labelled "Control panel" before "Log out", `main.main` with `nav#tabs` holding only `#new-tab`, `#panes`
   showing `.pane.is-empty.is-active` with `.transcript-empty` ("No conversation open."), the composer
   `#composer` with `#composer-tools .composer-slot[data-slot="@thetis/gateway-web#model"]`. `#rail`, `#dock`,
   `#shelf`, `#place` and `#statusbar` all carry `hidden`. No console errors.
2. **New conversation** with `#new-chat`. Expect one `.tab.is-active` in `#tabs` (`.tab-title` "New
   conversation", a `.tab-close`), one `.pane.is-active[data-session]` with `.chat-bar` (`.chat-title`,
   `.chips#chips-<id>` holding a hidden `[data-chip="@thetis/gateway-web#todo"]`, `.chip-model`,
   `.archive-chat`) and a `.transcript` with `.transcript-empty` ("No messages yet"), and a matching
   `.session.is-active` row in the sidebar. The `.picker` in `#composer-tools` is visible.
3. **Second tab** with `#new-tab`. Expect two `.tab`s, the new one `.is-active`; two `.pane`s, only the
   new one `.is-active` (the other keeps `visibility: hidden`).
4. **Send one message** in `#input` (Enter). Expect in the active pane, in order: `.msg.is-user` (first
   `.is-pending` with `.pending-note`, then plain), the tab's `.tab-dot` visible while the turn runs
   (`.tab.is-working`), `.chat-state` visible, then `.msg.is-assistant .msg-text` with the reply and a
   `.msg-usage` footnote. The other pane still holds its own content (0 `.msg`). The sidebar row shows the
   working step while it runs and the preview and `.session-meta` after.
5. **Switch tabs from the sidebar**: click the other `.session-open` row. Expect its `.tab.is-active` and
   `.pane.is-active`; the pane with the reply keeps its 2 `.msg`s. Click the first tab's `.tab-open` to
   come back the same way.
6. **Model pill**: click `.pane.is-active .chip-model`. Expect the composer's `.picker.is-open` with a
   `.picker-menu` listbox; pick a model. Expect the chip text to change, `.chip-model.is-set`, the
   `.picker-label` to match, and the sidebar row's `.session-meta` to name it.
7. **Rename**: click `.pane.is-active .chat-title`. Expect `.session-rename` in the sidebar row; type a
   name, Enter. Expect `.tab-title`, `.chat-title`, the row and `document.title` to carry it.
8. **Archive**: click `.pane.is-active .archive-chat`. Expect a `.toast` "Conversation archived." with a
   `.toast-action` Undo, the row under `details.session-archived[open]`, `.tab.is-archived`, and the
   button's title "Restore this conversation". Click it again: the row returns to its bucket.
9. **Control panel as a place**: click `#sidebar-places [data-place]`. Expect `#app.is-place`, `#place`
   without `hidden` and `main.main` not displayed, `.place-title` "Control panel", `.place-sub`, and in
   `.place-body` a `.panel-shell` with `.panel-nav-item`s (Packages first, `.is-active`; People, Models,
   Activity, Overview for an admin) and `.panel-main` holding `.panel-note` and the Packages `.table`.
10. **Close the place** with `.place-close`. Expect `#app` without `is-place`, `#place[hidden]`, and the
    same `.tab.is-active` and `.pane.is-active` as before. Open it again and press Escape: same result.
11. **Close tabs**: click `.tab.is-active .tab-close`. Expect the neighbour tab `.is-active` and its pane
    shown. Close the last one: expect no `.tab`, `.pane.is-empty.is-active`, `document.title` "Thetis",
    and the composer `.picker` hidden.
12. **Reload** the page. Expect the newest unarchived conversation opened as the one `.tab.is-active`
    with its transcript restored (the `.msg`s and the `.msg-usage`).
13. **Narrow screen** (resize to 700px): `#toggle-sidebar` in `#tabs` is displayed; clicking it adds
    `.sidebar.is-open` and shows `#sidebar-veil`; clicking the veil closes it.
14. **The todo chip** stays hidden unless the conversation has a plan (a `todo_*` result); with a plan it
    reads `todo n/m` and opens `.popover.plan-popover`. Optional: needs a model that calls the tool.

## The seam, without a package

Until an extension package is installed, the slots can be exercised from the console (or
`browser_evaluate`) by importing the shell's own modules — the loader would do the same with a real
`api/ui` entry:

```js
const registry = await import("/dev/assets/lib/registry.js");
const { createExt } = await import("/dev/assets/lib/ext.js");
const decl = { package: "@test/probe", dock: [{ id: "tools", label: "Tools", icon: "M4 4h12v12H4z", wide: true }],
  places: [{ id: "page", label: "Probe page" }], chips: [{ id: "count" }], shelf: [{ id: "term", label: "Terminals" }],
  statusbar: [{ id: "load" }], panel: [], sidebar: [], composer: [], commands: ["ping"] };
registry.declare(decl);
const ext = createExt(decl);
```

Expect after `declare`: `#rail` shown with `.rail-btn[data-dock="@test/probe#tools"]`, `#sidebar-places`
gaining "Probe page", `#statusbar` shown with `.statusbar-item[data-item="@test/probe#load"]`, and every
open pane's `.chips` gaining a hidden `[data-chip="@test/probe#count"]`. After `ext.dock("tools", { draw })`
and a click on the rail button: `#dock` without `hidden`, `.is-wide`, `.panel-title` from `draw()`, the
body in `.panel-body`, the button `.is-active`; a second click, the `.panel-close`, or Escape hides it.
A `draw` that throws shows `.ext-broken` ("@test/probe could not draw this") and one toast. `ext.dock("nope", …)`
logs a console error and returns false. `ext.open.shelf("term")` shows `#shelf` with `.shelf-title` and the
mounted body; `.shelf-close` hides it and runs the unmount. `ext.open.place("page")` shows `#place` with
`.place-title` "Probe page". `ext.request("ping")` posts to `api/ext/@test/probe/ping`.

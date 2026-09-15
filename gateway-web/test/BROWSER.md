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
#   packages["@thetis/provider-openrouter"].apiKey = <a key> (only needed to send a message),
#   systemPackages["*"] += "@thetis/tools-files", "@thetis/tools-plan", "@thetis/ui-tools"
#   (`init` writes the kernel's short default list; a person is seeded from the list at `users add`,
#   so edit the file before the next line, or install the rest with `packages install <name> --user dev`)
THETIS_HOME=.devhome node bin/thetis.js users add dev --admin
echo devpass123 | THETIS_HOME=.devhome node bin/thetis.js users passwd dev
THETIS_HOME=.devhome nohup node bin/thetis.js serve > .devhome/serve.log 2>&1 &
```

Open `http://127.0.0.1:8799/login` at a viewport of at least 1000px wide (under 860px the chat-bar chips
are hidden by design; under 760px the sidebar becomes a drawer). Stop the daemon by killing the pid whose
listening socket is `.devhome/thetis.sock` (`ss -lxp | grep devhome/thetis.sock`), then delete `.devhome`.

The MCP browser is shared. Take `mkdir /tmp/thetis-browser.lock` before the run and `rmdir` it after. A
tab left behind by an earlier run can stop delivering real input events (a `fill` lands, a click or a key
press does not): open a new tab on the same URL and close the old one before the first step.

## Steps

1. **Sign in** as `dev` / `devpass123`. Expect the page at `/dev/`: `#sidebar` with `#session-list`
   showing "No conversations yet", `#sidebar-places` holding one `.foot-action[data-place="@thetis/gateway-web#panel"]`
   labelled "Control panel" before "Log out", `main.main` with `nav#tabs` holding only `#new-tab`, `#panes`
   showing `.pane.is-empty.is-active` with `.transcript-empty` ("No conversation open."), the composer
   `#composer` with `#composer-tools .composer-slot[data-slot="@thetis/gateway-web#model"]`. `#dock`,
   `#shelf`, `#place` and `#statusbar` all carry `hidden`. `#rail` is shown, with one `.rail-btn` per installed
   dock package in install order, the first `[data-dock="@thetis/ui-tools#tools"]` with the spanner path and
   the title "Every tool this conversation can call"; `head` holds a `link[href$="ext/@thetis/ui-tools/index.css"]`.
   With no dock package installed `#rail` carries `hidden` too. No console errors.
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
15. **The Tools dock** (`@thetis/ui-tools`): with a conversation open, click
    `.rail-btn[data-dock="@thetis/ui-tools#tools"]`. Expect one `POST api/ext/@thetis/ui-tools/tools` (not
    another on a redraw or a reopen), `#dock` without `hidden` and `.is-wide` (620px), the button
    `.is-active[aria-pressed="true"]`, `.panel-title` "Tools", `.panel-sub` "n tools from m packages", and in
    `.panel-body > .ui-tools`: an `input.ui-tools-filter`, one `section.ui-tools-section[data-package]` per
    installed package in install order (a `.section-label.ui-tools-name`, `.ui-tools-version`,
    `.ui-tools-count`, and the description as `.section-note`), a `.ui-tools-grid` of two columns holding one
    `.card.ui-tools-card[data-tool]` per tool (`.ui-tools-card-title`, a `.badge` "reads only" for
    `read_path`, `search_files`, `find_files`, `get_directory`, `todo_read` and "changes files" otherwise,
    `.ui-tools-card-desc`, `.ui-tools-card-params` "requires …"), "This package declares no tools." for a
    package without tools, and last a `.ui-tools-section.is-withheld` "Turned off right now" with the note
    "Nothing is withheld in this conversation." No `.ext-broken`, no toast.
16. **Filter**: type `read` into `.ui-tools-filter`. Expect the input to keep focus, only matching cards to
    remain (`read_path`, `search_files`, `get_directory`, `todo_read`, and any whose description says
    "read"), sections without a match gone, the withheld section still last, and no new request. Clear it:
    every card returns.
17. **Close the dock**: the active rail button, then `.panel-close`, then Escape, each after reopening.
    Expect after each `#dock[hidden]`, an empty `.panel-body`, and no `.rail-btn.is-active`. Switch to the
    other tab with the dock open: expect `.panel-sub` "Asking…" then a second `POST …/tools` and the list
    for that conversation. With no conversation open the dock still lists the tools (the request goes
    without `session`).
18. **A second dock package**: write a two-line fixture in dev's home and install it:
    `packages/second-dock/package.json` with `"thetis": { "type": "ui", "ui": { "dir": "ui", "entry": "index.js",
    "dock": [{ "id": "second", "label": "Second", "icon": "M4 4h12v12H4z", "hint": "The second dock" }] } }`,
    `ui/index.js` with `export default (ext) => ext.dock("second", { draw: () => ({ title: "Second", body:
    ext.dom.el("div", { class: "panel-empty" }, "second dock body") }) });`, an empty `index.js`, then
    `THETIS_HOME=.devhome node bin/thetis.js packages install packages/second-dock --user dev` and reload.
    Expect `#rail-tabs` to hold the `@thetis/ui-tools#tools` button first and `@dev/second-dock#second` last
    (install order), neither `.is-broken`; clicking the second opens `#dock` at 360px (not `.is-wide`) with
    `.panel-title` "Second" and the body text; only one `.rail-btn.is-active` at a time.

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

## The todo dock, the todo chip, and the ask form (`@thetis/tools-plan`)

Since phase 2 these pieces come from `@thetis/tools-plan`, not from the gateway, so step 2's hidden chip is
`[data-chip="@thetis/tools-plan#todo"]` and step 14 is replaced by the steps below. They need a model that
calls the tools (an OpenRouter key in the config) and cost one turn plus one answer. One message does it:
"Use todo_write to make a 3-item plan for tidying my notes, mark the first item active, then use ask_user
to ask me one question with two options; then stop and wait."

15. **Before any message**: `#rail` is shown with `.rail-btn[data-dock="@thetis/tools-plan#todo"]`
    (title "The plan the agent is working to"), and `document.head` holds a
    `link[href$="ext/@thetis/tools-plan/index.css"]`. In a new conversation, the chip
    `[data-chip="@thetis/tools-plan#todo"]` carries `hidden`. Clicking the rail button opens `#dock` with
    `.panel-title` "Todo", an empty `.panel-sub`, and `.panel-empty` "No plan yet in this conversation.".
    Close it with Escape.
16. **Send the message.** Expect, in the transcript, no `details.tool` for the `todo_*` calls but
    `.msg.is-note.is-quiet.tp-line` lines (`plan: 3 items · 0 of 3 done`, then `plan: t-1 → active · 0 of 3
    done`), the chip shown with the text `todo 0/3`, and the `ask_user` call drawn as `.tp-ask` (`.tp-ask-title`
    "Thetis is asking", one `.tp-ask-q` with two `.tp-ask-option` radios plus the `.is-other` one, a
    `.tp-ask-skip`, a `.tp-ask-foot` with Submit) and no tool card for it.
17. **The dock from the chip**: click the chip. Expect `#dock` without `hidden`, `.panel-title` "Todo",
    `.panel-sub` "0 of 3 done", and `.tp-list` with three `.tp-row[data-item]` (`t-1` `.is-active` with the
    ● glyph in the warning colour, the others `.is-pending` with ○), each with `.tp-text` and `.tp-id`. The
    rail button is `.is-active`. Escape closes it; the rail button opens the same.
18. **Tick a row**: click `.tp-row[data-item="t-2"] .tp-mark`. Expect the row `.is-busy` with its
    `.tp-check` disabled until the answer, then `.is-done` with ✓, `.panel-sub` "1 of 3 done", the chip
    `todo 1/3`, and `[x] t-2` in `<home>/plans/<session>.json` on disk. Click it again: back to
    `.is-pending`, "0 of 3 done".
19. **Answer the form**: pick one option and click Submit. Expect a new `.msg.is-user` with `1. <question>
    — <option>`, the card `.tp-ask.is-answered` with every control disabled and the foot reading
    "Answered.", and the turn running.
20. **Reload** the page. Expect the same conversation restored with the `.tp-line`s, the chip `todo n/3`
    (rebuilt from the last `todo_*` result in the record), and the form drawn `.tp-ask.is-answered`
    because a user message follows it.

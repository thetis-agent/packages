# Browser checklist for the web gateway

The browser code has no automated test. This checklist is driven through the Playwright MCP browser
against a throwaway data directory (`packages/gateway-web/README.md` §10), and its result goes into the commit
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
   showing "No conversations yet", `#menu.menu-btn[aria-haspopup="menu"]` (the ≡ and "Thetis") in the head;
   clicking it appends `.menu[role="menu"]` to `.sidebar-head` with one `.menu-item[data-place="@thetis/gateway-web#panel"]`
   labelled "Control panel" (focused), and Escape closes it; the footer holds only the identity row and "Log out"; `main.main` with `nav#tabs` holding only `#new-tab`, `#panes`
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
9. **Control panel as a place**: click `#menu`, then `.menu-item[data-place]`. Expect the menu gone. Expect `#app.is-place`, `#place`
   without `hidden` and `main.main` not displayed, `.place-title` "Control panel", `.place-sub`, and in
   `.place-body` a `.panel-shell` with `.panel-nav-item`s (Packages first, `.is-active`; then, for an admin,
   the sections `@thetis/ui-admin` declares, see the phase 3 section below) and `.panel-main` holding
   `.panel-note` and the Packages `.table`.
10. **Close the place** with `.place-close`. Expect `#app` without `is-place`, `#place[hidden]`, and the
    same `.tab.is-active` and `.pane.is-active` as before. Open it again and press Escape: same result.
11. **Close tabs**: click `.tab.is-active .tab-close`. Expect the neighbour tab `.is-active` and its pane
    shown. Close the last one: expect no `.tab`, `.pane.is-empty.is-active`, `document.title` "Thetis",
    and the composer `.picker` hidden.
12. **Reload** the page. Expect the newest unarchived conversation opened as the one `.tab.is-active`
    with its transcript restored (the `.msg`s and the `.msg-usage`). With a transcript taller than the
    window (or after shrinking the window under it), `#tabs` stays 36px tall and `.chat-bar` 42px: the
    transcript scrolls inside its pane, the rows above it never shrink.
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

Expect after `declare`: `#rail` shown with `.rail-btn[data-dock="@test/probe#tools"]`, the menu (open `#menu`)
gaining `.menu-item` "Probe page", `#statusbar` shown with `.statusbar-item[data-item="@test/probe#load"]`, and every
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

## The admin sections (`@thetis/ui-admin`, phase 3)

Since phase 3 the People, Models, Mounts, Activity and Overview sections come from `@thetis/ui-admin`, which
`init` now puts in `systemPackages["*"]`; the gateway keeps Packages only. Set up a second home on another
port so this run does not touch `.devhome`: `THETIS_HOME=.devhome3 node bin/thetis.js init`, `door.port`
8803, `packages["@thetis/gateway-login"].secure` false, `users add dev --admin` with the password
`devpass123`, and a plain person `users add bob` with `bobpass123`. Source `.env` for the OpenRouter key
before `serve` (the Models section asks the provider), but export `THETIS_HOME` after sourcing: `.env`
carries its own. Keep the daemon's pid: `echo $! > .devhome3/serve.pid` is the wrapper; the daemon is the
pid on `.devhome3/thetis.sock` (`ss -lxp`). Run 2026-09-15: every step below passed; screenshots
`.playwright-mcp/phase3-01` to `-10`.

21. **The nav, as dev**: sign in at `http://127.0.0.1:8803/login`, open `#menu` and click `.menu-item[data-place]`.
    Expect `.panel-nav-item`s in this order: Packages (`.is-active`), People, Models, Mounts, Activity,
    Overview; `head` holding a `link[href$="ext/@thetis/ui-admin/index.css"]`; no console errors. `api/ui`
    for dev lists the five `panel` entries (orders 20, 30, 35, 40, 50), eleven `commands`, and `hidden: []`.
22. **People**: click the second nav item. Expect `.panel-note` "Who can sign in, and what they may do.",
    a `.ua-people .table` with one row per person (`dev (me)`, `bob`), and the `.ua-add` card. Type `carol`
    and `carolpass1`, click **Add person**: one `POST api/ext/@thetis/ui-admin/user-create`, the row
    `carol | user | active | just now` selected, and the side card with **Make an admin**, **Suspend**, **Set
    password**, **Remove**. **Make an admin** opens a `.popover` "Change role?" naming carol; **Change** sends
    `user-role` and the row reads `admin`, the button **Make a user**. **Suspend** the same way (`user-status`):
    the row reads `suspended`, the button **Activate**. Type a new password and **Set password**
    (`user-password`): the input empties. **Remove** opens "Remove this person?" with the two facts; the warn
    button sends `user-remove` and the row is gone, the side column back to "Select a person…". Selecting
    your own row shows the "This is you" card and no buttons.
23. **Models**: the third nav item. Expect `.busy-note` "Asking the providers…", then the **Default model**
    card with the config's model in `code`, the toolbar note `n listed`, and the `.ua-models .table` (at most
    300 rows) with a `.badge.is-accent` "default" on the default model's row. The filter narrows without a
    second request.
24. **Mounts**: the fourth nav item. Expect "No host directory is bound into anyone's fence.", `0 mounts`,
    the `.ua-add` card with a Person select (`dev`, `bob`), a Host path input and a Mode select, and the
    `.panel-hint` on the fence reopening. Pick `bob`, type an existing absolute directory (`mkdir -p
    /tmp/thetis-phase3-mount`), click **Bind directory**: a `.popover` "Bind this directory?" with person,
    path and mode; **Bind** sends `mounts-set` with bob's whole list. Expect the row `bob |
    /tmp/thetis-phase3-mount | read-write | Unbind`, `1 mount`, the path input empty,
    `.devhome3/mounts.json` holding it, and the daemon log showing bob's fence restarted. **Unbind** opens
    "Unbind this directory?"; the warn button sends the list without it: `0 mounts` and `{}` on disk.
25. **Activity**: the fifth nav item. Expect "Reading the journal…" then `n newest rows` and the
    `.ua-activity .table`, newest first, with `.badge`s for the kinds and `dev` in the **Who** column for
    `user.create`, `user.role`, `user.status`, `user.password`, `user.remove` (target `carol`) and two
    `mounts` rows for `bob` (details `/tmp/thetis-phase3-mount (rw)` then `no mounts`). Pick `mounts` in the
    Kind select: only those two rows.
26. **Overview**: the sixth nav item. Expect the cards **Kernel** (`home`, `model`, `door`, …), **System
    packages** (`everyone` listing `@thetis/ui-admin` last), **Fence**, and **Package configuration** with one
    `.ua-kv-block` per configured package and `•••` where the key was; nothing that looks like a key.
27. **As bob**: sign in as `bob` / `bobpass123` in the same tab. Expect no console errors (the five admin
    entries arrive in `api/ui`'s `hidden`, so the module's registrations are ignored quietly), and the panel
    place showing **Packages** only. From a shell with bob's cookie, `POST /bob/api/ext/@thetis/ui-admin/users`
    with `{"args":{}}` and `sec-fetch-site: same-origin` answers `403 {"error":"only an admin can send \"users\""}`;
    `GET /bob/api/panel` answers `{"sections":["packages"]}`.

Stop the daemon by the pid on `.devhome3/thetis.sock` (SIGINT; SIGKILL after 20 s), release
`/tmp/thetis-browser.lock`, and delete `.devhome3` and the temporary directory.

## Projects (`@thetis/projects`, phase 5)

The switcher in the sidebar head slot and the project place come from `@thetis/projects`, which `init`
puts in `systemPackages["*"]`. Use a third home on its own port: `THETIS_HOME=.devhome5 node bin/thetis.js
init`, `door.port` 8805, `packages["@thetis/gateway-login"].secure` false, the OpenRouter key in
`packages["@thetis/provider-openrouter"].apiKey` (step 31 sends one message), `users add dev --admin` with
`devpass123`, build, `serve`. Make a directory with a file (`mkdir -p /tmp/thetis-phase5-proj; echo hello >
/tmp/thetis-phase5-proj/README.md`) and bind it: `THETIS_HOME=.devhome5 node bin/thetis.js mounts add dev
/tmp/thetis-phase5-proj` (dev's fence closes and reopens with it). Run 2026-09-15: every step below passed
after the one fix in `ui/state.js` (see the last paragraph); screenshots `.playwright-mcp/phase5-01` to `-14`.

28. **The switcher**: sign in at `http://127.0.0.1:8805/login`. Expect `#sidebar-head .sidebar-slot-item
    [data-item="@thetis/projects#head"]` holding `.pj-head > button.pj-head-btn[aria-haspopup="listbox"]`
    with `.pj-head-label` "Project", `.pj-head-name` "All conversations", and `svg.pj-caret`; `head` holding a
    `link[href$="ext/@thetis/projects/index.css"]`; the menu (`#menu`) holding
    `.menu-item[data-place="@thetis/projects#project"]` "Project" after "Control panel"; one `POST
    api/ext/@thetis/projects/list`; no console errors. Click the button: `.pj-head.is-open`,
    `[aria-expanded="true"]`, and `.pj-menu[role="listbox"]` with two `.pj-item[role="option"]`: "All
    conversations" (`.is-selected`, focused) and "New project…" after a `.pj-menu-rule`. Escape closes it and
    returns focus to the button; so does a click elsewhere.
29. **New project**: open the menu and click "New project…". Expect `#app.is-place`, `.place-title` "Project",
    `.place-sub` "This project's directories, tools and instructions", and in `.place-body > .pj-place >
    .pj-page` the sections: `input.pj-name` (empty), "Project directories" with `.section-note` "0 of 64",
    `.pj-empty` "No project directories.", `.pj-dir-add` (`input.pj-dir-input` and the button "Add a
    directory") and the `.pj-note`; "Instructions" with `textarea.pj-instructions`; "Conversations" with
    `.pj-facts` "None yet. …"; "Tools" with the note "24 tools, every one on" and one `.pj-tool-group` per
    package with tools (`@thetis/tool-exec`, `@thetis/tools-files`, `@thetis/tools-plan`, `@thetis/terminal`,
    `@thetis/skills`, `@thetis/skills-hybrid`), each tool a
    `label.pj-tool` with `code.pj-tool-name` and `input.pj-switch[checked]`; "Skills" with its one sentence;
    `.pj-actions` with the one button "Create project". Type `thetis-check` in the name; type
    `/tmp/thetis-phase5-proj` in `.pj-dir-input` and press Enter, then `/tmp/does-not-exist` the same way.
    Expect two `li.pj-dir` rows, each `code.pj-dir-path`, a badge and a `.pj-dir-remove`: the first
    `.badge.is-ok` "mounted · read-write", the second `.badge.is-warn` "not mounted"; the note "2 of 64"; the
    name kept across the redraw. Type "Answer in one short sentence." in the textarea; uncheck the
    switches `shell on` and `install_package on`: their rows `.pj-tool.is-off`, the note "24 tools, 2 switched
    off for this project". Click **Create project**: one `POST …/save`, a `.toast` `Project "thetis-check"
    created.`, then `list` and `get` again; the buttons now "Save" and "Delete project"; `.pj-facts` "0
    conversations are in this project."; the switcher `.pj-head.is-chosen` with `.pj-head-name`
    "thetis-check" (a new project is chosen after its first save); `localStorage["thetis.project"]` its
    id; on disk `<home>/projects/p_<8 hex>.json` with the two directories and `tools.disable` `["shell",
    "install_package"]`, and `p_<id>.md` with the sentence.
30. **Choosing and joining**: close the place. Open the menu: the option `thetis-check` with `.pj-item-note`
    "0 conversations" `.is-selected`, then the rule, "Settings" (note "thetis-check"), "New project…". Pick
    "All conversations": the label reads it, the storage key is gone. Pick `thetis-check` again, then click
    `#new-chat`. Expect the new `.session` row in the list, one `POST …/assign` with `{ session, project }`,
    and `<home>/projects/sessions.json` mapping the id to the project. Pick "All", click `#new-chat` once
    more (no `assign`; the map keeps one entry), and the list shows both rows; pick `thetis-check`: only the
    first row; the menu's note reads "1 conversation".
31. **The prompt and the tools**: open the project's conversation and send "Read /tmp/thetis-phase5-proj/
    README.md and tell me its first line." Expect a `details.tool` for `read_path` with the line in its
    result (the mount is bound, so the file tools accept the path), and a `.msg.is-assistant` of one short
    sentence. The session record under `<home>/../sessions/<id>.json` carries the system prompt's section
    `## Project: thetis-check` with `Project directories:`, `- /tmp/thetis-phase5-proj (mounted rw)`, `-
    /tmp/does-not-exist (not mounted — ask an admin: thetis mounts add dev /tmp/does-not-exist)`, `###
    Instructions` and the sentence; the call's tool list has no `shell` and no `install_package`. The Tools
    dock (`.rail-btn[data-dock="@thetis/ui-tools#tools"]`) still lists both cards and its "Turned off right
    now" section still says "Nothing is withheld in this conversation.": `@thetis/ui-tools` does not yet
    read the project's list (its `withheld()` is a placeholder; the integration was left for later).
32. **Settings, save, delete**: open the menu and pick "Settings". Expect the place with the name, the two
    rows with their badges, `.pj-facts` "1 conversation is in this project.", the two switches off and the
    instructions. Change the name to `thetis-check-2`, click the `.pj-dir-remove` of `/tmp/does-not-exist`,
    click **Save**: the toast `Project "thetis-check-2" saved.`, one row, the switcher `.pj-head-name`
    "thetis-check-2", the record updated on disk with the same `createdAt` and a new `updatedAt`. Click
    **Delete project**: a `.popover[role="dialog"]` "Delete this project?" with the facts Project /
    Conversations and the note "The conversations stay; they leave the project. …"; its warn button
    "Delete" sends `POST …/remove`; expect the toast `Project "thetis-check-2" deleted.`, the switcher back
    to "All conversations" without `.is-chosen`, the storage key gone, the place redrawn as the new-project
    form ("Create project"), both `.session` rows in the list, and `sessions.json` `{}` with the record and
    the `.md` gone.
33. **Reload with a project chosen**: create a project again, keep it chosen, reload. Expect `.pj-head-name`
    with its name from `localStorage`, the list narrowed to its conversations, and no `assign` request: a
    conversation that exists when the page loads is never adopted, however new it is (a `+` while the
    project is chosen still is).

Defect found and fixed in this run (`packages/projects/ui/state.js`): the page decided which conversations
"existed at load" from `ext.sessions.list()` at `install`, but the shell's module loader and its event
stream race, so on a fast load the list was still empty and a conversation created in the last two minutes
could be adopted, or even moved from another project before the assignments had been read. The state now
adopts nothing until its first `list` has answered, marks every conversation known by then as seen, skips
archived ones, and clears the storage key when the remembered project no longer exists.

Stop the daemon by the pid on `.devhome5/thetis.sock` (SIGINT), release `/tmp/thetis-browser.lock`, and
delete `.devhome5` and `/tmp/thetis-phase5-proj`.

## The marketplace place (`@thetis/ui-marketplace`, phase 4)

Since phase 4 the registries, the package pages and the admin actions over packages come from
`@thetis/ui-marketplace`, which `init` puts in `systemPackages["*"]`; the gateway's Packages section shows
what is installed here only. Set up a third home on another port: `THETIS_HOME=.devhome4 node bin/thetis.js
init`, `door.port` 8804, `packages["@thetis/gateway-login"].secure` false, and, so the index reflects this
checkout, `packages["@thetis/marketplace"].registries` = `[{ "name": "local", "url":
"file:///tank/data/Dev/thetis-agent/runtime/packages" }]` (the checkout is bound read-only into every fence;
the mirror clones the committed tree, so an uncommitted package is not in the index). `users add dev --admin`
with `devpass123`, `users add bob` with `bobpass123`, `serve` with the pid kept, and wait for the log line
`indexed N packages from 1 registries`. No package in the checkout has a `README.md`, so every page shows
*This package has no README.*; to see the rendering path, put a markdown file at
`.devhome4/shared/marketplace/readme/local/exa.md` and set `"readme": true` on the `@thetis/exa` entry of
`.devhome4/shared/marketplace/index.json`. Run 2026-09-15: every step below passed; screenshots
`.playwright-mcp/phase4-01` to `-09`.

28. **The menu item, as dev**: sign in at `http://127.0.0.1:8804/login` and open `#menu`. Expect
    `.menu-item[data-place="@thetis/ui-marketplace#marketplace"]` labelled "Marketplace" (order 20) after
    "Control panel" (order 10), with the hint "What the registries offer, and what is installed here", and `head`
    holding a `link[href$="ext/@thetis/ui-marketplace/index.css"]`. `api/ui` for dev lists one `places` entry
    and eleven `commands`; for bob six (`search`, `show`, `install`, `remove`, `delete`, `update`).
29. **The gallery**: click the item. Expect `#place` without `hidden`, `.place-title` "Marketplace", a
    `.place-page.mk-gallery` with one `.mk-toolbar` row holding `.mk-search`, `.mk-chips` with `.mk-chip[data-type=""]` "All" `.is-active` and one
    chip per type seen (`gateway`, `loader`, `provider`, `service`, `tool`, `ui`), `.mk-note` "registry local ·
    refreshed n min ago · 16 packages", and `.mk-card[data-name]` per package, installed ones first with
    `.is-installed` and the badge **Everyone**, then the available ones with **Available · local**; a package
    with reports carries `bench: 2 suites`, one that opted in without a run `bench: not run`. Type `exa` in
    the search: after 250 ms one `POST api/ext/@thetis/ui-marketplace/search` and one card. Clear it and click
    the `ui` chip: the four `ui` packages (`@thetis/ui-marketplace` among them, matched on its installed name
    because the index does not carry it), the chip `.is-active`. Click **All**.
30. **A page**: click `.mk-card[data-name="@thetis/exa"]`. Expect `.mk-crumb` reading "Marketplace › @thetis/exa"
    (the first part a `.btn`), `.mk-readme` with "This package has no README." (or, with the copy planted, a
    `.mk-readme-body` holding `.md-h` "Exa", `.md-p`, `.md-list` and `.md-code` built by the shell's markdown),
    and `.mk-side` with the badges in `.card-head`, the description, the `.kv` rows `registry` "0.1.0 in local",
    `type`, `source`, then **BRINGS** with one `.badge.is-ok.mk-pill` per tool (ten for exa), `steps` "no
    steps", `service` "none", `keywords`, `bench suites` "(not run)". The actions for an admin: **Install for
    me**, **Install for everyone**, and the `.mk-picker` with a `select.mk-person` listing `bob` and the button
    **Install for bob**; the `.panel-hint`s under the card.
31. **Install for me**: click it. Expect a `.popover` "Install for you?" with `package @thetis/exa@0.1.0`,
    `from local`, `for you only`, the note "It is live on the next turn.", **Cancel** and **Install**. Confirm:
    `.busy-note` "Installing…", then the page re-opened with the badge **Only me**, the row `installed`
    "0.1.0", `license` "MIT", `bench: 2 suites` (the reports next to the checkout's code), and **Remove** in
    place of Install for me.
32. **Remove**: click it. Expect "Remove this package?" with `package`, `from your own setup`, the note on
    the link being removed and the tools stopping, a warn **Remove**. Confirm: the page re-opened as
    **Available · local** with **Install for me** again.
33. **Install for everyone**: click it. Expect "Install for everyone?" with `for everyone, now and later` and
    the note "Every person gets it on their next turn, and every new person is set up with it." Confirm: the
    badge **Everyone**, **Remove** only (no Install for everyone, no picker after a reload), and `thetis
    packages list --user bob` shows `@thetis/exa`.
34. **The Packages section**: click **Control panel**. Expect `.panel-note` "What is installed here, and what
    each package brings.", the toolbar note "12 installed", the columns Package, Version, Type, Scope, Brings
    (one line per row: the name carries the description as its title), no search of the registries, no
    "Whose" picker. Click the exa row: the card on the right shows the description and the button **Open in
    the marketplace**; click it: the Marketplace place opens on "Marketplace › @thetis/exa". No console errors.
35. **As bob**: sign in as `bob` / `bobpass123` in the same tab and open the Marketplace. Expect the exa card
    **Everyone**. Open `@thetis/bench-probe`: **Install for me** only, no picker, no admin action. The crumb
    returns to the gallery; Escape closes the place and `#app` loses `is-place`. From a shell with bob's
    cookie, `POST /bob/api/ext/@thetis/ui-marketplace/install-everyone` and `.../people` with
    `sec-fetch-site: same-origin` answer `403 {"error":"only an admin can send \"…\""}`; `GET /bob/api/admin/users`
    and `GET /bob/api/marketplace` answer `404`.

Stop the daemon by the pid on `.devhome4/thetis.sock` (SIGINT; SIGKILL after 20 s), release
`/tmp/thetis-browser.lock`, and delete `.devhome4`.

## The menu and the polish pass (2026-09-15)

The places moved from the sidebar footer to the ≡ menu in the sidebar head (`#menu`, `views/menu.js`), the
marketplace gallery and package page took the canvas's spacing (`.place-page`, one toolbar row, cards on
`--surface-1`, an unboxed README beside a 340px card), the Packages table lost the description under the
name and the per-row link, and a place's head gained the drawer toggle for narrow screens. Run on
`.devhome6` (port 8806, the `local` file registry) as dev; screenshots `.playwright-mcp/polish-01` to `-14`.

36. **The menu**: click `#menu`. Expect `.menu[role="menu"]` inside `.sidebar-head`, `[aria-expanded="true"]`
    on the button, `.menu-item`s Control panel (order 10, focused), Marketplace (20), Project (100), each with
    `.menu-icon`, `.menu-label` and `.menu-hint`; the open place's item `.is-active`. Arrow keys move the
    focus; Escape closes the menu (and not the place) and returns the focus to the button; a click elsewhere
    closes it; choosing an item closes it and opens the place. `#sidebar-places` no longer exists; the footer
    holds the identity row and **Log out** only.
37. **The gallery's spacing**: `.place-page.mk-gallery` padded 16px 24px, `.mk-toolbar` one row with the search
    (max 22rem), the chips and `.mk-note` at the right; `.mk-card` shows the name, the state badge (and an
    update badge when one is on offer), two lines of description, then `version · type · registry`.
38. **The package page**: `.mk-crumb` in the faint small style, `.mk-readme` unboxed with the README's `#`
    heading at `--text-lg`, `.mk-side` 340px and sticky; long badges under "last run" wrap inside the card.
39. **The Packages table**: five columns, one line per row, the name's `title` is the description; the table
    never overflows `.table-wrap` at 1440px; the card on the right carries **Open in the marketplace**.
40. **Narrow**: at 700px with a place open, `.place-head .chat-menu` is visible and opens the drawer; `#menu`
    works inside the drawer; Escape closes the menu and leaves the place and the drawer; the veil closes the
    drawer.

## The Skills dock and project switches (2026-09-16)

`@thetis/ui-skills` adds the **Skills** dock; `@thetis/projects` gained a switch per skill. Use a home on
its own port: `THETIS_HOME=.devhome7 node bin/thetis.js init`, `door.port` 8807,
`packages["@thetis/gateway-login"].secure` false, `systemPackages["*"]` the default list plus
`@thetis/skills`, `@thetis/skills-l1`, `@thetis/skills-thetis` and `@thetis/ui-skills` (skills-l1 is the
loader here; the hybrid loader works the same way and adds a **Retrieved for this conversation** section),
the OpenRouter key in the environment of `serve` (steps 43 and 47 send one message each), `users add dev
--admin` with `devpass123`, `serve`. Run 2026-09-16: every step below passed; screenshots
`.playwright-mcp/skills-dock-01` to `-09`; no console errors or warnings at any step.

41. **The rail and the dock without a conversation**: sign in at `http://127.0.0.1:8807/login` at 1440px.
    Expect `#rail .rail-btn[data-dock="@thetis/ui-skills#skills"]` after the Tools and Context buttons
    (order 110), title "The skills this conversation can reach, and which are in force", and `head` holding
    `link[href$="ext/@thetis/ui-skills/index.css"]`. Click it: `#dock.is-wide` shown, `.panel-title`
    "Skills", `.panel-sub` "12 skills · no loader in force", one `POST api/ext/@thetis/ui-skills/skills`
    without a session. In `.panel-body > .sk-dock` the sections `section.sk-section` in order `.sk-loader`
    (`.sk-empty` "Open a conversation to see which loader is in force and what it put in the prompt."),
    `.sk-universal` (`.section-note` "Declared universal; a loader puts these in force.", one
    `button.sk-row[data-skill="thetis"]` with `code.sk-row-id`, `.sk-row-title` "Thetis", `.badge.is-ok`
    "always", `.sk-row-pkg` "@thetis/skills-thetis", `.sk-row-brief`), `.sk-off` (`.sk-empty` "Nothing is
    switched off by a project."), `.sk-catalogue` (`.section-note` "12 skills from 1 source",
    `input.sk-search`, and 12 `.sk-row`s by id, `thetis` first, the eleven `thetis/<name>` rows
    `.is-nested`).
42. **Before the first turn**: click `#new-chat`. The dock redraws and sends `skills` once more with the
    session: `.sk-loader .sk-empty` "@thetis/skills-l1 is installed; it writes what it did after the first
    turn of this conversation."; the rest as in 41.
43. **The search**: type `packages` into `input.sk-search`. Expect the catalogue reduced to the rows BM25
    ranks (`thetis/packages`, `thetis/marketplace`, `thetis`, `thetis/configuration`, `thetis/skills`), each
    with `.sk-row-score` "score N.NNNNNN", and no new request (`performance.getEntriesByType("resource")`
    still lists two `…/ui-skills/skills`). A query that matches nothing shows `.sk-empty` `No skill matches
    "…".`.
44. **A row**: click `.sk-catalogue .sk-row[data-skill="thetis/packages"]`. Expect one `POST
    …/ui-skills/skill`, `.sk-dock.is-open`, `.panel-title` "thetis/packages", `.panel-sub` "How a Thetis
    package is built and managed.", `button.sk-back` "← Skills", `.sk-body-head` with `code.sk-body-id`
    and `.sk-row-pkg`, and `.sk-body` holding the rendered markdown (an `h3` "Packages", the text ending
    with `Skill directory: …`). Click `.sk-back`: the list again, `.panel-title` "Skills", the query kept.
    Opening the same row again sends nothing (the text is held by id and content hash).
45. **After a turn**: send "Say hello in one word." and wait for the reply. On `turn.end` the dock asks
    once more (a third `skills`): `.panel-sub` "12 skills · @thetis/skills-l1", `.sk-loader` with
    `.section-note` "Wrote the prompt of the last turn." and `code.sk-loader-name` "@thetis/skills-l1",
    `.sk-universal .section-note` "The bodies every prompt carries." with the `thetis` row. No
    `.sk-pinned`, `.sk-loaded`, `.sk-dropped` or `.sk-notes` section: skills-l1 pinned nothing, the model
    loaded nothing, nothing was dropped and there are no notes.
46. **The project's switches**: open `#menu`, pick "Project". Expect in `.pj-page` the section
    `.pj-section.pj-skills` after Tools: `.section-note` "12 skills, every one on", one
    `.pj-tool-group.pj-skill-group` with `code.pj-tool-package` "@thetis/skills-thetis" and 12
    `label.pj-tool.pj-skill[data-skill]` rows, the nested ones `.is-nested`, each with `code.pj-tool-name`,
    `.pj-tool-desc` and `input.pj-switch[checked]` (`aria-label` "<id> on"), and the `.pj-note` ending
    "a switched-off parent switches off its nested skills too." Type `skills-check` in `input.pj-name`.
    Uncheck `thetis/packages on`: its row `.is-off`, the note "12 skills, 1 switched off for this project",
    the name kept across the redraw. Uncheck `thetis on`: every row `.is-off`, the note "12 skills, 12
    switched off for this project", and the eleven nested switches `[disabled]` with `title` "Switched off
    with thetis" (the `thetis/packages` switch stays enabled: it is off by name). Check `thetis on` again:
    only `thetis/packages` stays off, no switch disabled. Click **Create project**: one `POST
    …/projects/save`, then `list` and `get`; the buttons "Save" and "Delete project"; the switcher
    `.pj-head.is-chosen` "skills-check"; `<home>/projects/p_<8 hex>.json` with `skills.disable`
    `["thetis/packages"]` and `tools.disable` `[]`.
47. **Switched off, before and after a turn**: close the place (`.place-close`) and click `#new-chat`
    while the project is chosen (one `assign`). The open dock redraws for the new conversation at once,
    before any turn: `.sk-off` with `.section-note` "Left out of the prompt and of skill_fetch. A
    switched-off parent takes its nested skills with it." and one `.sk-row.is-off[data-skill="thetis/packages"]`
    with `.badge.is-warn` "switched off"; the catalogue row for the same id `.is-off` with the badge too.
    Send "Say hello in one word." and wait: the dock gains `.sk-notes` with `ul.sk-notes-list > li`
    "switched off by the project: thetis/packages", `.sk-off` unchanged; the session record under
    `<home>/../sessions/<id>.json` carries `harness["@thetis/skills"].excluded` `["thetis/packages"]`
    and the same note, and its system prompt has `# Skills you can load`, `# Skills always in force` and
    `## Project: skills-check`.

48. **A project directory says whether it can be used**: open the project place for `skills-check`. In
    **Project directories** type `/srv/nowhere` in `input.pj-dir-input` and press Enter. One `POST
    …/projects/mounts` with `args.paths` naming it, then the row `li.pj-dir.is-unmounted[data-path]` with
    `code.pj-dir-path`, `.badge.is-err` "not mounted", and `p.pj-dir-state` "Nothing is bound over this
    path, so the file tools cannot reach it. An agent in this project will find it missing." Above the
    rows, `p.pj-warn` "1 of 1 directory is not usable. An agent in this project cannot read it." Since
    this person is an admin, the row also has `.pj-dir-actions` with a **Bind it** button and no
    `.pj-dir-ask`.
49. **The picker will not offer a path that is not there**: click **Choose a directory…**. A
    `.popover.dp` opens with `input.dp-path` at `/`, `p.dp-status.is-ok` "A directory: *n* directories
    inside.", and one `.dp-row` per directory. Type `/srv/nowhere` in the path box: `.dp-status.is-warn`
    "Not on the host." and the **Use this directory** button `[disabled]`. Type the absolute path of a
    real directory outside the home (`/tmp` will do): the status turns `.is-ok` and the button enables.
    Click a `.dp-row` to descend, then the `.dp-row.is-up` to go back. Press Escape: the popover closes
    and nothing is added.
50. **Binding one from the page**: pick `/tmp` in the picker, leave the mode select at read-write, and
    click **Use this directory**. The row is added, then a confirm popover "Bind it read-write?" with the
    lines Directory and Mode and the note about the workspace reopening. Confirm: one `POST
    …/projects/mount`, the fence closes (the request may not answer), then `mounts` polling until the new
    workspace answers, a toast, and the row redrawn `li.pj-dir.is-ready` with `.badge.is-ok` "mounted ·
    read-write" and the state line "The file tools can read and write here." `.pj-warn` is gone for that
    row. `<home>/../../mounts.json` holds `{ "alice": [ { "path": "/tmp", "mode": "rw" } ] }`. The unsaved
    name in `input.pj-name` survived the bind.
51. **Unbind, and the prompt**: the row now offers **Make read-only** and **Unbind**. Click **Make
    read-only**, confirm: the badge turns `.badge.is-accent` "mounted · read-only". Click **Save**, then
    send a message in a conversation of this project: the session record's system prompt has the line
    `- /tmp (mounted ro, read-only)` and the line `- /srv/nowhere (NOT USABLE: no mount covers it, …)`,
    followed by "A directory marked NOT USABLE is outside this workspace". Click **Unbind**, confirm:
    the badge returns to `.badge.is-err` "not mounted" and `mounts.json` no longer names `/tmp`.
52. **The control panel agrees**: open **Control panel → Mounts**. The table has a column **On the host**;
    bind `/srv/nowhere` for `bob` through the form. The toast says the host has no directory there, and
    the row shows `.badge.is-err` "skipped · not there" beside `read-write`. The **Choose…** button opens
    the same picker. Unbind it.

### The terminal

`@thetis/terminal` must be in `systemPackages["*"]` for these; it is there by default.

53. **The chip, with nothing open**: the status bar stays `hidden` (no package fills it). The active
    pane's chat bar shows `.chips .chip.term-chip` reading **Terminal** with a grey `.term-dot.is-done`;
    it is never hidden, because the **+** that opens the first shell is inside the drawer and the chip is
    the way in. Click it: `#shelf.is-open` rises under the conversation (no `hidden`, an inline height of
    `300px`), `.shelf-title` **TERMINALS** (uppercase, faint), `.shelf-actions` holding `.term-add`,
    `.term-clear`, `.shelf-collapse`, `.shelf-close` in that order, `.term-list` with only `.term-empty`
    "No shells open — open one with +, or the agent opens one when it needs to run something.", an empty
    `.term-foot`, and the chip now `.is-on`.
54. **Open one**: click `.term-add`. A `.term-tab.is-active[data-id]` appears with `.term-dot.is-ok`,
    `.term-tab-label` `main`, `.term-tab-sub` `home`, and `.term-tab-info` and `.term-tab-kill` beside
    it; the emulator loads (`ui/vendor/xterm.js`, once per page) into `.term-panes > .term-pane` and shows a
    prompt; `.term-cwd` reads `~` and `.term-meta` `bash · idle`; the chip reads `1 terminal`. The
    console must be clean: a blocked stylesheet here means the page was served without its nonce (see
    `packages/sandbox/README.md`). Reload: the drawer opens by itself, because the conversation has a shell, at
    the same height.
55. **Type in it**: click the screen and type `printf '\033[31mRED\033[0m \033[1;32mGREEN\033[0m\n'` and
    Enter. `RED` renders in `--term-red` and `GREEN` bold in `--term-bright-green` — `getComputedStyle` on
    those spans must not return the default foreground. Keystrokes reach the shell through `write`,
    coalesced at 15 ms.
56. **Your own command**: type `sleep 30` and Enter. The row's dot becomes `.is-busy` (pulsing yellow), a
    `.term-tab-stop` appears before the info button, `.term-meta` reads `bash · you are running sleep 30`,
    and the chip is `.is-busy` with its dot in the warning colour. Click `.term-tab-stop`: `^C` appears,
    the dot returns to `.is-ok`, the stop button goes, and the meta returns to `bash · idle`.
57. **The agent's command, watched live**: click `.term-add` once more (a row `2`, chosen), then send
    `run: sleep 6; echo hi` (the echo model calls the `shell` tool, which uses `main`). The `main` row turns
    `.is-busy` with `.has-activity` (the label bold and bright) and the view stays on `2`; choose `main`:
    `.term-meta` reads `bash · the agent is running sleep 6; echo hi · 2s`, the clock ticking once a
    second, and after five seconds of silence `bash · running … · no output for 6s` — `busy-quiet`, the
    observed fact and not a guess about what the program is waiting for. The reply reports `exit 0`.
    `.term-tab-info` opens `.term-card[role="dialog"]` left of the list with the rows Name, Session id,
    Working directory, Conversation, Shell, State, Command and Running since while it runs, Last exit,
    Terminal (`/dev/pts/N`), Reports exit codes, and the foot "What you type here goes to the shell.";
    Escape closes it. Double-click `.term-tab-label` on `2`: `.term-tab-rename` takes its place; type
    `build` and Enter: the label reads `build`. Double-click again, type, Escape: the name is unchanged.
58. **A full-screen program**: type `printf '\033[?1049h'; sleep 8; printf '\033[?1049l'`. `.term-meta`
    reads `bash · a full-screen program has the terminal` for those eight seconds, then `bash · idle`.
59. **Resize while something runs**: type `sleep 20`, then make the window wider. No note appears on the
    row and nothing is typed into the shell: the size is set on the pty from outside it, so the prompt that
    follows the sleep is already at the new width. Type `less /etc/services` and resize again: `less`
    redraws at the new size at once. The details card's Terminal row shows the device it was set on,
    `/dev/pts/N`.
60. **Close keeps the transcript**: hover a row with output in it and click `.term-tab-kill`. A
    `.term-popover[role="dialog"]` "Close build?" appears with "The shell in ~ and everything it is running
    will be terminated. The agent may be using it." and Cancel and **Close** (`.btn.is-warn`); Escape
    cancels it. Open it again and click **Close**: the row's dot becomes `.is-done`, `.term-tab-note` reads
    `exited`, `.term-meta` `bash · closed · exit N` (or `closed`), the screen keeps what it printed and the
    cursor stops blinking. The trash on the closed row now reads "Remove … from the list" and removes the
    row without asking; the host keeps the last four closed sessions, so it is back after a reload until
    then. The drawer's chrome: `.shelf-collapse` adds `.is-collapsed` (the body hidden, the chevron
    turned, the inline height cleared) and again restores it; dragging `.shelf-grip` up adds `.is-dragging`
    while the pointer moves and leaves the new height in `localStorage["thetis.shelf.height"]`, which a
    reload restores; `.shelf-close` animates the height to 0 and then sets `hidden`, and the chip loses
    `.is-on`. With `prefers-reduced-motion: reduce` the pulse and the transition are off and hiding still
    lands. At 1060px `.term-list` is 158px and `.term-tab-sub` is hidden; at 900px it is 128px and
    `.term-tab-info` is hidden too, the kill never. A new conversation (`#new-chat`) closes the drawer and
    its chip reads `Terminal`; the first conversation's tab reopens it with its rows.
61. **Nothing is shown as live when it is not**: stop the daemon. Within a few seconds `.term-foot`
    reads `not live: the stream "watch" to this workspace ended · Reconnect` (`.term-meta.is-stale`, a
    `.term-reconnect` link) and the chip turns `.term-chip.is-stale` with the reason in its title. The
    browser's own silent retry is deliberately not relied on here: `ext.subscribe` ends the subscription
    so the page owns the retry and can say what it knows. Start the daemon: the page's own retry (a second,
    doubling to thirty) reconnects, or **Reconnect** does it now. The shells closed with the fence, so the
    list is empty and live again; the drawer stays up.

### Workspaces, and putting new code into service

62. **What is running**: open **Control panel → Workspaces**. The daemon card says `running the code on
    disk`, when it started and `up N h`, and an ok badge `systemd` (or a warn badge `not supervised` when
    the daemon was started from a shell). The table lists every workspace including `_system`, your own row
    marked ` (me)`, with the Code column reading `running the code on disk` and the services each one runs.
    A workspace with no fence open reads `not running · opens on the next request` and offers **no** Reload
    button — there is nothing to reload.
63. **Staleness is visible**: on the host, `touch` a file under a package installed for the other person
    (`packages/tools-files/index.js` will do). Reopen the section. That row now reads `running code from
    HH:MM · newer on disk since HH:MM` with a warn badge `newer code on disk`. This is the signal whose
    absence sent two features out with a hand-run restart.
64. **Reload someone else**: click **Reload** on that row. The confirm names what restarts and says every
    open shell session in it stops. Confirm: a toast names the services that started again, and the row
    returns to `running the code on disk`.
65. **Reload yourself** — the case that kills the gateway serving the page. Click **Reload** on your own
    row; the confirm says the page will wait for it. Confirm: the request is lost rather than refused, the
    toast says it is reloading, and the page waits and recovers by itself. It must never sit on a spinner:
    if the workspace does not answer within thirty seconds the row says so and names
    `thetis reload --user <id>`.
66. **Reload `_system`**: the confirm says the sign-in page is briefly unavailable and anyone already
    signed in is unaffected. Confirm, then reload the page: you are still signed in.
67. **A dead workspace recovers by itself**: on the host, kill the agent process of the other person
    (`pkill -f "userspace-agent.*<their id>"` — never a pattern matching your own tooling). Visit their
    prefix in the browser. The door opens the fence again and the page loads; before this change it
    answered 502 and stayed that way until someone intervened.
68. **The daemon's own tier**: `touch packages/kernel/dist/src/control.js` on the host and reopen the
    section. The daemon card reads `running code from HH:MM · newer on disk since HH:MM` and says a reload
    cannot replace the kernel, the door or `thetis.config.json` — those need
    `sudo systemctl restart thetis-runtime.service`.

Stop the daemon by the pid on `.devhome7/thetis.sock` (SIGINT), release `/tmp/thetis-browser.lock`, and
delete `.devhome7`.

## Subagents on the page (2026-09-19)

The pass runs against `.devhome3` on door port 8803 with the echo provider fixture as the model, so a
subagent costs nothing and behaves the same every time. Setup, after `init` and before `users add`:
make `.devhome3/system-packages` with a symlink per directory of `packages/` plus
`packages/host/test/fixtures/provider-echo` as `provider-echo`; in `.devhome3/thetis.config.json` set
`"model": "echo"`, `"door": {"host": "127.0.0.1", "port": 8803}`, `"systemPackagesDir": "<runtime>/.devhome3/system-packages"`,
add `"@thetis/provider-echo"` to `systemPackages._system`, `packages["@thetis/provider-echo"] = {"tag": "t1"}`,
`packages["@thetis/gateway-login"] = {"secure": false}`, and `fence.readOnly` listing `<runtime>/packages`,
`<runtime>/node_modules`, `<runtime>/.devhome3/packages`, `<runtime>/.devhome3/system-packages` and
`<runtime>/packages/host/test/fixtures`. The cue `spawn: <task>` makes the echo model call `spawn_subagent`
with the label `helper`; a task of `slow: w1 w2 …` streams one word every 50 ms, so a child of eighty words
runs for four seconds. The echo provider reports no usage, so every meta line and cost is empty here.

69. **A short subagent**: sign in at `http://127.0.0.1:8803/login` at 1440px, open a conversation, and send
    `spawn: hello there`. Expect at the root of the transcript (never inside a `.tool-run`), in order:
    `.msg.is-user`, `details.agent[data-call][data-agent^="s_"]` and `.msg.is-assistant` (the parent's reply,
    `tool said: [subagent … helper] …`). No `details.tool` at all. The block: `.agent-label` "helper",
    `.agent-gist` "hello there", `.agent-brief` "hello there", `.agent-state` "done", `.agent-took` set,
    `.agent-stop[hidden]`, folded (`open` false), one `.msg.is-assistant` in `.agent-body` with the child's
    reply, and after the body **no** `.tool-label` "reply": the result is the reply the child's last row already
    shows, so it is not quoted twice (it is quoted when it differs, the `[subagent …]` line stripped). In the sidebar, under the active `.session` row: one `.session-agent.is-done.is-last[data-agent]`
    holding `button.session-agent-go` (`.session-agent-dot`, `.session-agent-label` "helper",
    `.session-agent-state` "done") and `button.session-agent-open` "Open in a tab". No console errors.
70. **Reveal from the sidebar**: click `.session-agent-go`. Expect the block `open`, scrolled into view, and
    `.agent.is-flashed` for 1200 ms (check it synchronously: `document.querySelector('.session-agent-go').click()`
    in `browser_evaluate`, then read the class).
71. **The child's tab**: focus the row, then click `.session-agent-open`. Expect `.tab.is-agent.is-active`
    (`.tab-title` "helper", `.tab-dot` displayed, an empty `.tab-note`), `.pane.is-agent.is-active` with
    `.chat-bar.is-agent` holding `.chat-dot`, `.chat-title.is-agent` "helper", `.chat-agent-state` "done",
    `.chat-state[hidden]`, `.chip-spend[hidden]`, `.chat-parent` "Show in conversation", `.chat-stop[hidden]`;
    in the pane `.msg.is-user.is-brief` "hello there" then `.msg.is-assistant`. The composer: `#input`
    disabled with the placeholder "A subagent has no composer. Talk to its conversation.", `#send[hidden]`,
    `#composer.is-agent`, the picker hidden, `.composer-hint` not visible. `document.title` and the
    `.session.is-active` row still name the conversation. Click `.chat-parent`: the conversation's tab is
    active again and the block is open and flashed. Click `.session-agent-go` with the child's tab open:
    that tab is activated. Close the child's tab.
72. **A streaming child**: from `browser_evaluate`, set `#input` to `spawn: slow: w0 w1 … w79`, dispatch
    `input`, `requestSubmit()` the form, and wait 1500 ms. Expect the newest `.agent.is-running[open]` with
    `.agent-state` "working", `.agent-stop` shown, a `.msg-text.is-live` in `.agent-body` growing word by word,
    the transcript still at the bottom; the sidebar's active row reading `spawn_subagent` with the facts
    `1 tool call · 1 agent`, its child row `.session-agent.is-working.is-last` reading `working · writing a reply`
    under the sheen (`--phase` set on the row), `.tab.is-working`, `.chat-state` "spawn_subagent",
    `document.title` "(1) …", `#stop` shown. After 4500 ms more: the block folded, `.agent-state` "done",
    `.agent-took` "4s", the row `is-done`, the title without "(1)".
73. **Stop a running block**: send a hundred-word `slow:` spawn the same way, wait 1200 ms, and click
    `.agent-stop` from `browser_evaluate`. Expect the block still `open` right after the click (the button
    does not toggle the fold), then within 2500 ms: `.agent.is-bad`, folded, `.agent-state` "stopped",
    `.agent-stop[hidden]`, in `.agent-body` the partial `.msg.is-assistant` and a `.msg.is-note.is-quiet`
    "Stopped.", after it a `.tool-label` "stopped" with a `.tool-pre` reading `stopped: the subagent was stopped
    before it finished.` and, under `What it had said so far:`, the words it streamed; the sidebar row
    `.session-agent.is-stopped`; and the parent's own reply (`tool said: [subagent … helper] stopped: …`, no
    stack trace) ending the turn.
74. **Reload while a child runs**: send a 120-word `slow:` spawn, wait 900 ms, and reload. Expect, once the
    record is restored, the newest block `.agent.is-running[open]` with `.agent-state` "working", its
    `.msg-text.is-live` continuing from the words already streamed, the sidebar row `is-working`, the tab
    `is-working`, `#stop` shown; every finished block folded with an **empty** `.agent-body` (rows are built on
    first open). After the child ends: `.agent-state` "done", `.agent-took` "6s", one row in the body.
75. **Lazy build on open**: click a finished block's `.agent-head`. Expect `open` and the child's rows in
    `.agent-body` (one `.msg.is-assistant` for an echo child). The stopped child of step 73 is restored with
    `.agent-label` "helper" and `.agent-state` "stopped" (its spawn result's second line is `stopped: …`), and
    its sidebar row reads `helper stopped`.
76. **Regression**: steps 1 to 13 still pass on this setup (the echo provider reports no usage, so step 4's
    `.msg-usage` is absent here by design; `#statusbar` is shown because `@thetis/terminal` is installed).

Stop the daemon by the pid on `.devhome3/thetis.sock`, release `/tmp/thetis-browser.lock`, and delete `.devhome3`.

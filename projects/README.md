# @thetis/projects

Named workspaces for one person. A project is a name, zero or more project directories, standing instructions, and a set of tools and skills switched off; a conversation belongs to at most one project. The package is a `loader` with a `ui`: two pipeline steps that run inside the person's own fence on every turn, and a switcher and a settings place in the web gateway, which `@thetis/gateway-web` serves and whose commands it calls as the person. Its files live under `projects/` in the person's home. It has no build step and one dependency, the `@thetis/skills` library, imported only when the page asks for the skill list (a person without it still has their projects). It changes no kernel code and decides no mount: binding a host directory is the operator's authority, which an admin reaches through this package's two admin commands.

## What it provides

The manifest declares `type: "loader"`, two `steps`, and a `ui` block with `dir: "ui"`, `entry: "index.js"` and `style: "index.css"`.

| Step | Phase | Export | Effect |
|---|---|---|---|
| `project-prompt` | `prompt` | `projectPrompt` | Finds the session's project through `projects/sessions.json`. Without one, returns nothing. With one, appends to `call.system` a section `## Project: <name>`, one line per project directory with what the agent can do with it (`(mounted rw)`, or `NOT USABLE` and why, with the command an admin would run), one line telling the model to say so rather than work around it, and the instructions under `### Instructions` when there are any. |
| `project-tools` | `call` | `projectTools` | Without a project, or with nothing switched off, returns nothing. Otherwise returns `call` with the switched-off tools removed from `call.tools`. The `call` phase runs after every `tools`-phase step, so it sees the full list. |

| Slot | Id | Label | Notes |
|---|---|---|---|
| `sidebar` | `head` | | The switcher, under the ≡ menu button. |
| `places` | `project` | Project | Hint: "This project's directories, tools and instructions". |

Nine commands. Seven are any signed-in person's; `browse` and `mount` need the admin role, because only an admin may reach the operator table. Each answers `{ data }`, and a refusal is a thrown error the gateway answers as `400 { error }`.

| Verb | Export | Arguments | Answer |
|---|---|---|---|
| `list` | `uiList` | none | The projects with their directory and conversation counts, the session-to-project map, and `current`: the project of the conversation the page named, or `null`. |
| `get` | `uiGet` | `id?` | The project, its directories with the state of each (see below), the instructions, the conversation count, this fence's mounts, the operator's mount list for an admin, every installed package's tools with a `disabled` flag, and `skills`: every skill `loadSkills` finds (`id`, `brief`, `short`, `package`, `universal`, `disabled`), a nested skill counting as disabled when its parent is. Without `id`, the template a new project starts from. |
| `save` | `uiSave` | `id?`, `name`, `directories?`, `disable?`, `disableSkills?`, `instructions?` | Creates without `id`, updates with one. `disable` is tool names for `tools.disable`; `disableSkills` is skill ids for `skills.disable`. `instructions` left out keeps the file; an empty string empties it. |
| `remove` | `uiRemove` | `id` | Deletes the record, the instructions, and the project's assignments. |
| `assign` | `uiAssign` | `session`, `project` | Puts the conversation in a project, or takes it out with `null`. `session` must be the one the page named. |
| `sessions` | `uiSessions` | `project` | The ids of the conversations in the project. |
| `mounts` | `uiMounts` | `paths?` | This fence's mounts, from `THETIS_MOUNTS`, and the state of each path asked about (at most 64), so the page can tell the truth about a directory it has not saved yet. Also the page's heartbeat while the fence reopens after a bind. |
| `browse` | `uiBrowse` | `path?` | Admin only. The directories under one host path, through `host.grants.mountsBrowse`. The picker draws from it; a person's fence shows only what is bound into it, so the listing has to come from the operator. |
| `mount` | `uiMount` | `path`, `mode` | Admin only. Binds `path` into this person's own fence (`rw` or `ro`), or unbinds it with `mode: null`, by sending the whole list through `host.grants.mountsSet`. The user id comes from `env.user`, never from the page. The answer says whether the host has a directory at the path. |

`save` checks: a name of 1 to 80 characters; each directory absolute and normalized, with no `..` and no NUL; at most 64 directories, 256 tool names of at most 64 characters, 256 skill ids in the library's shape (lowercase words and dashes, up to three levels joined by `/`), 32768 characters of instructions; at most 32 projects per person. Duplicates are dropped.

The files are `projects/<id>.json` (the record), `projects/<id>.md` (the instructions) and `projects/sessions.json` (the assignments). An id is `p_` and 8 hexadecimal characters.

A project directory does not open the fence, and a mount over it is not enough on its own. `lib/mounts.js` folds four questions — does the path lie under the home, is a mount over it, what does the fence find there, and is a mount written down that the fence did not take — into one state, and every surface says the same one:

| State | Meaning |
|---|---|
| `ready` | It is reachable and the directory is there. With `home: true` it is inside the person's own space, which needs no mount. |
| `empty-path` | It is reachable and nothing is at the path. |
| `not-a-directory` | It is reachable and a file is at the path. |
| `skipped` | A mount is written down and the host has no directory there, so the fence opened without it. |
| `unmounted` | It is outside the home and no mount covers it. The file tools cannot reach it. |

`skipped` needs the operator's list, so for anyone but an admin it reads as `unmounted`. Both mean the same to them: the directory cannot be used.

## Use

**The switcher** sits at the head of the sidebar: a row `Project <name>` with a caret. It opens a list: All conversations, each project with how many conversations it holds, Settings for the chosen project, and New project…. Choosing a project narrows the conversation list to the conversations assigned to it; the choice is kept in `localStorage` under `thetis.project`. While a project is chosen, a conversation created in this browser tab is assigned to it through `ext.sessions.onCreate`, before the conversation opens or its first message is sent. A conversation arriving in the list from another tab or the command line is never assigned by this page.

**The place** is the project's settings, opened from the switcher: a name input; the project directories; a text area for the instructions; the conversation count; every installed package's tools with a switch each, off meaning switched off for the project; every skill the loaders see, grouped by the package it comes from (the home's own last), with the same switch, a nested skill greyed and off when its parent is off; and **Save** and **Delete project**, the latter behind a confirm popover. A new project is chosen after its first save.

The name, the instructions and the switches are a draft and wait for Save. The directory list does not: adding or removing a directory saves the list at once, on its own, leaving every other field of the record as it was. A directory is bound into the workspace as soon as it is chosen, so a list that waited for Save was a list that could name a bind nobody had recorded -- which is how a person lost two directories they had just chosen and bound, and found an empty page with the binds still in place. A project that has not been created yet has nowhere to save to, so its list waits for **Create project**, and a save the workspace refuses leaves the draft alone and says so. Whatever the record does not hold yet is named beside the button ("Not saved yet: the name and the instructions."), the browser warns before the tab closes on it, and closing the place -- Escape, the ✕, opening a conversation -- keeps the draft for as long as the page is loaded, so coming back finds it.

**A directory row** carries the path, a badge for its state, a remove button, and one sentence saying what an agent in this project can do with it now. When any directory is unusable the section says so above the rows, in as many words. An admin gets the buttons to repair it there: **Bind it**, or **Make read-only** / **Allow writing** / **Unbind**. Anyone else gets the `thetis mounts add` line to hand to an admin. An admin adds a directory with **Choose a directory…**, the shell's picker over `browse`, so a path that goes in is a path the host has; anyone else types it.

A mount is a change to the workspace, not a field of the project, so those buttons send at once, behind a confirm popover that says the workspace restarts. The directory list is saved before the bind is asked for, never after, because binding closes the fence. The kernel closes the fence to rebind it, which takes the gateway serving the page with it: the page treats its own lost request as expected, waits for the new workspace to answer, and then asks `mounts` for the state of every directory in the draft. The draft is never reloaded around a bind, so unsaved edits survive it.

The tool switch shows in the page after the first turn: the Tools dock of `@thetis/ui-tools` lists under **Turned off right now** every declared tool the last call did not carry. The skill switch shows at once: the Skills dock of `@thetis/ui-skills` reads `skills.disable` through the library's `excludedFor` and lists the ids under **Switched off by the project**; the loaders leave them out of the prompt and of `skill_fetch` from the next turn.

## Files

| File | Content |
|---|---|
| `package.json` | The two steps, the two slots, the nine commands. |
| `index.js` | The commands, and the re-exported steps. |
| `lib/steps.js` | `projectPrompt`, `projectTools`, `projectSection`. |
| `lib/store.js` | The records, the instructions, the assignments, the validation. |
| `lib/mounts.js` | `THETIS_MOUNTS` parsing, `stateOf` for one directory, and the line the prompt shows. |
| `ui/index.js` | `install(ext)`: the state, the switcher in the sidebar's head slot, the place. |
| `ui/switcher.js`, `ui/place.js`, `ui/place-parts.js`, `ui/state.js` | The switcher, the settings page and its sections, the page's project state. |
| `ui/index.css` | The styles, under `.pj-`. |
| `test/store.test.js`, `test/steps.test.js`, `test/commands.test.js`, `test/helpers.js` | The tests. |

## Tests

`npm test` from the runtime root runs `test/store.test.js` (create, read, update, assign, remove, the limit, every validation rule), `test/steps.test.js` (nothing for an unassigned or stale session, the prompt section with mount states and instructions, the tool filter, `THETIS_MOUNTS` parsing) and `test/commands.test.js` (every verb against a fake environment over a temporary home, and that the browser modules parse). The browser checklist is `packages/gateway-web/test/BROWSER.md`.

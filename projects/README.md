# @thetis/projects

Named workspaces for one person. A project is a name, zero or more project directories, standing instructions, and a set of tools and skills switched off; a conversation belongs to at most one project. The package is a `loader` with a `ui`: two pipeline steps that run inside the person's own fence on every turn, and a switcher and a settings place in the web gateway, which `@thetis/gateway-web` serves and whose commands it calls as the person. Its files live under `projects/` in the person's home. It has no build step and one dependency, the `@thetis/skills` library, imported only when the page asks for the skill list (a person without it still has their projects). It changes no kernel code and never mounts anything.

## What it provides

The manifest declares `type: "loader"`, two `steps`, and a `ui` block with `dir: "ui"`, `entry: "index.js"` and `style: "index.css"`.

| Step | Phase | Export | Effect |
|---|---|---|---|
| `project-prompt` | `prompt` | `projectPrompt` | Finds the session's project through `projects/sessions.json`. Without one, returns nothing. With one, appends to `call.system` a section `## Project: <name>`, one line per project directory with `(mounted rw)`, `(mounted ro)` or `(not mounted — ask an admin: thetis mounts add <user> <path>)`, and the instructions under `### Instructions` when there are any. |
| `project-tools` | `call` | `projectTools` | Without a project, or with nothing switched off, returns nothing. Otherwise returns `call` with the switched-off tools removed from `call.tools`. The `call` phase runs after every `tools`-phase step, so it sees the full list. |

| Slot | Id | Label | Notes |
|---|---|---|---|
| `sidebar` | `head` | | The switcher, under the ≡ menu button. |
| `places` | `project` | Project | Hint: "This project's directories, tools and instructions". |

Seven commands. Any signed-in person may send them; each answers `{ data }`, and a refusal is a thrown error the gateway answers as `400 { error }`.

| Verb | Export | Arguments | Answer |
|---|---|---|---|
| `list` | `uiList` | none | The projects with their directory and conversation counts, the session-to-project map, and `current`: the project of the conversation the page named, or `null`. |
| `get` | `uiGet` | `id?` | The project, its directories with their mount state (`rw`, `ro` or `null`), the instructions, the conversation count, this fence's mounts, every installed package's tools with a `disabled` flag, and `skills`: every skill `loadSkills` finds (`id`, `brief`, `short`, `package`, `universal`, `disabled`), a nested skill counting as disabled when its parent is. Without `id`, the template a new project starts from. |
| `save` | `uiSave` | `id?`, `name`, `directories?`, `disable?`, `disableSkills?`, `instructions?` | Creates without `id`, updates with one. `disable` is tool names for `tools.disable`; `disableSkills` is skill ids for `skills.disable`. `instructions` left out keeps the file; an empty string empties it. |
| `remove` | `uiRemove` | `id` | Deletes the record, the instructions, and the project's assignments. |
| `assign` | `uiAssign` | `session`, `project` | Puts the conversation in a project, or takes it out with `null`. `session` must be the one the page named. |
| `sessions` | `uiSessions` | `project` | The ids of the conversations in the project. |
| `mounts` | `uiMounts` | none | This fence's mounts, from `THETIS_MOUNTS`. |

`save` checks: a name of 1 to 80 characters; each directory absolute and normalized, with no `..` and no NUL; at most 64 directories, 256 tool names of at most 64 characters, 256 skill ids in the library's shape (lowercase words and dashes, up to three levels joined by `/`), 32768 characters of instructions; at most 32 projects per person. Duplicates are dropped.

The files are `projects/<id>.json` (the record), `projects/<id>.md` (the instructions) and `projects/sessions.json` (the assignments). An id is `p_` and 8 hexadecimal characters.

A project directory does not open the fence. The package reads what is mounted from `THETIS_MOUNTS`, the same source the file tools use, and marks the rest as not mounted so the model can ask an admin instead of failing.

## Use

**The switcher** sits at the head of the sidebar: a row `Project <name>` with a caret. It opens a list: All conversations, each project with how many conversations it holds, Settings for the chosen project, and New project…. Choosing a project narrows the conversation list to the conversations assigned to it; the choice is kept in `localStorage` under `thetis.project`. While a project is chosen, a conversation started with `+` is assigned to it with one `assign` request. Conversations that exist when the page loads are never assigned by the page.

**The place** is the project's settings, opened from the switcher: a name input; the project directories, one row each with a badge `mounted · read-write`, `mounted · read-only` or `not mounted` and a remove button, plus an input to add one; a text area for the instructions; the conversation count; every installed package's tools with a switch each, off meaning switched off for the project; every skill the loaders see, grouped by the package it comes from (the home's own last), with the same switch, a nested skill greyed and off when its parent is off; and **Save** and **Delete project**, the latter behind a confirm popover. Nothing is sent until Save. A new project is chosen after its first save.

The tool switch shows in the page after the first turn: the Tools dock of `@thetis/ui-tools` lists under **Turned off right now** every declared tool the last call did not carry. The skill switch shows at once: the Skills dock of `@thetis/ui-skills` reads `skills.disable` through the library's `excludedFor` and lists the ids under **Switched off by the project**; the loaders leave them out of the prompt and of `skill_fetch` from the next turn.

## Files

| File | Content |
|---|---|
| `package.json` | The two steps, the two slots, the seven commands. |
| `index.js` | The commands, and the re-exported steps. |
| `lib/steps.js` | `projectPrompt`, `projectTools`, `projectSection`. |
| `lib/store.js` | The records, the instructions, the assignments, the validation. |
| `lib/mounts.js` | `THETIS_MOUNTS` parsing and the mount state of a directory. |
| `ui/index.js` | `install(ext)`: the state, the switcher in the sidebar's head slot, the place. |
| `ui/switcher.js`, `ui/place.js`, `ui/place-parts.js`, `ui/state.js` | The switcher, the settings page and its sections, the page's project state. |
| `ui/index.css` | The styles, under `.pj-`. |
| `test/store.test.js`, `test/steps.test.js`, `test/commands.test.js`, `test/helpers.js` | The tests. |

## Tests

`npm test` from the runtime root runs `test/store.test.js` (create, read, update, assign, remove, the limit, every validation rule), `test/steps.test.js` (nothing for an unassigned or stale session, the prompt section with mount states and instructions, the tool filter, `THETIS_MOUNTS` parsing) and `test/commands.test.js` (every verb against a fake environment over a temporary home, and that the browser modules parse). The browser checklist is `packages/gateway-web/test/BROWSER.md`.

See docs/22-projects.md in the runtime repository.

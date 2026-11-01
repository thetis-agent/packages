# @thetis/projects

Named projects for one person. A project is a name, zero or more project directories, standing instructions, and a set of tools and skills switched off; a conversation belongs to at most one project. The package is a `loader` with a `ui`: three pipeline steps that run inside the person's own fence on every turn, and in the web gateway the space provider, a switcher, a composer pill and a settings place, which `@thetis/gateway-web` serves and whose commands it calls as the person. Its files live under `projects/` in the person's home. It has no build step and one dependency, the `@thetis/skills` library, imported only when the page asks for the skill list (a person without it still has their projects). It changes no kernel code and decides no mount: `browse` and `mount` go through `host.grants`, which lets a person bind any host directory into their own fence except the blocked ones and lets an admin bind anything.

## What it provides

The manifest declares `type: "loader"`, three `steps`, and a `ui` block with `dir: "ui"`, `entry: "index.js"` and `style: "index.css"`.

| Step | Phase | Export | Effect |
|---|---|---|---|
| `inherit` | `history` | `inheritProject` | For a subagent (`ctx.session.parent`) with no `projects/agents/<id>.json`: resolves the parent's project and, when there is one, writes `{"project":"p_…","parent":"s_…"}` there. Returns nothing. History runs before every other phase, so the steps below and other packages find it, and a grandchild chains through its parent's file. |
| `project-prompt` | `prompt` | `projectPrompt` | Finds the session's project (see the resolver below). Without one, returns nothing. With one, appends to `call.system` a section `## Project: <name>`, one line per project directory with what the agent can do with it (`(mounted rw)`, or `NOT USABLE` and why, with the command an admin would run), one line telling the model to say so rather than work around it, and the instructions under `### Instructions` when there are any. |
| `project-tools` | `call` | `projectTools` | Without a project, or with nothing switched off, returns nothing. Otherwise returns `call` with the switched-off tools removed from `call.tools`. The `call` phase runs after every `tools`-phase step, so it sees the full list. |

| Slot | Id | Label | Notes |
|---|---|---|---|
| `sidebar` | `head` | | The switcher, under the ≡ menu button. |
| `composer` | `project` | Project | The project pill, beside the model pill. Hint: "Which project this conversation is in". |
| `places` | `project` | Project | Hint: "This project's directories, tools and instructions". |

Nine commands, all any signed-in person's. `browse` and `mount` reach `host.grants`, which pins a person's call to them and refuses the blocked paths. Each answers `{ data }`, and a refusal is a thrown error the gateway answers as `400 { error }`.

| Verb | Export | Arguments | Answer |
|---|---|---|---|
| `list` | `uiList` | none | The projects with their directory and conversation counts (root conversations only: the map), the session-to-project map, and `current`: the project of the conversation the page named, or `null`. |
| `get` | `uiGet` | `id?` | The project, its directories with the state of each (see below), the instructions, the conversation count, this fence's mounts, the operator's mount list for an admin, every installed package's tools with a `disabled` flag, and `skills`: every skill `loadSkills` finds (`id`, `brief`, `short`, `package`, `universal`, `disabled`), a nested skill counting as disabled when its parent is. Without `id`, the template a new project starts from. |
| `save` | `uiSave` | `id?`, `name`, `directories?`, `disable?`, `disableSkills?`, `instructions?` | Creates without `id`, updates with one. `disable` is tool names for `tools.disable`; `disableSkills` is skill ids for `skills.disable`. `instructions` left out keeps the file; an empty string empties it. |
| `remove` | `uiRemove` | `id` | Deletes the record, the instructions, and the project's assignments. |
| `assign` | `uiAssign` | `session`, `project` | Puts the conversation in a project, or takes it out with `null`. `session` must be the one the page named. |
| `sessions` | `uiSessions` | `project` | The ids of the conversations in the project. |
| `mounts` | `uiMounts` | `paths?` | This fence's mounts, from `THETIS_MOUNTS`, and the state of each path asked about (at most 64), so the page can tell the truth about a directory it has not saved yet. Also the page's heartbeat while the fence reopens after a bind. |
| `browse` | `uiBrowse` | `path?` | The directories under one host path, through `host.grants.mountsBrowse`. The picker draws from it; a person's fence shows only what is bound into it, so the listing has to come from the operator. |
| `mount` | `uiMount` | `path`, `mode` | Binds `path` into this person's own fence (`rw` or `ro`), or unbinds it with `mode: null`, by sending the whole list through `host.grants.mountsSet`. The user id comes from `env.user`, never from the page. The answer says whether the host has a directory at the path. |

`save` checks: a name of 1 to 80 characters; each directory absolute and normalized, with no `..` and no NUL; at most 64 directories, 256 tool names of at most 64 characters, 256 skill ids in the library's shape (lowercase words and dashes, up to three levels joined by `/`), 32768 characters of instructions; at most 32 projects per person. Duplicates are dropped.

The files are `projects/<id>.json` (the record), `projects/<id>.md` (the instructions), `projects/sessions.json` (the assignments of root conversations) and `projects/agents/<session>.json` (a subagent's inherited project). An id is `p_` and 8 hexadecimal characters.

A session's project is found by one rule, and every package that reads these files uses the same one: `map[id] ?? agents/<id>.json?.project ?? null`. `lib/store.js` has it as `projectIdOf`, and `projectOfSession` reads the record. Subagents are kept out of the map so five running in parallel never race a page's write, and so the counts stay roots only.

When a person forgets a conversation, `forgetSession` (declared as `thetis.sessions.forget`) drops it and its subagent conversations from `projects/sessions.json`, rewritten whole and renamed into place, and deletes their agents files. The project stays.

A project directory does not open the fence, and a mount over it is not enough on its own. `lib/mounts.js` folds four questions — does the path lie under the home, is a mount over it, what does the fence find there, and is a mount written down that the fence did not take — into one state, and every surface says the same one:

| State | Meaning |
|---|---|
| `ready` | It is reachable and the directory is there. With `home: true` it is inside the person's own space, which needs no mount. |
| `empty-path` | It is reachable and nothing is at the path. |
| `not-a-directory` | It is reachable and a file is at the path. |
| `skipped` | A mount is written down and the host has no directory there, so the fence opened without it. |
| `unmounted` | It is outside the home and no mount covers it. The file tools cannot reach it. |

`skipped` needs the list written down for the person, `host.grants.mountsList`, which anyone may read about themselves (the kernel pins the call to the caller). On a kernel that refuses that self call the list is unknown and `skipped` reads as `unmounted`; both mean the directory cannot be used.

## Use

**A project is a space you are in.** The page's state (`ui/state.js`) is the gateway's space provider: `ext.space.provide({ of, name })`, where `of(id)` is a root conversation's project, `null` for none, or `undefined` until the map has been read with that conversation in it (an unknown id makes the map be read again once, because a workflow's service may have assigned it). The shell keeps the current space in `localStorage` under `thetis.space` and swaps the sidebar list, the tab strip and the draft when it changes; this package tells it `ext.space.changed()` after every read and every assignment. The key used before, `thetis.project`, is entered once and removed. A current space whose project is gone becomes No project. On a gateway without `ext.space` the old key and `ext.sessions.filter` stand in.

**The switcher** sits at the head of the sidebar: a row `Project <name>`, or `Project No project`, with a caret, and a dot while something works in another project. The list holds each project with how many conversations it has ("2 working" while some run), No project with its count, then Project settings and New project…. The counts come from the sidebar's own list through the same `of`. Picking one enters that space.

**The pill** in the composer reads "● Torchship" or "No project". On the draft, picking another project enters it and the typed text stays. On a conversation the list is headed "Move to": picking moves the conversation (`assign`), and the space follows it. A subagent's pill only names its root's project. A conversation started on this page joins the space of its draft, which the shell passes to `ext.sessions.onCreate`. One arriving from another tab or the command line is never assigned here.

**The place** is opened three ways. From Project settings it is the current project's settings (`{ id }`), and from New project… it is the empty form (`{ new: true }`). From the main menu (no arguments) it is the settings of the project you are in, and in No project it is **Pick a project or create one**: every project as a row with how many conversations and directories it has, and a **New project** button. Picking a row enters that project and opens its settings. After **Delete project** the place returns to that list.

The settings page starts with **New conversation**, which closes the place and opens the draft in that project (`ext.conversation.start`). Then: a name input; the project directories; a text area for the instructions; the conversation count ("No conversations yet." for none); every installed package's tools with a switch each, off meaning switched off for the project; every skill the loaders see, grouped by the package it comes from (the home's own last), with the same switch, a nested skill greyed and off when its parent is off; and **Save** and **Delete project**, the latter behind a confirm popover. A new project is entered after its first save.

The name, the instructions and the switches are a draft and wait for Save. The directory list does not: adding or removing a directory saves the list at once, on its own, leaving every other field of the record as it was. A directory is bound into the workspace as soon as it is chosen, so a list that waited for Save was a list that could name a bind nobody had recorded -- which is how a person lost two directories they had just chosen and bound, and found an empty page with the binds still in place. A project that has not been created yet has nowhere to save to, so its list waits for **Create project**, and a save the workspace refuses leaves the draft alone and says so. Whatever the record does not hold yet is named beside the button ("Not saved yet: the name and the instructions."), the browser warns before the tab closes on it, and closing the place -- Escape, the ✕, opening a conversation -- keeps the draft for as long as the page is loaded, so coming back finds it.

**A directory row** carries the path, a badge for its state, a remove button, and one sentence saying what an agent in this project can do with it now. When any directory is unusable the section says so above the rows, in as many words. Everyone gets the buttons to repair it there: **Bind it**, or **Make read-only** / **Allow writing** / **Unbind**; a blocked path is refused with the reason in a toast. A directory goes in with **Choose a directory…**, the shell's picker over `browse`, which dims and will not choose a blocked directory, or by typing it.

A mount is a change to the workspace, not a field of the project, so those buttons send at once, behind a confirm popover that says the workspace restarts. The directory list is saved before the bind is asked for, never after, because binding closes the fence. The kernel closes the fence to rebind it, which takes the gateway serving the page with it: the page treats its own lost request as expected, waits for the new workspace to answer, and then asks `mounts` for the state of every directory in the draft. The draft is never reloaded around a bind, so unsaved edits survive it.

The tool switch shows in the page after the first turn: the Tools dock of `@thetis/ui-tools` lists under **Turned off right now** every declared tool the last call did not carry. The skill switch shows at once: the Skills dock of `@thetis/ui-skills` reads `skills.disable` through the library's `excludedFor` and lists the ids under **Switched off by the project**; the loaders leave them out of the prompt and of `skill_fetch` from the next turn.

## Files

| File | Content |
|---|---|
| `package.json` | The three steps, the slots, the nine commands. |
| `index.js` | The commands, and the re-exported steps. |
| `lib/steps.js` | `inheritProject`, `projectPrompt`, `projectTools`, `projectSection`. |
| `lib/store.js` | The records, the instructions, the assignments, the agents files and the resolver, the validation. |
| `lib/mounts.js` | `THETIS_MOUNTS` parsing, `stateOf` for one directory, and the line the prompt shows. |
| `lib/forget.js` | `forgetSession`, the forget hook. |
| `ui/index.js` | `install(ext)`: the state, the switcher in the sidebar's head slot, the pill in the composer, the place. |
| `ui/switcher.js`, `ui/pill.js`, `ui/place.js`, `ui/place-parts.js`, `ui/state.js` | The switcher, the pill, the settings page and its sections, the page's project state and space provider. |
| `ui/index.css` | The styles, under `.pj-`. |
| `test/*.test.js`, `test/helpers.js` | The tests. |

## Tests

`npm test` from the runtime root runs `test/store.test.js` (create, read, update, assign, remove, the limit, every validation rule), `test/steps.test.js` (nothing for an unassigned or stale session, the prompt section, the tool filter, `THETIS_MOUNTS` parsing, `inheritProject` for a child, a grandchild, no parent and a parent in no project, and the resolver), `test/commands.test.js` (every verb against a fake environment over a temporary home, counts that leave out subagents, and that the browser modules parse), `test/forget.test.js` (the map and the agents files), `test/state.test.js` (the space provider, creation in the draft's space, the key migration, working counts, the older-gateway filter), `test/pill.test.js` (the pill on the draft, on a conversation, on a subagent) and `test/place.test.js` (the pick-or-create list, picking one, New project, the three ways it opens a page, New conversation). The browser checklist is `packages/gateway-web/test/BROWSER.md`.

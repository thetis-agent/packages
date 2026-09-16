# @thetis/ui-skills

The Skills dock of the web gateway: the skills the open conversation can reach, which of them are in force, and what its project switched off. It is a `ui` package with no build step and one dependency, the `@thetis/skills` library, which it imports the way `@thetis/ui-marketplace` imports `@thetis/marketplace`. Its browser module runs in the page; its two commands run inside the person's own fence, where `@thetis/gateway-web` calls them as the person. Every person gets it by default.

## What it provides

The manifest declares `type: "ui"` and a `ui` block with `dir: "ui"`, `entry: "index.js"` and `style: "index.css"`.

| Slot | Id | Label | Notes |
|---|---|---|---|
| `dock` | `skills` | Skills | `wide: true`, `order: 110`, so it sits after Tools and Context. Hint: "The skills this conversation can reach, and which are in force". |

| Verb | Export | Who may send it | What it does |
|---|---|---|---|
| `skills` | `uiSkills` | any signed-in person | `{ loader, loaders, universal, pinned, loaded, catalogue, dropped, notes, excluded, skills }`. The first block is the state the loader in force wrote for the conversation under `harness["@thetis/skills"]` (docs/23-skills.md section 5), read through `env.kernel.sessions.inspect(env.session)`; `loaders` names the installed loader packages; `excluded` is what the conversation's project switched off, from `excludedFor`, so a switch flipped in the project place shows at once; `skills` is the catalogue from `loadSkills(env, env.kernel.packages.list())`, one row per skill: `id`, `name`, `title`, `brief`, `short` (the first sentence), `description`, `tags`, `universal`, `package` (null for a skill under the home), `contentHash`, `children`, and `error` when `lint` would leave it out. Without a session, the catalogue alone. |
| `skill` | `uiSkill` | any signed-in person | `{ id }` to `{ id, title, brief, package, contentHash, universal, excluded, children, resources, text }`, where `text` is what `renderBody` makes: the body, the skill directory, and the files beside `SKILL.md`. A missing or unknown id is refused. |

Neither command reads a configuration; a UI command gets none (docs/15-web-gateway.md section 11.4).

## Use

The **Skills** button in the rail opens the dock. The subtitle counts the skills and names the loader. The sections, in order:

| Section | Content |
|---|---|
| Loader | The package that wrote the prompt of the last turn. Before the first turn: the installed loader and a note that it writes its state on the first turn. With none installed: "No skill loader is installed. Install one of @thetis/skills-hybrid, @thetis/skills-l1 or @thetis/skills-all." Without a conversation: a note to open one. |
| Always in force | The universal skills, from the loader's state; before a loader has run, the skills declared universal. |
| Retrieved for this conversation | The pinned set with `score` and `how`. Only when the loader pinned something. |
| Loaded in this conversation | The bodies the model asked for with `load_skill`. Only when there are any. |
| Switched off by the project | What the project's `skills.disable` leaves out, nested skills included; otherwise "Nothing is switched off by a project." |
| Left out for the budget | `dropped`, only when the loader dropped something. |
| Notes | The loader's notes, only when there are any. |
| Catalogue | Every skill, by id, with a search box. The search ranks the rows by BM25 over name, description and tags in the page (`ui/rank.js`, the same algorithm as the library's, held to it by a test) and shows the score; no keystroke sends a request. |

A row shows the id, the title, badges (`always`, `pinned`, `loaded`, `switched off`, `dropped`, `left out`), where the skill comes from, and its first sentence. Clicking a row opens the skill's text in the dock, rendered through `ext.markdown`, with a `← Skills` button back to the list; the text is asked for once per skill and content hash. A new conversation returns the dock to the list.

The dock asks once per conversation, once more when a turn of the open conversation ends, and never while drawing. A refused request shows its sentence in the body.

## Files

| File | Content |
|---|---|
| `package.json` | The dock entry and the two commands. |
| `index.js` | `uiSkills`, `uiSkill`, `stateOf`, `LOADERS`. |
| `ui/index.js` | `install(ext)`: registers the dock, watches the conversation and the turn events, draws the sections and one skill's text. |
| `ui/rank.js` | BM25 for the search box, a copy of the library's ranker for the page. |
| `ui/index.css` | The dock's styles, under `.sk-`. |
| `test/ui-skills.test.js` | The tests. |

## Tests

`npm test` from the runtime root runs `test/ui-skills.test.js`: the two commands over a fake kernel and a temporary home with a pack and a project (the state, the switches with a parent taking its nested skill, the catalogue rows, the refusals), the page's BM25 against the library's on the same rows, the manifest, and the browser module over a fake seam (nothing at import, one dock registered, one request per conversation and per turn end, the sections, the search without a request, a row opening the text through `skill` and the back link, the refusal). The browser checklist is `packages/gateway-web/test/BROWSER.md`.

See docs/15-web-gateway.md and docs/23-skills.md in the runtime repository.

# @thetis/skills-thetis

The skills that teach an agent inside Thetis what Thetis is, the words to use with a person, how to use it, and how to change it from the inside. It is a `skill` package: a directory of `SKILL.md` files and nothing else. A loader package puts the skills in front of the model. The text is Simplified Technical English (ASD-STE100). Every command, path, field, and shape comes from the code, which is the only thing that can be wrong in a way a reader can check.

## What it provides

The manifest declares `"thetis": { "type": "skill", "label": "Thetis skills", "skills": "skills" }`. No steps, no tools, no service, no UI, no bench suites.

Thirteen skills under `skills/thetis/`. None is universal: the loader puts one brief per top-level skill in the prompt, and a body is fetched by id. The first one, `thetis`, is the index.

**Two vocabularies.** The words the model uses with a person are the words the page uses: chat, reply, helper chat, your space, Files, extension, your copy, Update, Apply, Retry, Continue, Restart Thetis. The index opens with that table, and every child skill uses those words with the person. Fence, userspace, reload, fork, promote and daemon stay, for package authors, in the index's "How Thetis works inside" and in the mechanism sections of the children. Every procedure gives the browser route first and the host command second, in parentheses. No skill tells the model to ask a person to type "continue", or to run `thetis reload` or `thetis restart` for an ordinary change.

| Id | Content |
|---|---|
| `thetis` | The index: the words to use with a person, how a change takes effect (live on the next message; applied by itself when no reply runs; Restart Thetis for the core only), the one rule, which child skill to fetch, and how Thetis works inside. |
| `thetis/using` | Chats and replies, what happens when a reply stops (automatic retry, Retry and Continue, the automatic resume), helper chats and `resume_subagent`, reading other conversations, the shell, the file tools, the plan tools, `ask_user`, the home layout, standing notes, how a restart of Thetis goes. |
| `thetis/packages` | The manifest (with `thetis.label` and a tool's `reads`), steps, tools, providers, services, install sources, the store, forks (your copy, Switch back), delete, promote, publish. An install takes effect when this reply ends. |
| `thetis/pipeline` | Phases, enumeration, the step contract, the three variables, validation, the turn, `interrupted` and the resume, the round retry, the drain (`turns.yielding()`, the `yield` event), the events, the prompt cache rules. |
| `thetis/skills` | The skill format, the sources, the loaders and their tools, how to write a description, the lint rules. |
| `thetis/projects` | Project files, the two steps, the commands, the switcher, mounts, limits. |
| `thetis/marketplace` | Registries, the index, pinned sources, install, the Updates ready card and Update all, the two kinds of behind, the Extensions place. |
| `thetis/web` | The `thetis.ui` field, the slots, the commands, the browser seam with `ext.notice`, `ext.awaitReturn`, `ext.developer`, `ext.turns` and `ext.build`, a dock and a place, the shipped extensions. |
| `thetis/bench` | Opting in, the two seams, running a suite, what the numbers mean and do not mean. |
| `thetis/configuration` | Where a setting is set (an extension's Configure form, the admin's Settings tab, the server's file), every field of `thetis.config.json`, `thetis config tidy`, the tiers, per-package configuration, secrets. |
| `thetis/developing` | The host side: building and testing the runtime, the house rules, what it takes for a change to the runtime to be live, the one-button update. |
| `thetis/fence` | What the sandbox binds, hidden paths, mounts (server folders), ssh keys, network modes, Docker, limits, what fails and why. |
| `thetis/troubleshooting` | Error codes, a reply that stopped and each `why`, my change is not live (three answers), a refused restart, failed steps, refused tools, failed installs, services, providers, where the records are. |

Longer reference material sits beside the skill that uses it: `packages/references/manifest.md`, `packages/references/operator-methods.md`, `pipeline/references/turn-events.md`, and `web/references/ext-seam.md`.

## Configuration

`config.packages["@thetis/skills-thetis"]` has no keys. The package reads no environment variables.

## Use

A loader reads the skills from the directory the manifest names. It indexes the `name`, the `description`, and the `metadata.tags` of each `SKILL.md`. It never indexes the body. It puts a brief of each top-level skill in every prompt. The model fetches a body with `skill_fetch`:

```
skill_fetch { id: "thetis/packages" }
skill_fetch { id: "thetis/packages", file: "references/manifest.md" }
```

Every person gets the package by default. A person installs it with **Install** in **Extensions**, and an admin installs it for somebody else with **Install for <person>** there. On the host:

```sh
thetis packages install @thetis/skills-thetis --user alice
```

To write a skill of your own, follow `thetis/skills`. Put it under `skills/` in your home, or in a package like this one.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: type `skill`, directory `skills`. |
| `skills/thetis/SKILL.md` | The index skill. |
| `skills/thetis/<name>/SKILL.md` | One child skill per directory. |
| `skills/thetis/<name>/references/*.md` | Reference tables beside the skill that links them. |
| `test/skills.test.js` | The checks below. |

## Tests

Run `node --test "packages/skills-thetis/test/*.test.js"` from the runtime root. No build, no dependency. The test checks every `SKILL.md`:

- The frontmatter is fenced by `---` lines. `name` and `description` are present.
- `name` equals the directory name. `description` is at most 1,024 bytes.
- The body is at most 400 lines. A universal body would be at most 40 lines; none is universal.
- `metadata.tags` are at most 32 lowercase words. Every `metadata.related` id exists.
- Every relative link target exists inside the package.
- Every body ends with a `## Sources` list.
- No file uses a word or a character from the style deny-list in `test/skills.test.js`.


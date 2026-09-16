# @thetis/skills-thetis

The skills that teach an agent inside Thetis what Thetis is, how to use it, and how to change it from the inside. It is a `skill` package: a directory of `SKILL.md` files and nothing else. A loader package puts the skills in front of the model. The text is Simplified Technical English (ASD-STE100). Every command, path, field, and shape comes from `docs/` and from the code, and the code wins when the two disagree.

## What it provides

The manifest declares `"thetis": { "type": "skill", "skills": "skills" }`. No steps, no tools, no service, no UI, no bench suites.

Twelve skills under `skills/thetis/`. The first one is universal: its body is in every prompt. The others are fetched by id.

| Id | Content |
|---|---|
| `thetis` | What Thetis is, the one rule, and which child skill to fetch. Universal. |
| `thetis/using` | Sessions, subagents, `exec`, the file tools, the plan tools, `ask_user`, the home layout, `THETIS.md`. |
| `thetis/packages` | The manifest, steps, tools, providers, services, install sources, the store, forks, delete, promote, install for everyone. |
| `thetis/pipeline` | Phases, enumeration, the step contract, the three variables, validation, the turn, the events, the prompt cache rules. |
| `thetis/skills` | The skill format, the sources, the loaders and their tools, how to write a description, the lint rules. |
| `thetis/projects` | Project files, the two steps, the commands, the switcher, mounts, limits. |
| `thetis/marketplace` | Registries, the index, pinned sources, install, update, the Marketplace place. |
| `thetis/web` | The `thetis.ui` field, the slots, the commands, the browser seam, a dock and a place. |
| `thetis/bench` | Opting in, the two seams, running a suite, what the numbers mean and do not mean. |
| `thetis/configuration` | The data directory, every field of `thetis.config.json`, per-package configuration, secrets. |
| `thetis/fence` | What the sandbox binds, hidden paths, mounts, network modes, limits, what fails and why. |
| `thetis/troubleshooting` | Error codes, failed steps, refused tools, failed installs, services, providers, where the records are. |

Longer reference material sits beside the skill that uses it: `packages/references/manifest.md`, `packages/references/operator-methods.md`, `pipeline/references/turn-events.md`, and `web/references/ext-seam.md`.

## Configuration

`config.packages["@thetis/skills-thetis"]` has no keys. The package reads no environment variables.

## Use

A loader reads the skills from the directory the manifest names. It indexes the `name`, the `description`, and the `metadata.tags` of each `SKILL.md`. It never indexes the body. It puts the body of the universal skill `thetis` in every prompt, and a brief of every other skill. The model fetches a body with `skill_fetch`:

```
skill_fetch { id: "thetis/packages" }
skill_fetch { id: "thetis/packages", file: "references/manifest.md" }
```

Install the package for one person, or for everyone:

```sh
thetis packages install @thetis/skills-thetis --user alice
```

To write a skill of your own, follow `thetis/skills`. Put it under `skills/` in your home, or in a package like this one.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: type `skill`, directory `skills`. |
| `skills/thetis/SKILL.md` | The universal skill. |
| `skills/thetis/<name>/SKILL.md` | One child skill per directory. |
| `skills/thetis/<name>/references/*.md` | Reference tables beside the skill that links them. |
| `test/skills.test.js` | The checks below. |

## Tests

Run `node --test "packages/skills-thetis/test/*.test.js"` from the runtime root. No build, no dependency. The test checks every `SKILL.md`:

- The frontmatter is fenced by `---` lines. `name` and `description` are present.
- `name` equals the directory name. `description` is at most 1,024 bytes.
- The body is at most 400 lines. The universal body is at most 40 lines. At most one skill is universal.
- `metadata.tags` are at most 32 lowercase words. Every `metadata.related` id exists.
- Every relative link target exists inside the package.
- Every body ends with a `## Sources` list.
- No file uses a word or a character from the style deny-list in `test/skills.test.js`.

See docs/plans/skills.md in the runtime repository.

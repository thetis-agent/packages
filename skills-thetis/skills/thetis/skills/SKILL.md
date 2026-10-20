---
name: skills
description: The skill format, where skills come from, the loaders and their budget, the lint rules, and where a lesson goes. Use when you write a skill, ask why one is not found or what a field means, or decide where to keep something you learned.
metadata:
  title: Skills
  tags: [skills, skill, frontmatter, description, tags, universal, related, loader, fetch, search, retrieval, lint, references, project, budget, lessons, learned]
  related: [thetis/packages, thetis/projects, thetis/bench]
  version: 1
---
# Skills

A skill is a directory with a `SKILL.md`. A skill package is a package of type `skill` that declares `thetis.skills`, the directory that holds them. A loader is a package that puts skills in front of the model.

## The format

```
skills/
  concise/
    SKILL.md
  packages/
    SKILL.md              # the skill "packages"
    references/install.md # a resource: any file beside SKILL.md, one level deep
    forks/
      SKILL.md            # a child skill, id "packages/forks"
```

`SKILL.md` starts with YAML frontmatter between `---` lines.

| Field | Rule |
|---|---|
| `name` | Required. Equal to the directory name. Pattern `^[a-z0-9][a-z0-9-]{0,63}$`. |
| `description` | Required. What the skill does in one sentence of at most 160 characters, then when to use it; at most 400 characters in all is the guideline, 1,024 bytes the limit. |
| `metadata.title` | Optional display title. |
| `metadata.tags` | Optional. At most 32 lowercase words. Indexed. A tag `tool-group:<id>` admits that tool group when the skill is pinned or universal; see `thetis/using`. |
| `metadata.universal` | `"true"` puts the body in every prompt. At most 8 per person. |
| `metadata.related` | Optional ids. Never ranked on and not on the card; a UI may show them. |
| `metadata.version` | Optional integer. |
| `metadata.project` | Optional project id, `p_` and 8 hex digits. Only conversations of that project see the skill and its nested skills. Another value is a warning, and the skill is then seen everywhere. |

The body is everything after the frontmatter. It is markdown of at most 64 KiB. The id is the path under `skills/` with `/` between levels. The depth is at most 3. A skill may not be named `references`, `scripts`, or `assets`. A relative link in the body must resolve inside the skill's directory or the package.

## What retrieval sees

Retrieval indexes the name, the description, and the tags. It never indexes the body. Nothing in the body can make a skill retrievable. When a skill is not found, fix the frontmatter.

Write the description in two parts, terse. First say what the skill covers, in one sentence of at most 160 characters: that sentence is the brief, the one line every prompt carries. Then say when to use it, in the words a person or a model would use to ask; the card shows the first 160 characters of it, cut at a sentence end. Keep the whole description at or under 400 characters. Lists of names belong in the tags, which retrieval indexes and no prompt shows.

A card is three lines at most: the brief, `Use when:` cut to 160 characters, and `Nested:` with the last id segment of at most 8 children and a count of the rest.

## Sources of skills

Skills come from two places. A later source wins on an equal id.

1. Installed packages that declare `thetis.skills`. The value is a directory relative to the package root, usually `"skills"`. A package of type `skill` usually has nothing else. Any type may declare the directory.
2. Your own `skills/` directory under home.

A project can switch a skill off. `projects/<id>.json` has `skills.disable`, a list of ids. See `thetis/projects`.

A skill with `metadata.project` belongs to that project. A conversation of another project, or of no project, does not see it or its nested skills: they are not in the prompt, `skill_fetch` and `load_skill` refuse the id as unknown, and `skill_search` does not find them. The notes give one count, "N skills belong to other projects", and no ids. Lessons under `skills/lessons/p-<hex>/` use this.

## Write your own skill

1. Create `skills/<name>/SKILL.md` under home with `write_path`.
2. Write the frontmatter with `name` equal to `<name>` and a description with a "Use when" part.
3. Write the body. Put long reference material in `skills/<name>/references/<file>.md` and link it.
4. Fetch it with `skill_fetch` to check that it parses.

To ship a skill to other people, put the directory under `skills/` in a package with `"thetis": { "type": "skill", "skills": "skills" }`. Install the package. This package, `@thetis/skills-thetis`, is an example.

## Lint rules

A skill with an error is left out and named in the prompt's notes. A warning keeps the skill.

- The frontmatter must be fenced by `---` lines and must have `name` and `description`.
- `name` must equal the directory name and match the pattern.
- `description` must be at most 1,024 bytes. A first sentence over 160 characters, or a description over 400, is a warning.
- The body must be at most 64 KiB.
- `metadata.tags` must be at most 32 lowercase words.
- The id depth must be at most 3. A reserved directory name is not a skill.
- A relative link must resolve inside the skill's directory or the package.
- At most 8 universal skills per person.

## The library and the loaders

One library and three loaders ship: `@thetis/skills` and `skills-all`, `skills-l1`, `skills-hybrid`. Call `list_packages` to see which loader is installed.

The library `@thetis/skills` (type `skill-type`) parses, loads, lints, and ranks skills. It declares one tool that every loader shares:

| Tool | Arguments | Returns |
|---|---|---|
| `skill_fetch` | `id` (required), `file`, `offset` | The body of a skill, or one file beside it, in slices of 24,000 characters with `truncated` and `total`. |

The loaders:

| Loader | Mechanism | Own tool |
|---|---|---|
| `@thetis/skills-all` | Every body in the prompt until a byte budget (default 98,304) is spent. Universal first, then by id. | none |
| `@thetis/skills-l1` | A catalogue of one brief per top-level skill, then the universal bodies. | `load_skill({ name })`. It returns a body once per conversation. |
| `@thetis/skills-hybrid` | The briefs, the universal bodies, then cards of the skills retrieved for the first user message. The retrieval is pinned by content hash for the whole conversation. | `skill_search({ query, k })` for discovery later in the conversation. |

Every loader writes its state under `harness["@thetis/skills"]`: `{ loader, universal, pinned, loaded, catalogue, dropped, alwaysOn, notes }`.

## The always-on budget

Some text is in every prompt: the catalogue header, one brief per top-level skill, and the universal bodies. Each loader limits it. `skills-l1` and `skills-hybrid` read `alwaysOnBudget`, in characters, default 64,000. `skills-all` reads `budget`, in bytes, default 98,304, because all its bodies are always on.

Over the budget, the loader drops universal bodies first, from the last id back. Then it drops briefs from the end of the catalogue. A universal skill without its body is an ordinary skill: you can load, search, or fetch it. Each drop is in the notes and in the Skills panel. `alwaysOn` in the state has `{ budget, used, total, unit, dropped }`.

## What goes where

When you learn something that must last, put it in the first place on this list that fits it.

1. **The tool description.** The rule is about the arguments or the result of one tool. Change the description of that tool in its package.
2. **A script beside a skill.** The procedure is mechanical and the same each time. Put the script in `skills/<id>/scripts/`. In the body, say when to run it.
3. **A skill whose brief is its trigger.** The rule applies in a situation that you can recognise. Write the description as a situation, not a topic: "Use when a test fails and no code changed", not "Testing".
4. **A workflow check.** The rule is a step that a fixed sequence must not skip. Add a check to the workflow. See `@thetis/workflows`.
5. **A universal skill or the project instructions.** The rule applies to every conversation, or to every conversation of one project. Every turn pays for this text, so use it last.

Rules for the text:

- A body holds rules that you can check, not background to read. Each rule says what to do and how to see that it is done.
- Do not keep the facts of one task as durable text. A path, a version, a port, or a count from one conversation is a workspace fact. Label it as a workspace fact with the date, and verify it again before you use it.
- "No change" is a valid answer. If you learned nothing new, write nothing.

The retrieval runs once per conversation, on the first user message. It never runs again on later turns. A rerun would change the prompt prefix and lose the cache. Ask with `skill_search` when you need a skill the first message did not name.

## The bench

The loaders opt into `skill-recall@1` and `assembly-cost@1` with `peerGroup: "skills"`. The corpus comes from SkillRet. See `thetis/bench`.

## Sources

- packages/skills/README.md and packages/skills/lib/
- packages/skills-all/README.md, packages/skills-l1/README.md, packages/skills-hybrid/README.md
- packages/skills-thetis/README.md for the lint this package is held to

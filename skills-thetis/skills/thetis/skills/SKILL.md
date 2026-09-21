---
name: skills
description: The skill format Thetis uses (a directory with SKILL.md, YAML frontmatter with name, description, and metadata, a markdown body, references beside it, child skills below it), where skills come from (packages that declare thetis.skills, and the skills/ directory under your home), the loaders and their tools skill_fetch, load_skill, and skill_search, how to write a description that retrieval finds, the lint rules, and how a project switches a skill off. Use when you ask "how do I write a skill", "where do I put my own skill", "why is my skill not found", "what does skill_fetch return", or "what are the frontmatter fields".
metadata:
  title: Skills
  tags: [skills, skill, frontmatter, description, tags, universal, related, loader, fetch, search, retrieval, lint, references]
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
| `description` | Required. At most 1,024 bytes. What the skill does, then when to use it. |
| `metadata.title` | Optional display title. |
| `metadata.tags` | Optional. At most 32 lowercase words. Indexed. |
| `metadata.universal` | `"true"` puts the body in every prompt. At most 8 per person. |
| `metadata.related` | Optional ids. Never ranked on and not on the card; a UI may show them. |
| `metadata.version` | Optional integer. |

The body is everything after the frontmatter. It is markdown of at most 64 KiB. The id is the path under `skills/` with `/` between levels. The depth is at most 3. A skill may not be named `references`, `scripts`, or `assets`. A relative link in the body must resolve inside the skill's directory or the package.

## What retrieval sees

Retrieval indexes the name, the description, and the tags. It never indexes the body. Nothing in the body can make a skill retrievable. When a skill is not found, fix the frontmatter.

Write the description in two parts. First say what the skill covers. Then say when to use it, in the words a person or a model would use to ask. Name the questions it answers. Keep it under 1,024 bytes.

A brief is the id and the first sentence of the description, at most 160 characters. Put the most important words in the first sentence.

## Sources of skills

Skills come from two places. A later source wins on an equal id.

1. Installed packages that declare `thetis.skills`. The value is a directory relative to the package root, usually `"skills"`. A package of type `skill` usually has nothing else. Any type may declare the directory.
2. Your own `skills/` directory under home.

A project can switch a skill off. `projects/<id>.json` has `skills.disable`, a list of ids. See `thetis/projects`.

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
- `description` must be at most 1,024 bytes.
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
| `@thetis/skills-l1` | A catalogue of one brief per top-level skill, then the universal bodies. | `load_skill({ name })`, with an enum of the ids. It returns a body once per conversation. |
| `@thetis/skills-hybrid` | The briefs, the universal bodies, then cards of the skills retrieved for the first user message. The retrieval is pinned by content hash for the whole conversation. | `skill_search({ query, k })` for discovery later in the conversation. |

Every loader writes its state under `harness["@thetis/skills"]`: `{ loader, universal, pinned, loaded, catalogue, dropped, notes }`.

The retrieval runs once per conversation, on the first user message. It never runs again on later turns. A rerun would change the prompt prefix and lose the cache. Ask with `skill_search` when you need a skill the first message did not name.

## The bench

The loaders opt into `skill-recall@1` and `assembly-cost@1` with `peerGroup: "skills"`. The corpus comes from SkillRet. See `thetis/bench`.

## Sources

- packages/skills/README.md and packages/skills/src/
- packages/skills-all/README.md, packages/skills-l1/README.md, packages/skills-hybrid/README.md
- packages/skills-thetis/README.md for the lint this package is held to

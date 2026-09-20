# @thetis/skills

The skill format and the library behind every skill loader. A skill is a directory with a `SKILL.md` in the Agent Skills shape: YAML frontmatter with a name and a description, then a markdown body, with files and nested skills beside it. This package reads skills from installed packages and from the person's home, lints them, ranks them, and offers one tool, `skill_fetch`, so that every loader shares the same way of reading a skill in full. It is a `skill-type` package: plain ECMAScript, no build step, no dependencies, nothing runs at import. Loaders (`@thetis/skills-all`, `@thetis/skills-l1`, `@thetis/skills-hybrid`) import it the way `@thetis/ui-marketplace` imports `@thetis/marketplace`.

## What it provides

One tool, declared in `thetis.tools`:

| Tool | Arguments | Returns |
|---|---|---|
| `skill_fetch` | `id` (required), `file`, `offset` | The body of the skill, then `Skill directory:` and the files beside it; or one of those files. Slices of 24000 characters with a footer `[characters 1-24000 of 51234; read on with offset 24000]`. An unknown id is refused with the closest ids. A skill a project switched off is not there. |

The library, from `index.js`:

| Export | Does |
|---|---|
| `parseSkill(text, { id })` | Frontmatter and body to `{ id, name, description, title, tags, universal, related, version, body, contentHash, problems }`. `contentHash` is sha256 over name, description and tags: a body edit does not move it. |
| `loadSkills(env, packages)` | Every skill from every source (section below), deduplicated, sorted by id, each with `source: { package?, path, dir }`, `children` and `resources`. `packages` is `ctx.packages`, or the list from `env.kernel.packages.list()` in a tool. Parsing is cached per process by the mtime and size of each `SKILL.md`. |
| `lint(skills)` | `{ id, level: "error" \| "warning", message }` for every rule: the per-skill problems, more than 8 universal skills, a related id that names nothing, a child without a parent. |
| `excludedFor(env, session)` | The ids the session's project switched off (`projects/<id>.json` `skills.disable`, through `projects/sessions.json`), or an empty set. |
| `selectSkills(env, packages, session)` | What a loader works from: `{ all, skills, universal, excluded, problems, notes }`. A skill with an error is left out and named in `notes`; a switched-off parent takes its children; `universal` is capped at 8 by id. |
| `tokens`, `bm25Index(skills)`, `bm25Search(index, query, k)` | Okapi BM25, k1 1.2, b 0.75, over name, description and tags. Ties by id. Deterministic. |
| `fuse(dense, lexical, weight)` | Weighted reciprocal rank fusion, K 60, `weight` the dense share. |
| `absorb(skills, ranked)`, `promote(skills, ranked, limit)` | A child whose parent is in the pool is absorbed into the parent; the parent of a lone child is promoted at 0.99 of its score. |
| `closest(skills, name, n)` | The nearest ids to a misspelt name, for a tool's refusal. |
| `brief(skill)` | `` `id` (title) — first sentence of the description``, at most 160 characters of description. The title part appears only when `metadata.title` is set. |
| `card(skill)` | The brief, then `Use when:` the rest of the description, `Nested:` and `Related:`. |
| `renderBody(skill)` | The body, then `Skill directory:` and the files beside `SKILL.md`. |
| `fetchSkill(args, env)` | The tool. |
| `importCorpus(ctx, self)` | The bench importer every loader reuses. See Bench. |
| `claim(ctx, self, importRecord, claim)` | The `harness["@thetis/bench"]` spread of the reference arms. |
| `readMap(env)`, `corpusIds(map, ids)` | The corpus-to-skill id map the importer left, and skill ids back to corpus ids. |
| `STATE` | `"@thetis/skills"`, the harness key every loader writes its state under. |

## The format

```
skills/
  concise/
    SKILL.md
  packages/
    SKILL.md              # the skill "packages"
    references/install.md # a file beside it, one level deep
    forks/
      SKILL.md            # a nested skill, id "packages/forks"
```

`SKILL.md` starts with frontmatter between `---` lines. The frontmatter is a YAML subset read by a hand parser: `key: value` lines, one `metadata:` block indented by two spaces, `[a, b]` lists, `- item` lists, and quoted strings. A block scalar (`>` or `|`), an anchor, a flow map, or a value that spans lines is refused with an error, not guessed at.

| Field | Rule |
|---|---|
| `name` | Required. Equal to the directory name. `^[a-z0-9][a-z0-9-]{0,63}$`. |
| `description` | Required. At most 1024 bytes. What it does, then when to use it. This line and the name are all that retrieval sees. |
| `metadata.title` | Optional display title. Shown in the brief. |
| `metadata.tags` | Optional, at most 32 lowercase words. Indexed. |
| `metadata.universal` | `"true"` puts the body in every prompt. At most 8 per person. |
| `metadata.related` | Optional ids. Shown on the card, never ranked on. |
| `metadata.version` | Optional integer. |

The body is at most 64 KiB. The id is the path under `skills/` with `/` between levels, at most 3 deep. `references`, `scripts` and `assets` are not skill names. A relative link in the body that leaves the pack is a warning. An unknown key is a warning and is ignored.

Sources, in order, the later winning on an equal id:

1. Every installed package that declares `thetis.skills`, a directory relative to the package root (usually `"skills"`). A package of type `skill` usually has nothing else; any type may declare the directory.
2. The person's own `skills/` under the home. This is where the model writes a skill of its own with the file tools.

A project (`@thetis/projects`) switches skills off with `skills.disable` in `projects/<id>.json`; the library reads the session's project the way that package does and leaves those ids out, in the prompt and in `skill_fetch`.

## Bench

`importCorpus(ctx, self)` writes `bench/corpus.json` as `skills/<id>/SKILL.md` under the home, once per corpus sha256 (`bench/imported.json` is the marker), so a loader under the bench sees ordinary skills and nothing else. The corpus frontmatters use YAML the format does not read, so the frontmatter is generated from the record's fields and the text after the record's own frontmatter is kept verbatim, canary included. The skill id is the last segment of the record id; `metadata.title` is the corpus id, so a brief names the record and the bench can verify a catalogue claim by finding that id in the prompt. `bench/map.json` maps corpus ids to skill ids, and a loader's claim goes through it, because claims must name corpus ids.

## Configuration

`config.packages["@thetis/skills"]` has no keys. The package reads no environment variables. It writes nothing on an ordinary turn; under the bench it writes under `skills/` and `bench/` in the home.

## Limits

| Limit | Value |
|---|---|
| Description | 1024 bytes |
| Body | 64 KiB |
| Tags | 32 |
| Depth | 3 |
| Universal skills per person | 8 |
| Brief | 160 characters of description |
| `skill_fetch` slice | 24000 characters |

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: type `skill-type`, the `skill_fetch` tool. |
| `index.js` | The exports. |
| `lib/frontmatter.js` | The YAML-subset parser, `splitDocument`, `yamlString`. |
| `lib/skill.js` | `parseSkill`, `lint`, `brief`, `card`, `renderBody`, the limits. |
| `lib/load.js` | The sources, the walk, the cache, `excludedFor`, `selectSkills`. |
| `lib/rank.js` | BM25, fusion, absorb, promote, closest. |
| `lib/fetch.js` | The tool and the slice rule. |
| `lib/bench.js` | `importCorpus`, `claim`, the id map, `STATE`. |
| `scripts/convert-legacy.mjs` | The converter for legacy skill trees (last section). |

## Tests

`npm test` from the runtime root runs `test/frontmatter.test.js`, `test/skill.test.js`, `test/rank.test.js`, `test/load.test.js`, `test/bench.test.js` and `test/convert-legacy.test.js`, plain `node --test` files over temporary directories.
## Converting a legacy tree

`scripts/convert-legacy.mjs` brings a skill tree of the legacy Rust Thetis (TOML frontmatter with `name`, `brief`, `when_to_use`, `tags`, `related`, `children`, `status`, `version`; bodies linking other skills as `[text](skill:<id>)`) into this format. `node packages/skills/scripts/convert-legacy.mjs <legacy skill dir>... --out <skills dir> [--force]` copies each tree as `<out>/<id>` with its nested skills beneath it. In every `SKILL.md` the `name` becomes the directory name (refused when it is not a skill name), the `description` is `brief` and `when_to_use` joined and, when over 1024 bytes, cut at a sentence end with a warning, `metadata.title` is the legacy name, `metadata.tags` the first 32 tags lowercased with spaces and underscores as hyphens, `metadata.related` the related ids that exist in the converted set, `metadata.universal` `"true"` only when the legacy said so, and `metadata.version` the legacy version. A `status` other than active is noted with its `superseded_by` as the first body line. The body is otherwise verbatim: a link becomes `` `<id>` `` when its text is the id or its last segment, ``text (`<id>`)`` otherwise, and a link to a skill outside the converted set becomes its text with a warning. `children` is dropped (the subdirectories are the children) and `references/`, `scripts/` and `assets/` are copied as they are. The summary counts skills, resources, links rewritten and warnings; `--force` replaces an existing `<out>/<id>`. `test/convert-legacy.test.js` runs it over a fixture tree.

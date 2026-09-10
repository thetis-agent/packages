# skills-core

A content pack: a `skills/` directory, and an `index.ts` that answers with no
stages. It provides no names and requires nothing, so the runtime finds its
skills by the `/packages/skills-core@<version>` alias its selection mounts, not
by a registry entry (`lib/skills/index.ts`). The inert module exists only
because `lib/package-loader` still requires an `index.ts` in every package
directory and a `stages` object from it.

`skills/skill-creator` is ported from Anthropic's
[skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)
in the [anthropics/skills](https://github.com/anthropics/skills) repository,
taken from `main` on 2026-09-10. Upstream ships it under the Apache License
2.0, carried here as [LICENSE](LICENSE) and beside the skill itself as
`skills/skill-creator/LICENSE.txt`. The body and the bundled `agents/`,
`assets/`, `eval-viewer/`, `references/` and `scripts/` files are verbatim; the
only change is the YAML frontmatter, which gains the `metadata` block this
runtime's contract defines (`contracts/skills/schema.json`). It is deliberately
not `universal`: it is reached for when authoring a skill, not carried in every
prompt (design findings §8).

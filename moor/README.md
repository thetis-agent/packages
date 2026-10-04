# @bitmuse/moor

The mooR **server** as one skill tree: 37 skills and 3 references describing the
Rust MOO engine itself — the transactional object database, the compiler, the
bytecode VM, the task scheduler, and the daemon, host and worker processes.

Companion to `@bitmuse/torchship`, which describes one *world* that runs on this
server. The boundary is firm and worth keeping: if the question is "what does
this game do", read `torchship`; if it is "what does the engine do", read here.

## Layout

```
moor/                          the umbrella: the four ideas, the topic map
  storage-and-state/           objects, properties, verbs, transactions, conflict
  language-and-compiler/       parsing, compiling, decompiling, the value model, opcodes
  execution/                   the scheduler, the VM, builtins, permissions, command parsing
  services/                    RPC, the wire schema, hosts, telnet protocols, workers, the event log, the MCP host
  content-pipeline/            objdef, textdump, the bundled cores
  working-in-the-repo/         build, run, test, profile, ship, conventions
  references/
    crate-map.md               every crate, what it owns, which layer
    glossary.md                the vocabulary
    doc-drift.md               where mooR's own book disagrees with its code
```

## Provenance

Converted from the TOML-frontmatter skills at `/opt/thetis/skills/moor` by
`~/tools/convert-skills.py`. The transform was validated by running it against
the `torchship` originals and diffing the result with the already-converted
`@bitmuse/torchship` package: it reproduces all 66 of those skills
byte-for-byte, except one hand-written "Status: retired" note that no script
could infer.

What the conversion changed, and nothing else:

| From | To |
|---|---|
| TOML frontmatter | YAML frontmatter |
| `name = "The mooR task scheduler"` | `name: task-scheduler` (the directory name, as the format requires) plus `metadata.title` for the prose |
| `brief` + `when_to_use` | one `description` |
| `tags = ["conflict retry"]` | `metadata.tags: [conflict-retry]` — spaces, underscores and punctuation normalised |
| `children = "auto"` | dropped; nesting comes from the directory tree |
| `[text](skill:moor/execution)` | `` `moor/execution` `` — in references too, not just bodies |

Skill bodies are otherwise untouched. They name crates, modules and config keys
rather than reproducing source, so they age slowly — but `references/doc-drift.md`
exists because documentation does drift. Where a body names a path, confirm it
before depending on it.

## A note on the tools

These skills describe the engine; several of them assume an agent driving a live
MOO through `moo_*` tools. Those tools are **not** in this package — they are the
50 `moo-*` wasm components at `/opt/thetis/tools/`, not yet ported. Until they
are, treat any instruction to call `moo_eval` as context, not as something you
can do.

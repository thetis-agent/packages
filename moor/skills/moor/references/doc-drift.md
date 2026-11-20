# Where the mooR documentation disagrees with the code

First observed on 2026-08-29. Rechecked on 2026-11-18 against `v2.0-release` at
`e52638608` (version `2.0.0-dev`): fixed rows were removed, and new rows were added.
Each row was checked against the source at that date.

Use this list in one way only: as a warning that a specific document is not
authority on a specific point. Do not cite a row as a current defect without
checking it again. The project is active, and a row here is a good candidate to
have been fixed since.

When you find a new disagreement, the rule is the same one the whole library
follows: **the code is correct, the document is a claim**. Record the new row here,
and in the skill that owns the subject.

## The book

| Document | The claim | What the code does |
|---|---|---|
| `the-system/performance-and-concurrency.md` | Serializable isolation | Snapshot isolation with write-write conflict detection. Read sets are not tracked, so write skew is possible. `the-database/transactions.md` states this correctly in the same book. |
| `the-database/transactions.md`, `the-system/moo-tasks.md` | A conflicting task re-executes from the beginning | A retry restores the task from the state saved at its last transaction boundary. Only a task that never crossed one runs again in full. |
| `the-system/server-assumptions-about-the-database.md` | A restart always restores the previous state | The world-state batch writer does not request an fsync. An unclean stop can lose commits it had not reached. (Not fully rechecked in 2026-11; read `moor/storage-and-state` before you cite it.) |
| `the-system/server-assumptions-about-the-database.md` | Checkpoints can be written in two formats | Checkpoints are always objdef. The export-format option is deprecated, hidden, and ignored. |
| `the-system/server-assumptions-about-the-database.md` | The server-options table | It omits the garbage-collection interval, and does not say that the dump and collection intervals are read from the system object itself rather than from the server-options object. |
| `the-system/controlling-the-execution-of-tasks.md` | Tick and second limits below a floor are ignored | No floor exists. The scheduler config accepts any non-negative value. |
| `the-system/controlling-the-execution-of-tasks.md` | A queued-task limit raises a quota error on fork or suspend | Not implemented anywhere in the tree. |
| `the-moo-programming-language/task-permissions-and-capability-grants.md` | The list of grant kinds | It omits the object-listing grant, which the parser accepts and which gates object enumeration. |
| `the-built-in-command-parser.md` | Punctuation aliases are applied before the core's command hook | They are applied inside the default parser, which runs only after that hook declines. The hook sees the raw punctuation. |
| `the-database/moo-value-types.md` | The list of value kinds | It omits booleans, which exist and are enabled by default. |
| `the-database/flyweights.md` | Flyweights are garbage collected | They are reference counted. There is no cycle collector for them. |
| `the-system/objdef-file-format.md` | Run the migrate target | No core provides that target. |
| `the-system/server-architecture.md` | Single-process components talk over in-process ZeroMQ | `crates/server/src/main.rs` still defines `inproc://` endpoint strings, but the hosts reach the runtime through `LocalRuntimeClient` and `LocalEventBus`, not ZeroMQ. |
| `moor-architecture.md` | Module paths inside one daemon crate | The workspace was split into many crates. The chapter is right about the shape and wrong about the paths. |
| `single-process-deployment.md` (repository root) | The single-process binary lives in the daemon crate | It is in the server crate. |

## Design notes

The design notes under `doc/` were removed upstream (`doc/messaging.md` and
`doc/RPC_API_SPEC.md` in October 2026, `doc/TRACING.md` with the `trace_events`
feature). `doc/` now holds only README images. Do not look for them.

## Repository rules and READMEs

| Document | The claim | What the repository does |
|---|---|---|
| `AGENTS.md` (before October 2026) | Every file carries a GPLv3 header; the client is under `web-client/`; test the harness as `moot`; root npm scripts for test, lint and typecheck | The file was rewritten upstream and no longer makes these claims. Headers follow `.licensure.yml` (AGPL-3.0 by default), the client is under `clients/`, and the harness package is `moor-moot`. |
| `CONTRIBUTING.md` | `rust-toolchain.toml` selects Rust 1.98.1 | The version is right, but no `rust-toolchain.toml` exists. The workspace `rust-version`, CI and the Dockerfiles say 1.98.1. |
| `CONTRIBUTING.md` | Branches are `main` and `1.0`; beta tags come from `1.0` | `v2.0-release` is the release line and `main` is `2.1.0-dev`; 1.0 is unsupported. The README "Branch policy" and the release workflow (`v${major}.0-release`) agree. |
| `CONTRIBUTING.md` | GPLv3 headers; `crates/rpc/`; `web-client/`; `cargo test -p moot`; root `npm run lint`, `typecheck`, `test` | The same stale claims `AGENTS.md` dropped. See the row above. |
| `cores/cowbell/README.md` | Cowbell needs the `main` branch | It needs mooR 2.0: `v2.0-release` or later. |
| `cores/lambda-moor/README.md`, `cores/make/core.mk` | `make gen.moo-textdump` (and lambda-moor's `make output`) exports a textdump | The `core.mk` rule passes `--out-textdump` to `moorc`, which has no such option, so the target fails. |
| `deploy/README.md` | `npm run moor:traced`, `npm run full:dev-traced` | Those scripts are gone with the `trace_events` feature. |
| `deploy/clustered/*/docker-compose.yml` and READMEs, `book/src/the-system/docker-compose-setup.md` | Pull `ghcr.io/timbran-project/moor:latest` | The README says 2.0 has no container images yet, so that tag is not a 2.0 server. Build 2.0 from the branch. |
| `crates/kernel/testsuite/README.md` | Anonymous objects are unsupported | They exist behind a feature flag, with a collector. |

## Comments inside the source

| Where | The claim | What happens |
|---|---|---|
| The stored-program module | Decoding happens in the compiler crate | It happens in the schema crate. |
| The opcode-stream module | The program counter indexes the encoded word stream | At run time it indexes the decoded operation list. Jump labels are operation indices. |
| The database config | Settings for object-contents and object-children tables | Those relations no longer exist. Both are reverse lookups on secondary indexes. |
| The RPC client arguments | The two worker socket help strings | They describe the sockets the wrong way round, relative to the daemon's own flags and to actual use. |

## Stray artefacts

A generated schema file is tracked at a nested, duplicated path inside the schema
crate. Nothing includes it. It is the result of running the generator from the wrong
directory. Do not edit it and do not copy its path.

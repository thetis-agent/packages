---
name: working-in-the-repo
description: "Build, run, test and contribute to the mooR Rust workspace: which crate makes which binary, the checks CI enforces, and the rules a patch must satisfy. Use when the task is about the repository itself: compiling, starting a server locally, choosing a test to write, or a build that fails only in CI. Use it before you claim a change works. Not for how the database, the compiler, the VM or the RPC protocol behave, which are the other moor topics, and not for the Torchship database or Thetis's own internals."
metadata:
  title: Working in the mooR repository
  tags: [moor, build, cargo, workspace, test, clippy, rustfmt, dprint, ci, contributing, pull-request, rust, licence-headers, dependency-policy, commit-norms, branch-policy, v2-0-release, mootop, metrics]
  related: [moor/services/daemon-and-rpc]
  version: 2
---

# Working in the mooR repository

mooR is one Cargo workspace of Rust crates, plus an npm workspace of TypeScript
packages, plus MOO source trees under `cores/`. This skill and its children tell
you how to build it, how to run it, how to test it, and what a patch must satisfy
before it is acceptable.

`AGENTS.md` and `CONTRIBUTING.md` at the repository root are the project's own
statements of these rules. Read them. Where they disagree with the code or the
tooling, the code is right; the "Stale statements" table below lists the
disagreements found so far.

## Which child to read

- `moor/working-in-the-repo/build-and-run` — the build
  graph, crates to binaries, profiles, features, and every way to start a
  server. Reach for it to compile something or get a running system in front
  of you.
- `moor/working-in-the-repo/testing` — unit tests, `.moot`
  text tests, integration tests, and what CI gates. Reach for it to add a
  test, choose a test kind, or explain a failure.
- `moor/working-in-the-repo/conventions` — licence
  headers, formatting, clippy, dependency policy, and commit norms. Reach
  for it before writing or submitting a change.
- `moor/working-in-the-repo/repo-tooling` — `tools/`,
  `scripts/`, bacon, dprint, licensure, the book, the schema generators.
  Reach for it when you need a tool and do not know which one.
- `moor/working-in-the-repo/performance-and-profiling`
  — the benches, `perf`, `mootop`, the metrics file and runtime counters. Reach for it
  when a change is meant to be faster, or something is slow.
- `moor/working-in-the-repo/deployment-and-release`
  — `deploy/`, the Dockerfiles, the release workflow, version skew between
  processes, and operator facts. Reach for it when you touch a compose file, a
  manifest, or must plan a real deployment.

## Facts every contributor needs

**The branch decides the version.** `v2.0-release` is the 2.0 line (version
`2.0.0-dev`, code freeze, the branch for new users and the one this skill tree
describes). `main` is `2.1.0-dev`. Fixes land on `main` first and are
cherry-picked. The README "Branch policy" section is the current statement.

**The workspace is the unit.** Every crate lives under `crates/`, `tools/` or
`cores/tools/` and is a member of the root `Cargo.toml`. Crate directory names drop the `moor-`
prefix that the package names carry: the directory `crates/kernel` holds the
package `moor-kernel`. Use the package name with `-p`.

**Dependency versions live in one place.** The root `Cargo.toml` declares every
third-party version under `[workspace.dependencies]`. A member crate inherits
with `.workspace = true`. Never write a version number in a member manifest; the
three that exist (`conventions` names them) are exceptions, not a model.

**Rust version and toolchain.** The workspace `rust-version` in the root
`Cargo.toml` (1.98.1) is the authority; CI and every Dockerfile use exactly that
toolchain. There is no `rust-toolchain.toml`. Stable Rust
builds everything. The nightly toolchain is used for one purpose only:
formatting. Edition is 2024.

**There are two deployment shapes, and both are supported.** A single `moor`
binary runs the runtime and the hosts in one process. A split deployment runs
`moor-daemon` plus separate host and worker processes that speak ZeroMQ and
FlatBuffers. The single process is the default for development. `build-and-run`
explains both. In the split shape, every process must come from the same version:
the 2.0 RPC schema is not compatible with older hosts.

**Five gates decide whether a change is acceptable.** They are, in the order CI
runs them: the workspace builds, the workspace tests pass, formatting matches,
clippy is clean with warnings denied, and every tracked file carries the right
licence header. Other CI jobs also check the web workspace, the Cowbell core,
Elle histories, deployment files and dependencies. `conventions` gives each gate
and its command.

**The book is part of the change.** `book/` is the user documentation. A change
to user-visible behaviour updates the book in the same pull request.

## Rules the project states about a coding partner

`AGENTS.md` addresses an AI coding partner directly. These are not suggestions.

1. **Ask before a large change.** You are a coding partner, not an independent
   agent. The human decides. Propose the shape of a large change and get
   agreement before you write it.
2. **Do not run git commands unless asked.** No commits, no branches, no
   rebases, no pushes, unless the human asked for that specific action.
3. **Do not write marketing language.** Not in code, not in comments, not in
   commit messages, not in replies. `AGENTS.md` asks for factual language with no
   praise, marketing claims or filler.
4. **Do not write legacy-compatibility scaffolding.** Migration shims and
   "legacy bridge" paths are not wanted; change the thing. LambdaMOO behaviour is
   a product requirement, not scaffolding.
5. **Write your own commit messages and pull-request descriptions.**
   `CONTRIBUTING.md` asks that these are not machine-generated.

## Stale statements in the project's own documents

These documents are still the right statement of intent. These specific details
have drifted. Verify a path or a command before you follow it.

| Document says | Repository has |
|---|---|
| The web client is in `web-client/` | The web client is `clients/meadow`; other clients and the browser SDK are also under `clients/` |
| `crates/rpc/` holds the RPC crates | The wire and transport crates are `crates/schema`, `crates/runtime-api` and `crates/zmq-client` |
| `cargo test -p moot` | The package is `moor-moot`; the `.moot` suites run under `moor-kernel` and `moor-telnet-host` |
| Source files carry a GPLv3 header | The default header is AGPL-3.0; `.licensure.yml` assigns LGPL to the schema and browser SDK and GPL to the Meadow client |
| `single-process-deployment.md` (repository root): the `moor` binary is at `crates/daemon/src/bin/moor.rs` | It is the `moor-server` crate, `crates/server` |
| `npm run test`, `npm run lint`, `npm run typecheck` at the root | The root exposes `web:typecheck`, `format:check`, `test:mcp` and `test:changes`; `lint` is a per-package script |
| `CONTRIBUTING.md`: `rust-toolchain.toml` selects Rust 1.98.1 | No `rust-toolchain.toml` exists. Install 1.98.1 with rustup |
| `CONTRIBUTING.md`: branches are `main` and `1.0` | `v2.0-release` is the release line and `main` is 2.1 development; 1.0 is unsupported. See the README |
| `deploy/README.md`: `npm run moor:traced`, `npm run full:dev-traced` | Those scripts and the `trace_events` feature are gone |
| `cores/cowbell/README.md`: Cowbell needs the `main` branch | It needs mooR 2.0: `v2.0-release` or later |

## Knowledge barriers

Before a first change lands, you must understand these. Each has a source.

| You must understand | Learn it from |
|---|---|
| What the workspace builds and what a running system is, as processes | `build-and-run` |
| Which test kind fits the change you made | `testing` |
| The five gates and the style rules | `conventions` |
| How to prove a change made something faster | `performance-and-profiling` |
| Why a deployment file you edited failed CI | `deployment-and-release` |
| The transaction model, if you touch `crates/db` or `crates/kernel` | `moor/storage-and-state/transactions` |
| The task and verb execution model, if you touch scheduling or the VM | `moor/execution/task-scheduler` |
| The FlatBuffers wire contract, if you touch any message between processes | `moor/services/wire-schema` |
| How a database is imported and bootstrapped, if you touch startup or cores | `moor/content-pipeline/cores-and-bootstrap` |
| How to add a builtin function | `crates/kernel/src/vm/builtins/ADDING-BUILTINS.md` in the repository |

## Read first / read next

Read `AGENTS.md` and `CONTRIBUTING.md` in the repository before your first
change. Then read the child that matches your task. If you do not know which
area of the system your change touches, read the root `moor` skill first and let
it route you.

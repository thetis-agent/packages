---
name: repo-tooling
description: "What each tool in tools/ and scripts/ is for and who needs it: moorc, moor-emh, mootop, moor-loadsim, bacon, scripts/dev.sh, the perf scripts, the book, and the schema generators. Use when you need a tool and do not know which: compiling a MOO source tree offline, inspecting a database without a server, watching files and restarting, or generating FlatBuffers or documentation. Use it also to know which tools must be installed before a first change. Not for choosing a build or a test, and not for the Torchship database or Thetis's own internals."
metadata:
  title: mooR repository tooling
  tags: [moor, tools, moorc, moor-emh, mootop, moor-loadsim, bacon, dev-sh, dprint, licensure, gitlint, cargo-deny, mdbook, perf, profiling, flatc, planus, scripts, editor, watching-files, api-reference-documentation, moot-syntax-support]
  related: [moor/services/wire-schema, moor/content-pipeline/objdef-format]
  version: 2
---

# mooR repository tooling

The repository ships two kinds of tool: programs built from the workspace, and
external programs the project expects you to install. This skill says what each
is for and who needs it, so that you install four things rather than twenty.

## Install before your first change

| Tool | Why | How |
|---|---|---|
| Rust 1.98.1 | Everything builds on it | `rustup`. The version is `rust-version` in the root `Cargo.toml`. There is no `rust-toolchain.toml`, so select it yourself |
| The nightly toolchain, rustfmt component only | Formatting uses nightly-only import options | `rustup toolchain install nightly` |
| `dprint` | Formats JSON, TOML, Markdown, TypeScript and Dockerfiles | It is an npm dev dependency, so `npx dprint` works after `npm ci` |
| `licensure` | Checks and writes licence headers | `cargo install licensure --version 0.8.1 --locked`, the CI version |
| Node.js and npm | The browser client, the TypeScript schema bindings, the formatting check | Any recent LTS |

Install when the task needs them, not before: `bacon`, `flatc`, `planus`,
`mdbook` and its plugins, Docker, `perf`, `bpftrace` (for `mootop`), `cargo-deny`,
and `gitlint-core==0.19.1` for the commit hook (`scripts/install-commit-hook.sh`).

There is no Nix flake and no `direnv` file now; both were removed.

## Tools built from the workspace

### `moorc` — the offline compiler and test runner

`moorc` compiles MOO source without a server. It reads either an objdef
directory tree or a textdump file, and writes an objdef directory. It is the
tool that validates a core: if `moorc` compiles a core cleanly, the core's
source is well formed.

It is also a test runner, and this is why it matters beyond compilation. It can
run every verb whose name begins with `test_` in the compiled database, filtered
by object or by verb, with a per-test timeout. It can also run `.moot` files
against the compiled database, from a directory or a glob. This is how the
Cowbell core's own test suite runs, driven by its Makefile, and it is what CI
runs for that core.

Who needs it: anyone changing a core, anyone changing the compiler, anyone
importing a LambdaMOO or ToastStunt database. It has a flag to continue past
verbs that fail to compile, which is how a foreign database is brought in for
inspection. Run it with `--help` for the current flag set rather than trusting a
list here.

### `moor-emh` — the offline database console

An interactive console over a database directory, with no daemon and no network.
It opens the store, starts a scheduler, and gives you a line editor in which to
evaluate MOO. It takes a lock on the database, so it is for a database nothing
else is serving.

Its commands include `get`, `set`, `props`, `verbs`, `prog`, `list`, `dump`,
`export`, `load`, `reload` and `su`. `load` and `reload` take the same options as
the builtins; see `moor/content-pipeline/objdef-format`.

Who needs it: anyone who must inspect or repair a database that will not boot,
or who wants to evaluate against a database without bringing a server up.

### `mootop` — the live CPU view

`tools/mootop` attaches `bpftrace` to the daemon's USDT probes and shows CPU by
verb, builtin and task, beside the daemon's metrics. It has `record` and `report`
subcommands. It needs root or the bpftrace capabilities. It is not in the default
build: `cargo build --release -p mootop`. See
`moor/working-in-the-repo/performance-and-profiling`.

### `moor-loadsim` — what players see under load

`tools/moor-loadsim` starts its own daemon and telnet host on a temporary database,
runs a simulated load scenario, and reports dropped sessions and command latency.
It never attaches to an existing server, because scenarios overwrite verbs such as
`do_login_command`. It is not in the default build.

### Load and consistency binaries

`crates/testing/load-tools` builds under the package name `moor-model-checker`
and produces many binaries: Jepsen-style workload generators that write EDN
histories for the external Elle checker, and several load and benchmark drivers
for verb dispatch, property updates, opcodes, the scheduler and suspend-resume.
The binary list is the `[[bin]]` sections of its `Cargo.toml`; read those rather
than a list here. Its own `README.md` and the shell scripts beside it explain
the Elle workflow. `crates/testing/edn` (`moor-edn`) is the small EDN reader and
writer they use. See `moor/working-in-the-repo/testing`.

### Core tools

`cores/tools/session-runner` (`core-session-runner`) runs `.moot` scenarios and
executable Markdown against an imported core, with one mock session per player.
`cores/tools/style-audit` (`core-style-audit`) checks core source style. The core
makefiles build and run both.

The old `lambdamoo-harness` crate is gone. To compare with the real LambdaMOO,
run `moor-moot`'s ignored `moot_lmoo` test against a LambdaMOO 1.8.1 binary
(`MOOT_MOO_PATH`).

## Non-Rust tools in `tools/`

| Path | What it is | Who needs it |
|---|---|---|
| `tools/generate-api-docs.py` | Reads the web host's OpenAPI specification and writes the HTTP API reference page of the book | Anyone changing a web host route. Needs PyYAML |
| `tools/moo-mode.el` | Emacs major mode for MOO files: syntax highlighting and indentation | Emacs users editing `.moo` files |
| `tools/moot-lang/` | A Visual Studio Code extension that highlights `.moot` files | Anyone writing many moot tests in that editor |
| `tools/moot-translate.awk` | A one-way helper that rewrites Ruby test files from the Stunt suite towards moot syntax | Anyone porting another Stunt regression file. It gets most lines right and leaves the rest to you |
| `tools/perf/` | Shell wrappers around Linux `perf`, and the activation profiling binary they drive. `activation-bench-breakdown.sh` splits the activation bench by phase | Anyone investigating a performance regression on Linux. `moor/working-in-the-repo/performance-and-profiling` explains what they produce |
| `tools/example-python-worker/` | A worker implemented in Python, over the same FlatBuffers and ZeroMQ protocol the Rust workers use | Anyone writing a worker in another language, or checking that the worker protocol is genuinely language-neutral |

The API reference page is generated. Do not hand-edit it; change the OpenAPI
specification and re-run the generator.

## `scripts/`

Thin wrappers that supply the correct arguments so you do not have to remember
them.

| Script | Does |
|---|---|
| `scripts/format-rust.sh` | Runs nightly rustfmt with the project's three import options. Takes `--check`. **Use this, not plain `cargo fmt`** |
| `scripts/licensure-project.sh` | Runs licensure over git-tracked files only, so untracked and generated files are left alone |
| `scripts/dev.sh` | The native development stack: daemon, web host and Meadow under Vite, optional telnet host and workers, Cowbell with Git baselines. Ctrl-C stops all |
| `scripts/daemon.sh` | Runs `moor-daemon` with a data directory, a core (default lambda-moor), an export path and a checkpoint interval. Has `--debug`, `--release` and `--clean-slate`, and reads several environment variables |
| `scripts/telnet.sh`, `scripts/web.sh`, `scripts/curl-worker.sh`, `scripts/git-worker.sh` | The matching host and worker launchers |
| `scripts/start-moor-lambdacore.sh`, `scripts/start-moor-cowbell.sh` | Start the Docker Compose stack against one specific core |
| `scripts/install-commit-hook.sh` | Installs the gitlint commit-message hook, using `scripts/gitlint.cfg` |

## External development tools

### `bacon` — watch and restart

`bacon.toml` defines named jobs. The default job, `moor`, runs the single `moor`
binary against the development configuration. Other jobs run the daemon in
release or debug, the telnet host with and without TLS, the web host, the curl
worker, and the test suite. There is no traced job now. Read `bacon.toml` for the current job
list; it changes more often than this skill.

Use bacon when you are iterating on one component and want it rebuilt and
restarted on every save.

### `scripts/dev.sh` — the split stack without containers

`scripts/dev.sh` replaced the removed `process-compose` files. It builds and starts
the daemon, the web host and the Meadow dev server as separate processes over IPC
sockets, and with `--telnet`, `--curl-worker` and `--git-worker` the other
processes too. If one service exits, the others stop. `--clean` wipes the data
directory for a fresh import.

Use it when the thing you changed lives on the boundary between processes. It is
the cheapest way to exercise the real ZeroMQ path.

### Docker

`Dockerfile` at the root builds the frontend in a Node stage and the Rust
binaries in a Rust stage, then assembles a slim runtime image with `moor`, the
daemon, the hosts and the curl, file and git workers. Build arguments select the
cargo profile, the job count and extra cargo flags. `docker-compose.yml` runs the
single-process image plus the frontend in nginx.
`Dockerfile.elle` builds the consistency-check environment.
`Dockerfile.arm64-cross` cross-builds for arm64.

`deploy/` holds the deployment examples rather than development stacks. CI
renders every one of those manifests on each push, so a syntax error there fails
the build even though nothing was deployed. `moor/working-in-the-repo/deployment-and-release`
owns that whole area.

### The book

`book/` is an mdBook. `book/install-tools.sh` installs mdBook and the two
plugins the book uses, at the versions the book expects; run it before building
the book. `book/build-single-page.sh` produces a single PDF through pandoc.

Edit `book/src/` and add the page to `book/src/SUMMARY.md`, or it will not
appear. A change to user-visible behaviour must update the book in the same pull
request; see `moor/working-in-the-repo/conventions`.

### The schema generators

FlatBuffers bindings are generated by two different tools, and the two have
different lifecycles.

| Target | Generator | Committed? |
|---|---|---|
| Rust | `planus` | Yes. Regenerate and commit the generated file with the schema change |
| TypeScript | `flatc`, driven by an npm script | No. Built on demand; set `MOOR_FLATC` if `flatc` is not on the path |

Because the Rust side is committed, a `.fbs` edit alone changes nothing that
cargo can see. `moor/services/wire-schema` covers the
schema itself and the compatibility rules a change must respect.

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| Formatting still fails after `cargo fmt` | Stable rustfmt ignores the project's import options | Run `scripts/format-rust.sh` |
| `scripts/format-rust.sh` reports no nightly toolchain | Nightly is not installed | Install it with the rustfmt component. It is used for nothing else |
| Licensure rewrites files you did not touch | It ran over the whole tree | Use `scripts/licensure-project.sh` |
| The header check disagrees with your local licensure | Version drift | Match the version CI installs |
| `npm run schema:build` cannot find `flatc` | The FlatBuffers compiler is missing | Install it, or set `MOOR_FLATC` to its absolute path |
| A `.fbs` change has no effect on the Rust build | Rust bindings are committed, not generated at build time | Regenerate with planus and commit the result |
| The book build fails on a missing preprocessor | mdBook plugins are not installed | Run `book/install-tools.sh` |
| The API reference page reverts your edit | That page is generated | Edit the OpenAPI specification and re-run the generator |
| A `perf` script refuses to record | The kernel blocks access to performance counters | The script reports which setting to change. See `moor/working-in-the-repo/performance-and-profiling` |
| A launcher starts the wrong world | `scripts/daemon.sh` and the bacon `daemon` job import lambda-moor; `scripts/dev.sh`, npm and the default bacon job import Cowbell | Check which core each launcher imports before you compare behaviour |
| `mootop` cannot attach | Not root, or bpftrace is missing | See `moor/working-in-the-repo/performance-and-profiling` |
| The commit hook rejects a message | `scripts/gitlint.cfg` rules: type, 50/70 limits, body | Rewrite the message. A fixup commit passes and is folded later |

## Read first / read next

Read `moor/working-in-the-repo/build-and-run` for which
launcher to reach for first, and `moor/working-in-the-repo/conventions`
for the gates these tools enforce. Read `moor/working-in-the-repo/performance-and-profiling`
before using the perf scripts, and `moor/working-in-the-repo/deployment-and-release`
before changing anything under `deploy/`. Read
`moor/content-pipeline/objdef-format` before using
`moorc` on a source tree, and `moor/services/wire-schema`
before regenerating bindings.

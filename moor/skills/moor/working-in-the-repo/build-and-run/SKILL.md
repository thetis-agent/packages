---
name: build-and-run
description: "Compile the mooR workspace and get a server up: which crate makes which binary, cargo profiles and features, and the ways to start daemon, hosts and workers. Use when you must compile mooR, pick the right build for the area you changed, or bring a server up locally with telnet and web access. Use it when a build is slow, the stack will not start, or the database will not import. Not for choosing or writing tests, or style and pull-request norms, and not for the Torchship database or Thetis's own internals."
metadata:
  title: Building and running mooR
  tags: [moor, build, cargo, run, daemon, telnet-host, web-host, git-worker, docker, dev-sh, bacon, binaries, profiles, release-check, startup]
  related: [moor/services/daemon-and-rpc, moor/content-pipeline/cores-and-bootstrap]
  version: 2
---

# Building and running mooR

The workspace compiles a small set of binaries. Most of the code is in
libraries; the binaries are thin. Knowing which library your change is in tells
you which binary must be rebuilt and which loop is fastest.

## The build graph

Libraries, in dependency order. Each depends on those above it.

| Crate | Package | Responsibility |
|---|---|---|
| `crates/var` | `moor-var` | MOO value types, symbols, errors |
| `crates/common` | `moor-common` | Object model, world-state interfaces, command matching, shared utilities |
| `crates/compiler` | `moor-compiler` | MOO grammar, parser, code generation, decompiler and unparser |
| `crates/vm` | `moor-vm` | Execution core: frames, activations, unwinding. No scheduler and no host |
| `crates/db` | `moor-db` | The transactional object store |
| `crates/kernel` | `moor-kernel` | Task scheduler, builtin functions, the wiring of VM to database |
| `crates/objdef`, `crates/textdump` | `moor-objdef`, `moor-textdump` | Import and export formats |
| `crates/schema` | `moor-schema` | FlatBuffers types and conversions for wire and persistence |
| `crates/native-verb` | `moor-native-verb` | The C ABI between the daemon and native verb libraries, with helpers for writing them. No workspace dependencies; the kernel uses it |
| `crates/runtime-api` | `moor-runtime-api` | Typed runtime and worker API, shared message types |
| `crates/zmq-client` | `moor-zmq-client` | The ZeroMQ transport that implements that API |
| `crates/daemon` | `moor-daemon` | The runtime assembly: database, scheduler, connections, event log, RPC server |

Binary-producing crates.

| Crate | Binary | What it is |
|---|---|---|
| `crates/server` | `moor` | The single process. Runtime plus telnet host plus web host plus selected embedded workers |
| `crates/daemon` | `moor-daemon` | The split-process runtime. No player-facing protocol |
| `crates/telnet-host` | `moor-telnet-host` | Line-oriented TCP and telnet, optionally TLS |
| `crates/web-host` | `moor-web-host` | HTTP, WebSocket and WebRTC, plus the web APIs |
| `crates/curl-worker` | `moor-curl-worker` | Outbound HTTP on behalf of the world |
| `crates/file-worker` | `moor-file-worker` | File access on behalf of the world |
| `crates/git-worker` | `moor-git-worker` | Read-only Git repository access on behalf of the world |
| `tools/moorc` | `moorc` | Offline compiler and test runner |
| `tools/moor-emh` | `moor-emh` | Offline database console |
| `tools/mootop` | `mootop` | Live CPU view of a running daemon, by verb, builtin and task |
| `tools/moor-loadsim` | `moor-loadsim` | Simulated player loads against a throwaway daemon and telnet host |

Members for tests and core tooling: `crates/testing/moot` (`moor-moot`, the
text-test harness), `crates/testing/load-tools` (`moor-model-checker`, which
produces many load and consistency binaries), `crates/testing/edn` (`moor-edn`,
the EDN subset for Elle histories), and `cores/tools/session-runner` and
`cores/tools/style-audit`, used by the core makefiles. The MCP server is no longer
a Rust crate: it is the TypeScript client `clients/moor-web-mcp`.

The build graph explains the cost of a change. An edit in `moor-var` rebuilds
everything. An edit in `moor-web-host` rebuilds one binary.

## The fastest correct loop, by area

| You changed | Fastest loop | Before you claim it works |
|---|---|---|
| `var`, `common`, `compiler`, `vm` | `cargo test -p <package>` | `cargo test --workspace`, because these are under everything |
| `db` | `cargo test -p moor-db` | Add `cargo test -p moor-kernel`; the kernel suites exercise the store hardest |
| `kernel` | `cargo test -p moor-kernel --test moot-suite` | The full `-p moor-kernel` run, then the workspace |
| `daemon`, `runtime-api`, `zmq-client` | `cargo test -p moor-daemon` | `cargo test -p moor-telnet-host`, which starts a real daemon |
| `telnet-host`, `web-host` | `cargo test -p <package>`, then run the stack | Start `moor` and connect for real |
| `schema` (`.fbs` files) | Regenerate bindings, then `cargo build --workspace` | Also `npm run schema:build`; see `moor/services/wire-schema` |
| `clients/meadow` | `npm run meadow:dev` | `npm run web:build` and `npm run web:typecheck` |
| `cores/cowbell` | `make -C cores/cowbell` | `make -C cores/cowbell test` |

## Build commands

`cargo build` with no arguments builds the workspace `default-members`. That set
leaves out the proc-macro helper crates, `moor-native-verb`, `mootop`,
`moor-loadsim` and the `cores/tools` crates. Use it as the everyday build.

`cargo build --workspace` builds everything. CI runs
`cargo build --workspace --all-features --all-targets` with no exclusions, on Rust
1.98.1, the workspace `rust-version`. There is no `rust-toolchain.toml`.

`cargo build -p <package>` is the tight loop. Prefer it.

### Profiles

| Profile | Purpose |
|---|---|
| `dev` (default) | Development. Fast to compile, slow to run |
| `release` | Single codegen unit, fat LTO, full debug info. Slow to build, fastest to run, and profilable |
| `release-fast` | Inherits `release` with thin LTO, default parallelism and no debug info. For packaging and container builds where build time matters. The default of `docker-compose.yml` |
| `release-check` | Inherits `release` with no LTO, incremental builds and no debug info. The core makefiles build `moorc` with it (`MOORC_PROFILE`) |

Never benchmark or measure a performance claim on a `dev` build. The `release`
profile keeps debug information on purpose so that a profiler can attribute
time; that is why release binaries are large. `moor/working-in-the-repo/performance-and-profiling`
owns how to measure.

### Features

Feature flags are few and none changes the server. The `trace_events` feature
was removed; the USDT probes that `mootop` reads are always compiled in. The
remaining features are small: `json` on `moor-var`, `task-client` on
`moor-runtime-api`, `colors` on `moor-moot`. Consult a crate's `Cargo.toml` for
its current feature list rather than trusting a written list here.

### Build inputs that are not source

The `moor-common` build script reads the git checkout to stamp a version and a
commit hash into every binary. A build from a source tree with no `.git`
directory can fail or produce an unstamped binary. The Dockerfile copies `.git`
into the build stage for this reason. That stamp is what a bug report is asked
to quote from the daemon's first log line.

FlatBuffers Rust bindings are generated ahead of time and committed. A `.fbs`
change is not picked up by `cargo build`; you must regenerate. The TypeScript
bindings are generated at npm build time and need the `flatc` compiler on the
path.

## Bringing a system up

Reach for the first row first.

| Way | Command | What it is for |
|---|---|---|
| Native split stack | `scripts/dev.sh` | Daemon, web host and Meadow under Vite, with `--telnet`, `--curl-worker`, `--git-worker` as options. Imports Cowbell with Git baselines (`--git-upstream`, default `origin/main`). Ctrl-C stops all |
| Single process, from cargo | `npm run moor:dev` | One `moor` process, telnet and web, importing the Cowbell core, with the curl and git workers |
| Single process plus web client | `npm run full:dev` (also `npm run dev`) | Adds the Meadow dev server with hot reload. Use when you touch the browser client |
| File-watching restart | `bacon` (default job `moor`), or `bacon daemon`, `bacon telnet`, `bacon web` | Rebuild and restart on every save. Use when iterating on one host |
| Split processes, one at a time | `scripts/daemon.sh`, `scripts/telnet.sh`, `scripts/web.sh`, `scripts/curl-worker.sh`, `scripts/git-worker.sh` | Exercises the real ZeroMQ path between daemon, hosts and workers |
| Containers | `scripts/start-moor-cowbell.sh` or `docker compose up` | A container image close to what is released. The README route for new users |
| Deployment examples | The trees under `deploy/` | Clustered, Kubernetes, Debian package and TLS shapes. Not a development loop; see `moor/working-in-the-repo/deployment-and-release` |

`npm run moor:dev` and the default `bacon` job run nearly the same thing: the
`moor` binary against `moor-dev.yaml`, importing `cores/cowbell/src` in `objdef`
format, with a generated key pair and the curl worker. `moor:dev` also enables the
git worker. `moor-dev.yaml`
is the checked-in development configuration and turns on the newer language
features. Override the config with the `MOOR_CONFIG` environment variable and
the core with `MOOR_CORE`.

`scripts/daemon.sh` and the bacon `daemon` job import `cores/lambda-moor/src`
instead, which is the reconstituted LambdaCore. The `process-compose` files are
gone; `scripts/dev.sh` replaced them. The two cores behave very
differently; know which one you started.

### What a running system is, as processes

In the single-process shape there is exactly one operating-system process. Its
internal boundaries are the same ones the split shape has: hosts talk to a
runtime through a typed in-process client rather than through ZeroMQ. Sessions,
authentication and connection semantics are identical. This is deliberate, so
that a bug found in one shape is a bug in both.

In the split shape there are four or more processes:

| Process | Role |
|---|---|
| `moor-daemon` | Owns the database, the scheduler, the VM, connections, the event log, host enrolment and worker routing. Serves RPC |
| `moor-telnet-host` | Accepts telnet clients. Talks request and reply plus subscribe to the daemon |
| `moor-web-host` | Accepts HTTP, WebSocket and WebRTC clients. Same two channels |
| `moor-curl-worker`, `moor-file-worker`, `moor-git-worker` | Perform outbound effects the world asks for. Subscribe for requests, reply over their own channel |
| Meadow (a static bundle, served by nginx or Vite) | The browser client. Not a server process |

Hosts and workers may come and go while the daemon stays up. That is the point
of the split. `moor/services/daemon-and-rpc` explains the
enrolment and authentication that makes it safe.

### Persistent state on disk

The data directory, `moor-data` by default, holds the database. The `--db` value
names the database inside it. The import runs only when the database does not
yet exist. To force a fresh import, delete the data directory; `scripts/daemon.sh
--clean-slate` does that for you.

The key pair signs session tokens. `--generate-keypair` creates it on first run
if it is absent. Generated keys and exports must not appear in a diff.

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| The build succeeds locally and fails in CI | Local toolchain is newer, or a feature combination is untested locally | CI builds with `--all-features --all-targets` on Rust 1.98.1. Reproduce with those flags before you look further |
| Everything rebuilds after a one-line edit | The edit was in `moor-var` or `moor-common` | Expected. Work in the leaf crate and its tests, and pay the full rebuild once |
| A `.fbs` edit changes nothing | Rust bindings are committed, not generated by `build.rs` | Regenerate the bindings and commit them. See `moor/services/wire-schema` |
| The npm build fails looking for `flatc` | The FlatBuffers compiler is missing | Install it, or set `MOOR_FLATC` to its absolute path |
| The server starts but the world is empty or wrong | The data directory already existed, so the import was skipped | Delete the data directory and start again |
| The server starts with unexpected verbs or objects | You imported a different core than you expected | Check `MOOR_CORE`, `moor-dev.yaml` and which launcher you used |
| A host cannot reach the daemon | Socket addresses do not match | The launchers agree on IPC socket paths. If you started processes by hand, the RPC and events addresses must be given to both sides |
| A host enrols but every request fails to decode | Host and daemon are from different versions. The RPC schema changed without compatibility (f50464d59) | Build and run every process from one commit |
| A container build takes very long | The compose default is `release-fast`, an optimising build | Pass `--debug` to the start script, or use a cargo-based launcher instead |
| A performance number looks wrong | You measured a `dev` build | Rebuild with `--release` and measure again. See `moor/working-in-the-repo/performance-and-profiling` |

## Read first / read next

Read `moor/working-in-the-repo/repo-tooling` for what
`bacon`, `scripts/dev.sh`, `moorc` and the other `scripts/` wrappers actually are.
Read `moor/working-in-the-repo/testing` before you assert that a
change works, and `moor/working-in-the-repo/performance-and-profiling`
if the claim is about speed. Read
`moor/working-in-the-repo/deployment-and-release`
for the container and package shapes, and
`moor/content-pipeline/cores-and-bootstrap` before
you change import or startup behaviour.

## Verify this still holds

```
cargo build -p moor-server
npm run moor:dev
```

The server logs its version and commit stamp on the first line; if that line
is missing or unstamped, the `.git` directory was not visible to the build.

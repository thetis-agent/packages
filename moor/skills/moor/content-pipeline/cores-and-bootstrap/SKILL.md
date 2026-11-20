---
name: cores-and-bootstrap
description: "Pick a bundled mooR core, bring a world up from nothing, and know what the server itself requires from a database. Use when starting a mooR world for the first time, or when the server runs but a connection cannot log in, or a startup hook is missing or ignored. Not for objdef file syntax (read objdef-format), not for importing a LambdaMOO textdump (read textdump-compat), and not for the Torchship game database, in-world verb authoring, or Thetis's own internals."
metadata:
  title: "Cores, bootstrap, and what the server needs from a database"
  tags: [moor, core, cowbell, snore, lambda-moor, lambdacore, minimal-core, bootstrap, first-start, do-login-command, server-options, server-started, startup-config, user-connected, checkpoint, docker-compose, dev-sh, moorc, login-fails, dump-interval, start-moor-cowbellsh, start-moor-lambdacoresh, docker-composeyml, moor-devyaml, cores-make, do-command, huh, handle-uncaught-error]
  related: [moor/working-in-the-repo/build-and-run, moor/services/daemon-and-rpc]
  version: 2
---

# Cores, bootstrap, and what the server needs from a database

This skill is written in ASD-STE100 Simplified Technical English.

mooR is an engine with no world in it. A **core** is the starter database that makes
the engine usable: a system object, a root object, players, rooms, a login path, and
the library code above them. This page covers the cores the repository ships, how a
world comes up from nothing, and the small set of things the server itself reaches
into the database to find.

## What a core is, and is not

The engine knows about objects, properties, verbs, permissions and tasks. It knows
almost nothing about rooms, players, commands or logins. Everything a person
experiences is written in MOO and lives in the database.

So a core is not configuration and not a template. It is the world, and after the
first start it is the live database. The source directory that built it is a
historical record from that moment on. Read
`moor/content-pipeline/objdef-format` for how the two diverge
and how to move changes between them.

## The bundled cores

| Path | What it is | Start here when |
|---|---|---|
| `cores/cowbell/src` | mooR's own core, written from scratch for the web client. Event driven, rich content, uses mooR-only language features. A world of packages (`core`, `git`, `http`, `package`, `types`). | You are building a new world, or working on mooR itself. This is the default in `docker-compose.yml`, `moor-dev.yaml`, `scripts/dev.sh` and the `moor:dev` npm script. |
| `cores/snore/src` | Snore, a LambdaCore fork for mooR, through the lambda-moor port. Familiar commands, mail, news and guests, with internals updated to booleans, maps, closures and UUID users. `cores/snore/run-monolith.sh` runs it locally. | You want a LambdaCore-style world that uses modern mooR features. |
| `cores/lambda-moor/src` | LambdaCore 2018, converted to objdef and edited until it works with mooR's modern flags. Passwords moved to argon2. | You want a familiar LambdaCore environment, or a compatibility test. The default of `scripts/daemon.sh`. |
| `cores/minimal-core/src` | Four objects: system object, root, one room, one wizard. Enough to log in and evaluate expressions. | You are testing the runtime, or building a world with no inherited assumptions. |
| `cores/benches/src` | Not a usable world. Objdef files whose `test_` verbs are performance benchmarks. | You are measuring the engine. |
| `cores/JHCore-DEV-2.db` | A JaysHouseCore textdump. It is the fixture for the large textdump import test. | You are testing textdump import. |

Constraints that decide whether a core will even load:

- **Cowbell and Snore need mooR 2.0.** They use post-1.0 runtime and compiler
  features, packages among them, and do not work with the 1.0 line. Cowbell's README
  still says "the `main` branch"; for 2.0 that means `v2.0-release` or later.
- **Every core declares its feature flags in its own `Makefile`.** Read the `OPTIONS`
  variable there (Snore calls it `FEATURES`). Cowbell also needs
  `--anonymous-objects true`; the benches core explicitly sets it false. Snore turns
  flyweights and rich notify off. The server side of the same flags is the
  `features` block of the config file, and `FeaturesConfig` in
  `crates/vm/src/config.rs`.
- **The core makefiles share rules.** `cores/make/core.mk`, `compiler.mk` and
  `tests.mk` define `build`, `check`, `roundtrip`, `rebuild` and `test`. They build
  `moorc` with `MOORC_PROFILE ?= release-check`, a fast-compiling profile.
- **Licensing is not uniform.** Only `minimal-core` is under mooR's own licence.
  `cores/LICENSING.md` explains the position on LambdaCore-derived material, and
  `cores/snore/LICENSE.md` covers Snore.

## Bringing a world up

The rule that surprises everyone first: **an import happens only when the database
did not exist.** The daemon creates the database, and only then reads the import
path. On every later start the import path is ignored. Editing the source directory
does not change an existing world, and neither does restarting. The baseline options
(`--git-upstream`, `--baseline-objdef-dir`) are also read only on that first import;
see `moor/content-pipeline/objdef-format` for how later source changes are reviewed
into a live world.

If the import fails, the daemon deletes the database it had just created and exits
with the error. It removes only that database, not the whole data directory.

| Route | What it does | Use it for |
|---|---|---|
| `scripts/start-moor-cowbell.sh`, `scripts/start-moor-lambdacore.sh` | Set `IMPORT_PATH` and `RUN_DIR` (`run-cowbell/`, `run-lambda-moor/`), then run `docker compose up --build`. Accept `--core`, `--git-upstream`, `--baseline-objdef-dir`, `--debug`. | The quickest complete stack, with the web client. This is what the README tells new users to run. |
| `docker-compose.yml` | Runs the single-process `moor` binary with `--import`, `--import-format=objdef`, `--export`, `--generate-keypair`, the curl and git workers, and optional baseline options from `MOOR_GIT_UPSTREAM` / `MOOR_BASELINE_OBJDEF_DIR`. | Reading exactly which options a first start uses. |
| `scripts/dev.sh` | Native stack, no Docker: daemon, web host, Meadow under Vite, and optional telnet host and workers. Imports `cores/cowbell/src` with baselines from `--git-upstream` (default `origin/main`). | Daily development. It replaced the removed `process-compose` files. |
| The `moor` or `moor-daemon` binary directly | `--import`, `--import-format`, `--export`, `--db`, `--config-file`, `--startup-config`, `--git-upstream`, `--baseline-objdef-dir`. | Scripted or unusual setups. |
| `moorc` | Compiles a source tree into a database or an objdef dump, with no server. | Validating a core, converting a textdump, running a core's tests. |
| `make -C cores/<core>` | Wraps `moorc` to produce `gen.objdir` (with `--include-baselines=false`); `make test` runs the core's `test_` verbs; `make check` adds round-trip and core checks; `make rebuild` overwrites `src/` with normalised output. Cowbell adds `check-full`. | Core development. `rebuild` is destructive; review the diff. |

To start over, delete the database directory and start again. That is the supported
way to re-import.

Exports go the other way. When an export path and a checkpoint interval are
configured, a background thread asks the scheduler for a checkpoint. The checkpoint
takes a read-only snapshot, collects every object, writes an objdef directory named
`checkpoint-<seconds>.in-progress`, and renames it to `checkpoint-<seconds>.moo` as
the last step. `dump_database()` requests one on demand. Checkpoints are always
objdef, whatever `--export-format` says.

## What the server requires of the database

This is the part that decides whether a core works. The engine reaches into the
database in a small number of named places. Each one is defined in code as a symbol
constant, and each list changes, so read the constant, not a copy of it.

**Settings the server reads.** `reload_server_options` in
`crates/kernel/src/tasks/scheduler/config.rs` holds the whole set as
`LazyLock<Symbol>` constants at the top of that file. Two facts about the shape:

- Most are read from the object that `#0.server_options` points at. If that property
  is missing, or is not an object, every setting keeps its default and the server
  logs that it is using defaults.
- Some are read from `#0` itself, not from `$server_options`. `dump_interval` and
  `gc_interval` are on `#0`. The book's table omits `gc_interval`.
- A value of the wrong type produces a warning and the default. Nothing here is
  fatal, and nothing here is required.

**Verbs the server calls.** Each name below is a symbol constant in the file named.
Missing verbs are not startup errors; the effect appears when the situation arises.

| Verb | Called on | Defined in | Effect when absent |
|---|---|---|---|
| `do_login_command` | The listener's handler object, which defaults to `#0` | `crates/daemon/src/rpc/message_handler.rs`, used in `daemon_api_impl.rs` | Nobody can log in. The login task fails and the client gets a login failure. |
| `user_connected`, `user_reconnected`, `user_created`, `user_disconnected` | The handler object | `crates/daemon/src/rpc/message_handler.rs`, used in `message_handler_tasks.rs` | Login still works. The world is never told that a player arrived or left. |
| `server_started` | `#0` | `crates/daemon/src/lib.rs` | Skipped, with a debug log. Anything the world wanted to restart does not restart. With `--startup-config FILE` the hook gets the file's JSON object as its argument and becomes mandatory: a missing verb, an error or the 30 s timeout stops the daemon. |
| `do_command` | `#0` | `crates/kernel/src/tasks/task/start.rs` | Every command goes straight to the normal command parser. This is a valid design, not an error. |
| `huh` | The player's location | `crates/kernel/src/tasks/task/start.rs` | An unmatched command reports no match instead of being handled in-world. |
| `handle_uncaught_error` | `#0` | `crates/kernel/src/tasks/task/start.rs` | An uncaught error is logged by the server and not reported in-world. |
| `handle_task_timeout` | The scheduler's callback path | `crates/kernel/src/tasks/scheduler/transitions/complete.rs` | A task that hits a limit is finalised with no in-world notice. |
| `do_out_of_band_command` | The handler object | `crates/kernel/src/tasks/scheduler/admission.rs` | Out-of-band input is not handled. |
| `do_client_data` | The handler object | `crates/kernel/src/tasks/scheduler_client.rs` | Structured client data (GMCP, MSDP, telnet negotiation results) is dropped silently. Called before login too, with the connection as `player`. See `moor/services/telnet-protocols` |
| `initialize`, `recycle` | The object being created or destroyed | `crates/kernel/src/vm/builtins/bf_objects.rs` | `create()` and `recycle()` still work; the object gets no lifecycle callback. |

**Objects.** `#0` is the system object and is hard-coded as `SYSTEM_OBJECT`
throughout the engine. Everything else is convention. `#1` as a root object and `#2`
as a first room are core conventions, not engine requirements; `minimal-core` shows
the smallest set that works.

**Nothing is validated at startup.** The daemon opens the database, optionally
imports, starts the scheduler, and calls `server_started` if it exists. It never
checks that a login path exists. A core with no `do_login_command` starts cleanly and
accepts connections that can never log in.

## Invariants

1. The import path is read only when the database file was just created.
2. A failed import leaves no database behind, so a retry is always from a clean state.
3. Checkpoints are objdef directories, always, and the `.moo` name appears only after
   a successful write.
4. `#0` is the system object. No other object number is fixed by the engine.
5. A core's feature flags and the server's feature flags must agree. The core's
   `Makefile` is the record of what the core was built with.

## Where the code and the configuration live

| Path | Responsibility |
|---|---|
| `crates/daemon/src/lib.rs` | Opening the database, deciding whether to import, `perform_import`, cleanup on failure, the checkpoint thread, the `server_started` hook and `load_startup_config`. |
| `crates/daemon/src/args.rs` | `--import`, `--export`, `--import-format`, the deprecated `--export-format`, `--checkpoint-interval-seconds`, `--startup-config`, `--git-upstream`, `--baseline-objdef-dir`. |
| `crates/server/src/main.rs` | The same options on the single-process `moor` binary. |
| `crates/kernel/src/config.rs` | `ImportExportConfig` and `ImportFormat`, the file-config form of the same options. |
| `crates/kernel/src/tasks/scheduler/config.rs` | Every `$server_options` and `#0` setting the server reads. |
| `crates/kernel/src/tasks/checkpoint.rs` | The checkpoint export. |
| `crates/vm/src/config.rs` | `FeaturesConfig`: the flag set and its defaults. |
| `moor-dev.yaml`, `docker-compose.yml`, `scripts/dev.sh`, `scripts/start-moor-*.sh` | The worked examples of a first start. |
| `cores/make/*.mk` | The build, check, round-trip and test rules every core `Makefile` includes. |
| `cores/*/Makefile` | The flags each core requires, and its build, test and rebuild targets. |
| `cores/LICENSING.md` | The licence position for each bundled core. |

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| Source edits have no effect after a restart | The database already exists, so the import was skipped | Delete the database directory to re-import, or apply the change in-world with `load_object` or `reload_object`. |
| The daemon exits during a first start and no database remains | The import failed and the daemon removed the database it created | The error above the removal message is the real one. Reproduce it with `moorc` for a faster loop. |
| The world starts, a connection is accepted, and login never completes | No `do_login_command` on the handler object, or it does not return an object | Check the handler object of the listener, which defaults to `#0`. A login verb must return a player object. |
| Login works, but the world never reacts to arrivals | No `user_connected` or `user_created` | These are separate from the login verb. Add them. |
| Nothing the world scheduled at boot is running | No `server_started`, or it failed | Without `--startup-config` the hook is optional and its absence is only a debug log. It has a 30 s completion timeout. |
| The daemon stops at startup after the import | `--startup-config` was given, and `server_started` is missing, failed or timed out | Read the log line. The config file must hold a JSON object. |
| A core fails to compile with errors about unknown syntax | The core needs feature flags the server does not have | Compare the core's `Makefile` `OPTIONS` with the server's `features` block. Cowbell and Snore need mooR 2.0. |
| `$server_options` settings are ignored | `#0.server_options` is missing, or is not an object | The log says the server is using defaults. It never fails. |
| Checkpoints never appear | No export path, or no checkpoint interval | Both are needed. The error when only the interval is set is logged as an inability to checkpoint. |
| `make gen.moo-textdump` or `make output` fails on an unknown option | `cores/make/core.mk` still has a `gen.moo-textdump` target, lambda-moor makes it its `output` target, and `moorc` has no `--out-textdump` | Use `make build` (`gen.objdir`) instead. |
| Two servers appear to fight over one database directory | The database is opened by one process only | Stop one. `moor-emh` takes an exclusive directory lock for exactly this reason. |

## Recovering a world with no working login

`tools/moor-emh` exists for this. It opens the database directly, with the server
stopped, takes an exclusive lock on the data directory, and finds a wizard by scanning
for the wizard flag and choosing the lowest object number. It gives a REPL that can
evaluate code, read and write properties, program verbs, and `dump`, `load` and
`reload` objdef definitions. Use it to install or repair a login verb, then start the
server again. Read `moor/working-in-the-repo/repo-tooling`
for the tool set it belongs to.

## Read first, read next

Read first:

- `moor/content-pipeline/objdef-format` — the format every
  bundled core is written in.
- `moor/working-in-the-repo/build-and-run` — building the
  binaries these routes run.

Read next:

- `moor/content-pipeline/textdump-compat` — bringing a
  world in from an older server.
- `moor/services/daemon-and-rpc` — the process that owns
  the import, the checkpoint thread, and the login path.
- `moor/execution/task-scheduler` — what
  `$server_options` actually controls.
- `book/src/the-system/understanding-moo-cores.md` and `bootstrapping-from-source.md`
  — good background. Check `server-assumptions-about-the-database.md` against
  `scheduler/config.rs`; the book's list is behind.

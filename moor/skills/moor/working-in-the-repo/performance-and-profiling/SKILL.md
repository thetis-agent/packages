---
name: performance-and-profiling
description: "Prove a mooR optimisation instead of asserting it: where the benches are, how to profile with perf and mootop, how to read the daemon's metrics, and what zero-copy means in the db, var and kernel crates. Use when a change is meant to make mooR faster, when you must show a before and after, when something is slow and you do not know where, or when you must read runtime counters from a live server. Use it before you write a bench, run perf or mootop, or turn on the metrics file. Not for choosing a correctness test or compiling and starting a server, and not for the Torchship database or Thetis's own internals."
metadata:
  title: Measuring and profiling mooR
  tags: [moor, performance, benchmark, profiling, perf, flamegraph, mootop, bpftrace, usdt, probes, counters, metrics, metrics-file, prometheus, optimisation, slow, micromeasure, cache, runtime-counters, moor-loadsim]
  related: [moor/storage-and-state/storage-engine, moor/execution/virtual-machine]
  version: 2
---

# Measuring and profiling mooR

The project states that performance is paramount in the hot crates, and that an
optimisation must be proved rather than asserted. This skill is how you prove
it. It owns the benches, the profilers, `mootop`, the metrics and the runtime
counters; `moor/working-in-the-repo/conventions` states the
rule and points here, and `moor/working-in-the-repo/build-and-run`
gives the profiles a measurement needs.

The hot crates are `crates/db` and `crates/kernel`, named as such in `AGENTS.md`.
In practice `crates/var` and `crates/vm` are as hot, because they sit under every
instruction the VM runs.

## The measurement ladder

Climb from the top only as far as you must. Each rung costs more time and gives
a broader answer.

| Rung | Tool | Answers |
|---|---|---|
| 1 | A bench in `crates/*/benches` | Did this function get faster |
| 2 | A load tool in `crates/testing/load-tools`, or a `tools/moor-loadsim` scenario | Did the whole transaction and scheduling path get faster; what do players see under load |
| 3 | `mootop` on a running server | Which verbs, builtins and tasks use the CPU, beside the daemon's own metrics |
| 4 | `perf`, through the scripts in `tools/perf` | Which instructions, cache misses and branch mispredictions cause it |
| 5 | The metrics file, the metrics RPC and the in-world counter builtins | What is a running server doing, over time |

A rung-1 result alone does not justify a change in `db` or `kernel`. Those
crates are reached through a transaction and a scheduler, and a micro-benchmark
that skips both can improve while the system gets slower.

## The benches

All benches use the `micromeasure` harness with the standard test harness turned
off, not Criterion. That choice matters: micromeasure reports hardware
performance-counter data alongside timing, so a bench can tell you instructions
per cycle, front-end stalls and branch prediction, not only nanoseconds.

| Crate | Bench | Measures |
|---|---|---|
| `var` | `var_benches`, `map_benches`, `symbol_benches`, `flyweight_benches` | Value construction and access for each value kind, map operations, symbol interning, flyweights |
| `var` | `var_repr_benches` | Codegen probes for alternate scalar representations. The timings are secondary; the point is the release assembly the loops produce |
| `common` | `verbcasecmp_benches` | The verb-name matching comparison, which runs on every dispatch |
| `compiler` | `compile_benches`, `objdef_benches` | Compilation throughput, and objdef parsing |
| `db` | `tx_relation_benches`, `tx_worldstate_benches` | Transactional relation and world-state operations |
| `db` | `verb_cache_benches`, `prop_cache_benches` | The verb and property lookup caches, under light and heavy contexts |
| `db` | `objdef_export_benches` | Collecting a whole world for an objdef export |
| `daemon` | `connection_registry_benches` | Connection registry lookups and updates |
| `kernel` | `vm_benches` | Interpreter throughput, run to a tick limit, isolated from world-state mutation |
| `kernel` | `vm_micro_benches` | Opcode dispatch at the CPU level: instructions per cycle, stalls, branch prediction |
| `kernel` | `verb_dispatch_bench`, `property_dispatch_bench`, `builtin_dispatch_bench` | The cost of a verb call, a property access and a builtin call through the VM loop, isolated from the scheduler |
| `kernel` | `activation_bench`, `activation_stack_capacity_bench` | Frame and activation construction, and the allocation and drop cost of the activation stack's backing store |
| `schema` | `var_encode_benches` | Encoding a value to the wire and persistence form |

The bench list drifts. Read the `[[bench]]` sections of a crate's `Cargo.toml`
for the current set, and the module comment at the top of each bench for what it
claims to isolate. Those comments are careful; trust them over a guess.

Run a bench with `cargo bench -p <package> --bench <name>`. Benches are compiled
by CI as part of the all-targets build, so a bench that does not compile fails
the build even though nobody ran it.

## Profiling with perf

`tools/perf` holds Linux `perf` wrappers. They exist because the arguments are
tedious and easy to get subtly wrong.

**A running server.** `tools/perf/profile-running-moor.sh` records from a live
`moor` or `moor-daemon` process for a fixed duration and bundles the recording
with the exact executable image the process was running, so symbols still
resolve later. It takes an optional duration and process id, writes the archive
to the current directory unless told otherwise, and checks access to the CPU
performance counters before it starts, reporting which kernel setting to change
if access is blocked.

**Activation and frame construction.** This path is hot enough to have its own
profiling binary, `activation_profile` in the kernel crate, which runs one named
scenario in a loop with no Criterion or micromeasure framing around it.
`tools/perf/activation-profile.sh` builds it in release, runs it, and writes
counter statistics, a recording and two reports under the target directory. The
scenario, iteration count and warm-up are set by environment variable.
`tools/perf/activation-analyze.sh` regenerates reports, including an annotated
disassembly, from a recording you already have. The scenario names and the
default output paths are in `tools/perf/README.md`.

## Watching a running server with mootop

`tools/mootop` shows where a running `moor` or `moor-daemon` spends its CPU, by verb,
builtin and task. It attaches `bpftrace` to USDT probes under the provider `moor`
and samples what each thread runs. It needs Linux, bpftrace, and root or the
capabilities bpftrace needs. It finds the only running daemon, or takes `--pid`.

- `mootop` is the live view. `mootop record --duration N --output FILE` records one
  JSON line per second, and `mootop report FILE` prints the tables later, with no
  server.
- The frame probes are in `crates/vm/src/probes.rs`, through the `probe` crate. With
  no tracer attached a probe costs one load and one branch, and its arguments are
  never evaluated. So the probes are always compiled in; there is no feature flag.
- The probe list and the views are in `book/src/the-system/mootop.md`. Keep it in
  step when you change a probe; the module comment says so.

Use `mootop` when the question is "which MOO code is the server running". Use
`perf` when the question is "which machine instructions".

## Runtime metrics and counters

The runtime carries always-on metrics through the `fast-telemetry` crate:
counters, gauges and sampled timers in the world-state layer, the scheduler, the
task program cache, the builtin dispatch table, the database caches and the RPC
queues. They are not behind a feature flag. A sampled timer reports an estimated
total, `sum * calls / samples`, from its own exact call counter, so the total is
right whatever timing policy was in effect when the timer was built.

Four ways to read them:

| Way | What it gives |
|---|---|
| `--metrics-file FILE`, `--metrics-interval-seconds N` (default 10) on `moor` and `moor-daemon` | The Prometheus text format, replaced each interval and deleted at shutdown. Serve it with a static file server or the node_exporter textfile collector. The server itself serves no metrics over the network |
| The metrics RPC (`RequestMetrics`, reply `DaemonToHostMetrics`) | One `MetricsSnapshot` in the Prometheus data model: families with name, help, unit and kind, and labelled samples with histogram buckets. The load tools use it |
| `mootop` | The same snapshot, sent through the `metrics_begin`, `metric` and `metrics_end` probes once a second while a tracer is attached |
| The in-world builtins | `bf_counters()`, `db_counters()` and `sched_counters()`, wizard-only maps of name to count and elapsed nanoseconds, plus `memory_usage()` and `db_disk_size()`. See `moor/execution/builtin-functions` |

The code is `MetricsExporter` in `crates/common/src/util/metrics_file.rs` and
`MetricsSnapshot` in `metrics_snapshot.rs` beside it. The daemon always runs the exporter, also
in the single-process `moor`; the curl and git workers run it only with a file.
`book/src/the-system/server-configuration.md` documents the file options.

The database also exposes statistics for its verb, property and ancestry caches.
A cache hit rate that has dropped is often the whole explanation for a
regression.

Ordinary logging goes through `tracing`, initialised once in `moor-common` and
driven by `RUST_LOG`. This is diagnosis, not measurement: log volume changes
timing.

## What "zero-copy" and "cache-friendly" mean here

These words are used precisely in this project. They describe designs already in
the code, and a change is expected to preserve them.

**In `crates/var`.** A value is a small, cheaply copied representation. Strings
and lists are reference-counted and shared rather than copied on assignment;
persistent immutable collections give a cheap clone with structural sharing.
Symbols are interned so that a name comparison is an integer comparison, not a
string comparison. The scalar representation is deliberately tuned, to the point
that one bench exists only to inspect the assembly it produces. A change that
makes `Var` larger, or that makes a clone deep, is a serious regression even if
no bench notices.

**In `crates/db`.** Reads go through caches for verb lookup, property lookup and
ancestry, because those are the queries the VM makes constantly. Stored bytes
are handled as views over shared buffers rather than being decoded into owned
structures on every read. A change that adds a decode or an allocation to a read
path costs on every property access in the world.

**In `crates/kernel`.** The activation stack is reused rather than reallocated
per call; that is why it has its own bench. Builtin dispatch is an index into a
table, not a lookup by name. Compiled programs are cached per task. A change
that puts an allocation, a hash lookup or a string comparison into verb
dispatch, property access or opcode dispatch is on the hottest path in the
system.

Practically: before you add an allocation, a clone, a `String`, a hash map or a
trait object to any of these paths, measure. After you add it, measure again.

## Rules of measurement

1. **Measure a release build.** A `dev` build is not the program. A profile
   taken on a debug build shows the cost of unoptimised code and misleads you
   about where time goes. The `release` profile keeps full debug information for
   exactly this reason, so use it rather than inventing a custom profile.
2. **Measure both sides on the same machine, in the same session.** A number
   from your machine compared against a number from CI, or from yesterday, is
   not evidence.
3. **Interleave the runs.** Run before, after, before, after. A machine that
   warms up or throttles produces a monotone drift that looks exactly like an
   improvement.
4. **Do not measure with a tracer attached** unless the tracer is what you are
   measuring. An attached `mootop` slows the probed paths.
5. **Match the rung to the claim.** A claim about the database or the scheduler
   needs a rung-2 result. A claim about one function may stop at rung 1.
6. **Keep the evidence.** Put the numbers in the pull request.
   `moor/working-in-the-repo/conventions` requires it.

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| The bench result moves as much between runs of the same code as between versions | Machine noise: other load, frequency scaling, a laptop on battery | Quiet the machine, pin frequency if you can, and interleave runs. If the change is smaller than the run-to-run spread, you have not shown anything |
| A micro-benchmark improves but the server does not | The bench skipped the transaction and scheduler path that the real call goes through | Re-measure with a load tool from `crates/testing/load-tools`, or watch the real path with `mootop`. The dispatch benches say in their own comments that they isolate from the scheduler; that isolation is the thing you must undo to confirm |
| A profile shows time in unexpected places, spread thinly | You profiled a debug build | Rebuild with `--release` and profile again. The perf scripts build release for you; a hand-run `perf` may not |
| `perf` refuses to record | The kernel restricts access to performance counters | The script reports which setting to change |
| Symbols do not resolve in a recording | The binary was rebuilt or is in a container | Use `tools/perf/profile-running-moor.sh`, which bundles the exact image with the recording |
| `mootop` cannot attach, or shows no samples | Not root, bpftrace missing or too old, or more than one daemon is running | Run it with the capabilities bpftrace needs, and give `--pid`. The book page lists the tested bpftrace versions |
| `mootop` shows CPU but no daemon metrics | The binary is older than the metrics probes | Rebuild. `mootop` adds `metrics.bt` only when the binary has the metrics probes |
| The metrics file is stale | The exporter stopped, or the daemon is stopped | Alert on `moor_metrics_written_timestamp_seconds` |
| Database timings read far too low in an old build | Timers were scaled by the policy at read time | Fixed: estimated totals use each timer's own samples. Upgrade before you compare |
| A counter builtin returns an error | It is wizard-only | Run it as a wizard. See `moor/execution/permissions-and-security` |
| A regression appears with no code change in the hot path | A cache hit rate fell, or a transaction is retrying | Read the database cache statistics and the transaction counters before you read any code. See `moor/storage-and-state/transactions` |
| A change is faster but the reviewer objects | The gain came at a readability cost with no number behind it | The project accepts a readability cost only with evidence. Produce it, or revert |

## Read first / read next

Read `moor/working-in-the-repo/conventions` for the rule
this skill serves, and `moor/working-in-the-repo/build-and-run`
for the profiles. Read
`moor/working-in-the-repo/testing` for the load and consistency
tools, which double as the rung-2 measurement. Read
`moor/storage-and-state/storage-engine` before
optimising in `crates/db`, and
`moor/execution/virtual-machine` before optimising in
the interpreter.

---
name: task-scheduler
description: "How a MOO task starts, runs, suspends, forks, retries after a conflict, and dies; the queues behind it and the tick and seconds limits that bound it. Use when the question is about task lifecycle in the mooR server: what starts a task, suspend and resume, background tasks, conflict retry and backoff, surviving a restart, or the tick/seconds limits on $server_options. Not for opcode execution, writing a builtin, permission checks, or command parsing, and not for Torchship or Thetis's internals."
metadata:
  title: The mooR task scheduler
  tags: [moor, scheduler, task, suspend, fork, resume, kill-task, ticks, server-options, conflict-retry, backoff, background-task, checkpoint, dump-interval, queued-tasks, task-recv, task-send, wait-task, task-ids, fg-ticks, bg-ticks, fg-seconds, bg-seconds, max-stack-depth, max-task-retries, read]
  version: 4
---

# The mooR task scheduler

The scheduler owns every task in the server. It decides when a task starts, on
which thread it runs, when a suspended task wakes, and what happens to its
transaction when it ends. It does not execute MOO code; it hands a prepared
`Task` to a thread pool worker, and the worker drives the VM.

Read `moor/execution` first for the task and transaction rule. This skill assumes it.

## What starts a task

A task begins as a `TaskStart` value. The variant decides how the VM is set up.

| Variant | Started by | Notes |
|---|---|---|
| `StartCommandVerb` | A line of player input | Parses the command inside the task's own transaction. |
| `StartDoCommand` | The same input, when `$do_command` exists | If `$do_command` returns a false value the same task rewrites itself to `StartCommandVerb` and parses, in the same transaction. |
| `StartVerb` | RPC verb invocation, login, connect and disconnect handlers, `$handle_task_timeout` | |
| `StartScheduled` | A firing of a native schedule (`schedule_at()`, `schedule_every()`) | Runs as `StartVerb` with an empty argstr. A background task. |
| `StartFork` | The `fork` statement | A background task, with `StartScheduled` (`TaskStart::is_background`). |
| `StartEval` | `eval` and the `;` command | A non-programmer's program is replaced with one that returns `E_PERM`. |
| `StartExceptionHandler` | An uncaught exception, when `$handle_uncaught_error` exists | |
| `StartBatchWorldState` | Host-side bulk read and write | Bypasses the VM entirely; runs world state actions in one transaction. |

Outside callers reach these through `SchedulerClient` in
`crates/kernel/src/tasks/scheduler_client.rs`. Requests are queued and answered
with a timeout, so a wedged scheduler produces `SchedulerNotResponding` rather
than a hang.

## Concurrency

Tasks run in parallel on a fixed thread pool. Unlike LambdaMOO there is no global
interpreter turn; isolation comes from the per-task transaction, not from
serialisation. The pool is sized from `usable_core_count()` in
`crates/common/src/threading.rs`: the CPUs the process may use, recorded before
any thread is pinned and capped by a container CPU quota. With performance-core
pinning it is the count of pinned cores instead.

Three service threads sit beside the pool (`crates/kernel/src/tasks/scheduler/services.rs`):

| Thread | Job |
|---|---|
| `moor-timer` | Wakes expired suspensions, drains immediate wakes, triggers GC and periodic tasks-database compaction, fires native schedules, hands due suspended tasks to the task writer, records task gauges once a second. Runs at background priority. |
| `moor-scheduler-requests` | Runs requests submitted through `SchedulerClient`. |
| `moor-worker-recv` | Wakes tasks that were waiting on an out-of-process worker. |

All mutable scheduler state sits behind one lifecycle mutex. Task membership is
also mirrored into a lock-free registry so cheap existence checks do not take the
lock. Cancellation and commit are arbitrated without the mutex by an atomic state
in `crates/kernel/src/tasks/task_control.rs`: a kill that arrives during a commit
takes effect after that commit, and a terminal commit that has started wins. A
panicking task does not kill its pool thread; the pool catches it, logs it, and
reports `Aborted(Internal)` with `Kept::Unknown`.

Thread affinity is optional and configured by `runtime.task_pool_pinning` (none,
auto, performance) and `runtime.service_perf_cores` in the daemon config.

## Active and suspended

A task is in exactly one of two places.

**Active** means a pool worker owns the `Task` and the VM may be running. The
scheduler holds only a control record: the player, the kill switch, the session,
and the result channel. Because the stack is moving, introspection of an active
task is limited to metadata. `active_tasks()` and `task_telemetry()` report it.

**Suspended** means the scheduler owns the whole `Task`, including its VM state.
It is inspectable, so `queued_tasks()` can report the verb and line number.

Each suspended task carries one wake condition:

| Wake condition | Set by |
|---|---|
| `Never` | `suspend()` with no argument |
| `Time` | `suspend(n)`, and a delayed `fork` |
| `Input` | `read()` |
| `Task` | `wait_task()` |
| `Immediate` | `commit()`, `suspend_if_needed()` past its threshold, `task_recv()` with no wait, and a brand new task before its first run |
| `Worker` | `worker_request()` |
| `GCComplete` | A task submitted while a GC sweep is in progress |
| `Retry` | Transaction conflict backoff |
| `TaskMessage` | `task_recv(seconds)` with an empty mailbox |
| `Checkpoint` | `dump_database(1)`, until the checkpoint finishes |
| `StorageCompaction` | `db_compact()`, until the compaction finishes |

`WakeCondition` is in `crates/kernel/src/tasks/registry/suspension.rs`. A
checkpoint and a storage compaction exclude each other
(`crates/kernel/src/tasks/maintenance.rs`); a second request gets
`CheckpointInProgress` or `StorageMaintenanceInProgress`.

Timed wakes use a hierarchical hash wheel, so inserting and expiring a deadline
is cheap regardless of how many tasks are queued. Each suspension carries a
generation stamp, so a stale timer entry left by an earlier suspension of the
same task is ignored.

## Suspension is a commit

Every suspension commits first. The order matters and is fixed:

1. The VM yields with a suspend request.
2. The world state transaction commits. A conflict here turns the suspension into
   a retry instead.
3. The VM state snapshot is refreshed. This becomes the new retry point, and the
   retry count goes back to zero.
4. The session commits, publishing buffered narrative output. This happens
   outside the scheduler lock, because it does I/O.
5. The task's pending effects (`task_send()` messages, schedule changes) are
   published, and the task moves from the active map to the suspension queue.

A session commit that fails does not roll back the world state. The task aborts
with `Aborted(Internal)` and `Kept::Yes`; the world state's integrity wins. A
suspension handed over without proof of a committed boundary ends with
`Kept::Unknown`, which drops its effects.

An in-task boundary (`commit()`, `suspend(0)`, `fork`, `task_recv` with no wait)
goes through `renew_transaction`, which since 557366534 and 5691b4700 (2026-11-14)
also commits the session once the world state commits. If that session commit fails,
the task aborts with its changes kept. Before the fix, output told before the
boundary stayed buffered, and a conflict after it rolled back the whole session:
lines that had happened were lost with no error (Torchship: "[ Gig X complete ]"
and NPC poses before the `fork` in a relationship report). Tests in
`crates/kernel/src/tasks/task/tests/transactions.rs`:
`output_before_commit_survives_later_conflict_retry`,
`session_failure_at_commit_boundary_aborts_and_keeps_changes`.

`fork` follows the same path but resumes immediately in a new transaction rather
than suspending. The forked child gets a copy of the parent's activation, its own
task id, its own session forked from the parent's, and background limits.

## Failure and retry

Every task reports one `TaskOutcome` to whoever waits on it
(`crates/common/src/tasks/outcome.rs`). `SchedulerError` now carries only refusals
to start or find a task, never how a task ended.

| Outcome | What the scheduler does | Reported as |
|---|---|---|
| Conflict on commit | Roll back the session, drop pending effects, wait a randomised exponential backoff, restore the VM snapshot (`retry_from`), run again in a new transaction with a forked retry session. | (no result yet) |
| Consecutive retries reach `max_task_retries` | Log "Task retry limit exhausted; aborting task" and drop the task. | `Aborted(ConflictRetriesExhausted)`, `Kept::No` |
| Tick, seconds or output limit | Commit or roll back per `rollback_on_task_limit`, send the player an abort message, and start `$handle_task_timeout` as a separate task with the resource name, stack, and backtrace. | `Aborted(Limit(..))`, `Kept::Yes` on commit, `No` on rollback |
| Uncaught exception | Try `$handle_uncaught_error` on `#0` first. If it is absent or returns a false value, commit, log the backtrace. | `Aborted(Exception)`, `Kept::Yes` |
| Commit refused, for example `DatabaseOverloaded` after the commit queue timeout | Roll back the session. The task gets `E_QUOTA`; other refusals give `E_EXEC` "Database commit failed" (`task/outcome.rs`, `commit_rejection`). | `Aborted(Exception)`, `Kept::No` |
| `kill_task()` from another task, or a disconnect | Request cancellation. A suspended task is removed at once. An active one stops at its next check or after the commit in progress. The open transaction rolls back; the session is committed and "Aborted." sent, except during shutdown. | `Aborted(Cancelled)`, `Kept::No` |
| `kill_task(task_id())` | The task commits, publishes its session and effects, and prints "Aborted." (LambdaMOO behaviour). | `Aborted(Killed)`, `Kept::Yes` |
| Explicit `rollback()` | Roll back the world state; discard or publish the session as the argument asks. | `Aborted(RolledBack)` |
| Verb or command not found | | `Aborted(VerbNotFound)` or `Aborted(CommandFailed)`, `Kept::No` |
| A new transaction cannot begin after a commit, or the session cannot commit at a boundary | Abort the task; the server cannot continue it. | `Aborted(Internal)`, `Kept::Yes` |
| Task panics | The pool catches it. | `Aborted(Internal)`, `Kept::Unknown` |

`Deadline` and `ResultLost` endings are produced by the daemon, not by the
scheduler; see `moor/services/daemon-and-rpc`.

Backoff is a random base of 10 to 50 ms shifted left by `retries - 1`, with the
shift capped at 10 (`scheduler/transitions/retry.rs`). It is deliberately jittered
so that two tasks fighting over the same relation do not resynchronise. `retries`
counts conflicts since the last successful commit point, not over the task's life:
`refresh_retry_state` resets it at every boundary. A value injected on resume (a
`read()` line, a worker reply) is put into the retry snapshot, so a retry after
the resume keeps it.

## The limits that bound a task

Defaults are constants in `crates/kernel/src/tasks/mod.rs`. The database overrides
them through properties on `$server_options`, reloaded by `load_server_options()`
and at startup. Read the current defaults from that file rather than from here.

| Property | Bounds |
|---|---|
| `fg_ticks`, `fg_seconds` | Any task that is not a background task. |
| `bg_ticks`, `bg_seconds` | Forked tasks and native schedule firings. |
| `max_stack_depth` | Nested verb calls. Fixed when the task is created; a suspended task keeps the value it started with. |
| `max_task_retries` | Consecutive conflict retries before `Aborted(ConflictRetriesExhausted)`. |
| `max_task_mailbox` | Messages a task's `task_recv` mailbox may hold. |
| `rollback_on_task_limit` | Whether a tick or seconds limit rolls back rather than commits. |
| `db_commit_queue_warn_seconds`, `db_commit_queue_timeout_seconds` | How long a commit may wait for the database writer before a warning, and before it is refused with `E_QUOTA`. Defaults are `DEFAULT_COMMIT_QUEUE_WARN` and `DEFAULT_COMMIT_QUEUE_TIMEOUT` in `crates/db/src/lib.rs`. Read in `scheduler/config.rs`. |

`$server_options.dump_interval` and `$server_options.gc_interval` are read from
`#0`, not from the options object. A command-line setting for the checkpoint or GC
interval takes precedence over the database value.

The seconds limit is not checked on every tick. The VM host checks elapsed time
every sixty-fourth tick, so a single very slow opcode can overshoot.

What a verb author sees: the task stops where it stood, the player gets an
`Abort: Task exceeded ticks limit ...` or `Abort: Task exceeded time limit ...`
system message, and `$handle_task_timeout` runs separately. Exceeding
`max_stack_depth` is different — it raises `E_MAXREC` inside the task, which
ordinary MOO code can catch.

## Surviving a restart

Suspended tasks persist only when the `persistent_tasks` feature is on. The daemon
then supplies a real tasks database; otherwise it supplies a no-op one and every
suspended task is lost at shutdown.

A suspension is not written when it happens; many tasks wake again within moments
(`crates/kernel/src/tasks/registry/persistence.rs`). The timer thread runs a save
pass every `SAVE_PASS_INTERVAL` (250 ms) and copies out at most 256 due tasks. A
task waiting on a timer or its mailbox is due after `MESSAGE_OR_TIMER_SAVE_DELAY`
(1 s); other waits are due at the next pass. The `TaskWriter` thread
(`registry/task_writer.rs`) serializes and writes them off the lifecycle lock,
with saves and deletes in one ordered queue. A task that wakes before its save
costs no write. A record is deleted when its task wakes.

Waits on input or an immediate wake are not saved as they happen. Waits on a
retry, a checkpoint or a storage compaction are never saved. A crash can lose a
task that suspended in about the last 1.25 seconds, with writes still queued. A
clean shutdown saves every other suspended task, and every persistent native
schedule.

On startup the scheduler loads every stored suspended task, gives each a fresh
background session, and re-arms its wake condition. Restored tasks keep their
records, so a crash soon after a restart does not lose them. Deadlines already in
the past wake immediately. No filtering is applied for age or for disconnected
players, so a long downtime produces a burst of waking tasks. The next task id is
advanced past the highest restored id. Native schedules with `persist` set are
loaded from the same tasks database, and their `catchup` option decides what
happens to firings missed while the server was down.

Active tasks are never persisted. A crash loses them, and their transactions with
them.

## Checkpoints are not task state

`dump_database()` and `dump_interval` write an objdef export of the **database**, not
of the task queue. The export runs against a database snapshot on a separate
thread, writes a `checkpoint-<epoch>.in-progress` directory with a
`manifest.json`, and renames it to `.moo` on success
(`crates/kernel/src/tasks/checkpoint.rs`). Only one checkpoint or storage
compaction runs at a time; a second request is refused with
`CheckpointInProgress` or `StorageMaintenanceInProgress`. `dump_database(1)`
suspends the calling task until the checkpoint finishes. Suspended tasks are
written to the tasks database instead, as described above.

## Invariants

1. **A running task always has a task context.** The thread-local context holds
   the transaction, the session, the task id, and the player. Kernel code that
   touches the world state outside one panics. Do not add a code path that reaches
   `with_current_transaction` from a thread that is not running a task.
2. **The world state commits before the session.** Never publish output for work
   that has not committed.
3. **A retry restores the last snapshot, not the start.** Any state you add to
   `Task` that must survive a retry has to be inside that snapshot or outside the
   VM entirely.
4. **Task ids are monotonic and never reused within a run.** Restart restores the
   counter above the highest persisted id.
5. **A task appears in exactly one of the active map and the suspension queue.**
   The transition is done under one lock acquisition, with an intermediate phase
   marker so a concurrent kill or shutdown sees a consistent state.
6. **Task effects are transactional.** `task_send()` messages and native
   schedule creations and cancellations are held as pending effects
   (`scheduler/effects.rs`) until the sender commits a boundary. A retry discards
   them. A task that ends publishes them only when its outcome is `Kept::Yes`.

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| `SchedulerNotResponding` from an RPC call | The scheduler is not in the running state, or a client request timed out | Check startup order and shutdown state. Do not raise the timeout as a first move. |
| A forked task never runs after a restart | `persistent_tasks` is off | Turn the feature on, or accept the loss. |
| Log: "Task already transitioning" or "Ignoring a boundary from a replaced task attempt" | A kill, retry or shutdown replaced the task while it was handing over a suspension | Usually benign. If frequent, look for a kill racing the suspension path in `scheduler/transitions/suspend.rs`. |
| Log: "No workers configured for scheduler; aborting task" | `worker_request()` with no worker process attached | Start the worker. See `moor/services/workers`. |
| A task suspended just before a crash is missing after restart | Saves are delayed by up to about 1.25 s | Expected. Only a clean shutdown saves every suspended task. |
| A burst of task starts after a restart | Restored deadlines that expired during downtime | Expected. There is no age filter by design. |
| `queued_tasks()` shows a task that never wakes | Wake condition `Never`, or a `Task` dependency on an id that no longer exists | Resume or kill it explicitly. |

## Where the code lives

| Path | Responsibility |
|---|---|
| `crates/kernel/src/tasks/mod.rs` | `TaskStart`, `ServerOptions`, limit defaults, `TaskHandle`, `TaskResult`. Its module docs give reading paths. |
| `crates/common/src/tasks/outcome.rs` | `TaskOutcome`, `TaskEnding`, `AbortReason`, `Kept`. |
| `crates/kernel/src/tasks/task/` | The task: `start.rs` sets up the VM for each `TaskStart`; `dispatch.rs` handles each VM response; `transaction.rs` owns every commit, rollback and renewal; `outcome.rs` maps them to scheduler calls. |
| `crates/kernel/src/tasks/task_control.rs` | Lock-free arbitration between cancellation and commit. |
| `crates/kernel/src/tasks/scheduler/mod.rs` | Scheduler state and construction. |
| `crates/kernel/src/tasks/scheduler/admission.rs` | Task submission entry points. |
| `crates/kernel/src/tasks/scheduler/transitions/` | Everything a running task reports back: `suspend`, `resume`, `retry`, `complete`, `cancel`. |
| `crates/kernel/src/tasks/scheduler/services.rs` | The service threads, the timer loop, shutdown. |
| `crates/kernel/src/tasks/scheduler/config.rs` | Reading `$server_options`. |
| `crates/kernel/src/tasks/scheduler/lifecycle.rs`, `effects.rs` | `TaskLifecycle`, the state under the lifecycle mutex; `finish_task` and the publishing or dropping of task effects. |
| `crates/kernel/src/tasks/registry/` | The active map (`active.rs`), the suspension queue and timer wheel (`suspension.rs`), kill and abort (`cancellation.rs`), persistence (`persistence.rs`, `task_writer.rs`). |
| `crates/kernel/src/tasks/schedule_q.rs`, `scheduler/schedules.rs` | Native schedules. |
| `crates/kernel/src/tasks/task_pool.rs` | The worker threads and their affinity. |
| `crates/kernel/src/tasks/tasks_db.rs` | The persistence trait for tasks and schedules; the daemon supplies the implementation. |
| `crates/kernel/src/tasks/checkpoint.rs`, `storage_compaction.rs`, `maintenance.rs` | Database checkpoint export, storage compaction, and their mutual exclusion. |
| `crates/kernel/src/tasks/task_scheduler_client.rs` | The handle a running task uses to talk back to the scheduler. |
| `crates/kernel/src/task_context.rs` | The thread-local transaction and session for the running task. |

## Where the book is behind the code

`book/src/the-system/moo-tasks.md` says a conflict re-executes the whole task
from the beginning. The code restores the snapshot taken at the last successful
commit or suspension, so work before that point is not replayed.

`book/src/the-system/controlling-the-execution-of-tasks.md` says values of
`fg_ticks` and `bg_ticks` below 100, and of `fg_seconds` and `bg_seconds` below 1,
are ignored. The loader accepts any non-negative value. There is no minimum.

The same chapter documents a `queued_task_limit` on the programmer or on
`$server_options`, raising `E_QUOTA` on `fork` or `suspend()`. No such limit
exists in the code.

## Read first / read next

Read `moor/storage-and-state/transactions` before you change any commit or
rollback path. Read `virtual-machine` for what the VM yields to this loop. Read
`moor/services/workers` for `worker_request()`, and `moor/services/hosts-and-sessions`
for what a session commit actually publishes.

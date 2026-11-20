---
name: transactions
description: "How a mooR transaction starts, what it reads, how commit detects conflict, and what a retry re-runs — plus what a retry does not undo. Use when a commit conflicts, a task retries or reports 'Transaction conflict', or you must reason about isolation, lost updates, or transaction boundaries in the mooR daemon. Not for the scheduler's queues, ticks and suspend rules (read moor/execution/task-scheduler), and not for the Torchship database."
metadata:
  title: Transactions and conflict retry
  tags: [moor, transactions, mvcc, conflict, retry, commitresult, conflictretry, commit, commit-pipeline, isolation, visibility, snapshot-isolation, optimistic-concurrency, rollback, moor-db, write-skew, lost-update, o-flag, clobber, database-overloaded, e-quota]
  version: 3
---

# Transactions and conflict retry

Every task in mooR runs inside one database transaction. The transaction gives the
task a fixed view of the world, collects the task's writes in memory, and checks
them against the current world only at commit. This page explains the model, the
lifecycle, and the costs a verb author and an operator pay for it.

## Why the global lock went away

LambdaMOO ran one task at a time. That made every task trivially isolated and made
the whole server single-threaded. One slow verb stopped the world.

mooR keeps the isolation and drops the lock. Each task reads from a published,
immutable snapshot of the world. Writes go to a private working set. At commit the
database asks one question: did another transaction change any key that I am writing,
after I read it? If no, the commit publishes. If yes, the commit is refused and the
task runs again.

The trade is explicit:

- **Bought:** tasks run in parallel on many cores. A slow task blocks only itself.
- **Paid:** a task can be asked to run twice. Work outside the database does not get
  a second chance to be undone. Some correct-looking MOO code is now wrong.

## The isolation level you actually get

mooR gives **snapshot isolation with write-write conflict detection**. It does not
track read sets. A transaction records an entry in its working set only when it
mutates a key. Reads are served from the snapshot index and leave no trace.

Consequences to state plainly:

- No dirty reads. No lost updates on the same key.
- **Write skew is possible.** Two transactions may read the same keys, each decide
  based on the other's old value, and each write a *different* key. Both commit. The
  invariant they were both defending is now broken.
- The fix in MOO code is to force an overlap: write the value you depended on, or
  keep the related values in one property so that they share one key.
- Real-time order is not guaranteed. A commit that happened later in wall-clock time
  may be ordered earlier.

`book/src/the-system/performance-and-concurrency.md` calls this "serializable
isolation". That is wrong. `book/src/the-database/transactions.md` describes it
correctly. Believe the code.

## The lifecycle

| Stage | What happens |
|---|---|
| Start | `TxDB::new_world_state` asks `MoorDB` for a transaction seed. |
| Seed | The seed (`acquire_tx_seed` in `crates/db/src/engine/moor_db.rs`) takes the published root snapshot, a fresh monotonic write timestamp, the shared sequence counters, and the base resolution caches. The transaction forks a cache only when it first uses that cache (17ccf622d). Relations borrow their indexes through one private snapshot handle (882d75f68). A relation that the transaction does not touch costs nothing. |
| Read | Every read is served from the snapshot's immutable relation indexes, then from the transaction's own pending writes if it has any. The snapshot never changes under the task. |
| Write | Each mutation is stored in a per-relation working set, with the timestamp of the value that was read and the transaction's own write timestamp. |
| Commit | The working sets go to the commit pipeline. See below. |
| Rollback | The transaction is dropped. Nothing was published, so nothing must be undone. |

Two timestamps matter. `visible_ts` is the committed timestamp of the snapshot the
transaction started from; it decides visibility. `ts` is the transaction's own write
timestamp, taken from a monotonic counter at start. Per key, `read_ts` records the
timestamp of the value the transaction saw.

## How conflict is detected

For each key in each non-empty working set, the check compares the key's current
canonical state against what the transaction saw:

| Situation | Conflict type |
|---|---|
| We insert, the key now exists | `InsertDuplicate` |
| We update, and the canonical timestamp is not equal to our `read_ts` | `ConcurrentWrite` |
| Our `read_ts` is newer than our write timestamp | `StaleRead` |
| We update, the key no longer exists | `UpdateNonExistent` |
| We delete a key that we saw, and the key no longer exists | `UpdateNonExistent` |

The check uses "not equal", not "newer". An `o` write can publish an older
transaction timestamp, so any change of version is a conflict.

Each conflict goes to a resolver (`crates/db/src/tx/resolve.rs`). The default is
`FailOnConflict`. Since 1a6594447, mooR does not accept identical writes and does
not merge. These rules apply:

1. **An equal value is still a conflict.** Two tasks that write the same value to one
   key conflict. A task that writes back the value *already stored* also records an
   update, and conflicts if another task changed the key. On a hot property, guard
   the write with `if (new != old)` in MOO. Torchship's retry-limit aborts fell
   mostly on NPC state that a verb rewrote unchanged on every beat.
2. **Map and flyweight writes do not merge.** Two inserts of different map keys into
   one property value conflict.
3. **The property `o` flag is the only opt-out.** The `o` (overwrite) flag is
   `PropFlag::Clobber` in `crates/common/src/model/props.rs`. Only wizards can set or
   remove it. For a property value whose final permissions have `o`, the resolver
   for `object_propvalues` accepts the overlap, and the last publication wins
   (`property_can_clobber` in `crates/db/src/engine/moor_db/property_policy.rs`).
   No other relation can opt out.
4. **An `o` write must still see a stable policy.** Before the check, and again
   after a lost compare-and-swap, `check_property_policies` makes sure that the
   property flags, the definition, and the parent chain of the object did not
   change. If one changed, the commit conflicts. An `o` value is persisted as a
   complete replacement, also for a list.
5. In all other cases the commit fails with a `ConflictInfo` that names the
   relation, the key, and the conflict type. For a property relation the pipeline
   adds the property name before it returns.

Keys created by object creation are marked `guaranteed_unique` and skip the check.
That is safe only because their identifiers come from a shared allocator.

## The commit pipeline

`crates/db/src/engine/moor_db/commit_pipeline.rs` and its `commit_pipeline/state.rs`
run this, in order:

1. **Read-only fast path.** A transaction with no mutations publishes only its
   resolution-cache updates and returns success. It can never conflict.
2. **Policy check.** If the root advanced, `check_property_policies` runs. See rule 4
   above.
3. **Check.** If the root snapshot has not advanced since the transaction started,
   the check is skipped. If it has advanced but the root's cumulative bloom filter of
   recently written keys does not intersect this transaction's keys, the check is
   also skipped. Otherwise every key is checked.
4. **Prepare.** The new relation indexes are built from the working sets, and a bloom
   filter of this commit's keys is produced. Nothing is published yet.
5. **Admission.** The commit reserves a place in the batch writer's queue
   (`admit_commit`). If the writer stays full for longer than the commit queue
   timeout, the commit fails with `WorldStateError::DatabaseOverloaded`. Nothing was
   published. The task ends with `E_QUOTA` "Database writer remained overloaded for
   ... The transaction was not committed." The task is not retried.
6. **Publish.** A compare-and-swap on the root pointer. It succeeds only if the root
   is still the version that was checked.
7. **Rebase.** If another writer won the compare-and-swap, the pipeline does the
   policy check again against the winner, then compares its keys against the winner.
   Keys of `o` property values are not compared. If the keys are provably disjoint —
   by bloom filter, or by exact key comparison of the two snapshots — it re-slots the
   prepared indexes onto the winner and tries again, up to `MAX_REBASE_ATTEMPTS`
   (16). A real key overlap ends in a conflict. Exhausting the attempts also ends in
   a conflict, with no detail.
8. **Persist.** Only after a successful publish is the batch handed to the background
   writer. See `storage-engine`.

Only step 6 serializes. Checking and preparing run in parallel across workers.

## What a retry re-executes

A refused commit returns `CommitResult::ConflictRetry`. It is not an error value;
the caller must act on it.

The task sees the conflict in `conflict_outcome` (`crates/kernel/src/tasks/task/outcome.rs`).
The scheduler's retry path is `handle_task_conflict_retry` in
`crates/kernel/src/tasks/scheduler/transitions/retry.rs`:

1. The task's session output since the last commit point is rolled back, so the
   player sees no duplicate text. The task effects since that point are discarded
   (`discard_task_effects`).
2. If the retry counter has reached `max_task_retries` from `$server_options`, the
   task ends. The log line is "Task retry limit exhausted; aborting task", and it
   names the conflict. The outcome is `Aborted(ConflictRetriesExhausted)` with
   `Kept::No`. Otherwise the counter increases.
3. The task suspends for a randomized backoff that doubles with each retry, with a
   capped exponent.
4. On wake the task gets a **new transaction** and its VM state is restored from
   `retry_state` (`retry_from` in `crates/kernel/src/vm/vm_host.rs`).

The counter goes back to zero at each commit point. So the limit applies to one
stretch between commit points, not to the whole task.

`retry_state` is a snapshot of the VM taken at the last transaction boundary. A task
that never suspended and never forked has its initial state there, so the whole verb
runs again from the first instruction. A task that already crossed a boundary resumes
from that boundary, not from the start.

Retry tasks are never persisted across a server restart.

## What a retry does not undo

This is the part that surprises people. Rolling back the transaction does not roll
back the world.

| Not undone | Why |
|---|---|
| Sequence numbers, including the maximum object number | Sequences live on the shared database handle, not in the working set. A failed transaction still consumed the numbers it allocated. Object numbers are skipped, never reused. |
| Work sent to an out-of-process worker | The request already left the daemon. |
| Anything a builtin did outside the database | The transaction has no record of it. |
| Time | A verb that measures elapsed time sees the retry's clock, not the first attempt's. |

Session output *is* buffered and is rolled back. That is deliberate, and it is why a
retried command does not print twice.

## Two commits you might not expect

Read these before you decide that "the transaction rolls back on failure".

- **An uncaught MOO exception still commits.** The task reports the traceback after
  committing. LambdaMOO behaved this way and mooR keeps it.
- **A task that exceeds its tick or second limit commits by default.** The
  `rollback_on_task_limit` server option changes this to a rollback. It defaults to
  false.
- **A task that kills itself commits.** `kill_task(task_id())` commits, then ends
  the task as aborted with `Kept::Yes`, as in LambdaMOO (`dispatch_kill` in
  `crates/kernel/src/tasks/task/dispatch.rs`). A kill by another task, or by a
  disconnect, rolls back the open transaction. Earlier commit points stay.

## Transaction abort versus task abort

Do not confuse them.

| | Transaction abort | Task abort |
|---|---|---|
| Who decides | The database, at commit | The scheduler or the VM |
| Signal | `CommitResult::ConflictRetry` | `TaskOutcome::Aborted` with an `AbortReason` (`crates/common/src/tasks/outcome.rs`) |
| Effect on world state | Nothing was published | Given by the outcome's `Kept` value: `Yes`, `No` or `Unknown` |
| Effect on the task | It runs again | It ends |
| Visible to MOO code | No | Yes, as an aborted task |

## Invariants

1. **A transaction reads one snapshot for its whole life.** Never let a read reach
   the live root. If you do, a task can observe another task's commit mid-execution,
   and the conflict check will not protect it.
2. **A key that a transaction writes must appear in that relation's working set.** A
   write that bypasses the working set is invisible to the check, and silently
   overwrites concurrent work.
3. **Publication is a compare-and-swap on the root, and nothing else publishes.**
   Any other path that mutates a published index breaks isolation for every reader
   that already holds it.
4. **Persistence happens only after publication, and in version order.** Writing
   before publication would make a rejected transaction durable.
5. **Conflict resolution must be a function of base, theirs, mine and the
   transaction's own property flags only.** The `o` resolver reads the flags from
   the working set, and the policy check proves that they did not change. A resolver
   that reads anything else is not reproducible under retry.
6. **A retry must be safe to run again.** Any code path that commits must be
   re-entrant from `retry_state`.

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| "Task retry limit exhausted; aborting task" in the log | Sustained contention on one key | Read the `conflict` field in the log line; it names the relation and key. Reduce the write to that key, or split the value. Do not write a value that did not change. A wizard can set `o` on a property where the last write may win. |
| `E_QUOTA` "Database writer remained overloaded ... The transaction was not committed." | Commit admission waited longer than `db_commit_queue_timeout_seconds` (default 5 s, in `crates/db/src/lib.rs`) | The disk or the writer cannot keep up. Look for "Database commit queue remains full" warnings, which start after `db_commit_queue_warn_seconds` (default 1 s). The task is not retried. |
| A conflict that names `object_propflags`, `object_parent` or `object_propdefs` on an `o` write | The policy check found that the property flags, definition or parent chain changed | Expected. The task retries. |
| Steady low-level retries under load | Many tasks writing one hot object or property | Application shape, not a server fault. Split the hot value across keys. |
| Two tasks each read the other's state and both commit wrongly | Write skew; no read set is tracked | Make one of them write the key it depended on. |
| Commit succeeds but the change is missing after a restart | The write never reached disk | Read `storage-engine`. Check for batch-writer errors in the log. |
| A conflict with no `ConflictInfo` | The rebase attempts ran out | Rare. Treat as heavy write contention. |
| Object numbers have gaps | Retried or failed transactions consumed sequence values | Expected. Do not "fix" it. |

## Where the code lives

| Path | Responsibility |
|---|---|
| `crates/db/src/tx/transaction.rs` | The per-relation transaction, its local operations, and the working set |
| `crates/db/src/tx/check.rs` | Conflict detection; each conflict goes to a resolver |
| `crates/db/src/tx/resolve.rs` | The resolver trait and `FailOnConflict`, the default |
| `crates/db/src/engine/moor_db/property_policy.rs` | The `o` flag: `property_can_clobber`, `check_property_policies` |
| `crates/db/src/tx/commit_bloom.rs` | The bloom filter used to skip checks and prove disjointness |
| `crates/db/src/engine/moor_db/commit_pipeline.rs`, `commit_pipeline/state.rs` | The check, prepare, admission, publish, rebase and persist stages |
| `crates/db/src/engine/moor_db/snapshot_planes.rs` | The published root and the cache sidecar |
| `crates/db/src/engine/relation_defs.rs` | The macro that generates the per-relation check, apply and rebase code, and the `object_propvalues` resolver |
| `crates/kernel/src/task_context.rs` | The thread-local transaction, and commit and rollback for a task |
| `crates/kernel/src/tasks/task/transaction.rs` | The commit at each boundary, `refresh_retry_state`, and the retry counter reset |
| `crates/kernel/src/tasks/task/dispatch.rs` | Every transaction boundary a task can cross |
| `crates/kernel/src/tasks/scheduler/transitions/retry.rs` | The retry decision, the backoff, and the retry limit |
| `crates/db/tests/jepsen_history.rs` | Replays a generated history and asserts the expected outcomes |
| `crates/db/src/engine/moor_db_concurrent_tests.rs` | Schedule exploration with the model checker |

## Read first, read next

Read `moor/storage-and-state/world-state-model` to know which relation a given MOO
operation writes; that is what decides your conflict shape. Read `storage-engine` for
what happens after publication. Read `moor/execution/task-scheduler` for who owns the
transaction boundaries and the retry. Read `moor/working-in-the-repo/testing` before
you change the commit pipeline; the history and model-checker tests are the ones that
catch isolation faults.

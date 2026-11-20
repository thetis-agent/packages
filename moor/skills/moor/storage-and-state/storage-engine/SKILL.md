---
name: storage-engine
description: "What mooR keeps in memory versus on disk, how a commit reaches the fjall key-value store, what a snapshot and a checkpoint are, and what a crash costs. Use for questions about mooR's persistence: memory use, the on-disk format, durability guarantees, snapshots, or what survives a crash or restart. Not for conflict detection and retry, the relation model, or object lifetime, which the sibling skills own, and not for the event log or the Torchship database."
metadata:
  title: The storage engine and durability
  tags: [moor, database, storage, fjall, durability, fsync, wait-for-persistence, persistence, batch-writer, backpressure, snapshot, checkpoint, exports, format-version, record-chain, db-compact, commit-queue, startup-time, databaseconfig, restart, crash, memory, database-size, keyspace, moor-db]
  version: 3
---

# The storage engine and durability

The world lives in memory. Disk is the backing store that lets the process start
again. This page states that division exactly, and states what mooR does and does not
promise about a crash.

## The one fact that shapes everything

**At open, every relation is scanned in full from disk into an in-memory index.** The
whole world is resident. Reads never go to disk in steady state.

Two consequences follow, and an operator must plan for both:

- Memory use tracks the world size, not the working set. A large world needs memory
  for all of it.
- Startup cost tracks the world size. A restart re-reads and re-indexes everything
  before it serves anything.

The indexes are persistent immutable maps from `imbl`. Forking one is cheap and
shares structure, which is what makes a per-transaction snapshot affordable.

The relation code still has a path that reads the store when an index is not fully
loaded (`backing_get` and `backing_scan` in `crates/db/src/tx/transaction.rs`).
Today no relation uses it. If you make an index load in part, obey its rules: the
index entry always wins over the store, and a stored row newer than the snapshot
gives a conflict, so the task retries (dde81ff4a).

## The layers

| Layer | Type | What it is |
|---|---|---|
| Root snapshot | `WorldStateSnapshot` | One version number, one committed timestamp, one immutable index per relation, plus the resolution caches and a bloom filter of recent writes |
| Publication planes | `SnapshotPlanes` | Two atomic pointers: the root, and a cache sidecar that read-only commits may update alone |
| Relation index | `RelationIndex` | The in-memory map for one relation, with an optional value-to-keys reverse map |
| Provider | `FjallProvider`, `PropertyValueProvider` | Encoding and decoding for one relation, and its fjall keyspace. `object_propvalues` has its own provider, which stores record chains. |
| Writer | `BatchWriter` | Encoder threads (`moor-db-enc-N`), one rollup encoder (`moor-db-rollup-enc`), and the one writer thread (`moor-batch-writer`) that commits batches to fjall, in version order |
| Store | `fjall` | The log-structured key-value store on disk |

`fjall` is the only storage dependency. It is named in `crates/db/Cargo.toml`. One
fjall keyspace exists per relation, named after the relation, plus a `sequences`
keyspace for counters and markers.

## The on-disk form

A stored value is the encoded value followed by an eight-byte little-endian
timestamp. The timestamp is what makes conflict detection work after a restart: the
recovered index carries the committing transaction's timestamp for every tuple.

Encoding is per type, not universal:

- Fixed-size types are written with `zerocopy`, byte for byte.
- Values, verb definition sets, property definition sets and programs are written as
  FlatBuffers through `planus`.
- Byte-backed types pass through unchanged.

Property values are different. `object_propvalues` keeps each value as a **record
chain** (`crates/db/src/provider/property_value_store.rs` and
`property_value_provider.rs`). The key of a record is the property key and a record
version. A chain is one full record, then zero or more list-append records. Each
record starts with the magic `MPRV` and record format 1. So a verb that appends to a
long list writes only the new elements. A read rebuilds the value from the whole
chain. When a chain reaches 64 records or 4 MiB (`PROPERTY_VALUE_CHAIN_LIMITS`), the
writer replaces it with one full record (a rollup). A value with the `o` flag is
always written as one full record.

The `sequences` keyspace holds a format marker under the key `__db_version__`. The
current format is `3.0.0` (`crates/db/src/provider/fjall_format.rs`). The format
version is independent of the mooR release version. mooR accepts only an exact
match. A database with a different marker is refused at open, rather than misread.

## Startup

| Step | Effect |
|---|---|
| Format check | `fjall_check_format` runs first. An empty database gets the marker. An existing database must have exactly the current marker. There is no migration. |
| Open | The fjall database and the `sequences` keyspace open. |
| Sequence load | Counters are read back. A fresh database starts them at -1. |
| Relation seeding | Every relation is scanned through the provider's `seed()`, into a `RelationIndex`. The highest tuple timestamp becomes the recovered committed timestamp. The property value provider rebuilds each chain and gives the chains to the batch writer (`take_seeded_chains`). |
| Secondary indexes | Indexes that are not on disk, such as the `entity_metadata` value index, are built in memory. |
| Timestamp restart | The monotonic transaction counter starts above the recovered committed timestamp. |

To move a database to a new format, export it to objdef with a mooR version that can
open it, then import the export into a fresh database. The format 3.0 notes in
`fjall_format.rs` give the reason: metadata keys are stored case-folded, and
process-local metadata ids cannot be recovered after the process has stopped.

`try_open` returns a flag saying whether the database was fresh. The daemon imports a
world only when it is fresh; an existing database is never overwritten by an import.

## The write path after commit

Publication and durability are separate.

0. Before publication, the commit reserves a place in the encoder queue
   (`admit_commit`). If the queue stays full for longer than
   `db_commit_queue_timeout_seconds`, the commit fails with `DatabaseOverloaded`
   and nothing is published. See `transactions`.
1. The commit pipeline publishes a new root. Readers see the change immediately.
2. Only then is the batch built from the working sets and handed to the
   `BatchWriter`. An encoder thread encodes it. The number of encoder threads is the
   number of cores divided by 8, rounded up, from 1 to 8.
3. Batches may arrive out of order, because different worker threads win the
   publish and the encoders run in parallel. The writer holds them and commits only
   contiguous versions, so the on-disk state is always a prefix of the published
   history.
4. Each version becomes one cross-keyspace fjall write batch. Dirty
   sequence counters ride along in the same batch. For property values, the writer
   turns each change into a full record, a list-append record, or a delete, and
   removes the old records of a replaced chain. A rollup is encoded on the rollup
   encoder thread.
5. A completed-version counter advances. Barrier and snapshot waiters are released.

If encoding or enqueueing fails, the failure is fatal. The log shows "FATAL:", and the
database signals a fatal database error. It does not continue with a hole in its
history.

## Durability: what is actually promised

Read this before you tell anyone that a commit is durable.

- **Nothing in the database crate requests an fsync for world state.** Search
  `crates/db/src` for a persist call and you find calls only in the tests of
  `crates/db/src/engine/moor_db.rs`.
- `TxDB::wait_for_persistence` waits for the batch writer to commit the currently
  published version into fjall. Its own documentation says this is not an fsync and
  not a flush. It is an application-level handoff.
- `TxDB::checkpoint` is a trait method that currently does nothing. It is marked as
  such in the source.
- A clean shutdown drains the writer. `MoorDB::stop` reports an error if the writer
  stopped before it reached the published version, and the `Drop` implementation calls
  it.

So: a **clean stop** keeps everything. A **process crash** loses whatever the writer
had not yet committed. A **machine crash** additionally depends on the store's own
journal flushing behaviour, which mooR does not override. If you need a stronger
promise, the honest answer is a checkpoint export, not a claim about the write path.

## Two things called a snapshot

Keep them apart.

| Name | What it is | Used for |
|---|---|---|
| Root snapshot | The published in-memory index set | Every transaction's read view |
| `SnapshotInterface` | A read-only cross-keyspace view of the on-disk store, taken after the writer has committed through a given version | Export and checkpoint |

`Database::create_snapshot` asks the batch writer for the second kind, waiting up to a
fixed timeout for the published version to be committed. `create_snapshot_async` does
the same on a separate thread and calls back. The returned reader decodes the
keyspaces directly, so it never touches a live transaction.

## What a checkpoint is

A checkpoint is an **export**, not a database flush.

1. The scheduler gets a ticket from the maintenance coordinator
   (`crates/kernel/src/tasks/maintenance.rs`). Only one checkpoint or storage
   compaction runs at a time. A second request is refused with
   `CheckpointInProgress` or `StorageMaintenanceInProgress`.
2. It requires an output directory in the import and export configuration. Without
   one, the checkpoint fails and logs "Cannot checkpoint as output directory not
   configured".
3. It takes an asynchronous storage snapshot.
4. It writes an objdef directory named `checkpoint-<epoch>.in-progress`, then a
   `manifest.json` in it with the counts and timings.
5. On success the directory is renamed to `checkpoint-<epoch>.moo`. A directory left
   with the in-progress name means the export did not finish.

Blocking and non-blocking modes exist. `dump_database()` returns as soon as the
checkpoint is requested; `dump_database(1)` suspends the task until it finishes.
`moor/content-pipeline/objdef-format` owns the format of what is written.

A **storage compaction** is a different operation. `db_compact([relations])` waits
for the writer to commit the published state, then runs a fjall major compaction of
each named relation (`compact_relations` in `crates/db/src/engine/moor_db.rs`,
`crates/db/src/provider/fjall_maintenance.rs`). It changes disk use, not data.

A checkpoint always writes objdef. The daemon still accepts an export-format option,
but it is deprecated, hidden and ignored, and it says so in its own help text. The
book still lists textdump as a checkpoint format; it is not one.

## Tuning and observation

| Knob or counter | Where | Notes |
|---|---|---|
| Per-relation memtable size | `DatabaseConfig` in `crates/db/src/config.rs` | Two relations, `object_verbs` and `object_propvalues`, get larger memtables by default because they take the most write pressure |
| Commit queue | `db_commit_queue_warn_seconds`, `db_commit_queue_timeout_seconds` in `$server_options` | When a waiting commit is logged, and when it fails with `DatabaseOverloaded` |
| Storage maintenance counters | `StorageMaintenanceStats` from `Database::storage_maintenance_stats` | Write buffer bytes, outstanding flushes, active compactions, completed compactions, compaction time, journal count and size, disk size |
| Database counters | `db_counters()`, exposed to MOO as a wizard-only builtin | Commit phase timers, batch-writer backpressure, commit queue timeouts, property list-append and rollup counts. The `CrdtResolve*` counters are no longer incremented. |
| Cache statistics | The cache statistics types in `crates/db/src/cache` | Hits, negative hits, misses per cache |

`DatabaseConfig` also names two settings, `object_contents` and `object_children`,
that no relation uses. Setting them does nothing.

Do not write current default values into code or documentation. Read them from
`crates/db/src/config.rs` and from the daemon's own argument help.

## Invariants

1. **The durable state is a prefix of the published history.** Versions are committed
   in order and never skipped. A change that lets a later version land first makes
   recovery incoherent.
2. **A tuple's stored timestamp is the timestamp of the transaction that wrote it.**
   Recovery depends on it. Do not rewrite a value without carrying its timestamp.
3. **Publication happens before persistence, never after.** Reversing this would make
   a rejected transaction durable.
4. **A failure in the write path is fatal, not recoverable.** Continuing after a lost
   batch would leave memory and disk permanently disagreeing.
5. **The format marker is checked at open, for an exact match.** Never bypass it to
   "just open it". A format change goes through an objdef export and a fresh import.
   If you change the on-disk form, change `CURRENT_DB_VERSION`.
6. **A property value chain is owned by the batch writer.** Only the writer
   allocates record versions and removes old records. A read must use the whole
   chain.

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| "Slow batch encoding" or "Slow Fjall batch commit" warnings in the daemon log | Storage cannot keep up, or one value is very large | Check disk latency. The encoding warning names the slowest target, including the property name. Split large property values. |
| "Database commit queue remains full", then `E_QUOTA` in tasks | The encoders and the writer are behind for longer than the commit queue timeout | Same as above. The refused tasks did not commit and are not retried. |
| Rising batch-writer backpressure counters | Sustained write rate above what the device can take | An operator problem, not a code problem. Faster storage, or fewer and smaller writes. |
| "FATAL" and a database error at commit | Encode or enqueue failure | The process signals a fatal database error. Do not restart into the same fault without reading the message. |
| Startup takes minutes | The full relation scan on a large world | Expected. Measure it before assuming a fault. |
| Open refused: "invalid database format at ...: Database format X cannot be opened as 3.0.0; export it with a compatible mooR version and import it into a fresh database" | The database was written in another format | Do not delete it. Open it with the version that wrote it, export objdef, and import into a new directory. |
| Open refused: "Existing database has no format version; ..." | A database from before format markers, or a damaged `sequences` keyspace | The same export and import. |
| Open refused: "failed to seed relation ... from database at ..." | A stored tuple or property record does not decode, although the format marker matched | Do not delete it. The message names the relation. Find the build that wrote it. |
| A commit is missing after an unclean stop | The writer had not committed it | Expected under the durability model. Use checkpoints for anything that must survive. |
| A checkpoint directory keeps the `.in-progress` extension | The export failed part way | Read the error in the log. The rename is the last step. |

## Where the code lives

| Path | Responsibility |
|---|---|
| `crates/db/src/lib.rs` | `TxDB`, the `Database` trait, open errors, maintenance statistics |
| `crates/db/src/engine/moor_db.rs` | Open, seed, sequences, shutdown, snapshot creation |
| `crates/db/src/engine/moor_db/snapshot_planes.rs` | The root pointer and the cache sidecar |
| `crates/db/src/provider/mod.rs` | The `Provider` trait: get, put, del, scan, stop, and the default `seed()` |
| `crates/db/src/provider/fjall_provider.rs` | Per-type encoding, decoding, and the keyspace handle |
| `crates/db/src/provider/property_value_provider.rs`, `property_value_store.rs` | Property value record chains: the record codec, rebuild at seed, chain limits |
| `crates/db/src/provider/batch_writer.rs`, `batch_writer/` | Commit admission, the encoder and rollup threads, the ordered writer, barriers and snapshot waiters |
| `crates/db/src/provider/fjall_snapshot_loader.rs` | The read-only on-disk reader used for export |
| `crates/db/src/provider/fjall_format.rs` | The format marker and its exact-match check |
| `crates/db/src/provider/fjall_maintenance.rs` | Major compaction for `db_compact()` |
| `crates/db/src/tx/indexes.rs` | The in-memory index implementations |
| `crates/db/src/config.rs` | `DatabaseConfig` and per-relation keyspace options |
| `crates/kernel/src/tasks/checkpoint.rs` | The checkpoint export and its manifest |
| `crates/kernel/src/tasks/storage_compaction.rs`, `maintenance.rs` | Storage compaction on a background thread, and the one-at-a-time maintenance rule |
| `crates/daemon/src/lib.rs` | Opening the database at startup and the first import |
| `crates/db/tests/save_restore.rs` | Writes a world, reopens it, and verifies it came back |

## Read first, read next

Read `transactions` first; publication order only makes sense once you know what a
commit publishes. Read `world-state-model` for what the relations mean. Read
`moor/content-pipeline/objdef-format` for the checkpoint output, and
`moor/content-pipeline/textdump-compat` for the other import path. Read
`moor/working-in-the-repo/build-and-run` for where the database directory sits in a
running deployment.

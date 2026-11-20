---
name: workers
description: "Why blocking or untrusted work runs outside the daemon in mooR, how worker_request() dispatches to a worker process, and how to write a new one. Use when MOO code must reach something outside the database — outbound HTTP, files, or any new capability — or a task hangs or a worker never answers. Not for the RPC between hosts and the daemon (read daemon-and-rpc), and not for the FlatBuffer message definitions (read wire-schema) or scheduler internals (read moor/execution/task-scheduler)."
metadata:
  title: mooR out-of-process workers
  tags: [moor, workers, worker-request, moor-curl-worker, moor-git-worker, git-worker, gix, moor-file-worker, moor-runtime-api, moor-zmq-client, attach, ping, detach, e-invarg, outbound-http, filesystem, capability, sandbox, python-worker, zeromq, metrics, builtin-grant]
  version: 3
---

# mooR out-of-process workers

A worker is one capability the daemon deliberately refuses to have. MOO code asks
for it with `worker_request()`, the task suspends, a separate process does the
work, and the answer wakes the task. Workers are how mooR keeps "the database
server" and "the thing that talks to the internet" in different processes with
different privileges.

## Why not just do it in the daemon

Three reasons, in order of weight.

1. **Blocking.** The daemon runs the scheduler and the VM. An outbound HTTP call
   or a filesystem read can take seconds or never return. Anything that blocks
   inside the daemon blocks tasks that have nothing to do with it.
2. **Privilege.** The daemon holds the world database and the signing keys. It
   should not also hold network egress and filesystem write. A worker can run as
   a different OS user, in a different container, or on a different machine with
   a different firewall policy.
3. **Refusability.** An operator must be able to say no. A capability that lives
   in a separate binary is off by default simply by not being started. The file
   worker is the clearest case: it is not embedded in the single-process `moor`
   binary and a normal installation does not run it. The curl and Git workers
   can run inside `moor`, but only with `--enable-curl-worker` or
   `--enable-git-worker` (or the matching `services:` keys).

The corollary is a rule: **never add an outbound network call or a filesystem
call to the daemon on behalf of MOO code.** If you want a new capability, you
want a new worker.

## The shape of the protocol

Two ZeroMQ sockets, mirroring the host protocol.

| Direction | Pattern | Endpoint (daemon side) | Carries |
|---|---|---|---|
| Daemon to worker | PUB/SUB on the worker broadcast topic | `--workers-request-listen` | Ping, work requests, "please die" |
| Worker to daemon | REQ/REP | `--workers-response-listen` | Attach, pong, result, error, detach. A frame the daemon cannot decode is answered `WorkerRejected` |

Security follows the endpoint scheme exactly as it does for hosts: `tcp://` gets
CURVE and requires enrollment, anything else does not. See `daemon-and-rpc`.

The life of a request:

1. MOO code calls `worker_request(worker_type, args [, options])`. It needs a
   wizard, or a task authority with an explicit builtin-call grant for
   `worker_request` (`require_wizard_or_builtin_call`).
2. The VM returns a suspend instruction. The scheduler **commits the task's
   world-state transaction**, then mints a request UUID and hands the request to
   the workers server, and parks the task on that UUID. If the daemon has no
   worker channel at all, the task aborts with an internal reason, "no workers
   are configured".
3. The daemon picks an attached worker whose type symbol matches, preferring the
   one with the fewest queued requests. If there is none, the task is failed
   immediately with a no-worker-available error.
4. The request is published on the shared worker topic. It carries the target
   worker UUID, the request UUID, the authority principal, the argument list and
   a timeout in milliseconds (zero meaning none).
5. Every subscribed worker receives it; each discards anything not addressed to
   its own UUID.
6. The worker does the work and sends a result or an error back over REQ/REP.
7. The daemon wakes the parked task with the result, in a **new** transaction.

In the single-process binary the same steps run over in-process channels
instead of sockets. The daemon counts requests per worker type and outcome
(`ok`, `error`, `no_worker`, `detached`) and exports attached-worker and
pending-request gauges with its other metrics.

Workers are pinged on the same cadence as hosts. A worker that misses the worker
timeout is dropped from the registry and every request it had outstanding is
failed with a worker-detached error.

## What a worker may assume about the requesting task

Very little, and this is the part people get wrong.

- **The task's transaction has already committed.** The worker is not inside it
  and cannot be. Whatever the worker does is not atomic with the MOO world, and
  cannot be rolled back by aborting the task. This is stated plainly for the file
  worker in the book, and it is true of every worker.
- **The task may be gone by the time the answer arrives.** It may have been
  killed, or the server may have restarted. A worker must not assume its reply
  will be consumed.
- **The `authority_principal` is context, not authority.** It is the object the
  calling task's permissions derive from. The daemon does not use it to authorise
  the worker; the worker may use it to log or to make its own policy decision.
  The real gate already happened in `worker_request()`'s permission check.
- **The timeout is advisory and the worker enforces it.** The daemon parks the
  task on a wake condition that has no deadline. If a worker accepts a request
  and never answers, and keeps answering pings, the task waits forever.
- **The request is visible to every attached worker.** Dispatch is a broadcast
  with an addressee, not a point-to-point send. Do not put a secret in a worker
  request and assume only the target sees it.

## The workers that exist

| Worker | Type symbol | Capability | Notes |
|---|---|---|---|
| `crates/curl-worker` | `curl` | Outbound HTTP | Embeddable in the single-process binary; the usual default worker |
| `crates/git-worker` | `git` | Read-only access to public HTTP(S) Git repositories through `gix`: `capabilities`, `refs`, `tree`, `read`, `snapshot` | Embeddable with `--enable-git-worker`. Each job runs in a child process (`--git-job`) on a disposable bare repository, under byte, entry, memory, time and concurrency limits; no checkout, hooks, credentials, local paths or redirects. A full slot answers a `busy` error value, not a `WorkerError` |
| `crates/file-worker` | `file` | Reads and writes inside one directory | Opt-in only. Requires `--sandbox-dir` and never embeds in `moor` |
| `tools/example-python-worker` | `echo` in the sample | Nothing; it is a protocol proof | Shows that the protocol is language-neutral |

The file worker's sandbox is worth studying as the model for any worker that
touches the host. It opens the sandbox root once as a directory capability and
resolves every request path through it, so lookup stays confined even if
directories or symlinks change underneath. Its error messages mention only the
caller's relative path, so host layout does not leak back to MOO code. The Git
worker is the model for a network worker: it checks the URL itself, bounds
every resource, and does the blocking work in a child process it can kill at
the deadline. Its request protocol is versioned (`"schema" -> 1`) and is
documented in `book/src/the-system/server-configuration.md`.

## Writing a new worker

1. **Decide the type symbol.** It is the first argument to `worker_request()` and
   the only routing key. Pick a short noun.
2. **Decide the request and reply shape.** Both are lists of MOO `Var`. Keep them
   simple and self-describing; there is no schema for a worker's payload, so the
   contract is between the worker and the MOO code that calls it.
3. **Take the standard connection arguments.** Reuse `RpcClientArgs` from
   `moor-runtime-api` so your worker accepts the same addresses, data directory
   and enrollment token file as everything else.
4. **Call `setup_curve_auth`** with your service type string. It returns no keys
   for an IPC address and enrols for a TCP one.
5. **Write the perform function**: request id, worker type, authority principal,
   arguments, optional timeout, returning a `Var` or a `WorkerError`. Enforce the
   timeout yourself.
6. **Run `worker_loop`** from `moor-zmq-client` with a fresh worker UUID. It
   handles attach, ping, addressing, decoding and replying.
7. **Add a health endpoint and metrics** if the deployment expects them. The
   curl and file workers expose a trivial TCP port that reports unhealthy once
   the daemon's pings stop. Flatten `MetricsFileArgs` from
   `moor_zmq_client::metrics` to get `--metrics-file` and
   `--metrics-interval-seconds`, as the curl and Git workers do.
8. **Choose the right `WorkerError`.** The variants are the vocabulary MOO code
   sees: permission denied, invalid request, internal error, request timed out,
   request error, worker detached, no worker available. Do not collapse
   everything into an internal error.
9. **Document the capability and its risk**, the way `book/src/the-system/file-worker.md`
   does. A worker is an operator decision, so an operator needs to be able to
   make it.

To write a worker in another language, generate bindings from the `.fbs` files
(see `wire-schema`) and implement the same two sockets. The Python example is the
working reference, including its regeneration command.

## Invariants

1. **The daemon performs no outbound I/O for MOO code.** Every such capability is
   a worker.
2. **A worker request crosses a transaction boundary.** The task committed before
   the request went out and resumes in a new transaction. Nothing the worker does
   is atomic with the world.
3. **A worker answers with exactly one result or one error per request id.** The
   daemon matches on that id; a second answer has nowhere to go.
4. **A worker enforces its own timeout.** The scheduler will not rescue it.
5. **`worker_request()` needs a wizard or an explicit builtin-call grant.** Do
   not add a path that reaches a worker without that check.
6. **A worker ignores requests not addressed to its own UUID.** Dispatch is a
   broadcast.
7. **A worker confines its capability itself.** The daemon passes no policy. The
   file worker's sandbox root is the pattern.

## Where the code lives

| Path | Responsibility |
|---|---|
| `crates/kernel/src/vm/builtins/bf_connection.rs` | The `worker_request()` builtin: permission check, option parsing, suspend |
| `crates/kernel/src/tasks/scheduler/transitions/suspend.rs` | Turning the suspend into a request and parking the task |
| `crates/kernel/src/tasks/scheduler/services.rs` | The response loop that wakes parked tasks |
| `crates/kernel/src/tasks/workers.rs` | The scheduler-side request and response types |
| `crates/daemon/src/workers/message_handler.rs` | The worker registry, selection, dispatch, ping, expiry and metrics, including in-process workers |
| `crates/daemon/src/workers/server.rs`, `transport.rs` | The workers REP socket and its loop |
| `crates/runtime-api/src/worker.rs`, `worker_messages.rs` | The typed worker vocabulary and message builders |
| `crates/zmq-client/src/worker_loop.rs`, `worker_rpc_client.rs`, `metrics.rs` | The reusable worker main loop and its metrics file |
| `crates/curl-worker/`, `crates/git-worker/`, `crates/file-worker/` | The three shipped workers |
| `crates/server/src/main.rs`, `local_services.rs` | Embedding the curl and Git workers in `moor` |
| `tools/example-python-worker/` | Cross-language reference implementation |
| `book/src/the-system/file-worker.md` | The operator-facing case for why this is opt-in |
| `book/src/the-system/server-configuration.md` | Git worker setup, limits and request protocol |

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| `worker_request()` fails immediately, no worker available | No worker of that type is attached | Start the worker; check its type symbol matches the call exactly |
| The task aborts with "no workers are configured" | The daemon was started with workers disabled, so there is no worker channel at all | Enable the worker transport on the daemon, or `--enable-curl-worker`/`--enable-git-worker` on `moor` |
| A Git request returns a `busy` error value | Every Git job slot is in use | Retry later or raise `--max-concurrent-requests`. It is a value; the task did not fail |
| The task suspends and never returns | The worker accepted the request, is still answering pings, and never replied | Look at the worker's own logs. The scheduler has no deadline for this; kill the task |
| Tasks fail with worker detached | The worker missed the ping timeout, or exited | Every request it held was failed. Restart it; consider running more than one worker of that type |
| Requests reach the wrong worker | Two workers share a type symbol, which is legal, and the work is not idempotent | Selection is by queue depth, not by affinity. Do not assume one worker |
| Worker connects but receives nothing over TCP | CURVE key not enrolled | See the enrollment failure table in `daemon-and-rpc` |
| Worker arguments look swapped in the command line | The help text on `--workers-request-address` and `--workers-response-address` in `RpcClientArgs` describes them the wrong way round | Trust the daemon's own `--workers-request-listen` (PUB, daemon to worker) and `--workers-response-listen` (REP, worker to daemon) |
| File worker rejects a path | The path escaped the sandbox root | Correct behaviour. Move the file inside the sandbox; do not widen the root to the database directory |

## Read first / read next

- Read `moor/execution/task-scheduler` for suspension and wake conditions; a
  worker request is one wake condition among several.
- Read `moor/storage-and-state/transactions` to understand what "the transaction
  already committed" costs you.
- Read `moor/execution/permissions-and-security` for the wizard check and
  builtin-call grants.
- Read `daemon-and-rpc` for enrollment and CURVE, which are shared with hosts.

# mooR vocabulary

The words this codebase uses, and what each one means here. Many are inherited from
LambdaMOO and carry thirty years of assumed meaning. A word used loosely in this
system causes a real defect, because the same word often names a database concept, a
language concept, and a process at the same time.

Read this before your first change. It is the cheapest way past the vocabulary
barrier.

## The world

| Term | Meaning here |
|---|---|
| MOO | Two things. The kind of system: a multi-user, programmable, persistent shared world. And the language its verbs are written in. Context decides which. |
| LambdaMOO | The 1990s server this project re-implements. It is the compatibility target, not the design model. |
| ToastStunt | A later LambdaMOO fork. Some of its extensions are supported; support is partial by intent. |
| core | A database that holds a working world: its objects, its verbs, and its conventions. A server without a core starts but has nothing to be. Bundled cores live under `cores/`. |
| world state | The current contents of the database as the running system sees it: every object, property, and verb, under a transaction. |
| object | A persistent, permissioned entity with a number, an owner, a parent, properties, and verbs. |
| player | An object flagged as able to hold a connection. Not a separate type. |
| wizard | An object flag that grants full authority. Treat any code that runs with it as trusted. |
| programmer | An object flag that permits compiling verbs. |
| parent | The single object a given object inherits properties and verbs from. Inheritance is by prototype, not by class. |
| ancestry | The chain of parents from an object to the root. Property and verb lookup walks it, so it is cached. |

## The language and its values

| Term | Meaning here |
|---|---|
| verb | A named, permissioned program attached to an object. The unit of authored behaviour. |
| property | A named, permissioned value slot on an object. |
| builtin | A function the engine provides, callable from MOO code. Builtins are implemented in Rust and grouped by subject. |
| var | The runtime value type. Every MOO value is one. Values are immutable. |
| symbol | An interned name. Used where a string would otherwise be compared and hashed repeatedly. |
| flyweight | An immutable, value-typed, lightweight entity with slots, a contents list, and a delegate object that answers its verb calls. It has no object number and is not stored in the object table. Use it where an object would be too heavy. |
| error as value | A MOO error is an ordinary value that can be returned, stored, and tested, as well as raised. |
| opcode | One instruction of the compiled form of a verb. |
| program | The compiled form of a verb, as stored in the database. A verb's program is MOO bytecode, or a native program that names a library function. |
| native verb | A verb whose body is a function in a native library the administrator lists at daemon start. Only wizards bind one. It runs as the verb owner, and a crash in it stops the server. |
| objdef | The directory-based, version-controllable source format for a database. |
| package | An objdef directory with a `package.moo`: a name, an `objdef_version`, `depends`, and its own constant namespace (`pkg::NAME` from outside). Cowbell is a world of packages. |
| baseline | The `objdef_base` metadata on an object: per verb, the fingerprint of the program last accepted from source. Review compares source and live code against it. |
| review | `preview_objdef_changes()` then `apply_objdef_changes()`: a guarded update of verb programs from source, which tells upstream changes from local edits and conflicts. Not the same as direct `load_object()`. |
| textdump | The single-file LambdaMOO database format. |

## Execution

| Term | Meaning here |
|---|---|
| task | The unit of execution *and* the unit of transaction. Almost every question about correctness in this system reduces to where a task begins and ends. |
| task outcome | `TaskOutcome`: how a task ended (`TaskEnding`: completed, suspended, aborted, result lost) together with `Kept`, whether its last transaction committed (yes, no, unknown). The two are independent: an uncaught error keeps changes; a cancel does not. Every RPC reply for a task that ran carries one. |
| abort reason | `AbortReason`: why an aborted task stopped, such as a limit, an uncaught exception, verb not found, command failed, cancelled, killed, `rollback()`, conflict retries exhausted, a deadline, or an internal error. |
| native schedule | A deadline or cadence held by the kernel scheduler (`schedule_at()`, `schedule_every()`) that starts a verb when due. It survives restart and uses no task while idle. |
| tick | The unit of execution cost. A task has a budget in ticks and in seconds. |
| activation | One frame of the call stack inside the VM. |
| suspend | A task stops and gives up its place, to be resumed later. |
| fork | A task starts a second task, to run later or concurrently. |
| permissions | The identity a task runs as when it reads or writes the database. Not the same as the verb's owner and not the same as the caller. |
| capability grant | An explicit delegation of authority, narrower than the wizard flag. |
| command parser | The engine code that turns a line typed by a player into a verb call, with a direct object, a preposition, and an indirect object. |
| matching | Resolving a name a player typed to an object they can see. |

## Processes and protocol

| Term | Meaning here |
|---|---|
| daemon | The process that holds the database, the scheduler, and the VM. One per world. |
| host | A process that speaks one user-facing protocol and relays to the daemon. The telnet host and the web host are the two main ones. |
| worker | A process the daemon delegates an outside-world operation to, such as an HTTP request or a file read. It exists so the daemon never blocks and never holds an unsafe capability. |
| session | The daemon-side handle for one connected participant. It carries output to that participant and survives more than a single request. |
| connection | The transport-level link a host holds. A connection may exist before it is associated with a player object. |
| presentation | Structured content a verb sends to a client for display beyond plain text. A rich client renders it; a line-oriented client degrades it. |
| enrollment | The procedure by which a host or a worker proves it may talk to a daemon and receives its credentials. |
| event log | The daemon's durable record of what was sent to participants, used to replay history to a client that reconnects. |
| ephemeral event | Data sent with `emit_data(..., ['ephemeral -> true])`. It is never written to the event log, and is delivered best-effort over the fastest transport. |
| transient connection | A connection the daemon opens for one captured call or system handler, so output the verb sends to its player's connections returns to the caller. It closes when the call ends. |

## Development

| Term | Meaning here |
|---|---|
| Moot | The declarative test harness. A Moot file states MOO input and expected output, and runs against a real world. |
| checkpoint | An objdef export of the whole database, written from a read-only snapshot while the server runs. |
| mootop | The tool that shows a running daemon's CPU use by verb, builtin and task, through bpftrace and USDT probes. |
| metrics file | The Prometheus text file the daemon writes with `--metrics-file`. The same snapshot is also served by RPC and to `mootop`. |
| single-process | The build that puts daemon and hosts in one binary. Convenient for development. It does not change the architecture; it only removes the process boundaries. |

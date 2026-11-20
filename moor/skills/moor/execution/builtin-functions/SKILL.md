---
name: builtin-functions
description: "How bf_* builtins are numbered, registered, and called; the argument and error conventions; and the steps to add one with its docs and tests. Use when adding, changing, or debugging a builtin function in the mooR server: a bf_* module, the builtin id table, argument and error conventions, a builtin trampoline that calls MOO verbs, or a builtin-signature decode error. Not for the opcode loop or activation stack, the scheduler, the permission model in general, or the compiler. Not for the Torchship database or Thetis's own internals."
metadata:
  title: mooR builtin functions
  tags: [moor, builtin, bf, bf-modules, builtins-rs, bfcallstate, bfret, bferr, e-args, e-type, e-perm, function-help, function-info, call-function, bf-name-override-verb, trampoline, adding-a-builtin, builtin-signature-mismatch, native-verbs, task-local, suspend-if-needed, ctime]
  version: 3
---

# mooR builtin functions

A builtin is a Rust function called from MOO by name. The compiler turns the name
into a numeric id at compile time and stores that id in the program. The VM looks
the id up in a registry of function pointers and calls it.

Read `virtual-machine` first. A builtin runs inside the VM's activation stack and
inside the task's transaction, and both facts constrain what it may do.

## Numbering is frozen

Builtin ids are embedded in compiled programs, and compiled programs are stored in
the database. Reordering or removing a builtin changes ids and invalidates every
stored program.

The id table is `crates/common/src/builtins.rs`. It is divided into fixed-size
groups, one per `bf_*` module, each padded out with reserved entries. Reserved
entries are hidden from name lookup and from `function_info()` but still occupy
their ids. That padding is the whole point: a new builtin appends inside its own
group and no other group moves.

The group ordering is: server/system, connection/network, task/scheduler,
numeric/math, value conversion and introspection, string/binary/encoding,
list/set/regex, map, object/command, object load and dump, verbs, properties,
flyweights, documents/formats, cryptography, algorithms. Group size is a constant
in that file; read it there rather than from here.

Stored programs carry a fingerprint of the builtins they use
(`builtin_signature_for_ids`). Since d5f986817, programs are stored as version 7,
and the fingerprint covers only each used builtin's id, name, override name and
flags, not its declared argument counts or types. So a declaration can widen
without breaking stored programs. If an id comes to mean a different builtin,
decoding fails with a builtin signature mismatch rather than silently calling the
wrong function. Version 6 and older programs are checked against a frozen copy of
the old table and the declarations each later change replaced
(`crates/common/src/builtins/legacy.rs`, `legacy_table.rs`). Older builds refuse
version 7.

`crates/kernel/src/vm/builtins/ADDING-BUILTINS.md` is the short in-repo version of
this rule. Follow it.

## How a call reaches the function

1. The compiler resolves the name to a `BuiltinId` and emits a function-call
   opcode. An unknown name is a compile error, unless the caller asked for the
   permissive option that rewrites it into `call_function`.
2. The VM yields `DispatchBuiltin`.
3. Before calling anything native, the VM checks for an override: a verb named
   `bf_<name>` on `#0`. If it exists, and the caller is not `#0` itself, that verb
   is called instead. A per-transaction bit set caches the absence of each proxy
   so the lookup is paid once.
4. A `Bf` activation is pushed. It copies the calling verb's flags, so the `d`
   flag behaviour follows the caller.
5. The registry maps the id to a function pointer and calls it.
6. The result is turned into a return, an error, or a VM instruction.

An id with no registered implementation gets a no-op that raises `E_INVIND`
naming the function. That is what an entry declared in the table but never
implemented does at runtime.

## The calling convention

Every builtin has the same Rust shape: it takes a `BfCallState` and returns either
a `BfRet` or a `BfErr`.

`BfCallState` gives the builtin its name, its arguments, the whole `ExecState`,
the feature config, and the native verb libraries the daemon loaded. It does
**not** carry the world state, the session, or the scheduler client. Those come
from the task's thread-local context through `with_current_transaction` and its
mutable form.

| Return | Meaning |
|---|---|
| `BfRet::Ret(v)` | Success with a value. Returning the none type is a debug assertion failure. |
| `BfRet::RetNil` | Success with no meaningful value. Becomes integer zero. |
| `BfRet::VmInstr(e)` | Hand an `ExecutionResult` back to the VM: dispatch a verb, suspend, fork, roll back. |

| Error | Meaning |
|---|---|
| `BfErr::ErrValue(e)` | An error carrying a message. Prefer this; the message reaches the MOO programmer. |
| `BfErr::Code(c)` | A bare error code, when compatibility requires no message. |
| `BfErr::Raise(e)` | An error that should be raised rather than offered as a value. |
| `BfErr::Rollback` | Ask the task to roll back and retry. Never construct this by hand from a world state error; use the world-state error helper, which maps a rollback-retry to this and everything else to a MOO error. |

Argument arity is **not** checked by the compiler or by the dispatcher. Every
builtin checks `args.len()` itself and returns `E_ARGS`. The table's declared
minimum and maximum exist to answer `function_info()`, not to enforce anything.
Type errors are `E_TYPE`, bad values are `E_INVARG`, denied permission is `E_PERM`.

Use the boolean helper on `BfCallState` rather than constructing a boolean
directly. Whether truth values come back as booleans or as integers is a feature
flag, and cores depend on the old behaviour.

## Permission helpers

`BfCallState` exposes two different notions of identity, and choosing wrong is a
security bug.

| Call | Use it for |
|---|---|
| `task_permissions()` | Database authorisation. The current task authority with the flags cached at call setup. |
| `task_authority()` | Builtin-level wizard, programmer, and owner checks. The same principal, but with flags re-read from the transaction, so a change made earlier in the same task is seen. |
| `caller_perms()` | Only for the `caller_perms()` builtin. Never for authorisation. |

The `require_*` helpers on `BfCallState` wrap the common patterns: wizard only,
programmer only, owner or wizard, and each of those with a capability-grant
escape hatch. Prefer a helper over an open-coded flag test, because the helpers
also honour capability grants. See `permissions-and-security`.

## What a builtin may not do

- **It may not commit or roll back.** Only the task loop does that. A builtin that
  wants a commit returns a suspend instruction; a builtin that wants a rollback
  returns `BfErr::Rollback` or a rollback instruction.
- **It may not block.** It holds a thread-pool worker and an open transaction for
  as long as it runs. Waiting on the network or on a subprocess goes through
  `worker_request()`, which suspends the task instead. See `moor/services/workers`.
- **It may not suspend the thread itself.** Suspension is a VM instruction that
  the task loop acts on after it has committed.
- **It may not loop unboundedly without paying ticks.** Opcode ticks are counted
  by the interpreter, not inside native code. A builtin with an unbounded internal
  loop must charge the task through `bf_args.tick_budget().consume_ticks(n)`, which
  raises `E_MAXREC` "Task exceeded ticks limit" when the budget runs out, or it
  escapes the task limits entirely. Recent bulk builtins charge a tick per unit of
  work: `noise_grid()` one per row, the `binary_*` field builtins one per 256
  fields.
- **It may not assume it runs once.** A conflict retry re-runs the task from its
  last commit point, so a builtin with an external side effect can run twice.
- **It may not hold a reference across a suspension.** Only what is stored in the
  builtin frame survives.

## Builtins that call MOO code

Use a trampoline. Write a small integer, and optionally one value, into the
builtin's own frame, then return a `VmInstr` that dispatches the verb. The frame
stays underneath the new activation. When the verb returns, the VM re-enters the
same builtin, which takes the trampoline number back out and continues.

`create()`, `recycle()`, `move()`, and `eval()` all work this way. A builtin that
returns with no trampoline set is assumed finished, and its recorded return value
is unwound immediately. An unrecognised trampoline number is a panic, deliberately.

## Builtins whose rules are not obvious from their names

| Builtin | Rule to keep |
|---|---|
| `noise_2d()`, `noise_grid()`, `random_at()` (`bf_algorithms.rs`, `noise.rs`) | Their results are a contract with every world generated from them: they depend only on their arguments, on every platform and in every release. Unit tests pin exact values. Do not change the algorithm. |
| `binary_pack()`, `binary_unpack()`, `binary_field()`, `binary_set_field()`, `binary_set_fields()` (`bf_values.rs`) | Unsigned fields of 1 to 32 bits, lowest bit first, which may cross bytes. |
| `term_match()`, `term_query()` (`bf_algorithms.rs`) | `term_match` takes a list of binding maps as well as one map; `term_query` indexes facts on their first two scalar elements. `['return -> 'detail]` returns rows with whether the search was complete. |
| `objects_with_metadata(key [, value])` (`bf_objects.rs`) | Leaves out objects the caller may not read. With a value it uses the value index on `entity_metadata`; without one it scans. |
| `command_words()` (`bf_strings.rs`) | The same scanner as the command parser (`util::command_words`). |
| `suspend_if_needed([ticks [, seconds [, mode]]])` (`bf_task.rs`) | Commits and resumes only when fewer than `ticks` (default 4000) ticks or `seconds` (default the smaller of 1 s and half the time limit) remain; `mode` picks ticks, time or both. Returns true when it committed. |
| `task_local()`, `set_task_local()` (`bf_task.rs`) | Wizard-only, or with a builtin-call grant. The value is in `ExecState.task_local`, so it survives suspension and restart, a retry restores it from the last commit, and a fork does not inherit it. `task_local()` returns an empty map when unset. |
| `set_verb_native()`, `native_libraries()` (`bf_verbs.rs`) | Wizard-only. `verb_native()` needs the permission to read the verb's code. A library must have been loaded at startup; a native verb whose library is not loaded raises `E_VERBNF`. `verb_code()` of a native verb raises `E_INVARG`; `verb_code_hash()` hashes its `native "<library>" "<function>"` binding line. `set_verb_code()` makes it a MOO verb again. |
| `ctime([time])` (`bf_server.rs`) | Formats in the host's system time zone through jiff (`TimeZone::system()`), which falls back to UTC; it does not panic on a host with no detectable zone. The zone abbreviation is taken at the exact instant. A time out of range raises `E_INVARG` "ctime() time is out of range" (ad50ae0c4). |
| `dump_database(1)`, `db_compact()` (`bf_server.rs`) | Wizard-only. Both suspend the caller until the maintenance finishes; see `task-scheduler`. |

## Documentation is generated from the source

The doc comments on a `bf_*` function are the documentation. A procedural macro in
`crates/builtin-docs-macro` reads every `bf_*.rs` file at compile time, parses it,
and extracts doc comments **only from functions that a `register_bf_*` function
actually registers**. The result is the table that `function_help()` serves in
world.

The convention the tests enforce: the first doc line is a usage signature, of the
form "Usage:" followed by the return type, the name, and the argument types. Write
it that way, or `function_help()` gives a first line that is not a signature.

An unregistered function's doc comment is silently dropped. If `function_help()`
returns nothing for a builtin you documented, check the registration first.

The book pages under `book/src/the-moo-programming-language/built-in-functions/`
and the status table beside them are hand-written, not generated. They drift. The
generated table and `function_info()` are the authority for what exists.

## Adding a builtin

1. **Choose the group.** It must be the group whose `bf_*.rs` module will hold the
   implementation.
2. **Append the entry** in `crates/common/src/builtins.rs`, at the end of that
   group's block, before the padding call. Never insert into the middle, never
   reorder, never delete. Do not write reserved entries by hand.
3. **Implement** the function in the matching `crates/kernel/src/vm/builtins/bf_*.rs`.
   Check arity first, then types, then permissions, then do the work.
4. **Register** it in that module's `register_bf_*` function, indexed by the
   name-to-offset helper.
5. **Document** it with a doc comment whose first line is the usage signature.
6. **Test** it with a `.moot` file under `crates/kernel/testsuite/moot/`. A moot
   file is MOO input and expected output, which is the right level for a builtin's
   observable behaviour. Add Rust unit tests only for logic that MOO cannot reach.
7. **Check the group has room.** Each group is capped, and the padding helper
   asserts. If a group is nearly full, split it before adding.

Adding a builtin is a database-compatibility change in one direction only: an old
server cannot decode a program that calls a new builtin. Appending never breaks an
existing program. Widening an existing builtin's declared arguments is also safe,
because version 7 fingerprints do not include them; renaming it or changing its
flags is not.

## Invariants

1. **Ids never move.** Appending is safe; anything else invalidates stored
   programs and stored databases.
2. **A registered builtin has a doc comment with a usage line.** The generated
   help table is the only in-world documentation.
3. **A world state error passes through the world-state error helper.** A
   rollback-retry that is turned into an ordinary MOO error breaks the retry
   protocol and produces silent inconsistency.
4. **A builtin never returns the none type.** It is not a valid MOO value.
5. **Permission checks use the live authority, not the cached one**, wherever the
   task could have changed the flags it is testing.
6. **Reserved entries stay reserved.** They are what makes the group scheme work.

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| "Stored program builtin signature mismatch; program data is corrupt or builtin table changed" on load | An id now names a different builtin, a builtin's name or flags changed, or the program data is corrupt. Widening argument counts or types no longer causes it for version 7 programs | Revert the reorder or rename. For a version 6 program, check that `legacy.rs` covers the declaration that changed. |
| `E_INVIND` naming a builtin, at runtime | The id is declared in the table but nothing registered an implementation | Add the registration. |
| Panic: "Unknown builtin: <name>" at startup | A registration names a builtin absent from the table | The table entry and the registration disagree. |
| `function_help()` returns nothing for a new builtin | The function is not registered, or the registration pattern is not the one the macro recognises | Register it with the name-to-offset helper in a `register_bf_*` function. |
| A builtin's error reaches MOO as a plain error where a retry was expected | A world state error was converted directly instead of through the helper | Route it through the helper. |
| Compile error: unknown builtin function | The MOO source calls a name not in the table | Either the name is wrong or the builtin has not been added. |
| A wizard-only builtin is reachable by a player | A `bf_<name>` verb on `#0` overrides it, or the check used cached flags | Check `#0` for the override verb first. |

## Where the code lives

| Path | Responsibility |
|---|---|
| `crates/common/src/builtins.rs` | The id table, the group padding, the signature hash. |
| `crates/common/src/builtins/legacy.rs`, `legacy_table.rs` | Fingerprint checks for programs stored before version 7. Do not edit for new builtins. |
| `crates/kernel/src/vm/builtins/mod.rs` | The registry, `BfCallState`, `BfRet`, `BfErr`, the permission helpers, per-builtin counters. |
| `crates/kernel/src/vm/builtins/bf_*.rs` | One module per group. Implementations and their registration functions. |
| `crates/kernel/src/vm/builtins/ADDING-BUILTINS.md` | The in-repo checklist. |
| `crates/kernel/src/vm/builtins/docs.rs` | One macro invocation; expands to the generated documentation table. |
| `crates/builtin-docs-macro/src/lib.rs` | The macro that reads the `bf_*.rs` sources. |
| `crates/kernel/src/vm/vm_call.rs` | Calling and re-entering a builtin, and the `#0` proxy check. |
| `crates/schema/src/convert_program.rs` | Where the stored-program signature is checked. |
| `crates/kernel/testsuite/moot/` | MOO-level tests. |
| `crates/var/src/json.rs` | `moor_var::json`, the MOO/JSON mapping behind `generate_json` and `parse_json`, shared with the telnet host's GMCP. SYM converts to a JSON string. |

## Read first / read next

Read `virtual-machine` for the frame a builtin runs in and for trampolines. Read
`permissions-and-security` before you write any check. Read
`moor/working-in-the-repo/testing` for how to run a `.moot` file. Read
`moor/language-and-compiler/value-model` for the `Var` and `Error` types a builtin
takes and returns.

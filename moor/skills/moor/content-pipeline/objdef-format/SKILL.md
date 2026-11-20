---
name: objdef-format
description: "How mooR's objdef directories work: file layout, packages, object identity, the multi-pass import, what round-trips, how to load or replace one object safely, and how reviewed program updates use baselines. Use when you read, write, import, export or diff objdef .moo files, or when an import fails to compile a verb or reports a duplicate object. Not for the LambdaMOO textdump format (read textdump-compat), not for choosing or starting a core (read cores-and-bootstrap), and not for the MOO language, the Torchship game database, or Thetis's own internals."
metadata:
  title: "Objdef: a world as a directory of source files"
  tags: [moor, objdef, moo-files, constantsmoo, packagemoo, packages, import-export-id, load-object, reload-object, dump-object, preview-objdef-changes, apply-objdef-changes, objdef-base, baseline, review, clear-clause, native-verb, checkpoint, export, moor-objdef, round-trip, version-control, import-export-hierarchy, define-declarations, include, include-bin, property-overrides, verb-and-method-blocks, parse-objdef-constants, moor-emh, git-upstream, duplicate-object]
  related: [moor/language-and-compiler/compiler-pipeline, moor/storage-and-state/world-state-model]
  version: 2
---

# Objdef: a world as a directory of source files

This skill is written in ASD-STE100 Simplified Technical English.

Objdef is mooR's own database format. One object is one text file. A world is a
directory tree of those files plus a `constants.moo` index, or one or more packages,
each with a `package.moo`. The `moor-objdef` crate
in `crates/objdef` parses, applies, collects and writes them. The grammar lives with
the compiler, in `crates/compiler/src/objdef.rs` and `objdef_literal.rs`.

## Why the format exists

LambdaMOO kept a world in one dump file that only the server wrote. You could not
review a change to it, merge two changes to it, or see which object a diff touched.
Objdef exists to make a world an ordinary source tree.

The consequences are the point of the design:

1. **A world is reviewable.** One object per file means a diff names the object.
2. **A world is mergeable.** Two authors who touch different objects touch different
   files.
3. **A world has a canonical form.** An export is deterministic enough to commit:
   properties are sorted by name, and object references are written as symbolic
   constants instead of numbers where a name exists.
4. **A world can be built from source by a tool, not only by a server.** `moorc`
   compiles a directory into a database without starting a daemon.

The cost is that objdef is not the live world. The database is. The two diverge as
soon as anybody programs from inside the running server.

## Directory layout

| Path | Content |
|---|---|
| `constants.moo` | `define NAME = #n;` for every named object, in a plain directory. Read first, from the root only. |
| `package.moo` | In a package directory, in place of `constants.moo`: a `package "name" [...]` declaration, then the package's `define`s. |
| `<name>.moo` | One object, named from its `import_export_id`. |
| `object_<n>.moo`, `player_<n>.moo` | One object with no `import_export_id`. `player_` when the object has the player flag. |
| `<dir>/...` | A subtree named by the object's `import_export_hierarchy`. |
| `_anonymous_objects.moo` | Every anonymous object of one hierarchy group, in one file. |

The importer collects `.moo` files recursively. Only the `constants.moo` or
`package.moo` in the root of a directory is read first as its constants file; one
deeper in the tree is parsed as an ordinary source file.

### Packages

A directory with a `package.moo` is a package (`crates/objdef/src/package.rs`). The
declaration is `package "name" [objdef_version -> 2, depends -> {...}]`.
`objdef_version` is required, and a newer version than the reader knows is refused.
`depends` names packages to read first; a missing package or a cycle is refused. A
directory may not hold both `package.moo` and `constants.moo`.

- A package's constants are in its own namespace. Inside the package they are
  written bare; elsewhere they are written `pkg::NAME`. A bare name resolves to the
  package's own constant first, then to a global constant of a plain directory.
- A directory with no `package.moo` or `constants.moo` of its own, and at least one
  subdirectory with a `package.moo`, is read as a world of several packages. Its
  members are those subdirectories plus any with a `constants.moo`. Every directory's
  constants are read before any objects.
- Import records each object's package in its `objdef_package` metadata, and the
  package declarations on `#0` in `objdef_packages`. Export writes one directory per
  package, plus an `unpackaged` directory for objects from no package. Set
  `objdef_package` on an object to move it into a package at the next export.
- Verb code in objdef source may name a package object constant as `pkg::NAME`. See
  `moor/language-and-compiler/compiler-pipeline`.

### Declarations that changed

- **`clear` clause.** `property` and `override` declarations accept a trailing
  `clear`, after permissions and metadata and with no `=`, to mark a clear (inherited)
  value. Exports write it (`crates/objdef/src/write.rs`). Importers older than this
  clause cannot read such exports. `override x = clear;` still names a constant
  called `clear`.
- **`native` verbs.** `native NAMES [(argspec)] owner: OWNER [flags: "..."] "library"
  "function" [metadata]` declares a verb whose body is a function in a native
  library. It has no body and no end keyword. Only a wizard may load one: the loader
  refuses it unless `allow_native_verbs()` was set.

## Object identity

An object's number is its identity in the database. Its *name* in the source tree is
separate, and comes from object metadata:

- `import_export_id` gives the constant name (upper case) and the file name (lower
  case).
- `import_export_hierarchy` gives the subdirectory path, as a string or a list.

Both key names are defined in `crates/objdef/src/lib.rs`. Both may also appear as
ordinary properties on old objects; the dumper promotes such a property into metadata
and does not write it out as a property.

The dumper refuses to name an object when its `import_export_id` is not unique, or
when it equals the parent's value and was therefore inherited rather than set. Such
an object falls back to a numbered file name and gets no constant. A duplicate is
logged as a warning, not an error, so a core can silently lose a stable file name.

Where do the identifiers come from on a first import?

| Source | How identity is established |
|---|---|
| Objdef directory | After the load, each package, and the group of objects from no package, decides alone. If **no** object in that group carries an `import_export_id`, one is created for every object of the group named by a constant, from the lower-cased constant name. If any object of the group has one, nothing is inferred for that group. |
| Textdump | From the properties on `#0` that hold object values. See `moor/content-pipeline/textdump-compat`. |

## Constants

`define NAME = <literal>;` declares a constant. Constants are shared across every
file of one import, because the whole set is parsed through one `ObjFileContext`.

Two rules surprise people, and both raise an error at parse time:

1. A constant name may not be declared twice.
2. **Two constants may not have the same value.** `define A = #1; define B = #1;` is
   rejected as a duplicate. The check compares values, not names.

`include!("path")` and `include_bin!("path")` splice a file into a literal position as
a string or as binary. Both resolve relative to the file being parsed, and both are
refused if the resolved path leaves the import root directory.

## What round-trips, and what does not

The engine stores a verb compiled. An export decompiles the stored program and
unparses it. Therefore an export is not the text you wrote.

| Survives export and re-import | Does not survive |
|---|---|
| Object number, name, parent, location, owner, flags | Comments outside verb bodies, and comments inside them |
| Property definitions, values, owner and flags | Original whitespace, indentation and line breaks in verb code |
| Explicit local property values, permission rows and metadata, also when they equal the inherited ones; case-only edits too | Accepted program baselines (`objdef_base`), when the export used `include_baselines` false, as core rebuilds do |
| Clear property values, written as the `clear` clause | |
| Verb names, argument specification, owner, flags, program; a native verb as its library and function names | |
| Object, property and verb metadata maps | Verb order relative to a hand-edited file, if it was edited out of order |
| Anonymous objects, as one grouped file | Suspended and forked tasks. Objdef holds world state only. |

Two mitigations matter. A comment written as a MOO string statement inside a verb is
part of the compiled program, so it survives. Property definitions are sorted by name
on export, and verbs keep their stored order, so repeated exports of an unchanged
world are stable.

## The import path

Import is multi-pass because an objdef may name any object in the set, including one
whose file has not been read yet, and because a verb program may reference a parent
that does not exist yet.

| Pass | What it does | Why it cannot be later |
|---|---|---|
| 1. Parse | `ObjDefSet` in `set.rs`: read each directory's `constants.moo` or `package.moo` first, packages in dependency order, then every `.moo` file. Reject duplicate object definitions. | Constants must exist before any file that uses them. |
| 2. Create placeholders | Create every object in the set with its name and flags, and no parent, location or owner. | Every reference in later passes must resolve to a real object. |
| 3. Attributes | Set name, owner, parent and location, then object flags. | Property definition and verb definition depend on ancestry. |
| 4. Object metadata | Apply the object metadata map. | Identity data must exist before a later dump. |
| 5. Property definitions | Define each locally defined property. | Overrides need the definer to exist. |
| 6. Property overrides | Apply overriding values and permissions. | — |
| 7. Verbs | Add or update each verb, matched by exact names and argspec. | It runs last so the world is complete. |
| 8. Identity and packages | Infer `import_export_id` per package, then record package declarations on `#0`. | It reads the final constants and objects. |

Consequences to remember:

- **Verb bodies compile at parse time; verbs are applied last.** A compile error stops
  pass 1, before anything is written. An error in pass 7 comes after every object,
  property and attribute was applied in the same transaction. The transaction is
  dropped, so nothing lands, but the error you see is late.
- **Unknown builtin functions are allowed during a directory import.** The loader
  turns on `call_unsupported_builtins`, so a call to a function the server does not
  have compiles into a runtime call and fails only when the verb runs.
- **A bulk import does not validate parent references.** Parent validation is off for
  directory and textdump imports. A parent that names an object outside the set and
  outside the database is written as given. There is no error at import time.

## Updating one object directly

Direct import applies what the source says. It has no conflict modes, no per-entity
overrides and no dry run. For a guarded update that compares against an accepted
baseline, use the review builtins in the next section.

| Entry point | Semantics |
|---|---|
| `load_object(source [, options])` builtin, and `load` in `moor-emh` | Create or merge one object definition. Omitted attributes, properties, verbs and metadata entries stay as they are; explicit values apply exactly, defaults included. Validates parent changes. |
| `reload_object(source [, options])` builtin, and `reload` in `moor-emh` | Replace one existing object. Removes local properties, overrides, ordinary metadata and verbs that the source does not name, recreates verbs in source order, and gives missing attributes their creation defaults. |
| `dump_object(obj [, options])` builtin, and `dump` in `moor-emh` | Produce the objdef text for one object, as a list of lines. Options `constants` and `include_baselines` (default true). It reads the calling task's pending changes. |
| `parse_objdef_constants(text)` | Parse a constants file into a map for the `constants` option. |

The options map of `load_object` and `reload_object` takes `constants`, `target`, and
for load only `allocation` (`source`, `next`, `anonymous` or `uuid`). Unknown keys,
bad values and unsupported combinations fail before any write. The old third
argument and the conflict controls are gone. The book's `object-loading.md` is the
reference for the options.

Rules for doing this safely on a live world:

1. **Verbs match only on the exact alias list and argument specification.** A match
   keeps the verb's UUID and lookup position. An overlapping alias alone is not a
   match, so a source that renames a verb's aliases adds a new verb. Two matches, or a
   repeated declaration in the source, fail.
2. **`reload_object` deletes.** Descendants that relied on a removed property lose it.
   Dump the object first.
3. **A target override moves only the declaration.** It does not rewrite references
   inside programs or values. A source that refers to itself in a way that would need
   relocation is rejected (`validate_relocation` in `load.rs`).
4. **Direct import never sets a baseline.** The reserved `objdef_base` metadata key in
   the source is ignored. Merge keeps the tracking of surviving verbs; reload loses it
   for verbs it recreates.
5. **A failure after the first write rolls back the whole task.** `bf_obj_load.rs`
   returns `TaskRollback` once mutation started, so a MOO `try` cannot keep a partial
   import. A transaction conflict retries the task. Parse and option errors raise
   `E_INVARG` or `E_TYPE` before any write.
6. **These builtins are wizard-only and bypass permission checks.** They need a
   wizard or an explicit builtin grant, and native verbs need a real wizard. They run
   against the loader interface, through `with_loader_interface` in
   `crates/kernel/src/task_context.rs`, on the calling task's own transaction. Source
   is limited to 16 MiB, and a source label does not authorise `include!`.

## Reviewed program updates and baselines

A world that was imported from source and then edited live has two versions of each
verb. The review path tells which side changed since the last accepted source, so
an upgrade does not overwrite local edits by accident. The code is
`crates/objdef/src/review*.rs` and `fingerprint.rs`.

- **Baseline.** Object metadata `objdef_base` holds, per verb, the fingerprint of the
  program that was last accepted from source, with `schema`, `program` and an
  optional `source` provenance map. The schema is `objdef-v1:program:sha256`: SHA-256
  over a CBOR encoding of the decompiled program structure, so layout does not count.
  Imports and checkpoints keep baselines; core rebuilds export with
  `include_baselines` false.
- **Preview.** `preview_objdef_changes(sources, request [, choices])` is read-only.
  `request` has `schema -> 1`, an `operation` of `update` or `adopt` (or `inspect`
  for a read-only content diff), explicit `objects` and `fields`. Each row is
  classified `unchanged`, `upstream`, `local`, `converged`, `conflict` or `unbased`.
  The report has `evidence` that binds source, scope, options, identities, authority,
  live programs and baselines.
- **Apply.** `apply_objdef_changes(sources, request, evidence, choices)` revalidates
  the evidence and every choice, then writes programs and baselines in the task's
  transaction. Choices are `incoming`, `local`, `edited` (with a validated draft) or
  `defer`; adoption allows only `incoming` and `defer`. A stale review fails before
  any write.
- **Limits.** 4096 source units and 16 MiB of source, 8192 report rows, 8192 bytes of
  provenance. Automatic eligibility needs administrator-owned, not publicly writable
  objects and verbs, or owners named in `trusted_owners`.
- **Baselines at first import.** `--git-upstream REF` (on `moorc`, `moor`,
  `moor-daemon` and `scripts/dev.sh`) reads the baseline from the unique Git merge
  base of `HEAD` and `REF`, from local history only (`git_baseline.rs`).
  `--baseline-objdef-dir DIR` reads it from a directory. Both act only on an import
  into a new database. A missing or ambiguous ancestor fails.

Cowbell and Snore wrap this in `$change_manager` and `@changes`; Meadow has a review
view. Read `book/src/the-system/object-loading.md` for the full request and report
contract.

## Invariants

1. Every object in an import set exists before any attribute, property or verb is
   applied. Break this and references inside the set stop resolving.
2. One import is one transaction, and it commits once or not at all.
3. Two constants never share a value, and one object ID is never defined twice in one
   set. Both are parse-time errors, not load-time errors.
4. An `include!` path never leaves the import root directory.
5. A whole-world export (checkpoint, `moorc`, `moor-emh export`) is produced from a
   read-only snapshot. `dump_object()` and the review builtins read the calling
   task's own transaction, pending changes included (`collect.rs`), and write
   nothing.
6. An `import_export_id` is unique across the world. When it is not, the dumper drops
   the name and writes a numbered file instead.
7. Direct import never writes `objdef_base`. Only bulk import with prepared baselines
   and `apply_objdef_changes()` write it.
8. A package directory has a `package.moo` and no `constants.moo`.

## Where the code lives

| Path | Responsibility |
|---|---|
| `crates/compiler/src/objdef.rs` | The object definition types, the parse context, and the parse error set. |
| `crates/compiler/src/objdef_literal.rs` | The whole objdef grammar: objects, properties, verbs, literals, `define`, `include!`. |
| `crates/objdef/src/set.rs` | Parse a set of sources, or several directories and packages, into a proposed object graph, with optional baselines. No database effects. |
| `crates/objdef/src/package.rs` | `package.moo` declarations, dependency order, world directories, the `objdef_package` and `objdef_packages` keys. |
| `crates/objdef/src/load.rs` | Apply a graph: placeholders, phases, single-object merge and reload, relocation checks. |
| `crates/objdef/src/collect.rs` | Collect definitions from a live transaction, permission-checked, without writes. |
| `crates/objdef/src/dump.rs` | Collect definitions from a snapshot, choose names, hierarchy and package directories, write the directory. |
| `crates/objdef/src/write.rs` | Serialise one object, with `clear` and `native` forms, and generate `constants.moo` or `package.moo`. |
| `crates/objdef/src/review.rs`, `review_*.rs`, `fingerprint.rs` | Preview, inspect and apply; program fingerprints and the `objdef_base` baseline. |
| `crates/objdef/src/git_baseline.rs` | Baselines from local Git history, for `--git-upstream`. |
| `crates/objdef/src/direct_tests.rs`, `review_tests.rs`, `collect_tests.rs` | The direct-import, review and collection behaviour, as executable specification. |
| `crates/kernel/src/vm/builtins/bf_obj_load.rs` | `dump_object`, `load_object`, `reload_object`, `parse_objdef_constants`, `preview_objdef_changes`, `apply_objdef_changes`. |
| `crates/kernel/src/tasks/checkpoint.rs` | The checkpoint export: snapshot, collect, dump, rename. |
| `tools/moor-emh/src/commands.rs` | The offline `dump`, `export`, `load` and `reload` commands. |

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| Import stops with a verb compile error naming a file | A verb body does not compile under the current feature flags | Compare the flags the core needs with the flags the server runs. Read `moor/language-and-compiler/language-features-and-compat`. |
| `Duplicate object definition for #n` | Two files define the same object number | One of them is a stale copy. The error names both sources. |
| `Duplicate constant` on a constant you did not repeat | Another constant already has that value | Constants are unique by value as well as by name. |
| `Include error ... path escapes the source directory` | An `include!` reached outside the import root | Move the included file inside the tree. |
| `Cannot dump object #n: verb <i> has an empty name` | A verb in the database has no usable name | Repair it in-world with `set_verb_info` before the next checkpoint. The whole export fails until then. |
| An export writes numbered files where names used to be | Duplicate or inherited `import_export_id` | Look for the duplicate warning in the log and give one object a distinct value. |
| An import "succeeds" but an object has an invalid parent | Bulk import does not validate parents | Validate deliberately: load the object again through `load_object`, which does validate. |
| `load_object` fails on a third argument or a conflict option | Direct import takes one options map; the third argument and conflict controls were removed | Pass one options map only. Use `preview_objdef_changes()` to see differences first. |
| A verb was duplicated after `load_object` | Its alias list or argspec in the source differs from the live verb | Verbs match only on the exact list. Use `reload_object`, or fix the source. |
| An older mooR cannot import a new export | The export uses the `clear` clause or `package.moo` | Import with the same or a newer version. |
| `apply_objdef_changes` fails with stale evidence | The live programs or baselines changed since the preview | Preview again and review again. |
| A first start with `--git-upstream` fails | No unique merge base of `HEAD` and the upstream ref in local history | Fetch the ref, or use `--baseline-objdef-dir`. |
| A checkpoint directory is named `.in-progress` | The export failed part way | The rename to `.moo` is the last step. Read the log for the dump error. |

## Read first, read next

Read first:

- `moor/storage-and-state/world-state-model` — what a
  property definition, an override and a verb resolution actually are.
- `moor/language-and-compiler/compiler-pipeline` — why
  an exported verb body is decompiled text and not your source.

Read next:

- `moor/content-pipeline/textdump-compat` — the other
  import format, and the identity bridge from `#0`.
- `moor/content-pipeline/cores-and-bootstrap` — how
  a directory becomes a running world.
- `moor/working-in-the-repo/repo-tooling` — `moorc` and
  `moor-emh`.
- `book/src/the-system/objdef-file-format.md` — the syntax reference, with packages,
  native verbs and constants in verb code. Good, but check the code for anything
  load-bearing. Its "Migrating Legacy Code" section still names a `make migrate`
  target that no core has.
- `book/src/the-system/object-loading.md` — the direct-import options and the full
  review and apply contract.

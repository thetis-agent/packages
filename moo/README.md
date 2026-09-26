# @bitmuse/moo

The live mooR world as 51 tools, over **one** shared client.

Companion to the skills in `@bitmuse/torchship` (the world) and `@bitmuse/moor`
(the engine). Those skills tell an agent to call `moo_eval`, `moo_get_verb` and
friends; this package is what makes that possible.

## Configuration

Two keys, set once for all 51 tools:

| Key | |
|---|---|
| `username` | The MOO character the tools log in as. **Required.** |
| `password` | Its password. **Required, secret.** |
| `base_url` | The web host. Defaults to `http://10.10.10.1:7892`. |
| `request_timeout_secs` | HTTP timeout. Default 30. Not the same as a MOO task's `timeout_ms`. |

Set them in the control panel (Configure on the package), or with
`configure_package`. `moo_server_info` is the right first call when something
fails: `/health` and `/version` need no authentication, so it answers even when
the credentials are wrong and tells you which half is broken.

## Where the authority is

**This group holds no authority of its own.** It logs in over HTTP like any
player and every verb it runs is checked by the VM against that character. The
practical consequence: *what you give it decides the blast radius.* A programmer
bit and a wizard bit are very different grants.

This port was deliberately built **wizard-only** — one identity, no `wizard`
argument on any tool. The Rust ancestor kept a programmer login as the default
and reserved a wizard login for objdef operations, the object diff and
command-verb dispatch. That split is gone, so there is **no least-privilege
here**. It is simpler and more dangerous, and that was the explicit choice.

## What survived the port, on purpose

These are the properties that were learned the hard way; each has a test.

- **MOO source is built, never interpolated.** Every caller value passes through
  `mooLiteral`, so a string with a quote or a newline becomes an escaped MOO
  string rather than new code.
- **`#0` is refused twice** before a recycle — once by spelling, once inside the
  MOO task that recycles, because `toobj(<invalid CURIE>)` evaluates to `#0`.
  The equality test comes before `valid()`, so it holds even where `#0` is valid.
- **A patch that does not apply performs no write.** Context and removal lines
  must match exactly; the applier refuses rather than guessing, because a fuzzy
  patch on live verb source destroys code silently.
- **objdef paths are confined** beneath `workspace/torchship-objdef`, including
  against symlinked directories. mooR's own MCP host does *not* do this — its
  objdef tools take any path with no sandbox, which its skill names as the gap
  in its safety story. `test.confine.mjs` keeps it closed.
- **Every object field takes the same four spellings**: `#36`, a UUID id
  `#0011E5-9CB7359F34`, a mooR CURIE (`oid:36`, `sysobj:string_utils`), or a
  corified reference as a programmer types it (`$string_utils`, `$sys.utils`).
  In MOO source a `$name` is left for the VM to resolve; on a REST path it
  becomes `sysobj:name`. A `$name` has to be a dotted identifier path, so
  `$you; recycle(#1)` is refused rather than spliced into source. `moo_grep`
  reports the resolved `scope` so you can see what `$you` actually was.
- **A timeout is reported as "may have committed"**, never as a failure, with
  the instruction to read state back before retrying.
- **Both wire shapes are accepted**: a modern bare `InvocationSuccess`, and the
  older `ReplyResult -> ClientSuccess -> EvalResult`. A genuine error is never
  mistaken for either, and an unrecognised envelope is an error rather than a
  silent success.
- **FlatBuffers union wrappers are stripped**, so an owner reads as `#36` rather
  than five levels of nesting, and a `UuObjId` is rendered `#0011E5-9CB7359F34`
  the way mooR itself renders one — so an id a listing shows can be handed
  straight back to another tool.

## What changed

**Fifty copies became one.** Each `moo-*` tool was a standalone wasm component
with no workspace to share a library, so a 1,272-line `moo.rs` was duplicated
verbatim into fifty crates and kept in step by `sync-shared-client.sh --check`.
`/opt/thetis`'s postmortem counted the result: ~250,000 lines of tool source
over ~12,000 distinct lines. Here it is one `client.js` with fifty importers,
and the sync script is unnecessary.

**One tool was added.** `moo_grep` searches verb source across the database.
The torchship skills tell an agent to reach for it and neither the wasm tools
nor the MCP host ever had it — which matters because, as those skills put it,
"everything is objects and verbs; there are no source files to grep".

**`moo_list_pools` was not added.** The skills mention it too, but nothing in
either implementation says what a pool is here, and guessing at a tool's
semantics is worse than not having it.

**`moo_test_compile` is absent**, as it was: built once in the original and
deleted in `ae89aad8`.

## Tests

```
node test.unit.mjs      # 38: encoding, Var decoding, both wire shapes, injection
node test.wiring.mjs    # manifest vs module, and the diff applier
node test.confine.mjs   # 18: objdef path confinement, including symlink escapes
```

None of them touch the network.

## The one thing to read first

`torchship/agent-environment`. It is about the gap between what a tool reports
and what actually happened: tracebacks go to the player's connection and are
invisible here, a timeout is not a rollback, command output is invisible so
verify by reading state back, parse globals are empty outside a real parsed
command, and a verb that calls `read()` will block forever. Every one of those
is a wasted loop this package cannot prevent for you.

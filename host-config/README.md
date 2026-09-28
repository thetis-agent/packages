# @thetis/host-config

The keys of `thetis.config.json` an admin may change from the Control panel. The file is the host's, and a fence cannot write it, so the writing happens here: a package of type `host`, named `config`, which the daemon loads from the shipped or the promoted packages and calls per operator method `host.config.<export>`, importing the entry again whenever it changes. Plain ECMAScript with no build step and no dependency.

It only writes. Putting a change into service is `config.reload`, which the caller asks for next: it reads the file again and applies each changed key by its tier (`model` is a dispatch key, so the next turn has it; nothing restarts).

## Exports

The kernel admits an admin (through a fence) or the operator (at the control socket) and journals `host.call`. Nothing is listed in `thetis.host.self`, and a self call is refused here again (`unauthorized`).

| Export | Arguments | Answers |
|---|---|---|
| `modelSet` | `model`: a model id, or `""` | `{ model, was }`: the id written (null when removed) and the file's before. An empty id removes the key, so the built-in default applies again |

`modelSet` keeps every other key, writes the whole file or nothing (a sibling renamed over it, with the old file's mode), follows a symlinked file to its target, and journals `config.model` with `from` and `to`. A file that is not a JSON object is refused and left as it is. Whether a provider serves the id is not checked: a provider installed later may serve an id none serves now.

## Used by

`@thetis/ui-admin`'s `model-set` verb, behind **Make default** on the Models page.

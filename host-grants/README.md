# @thetis/host-grants

The grants an admin makes into one person's fence: host directories bound at their own path (mounts), and ssh keys that fence's own agent holds. Both need the host itself -- a directory to browse, a key file to write under `<home>/fence-keys/<user>`, a path whose presence to check -- and a fence cannot do any of that, so they live here rather than in the kernel. Plain ECMAScript with no build step and no dependencies.

## What it provides

A package of type `host`, named `grants`. Not installable: the daemon loads it from the shipped or the promoted packages and calls one export per operator method `host.grants.<export>`, importing the entry again whenever its file changes, so an edit is live on the next call without a reload. The kernel admits the call when the caller is an admin (through a fence) or the operator (at the control socket), and journals `host.call` without the arguments; each export then checks the target, writes the kernel's record, journals the grant itself, and reopens the fence so the grant reaches it.

Every export is `(args, env) => Promise<unknown>`, with `env` the `HostEnv` of `@thetis/contracts`: `home`, the `users` table, the `records` (`mounts` and `ssh`, one list per person with `get`, `all`, `set`), `journal(row)`, `reloadFence(user)` and `log`. `args.user` names the target; `_system` takes no grant of either kind, and an unknown user is `not-found`.

| Export | Arguments | Answers |
|---|---|---|
| `mountsList` | `user?` | `{ <user>: MountState[] }`: every mount with `present` (true only for a directory the fence will bind) and `kind` (`dir`, `file`, `none`) |
| `mountsBrowse` | `path` (default `/`), `all` | `{ path, parent, kind, readable, truncated, entries: [{ name, path }] }`, the directories under `path`, hidden ones with `all` |
| `mountsSet` | `user`, `mounts: [{ path, mode }]` | the list as written, with presence; at most 32, absolute normalized paths, mode `rw` or `ro` |
| `sshList` | `user?` | `{ <user>: SshGrantState[] }`: every grant with `present`, and for a key that is there its `publicKey` and `fingerprint` |
| `sshKeygen` | `user`, `ssh?: [{ hosts }]` | `{ key, publicKey, fingerprint }`: a key of the person's own under `fence-keys/<user>/id_ed25519`, kept if it exists, granted with the known hosts |
| `sshImport` | `user`, `name`, `privateKey`, `hosts?` | `{ key, publicKey, fingerprint }`: the material written once as `fence-keys/<user>/<name>`, proved a key by ssh-keygen, granted; never overwritten, never journalled |
| `sshSet` | `user`, `ssh: [{ key, hosts? }]` | the list as written, with presence; at most 16 keys, each an absolute normalized path |

The journal rows are `mounts` (`{ mounts: [{ path, mode }] }`) and `ssh` (`{ ssh: [key paths] }`), with the admin as `actor` when the call came through a fence. Key material is never in an answer, a refusal, a log line or the journal.

## Callers

`thetis mounts` and `thetis ssh` in `@thetis/gateway-cli`, and the mounts and ssh pages of `@thetis/ui-admin`. The fence side -- reading the records when a fence opens, binding the mounts, loading the keys into the agent -- is `@thetis/lib` (`UserspaceLayout`, `knownHostsOf`) and `@thetis/sandbox`, unchanged by this package.

## Layout

```
index.js        the seven exports
lib/mounts.js   parseMountList, withPresence, statOf, browseDirectories
lib/ssh.js      parseSshGrants, describeKeys, publicKeyOf, fingerprintOf, generateKey, importKey, KEY_NAME
lib/error.js    fail and assert, errors with a code the operator channel carries
test/           the exports over a fake env, and the mechanism on its own
```

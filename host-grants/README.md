# @thetis/host-grants

The grants an admin makes into one person's fence: host directories bound at their own path (mounts), and ssh keys that fence's own agent holds. Both need the host itself -- a directory to browse, a key file to write under `<home>/fence-keys/<user>`, a path whose presence to check -- and a fence cannot do any of that, so they live here rather than in the kernel. And the installation's own repository keys: one ssh key per repository, held by the system fence, so a private registry can be installed from without lending anyone's key. Plain ECMAScript with no build step; the one dependency is `@thetis/runtime/lib/git-url`, which says what repository a url names.

## What it provides

A package of type `host`, named `grants`. Not installable: the daemon loads it from the shipped or the promoted packages and calls one export per operator method `host.grants.<export>`, importing the entry again whenever its file changes, so an edit is live on the next call without a reload. The kernel admits the call when the caller is an admin (through a fence) or the operator (at the control socket), and journals `host.call` without the arguments; each export then checks the target, writes the kernel's record, journals the grant itself, and reopens the fence so the grant reaches it.

Every export is `(args, env) => Promise<unknown>`, with `env` the `HostEnv` of `@thetis/runtime/contracts`: `home`, the `users` table, the `records` (`mounts` and `ssh`, one list per person with `get`, `all`, `set`), `journal(row)`, `reloadFence(user)` and `log`. `args.user` names the target; `_system` takes no mount and no ssh grant through these (its keys are repository keys, below), and an unknown user is `not-found`.

| Export | Arguments | Answers |
|---|---|---|
| `mountsList` | `user?` | `{ <user>: MountState[] }`: every mount with `present` (true only for a directory the fence will bind) and `kind` (`dir`, `file`, `none`) |
| `mountsBrowse` | `path` (default `/`), `all` | `{ path, parent, kind, readable, truncated, entries: [{ name, path }] }`, the directories under `path`, hidden ones with `all` |
| `mountsSet` | `user`, `mounts: [{ path, mode }]` | the list as written, with presence; at most 32, absolute normalized paths, mode `rw` or `ro` |
| `sshList` | `user?` | `{ <user>: SshGrantState[] }`: every grant with `present`, and for a key that is there its `publicKey` and `fingerprint` |
| `sshKeygen` | `user`, `ssh?: [{ hosts }]` | `{ key, publicKey, fingerprint }`: a key of the person's own under `fence-keys/<user>/id_ed25519`, kept if it exists, granted with the known hosts |
| `sshImport` | `user`, `name`, `privateKey`, `hosts?` | `{ key, publicKey, fingerprint }`: the material written once as `fence-keys/<user>/<name>`, proved a key by ssh-keygen, granted; never overwritten, never journalled |
| `sshSet` | `user`, `ssh: [{ key, hosts? }]` | the list as written, with presence; at most 16 keys, each an absolute normalized path |

## Repository keys

A repository key is Thetis's, not a person's, and it reaches exactly one repository. It is an ssh grant on the system userspace that carries `repo`: only `_system` holds grants with `repo`, every `_system` grant has one, and there is one per repository, matched with `sameRepository` so `git@github.com:o/r.git` and `https://github.com/o/r` are the same key. The file sits at `fence-keys/_system/<alias>`, the alias being `repoRoute(repo).alias`, and the system fence's agent holds it; the fence routes that repository, in any spelling, through the alias so git offers that key and no other. Installs from the repository are cloned in the system fence and copied to the person, so nobody's fence ever holds the key.

Why per repository and not one installation key: GitHub accepts the first key that authenticates as anything, so an agent holding two deploy keys reaches one repository and is refused by the other. And why a key rather than a setting: a registry uses SSH exactly when a repository key names its url. Nothing records the intention, so what the UI shows is what the fence does.

| Export | Arguments | Answers |
|---|---|---|
| `repoList` | none | `RepoKeyState[]`: `{ repo, key, alias, hosts?, present, publicKey, fingerprint }` for every system grant |
| `repoKeygen` | `repo`, `scan?` (default true), `hosts?` | the `RepoKeyState`: a new ed25519 key at the alias, kept if the file exists (it may already be a deploy key), granted with its host keys |
| `repoImport` | `repo`, `privateKey`, `scan?`, `hosts?` | the `RepoKeyState`: the material written once at the alias, proved a key by ssh-keygen; refused when the file exists |
| `repoTest` | `repo` | `{ repo, ok, head?, error? }`: `git ls-remote <url> HEAD` from the host with this key alone; `error` is git's own stderr |
| `repoRevoke` | `repo`, `keepKey?` (default false) | the `RepoKeyState[]` left: the grant removed, and its files too unless `keepKey`; a kept file is removed by revoking again |

`repo` has to be a hosted url (`repoRoute` parses it), else `invalid`. `scan` runs `ssh-keyscan -T 10 [-p port] <host>` on the host and stores what it finds as the grant's known hosts, with any `hosts` given added; a scan that finds nothing is refused, because strict host checking would fail every connection. With neither, a key already granted keeps the hosts it had. `repoTest` runs with `IdentitiesOnly`, no agent, `BatchMode`, strict checking against the grant's own hosts and a 20 s limit, over `ssh://<user>@<host>[:port]/<path>.git` directly, so its answer is about this grant and not about the host's own ssh setup: a key not yet added as a deploy key comes back `ok: false` with GitHub's `Permission denied (publickey)` in well under a second.

A person's grant with `repo` is refused by `sshSet`, and `sshSet`, `sshKeygen` and `sshImport` refuse `_system` with a sentence naming `repoKeygen`. `sshList` lists the system's grants with the rest, `repo` included.

## Keeping

A key kept for a person outlives every call here but not the person: `removeUser` in `@thetis/runtime` deletes `fence-keys/<user>` with the rest of what is keyed to the id, so a removed id that is added again is a person with no key rather than one silently holding the last occupant's.

The journal rows are `mounts` (`{ mounts: [{ path, mode }] }`), `ssh` (`{ ssh: [key paths] }`) and, for a repository key, `ssh` on `_system` (`{ repo, key }`, the key being its path), with the admin as `actor` when the call came through a fence. Key material is never in an answer, a refusal, a log line or the journal.

## Callers

`thetis mounts`, `thetis ssh` and `thetis repo-key` in `@thetis/gateway-cli`, the mounts and ssh pages of `@thetis/ui-admin`, and the Registries section of `@thetis/ui-marketplace`. The fence side -- reading the records when a fence opens, binding the mounts, loading the keys into the agent -- is `@thetis/runtime/lib` (`UserspaceLayout`, `knownHostsOf`) and `@thetis/runtime/sandbox`, unchanged by this package.

## Layout

```
index.js          the twelve exports
lib/repo-keys.js  routeOf, grantFor, describeRepoKeys, keyscan, mergeHosts, directUrl, testKey
lib/mounts.js     parseMountList, withPresence, statOf, browseDirectories
lib/ssh.js        parseSshGrants, describeKeys, publicKeyOf, fingerprintOf, generateKey, importKey, KEY_NAME
lib/error.js      fail and assert, errors with a code the operator channel carries
test/             the exports over a fake env, and the mechanism on its own
```

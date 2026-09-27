# @thetis/host-update

Updating the installation itself from the control panel. The runtime checkout and its packages submodule live on the host and are bound read-only into every fence, so pulling them, installing dependencies and building can only happen on the host: this is a package of type `host`, named `update`, that the daemon loads per call as `host.update.<export>` and never installs into a fence. Plain ECMAScript with no build step and no dependencies; git and npm are the host's.

The whole update is **one job on the server**: download, install, build, a check that the new version loads, a rollback if any of that fails, and then the restart or the reloads that put it into service. Closing the page cannot leave the box built but half applied.

## What it provides

Four exports, each `(args, env) => Promise<unknown>` with `env` the `HostEnv` of `@thetis/runtime/contracts`, of which this uses `root` (the checkout), `home` (where the record and the lock are kept, under `update/`), `journal`, `log`, `reloadFence` and `restart`. The kernel admits a call from an admin's fence or from the operator at the control socket, and journals `host.call`. Only these four are exported as functions, because every function export is callable as `host.update.<name>`.

| Export | Arguments | Answers |
|---|---|---|
| `check` | `fetch?: boolean \| "stale"` | Where the installation stands (below). `fetch: true` reaches both remotes first. `fetch: "stale"` reaches them only when the last real fetch is more than 30 minutes old (5 minutes after a failed one), for the whole installation: the time is kept in `<home>/update/fetched.json` and claimed before the fetch runs, so ten admin tabs opening at once make one fetch. Without `fetch` the answer is what the last fetch left, which costs nothing. |
| `apply` | `then?: "restart" \| "none"` | Starts the job and answers at once: `{ state: "started", then, from, last }`. Refused with `busy` while another job holds the lock, and with `invalid` when a checkout has local changes ("Can't update: the server's copy has local changes (…). Commit or discard them on the host, then try again.") or tracks no upstream. `then: "restart"` puts the result into service; anything else (the default) leaves that to whoever asked, and the record's `needs` says what is left. |
| `progress` | — | The job's record (below), or null when no update has run here. |
| `restart` | `reason?` | Asks for a restart through `env.restart(reason, by)`, which arms the kernel's restart latch in drain mode. For the case "the code on disk is newer than the running daemon, and there is nothing to download": the dev-box **Restart to finish**. Without a reason, one is made from `stale.why`. Answers the latch's own `{ state, message }`; `{ state: "refused", why: "updating" }` while an update holds the lock, and `{ state: "refused", why: "unsupported" }` on a daemon whose `HostEnv` has no `restart` ("This Thetis version cannot restart itself from here yet…"). |

### `check`

```
{ runtime, packages, incoming, behind, dirty, dirtyFiles?, stale: { daemon, why? },
  needs: { restart, reload, why }, updating, fetchedAt?, fetchError?, last, root, checkedAt, node, beyond }
```

- `runtime`: `{ branch, commit, head, dirty, dirtyFiles, upstream, upstreamHead, ahead, behind, incoming, fetched, error }` against the branch it tracks. `packages`: `{ commit, head, pinned, pinnedHead, dirty, dirtyFiles, behind, incoming, fetched, error }` against the commit the runtime's upstream pins for the submodule. `commit` and `pinned` are short; `head`, `upstreamHead` and `pinnedHead` are full.
- `incoming`: `[{ commit, subject, repo }]` across both, the runtime's first, each newest first, at most forty per repository. `repo` is `"runtime"` or `"packages"`.
- `behind`: either checkout has commits to take, or the runtime pins a packages commit not fetched yet.
- `dirty` and `dirtyFiles`: local changes in either checkout, untracked files left out; the submodule's are prefixed `packages/`. On a dev box this is normal, not an alarm.
- `stale.daemon`: the running daemon is older than the code on disk. It compares this process's start time with the newest module file (`.js`, `.mjs`, `.cjs`, `package.json`; tests, pages, skills and docs are not walked) under `dist/src`, `packages/gateway-cli/dist/src` and the storage driver. Host packages are not counted: the host imports their whole module graph fresh when a file changes. `why` names each set in a phrase: "Thetis's own code was rebuilt", "the storage driver @thetis/store-toml changed". The kernel's own `status` counts only the first. A build that ends with the code the daemon already runs -- a rollback's rebuild of the old commit, or an update whose diff touched no daemon code -- rewrites `dist/` with new times; when the daemon was not already stale before that job, the job writes `<home>/update/rebuilt.json` (`{ at }`) and only files newer than that mark count, so a rollback never ends in a false **Restart to finish**. A change by hand afterwards is newer than the mark and is said.
- `needs`: what the incoming commits would need, decided from `git diff --name-only`, never from file times. `restart` is true when the runtime diff touches `src/`, `bin/`, `package.json`, `package-lock.json` or `tsconfig*`, or the packages diff touches `gateway-cli/` or the storage driver's directory (a host package is imported fresh, whole module graph and all, so it never needs a restart); `why` lists those paths (at most six). `reload` lists the workspaces (`_system` first) with a link into a shipped package whose directory changed. It is computed even when a restart is needed, so the page can say who is affected.
- `updating`: a job holds the lock now.
- `fetchedAt`: the last real fetch; `fetchError` when it failed.
- `last`: the job's record, as `progress` answers it.

### The job, and its record

`<home>/update/last.json`, written after every change and every two seconds while a step runs:

```
{ state: "running" | "done" | "failed" | "rolledback" | "interrupted",
  phase: "fetching" | "installing" | "building" | "checking" | "reloading" | "restarting" | "done",
  then, by, startedAt, updatedAt, finishedAt, ok, from, to, needs, steps: [{ name, cmd, ok, ms, code, tail, skipped? }],
  error?, rollback?: { ok, error?, command? }, rollingBack?, restart?: { state, why?, message, armedAt, reason, fired? },
  reloaded?: [{ user, ok, error? }], note? }
```

`from` and `to` are `{ runtime, packages, runtimeBehind, packagesBehind }`. Each step keeps the last 16 KiB of what it printed in `tail`. The steps, in order:

| Phase | Step | What runs |
|---|---|---|
| fetching | download | `git fetch --tags origin` in the runtime, `git fetch origin` in the submodule. A failure ends the job: "Couldn't reach the update source: … Nothing changed." Commits of this checkout that are not upstream end it too: it cannot update by itself. Nothing behind ends it `done`, with the note "Thetis is already up to date." |
| fetching | pull the runtime | `git merge --ff-only <upstream commit>`, after a baseline smoke check of the tree as it is (below). |
| fetching | move packages to the pinned commit | `git submodule update --init --recursive` |
| installing | install dependencies | `npm ci`, only when the diff touches `package-lock.json` or a `package.json`; otherwise recorded as skipped, so `node_modules` is not torn down for nothing. |
| building | build | `npm run build` |
| checking | check the new version loads | The smoke check (below). |
| reloading | — | With `then: "restart"` and no restart needed: `env.reloadFence(user, { drain: true })` for each workspace in `needs.reload`, the admin who asked last. One that refuses is recorded in `reloaded` and named in `note`; it picks the change up when it next opens. |
| restarting | — | With `then: "restart"` and a restart needed: `env.restart(reason, by)`, and no reloads first, because a restart reopens every fence. The reason is "Update to <commit> (Thetis's own code changed: <files>)". `armed` or `again` ends the job `done` in phase `restarting`; a daemon started after `restart.armedAt` reads it as phase `done`, `restart.fired: true`. A refused restart ends it `failed` with "The update is installed, but Thetis could not restart itself: <the latch's sentence>"; the code stays, and `check` then says `stale.daemon`. |

npm is the one beside the node running the daemon, else on `PATH`; that node is first on `PATH` for every step.

**The smoke check** is a child `node`, with the checkout as its working directory, that imports `dist/src/index.js`, the CLI adapter, the storage driver, every host package, every package in the effective default list (the kernel's `loadConfig`, so the file layer over the kernel's defaults), and every package linked into any person's store. It has 60 seconds. It runs twice: before the pull, on what is there now, and after the build. Only an entry that loaded before and fails after counts against the update ("the new version does not load: @thetis/x: Cannot find package 'zod' …"); one that was already failing is named in the step's output and not held against it, so one broken package cannot block every future update.

**The rollback** runs on any failure once the checkout has moved: `git reset --hard <from>` in the runtime, `git submodule update --init --recursive` and `git -C packages reset --hard <from>`, then `npm ci` again if it ran and the build again if it ran. The old daemon keeps serving throughout. It ends `rolledback` with `rollback: { ok: true }` and the failure in `error`. If the rollback fails too, the job ends `failed` with `rollback: { ok: false, error, command }`, where `command` is the exact line to run on the host. `rollingBack` is true while it runs.

**The lock** is `<home>/update/lock`, taken atomically when `apply` starts the job and removed when the job ends, before any restart can fire. It holds `{ pid, by, startedAt }`; its modification time is the heartbeat, touched every two seconds. A lock whose process is gone, or whose heartbeat is more than 30 minutes old, has nothing behind it: `check` says `updating: false`, and the next `apply` breaks it and says so in its record's `note`. While the lock is live, `restart` refuses, and `@thetis/tool-operator`'s `restart_daemon` refuses with "An update is installing; Thetis restarts by itself when it is done." A record still `running` with no live lock behind it is answered as `interrupted`.

The journal gets `update.start`, then `update.done`, `update.rolledback` or `update.fail`, with `from`, `to`, `needs`, `error` and `rollback`.

## What it does not do

Node itself, the OS packages the fence needs, and the systemd unit are `deploy/install.sh`'s, run on the host; `check` names them under `beyond` so nobody looks for them here. The update is in place: while `npm ci` runs, a fence that opens can see a half-installed `node_modules`. The lock stops restarts and reloads in that window, not a fence that crashes and reopens; a staging worktree swapped in by a link would close it and is not done. A new daemon that cannot boot at all is not caught here: systemd's start limit gives up, and the host is where that is fixed.

## Files

| File | Content |
|---|---|
| `index.js` | The four exports, and the fetch throttle. |
| `lib/checkout.js` | `git`, `runtimeState`, `packagesState`, `checkouts`: what git says about the two checkouts. |
| `lib/job.js` | `runJob`, `readState`: the steps, the rollback, the restart or the reloads, and the record. |
| `lib/lock.js` | `takeLock`, `readLock`, `updating`, `releaseLock`, `beat`, and the `UPDATING` sentence. |
| `lib/needs.js` | `needsFor`, `changedBetween`: restart or reload, from `git diff --name-only`. |
| `lib/smoke.js` | `smokeEntries`, `runSmoke`, `smokeAgainst`: the child that imports everything the installation runs. |
| `lib/stale.js` | `staleDaemon`: the code on disk against the running daemon; `markRebuilt`, `rebuiltAt`: the mark a rebuild of the running code leaves. |
| `lib/layout.js` | The shipped and promoted packages, each person's installed links, the default list and the storage driver, read from disk. |
| `test/update.test.js` | Against real repositories in a temporary directory: two bare origins, a runtime pinning the packages, a clone as the installation, a home where two people run a shipped package. npm is a script that records its arguments and fails on cue; the smoke check is the real one. |

## Tests

`node --test "test/*.test.js"` here. They cover: `check` before and after the origins move, `needs` for a packages-only change (reload the two people who run it) and for a change under `src/` (restart, naming the file), `dirtyFiles`; the `fetch: "stale"` throttle and its shorter retry after a failure; `then: "restart"` reloading with drain, the admin last, and arming the restart through a fake `env.restart` with no reloads; `then: "none"`; a daemon with no `env.restart`; a failing build and a new version that does not import, each rolled back to the old commits; an entry already broken before the update not blocking it; a rollback that fails too, with the host command; the lock refusing a second `apply` and `restart`, and a dead lock broken with a note; an interrupted record; "already up to date"; the local-changes refusal; and `stale.daemon` for a rebuilt runtime, and not for a changed host package or its docs or tests, nor for the files a rollback or a no-restart update rebuilt (the `rebuilt.json` mark), while a change by hand after the mark still is.

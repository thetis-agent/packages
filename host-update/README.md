# @thetis/host-update

Updating the installation itself from the control panel. The runtime checkout and its packages submodule live on the host and are bound read-only into every fence, so pulling them, installing dependencies and building can only happen on the host: this is a package of type `host`, named `update`, that the daemon loads per call as `host.update.<export>` and never installs into a fence. Plain ECMAScript with no build step and no dependencies; git and npm are the host's.

## What it provides

Three exports, each `(args, env) => Promise<unknown>` with `env` the `HostEnv` of `@thetis/runtime/contracts`, of which this uses `root` (the checkout), `home` (where the record is kept, under `update/`), `journal` and `log`. The kernel admits a call from an admin's fence or from the operator at the control socket, and journals `host.call`.

| Export | Arguments | Answers |
|---|---|---|
| `check` | `fetch?` | `{ root, checkedAt, runtime, packages, node, last, beyond }`. `runtime` is `{ branch, commit, dirty, upstream, ahead, behind, incoming, fetched, error }` against the branch it tracks; `packages` is `{ commit, pinned, dirty, behind, incoming, fetched, error }` against the commit the runtime's upstream pins for the submodule. `incoming` is `[{ commit, subject }]`, newest first, at most forty. With `fetch: true` both remotes are reached first; without it the answer is what the last fetch left, which costs nothing and is what a page draws on open. `last` is the last update's record, or null. |
| `apply` | — | Starts the update and answers at once: `{ state: "started", from, last }`, or `{ state: "current", ... }` when nothing is behind. Refused with `busy` while one runs, and with `invalid` when a checkout has uncommitted changes, because an update by hand is the only safe one then. The steps are the installer's: `git pull --ff-only`, `git submodule update --init --recursive`, `npm ci`, `npm run build`, in the checkout, with the node that runs the daemon first on PATH. |
| `progress` | — | `{ last, beyond }`: the record as it stands. |

The record is `<home>/update/last.json`: `{ state, by, startedAt, updatedAt, finishedAt, ok, from, to, steps, error }`, with `state` one of `running`, `done`, `failed`, and each step `{ name, cmd, startedAt, finishedAt, code, output }` carrying the last 32 KiB of what the command printed. It is written after every change and every two seconds while a step runs, so a record still `running` whose `updatedAt` is more than fifteen minutes old has no process behind it any more, and is answered as `interrupted`. `from` and `to` are `{ runtime, packages, runtimeBehind, packagesBehind }`: what the update moved, not only that it ran. The journal gets `update.start`, then `update.done` or `update.fail`, with the same two summaries.

## What it does not do

Nothing running changes. What a workspace loads is put into service by reloading it, and what the daemon runs by restarting it; the control panel's Overview offers both once the update is done, through the same helper and the same latch the Workspaces section uses, and `thetis status` says which workspaces and whether the daemon are behind the disk. Node itself, the OS packages the fence needs, and the systemd unit are `deploy/install.sh`'s, run on the host; every answer names them under `beyond` so nobody looks for them here.

## Files

| File | Content |
|---|---|
| `index.js` | The three exports. |
| `lib/checkout.js` | `git`, `runtimeState`, `packagesState`, `checkouts`: what git says about the two checkouts. |
| `lib/job.js` | `updateSteps`, `runUpdate`, `readState`, `assertNotRunning`, `npmPath`: the steps, the runner that writes the record as it goes, and the record. |
| `test/update.test.js` | Against real repositories in a temporary directory: two bare origins, a runtime pinning the packages, a clone as the installation; the checks before and after the origins move, the update with `build: false`, the refusals, a failing step, the interrupted record. npm is never run. |

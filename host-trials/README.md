# @thetis/host-trials

A trial runs one request twice: once with one harness change and once without it. It runs on the real Thetis, with the person's real packages, configuration, skills and projects, and every write goes to RAM. @thetis/reflections uses it before anyone adopts a proposal: it runs the trial request in both arms and then judges the runs. Plain ECMAScript with no build step. It imports `@thetis/runtime` from the checkout (`<root>/dist/src`), and only inside a trial.

## What a trial is

`start` writes the trial (state `queued`) and starts a detached **outer runner** (`node lib/outer.js <trial dir>`, in a new session, `unref`ed). The outer runner runs as the daemon's user, outside any namespace. It waits its turn in the host-wide queue, because only one trial runs on a host at a time. Then it runs each run in a fresh **inner runner**:

```
unshare --user --map-root-user --mount --propagation private --pid --fork --kill-child --mount-proc -- node lib/inner.js <run spec>
```

The runs are interleaved: base-1, change-1, base-2, change-2, and so on. The inner runner isolates itself, builds the trial kernel, applies its arm's change, runs the request and prints what it produced as JSON lines (lib/protocol.js). The outer runner writes those lines into the real trial directory. When the inner runner exits, its namespaces and every write made in them are gone. The pid namespace means that nothing the run started can outlive it.

## The isolation, as built

The inner runner does all of this as root of its own user namespace, before anything else runs (lib/isolate.js):

1. It reads `/proc/self/mountinfo`. The paths to protect are THETIS_HOME, the runtime checkout, the real path of every **read-write** mount grant of the person, and every filesystem mounted beneath any of these. A path that lies beneath another protected path is skipped unless it is a mount point of its own.
2. It mounts a tmpfs (`size=<scratchMb>m`) on `<THETIS_HOME>/trials/<t>/ns-<arm>-<n>` and `chdir`s into it.
3. It bind-mounts the source of each protected path into the tmpfs (`l/<i>`, not recursively). It does this for every path before any overlay goes up, because an overlay hides whatever is mounted beneath its path.
4. It overlays each protected path onto itself, shallowest first: `lowerdir=l/<i>,upperdir=u/<i>,workdir=w/<i>`. The layers are named relative to the working directory, because the tmpfs's own path stops resolving once THETIS_HOME is overlaid.
5. It masks with an empty tmpfs: `<home>/run`, `<home>/fence-ssh` (the real fences' ssh agent sockets), `<home>/fence-keys` (the private keys), every `<home>/userspaces/*/run` (gateway and terminal sockets) and `/run/user/<uid>` (dbus, rootless docker).
6. It binds `/dev/null` over every socket at the top of the home or of a userspace (the control socket `<home>/thetis.sock` among them), and over `/run/docker.sock`, `/var/run/docker.sock` and the configured `fence.dockerSocket`.
7. It unsets `SSH_AUTH_SOCK`, `DOCKER_HOST`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`. The outer runner unsets them too. `HOME` becomes a directory inside the overlaid home.
8. It checks itself:
   - It writes a sentinel `.thetis-trial-sentinel-<hex>` into every overlaid path. The outer runner looks for each one from outside, while the inner runner waits, and again after the run. A sentinel it can see fails the run and the trial, and is removed.
   - It connects to every docker socket path, and a connection fails the run.
   - If any of this fails, the run fails with a sentence and nothing more runs.

The isolation details of each run are written to `<arm>-<n>/isolation.json`.

**The trial kernel** is built by `createKernel` from the real `thetis.config.json`, read through the overlay, with these overrides:

- `fence.sandbox` is `bwrap`. A trial is refused when the configuration says `none`.
- The person's fence gets `network: "none"` and `docker: "off"`.
- The system fence keeps the configured network but also gets `docker: "off"`, because the provider runs there and makes the model call.
- `T.ssh` is an empty store, so no fence has an ssh agent or a repository key.
- `T.cgroups` is none. The cgroup tree is the daemon's, and a trial that creates groups in it could disturb real fences, so a trial has no per-fence limits.
- `T.hosts` refuses every `host.*` call, which rules out grants, updates and configuration writes from inside a trial.
- `T.services` is a supervisor that starts only `@thetis/terminal` and `@thetis/browser`. It is armed without `boot()`, so only the fences the run needs are opened.
- `control.allowRestart` is false. There is no gateway and no `serve()`, so there is no control socket and no door.

The kernel also checks that every read-write mount it would bind lies under one of the overlays. A grant made after the trial was queued fails the run.

**Writes into the person's home.** The host writes a trial's files into the person's home, which their fence can also write. To do this safely, every read and write the host makes there runs in a jail (lib/jail.js): a bubblewrap whose only writable path is that person's userspace directory, and which mounts none of the host's data. Inside the jail, every path segment is checked so that none is a link, and files are opened with `O_NOFOLLOW` (lib/safe-fs.js). The inner runner uses the same checks when it applies a change and when it copies files out, and it closes every fence before it copies.

## What a trial cannot do

- **No network** in the person's fence, **no docker** anywhere, and **no ssh**.
- **No host packages.**
- **No attachments.** In v2 the request is text only.
- **Only two services:** terminal and browser. A request that needs a gateway, workflows, a marketplace or anything else fails the same way in both arms, which tells you nothing about the change.
- **No per-fence memory or CPU limits.** Writes are bounded by `scratchMb`.
- **A provider installed in the person's own userspace** has no network. Only the system fence's provider reaches the model.
- **No forget hook.** A host package cannot have one. @thetis/reflections calls `forget({trial})` for each trial of a conversation it forgets. If it only deletes `home/trials/<t>/` itself, three things still clean up: a running trial's runner stops when it notices the directory is gone and removes the host copy, and `status` (for that trial) and `list` (for all of them) drop the host copy of a finished trial whose directory is gone.

## The API

These are self exports (`start`, `status`, `list`, `cancel`, `forget`): a person's call is pinned to them by the kernel (`args.self`), and an admin names the person with `user`.

| Export | Arguments | Answers |
|---|---|---|
| `start` | `user?`, `session`, `request: {text}`, `project?`, `model`, `arms`, `runs`, `costUsd`, `minutes`, `scratchMb` | `{trial: "t_<hex8>"}`, at once |
| `status` | `trial` | the trial's `trial.json` |
| `list` | `{}` (an admin may add `user`, or leave it out to see everyone's) | trial.json of each of the person's trials, newest first, at most 50 |
| `cancel` | `trial` | the trial after cancelling: the running run is stopped and the remaining runs are cancelled |
| `forget` | `trial` | `{trial, removed}`. A queued or running trial is cancelled first, and its runner is waited for (up to 40 s, then killed). Then the host's copy (`<THETIS_HOME>/trials/<t>/`, whose spec holds the request text), the queue entry and the person's `home/trials/<t>/` are removed. A trial that is unknown, or is not the caller's, answers `removed: false`, so calling it again is harmless. |

The arguments of `start`:

- **`session`**: the original conversation's id. It is only recorded.
- **`project`**: the project the trial session is assigned to, through `projects/sessions.json`, the way @thetis/workflows does it. The project must exist.
- **`arms`**: exactly `[{id: "base", change}, {id: "change", change}]`, where each `change` is a Change or `null` and at least one is a Change. Usually the base arm has `null`. A re-trial of an adopted change gives the base arm the removal, because the real home already has the change.
- **`runs`**: 1 to 5 per arm.
- **`costUsd`**: the cap for the whole trial, at most 100. Each run is told what is left of it, and is cancelled (state `budget`) when it reaches that. A run that starts after the cap is spent is not started and is marked `budget`.
- **`minutes`**: the limit per run, from 1 to 120. The inner runner cancels the run when time is up (state `timeout`). The outer runner kills the run's process group after the minutes plus a two-minute grace for boot and copy-out.
- **`scratchMb`**: the tmpfs size, from 64 to 65536.

Refusals are sentences with a code: `invalid`, `not-found`, `unauthorized`, `busy` (more than three active trials for one person, or twenty on the host) and `unavailable` (no bubblewrap, no user namespaces, or `fence.sandbox` is `none`).

### Change

| Kind | Fields | Applied in the trial |
|---|---|---|
| `skill` | `id`, `path`, `content` | `content` is written to `path`, relative to the home. `path` must be under `skills/` and must not contain `..` or a leading dot. |
| `project-instructions` | `project`, `content` | `home/projects/<project>.md` is replaced whole. The project must exist. |
| `guide-note` | `note` | `note` is appended to `@thetis/harness-core` `guideNotes` at the person's layer, via `kernel.settings`. It is at most 300 characters, on one line. |
| `config` | `package`, `key`, `value` | Set at the person's layer. The trial kernel checks the key against the manifest, and a bad key fails the run. |

Removals let the base arm of a re-trial undo a change the real home already has:

- `{kind: "skill", path, content: null}` deletes the file, and its directory if it is left empty. `id` is optional here.
- `{kind: "project-instructions", project, content: null}` deletes `home/projects/<project>.md`.
- `{kind: "config", package, key, value: null}` unsets the key at the person's layer.
- `guide-note` is only ever appended. To revert the notes, use `{kind: "config", package: "@thetis/harness-core", key: "guideNotes", value: [...]}`.

## Files

**Under the person's home**, at `<THETIS_HOME>/userspaces/<user>/home/trials/<t>/`. The outer runner writes each file whole (a temporary file and a rename) through the jail:

- **`trial.json`**:
  - `{id, user, session, state, model, project, request, arms, runs, costUsd, capUsd, minutes, error?, createdAt, startedAt?, finishedAt?}`.
  - `state` is one of `queued|running|done|failed|cancelled`. `done` means every run reached an end, whatever end that was.
  - Each entry of `runs` is `{arm, n, state, session, costUsd, tokens, error?, startedAt, finishedAt}`, with `state` one of `queued|running|done|failed|cancelled|budget|timeout`.
  - `costUsd` is what the trial has spent so far, and `capUsd` is its cap.
  - `tokens` is the sum of prompt and completion tokens across every call of the run, subagents included.
- **`<arm>-<n>/record.json`**: the inspected trial session.
- **`<arm>-<n>/children/<id>.json`**: each descendant (subagent), inspected.
- **`<arm>-<n>/harness/turns/<id>.jsonl`** and **`<arm>-<n>/harness/snapshots/<id>/<sha>.{md,json}`**: copied from @thetis/harness-core's `harness-core/turns/` and `harness-core/snapshots/` for the session and each descendant, when they exist.
- **`<arm>-<n>/isolation.json`**: `{overlays, masked, docker: [{path, blocked}], sentinels}`.
- **`log.txt`**: the outer runner's log, with the inner runner's stderr (the trial kernel's log) appended. It is capped at 4 MB.

**Under the host**, at `<THETIS_HOME>/trials/`, which no fence can see:

- `<t>/spec.json` holds what to run. The runners read only this file, never the person's copy.
- `<t>/trial.json` is the copy that `status` and `list` trust.
- `<t>/pid` holds the runner's pid. A trial whose runner is gone is marked failed the next time someone looks at it, which happens when the daemon restarts.
- `<t>/cancel` is the cancel mark, and `<t>/outer.out` holds the runner's raw output.
- `queue/<ms>-<t>` holds the waiting trials, in order.
- `lock` names the trial that is running.

## Tests

Run them with `npm test`. Most tests use a fake inner runner (`test/fixtures/fake-inner.js`). They cover:

- validating the spec and each Change, removals included;
- interleaving the arms;
- accounting for cost, the cap and timeouts;
- cancelling, and a trial whose directory was forgotten;
- the sentinel check;
- the queue and the lock;
- pinning `status`, `list` and `cancel` to the caller;
- refusing links in the jail and in safe-fs.

`test/integration.test.js` runs real trials through the real outer runner, inner runner, kernel and fences, using a scratch THETIS_HOME, the echo provider fixture and an empty env file. The test is skipped when `unshare --user --mount` or bubblewrap is unavailable, or when the runtime is not built. It checks that:

- the change arm sees the skill and the base arm does not;
- writes to a read-write mount and to the home do not reach the real files;
- the person's fence has only `lo`;
- the docker socket is blocked;
- a re-trial whose base arm removes an adopted skill works.

# @thetis/gateway-cli

The `thetis` command. It runs in the host process; the entry point `bin/thetis.js` in the runtime root calls its one export, `run(argv)`. When `thetis serve` runs, every other command connects to its control socket `$THETIS_HOME/thetis.sock` and is a client of that one kernel, so installs, passwords, and moderation reach the running services. Without a daemon, a command starts a kernel in its own process and shuts it down at the end. Both modes use the same operator handler, so a command behaves the same way in either. `serve` also opens the door for browsers.

## What it provides

The manifest declares `type: gateway` and nothing else: no steps, no tools, no service, no ui. The package is a host process; it is not linked into any userspace. It is the only package besides `@thetis/host` that may import `@thetis/kernel`. It uses `@thetis/door` under `serve`, `@thetis/marketplace` for `packages outdated` and `packages update`, and `@thetis/bench` for `bench`.

| Command | Effect |
|---|---|
| `init` | Creates `$THETIS_HOME/thetis.config.json` with the portable defaults when it does not exist. Refuses a home too long to hold its own unix sockets, before writing anything, and notes how long a user id it can carry when that is less than the kernel's 32. |
| `config` | Prints the effective configuration as JSON, interpolated API key included. Also `show [<package>] [--user <id>]`, `set <package> <key> [<value>] [--user <id>] [--json] [--stdin]`, `unset <package> <key> [--user <id>]`, and `reload`, which re-reads the file and says which keys went live, which reopened the fences, and which still need a new daemon. |
| `status` | What is running, and whether each fence is on the code that is on disk now. A workspace holding a package at a version the disk has moved past also gets `2 packages changed: @thetis/skills-hybrid 0.2.1 -> 0.2.2, @thetis/tool-groups 0.1.0 -> 0.2.0` on its line, and a reload is what applies those. `--json` prints the raw report: `{ daemon: { startedAt, uptimeSecs, supervised, restartPolicy, codeAt, stale }, restart, workspaces: [{ user, openedAt, codeAt, stale, services, changed }] }`, which the installer reads. |
| `reload` | `--user <id>` or `--all`: closes that fence and opens it again, so its services start on the code on disk. |
| `restart` | Asks the running daemon to restart itself once every turn has ended: `[--reason <text>] [--yes]`. It exits non-zero when the latch refuses (unsupervised, young, or the unit's `Restart=` is not `always`). Also `restart status` and `restart cancel`. This is the only way a daemon process is replaced, and only for the daemon's own bugs. |
| `migrate` | Moves legacy record files into the storage driver. The daemon refuses to start while they are present. |
| `serve` | Runs the kernel, its control socket, the door, and every installed service until `SIGINT` or `SIGTERM`. |
| `users` | `list`, `add <id> [--admin]`, `remove <id>`, `suspend <id>`, `unsuspend <id>`, `role <id> <admin\|user>`, `passwd <id> [--password <text>]`. |
| `packages` | `list`, `install <source>`, `uninstall <name>`, `promote <name> --user <id>`, `unfork <name> [--delete-files]`, `outdated`, `update [<name>]`, each with `[--user <id>]`. `install` and `uninstall` also work at the top level. Without `--user` the target is the system userspace. `list` ends a fork's line with what it was forked from and how far that has moved on. `outdated` reports all three kinds of behind: a pin older than the registry index, which `update` installs; a package whose fence loaded a version other than the one on disk, printed as `<name>  loaded 0.2.1, 0.2.2 on disk  thetis reload --user <id>`, which only a reload applies; and a fork whose origin has gone on without it, printed as `<name>  identical to @thetis/gateway-web@0.2.0, which is shipped  thetis packages unfork <name> --user <id>`, which `unfork` takes. `unfork` is the inverse of `promote`'s cousin `fork_package`: the userspace goes back to the package the fork was copied from, and the fork's files under `packages/` are kept unless `--delete-files` says otherwise. Both `list` and `outdated` also say what is *ahead*: a package whose version on disk is newer than the one the index holds (`0.3.0 here, 0.2.0 published in thetis`) or one no registry lists at all (`never published`). That is unpublished work, and it is invisible everywhere else -- whoever maintains a package runs it from the same checkout every fence loads, so a bump is live here the moment it lands. What ships one is `publish`, below. |
| `publish` | `publish <package> --to <target> [--version <v> \| --bump patch\|minor\|major] [--dry-run] [--message <text>]`: puts one package in a registry at a new version. `<package>` is a name installed in the workspace or a path. It runs `@thetis/package-publish` in this process rather than in a fence, so the clones live under the operator's `$HOME` and the push uses the operator's own ssh agent and git identity; the targets and the `verify` command come from the kernel's configuration for that package, the same ones the tool reads in a fence. It refuses a version that does not move past what the target already holds, an unsound manifest, and a checkout with other files staged. It commits only that package's directory, but a push sends the whole branch, so commits already on it to *other* packages would be published too: `--with <name>` (repeatable) names one you meant to publish as well and it then goes as a publish of its own, verified and recorded like any other, while one that could not be published on its own is refused whatever you say. `--dry-run` reports what would go and touches nothing, which is also how to ask what a registry currently holds; it prints the tree gates as `refused\t<code>\t<sentence>` rather than throwing, lists what `--with` could still take as `could add`, and exits non-zero when it found any. |
| `mounts` | `list [--user <id>]` (each line says whether the host still has the directory), `add <user> <path> [--ro]` (refused with a sentence when it does not), `remove <user> <path>`, `browse [path]`. Sent as `host.grants.mountsList`, `mountsSet` and `mountsBrowse`, answered by `@thetis/host-grants`. |
| `ssh` | `list [--user <id>]`, `grant <user> <key> [--host <name>] [--scan <name>]`, `keygen <user>`, `import <user> <name> < key`, `revoke <user> <key>`. Sent as `host.grants.sshList`, `sshSet`, `sshKeygen` and `sshImport`, answered by `@thetis/host-grants`. A grant names one key file, which the host package loads into that fence's own agent; the key is never bound into the fence. `keygen` makes the person a key of their own; `import` keeps a key they already have (read from stdin, refused with a passphrase) beside it. Both print the public half and its fingerprint; `list` prints the fingerprint of every key that is there. |
| `sessions` | `list --user <id>`, `show --user <id> --session <id>`. |
| `send`, `chat` | One turn, or an interactive loop, as `--user <id>`, streaming the events. |
| `models` | Every model id and its provider package. |
| `bench` | `run <suite>` and `verify [<package-dir>]`, in a temporary home, never against the data directory. |

The process exits with `1` and prints the message when a command throws. A turn error is printed as an event and does not change the exit code. A reader closing the pipe (`thetis packages list | head`) ends the process quietly at 0 rather than with an unhandled `EPIPE`.

### How long `$THETIS_HOME` may be

Every seam between two of our processes is a unix socket under the data directory, and a unix socket path has to fit in `sun_path`: 107 bytes, as `@thetis/lib/socket-paths` explains. The sockets are per-person — `<home>/userspaces/<id>/run/term.sock` is 26 bytes plus the id — so the length that matters is the home *and* an id together, and the verdict is passed wherever each half is known:

| Where | What it says | Why there |
|---|---|---|
| `init`, `serve` | Refuses a home over **73 bytes**, where even a one-character id overflows. The socket that decides this is the sign-in socket, `userspaces/_system/run/login.sock`, whose id is fixed. | Unconditional: the home cannot serve anybody. `init` refuses before writing anything; `serve` refuses again, because a home can be moved or the variable edited afterwards. |
| `init` | A note, not a refusal, when the home is over **49 bytes** and so cannot carry every id the kernel allows: `note: <home> allows user ids of at most 21 characters; …`. | Nothing is wrong: the home serves. It is said where the path is being chosen and another one is still free. |
| `users.create` | Refuses an id too long for this home, naming the home, the socket, its length, the limit, and the longest id that would fit. | The one moment both halves are known and a shorter id can still be picked. Every path — the command line, the browser, an admin's `operator.*` — comes through the kernel's control handler, so all of them get it. |

Before this, `init` accepted any path and `serve` died on `listen EINVAL: invalid argument`, which named a path and no length and read as a fault in the daemon.

## Use

Run from the runtime root with `node bin/thetis.js <command>` or `npm run thetis -- <command>`.

```sh
thetis users add alice
thetis users passwd alice --password secret   # or: echo secret | thetis users passwd alice
thetis serve                                   # the door, the login target, and one gateway per person
```

```sh
thetis send --user alice "what changed since yesterday?"
thetis chat --user alice
```

`send` without `--session` creates a new session; `sessions list` finds its id for later turns. In `chat`, a line of text sends one turn; `/new` starts a session, `/inspect` prints the session state, `/quit` ends the loop. `printf 'hello\n/quit\n' | node bin/thetis.js chat --user alice` works.

A reasoning model's thinking arrives as its own event, and a terminal has no fold to put it in, so `send` and `chat` write a dim `[thinking…]` once and close it off the moment the answer, a tool call or an error arrives. `--verbose` streams the thinking itself, dimmed, as it streams the steps. Nothing is stored either way; it is what the model was doing while you waited, not part of the reply. It appears only when the provider is asked for it, which is `defaults.reasoning` in the provider's configuration.

`--user` is not authenticated. The CLI is an operator tool on the host: anyone who can run it, or open the control socket, can act as any user.

## Files

| File | Content |
|---|---|
| `src/index.ts` | `run(argv)`: `.env` loading, option parsing, `serve` with its shutdown deadline, the dispatch of every command over the control handler, and the event rendering of `send` and `chat`. |

## Tests

The package has no tests of its own. `packages/kernel/test/boundaries.test.ts` allows it, and only it besides the host, to import the kernel; `packages/host/test/e2e.test.ts` drives the control socket the commands use. Run every test with `npm test` from the runtime root.

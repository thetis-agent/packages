# @thetis/gateway-cli

The `thetis` command. It runs in the host process; the entry point `bin/thetis.js` in the runtime root calls its one export, `run(argv)`. When `thetis serve` runs, every other command connects to its control socket `$THETIS_HOME/thetis.sock` and is a client of that one kernel, so installs, passwords, and moderation reach the running services. Without a daemon, a command starts a kernel in its own process and shuts it down at the end. Both modes use the same operator handler, so a command behaves the same way in either. `serve` also opens the door for browsers.

## What it provides

The manifest declares `type: gateway` and nothing else: no steps, no tools, no service, no ui. The package is a host process; it is not linked into any userspace. It is the only package besides `@thetis/host` that may import `@thetis/kernel`. It uses `@thetis/door` under `serve`, `@thetis/marketplace` for `packages outdated` and `packages update`, and `@thetis/bench` for `bench`.

| Command | Effect |
|---|---|
| `init` | Creates `$THETIS_HOME/thetis.config.json` with the portable defaults when it does not exist. |
| `config` | Prints the effective configuration as JSON, interpolated API key included. Also `show [<package>] [--user <id>]`, `set <package> <key> [<value>] [--user <id>] [--json] [--stdin]`, `unset <package> <key> [--user <id>]`, and `reload`, which re-reads the file and says which keys went live, which reopened the fences, and which still need a new daemon. |
| `status` | What is running, and whether each fence is on the code that is on disk now. |
| `reload` | `--user <id>` or `--all`: closes that fence and opens it again, so its services start on the code on disk. |
| `restart` | Asks the running daemon to restart itself once every turn has ended. Also `restart status` and `restart cancel`. |
| `migrate` | Moves legacy record files into the storage driver. The daemon refuses to start while they are present. |
| `serve` | Runs the kernel, its control socket, the door, and every installed service until `SIGINT` or `SIGTERM`. |
| `users` | `list`, `add <id> [--admin]`, `remove <id>`, `suspend <id>`, `unsuspend <id>`, `role <id> <admin\|user>`, `passwd <id> [--password <text>]`. |
| `packages` | `list`, `install <source>`, `uninstall <name>`, `promote <name> --user <id>`, `outdated`, `update [<name>]`, each with `[--user <id>]`. `install` and `uninstall` also work at the top level. Without `--user` the target is the system userspace. |
| `mounts` | `list [--user <id>]` (each line says whether the host still has the directory), `add <user> <path> [--ro]` (refused with a sentence when it does not), `remove <user> <path>`, `browse [path]`. |
| `ssh` | `list [--user <id>]`, `grant <user> <key> [--host <name>] [--scan <name>]`, `keygen <user>`, `import <user> <name> < key`, `revoke <user> <key>`. A grant names one key file, which the kernel loads into that fence's own agent; the key is never bound into the fence. `keygen` makes the person a key of their own; `import` keeps a key they already have (read from stdin, refused with a passphrase) beside it. Both print the public half and its fingerprint; `list` prints the fingerprint of every key that is there. |
| `sessions` | `list --user <id>`, `show --user <id> --session <id>`. |
| `send`, `chat` | One turn, or an interactive loop, as `--user <id>`, streaming the events. |
| `models` | Every model id and its provider package. |
| `bench` | `run <suite>` and `verify [<package-dir>]`, in a temporary home, never against the data directory. |

The process exits with `1` and prints the message when a command throws. A turn error is printed as an event and does not change the exit code.

## Configuration

No `config.packages` entry. The environment: `THETIS_HOME` is the data directory, default `~/.thetis`, a relative path resolved against the runtime root; `OPENROUTER_API_KEY` is interpolated into the configuration. A `.env` in the current directory and then one in the runtime root are loaded; a variable already set is not replaced. `serve` binds the door at `config.door`.

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

`--user` is not authenticated. The CLI is an operator tool on the host: anyone who can run it, or open the control socket, can act as any user.

## Files

| File | Content |
|---|---|
| `src/index.ts` | `run(argv)`: `.env` loading, option parsing, `serve` with its shutdown deadline, the dispatch of every command over the control handler, and the event rendering of `send` and `chat`. |

## Tests

The package has no tests of its own. `packages/kernel/test/boundaries.test.ts` allows it, and only it besides the host, to import the kernel; `packages/host/test/e2e.test.ts` drives the control socket the commands use. Run every test with `npm test` from the runtime root.

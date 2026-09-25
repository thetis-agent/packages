# The operator methods

The command line talks to a running kernel through the control socket `$THETIS_HOME/thetis.sock` with these methods. An admin's fence reaches the same table through `env.kernel.operator.call(method, args)`. The kernel checks the role on every call and records the fence's user as the actor. `user` names the target user. It defaults to `_system`. Every method that changes something writes one journal row.

| Method | Arguments | Effect |
|---|---|---|
| `ping` | | `pong`. |
| `users.list` | | All user records. |
| `users.create` | `id`, `role?` | Adds a user. Creates and seeds the userspace. |
| `users.remove` | `id` | Removes the user, closes the fence, deletes the userspace directory. |
| `users.setStatus` | `id`, `status` | `active` or `suspended`. |
| `users.setRole` | `id`, `role` | `admin` or `user`. |
| `users.passwd` | `id`, `password` | Sets the password. Revokes every token of the user. |
| `packages.list` | `user` | The packages installed in that user's userspace. |
| `packages.install` | `user`, `source`, `actor` | Installs into that user's userspace. `actor` names who installs. The ownership rules use the actor's role. Refused with the code `fork` when that userspace already holds a fork of the package, naming the fork. |
| `packages.uninstall` | `user`, `name` | Removes the package from that user's userspace. |
| `packages.promote` | `user`, `name` | Makes the package the default for everyone. Returns `{ name, userspaces, forks }`: the people it installed for, and `[{ user, fork }]` for the people holding a fork of it, whose own copy is left in place. |
| `packages.unfork` | `user`, `name`, `deleteFiles` | Puts the package this fork was copied from back in its place, at the version it is at now. Refused when that package is not on disk here, before anything is removed. `deleteFiles` defaults to false. Returns the `PackageInfo` of the package that came back. |
| `packages.unmarkEveryone` | `name` | A system package stops being everyone's default. New people are not seeded with it. Everyone who has it keeps it. Refused when the configuration or a promotion made it everyone's. |
| `packages.installEveryone` | `source`, `actor` | Installs a package for every person, now and later. Returns `{ name, userspaces, forks }`, as `packages.promote` does: a person holding a fork of the package keeps it and is named in `forks` and in the journal row. |
| `sessions.delete` | `user`, `session` | Removes the session record; a running turn is cancelled first. |
| `fence.reload` | `user` | Closes that person's fence and opens it again on the code on disk. |
| `restart.request`, `restart.status`, `restart.cancel` | `reason` | The daemon's own restart latch. |
| `status` | | `{ daemon, restart, workspaces }`: what each process runs and whether the code on disk is newer. |
| `host.<name>.<export>` | the export's own | Any other method is dispatched to a host package: `host.grants.mountsList`, `mountsBrowse`, `mountsSet`, `sshList`, `sshKeygen`, `sshImport`, `sshSet` are answered by `@thetis/host-grants`. Admin or the control socket only; journalled without the arguments. |
| `journal.tail` | `limit`, `kind`, `target`, `actor_filter` | The newest journal rows, newest first. `limit` at most 1000, default 200. |
| `config.get` | | The configuration with secrets replaced. |
| `models` | `user` | Every model the providers visible to that userspace serve. |
| `sessions.create` | `user`, `parent` | Creates a session. |
| `sessions.list` | `user` | The sessions of that user. |
| `sessions.inspect` | `user`, `session` | One session record with its status. |
| `sessions.cancel` | `user`, `session` | Stops the running turn. |
| `sessions.send` | `user`, `session`, `input`, `model` | Runs one turn and streams the events. `model` names the model for that turn. |

A method no table and no host package answers fails with the code `rpc`. A fence whose user has the role `user` is refused with `only an admin may use operator methods`.

The methods a fence calls as itself, without `operator.`: `packages.install`, `packages.uninstall`, `packages.delete`, `packages.list`, `sessions.create`, `sessions.ask`, `sessions.send`, `sessions.cancel`, `sessions.delete`, `sessions.list`, `sessions.inspect`, `sessions.watch`, `models`, `providers.call`, `store.*`, `config.*`, `auth.login`, `auth.authenticate`, and `auth.logout`. `auth.login` is answered only for the system userspace. Both tables are frozen seams, snapshotted by `test/architecture.test.mjs`.

Sources: src/kernel/control.ts, src/kernel/rpc.ts, packages/host-grants/package.json.

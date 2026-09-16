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
| `packages.install` | `user`, `source`, `actor` | Installs into that user's userspace. `actor` names who installs. The ownership rules use the actor's role. |
| `packages.uninstall` | `user`, `name` | Removes the package from that user's userspace. |
| `packages.promote` | `user`, `name` | Makes the package the default for everyone. Returns `{ name, userspaces }`. |
| `packages.installEveryone` | `source`, `actor` | Installs a package for every person, now and later. Returns `{ name, userspaces }`. |
| `mounts.list` | `user` | `{ "<user>": [ { path, mode } ] }` for that user, or for every user without `user`. |
| `mounts.set` | `user`, `mounts` | Replaces that user's mounts. At most 32 `{ path, mode }`, an absolute normalized path that is not `/`, mode `rw` or `ro`. Not for `_system`. Closes the user's fence. |
| `journal.tail` | `limit`, `kind`, `target`, `actor_filter` | The newest journal rows, newest first. `limit` at most 1000, default 200. |
| `config.get` | | The configuration with secrets replaced. |
| `models` | `user` | Every model the providers visible to that userspace serve. |
| `sessions.create` | `user`, `parent` | Creates a session. |
| `sessions.list` | `user` | The sessions of that user. |
| `sessions.inspect` | `user`, `session` | One session record with its status. |
| `sessions.cancel` | `user`, `session` | Stops the running turn. |
| `sessions.send` | `user`, `session`, `input`, `model` | Runs one turn and streams the events. `model` names the model for that turn. |

An unknown method fails with the code `rpc`. A fence whose user has the role `user` is refused with `only an admin may use operator methods`.

The methods a fence calls as itself, without `operator.`: `packages.install`, `packages.uninstall`, `packages.delete`, `packages.list`, `sessions.create`, `sessions.ask`, `sessions.send`, `sessions.cancel`, `sessions.list`, `sessions.inspect`, `models`, `auth.login`, `auth.authenticate`, and `auth.logout`. `auth.login` is answered only for the system userspace.

Sources: docs/08-cli.md, docs/03-fence.md, packages/kernel/src/control.ts, packages/kernel/src/rpc.ts.

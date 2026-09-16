# @thetis/ui-admin

The admin sections of the web gateway's control panel: People, Models, Mounts, Activity, Workspaces and Overview, and the commands behind them. It is a `ui` package with no build step and no dependencies. Its browser modules run in the page; its commands run inside the admin's own fence, where `@thetis/gateway-web` calls them as the admin, and each one is one call over the kernel's operator channel. Every person gets the package by default; a user sees none of it, because `api/ui` drops the entries and verbs above the person's role.

## What it provides

The manifest declares `type: "ui"` and a `ui` block with `dir: "ui"`, `entry: "index.js"` and `style: "index.css"`. Every entry and every verb carries `role: "admin"`.

| Slot | Id | Label | Order | Note |
|---|---|---|---|---|
| `panel` | `people` | People | 20 | Who can sign in, and what they may do. |
| `panel` | `models` | Models | 30 | Which model answers by default, and what the providers serve. |
| `panel` | `mounts` | Mounts | 35 | Which host directories are bound into whose space. |
| `panel` | `activity` | Activity | 40 | What happened: who did what, and when. |
| `panel` | `workspaces` | Workspaces | 45 | What code each workspace is running, and how to put new code into service. |
| `panel` | `overview` | Overview | 50 | How this installation is set up. |

The orders sort the sections after the gateway's built-in Packages section (order 10).

| Verb | Export | Arguments | What it does |
|---|---|---|---|
| `users` | `users` | none | `users.list`: every user record. |
| `user-create` | `userCreate` | `id`, `role?`, `password?` | `users.create`, then `users.passwd` when a password was given. `role` defaults to `user`. |
| `user-role` | `userRole` | `id`, `role` | `users.setRole`: `user` or `admin`. Not for your own account. |
| `user-status` | `userStatus` | `id`, `status` | `users.setStatus`: `active` or `suspended`. Not for your own account. |
| `user-password` | `userPassword` | `id`, `password` | `users.passwd`: at least 8 characters. Not for your own account. |
| `user-remove` | `userRemove` | `id` | `users.remove`. Not for your own account. |
| `models` | `models` | none | `{ model, models }` from `config.get` and `models`. |
| `config` | `config` | none | `config.get`: the configuration as the kernel reports it, secrets replaced. |
| `journal` | `journal` | `limit?`, `kind?` | `journal.tail`: the newest rows, 200 by default, at most 1000. |
| `mounts-list` | `mountsList` | `user?` | `mounts.list`: one person's mounts, or everyone's, each with `present` and `kind`: what the host holds at the path now. |
| `mounts-set` | `mountsSet` | `user`, `mounts` | `mounts.set`: replaces that person's list. At most 32 entries, each an absolute normalized path that is not `/`, mode `rw` or `ro`, no path twice. The kernel closes the person's fence. The answer says, per mount, whether the host has a directory there. |
| `mounts-browse` | `mountsBrowse` | `path?` | `mounts.browse`: the directories under one host path, for the picker. The root without a path. |
| `fence-reload` | `fenceReload` | `user` | `fence.reload`: closes that person's fence and opens it again on the code on disk now. `_system` is a legal target; every other id is checked the way `mounts-set` checks one. Answers `{ user, services }`. |
| `status` | `status` | none | `status`: `{ daemon, restart, workspaces }` — what the daemon and every workspace are running, and whether the code on disk is newer. |
| `restart-request` | `restartRequest` | `reason` | `restart.request`: arms the restart latch. The reason is required, and the latch's own sentence — armed, already armed, or refused — is the answer. |

Only an admin may send any of them. Each checks its arguments first, so a refusal is a plain sentence before the kernel is asked, and answers `{ data }`. The admin's own id comes from `env.user`, never from the arguments.

The role is checked three times: the page draws only what `api/ui` listed for the person, the gateway answers `403` to a verb above the person's role before the package's code runs, and the kernel refuses an operator method from a fence whose user is not an admin.

## Use

An admin opens **Control panel** from the sidebar's ≡ menu and finds the six sections after Packages.

- **People**: a table of everyone with their role, status and since when. An **Add a person** form with id, role and password. Clicking a row opens a card with **Make an admin** or **Make a user**, **Suspend** or **Activate**, **Set password** and **Remove**, each behind a confirm popover. The admin's own row shows a note instead: another admin, or the host, changes that account.
- **Models**: the default model and the models every provider serves, with a filter. Read-only.
- **Mounts**: one table of every person's mounts with a column **On the host** (`bound`, or `skipped` and why) and an **Unbind** button per row, and a **Bind directory** form: the person, the host path with a **Choose…** picker over `mounts-browse`, the mode. Every change sends that person's whole list; the page says their fence reopens and their services restart, and names a path the host does not have. Changing your own mounts closes the fence this page is served from, so the page waits for the new one to answer instead of calling the lost request a failure. A mount marked skipped is written down and not in the fence.
- **Activity**: the kernel's journal, newest first, with a filter by kind and a reload.
- **Workspaces**: the daemon's own line (whether systemd supervises it, whether it is running older code than what is on disk, and that only `sudo systemctl restart thetis-runtime.service` replaces the kernel), then one row per workspace with a **Code** column in words — `running the code on disk`, `running code from 13:17 · newer on disk since 16:02`, or `not running · opens on the next request` — its services, and a **Reload** button behind a confirm. A workspace with no fence open has no button: there is nothing to reload. Reloading your own workspace closes the fence serving this page, so the page tolerates the lost request and waits for the new workspace to answer; after half a minute it says to run `thetis reload --user <id>` on the host. There is no button for everyone at once, by decision: `thetis reload --all` on the host does that without a command timeout and without cutting off the page that asked. The daemon's own line also asks for a **restart**, with a typed reason, since this is the card that says the daemon is running older code and that only a new process replaces the kernel; the control is offered when the daemon is stale and otherwise only when asked for, it is off with the reason said beside it when supervision or the deployed `Restart=` policy means a restart could not succeed, and the latch's sentence is shown word for word. `@thetis/tool-operator`'s chip owns the countdown and the Cancel.
- **Overview**: the configuration with secrets hidden. Read-only.

## Files

| File | Content |
|---|---|
| `package.json` | The six `panel` entries and the fifteen commands. |
| `index.js` | The commands: the argument checks, then one operator call each. |
| `ui/index.js` | `install(ext)`: registers the six sections. |
| `ui/people.js`, `ui/models.js`, `ui/mounts.js`, `ui/activity.js`, `ui/workspaces.js`, `ui/overview.js` | One section each, built from `ext.dom` and `ext.ui`, sending through `ext.request`. |
| `ui/index.css` | What the sections add to the shell's styles, under `.ua-`. |
| `test/ui-admin.test.js` | The tests. |

## Tests

`npm test` from the runtime root runs `test/ui-admin.test.js`: each command over a fake `env.kernel.operator.call` (the method and arguments it sends, what it refuses before the kernel is asked, the own-account refusal), and the browser modules (they parse, the entry defines `install` and nothing else, `install` registers exactly the six sections). `packages/gateway-web/test/gateway.test.ts` sends the verbs through a real gateway as an admin and as a user. The browser checklist is `packages/gateway-web/test/BROWSER.md`.

See docs/17-control-panel.md in the runtime repository.

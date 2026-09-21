# @thetis/ui-admin

The admin sections of the web gateway's control panel: People, Models, Mounts, Activity, Workspaces and Overview, plus one settings page per package with configuration under the Packages section, and the commands behind them. It is a `ui` package with no build step and no dependencies. Its browser modules run in the page; its commands run inside the admin's own fence, where `@thetis/gateway-web` calls them as the admin, and each one is one call over the kernel's operator channel. Every person gets the package by default; a user sees none of it, because `api/ui` drops the entries and verbs above the person's role.

## What it provides

The manifest declares `type: "ui"` and a `ui` block with `dir: "ui"`, `entry: "index.js"` and `style: "index.css"`. Every entry and every verb carries `role: "admin"`.

| Slot | Id | Label | Order | Note |
|---|---|---|---|---|
| `panel` | `people` | People | 20 | Who can sign in, and what they may do. |
| `panel` | `models` | Models | 30 | Which model answers by default, and what the providers serve. |
| `panel` | `configuration` | Package settings | 32 | Hangs under the shell's Packages section (`under: "packages"`): one page per package with configuration, named by the package. |
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
| `config-list` | `configList` | `user?` | `config.list`: a `ConfigReport` per package, at the system layer, or at that person's layer with `user`. |
| `package-info` | `packageInfo` | `name` | What one installed package is and where it stands: the kernel's record (version, type, scope, source, fork, what it replaces), the marketplace index's entry and whether the copy is behind it (`@thetis/marketplace`, imported when asked), and the git checkout of its files (branch, ahead and behind the upstream, files of this package changed). |
| `config-show` | `configShow` | `name`, `user?` | `config.show`: one package's report. |
| `config-set` | `configSet` | `name`, `key`, `value`, `user?` | `config.set`: writes one key at the system layer, or at the person's with `user`. `value` is any JSON but never null or undefined: removing a value is `config-unset`. The value is passed through and never appears in a message. |
| `config-unset` | `configUnset` | `name`, `key`, `user?` | `config.unset`: removes one key from that layer. |
| `config-reload` | `configReload` | none | `config.reload`: re-reads `thetis.config.json` and the env file; answers `{ changed, restarted }`. |
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

An admin opens **Control panel** from the sidebar's ≡ menu and finds the seven sections after Packages.

- **People**: a table of everyone with their role, status and since when. An **Add a person** form with id, role and password. Clicking a row opens a card with **Make an admin** or **Make a user**, **Suspend** or **Activate**, **Set password** and **Remove**, each behind a confirm popover. The admin's own row shows a note instead: another admin, or the host, changes that account.
- **Models**: the default model and the models every provider serves, with a filter. Read-only.
- **Package settings**: not a section of its own but pages under **Packages**: the nav lists, beneath Packages, every package with at least one configuration key (declared or stored), by name, with a red mark on one that is broken (the module answers the shell's `children()` from `config-list`). Clicking one opens that package's page: the heading with the package and its description, then the package card from `package-info` (`ui/package-card.js`): the version and type, whether everyone has it, where the copy came from (shipped with Thetis, a directory, or a registry repository with its pin), what it forked from and replaces, what the registry holds and whether an update is on offer, and the git checkout of its files (branch, commits not pushed, commits behind the upstream, files changed and not committed), with badges for a fork, an update and unpushed or uncommitted work. Then, from `config-show`, the kernel's one sentence about the configuration (red when broken), the layer picker (the system layer, or one person's own), **Reload the file**, and the package's card. A row per key: the key with its help, `required` and `admins only` badges, a control by type (text, number, a checkbox, a JSON box for an object or an array; a write-only password box for a secret that says `set` or `not set` beside it), and in small text where the value came from (`from the file`, `default`, `set for everyone`, `set by alice`, `inherited from @bitmuse/notion`) and which `${VAR}` is not in the environment. An undeclared key is a row too, typed by its value. **Clear** sits in the row whose value this layer holds. **Save** sends one `config-set` per key that changed; a JSON box that does not parse is marked in place and nothing is sent. A key declared `scope: "system"` is read-only in a person's view. After a save, a clear or a reload the page asks the nav to read its children again, so the mark follows. **Reload the file** calls `config-reload` and says what changed and which services restarted, or "Nothing changed." The form itself is `ui/config-form.js`, the same file `@thetis/ui-marketplace` carries for a person's own layer.
- **Overview**: the configuration with secrets hidden. Read-only.

## Files

| File | Content |
|---|---|
| `package.json` | The seven `panel` entries and the twenty commands. |
| `index.js` | The commands: the argument checks, then one operator call each. |
| `ui/index.js` | `install(ext)`: registers the seven sections. |
| `ui/people.js`, `ui/models.js`, `ui/configuration.js`, `ui/mounts.js`, `ui/activity.js`, `ui/workspaces.js`, `ui/overview.js` | One section each, built from `ext.dom` and `ext.ui`, sending through `ext.request`. |
| `ui/package-card.js` | The package card of a settings page, from `package-info`; `packageFacts` is the wording, tested here. |
| `ui/config-form.js` | One package's configuration card, from a `ConfigReport`. Kept byte-identical with `@thetis/ui-marketplace`'s copy, because a package's page may import only its own files; a test in ui-marketplace holds the two together. Its pure helpers (`kindOf`, `readValue`, `sourceText`, `brokenSentence`, `reloadSentence`) are tested here. |
| `ui/index.css` | What the sections add to the shell's styles, under `.ua-`. |
| `test/ui-admin.test.js` | The tests. |

## Tests

`npm test` from the runtime root runs `test/ui-admin.test.js`: each command over a fake `env.kernel.operator.call` (the method and arguments it sends, what it refuses before the kernel is asked, the own-account refusal), the `config-*` verbs (the arguments they pass to `config.*`, what they refuse, and that nothing is written to the console, so no value can be), the form's pure helpers, and the browser modules (they parse, the entry defines `install` and nothing else, `install` registers exactly the seven sections). `packages/gateway-web/test/gateway.test.ts` sends the verbs through a real gateway as an admin and as a user. The browser checklist is `packages/gateway-web/test/BROWSER.md`.

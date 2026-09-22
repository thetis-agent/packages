# @thetis/ui-marketplace

The Marketplace place of the web gateway: a gallery of what the registries offer and what is installed here, and one page per package with its README, its facts, what it brings, and the actions the person's role allows. It is a `ui` package with no build step; its one dependency is the `@thetis/marketplace` library, for reading the index and the README copies. Its browser modules run in the page; its commands run inside the person's own fence, where `@thetis/gateway-web` calls them as the person. Every person gets it by default.

## What it provides

The manifest declares `type: "ui"` and a `ui` block with `dir: "ui"`, `entry: "index.js"` and `style: "index.css"`.

| Slot | Id | Label | Order | Hint |
|---|---|---|---|---|
| `places` | `marketplace` | Marketplace | 20 | What the registries offer, and what is installed here |

Sixteen commands. The first eleven may be sent by any signed-in person and work on the person's own packages through `env.kernel.packages`, their own configuration layer through `env.kernel.config`, or their own fence through `fence.reload`; the last five carry `role: "admin"` and go through `env.kernel.operator.call`.

| Verb | Export | Who | What it does |
|---|---|---|---|
| `search` | `search` | anyone | `{ q?, type? }`. The rows, installed first, narrowed through the index's search; an installed package the index does not carry is matched on its name, type and description. Answers the index's facts, the rows, and who is asking. |
| `show` | `show` | anyone | `{ name }`. One row with its README copy, or `null` when no registry holds one, and `assets`: the images the README shows, as `{ [path]: { type, data } }`, as many as fit under the gateway's answer cap. |
| `install` | `install` | anyone | `{ source }`. `kernel.packages.install` into the person's own userspace. |
| `remove` | `remove` | anyone | `{ name }`. `kernel.packages.uninstall`. The files stay. |
| `delete` | `del` | anyone | `{ name }`. `kernel.packages.delete`: the package and its files under `packages/`. The kernel allows it only for the person's own scope. |
| `update` | `update` | anyone | `{ name }`. Installs the newer pinned source the registry holds. Refused when the package is not installed or not behind. |
| `unfork` | `unfork` | anyone | `{ name }`. `kernel.packages.unfork`: the userspace goes back to the package this fork was copied from. The fork's files are kept -- `delete` is what removes them. When the fork is the gateway serving the page, this answer is lost with it; the page treats that as the success and waits for the package that took its place. |
| `config-show` | `configShow` | anyone | `{ name }`. `kernel.config.show`: the person's own layer of an installed package, every key's state, secrets redacted. |
| `config-list` | `configList` | anyone | `kernel.config.show` over every installed package, folded to `[{ package, summary, broken }]` for the gallery; a package the kernel cannot report on is left out. |
| `config-set` | `configSet` | anyone | `{ name, key, value }`. `kernel.config.set` at the person's own layer. `value` is any JSON but never null or undefined: removing a value is `config-unset`. The value is passed through and never appears in a message. The kernel refuses a key declared `scope: "system"`. |
| `config-unset` | `configUnset` | anyone | `{ name, key }`. `kernel.config.unset`. |
| `fence-reload` | `fenceReload` | anyone | No arguments. `fence.reload` for `env.user`, which the kernel allows anyone for their own id. The fence closes and opens again on the code on disk now: this is what puts a version the workspace has not loaded into service. Answers `{ user, services }`. |
| `install-everyone` | `installEveryone` | admin | `{ source }`. `packages.installEveryone`. |
| `install-for` | `installFor` | admin | `{ user, source }`. `packages.install` for that person. |
| `remove-for` | `removeFor` | admin | `{ user, name }`. `packages.uninstall` for that person. |
| `promote` | `promote` | admin | `{ user, name }`. `packages.promote`: a person's package becomes the default for everyone under `@thetis`. |
| `people` | `people` | admin | The people an admin may install for, without the system user. |

Each answers `{ data }`; a refusal is a thrown error, which the gateway answers as `400 { error }`. The gateway answers `403` to an admin verb from a user before the package's code runs, and the kernel refuses an operator method from a fence whose user is not an admin, with one exception it allows anyone: `fence.reload` naming the caller's own id, which is what `fence-reload` sends.

## Use

**Marketplace** in the sidebar's ≡ menu, after **Control panel**, opens the place in the main pane. Escape or the close button returns to the conversation.

**The gallery** has a search box, one chip per package type, a note on the index (which registries, when refreshed, how many packages; or that there is no index yet), and a card per package: the name, description, version, type and registry, and the badges **Only me**, **Everyone** or **Available**, `fork of …`, `update to <version>`, `reload to <version>` or `identical to @thetis/gateway-web 0.2.0`, and the benchmark badge. Installed packages come first. An installed package whose configuration is missing something carries the kernel's one sentence about it in red, from one `config-list` call after the rows. Clicking a card opens the package's page. The query is kept, so coming back from a page shows the same list.

**A package page** has the crumb **Marketplace › name** back to the gallery. On the left, the README copy rendered by the shell's markdown, or "This package has no README." A local image the README shows (`![alt](bench/x/chart.svg)`) is drawn from the copy `show` sent, as a `data:` URL; one the answer does not carry shows as its alt text. On the right, a card with the badges, the description, the facts (installed version and commit, the registry's tip, the type, the license, forked from, replaces, source, and `loaded` — `0.2.1 in your workspace, 0.2.2 on disk: a reload applies it` — for the reload case), what the package brings as pills (tools, steps by phase, service, keywords, benchmark suites), and the actions the state and the role allow: **Install for me**, **Update to <version>**, **Reload my workspace** or **Go back to <origin>**, **Remove**, **Delete** for a package of your own scope, and for admins **Install for everyone**, **Make it the default for everyone**, and **Install for <person>** from a picker. Every action sits behind a confirm popover that names the package, where it comes from, whom it is for, and what happens next. Nothing is sent until the person confirms. There are three kinds of behind, and the page says which one this is. A package installed from a registry whose pin is older than the index offers **Update to <version>**, an install of the newer commit. A package shipped with the service is a link into the checkout, so its files are installed the moment they land and nothing is behind any registry: what the workspace is running is the version its fence read when it opened, and the page offers **Reload my workspace**, whose confirm says that the fence closes for a second, every open shell session in it ends, and the page reconnects on its own. That request is expected to be lost, because it closes the fence answering it, so the page waits for the new workspace rather than reporting a failure, and says what to do if it never answers. A fork is behind in a third way: the package it was copied from goes on being fixed and the copy does not. The card says so -- `fork of @thetis/gateway-web 0.1.1 · 0.2.0 is shipped now`, or the stronger `identical to @thetis/gateway-web 0.2.0, which is shipped` when the copy changed nothing at all -- the facts carry a **shipped now** row beside **forked from**, and the page offers **Go back to @thetis/gateway-web**. Its confirm says that the fork's files stay where they are, and, when the fork is a gateway, that this page is served by the package being replaced and will go quiet for a second. That request is lost the same way a reload's is, and is waited out the same way. Deleting the files is still **Delete**, which the person can reach once the shipped package is back. An installed package also has **Configure**: the card says the kernel's sentence when the package is missing something, and the button opens the configuration form under the README, on the person's own layer. A row per key says its state and where the value came from, a secret is a write-only box that says `set` or `not set`, a key declared for admins is read-only, **Clear** removes what this layer holds, and **Save** sends one `config-set` per key that changed. The form is `ui/config-form.js`, the same file `@thetis/ui-admin` carries for the system layer.

## Files

| File | Content |
|---|---|
| `package.json` | The place and the sixteen commands. |
| `index.js` | The commands. |
| `lib/rows.js` | The merge of the installed list with the index: the pin, the update offer with its `apply` (`install` or `reload`, the reload carrying `installed` and `available` as versions), the benchmark reports. |
| `ui/index.js` | `install(ext)`: registers the place; a name opens the page, nothing opens the gallery. |
| `ui/gallery.js`, `ui/page.js`, `ui/actions.js`, `ui/badges.js` | The gallery, the page, the actions with their popovers, the state badges. |
| `ui/config-form.js` | One package's configuration card. Kept byte-identical with `@thetis/ui-admin`'s copy, because a package's page may import only its own files; a test here holds the two together. |
| `ui/index.css` | The styles, under `.mk-`. |
| `test/ui-marketplace.test.js` | The tests. |

## Tests

`npm test` from the runtime root runs `test/ui-marketplace.test.js`: the row merge, the reload case (a copy whose workspace loaded an older version than the disk is behind with or without an index entry, the install wins when both hold, and the badge says `reload to <version>`), `search` and `show` with and without an index, the person's own install, remove, delete and update, `fence-reload` naming the person who sent it and nobody else, the admin verbs over a fake operator call, the `config-*` verbs over a fake `env.kernel.config` (what they pass, what they refuse, that nothing is written to the console), that `ui/config-form.js` is the same file as ui-admin's, and that the browser modules parse and the entry defines `install` and nothing else. `packages/gateway-web/test/gateway.test.ts` sends `search`, `show` and the admin verbs through a real gateway. The browser checklist is `packages/gateway-web/test/BROWSER.md`.

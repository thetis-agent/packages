# @thetis/ui-marketplace

The Marketplace place of the web gateway: a gallery of what the registries offer and what is installed here, and one page per package with its README, its facts, what it brings, and the actions the person's role allows. It is a `ui` package with no build step; its one dependency is the `@thetis/marketplace` library, for reading the index and the README copies. Its browser modules run in the page; its commands run inside the person's own fence, where `@thetis/gateway-web` calls them as the person. Every person gets it by default.

## What it provides

The manifest declares `type: "ui"` and a `ui` block with `dir: "ui"`, `entry: "index.js"` and `style: "index.css"`.

| Slot | Id | Label | Order | Hint |
|---|---|---|---|---|
| `places` | `marketplace` | Marketplace | 20 | What the registries offer, and what is installed here |

Eleven commands. The first six may be sent by any signed-in person and work on the person's own packages through `env.kernel.packages`; the last five carry `role: "admin"` and go through `env.kernel.operator.call`.

| Verb | Export | Who | What it does |
|---|---|---|---|
| `search` | `search` | anyone | `{ q?, type? }`. The rows, installed first, narrowed through the index's search; an installed package the index does not carry is matched on its name, type and description. Answers the index's facts, the rows, and who is asking. |
| `show` | `show` | anyone | `{ name }`. One row with its README copy, or `null` when no registry holds one, and `assets`: the images the README shows, as `{ [path]: { type, data } }`, as many as fit under the gateway's answer cap. |
| `install` | `install` | anyone | `{ source }`. `kernel.packages.install` into the person's own userspace. |
| `remove` | `remove` | anyone | `{ name }`. `kernel.packages.uninstall`. The files stay. |
| `delete` | `del` | anyone | `{ name }`. `kernel.packages.delete`: the package and its files under `packages/`. The kernel allows it only for the person's own scope. |
| `update` | `update` | anyone | `{ name }`. Installs the newer pinned source the registry holds. Refused when the package is not installed or not behind. |
| `install-everyone` | `installEveryone` | admin | `{ source }`. `packages.installEveryone`. |
| `install-for` | `installFor` | admin | `{ user, source }`. `packages.install` for that person. |
| `remove-for` | `removeFor` | admin | `{ user, name }`. `packages.uninstall` for that person. |
| `promote` | `promote` | admin | `{ user, name }`. `packages.promote`: a person's package becomes the default for everyone under `@thetis`. |
| `people` | `people` | admin | The people an admin may install for, without the system user. |

Each answers `{ data }`; a refusal is a thrown error, which the gateway answers as `400 { error }`. The gateway answers `403` to an admin verb from a user before the package's code runs, and the kernel refuses an operator method from a fence whose user is not an admin.

## Use

**Marketplace** in the sidebar's ≡ menu, after **Control panel**, opens the place in the main pane. Escape or the close button returns to the conversation.

**The gallery** has a search box, one chip per package type, a note on the index (which registries, when refreshed, how many packages; or that there is no index yet), and a card per package: the name, description, version, type and registry, and the badges **Only me**, **Everyone** or **Available**, `fork of …`, `update to <version>`, and the benchmark badge. Installed packages come first. Clicking a card opens the package's page. The query is kept, so coming back from a page shows the same list.

**A package page** has the crumb **Marketplace › name** back to the gallery. On the left, the README copy rendered by the shell's markdown, or "This package has no README." A local image the README shows (`![alt](bench/x/chart.svg)`) is drawn from the copy `show` sent, as a `data:` URL; one the answer does not carry shows as its alt text. On the right, a card with the badges, the description, the facts (installed version and commit, the registry's tip, the type, the license, forked from, replaces, source), what the package brings as pills (tools, steps by phase, service, keywords, benchmark suites), and the actions the state and the role allow: **Install for me**, **Update to <version>**, **Remove**, **Delete** for a package of your own scope, and for admins **Install for everyone**, **Make it the default for everyone**, and **Install for <person>** from a picker. Every action sits behind a confirm popover that names the package, where it comes from, whom it is for, and what happens next. Nothing is sent until the person confirms.

## Files

| File | Content |
|---|---|
| `package.json` | The place and the eleven commands. |
| `index.js` | The commands. |
| `lib/rows.js` | The merge of the installed list with the index: the pin, the update offer, the benchmark reports. |
| `ui/index.js` | `install(ext)`: registers the place; a name opens the page, nothing opens the gallery. |
| `ui/gallery.js`, `ui/page.js`, `ui/actions.js`, `ui/badges.js` | The gallery, the page, the actions with their popovers, the state badges. |
| `ui/index.css` | The styles, under `.mk-`. |
| `test/ui-marketplace.test.js` | The tests. |

## Tests

`npm test` from the runtime root runs `test/ui-marketplace.test.js`: the row merge, `search` and `show` with and without an index, the person's own install, remove, delete and update, the admin verbs over a fake operator call, and that the browser modules parse and the entry defines `install` and nothing else. `packages/gateway-web/test/gateway.test.ts` sends `search`, `show` and the admin verbs through a real gateway. The browser checklist is `packages/gateway-web/test/BROWSER.md`.

See docs/18-marketplace.md in the runtime repository.

# @thetis/marketplace

Mirrors the package registries this installation trusts and writes the searchable index that the Marketplace place of the web gateway (`@thetis/ui-marketplace`) reads. It is a `service` package in the default `systemPackages["_system"]`, so it runs in the system userspace fence: the one place that can write the shared directory, and one with egress to clone a remote registry.

## What it provides

One service, declared as `"thetis": { "type": "service", "service": { "export": "startService" } }`:

| Export | What it does |
|---|---|
| `startService(env)` | Refreshes every configured registry on start and every `refreshMinutes`, and logs `indexed N packages from M registries`, with `; failed: <name> (<error>)` when one did not refresh. |

A refresh clones each registry shallowly and sparsely into `home/marketplace/repos/<slug>` through the fence's `exec`, widens the checkout to the `README.md` files, reads every `package.json` with a `thetis` field at the first or second directory level (skipping `node_modules`), and writes:

- `<shared>/marketplace/index.json`: the index, the contract every reader uses.
- `<shared>/marketplace/readme/<registry>/<dir>.md`: a copy of each package's `README.md`, capped at 256 KiB (a `/` in `dir` becomes `__`; a `readme.md` is not a README).
- `<shared>/marketplace/readme/<registry>/<dir>__<path>.svg|.png`: a copy of each local `.svg` or `.png` the README shows with `![alt](path)`, at most 12 per README and 512 KiB each, resolved inside the package directory. A PNG copy is base64 text. The entry lists the copied paths in `readmeAssets`.

A registry that fails keeps the packages and copies of its last successful refresh and records the error in the index. Each index entry carries the `commit` it was read from and a pinned `source` of the form `<url>#<dir>@<commit>`, so an install takes exactly that commit and a later refresh does not move it.

The library, for readers in any fence (`@thetis/ui-marketplace` is the one today):

| Export | Use |
|---|---|
| `readIndex(env)` | The index, or `undefined` when there is none. `env` needs `shared`, `readFile` and `writeFile`; the agent's `StepEnv` does. |
| `search(index, query, { type?, limit? })` | Every word of the query must match. A match on the name scores 100, a keyword 10, the type 5, the description 1. |
| `readReadme(env, entry)` | The README copy of an index entry, or `undefined`. |
| `readReadmeAsset(env, entry, path)` | One image the README shows, as `{ type, data }` (SVG text or PNG base64), or `undefined` when the entry does not list it. |
| `behind(installed, index)` | Installed packages that are behind, each with `apply`: `"install"` when the pin is older than the index, and the `source` to install to catch up; `"reload"` when the fence loaded a different version than the one on disk; `"unfork"` when the package is a fork and the package it was copied from has gone on without it. `index` may be `undefined`, which leaves the reload and un-fork cases. |
| `refresh(env, registries)`, `registriesOf(config)` | What the service runs. |

No steps, no tools, no UI, no bench suites.

## Configuration

`config.packages["@thetis/marketplace"]`:

| Key | Default | Meaning |
|---|---|---|
| `registries[].url` | required | A git URL. `file://` works when the path is readable inside the system fence. |
| `registries[].name` | the last path segment of the URL | Shown on the cards and the pages. |
| `refreshMinutes` | `30` | How often the service refreshes. |

The default, declared in this package's manifest (`thetis.config.registries.default`), is one registry, `thetis`, at `https://github.com/thetis-agent/packages.git`; the kernel knows no registry of its own. Replacing the list replaces the set of extensions this installation trusts. The package reads no environment variables.

## Use

Trust a second registry:

```json
"packages": {
  "@thetis/marketplace": {
    "registries": [
      { "name": "thetis", "url": "https://github.com/thetis-agent/packages.git" },
      { "name": "team", "url": "https://git.example.com/thetis/packages.git" }
    ]
  }
}
```

Install the service into a running daemon, then see what is behind its registry and update:

```sh
thetis packages install @thetis/marketplace
thetis packages outdated --user alice
thetis packages update --user alice
thetis packages update @thetis/exa --user alice
thetis packages unfork @alice/gateway-web --user alice
```

Nothing updates on its own: the index says what is latest, the registry record says what is installed, and a person decides. An update is an install of the newer pinned source.

### The three kinds of behind

`behind` reports all three, and `apply` says which:

| `apply` | What is behind | What catches it up |
|---|---|---|
| `install` | The installation is pinned to a commit older than the one the index holds. | An install of the newer pinned source: `thetis packages update`. |
| `reload` | The package's `loadedVersion`, the version the workspace's fence read when it opened, is not the `version` on disk. | A reload of that workspace: `thetis reload --user <id>`. |
| `unfork` | The package is a fork, and its `fork.shipped` -- the version of its origin on disk now -- is not the version it was forked from; or its files are the origin's files and it is carrying no change at all. | Going back to the origin: `thetis packages unfork <name> --user <id>`. |

A package shipped with the service is a link into the checkout, so a version bump on disk is installed the moment it lands and has no pin to compare. What the workspace still runs is the copy its fence read when it opened, so the change is real and only a reload applies it. `thetis packages outdated` prints such a row as `@thetis/skills-hybrid  loaded 0.2.1, 0.2.2 on disk  thetis reload --user <id>`.

A fork has no pin and no loaded version to be behind on: it is a copy of a package that goes on being fixed, and the copy does not. The kernel measures it -- `PackageInfo.fork` carries the origin, the version of that origin on disk now, and whether the two directories hold the same files -- and `behind` turns that into a row: `@alice/gateway-web  identical to @thetis/gateway-web@0.2.0, which is shipped  thetis packages unfork @alice/gateway-web --user alice`, or `forked from @thetis/gateway-web@0.1.1; 0.2.0 is shipped now` when the copy did change something. A fork that differs from an origin it was forked from the current version of is left alone: that is a fork doing its job.

A package is only ever one of the three. The install case wins when more than one holds, because an install brings the new pin and reopens the fence anyway, and the fork case comes last: being told two things at once about one package is being told neither. `loadedVersion` is absent when no fence is open for the workspace, and then there is nothing to say.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: the service export. |
| `src/service.ts` | `startService`, `registriesOf`. |
| `src/mirror.ts` | `refresh`: the clone, the scan, the README copies and their images. |
| `src/index-file.ts` | The index and README paths, `readIndex`, `writeIndex`, `readReadme`, `readReadmeAsset`, the `IndexedPackage` type. |
| `src/search.ts` | `search`. |
| `src/updates.ts` | `behind`, `shortCommit`. |

## Tests

`npm test` from the runtime root. `test/marketplace.test.ts` builds a git registry in a temporary directory, refreshes it with a real `exec`, and checks the index, a failed registry, the README copies and their cap, the image copies and their rules, the search ranking, the configuration parsing, the pinned sources, and what `behind` lists, of all three kinds.

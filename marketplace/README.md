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

A registry that fails keeps the packages and copies of its last successful refresh and records the error in the index. Each index entry carries the `commit` it was read from and a pinned `source` of the form `<url>#<dir>@<commit>`, so an install takes exactly that commit and a later refresh does not move it.

The library, for readers in any fence (`@thetis/ui-marketplace` is the one today):

| Export | Use |
|---|---|
| `readIndex(env)` | The index, or `undefined` when there is none. `env` needs `shared`, `readFile` and `writeFile`; the agent's `StepEnv` does. |
| `search(index, query, { type?, limit? })` | Every word of the query must match. A match on the name scores 100, a keyword 10, the type 5, the description 1. |
| `readReadme(env, entry)` | The README copy of an index entry, or `undefined`. |
| `behind(installed, index)` | Installed packages whose pin is older than the index, each with the `source` to install to catch up. A package with no pin is never listed. |
| `refresh(env, registries)`, `registriesOf(config)` | What the service runs. |

No steps, no tools, no UI, no bench suites.

## Configuration

`config.packages["@thetis/marketplace"]`:

| Key | Default | Meaning |
|---|---|---|
| `registries[].url` | required | A git URL. `file://` works when the path is readable inside the system fence. |
| `registries[].name` | the last path segment of the URL | Shown on the cards and the pages. |
| `refreshMinutes` | `30` | How often the service refreshes. |

The shipped default is one registry, `thetis`, at `https://github.com/thetis-agent/packages.git`. Replacing the list replaces the set of extensions this installation trusts. The package reads no environment variables.

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
```

Nothing updates on its own: the index says what is latest, the registry record says what is installed, and a person decides. An update is an install of the newer pinned source.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: the service export. |
| `src/service.ts` | `startService`, `registriesOf`. |
| `src/mirror.ts` | `refresh`: the clone, the scan, the README copies. |
| `src/index-file.ts` | The index and README paths, `readIndex`, `writeIndex`, `readReadme`, the `IndexedPackage` type. |
| `src/search.ts` | `search`. |
| `src/updates.ts` | `behind`, `shortCommit`. |

## Tests

`npm test` from the runtime root. `test/marketplace.test.ts` builds a git registry in a temporary directory, refreshes it with a real `exec`, and checks the index, a failed registry, the README copies and their cap, the search ranking, the configuration parsing, the pinned sources, and what `behind` lists.

See docs/18-marketplace.md in the runtime repository.

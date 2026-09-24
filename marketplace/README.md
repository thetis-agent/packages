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
| `ahead(installed, index)` | The other direction: installed packages whose version is newer than the one the index holds (`state: "ahead"`), and packages no registry lists at all (`state: "unpublished"`). Unpublished work. `undefined` for the index answers nothing, because there is then no published version to compare against. |
| `compareVersions(a, b)`, `isNewer(a, b)` | Two version strings compared as versions: `0.10.0` is newer than `0.9.0`, and `1.0.0-rc.1` is older than `1.0.0`. There is no semver dependency in this repository. Re-exported from `@thetis/runtime/lib/versions`, which is where it now lives: `@thetis/package-publish` decides the same question on the way out, the two copies disagreed on 34 pairs out of 400, and a badge saying a package is ahead while the publish refuses it is the shape that disagreement takes months later. |
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

### A private registry

A registry the installation cannot read anonymously is reached with a **repository key**: an SSH key that belongs to this installation, not to a person, and is scoped to exactly one repository. Make one on the command line,

```sh
thetis repo-key generate git@github.com:thirteen-games/thetis-packages.git
```

or under **Marketplace → Registries** in the web gateway (`@thetis/ui-marketplace`), where adding a registry offers *Authentication: None | SSH key*. Either prints the key's public half; add it to the repository as a read-only deploy key, and `thetis repo-key test <url>` or the page's **Test** says whether the repository answers. The key is `@thetis/host-grants`'s to hold: the system fence's ssh-agent offers it for that repository and no other, which is the fence this service clones in, so the refresh needs nothing else.

There is no configuration field for this. Whether a registry uses SSH is derived from whether a repository key exists for its url, matched with `sameRepository` from `@thetis/runtime/lib/git-url`, so `git@github.com:o/r.git` and `https://github.com/o/r` share one key. A field saying "ssh" would go on saying it after the key was revoked; the key is the fact, so the key is what is read. The registry entry stays `{ name, url }`, and a url in any spelling works, because the system fence's git rewrites every spelling of that repository to the route the key is offered on.

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

### The other direction: ahead

Whoever maintains a package is also running it. Their checkout is the source their own fences load, so the moment they bump a version on disk their installation is on the new one while the registry every other installation reads still holds the old. That gap is real work that nobody else can have yet, and until now nothing anywhere showed it. `ahead` is the sibling of `behind` and needs nothing new recorded and no new configuration: the index already carries each package's published version, and the installed record already carries the local one.

| `state` | What it means | The wording everywhere |
|---|---|---|
| `ahead` | A registry holds this package at an older version than the one installed here. | `0.3.0 here, 0.2.0 published` |
| `unpublished` | No registry lists this package at all: a package of one's own that has never been shared. | `never published` |

Matched on the name alone, unlike `behind`, which matches on the repository too. `behind` is about a pin moving along one registry; the question here is whether *anyone* has this package yet, and a package published to a second registry is published. When two registries hold it, the newest of them is what this is measured against.

Three things are left out on purpose. **A fork**, because a fork is by construction a package no registry holds, so every fork would be listed as unpublished for ever; it already has a row of its own saying what it was copied from and how that package stands now, and that row is the truer of the two -- a fork is a private copy, not work waiting to be shared. **A package installed from a git registry that the index no longer carries**, for the same reason `behind` leaves it alone: a registry dropping a package is a statement about the registry. And **no index at all**, because without a mirror "nothing is published" would be a claim about the registries made without reading one.

Versions are compared as versions, not as strings: `0.10.0` is newer than `0.9.0`, a missing part counts as zero so `1.2` and `1.2.0` are the same version, build metadata after `+` is dropped, and a prerelease is older than the release it leads to, which is what keeps a fork's `0.1.1-fork.1` from ever reading as newer than the `0.1.1` it was copied from. That rule lives in `@thetis/runtime/lib/versions` and is the same one `@thetis/package-publish` publishes by, because two implementations of "is this newer" is one implementation too many.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: the service export. |
| `src/service.ts` | `startService`, `registriesOf`. |
| `src/mirror.ts` | `refresh`: the clone, the scan, the README copies and their images. |
| `src/index-file.ts` | The index and README paths, `readIndex`, `writeIndex`, `readReadme`, `readReadmeAsset`, the `IndexedPackage` type. |
| `src/search.ts` | `search`. |
| `src/updates.ts` | `behind`, `ahead`, `shortCommit`. |
| (`src/versions.ts`) | Gone to `@thetis/runtime/lib/versions`, so the publisher and the marketplace order versions with one function. `src/index.ts` re-exports it, and the cases in `test/marketplace.test.ts` still run against it. |

## Tests

`npm test` from the runtime root. `test/marketplace.test.ts` builds a git registry in a temporary directory, refreshes it with a real `exec`, and checks the index, a failed registry, the README copies and their cap, the image copies and their rules, the search ranking, the configuration parsing, the pinned sources, what `behind` lists, of all three kinds, and what `ahead` lists, of both -- with the version comparison exercised on its own, including `0.10.0` against `0.9.0` and a prerelease against its release.

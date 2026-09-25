---
name: marketplace
description: The Thetis marketplace: trusted registries, the mirrored index and READMEs, search, pinned sources, install, update, remove, the Marketplace place. Use when you ask what you can install, how to install or update from a registry, whether a package is behind, or how to add a registry.
metadata:
  title: Marketplace
  tags: [marketplace, registry, registries, index, search, install, update, outdated, pin, commit, readme, shared, gallery]
  related: [thetis/packages, thetis/web, thetis/configuration]
  version: 1
---
# Marketplace

The marketplace is the set of registries this installation trusts. A registry is one git repository that holds package directories. This is not the kernel registry file `registry.json`, which records what is installed.

`@thetis/marketplace` mirrors the registries and writes an index. It is a `service` package in the system userspace. `@thetis/ui-marketplace` is the Marketplace place of the web page. It reads the index.

An installation ships with one registry: `https://github.com/thetis-agent/packages.git`, the approved extensions.

## Registries

`config.packages["@thetis/marketplace"]`:

```json
{
  "registries": [{ "name": "thetis", "url": "https://github.com/thetis-agent/packages.git" }],
  "refreshMinutes": 30
}
```

| Key | Default | Meaning |
|---|---|---|
| `registries[].url` | required | A git URL. `file://` works when the path is readable inside the system fence. |
| `registries[].name` | the last path segment | Shown on the cards and the pages. |
| `refreshMinutes` | `30` | How often the service refreshes. |

Replace the list to replace the set of trusted extensions. Set `registries` to `[]` to index nothing. A registry holds packages at its first or second directory level. Each package directory has a `package.json` with a `thetis` field.

## The index

The index is `<shared>/marketplace/index.json`, where `<shared>` is `$THETIS_HOME/shared`. Package code reaches it as `env.shared`. Any fence can read it by path.

```json
{
  "version": 1,
  "updatedAt": "2026-09-14T00:00:00.000Z",
  "registries": [{ "name": "thetis", "url": "...", "commit": "<40 hex>", "error": "<only when the refresh failed>" }],
  "packages": [
    {
      "name": "@thetis/prompt-cache", "version": "0.1.0", "type": "loader",
      "description": "", "keywords": [],
      "registry": "thetis", "url": "...", "dir": "prompt-cache",
      "source": "...#prompt-cache@<commit>",
      "steps": [{ "id": "cache-hints", "phase": "call" }], "tools": [], "service": false,
      "readme": true
    }
  ]
}
```

`description` and `keywords` come from the package's `package.json`. Add them to make a package findable. The README copy is at `<shared>/marketplace/readme/<registry name>/<dir>.md`. A `/` in `dir` becomes `__`. The copy is capped at 256 KiB.

A refresh is a shallow `git clone` from the system userspace. A registry that fails keeps the packages of its last refresh and records the error. It does not fail a turn.

## Search

`search(index, query, { type?, limit? })` in the library. Every word of the query must match. A match on the name scores 100, on a keyword 10, on the type 5, on the description 1. An empty query lists everything.

## Pinned sources and install

The index is the latest. An install is a copy at one commit. Each entry's `source` is pinned:

```
https://github.com/thetis-agent/packages.git#tools-files@ae6fdfd733a5b1c46eb6f26e8a1d249182dcf1ce
```

A pin is exactly forty hexadecimal characters. Install a package with `install_package { source }` and that pinned source. The kernel fetches that one commit into `store/src/<slug>-<commit prefix>`. The pin is recorded, so a later refresh does not move it.

A **system package** is one shipped in `<root>/packages` or promoted into `$THETIS_HOME/packages`. It is already on disk and already built. Send its name, `@thetis/<name>`, and the kernel links that copy into your workspace. Anyone can do this, admin or not. On an installation whose registry is the same repository the checkout ships, nearly every package in the index is also a system package, and the marketplace installs it by name, never by clone.

The ownership rules apply to a *source*. A `@thetis/*` package installed from a git URL or a directory is an admin's act. A `@<user>/*` package installs for that user only.

## Update

Nothing updates on its own. From the host:

```sh
thetis packages outdated --user alice
thetis packages update --user alice
thetis packages update @thetis/exa --user alice
```

There are two kinds of behind, and `outdated` reports both.

| Kind | What is behind | What applies it |
|---|---|---|
| Install | The installation is pinned to a commit older than the one the index holds. | `thetis packages update`, which installs the newer pinned source. |
| Reload | The version the workspace's fence loaded is not the version on disk. | `thetis reload --user <id>`, which closes that fence and opens it again. |

An update is an install of the newer pinned source. The old link stands until the new copy is cloned, validated, and built.

A package shipped with the service is a link into the checkout. It has no pin, so it is never behind a registry, but a version bump on disk is installed the moment it lands while the workspace keeps running the copy its fence read when it opened. That is the reload kind. `outdated` prints it as:

```
@thetis/skills-hybrid	loaded 0.2.1, 0.2.2 on disk	thetis reload --user alice
```

From package code, `behind(installed, index)` in the library lists both kinds, each row carrying `apply: "install" | "reload"`. A package is only ever one of the two, and install wins when both hold, because an install reopens the fence anyway. The reload kind needs no index. A package with no fence open has no loaded version and is not listed.

## The Marketplace place

The place is the item **Marketplace** in the sidebar's menu. The gallery shows a search box, one chip per type, and one card per package. Installed packages come first, then the system packages you do not have, then what the registries offer.

A card says three things apart. **System** or **System · everyone**: the package is the installation's, and whether every person gets it by default. **Mine**: a package of your own scope. `from <registry>`: an offer that is not on disk here. **Installed**: it is in your workspace. A package page shows the README copy, the facts, what the package brings, and the actions the role allows.

| Action | Who | Command |
|---|---|---|
| Install | anyone | `install { source }`. A system package by name. Anything else by its pinned source. The popover says what the package's type brings. A host package or a storage driver has no Install. |
| Remove | anyone | `remove { name }`. Out of your workspace only. A system package stays on disk, and Install puts it back. |
| Update to version | anyone, when behind | `update { name }` |
| Delete | the owner of a `@<user>/*` package | `delete { name }` |
| Go back to what a fork was copied from | anyone | `unfork { name }` |
| Make it the default for everyone | admins, on a system package | `install-everyone { source: name }`. Every person gets it now and later. |
| Stop it being the default | admins, on a system package an admin marked | `unmark-everyone { name }`. New people stop getting it. Everyone who has it keeps it. A default the configuration or a promotion made is not undone here. |
| Install for everyone | admins, on a registry's offer | `install-everyone { source }`. Installed for the admin, then promoted into a system package. |
| Make it the default for everyone | admins, on their own package | `promote { user, name }` |
| Install for a person | admins | `install-for { user, source }`, `remove-for { user, name }` |

`search { q?, type? }` and `show { name }` read the index and the kernel's catalog of system packages. `people` lists the people an admin may install for. Every action sits behind a confirm popover.

## The library

Readers import from `@thetis/marketplace`: `readIndex(env)`, `search(index, query, opts)`, `readReadme(env, entry)`, and `behind(installed, index)`, which takes `undefined` for the index. `env` needs `shared`, `readFile`, and `writeFile`. The agent's `StepEnv` has them. Only the system userspace can write the shared directory.

## Sources

- packages/marketplace/README.md
- packages/ui-marketplace/package.json

---
name: marketplace
description: The Thetis marketplace. The registries an installation trusts (git repositories of packages), the @thetis/marketplace service that mirrors them, the index at <shared>/marketplace/index.json and the README copies beside it, search, pinned sources of the form url#dir@commit, install, update with thetis packages outdated and update, remove, and the Marketplace place of the web page with its commands. Use when you ask "what packages can I install", "how do I install from the registry", "is this package behind", "how do I update", "where is the index", or "how do I add a registry".
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

A pin is exactly forty hexadecimal characters. Install a package with `install_package { source }` and that pinned source. The kernel fetches that one commit into `store/src/<slug>-<commit prefix>`. The pin is recorded, so a later refresh does not move it. A shipped `@thetis/*` package is sent by name, so the built copy is linked and not cloned.

The ownership rules apply. A `@thetis/*` package installs for an admin. A `@<user>/*` package installs for that user only.

## Update

Nothing updates on its own. From the host:

```sh
thetis packages outdated --user alice
thetis packages update --user alice
thetis packages update @thetis/exa --user alice
```

An update is an install of the newer pinned source. The old link stands until the new copy is cloned, validated, and built. A shipped package has no pin and is never behind.

From package code, `behind(installed, index)` in the library lists the installed packages whose pin is older than the index.

## The Marketplace place

The place is the item **Marketplace** in the sidebar's menu. The gallery shows a search box, one chip per type, and one card per package with the badges **Only me**, **Everyone**, or **Available**. A package page shows the README copy, the facts, what the package brings, and the actions the role allows.

| Action | Who | Command |
|---|---|---|
| Install for me | anyone | `install { source }` |
| Update to version | anyone, when behind | `update { name }` |
| Remove | anyone | `remove { name }` |
| Delete | the owner of a `@<user>/*` package | `delete { name }` |
| Install for everyone | admins | `install-everyone { source }` |
| Make it the default for everyone | admins | `promote { user, name }` |
| Install for a person | admins | `install-for { user, source }`, `remove-for { user, name }` |

`search { q?, type? }` and `show { name }` read the index. `people` lists the people an admin may install for. Every action sits behind a confirm popover.

## The library

Readers import from `@thetis/marketplace`: `readIndex(env)`, `search(index, query, opts)`, `readReadme(env, entry)`, and `behind(installed, index)`. `env` needs `shared`, `readFile`, and `writeFile`. The agent's `StepEnv` has them. Only the system userspace can write the shared directory.

## Sources

- packages/marketplace/README.md
- packages/ui-marketplace/package.json

---
name: marketplace
description: Extensions and the marketplace: trusted registries, the index and READMEs, pinned sources, install, updates, the Extensions place, the Updates ready card. Use when you ask what you can install, how to install or update an extension, whether one is behind, or how to add a registry.
metadata:
  title: Marketplace
  tags: [marketplace, extensions, registry, registries, index, search, install, update, updates, apply, outdated, pin, commit, readme, shared, gallery, fork, copy]
  related: [thetis/packages, thetis/web, thetis/configuration]
  version: 1
---
# Marketplace

The marketplace is the set of registries this installation trusts. A registry is one git repository that holds package directories. This is not the kernel registry file `registry.json`, which records what is installed.

`@thetis/marketplace` mirrors the registries and writes an index. It is a `service` package in the system userspace. `@thetis/ui-marketplace` is the **Extensions** place of the web page and the **Updates ready** card. It reads the index.

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

An admin manages the list on **Extensions › Registries**: add, rename, remove, give a private registry a key, and test it. (On the host: `thetis config set` and `thetis repo-key`.) Replace the list to replace the set of trusted extensions. Set `registries` to `[]` to index nothing. A registry holds packages at its first or second directory level. Each package directory has a `package.json` with a `thetis` field.

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

A scope is a namespace, not an owner: anyone installs any registry source into their own workspace, and each workspace's copy is its own entry in the kernel registry. The one rule is about `@thetis`: a *source* (a git URL or a directory) whose manifest claims it is an admin's to install.

## Updates

Every person sees new code for their extensions on the **Updates ready** card, bottom right, between replies: "Updates for 3 extensions: web gateway, compaction and skills", with **Review** (the Updates section of the Extensions place) and **Update all**. It never shows or changes while a reply runs.

**Update all** fetches what a registry holds newer, then applies once, drained: "Applying… a few seconds, your conversations are kept", or "Pausing your reply at a safe point… it continues afterwards" when a reply is running. Then it waits for the space to come back and refreshes the page, which says "Updated: …". It asks first only when terminal shells are open: "Update now? 2 terminal sessions will close. Conversations and files are kept." It never cancels a reply.

The same card carries two more things. The changes you make to the person's own extensions apply by themselves when your reply ends ("Applied your changes to moo"), or wait under **Changes ready · Apply** when a terminal is open or the person set `applyOwnChanges` to `ask`. A copy whose changes are all in the official version, or that has none, is offered **Switch back**.

So after an install or an edit, tell the person what changed. Do not ask them to reload anything.

Under the card there are two kinds of behind:

| Kind | What is behind | What applies it |
|---|---|---|
| Install | The installation is pinned to a commit older than the one the index holds. | Update: an install of the newer pinned source, then an apply. The old link stands until the new copy is cloned, validated, and built. |
| Apply | The version the space's fence loaded is not the version on disk. | Update: an apply alone, which closes that fence and opens it again, drained. |

A package shipped with the service is a link into the checkout. It has no pin, so it is never behind a registry, but a version bump on disk is installed the moment it lands while the space keeps running the copy its fence read when it opened. That is the apply kind.

From package code, `behind(installed, index)` in the library lists both kinds, each row carrying `apply: "install" | "reload"`. A package is only ever one of the two, and install wins when both hold, because an install reopens the fence anyway. The reload kind needs no index. A package with no fence open has no loaded version and is not listed. `@thetis/ui-marketplace`'s `updates` command is what the card reads: `{ items, own, forks, shells, applyOwnChanges }`.

An admin sees who has not applied an update under **Control panel › Extensions › All extensions**, with **Apply updates for N people**. (On the host: `thetis packages outdated --user alice`, `thetis packages update [<name>] --user alice`, and `thetis reload --user alice --drain`.)

## The Extensions place

The place is **Extensions** in the sidebar's ≡ menu. It is a store in three sections, each with its count: **Updates (n)**, drawn from the same answer as the card, with **Update all** at the top; **Installed (n)**; and **Discover (n)**, what the installation ships that the person does not have and what the registries offer. The installation's own machinery (host, storage, gateway, provider and loader packages, the page's plumbing, the benchmarks) is behind **Show system components**, and so are the type chips.

A card shows the extension's label, its description, `name · version`, and the badges **Included** (everyone's default), **Yours** (your own), **Update ready**, **No changes · switch back** or **Official version is newer**. An extension whose settings miss something says `Setup needed: …`.

An extension's page leads with what it is, **What you get** (`3 tools · 2 skills · 1 page`), **Setup needed**, and the actions. **Technical details** holds the README copy, the facts and the commit pair.

| Action | Who | Command |
|---|---|---|
| Install | anyone | `install { source }`. A system package by name. Anything else by its pinned source. A host package or a storage driver has no Install. |
| Update | anyone, when behind | One button for both kinds of behind: it goes through the same path as **Update all**. |
| Remove | anyone | `remove { name }`. Out of your space only. A system package stays on disk, and Install puts it back. |
| Delete | anyone, for a copy under their own home | `delete { name }` |
| Configure | anyone | The settings form on the person's own layer: `config-show`, `config-set`, `config-unset`. |
| Switch back to the official version | anyone, on a copy | `unfork { name }`. The copy's files stay. |
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
- packages/ui-marketplace/README.md

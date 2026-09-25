---
name: packages
description: How a Thetis package is built and managed: the manifest, install sources, the store, forks and the way back, delete, promote, publish, unpublish. Use when you write, install, fork or remove a package, publish one to a registry or take one out of one, change a shipped one, make one the default for everyone, or an install was refused.
metadata:
  title: Packages
  tags: [packages, manifest, install, uninstall, fork, unfork, delete, promote, publish, unpublish, everyone, steps, tools, provider, service, store, registry, scope, owner]
  related: [thetis/pipeline, thetis/using, thetis/marketplace, thetis/troubleshooting]
  version: 1
---
# Packages

A package is the unit of everything in Thetis. A package is a directory with a `package.json` that has a `thetis` field. The kernel reads manifests at the start of each turn. A package you install is live on the next turn.

## The manifest

```json
{
  "name": "@alice/example",
  "version": "0.1.0",
  "description": "Adds a greeting tool and a context step.",
  "type": "module",
  "main": "index.js",
  "thetis": {
    "type": "loader",
    "steps": [ { "id": "add-context", "phase": "prompt", "export": "addContext" } ],
    "tools": [ { "name": "greet", "description": "Say hi", "parameters": { "type": "object", "properties": {} }, "export": "greet" } ]
  }
}
```

The kernel validates these rules. A manifest that fails does not install.

| Field | Rule |
|---|---|
| `name` | Required. Must match `@<scope>/<name>`. The pattern is `^@[a-z0-9-]+/[a-z0-9._-]+$`. The scope gives ownership. |
| `version` | Required. A string. |
| `thetis.type` | Required. A string. The kernel does not check the value. |
| `thetis.steps[]` | Each entry needs `id`, `phase`, and `export`. |
| `thetis.tools[]` | Each entry needs `name`, `description`, and `export`. `parameters` is optional. |
| `thetis.service` | When present, needs `export`. |
| `thetis.forkedFrom` | When present, needs a scoped `name` and a `version`. |

The kernel does not reject fields it does not know. `thetis.ui` and `thetis.bench` reach the packages that read them. The full field table is in [references/manifest.md](references/manifest.md).

`description` is one sentence. People see it in the control panel and in the marketplace. The model sees it in the system prompt.

## Types

The type is a label. The kernel reads `steps` and `tools` of every package, whatever its type. Only `provider` has kernel behavior: the provider registry calls its factory export.

| Type | Contributes |
|---|---|
| `loader` | Steps that put content into the call. |
| `tool` | Tools. |
| `memory` | Steps that read and write `harness`. |
| `provider` | A model source. |
| `enumerator` | A replacement for the default plan. |
| `gateway` | An endpoint. |
| `service` | A long-running process. Any type can also declare a `service`. |
| `ui` | Additions to the web page. See `thetis/web`. |
| `skill`, `skill-type` | A directory of skills, and a skill library or loader. See `thetis/skills`. |

## Code

Use plain ECMAScript modules. A build step is optional. The agent imports `main` (default `index.js`) with a query `?v=<modification time>`. A changed file is a new module.

A step:

```js
export async function addContext(ctx) {
  const memory = await ctx.env.readFile("memory.md").catch(() => "");
  return { call: { ...ctx.call, system: `${ctx.call.system ?? ""}\n\n${memory}` } };
}
```

A tool:

```js
export async function greet(args, env) {
  const r = await env.exec("whoami");
  return `hi ${args.name}, I am ${r.stdout.trim()}`;
}
```

A tool receives the arguments and a `ToolEnv`: `cwd`, `root`, `store`, `shared`, `exec`, `readFile`, `writeFile`, `kernel`, `storage`, `session` (`{ id, user, parent? }`), and `config` (the package's own configuration). A tool returns a string or a JSON value. A thrown error becomes `error: <message>` for the model. The turn continues.

## Keeping documents: `env.storage()`

`env.storage(namespace?)` gives a package a `Store` of JSON documents: `get`, `set`, `delete`, `list`, `clear`. The kernel prefixes the namespace with `userspaces/<your user>/<your package>/`, so a package reaches only what it wrote and nothing a package names can leave its own tree. One document is capped at 256 KiB; an array at the top, or a `null` anywhere inside, is refused.

Use it for what a package has to remember between turns. A file under home works too, and is the better choice for anything a person should be able to read and edit.

`delete_package` clears a package's documents; `uninstall` leaves them, so reinstalling finds them again.

**One trap.** A UI command's `env.storage()` is bound to `@thetis/gateway-web`, not to the package whose command is running. A page that needs its own documents has to go through a tool or a service of its own package.

A provider:

```js
export function createProvider(config) {
  return {
    async models() { return [{ id: "my-model" }]; },
    async *call(call) {
      yield { type: "text", delta: "hello" };
      yield { type: "usage", usage: { total_tokens: 12 } };
    },
  };
}
```

Declare it with `"thetis": { "type": "provider", "export": "createProvider" }`. A provider runs in the userspace where it is installed. Return an entry with id `*` to accept any model id. The events are `text`, `tool_call`, `usage`, and `error`.

A service:

```js
export async function startService(env) {
  env.log("started");
  return { stop: () => {} };
}
```

Declare it with `"service": { "export": "startService" }`. `env` is the step environment plus `config` and `log`. The service runs while the package is installed and the fence is open. `thetis serve` starts every service. A one-shot CLI command does not. Do not write to `process.stdout` from a service or a step. It corrupts the protocol. Write to `stderr` with `console.error` or `env.log`.

## Scopes are namespaces

A scope is a label the author chose. It does not say who owns the package, and the kernel does not check it against who installs. Anyone installs any source into their own workspace. The registry keeps one entry per workspace, so two people holding the same name from different sources, or at different pins, never touch each other's entry.

One scope has a meaning. `@thetis/*` is the installation's: the kernel resolves those names on disk, in `<root>/packages` or `$THETIS_HOME/packages`. Anyone installs a `@thetis/*` package by name, because the copy is already there and already built. Only an admin installs a *source* (a git URL or a directory) whose manifest claims `@thetis`. The refusal has the code `unauthorized`.

Name your own packages `@<your user id>/<name>`. That is the convention a fork follows, and it keeps names apart between people. Nothing enforces it.

## Sources of a package

`install_package` takes one argument, `source`.

| Source | Detection | Action |
|---|---|---|
| A path | Anything that is not a URL or a system name | Resolved against home. Must stay inside the userspace root. |
| A git URL | Starts with `http://`, `https://`, `git@`, `git://`, `ssh://`, or `file://`, or ends with `.git`. `#<dir>` names a directory inside the repository. `@<commit>` pins one commit of 40 hexadecimal characters. | A shallow clone into `store/src/<slug>`. With a pin, `store/src/<slug>-<commit prefix>`. |
| A system name | `@thetis/<name>` with no further `/` | Links the shipped or promoted package. Anyone. |

## The install procedure

1. Get the package directory.
2. Read and validate `package.json`.
3. Check the namespace: a source claiming `@thetis` needs an admin.
4. Check `peerDependencies`. Each peer must be installed in this userspace. `@thetis/runtime` is provided by the platform. Failure code: `peer`.
5. Build inside the fence. With `scripts.build`: `npm install --no-audit --no-fund && npm run build`. Else with `dependencies`: `npm install --omit=dev --no-audit --no-fund`. Else nothing. The timeout is 300000 milliseconds. A non-zero exit fails with the code `build`.
6. Make sure the `main` file exists.
7. Link `store/node_modules/<name>` to the package directory.
8. Record the package in the kernel registry.

The fence has no host loopback and, in network mode `none`, no network. An `npm install` then fails. Prefer packages with no dependencies.

## The store and the kernel registry

```
<userspace>/store/
  node_modules/@thetis/<name>  -> <root>/packages/<dir>
  node_modules/@<user>/<name>  -> ../../../home/packages/<dir>
  src/<slug>/
```

The kernel keeps `$THETIS_HOME/registry.json` in the service plane. You cannot read it from the fence. Each record has `name`, `everyone` when it is the default for everyone, `forkedFrom` for a fork, and `installs`: one entry per workspace, `{ version, type, source, replaced?, replacedSource? }`, with `source` `{ kind, ref }` and `kind` `system`, `local`, or `git`. There is no owner. A record whose last entry is removed is deleted. Read your installed packages with `env.kernel.packages.list()`, or with the `list_packages` tool. Read the system packages on disk, installed or not, with `env.kernel.packages.catalog()`.

## The cycle from a conversation

1. `write_path` writes `packages/<name>/package.json` and `packages/<name>/index.js` under home.
2. `shell` runs `node` to test the module.
3. `install_package` with `source: "packages/<name>"` installs it.
4. On the next turn the steps run and the tools are attached.

## Forks

A fork is a copy of an installed package under your own scope. It runs in place of the original.

`fork_package` takes `name` (an installed package) and `as` (a directory name under `packages/`, default the unscoped name). It:

1. Copies the package root without `node_modules` to `packages/<as>` under home.
2. Rewrites `package.json`. `name` becomes `@<you>/<as>`. `version` becomes `<origin version>-fork.1`, or `fork.N+1` when a fork is already installed. `scripts` and `devDependencies` are removed. A dependency the original resolves is linked into the copy and removed from the field. `thetis.forkedFrom` is set to `{ name, version }` of the original.
3. Returns the path, the origin, what the copy brings, and the next step.

The tool does not install. It refuses a package that is not installed and a target directory that exists.

The replace rule: when a manifest carries `forkedFrom` and that package is installed here, the install replaces it in one operation. The original's service stops. Its link goes. The fork's link comes. The fork's service starts.

The other direction is a refusal, not a second replacement. Installing a package into a userspace that already holds a fork of it is refused with the code `fork` and a message naming the fork: `bob holds @bob/gwfork, a fork of @thetis/gateway-web: un-fork @bob/gwfork first, or leave it in place`. Nothing is removed, linked or recorded. The two directions differ because what they would displace differs: a displaced original is shipped or promoted and comes back by name, while a displaced fork is the person's own work and nothing could put it back. Un-fork first if you want the original; otherwise there is nothing to do.

The restore rule: `uninstall_package` or `delete_package` of the fork puts the original back in the same call, when the registry recorded what the fork displaced. A fork installed into a userspace the original was not in has no such record, and then an uninstall leaves nothing in its place. For a gateway that is a person locked out of their browser.

The way back: `unfork_package { name, deleteFiles }` reads the original off the fork's own manifest instead of off the registry, checks it is on disk here before it removes anything, and then swaps. The original comes back at the version it is at now, with every change it has had since the fork. `deleteFiles` defaults to false: the copy under `packages/` is kept. The CLI is `thetis packages unfork <name> --user <id> [--delete-files]`.

What a fork costs, and how to see it: `list_packages` measures a fork against the original as the original stands now. `fork of @thetis/gateway-web@0.1.1, 0.2.0 is shipped now` means the original has moved on and the copy has not. `identical to the shipped 0.2.0` means the copy holds the same files as the shipped package, so it is changing nothing and will see no further fix. `thetis packages outdated` lists both. Neither shows in a version number: a fork's version follows the day it was made, not the day the original moved.

A shipped TypeScript package cannot rebuild inside the fence. The fork carries the built `dist/`. Edit the JavaScript in `dist/`, or build outside and copy the result in.

```
fork_package { name: "@thetis/tools-plan" }
edit_path { path: "packages/tools-plan/index.js", old_text: "...", new_text: "..." }
install_package { source: "packages/tools-plan" }
unfork_package { name: "@alice/tools-plan" }
delete_package { name: "@alice/tools-plan" }
```

## Uninstall and delete

`uninstall_package` takes `name`. It stops the service, removes the link, and removes the record. The files stay.

`delete_package` takes `name`. It uninstalls the package and deletes its directory under `packages/` in home. It works only for a package in your own scope, installed from under home. `@thetis/*` is refused with the code `unauthorized`.

## Promote and install for everyone

These are operator methods. Only an admin calls them: from the CLI, from the control panel, or from an admin's fence through `env.kernel.operator.call`.

`packages.promote { user, name }` makes a person's package the default for everyone. The directory is copied to `$THETIS_HOME/packages/<basename>` with its `node_modules`. The name becomes `@thetis/<basename>`. The owner's original is removed. The package is installed into every existing userspace. New userspaces get it at creation. The copy does not follow later changes to the source. The CLI command is `thetis packages promote <name> --user <id>`.

Neither method reaches a person who is holding a fork of the package, and neither stops on one. Both answer `{ name, userspaces, forks }`: `userspaces` are the people it installed for, `forks` is `[{ user, fork }]` for the people whose own copy was left in place. The same pair goes into the journal row, so an admin reading it later still knows the package is not everywhere and whose copy is standing in for it. The people themselves see it on their own listing: their fork's row says the package it was copied from is the default for everyone (`everyone else gets it`). The seed a new userspace gets skips a forked package for the same reason.

`packages.installEveryone { source }` installs a package for every person, now and later. A shipped `@thetis/*` package is linked into every person and marked `everyone`. Another source is installed for the admin first. A `@thetis/*` name from a registry is then linked into every person. A package in the admin's own scope is promoted.

The system userspace is never included. The full operator table is in [references/operator-methods.md](references/operator-methods.md).

## Publishing to a registry

A registry is a git repository. Each package is a directory in it holding a `package.json` with a `thetis` field. `@thetis/marketplace` clones a registry, indexes it, and pins every entry as `<url>#<dir>@<commit>`. So publishing is one act: put the package's directory in the registry repository at a new version, commit, push. Nothing else makes a new version visible to anybody.

`@thetis/package-publish` is the package that does it. It is a `tool` package, so it runs in the person's own fence with their own agent-held ssh key. The registry's own authentication decides who may publish; Thetis decides nothing about that.

Versions are compared with one function for the whole system, `@thetis/runtime/lib/versions`, which the marketplace's badges also use, so "is this newer" cannot be answered one way on a card and another way by the publish. It is lenient: every pair of strings has an order, including a hand-written `1.2`, which a registry is free to hold and this package is not free to reject. What a package may be published *at* is the stricter question and is separate: that has to be a real semantic version.

The rule the whole thing turns on: the version has to move past what the registry already holds for that package. A publish at a version the registry has is invisible to every update check there is, because the index carries the version it carried before and every installation goes on believing it is current. A package the registry does not hold yet is a first publish and passes.

Two sources, told apart by looking, not by being told:

| Source | What happens |
|---|---|
| A package under `packages/` in home, which is not a git repository | The registry is cloned into `<home>/<workDir>/<target>`, the package's directory is copied in at the name the registry already uses for it, and the clone is committed and pushed. |
| A package inside a checkout that is already the registry repository | Nothing is cloned and nothing is copied. Only that package's directory is committed, in the checkout, and the branch is pushed. |

The second is the case of whoever maintains the shipped packages: one checkout that is the package source, the git work tree, the registry and the push origin at once. Detection is the resolved package path being inside a git work tree whose `origin` is the same repository as the target's url. `git@github.com:o/r.git`, `https://github.com/o/r.git` and `.../o/r` are one repository.

| Tool | Arguments | Answers |
|---|---|---|
| `publish_targets` | `package` (optional) | The configured targets. With a package: what each one holds for it, the directory it holds it in, and whether what is here is in front of that. `lastPublish` and `lastRemoval` say what last happened at the target, whatever the package was. With a package there is also `record`, which says what happened to *that* package here: `{ published, publishedAt, removed, removedAt, latest }`. Use `record` when the question is about one package, because the per-target keys are overwritten by the next publish of anything else. |
| `publish_package` | `package` (required), `to`, `version` or `bump` (`patch`, `minor`, `major`), `as` (`origin` or `itself`, for a fork), `with`, `message`, `dryRun` | The package, the target, `was` and `now`, whether it was a first publish, the files, the commit and the branch, plus `source` (the pin the marketplace will carry) and `indexed: false`. |
| `unpublish_package` | `package` (required), `to`, `with`, `message`, `dryRun` | `removed: true`, the package, the target, `held` (the version the registry was carrying), the directory, the files and the commit. |

`package` is a name installed in this workspace or a path to a directory. `to` is a target's name, required when more than one is configured. `dryRun` does everything up to the commit and says what would go.

A publish is refused, with a sentence naming what to do and a code on the error, when the version does not move past what the target holds (`not-newer`), the manifest is not sound (`manifest`: no `name`, no `version`, no `thetis`, a `main` that is not there, a version that is not semantic), or a configured `verify` command exits non-zero (`verify-failed`).

### What else the branch is carrying

Scoping a commit to one directory does not scope the push. `git push` sends the branch, so a branch that already holds commits to other packages publishes those too. Committing across several packages and then shipping one is a normal way to work, so this is the common case and not a corner.

`with` is how it is settled: the names of the other packages you mean to publish as well.

| A package riding on the branch | What happens |
|---|---|
| Not publishable on its own: its version has not moved past what the registry holds, or its manifest is unsound | Refused (`unpushed-others`), always. It can never be named in `with`, because its code would land under a version every installation already holds and no update check will look at again. The refusal gives the way out: `git branch keep; git reset --hard origin/<branch>; git checkout keep -- <dir>`, then publish one at a time. |
| Publishable, not named | Refused (`unnamed-others`), and listed. A version having moved is not consent: a person raises a version to try something as readily as to ship it. |
| Publishable and named in `with` | It goes, as a publish in its own right: every gate the named package gets, `verify` included, its own journal row and its own record. |
| Named in `with` but not riding | Refused (`not-a-passenger`). A name that quietly does nothing is worse than a name that is wrong. |

`dirty-index` is the smaller cousin: other files are *staged*, and only this package's directory would be committed, so they would be left behind. `dryRun` reports all three in `blockers` instead of refusing, and lists what `with` could still take in `nameable`.

### Publishing a fork

A fork carries `thetis.forkedFrom`, so "publish my change" over a fork is two different acts wearing the same words. It can mean the change becomes the next version of the package it came from, which is upstreaming. Or it can mean this is a package of its own now, apart from the one it came from. Both are legitimate, so the publish refuses (`ambiguous-fork`) until `as` says which, and the refusal prints the command for each.

| `as` | What lands in the registry | What happens to your copy |
|---|---|---|
| `origin` | The origin's name, the version you are publishing, and no `forkedFrom`, in the origin's own directory. A registry entry carrying `forkedFrom` would displace the very package it is, in every userspace that took it. | Nothing. It keeps its own name, its `0.1.0-fork.1` version and its `forkedFrom`, and goes on being your fork. |
| `itself` | The fork, under its own name, in its own directory, `forkedFrom` and all. | An ordinary publish: the version is written into the fork's manifest. |

The question is asked once. The gate fires when the target holds the origin and does not yet hold this fork; once the fork is in the registry under its own name a publish has only one reading left, and the registry is what remembers the answer.

The version of an as-origin publish is a version of the origin, never of the fork. `0.1.0-fork.1` is never a candidate and never the default, and a `bump` steps from what the target holds for the origin, or from the version the fork was taken at when the target holds none. `as origin` on a package that is not a fork is `not-a-fork`; a word that is neither is `bad-as`; a fork inside a checkout that is itself the registry is `fork-in-checkout`, because a publish there commits the directory the package already sits in and copies nothing.

Un-forking after an as-origin publish is the loop closing: you go back to the origin, and the origin is now your own change.

### Taking a package out of a registry

`unpublish_package` deletes the package's directory from the registry, commits and pushes. It is its own tool and its own verb rather than an argument to `publish_package`, because an argument that inverts what a command does is how people delete things by accident.

`package` is the name the registry holds it under, or the directory it keeps it in. It does not have to be installed here. The target has to actually hold it (`not-held`), the directory has to hold the package that was named (`name-mismatch`), and a removal pushes the branch exactly as a publish does, so the same three gates about what else is committed on the branch apply, `with` and all.

Say what it does and does not do, because the two halves are easy to confuse. The package leaves the registry now and the marketplace index at its next refresh, so nobody installs it again. Every installation that already has it keeps it, goes on running it, and is not told: `behind` leaves a package the index no longer carries alone, because a registry dropping a package is not the same thing as a package being out of date. A removal is therefore not a recall, and it is irreversible from the product's point of view. When the package is inside a checkout that is itself the registry, the source and the registry are the same directory and the removal takes it.

Where a workspace may publish is configuration: `config.packages["@thetis/package-publish"].targets`, each `{ name, url, branch? }`. The list is empty by default, so a new installation publishes nowhere until somebody says otherwise.

```
publish_targets { package: "@alice/hello" }
publish_package { package: "packages/hello", to: "thetis", bump: "minor", dryRun: true }
publish_package { package: "@thetis/exa", version: "0.4.0" }
publish_package { package: "@thetis/exa", bump: "patch", with: ["@thetis/skills"] }
publish_package { package: "@alice/exa", to: "thetis", as: "origin", bump: "minor" }
unpublish_package { package: "@alice/hello", to: "thetis" }
```

The command line is `thetis publish <package> --to <target> [--version <v> | --bump patch|minor|major] [--as origin|itself] [--with <name>]... [--dry-run]`, and `thetis unpublish <package> --to <target> [--with <name>]... [--dry-run]`.

The registry holds the new version as soon as the push returns, but the marketplace index does not: it is refreshed on the service's own schedule, 30 minutes by default. So a gallery goes on showing the old version for a while, and the answer's `indexed: false` is there to be said out loud rather than looked past.

## Sources

- src/kernel/packages/manifest.ts
- src/kernel/control.ts
- packages/tool-exec/src/index.ts
- packages/package-publish/lib/publish.js
- packages/package-publish/lib/fork.js
- packages/package-publish/lib/unpublish.js

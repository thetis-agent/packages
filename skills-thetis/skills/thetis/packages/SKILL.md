---
name: packages
description: How a Thetis package is built and managed: the manifest and its thetis field, install sources, the store, forks and the way back, delete, promote, uninstall. Use when you write, install, fork or remove a package, change a shipped one, make one the default for everyone, or an install was refused.
metadata:
  title: Packages
  tags: [packages, manifest, install, uninstall, fork, unfork, delete, promote, everyone, steps, tools, provider, service, store, registry, scope, owner]
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

## Scopes and ownership

| Scope | Owner | Rule |
|---|---|---|
| `@thetis/*` | The system | Shipped in `<root>/packages` or promoted into `$THETIS_HOME/packages`. Only an admin or the system user installs one. |
| `@<user>/*` | That user | Only that user installs it, and only into that user's userspace. |

Name your packages `@<your user id>/<name>`. A wrong scope fails with the code `unauthorized`.

## Sources of a package

`install_package` takes one argument, `source`.

| Source | Detection | Action |
|---|---|---|
| A path | Anything that is not a URL or a system name | Resolved against home. Must stay inside the userspace root. |
| A git URL | Starts with `http://`, `https://`, `git@`, `git://`, `ssh://`, or `file://`, or ends with `.git`. `#<dir>` names a directory inside the repository. `@<commit>` pins one commit of 40 hexadecimal characters. | A shallow clone into `store/src/<slug>`. With a pin, `store/src/<slug>-<commit prefix>`. |
| A system name | `@thetis/<name>` with no further `/` | Links the shipped package. Admin only. |

## The install procedure

1. Get the package directory.
2. Read and validate `package.json`.
3. Check ownership.
4. Check `peerDependencies`. Each peer must be installed in this userspace. `@thetis/contracts`, `@thetis/lib`, and `@thetis/kernel` are always satisfied. Failure code: `peer`.
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

The kernel keeps `$THETIS_HOME/registry.json` in the service plane. You cannot read it from the fence. Each record has `name`, `version`, `type`, `owner`, `source` (`{ kind, ref }` with `kind` `system`, `local`, or `git`), and `userspaces`. A fork's record also has `forkedFrom`, `replaced`, and `replacedSource`. Read your installed packages with `env.kernel.packages.list()`, or with the `list_packages` tool.

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

`packages.installEveryone { source }` installs a package for every person, now and later. A shipped `@thetis/*` package is linked into every person and marked `everyone`. Another source is installed for the admin first. A `@thetis/*` name from a registry is then linked into every person. A package in the admin's own scope is promoted.

The system userspace is never included. The full operator table is in [references/operator-methods.md](references/operator-methods.md).

## Sources

- packages/kernel/src/packages/manifest.ts
- packages/kernel/src/control.ts
- packages/tool-exec/src/index.ts

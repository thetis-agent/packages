# The manifest, field by field

Standard fields the kernel reads:

| Field | Use |
|---|---|
| `name` | Required. Must match `@<scope>/<name>`, pattern `^@[a-z0-9-]+/[a-z0-9._-]+$`. The scope gives ownership. |
| `version` | Required. A string. |
| `description` | One sentence. Shown in the control panel, the marketplace index, and the system prompt's package list. |
| `keywords` | Indexed by the marketplace search. |
| `main` | The module the agent imports. Default `index.js`. Relative to the package directory. |
| `dependencies` | When not empty and there is no build script, install runs `npm install --omit=dev`. |
| `peerDependencies` | Each peer must be installed in the same userspace. `@thetis/runtime` is provided by the platform. |
| `scripts.build` | When present, install runs `npm install` and then `npm run build`. |
| `license` | Every shipped package has `MIT`. Shown on the marketplace page. |

The `thetis` field:

| Field | Type | Use |
|---|---|---|
| `type` | string, required | The package type. An open set. |
| `steps` | array | Pipeline steps. Each entry needs `id`, `phase`, and `export`. |
| `tools` | array | Tools. Each entry needs `name`, `description`, and `export`. `parameters` is an optional JSON schema object. `group` is an optional tool group id that puts the tool in a group other than its package's. |
| `export` | string | The factory export of a provider, or the function export of an enumerator. Default `createProvider` for providers. |
| `service` | `{ export }` | A long-running process. The agent starts the export when the fence opens under `thetis serve`. |
| `publish` | array | Declared ports. The kernel records the field and does not act on it. |
| `forkedFrom` | `{ name, version }` | Set on a fork. Installing the fork replaces the named package when it is installed in the same userspace. |
| `bench` | object | Opts the package into benchmark suites. The kernel does not read it. See `thetis/bench`. |
| `ui` | object | What the package adds to the web page. The kernel does not read it. See `thetis/web`. |
| `skills` | string | A directory of skills relative to the package root, usually `"skills"`. The kernel does not read it. See `thetis/skills`. |
| `config` | object | The settings this package takes, one entry per key. **Validated on install: a malformed declaration refuses the install.** See below. |
| `toolGroup` | object | The tool group this package's tools form, for `@thetis/tool-groups`: `{ id, brief, tags, alwaysOn }`. Every field is optional. The kernel does not read it. See below. |

## `thetis.config`: declaring a setting

A key name matches `^[A-Za-z_][A-Za-z0-9_]*$`. Each declaration is an object:

| Field | Values | Use |
|---|---|---|
| `type` | `string`, `number`, `boolean`, `object`, `array` | Required. A value of the wrong type is refused when it is set. |
| `secret` | boolean | Kept in a private namespace: never shown, never echoed by a tool, named but not valued in the journal. |
| `required` | boolean | The package cannot work without it. The panel and the command line say so before the model finds out. |
| `default` | any | The bottom layer. Checked against `type`. |
| `scope` | `system`, `user` | `system`: only an admin sets it, at the system layer, and a person's own layer never overrides it. Default `user`. |
| `help` | string | One sentence, shown in the form. |

Declaring is what makes a key real. The value your code receives is the merge of four layers, later winning: the declared `default`, the `packages[<name>]` block of `thetis.config.json`, the system layer, then the person's own layer. A fork's declaration replaces its origin's, and the merge runs along the fork chain, so a person's override on the origin still beats a file entry on the fork.

Your code reads the result as `env.config` in a tool, or `ctx.config` in a step. A person sets it with the `configure_package` tool or the Configure form; an admin sets a system default with `thetis config set`.

## `thetis.toolGroup`: naming a tool group

`@thetis/tool-groups` scopes the tool list to the groups a conversation looks like it needs. Every package that declares tools is one group by default: the id is the package name without its scope (`@bitmuse/moo` is `moo`; when two packages share an unscoped name each keeps its scope, `bitmuse/moo`), the brief is the first sentence of `description`, and there are no tags, so the group is reached only by the dense fallback, a skill edge, `tool_search`, or a call by name. A package says more with:

```json
"thetis": { "toolGroup": { "id": "web", "brief": "Search and read the web with Exa.", "tags": ["web", "search", "url", "website", "research"], "alwaysOn": false } }
```

| Field | Use |
|---|---|
| `id` | The group id. Lowercase. Default: the unscoped package name. |
| `brief` | One line for the prompt's `# Tool groups` section and `tool_search`. Default: the first sentence of `description`. |
| `tags` | Lowercase words that mean this group is wanted, matched against the first message. A multi-word tag needs its words adjacent. Pick words that rarely occur in a conversation that does not want the group. |
| `alwaysOn` | `true` admits the group for every conversation. A group whose packages everyone has is always on anyway. |

A tool with `"group": "<id>"` sits in that group instead of its package's, so a package can host several groups. A group only tools declare takes its brief from the first such tool's description. A skill whose `metadata.tags` carry `tool-group:<id>` admits the group when the skill is pinned or universal. See `thetis/using`.

A kernel registry record, in `$THETIS_HOME/registry.json`:

```json
{
  "name": "@alice/hello",
  "version": "0.1.0",
  "type": "loader",
  "owner": "alice",
  "source": { "kind": "local", "ref": "packages/hello" },
  "userspaces": ["alice"]
}
```

`kind` is `system`, `local`, or `git`. `ref` is the system directory, the local path relative to home, or the git source with its pin. A fork's record also carries `forkedFrom`, `replaced`, and `replacedSource`. A record with no userspaces is deleted.

What package code sees for each installed package, `PackageInfo`, from `ctx.packages.list()` or `env.kernel.packages.list()`: `{ name, version, type, description, root, thetis, source?, forkedFrom?, everyone?, everyoneBy?, replaced? }`. `source.kind` is `system` for a package shipped or promoted here, `git` or `local` otherwise. `everyone` is `true` when every person gets the package by default, and `everyoneBy` says who decided that: `config` (the `systemPackages["*"]` list), `promoted`, or `marked` (an admin). `env.kernel.packages.catalog()` lists every system package on disk in the same shape, whether or not this workspace has it; anyone may install one of those by name.

Sources: src/kernel/packages/manifest.ts, src/contracts/config.ts, src/contracts/packages.ts.

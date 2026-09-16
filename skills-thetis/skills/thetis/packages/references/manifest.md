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
| `peerDependencies` | Each peer must be installed in the same userspace. `@thetis/contracts`, `@thetis/lib`, and `@thetis/kernel` are always satisfied. |
| `scripts.build` | When present, install runs `npm install` and then `npm run build`. |
| `license` | Every shipped package has `MIT`. Shown on the marketplace page. |

The `thetis` field:

| Field | Type | Use |
|---|---|---|
| `type` | string, required | The package type. An open set. |
| `steps` | array | Pipeline steps. Each entry needs `id`, `phase`, and `export`. |
| `tools` | array | Tools. Each entry needs `name`, `description`, and `export`. `parameters` is an optional JSON schema object. |
| `export` | string | The factory export of a provider, or the function export of an enumerator. Default `createProvider` for providers. |
| `service` | `{ export }` | A long-running process. The agent starts the export when the fence opens under `thetis serve`. |
| `publish` | array | Declared ports. The kernel records the field and does not act on it. |
| `forkedFrom` | `{ name, version }` | Set on a fork. Installing the fork replaces the named package when it is installed in the same userspace. |
| `bench` | object | Opts the package into benchmark suites. The kernel does not read it. See `thetis/bench`. |
| `ui` | object | What the package adds to the web page. The kernel does not read it. See `thetis/web`. |
| `skills` | string | A directory of skills relative to the package root, usually `"skills"`. The kernel does not read it. See `thetis/skills`. |

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

What package code sees for each installed package, `PackageInfo`, from `ctx.packages.list()` or `env.kernel.packages.list()`: `{ name, version, type, description, root, thetis, forkedFrom?, everyone?, replaced? }`. `everyone` is `true` when every person gets the package.

Sources: docs/05-packages.md, docs/plans/skills.md, packages/kernel/src/packages/manifest.ts.

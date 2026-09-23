---
name: configuration
description: The Thetis configuration: $THETIS_HOME, every field of thetis.config.json with its default, per-package settings and secrets, ${VAR} interpolation. Use when you ask where the config is, how to set the model or a package setting, why an API key is empty, or how to add a system package.
metadata:
  title: Configuration
  tags: [configuration, config, model, phases, packages, systempackages, fence, door, env, secrets, apikey, interpolation, defaults, home]
  related: [thetis/fence, thetis/packages, thetis/pipeline]
  version: 1
---
# Configuration

## Files

```
$THETIS_HOME/
  thetis.config.json      The configuration file. Created by `thetis init`.
  thetis.sock             The control socket while `thetis serve` runs. Mode 0600.
  store/                  The records: users, auth, the package registry, the grants, the configuration layers.
  journal.jsonl           The append-only record of operator acts, turns, and services.
  packages/               Promoted packages. Read-only in every fence.
  shared/                 Written by the system userspace. Read-only in every other fence.
  userspaces/<user>/      One directory per user.
```

`THETIS_HOME` defaults to `~/.thetis`. The `.env` file in the checkout sets it to `.thetis`, which resolves to `<root>/.thetis`. The fence hides `$THETIS_HOME` from you. Only `packages/` and `shared/` under it are bound in. You cannot read the configuration file from a fence.

## Loading

1. Start from the defaults.
2. Read `thetis.config.json` when it exists. Copy its top-level fields over the defaults. The `fence` object is merged one level deep.
3. Replace every `${NAME}` in every string with the environment variable `NAME`. A missing variable becomes an empty string. There is no warning.

The CLI loads `.env` from the current directory and then from `<root>`. A variable that is already set is not replaced. Each CLI invocation reads the file, and the daemon re-reads it on `thetis config reload`.

## Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | `anthropic/claude-sonnet-5` | The initial `call.model` of every turn. |
| `phases` | string[] | `["history","prompt","tools","call","execute","after"]` | The phase order. `call` shapes the request; `execute` makes it, through the `call` step of `@thetis/harness-core`. |
| `enumerator` | `{ package, export }` | not set | A package enumerator that replaces the default plan. |
| `systemPackages` | object | see below | System packages linked into a userspace when it is created. |
| `packages` | object | `{}` | The file layer of per-package configuration. |
| `fence.sandbox` | `auto`, `bwrap`, `none` | `auto` | The sandbox mode. |
| `fence.network` | `auto`, `egress`, `none`, `host` | `auto` | What a fence can reach. |
| `fence.limits` | `{ memoryMb, pids, cpuPercent }` | `1024`, `512`, `200` | Per-fence resource limits. |
| `door.host`, `door.port` | string, number | `127.0.0.1`, `8777` | The one host port. |
| `requestTimeoutMs` | number | `600000` | Timeout of one fence request. |

Derived fields are set from the checkout and the home at load time. The file never holds them: `home`, `systemPackagesDir` (`<root>/packages`), `promotedPackagesDir` (`<home>/packages`), `sharedDir` (`<home>/shared`), `agentPath`, `fence.readOnly`, and `fence.hidden`.

The defaults of the object fields:

```json
"systemPackages": {
  "*": ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache", "@thetis/tools-files", "@thetis/tools-plan", "@thetis/terminal", "@thetis/gateway-web", "@thetis/ui-tools", "@thetis/ui-context", "@thetis/projects", "@thetis/ui-admin", "@thetis/ui-marketplace", "@thetis/skills", "@thetis/skills-thetis", "@thetis/skills-hybrid", "@thetis/tool-groups", "@thetis/ui-skills"],
  "_system": ["@thetis/provider-openrouter", "@thetis/gateway-login", "@thetis/marketplace"]
}
```

`packages` defaults to `{}`: the kernel compiles in no default for any package. A package's defaults are in its own manifest, under `thetis.config.<key>.default`, and are the `default` layer of its configuration. The ones that used to be here: `@thetis/provider-openrouter` declares `apiKey: "${OPENROUTER_API_KEY}"` and `baseUrl`, `@thetis/marketplace` declares `registries`, `@thetis/skills-hybrid` and `@thetis/tool-groups` declare `embeddings: { "apiKey": "${OPENROUTER_API_KEY}" }`. `thetis config show <package>` reports each with `source: default`.

An installation made before a package joined `"*"` has its own `systemPackages` in `thetis.config.json`, and the kernel does not rewrite that file: add the package there, or install it for everyone with `thetis packages install @thetis/<name>`.

`"*"` applies to every person's userspace, together with every promoted package. A user id applies to that userspace only. `_system` gets only its own list. An existing userspace gets a new system package with `thetis packages install @thetis/<name> --user <id>`.

## Per-package configuration

`config.packages[<name>]` reaches:

- the steps of that package, as `ctx.config`.
- the tools of that package, as `env.config`.
- the provider factory of that package, as its argument.
- the service of that package, as `env.config`.

The kernel never sends the configuration of one package to another package. A web page command does not get it. A provider's secret stays in the fence of that provider: a harness's call step sends the request through `env.kernel.providers.call`, and the kernel routes it to the provider's fence. The OpenRouter key reaches only the system userspace. The kernel's own environment, `OPENROUTER_API_KEY` included, reaches no fence.

To give your own package a setting, **declare it in your manifest** under `thetis.config`, then set it with the `configure_package` tool or the Configure form. A declaration is what makes a key real: the kernel validates it on install, so a malformed one refuses the install, and a declared key gets a type, a default, a help line and a place in the form. The four layers, lowest first: `default` (the manifest, re-read on every call), the file (`config.packages[...]` in `thetis.config.json`), the system layer (`thetis config set`), the person's own. A plain-object value merges one level deep across layers, so a file layer `embeddings: { baseUrl }` keeps the declared `embeddings.apiKey`; arrays and scalars replace. Asking an operator to add `config.packages[...]` on the host is for an installation-wide override, never for a default. The field table is in `thetis/packages`, in `references/manifest.md`.

## When a configuration change takes effect

`CONFIG_TIERS` in `src/kernel/config.ts` declares this per key of `thetis.config.json`, and `thetis config reload` prints which of the three happened:

| Tier | Keys | What it takes |
|---|---|---|
| `dispatch` | `model`, `phases`, `enumerator`, `systemPackages`, `packages`, `control` | `thetis config reload`, live at once |
| `fence` | the whole `fence` block, `requestTimeoutMs` | `thetis config reload`, which closes every fence so each reopens with it |
| `boot` | `door`, `storage` | a new daemon process: `thetis restart` |

**A key with no entry is treated as `boot`.** So a new configuration key that nobody declared a tier for is silently un-reloadable, and the fix is a line in `CONFIG_TIERS` rather than anything at the call site. A person's own package settings are not in this table at all: `config.set` from a fence, the Configure form and the `configure_package` tool all take effect on the next call, with no reload of anything. Nor is a manifest default: it is re-read on every call.

`thetis config reload` also names the keys it could **not** apply, rather than looking like it worked:

```
changed: model, fence.docker, door.port
live now: model
applied by reopening every fence: fence.docker
NOT applied -- these are read once at startup and need a new process: door.port (thetis restart)
```

Known keys:

| Package | Keys |
|---|---|
| `@thetis/provider-openrouter` | `apiKey`, `baseUrl`, `headers`, `defaults`, `retries`, `cache`. Set `defaults.max_tokens` high enough for the model's reasoning. |
| `@thetis/prompt-cache` | `enabled`, `ttl`, `systemTtl`, `anchorStride`, `maxBreakpoints`, `explicitVendors`, `overrides`, `diagnostics`, `affinity`. |
| `@thetis/marketplace` | `registries`, `refreshMinutes`. |
| `@thetis/gateway-login` | `secure`. |
| `@thetis/exa` | `apiKey`, `baseUrl`, `timeoutMs`, `defaults`. |
| `@thetis/skills-hybrid` | `fusionWeight`, `denseThreshold`, `minTerms`, `pinLimit`, `pinBodies`, `embeddings`. |
| `@thetis/tool-groups` | `routeThreshold`, `denseFallback`, `denseMode`, `denseThreshold`, `fusionWeight`, `alwaysOn`, `listAlwaysOn`, `embeddings`. |

`@thetis/gateway-web`, `@thetis/harness-core`, `@thetis/tool-exec`, `@thetis/tools-files`, `@thetis/tools-plan`, and `@thetis/projects` have no keys. `@thetis/terminal` takes `shell`, `sessions`, `bufferBytes`, `idleMinutes` and `waitMs`; see `thetis/using`.

## Secrets

Write a secret as `${NAME}` in the configuration and put the value in `<root>/.env`. Do not write the literal key into the file. `thetis config` prints the interpolated configuration with the key. The operator method `config.get` and the Overview section replace strings under a key that matches `key`, `secret`, `token`, or `password` with `•••`.

## Change the configuration

1. Edit `$THETIS_HOME/thetis.config.json` on the host.
2. `thetis config reload`. It says which keys are live, which reopened the fences, and which want `thetis restart`.

To change the model for one user only, install a package with a `prompt` step that sets `call.model`. To change the model for one turn, a gateway passes `opts.model` to `sessions.send`.

A minimal file:

```json
{
  "model": "anthropic/claude-sonnet-5",
  "fence": { "sandbox": "auto" }
}
```

The provider's key needs no line here: its manifest default is `${OPENROUTER_API_KEY}`, and `.env` holds the value.

## Sources

- src/kernel/config.ts
- src/kernel/control.ts
- src/lib/config.ts

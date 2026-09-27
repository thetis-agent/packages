---
name: configuration
description: Thetis settings: an extension's settings form, the server settings, every field of thetis.config.json with its default, secrets, ${VAR} interpolation. Use when you ask where a setting is, how to set the model or an extension setting, why an API key is empty, or how to add a default extension.
metadata:
  title: Configuration
  tags: [configuration, config, settings, configure, tidy, model, phases, packages, systempackages, fence, door, env, secrets, apikey, interpolation, defaults, home]
  related: [thetis/fence, thetis/packages, thetis/pipeline]
  version: 1
---
# Configuration

## Where a setting is set

Settings are set on an extension's page. Admins set the server's settings on the host.

| Setting | Who | In the browser | Otherwise |
|---|---|---|---|
| An extension setting, for yourself | anyone | **Extensions ›** the extension **› Configure**: one row per key, its value and where it came from. A secret is a write-only box that says `set` or `not set`. | The `configure_package` tool, and `package_config` to read one. |
| An extension setting, for everyone or for one person | admin | **Control panel › Extensions ›** the extension **› Settings**, with a layer picker. | `thetis config set <package> <key> <value> [--user <id>]` on the host. |
| The server's own settings (`thetis.config.json`, `.env`) | admin | **Control panel › Advanced › Server settings** shows them, secrets hidden. They are edited on the host. | Edit the file, then `thetis config reload`. |

A saved extension setting is live on the next call: nothing to apply and nothing to restart. The one exception is a package with a service, which starts again on its own when its setting changes (`configure_package` says `The service was restarted.`).

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

The CLI loads `.env` from the current directory and then from `<root>`. A variable that is already set is not replaced. Each CLI invocation reads the file, and the daemon re-reads it on `thetis config reload`, or when an admin presses **Read the file again** on an extension's Settings tab.

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
  "*": ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache", "@thetis/tools-files", "@thetis/tools-plan", "@thetis/terminal", "@thetis/gateway-web", "@thetis/ui-tools", "@thetis/ui-context", "@thetis/projects", "@thetis/ui-admin", "@thetis/ui-marketplace", "@thetis/skills", "@thetis/skills-thetis", "@thetis/skills-hybrid", "@thetis/tool-groups", "@thetis/ui-skills", "@thetis/effort", "@thetis/compaction", "@thetis/ui-workspace"],
  "_system": ["@thetis/provider-openrouter", "@thetis/gateway-login", "@thetis/marketplace"]
}
```

`packages` defaults to `{}`: the kernel compiles in no default for any package. A package's defaults are in its own manifest, under `thetis.config.<key>.default`, and are the `default` layer of its configuration. The ones that used to be here: `@thetis/provider-openrouter` declares `apiKey: "${OPENROUTER_API_KEY}"` and `baseUrl`, `@thetis/marketplace` declares `registries`, `@thetis/skills-hybrid` and `@thetis/tool-groups` declare `embeddings: { "apiKey": "${OPENROUTER_API_KEY}" }`. `thetis config show <package>` reports each with `source: default`.

`thetis init` writes a file with only what differs from the defaults: nothing, or the `door` its `--host` and `--port` name. A default written into the file stops following the default when a newer Thetis changes it. An older `init` wrote every default down; `thetis config tidy` takes out every value equal to its default and every package value the store's system layer shadows, and says what it took out (`--dry-run` only says). A `systemPackages` in the file replaces the default list whole, so tidy keeps it and names the defaults it lacks.

An installation whose file has its own `systemPackages` does not get a package that joined `"*"` later. An admin makes it the default for everyone with **Make it the default for everyone** on the extension's page in **Extensions** (on the host: `thetis packages install @thetis/<name>`), or adds it to the file.

`"*"` applies to every person's userspace, together with every promoted package. A user id applies to that userspace only. `_system` gets only its own list. A person installs any system package into their own space by name, with **Install** in **Extensions**; an admin installs one for somebody else with **Install for <person>** there (on the host: `thetis packages install @thetis/<name> --user <id>`).

## Per-package configuration

`config.packages[<name>]` reaches:

- the steps of that package, as `ctx.config`.
- the tools of that package, as `env.config`.
- the provider factory of that package, as its argument.
- the service of that package, as `env.config`.

The kernel never sends the configuration of one package to another package. A web page command does not get it. A provider's secret stays in the fence of that provider: a harness's call step sends the request through `env.kernel.providers.call`, and the kernel routes it to the provider's fence. The OpenRouter key reaches only the system userspace. The kernel's own environment, `OPENROUTER_API_KEY` included, reaches no fence.

To give your own package a setting, **declare it in your manifest** under `thetis.config`, then set it with the `configure_package` tool or the **Configure** form on the extension's page. A declaration is what makes a key real: the kernel validates it on install, so a malformed one refuses the install, and a declared key gets a type, a default, a help line and a place in the form. The four layers, lowest first: `default` (the manifest, re-read on every call), the file (`config.packages[...]` in `thetis.config.json`), the system layer (`thetis config set`), the person's own. A plain-object value merges one level deep across layers, so a file layer `embeddings: { baseUrl }` keeps the declared `embeddings.apiKey`; arrays and scalars replace. Asking an operator to add `config.packages[...]` on the host is for an installation-wide override, never for a default. The field table is in `thetis/packages`, in `references/manifest.md`.

## When a configuration change takes effect

`CONFIG_TIERS` in `src/kernel/config.ts` declares this per key of `thetis.config.json`, and a re-read says which of the three happened:

| Tier | Keys | What it takes |
|---|---|---|
| `dispatch` | `model`, `phases`, `enumerator`, `systemPackages`, `packages`, `control` | a re-read of the file: live at once |
| `fence` | the whole `fence` block, `requestTimeoutMs` | a re-read, which closes every fence so each reopens with it |
| `boot` | `door`, `storage` | **Restart Thetis** (on the host: `thetis restart`) |

The re-read is **Read the file again** on an extension's Settings tab under **Control panel › Extensions** (on the host: `thetis config reload`).

**A key with no entry is treated as `boot`.** So a new configuration key that nobody declared a tier for is silently un-reloadable, and the fix is a line in `CONFIG_TIERS` rather than anything at the call site. A person's own package settings are not in this table at all: `config.set` from a fence, the Configure form and the `configure_package` tool all take effect on the next call, with no reload of anything. Nor is a manifest default: it is re-read on every call.

The re-read also names the keys it could **not** apply, rather than looking like it worked:

```
changed: model, fence.docker, door.port
live now: model
applied by reopening every fence: fence.docker
NOT applied -- these are read once at startup and need a new process: door.port (thetis restart)
```

Known keys:

| Package | Keys |
|---|---|
| `@thetis/harness-core` | `turnContext`, `timeZone`; the silence watch `modelStallMs`, `toolStallMs`, `stallBackoff`, `stallMaxMs`, `nudgeMs`, `nudgeAttempts`, `nudgeModel`; the round retry `retryAttempts` (5), `retryBaseMs` (2000), `retryMaxMs` (60000), `retryBudgetMs` (300000); the resume `autoResume` (true), `resumeMaxAgeMs` (1800000). |
| `@thetis/provider-openrouter` | `apiKey`, `baseUrl`, `headers`, `defaults`, `retries`, `cache`, `requestTimeoutMs`, `streamStallMs`. Set `defaults.max_tokens` high enough for the model's reasoning. |
| `@thetis/compaction` | `enabled`, `threshold`, `window`, `windows`, `keepTokens`, `minShedTokens`, `summaryModel`, `summaryMaxTokens`, `summaryReasoning`, `summaryTimeoutMs`, `maxFailures`. |
| `@thetis/ui-marketplace` | `applyOwnChanges`: `auto` (the default) applies the changes to a person's own extensions when a reply ends, `ask` shows **Changes ready** with **Apply**. |
| `@thetis/workflows` | `concurrency`, `costCapUsd`. |
| `@thetis/prompt-cache` | `enabled`, `ttl`, `systemTtl`, `anchorStride`, `maxBreakpoints`, `explicitVendors`, `overrides`, `diagnostics`, `affinity`. |
| `@thetis/marketplace` | `registries`, `refreshMinutes`. |
| `@thetis/gateway-login` | `secure`. |
| `@thetis/exa` | `apiKey`, `baseUrl`, `timeoutMs`, `defaults`. |
| `@thetis/skills-hybrid` | `fusionWeight`, `denseThreshold`, `minTerms`, `pinLimit`, `pinBodies`, `embeddings`. |
| `@thetis/tool-groups` | `routeThreshold`, `denseFallback`, `denseMode`, `denseThreshold`, `fusionWeight`, `alwaysOn`, `listAlwaysOn`, `embeddings`. |

`@thetis/gateway-web`, `@thetis/tool-exec`, `@thetis/tools-files`, `@thetis/tools-plan`, `@thetis/ui-workspace` and `@thetis/projects` have no keys. `@thetis/terminal` takes `shell`, `sessions`, `bufferBytes`, `idleMinutes` (120) and `waitMs`; see `thetis/using`.

## Secrets

Write a secret as `${NAME}` in the configuration and put the value in `<root>/.env`. Do not write the literal key into the file. `thetis config` prints the interpolated configuration with the key. The operator method `config.get` and the Overview section replace strings under a key that matches `key`, `secret`, `token`, or `password` with `•••`.

## Change the server's configuration

1. Edit `$THETIS_HOME/thetis.config.json` on the host.
2. Re-read it: **Read the file again** on an extension's Settings tab, or `thetis config reload` on the host. It says which keys are live, which reopened the fences, and which need **Restart Thetis**.

To change the model for one user only, install a package with a `prompt` step that sets `call.model`. To change the model for one chat, the person picks it in the model picker; a gateway passes `opts.model` to `sessions.send`.

A minimal file holds only what differs from the defaults:

```json
{
  "door": { "host": "0.0.0.0" }
}
```

The provider's key needs no line here: its manifest default is `${OPENROUTER_API_KEY}`, and `.env` holds the value.

## Sources

- src/kernel/config.ts
- src/kernel/control.ts
- src/lib/config.ts
- src/lib/config-tidy.ts
- packages/gateway-cli/src/index.ts
- packages/ui-admin/README.md

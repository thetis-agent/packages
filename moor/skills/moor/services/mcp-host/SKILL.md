---
name: mcp-host
description: "What moor-web-mcp, the MCP bridge, exposes to an AI assistant, how it logs in through the web host as ordinary MOO players, and where its safety boundary sits. Use when connecting an assistant to a running MOO, adding a world-defined tool, or auditing what it can reach; or when a tool returns a permission error or a command's outcome is unknown. Not for the HTTP contract (read clients-and-web-ui), what a MOO permission allows (read moor/execution/permissions-and-security), or workers (read workers)."
metadata:
  title: The mooR MCP bridge (moor-web-mcp)
  tags: [moor, mcp, model-context-protocol, ai-assistant, moor-web-mcp, web-mcp, stdio, wizard, programmer, moo, resources, credentials, tools, dynamic-tools, external-agent-tools, safety, cowbell]
  version: 3
---

# The mooR MCP bridge (moor-web-mcp)

`moor-web-mcp` (`clients/moor-web-mcp`, npm `@moor/web-mcp`) is a Model Context
Protocol server that lets an AI assistant explore and edit a running MOO. It is
a client of the **web host**, built on `@moor/web-sdk` and the official MCP SDK.
Everything it can do, a person with the same credentials could do from a web
client.

The older Rust `moor-mcp-host` (`crates/mcp-host`), which spoke the daemon's
ZeroMQ RPC directly and carried objdef file tools, was removed in October 2026
(745e1cfa0). If a document or script still names it, it is stale.

## What it is

A Node program that speaks MCP over stdio. The assistant's client spawns it;
there is no listening socket. On the other side it uses the web host's HTTP API
and WebSocket, and logs in with a username and password like any player.

Build and run from the repository root:

```bash
npm run web:prepare
npm run web-mcp:build
node clients/moor-web-mcp/dist/index.js --config /path/to/moor-web-mcp.json
```

The JSON config (`src/config.ts`) lists one or more worlds: `timeoutMs`
(default 30000), `defaultMoo`, `defaultCharacter`, and `moos[]`, each with an
`id`, `description`, `connectAddress` (the web host's base URL), an optional
`wsConnectAddress` and `defaultPlayer`, and `players[]` of `{id, username, password, isProgrammer?,
isWizard?, notes}`.

It exposes two MCP surfaces, both announced with `listChanged`:

| Surface | Contents |
|---|---|
| Static tools | `moo_eval`, `moo_command`, `moo_invoke_verb`, `moo_function_help`, `moo_list_objects`, `moo_resolve`, `moo_list_verbs`, `moo_get_verb`, `moo_program_verb`, `moo_list_properties`, `moo_get_property`, `moo_set_property`, `moo_refresh_dynamic_tools`. Every one takes optional `moo`, `character` and `wizard` arguments |
| World tools | Whatever `#0:external_agent_tools()` returns for the selected account |
| Resources | `moor://moos` (the config without passwords), `moor://events/{moo}/{player}` (the last 200 narrative lines of that account's command connection), and whatever `#0:external_agent_resources()` returns, scoped as `moor://world/{moo}/{player}/{uri}` |

There are no prompts. The authoritative static list is `src/static-tools.ts`.

## World-defined tools

The world, not the bridge, decides most of what an assistant can do. On first
use per (world, account) the bridge evals `#0:external_agent_tools()` and
`#0:external_agent_resources()` as that account and caches the result in
`ToolCatalog` (`src/tool-catalog.ts`).

- A tool entry has `name` (`^[a-zA-Z0-9_-]{1,64}$`), `description`, an object
  `input_schema`, `target_obj` and `target_verb`. A call runs
  `target_obj:target_verb(parse_json(args), player)` through `/v1/eval`.
- A resource entry has `uri`, `name`, `description`, `mimeType` and `content`.
  URIs under the bridge's own `moor://moos`, `moor://events/` and
  `moor://world/` prefixes are refused.
- A world tool whose name matches a static tool is skipped with a warning.
- After changing the core, call `moo_refresh_dynamic_tools`; it reloads the
  catalog and notifies the client that both lists changed.

Cowbell defines both verbs (`cores/cowbell/src/core/sysobj.moo`) and uses them
for its `changes_*` change-management tools and the `moor://changes-guide`
resource. A core that defines neither still gets the static tools.

## Accounts and privilege

Each call picks an account: `character` names a configured player id;
`wizard: true` picks the world's first player with `isWizard`, and fails with
"No wizard account configured for …" if there is none; otherwise the defaults
apply. `isWizard` and `isProgrammer` only help select an account. The world
checks the account's real flags on every operation.

Login is `POST /auth/connect`, and later requests carry the `X-Moor-Auth-Token`,
client token and client id headers. On a 401 or 403 the bridge rereads the
config file and retries once if that account's credentials changed, so an
edited password takes effect without a restart.

How the operations travel (`src/moor-service.ts`):

- **Eval and world tools** use `/v1/eval?timeout_ms=…`, a captured invocation.
  The task's deadline is slightly shorter than `timeoutMs`, so a slow task is
  aborted by the daemon and reported as a time limit instead of left running.
  A compile error (422) is reported with line and column.
- **Commands** go over a WebSocket per account (`buildWsAttach`). They run one
  at a time per account and finish on the `TaskOutcomeEvent`; anything other
  than completed or suspended is a tool error. A command that asks for input
  fails with "Command requires interactive input; use a MOO client."
- **Objects, verbs and properties** use the `/v1/objects`, `/v1/verbs` and
  `/v1/properties` endpoints.

## Where the safety boundary is

**Inside the MOO, the boundary is the MOO's own permission system.** The bridge
holds no special authority. Every verb it runs, including every world tool, is
checked by the VM against the player it logged in as. Read
`moor/execution/permissions-and-security`. To limit an assistant, limit the
character you give it: a programmer bit is a very different grant from a
wizard bit, and Cowbell's Git access and object creation need a real wizard.

**Outside the MOO, it reaches only the web host.** There are no filesystem
tools, no ZeroMQ and no CURVE. What it can reach on the host machine is what
the web host and the world's workers allow.

The consequences:

1. The config file holds plaintext passwords for every account. Give it
   restrictive permissions. Anything that can spawn the bridge with that file
   inherits all of them, with no second factor and no per-tool confirmation.
2. Give it a wizard account only when the work needs one.
3. A world tool is as safe as the verb behind it. Its arguments come from a
   model; the verb must validate them.
4. A command that times out, is cancelled, or loses its connection has an
   **unknown outcome**. The bridge closes that WebSocket and never repeats the
   command. Check world state before retrying a write.

## Invariants

1. **The bridge is a client.** It never bypasses login, tokens or permissions.
   If a change would let it do something a player could not, the change is
   wrong.
2. **Privilege comes from the character, not from the tool.** `wizard: true`
   selects an account; it is not the security control.
3. **Logging goes to stderr.** stdout is the MCP channel; anything written
   there corrupts the protocol.
4. **A write with an unknown outcome is never replayed automatically.**
5. **Catalogs are per account.** Two accounts in one world can see different
   tools and resources, and one must never be served the other's.
6. **Static tool names win.** A world tool cannot shadow one.

## Where the code lives

| Path | Responsibility |
|---|---|
| `clients/moor-web-mcp/src/index.ts` | Arguments, stdio transport, shutdown on SIGINT, SIGTERM or stdin end |
| `clients/moor-web-mcp/src/config.ts` | Config loading and validation |
| `clients/moor-web-mcp/src/mcp-server.ts` | MCP handlers, account selection, resources |
| `clients/moor-web-mcp/src/static-tools.ts` | The static tool definitions |
| `clients/moor-web-mcp/src/tool-catalog.ts` | World tool and resource catalogs, validation, caching |
| `clients/moor-web-mcp/src/moor-service.ts` | Login, HTTP calls, the command WebSocket, timeouts, recent events |
| `clients/moor-web-mcp/tests/` | `npm run test:mcp` (fast, in CI); `npm run test:mcp:integration` builds the services and drives Cowbell worlds |
| `cores/cowbell/src/core/sysobj.moo` | The reference `external_agent_tools` and `external_agent_resources` |
| `book/src/the-system/object-loading.md` | The administrator workflow for reviewing updates with an agent |

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| Every tool returns a permission error | The selected account lacks the bit | Use `wizard: true` if a wizard account is configured, or a character with the right flags. Do not raise anything on the server side |
| "No wizard account configured for …" | `wizard: true` and no player has `isWizard` | Add a wizard account to the config, or do without |
| A world tool is missing | The core defines no `external_agent_tools`, the entry failed validation, its name clashes with a static tool, or the catalog is cached | Check the bridge's stderr warnings, then call `moo_refresh_dynamic_tools` |
| "Command timed out; its outcome may be unknown" | The command outlived `timeoutMs`, or the connection dropped | Inspect the world before repeating it |
| "Command requires interactive input" | The verb called `read()` or similar | Use a MOO client, or call a verb that takes arguments |
| Eval reports a time limit | The daemon aborted it at the deadline the bridge asked for | Raise `timeoutMs`, or make the code cheaper |
| Login fails | Wrong credentials, wrong `connectAddress`, or the web host is down | Check the account with a normal client; the bridge has no special login path |
| The MCP client reports protocol corruption | Something wrote to stdout | All logging must go to stderr |
| A script still runs `moor-mcp-host` | It predates its removal | Switch to `moor-web-mcp` and a JSON config |

## Read first / read next

- Read `moor/execution/permissions-and-security` before deciding which character
  an assistant gets. That decision is the whole security posture.
- Read `clients-and-web-ui` for the HTTP and WebSocket contract the bridge uses,
  including error codes and `TaskOutcome`.
- Read `daemon-and-rpc` for captured calls, deadlines and why an outcome can be
  unknown.
- Read `workers` for how mooR confines a capability that touches the host.

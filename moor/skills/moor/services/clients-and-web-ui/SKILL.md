---
name: clients-and-web-ui
description: "What lives under clients/, and the contract the web host offers them: HTTP, WebSocket frames, auth, and history resume. Use when building or debugging a mooR client, or its HTTP/WebSocket contract with the web host: auth, reattach, or history resume. Use it when a frame is not understood or a token expires mid-session. Not for the web host's own internals (read hosts-and-sessions), not for the RPC between processes (read daemon-and-rpc), and not for the .fbs files (read wire-schema) or Thetis's own internals."
metadata:
  title: mooR clients and the web UI contract
  tags: [moor, meadow, meadow-flutter, web-client, web-sdk, moor-web-mcp, flutter, websocket, openapiyaml, http-api, oauth2, x-moor, presentations, typescript, npm-workspace, vite, client, sse, task-outcome, client-data, do-action, webrtc, error-codes]
  version: 3
---

# mooR clients and the web UI contract

A mooR client is any program that speaks the web host's HTTP and WebSocket
surface. Nothing about the world is client-side: a client renders events and
sends commands. This skill is the contract that surface offers, and the state of
the clients that consume it.

## What lives under clients/

| Directory | What it is | Built by |
|---|---|---|
| `clients/meadow` | The React and Vite web client, also packaged as a Tauri desktop app. The reference implementation | npm workspace |
| `clients/meadow_flutter` | A Flutter client for web and Linux desktop, with Android and iOS structurally possible | Flutter, not npm |
| `clients/web-sdk` | `@moor/web-sdk`: the shared TypeScript protocol layer. Auth headers, HTTP wrappers, WebSocket attach and dispatch, FlatBuffer decoding, narrative and presentation parsing | npm workspace |
| `clients/moor-web-mcp` | `@moor/web-mcp`: the stdio MCP bridge for AI assistants, built on the web SDK and the official MCP SDK. See `mcp-host` | npm workspace |
| `crates/schema/schema` | `@moor/schema`: the generated TypeScript FlatBuffer bindings. It is an npm workspace even though it lives under `crates/` | npm workspace |

The Flutter client's own README states it is replacing the React client;
`clients/README.md` still describes both as maintained on independent version
lines. Treat that as a transition in progress and check which one a deployment
actually serves before assuming.

The two clients share no code. The web SDK is TypeScript; the Flutter client
generates its own Dart bindings from the same `.fbs` files with
`clients/meadow_flutter/tool/gen_flatbuffers.sh`, which pins the same `flatc`
version CI installs. So the schema is shared and the protocol layer is not. A
fix in `@moor/web-sdk` does not reach the Flutter client.

## The HTTP surface

`crates/web-host/openapi.yaml` is the reference. It is embedded in the binary and
served at `/openapi.yaml`, and `book/src/web-client/http-api-reference.md` is
generated from it by `tools/generate-api-docs.py` — the page carries a banner
saying so. Read the spec, not a list copied into a skill.

The shape, which is stable:

- `/auth/connect` and `/auth/create` take a form and return tokens. `/auth/validate`
  and `/auth/logout` manage them.
- `/v1/...` covers world state: eval, `/v1/command`, objects (and
  `/v1/objects/query`), verbs, properties, system properties, presentations,
  history, the event-log key, features, the welcome message, and a batch
  endpoint that carries several world-state actions in one request.
- `/ws/attach/connect` and `/ws/attach/create` upgrade to a WebSocket.
- `/v1/session`, `/v1/events/stream`, `/v1/events/ack`, `/v1/session/command`
  and `/v1/session/input/{request_id}` are the SSE alternative to the WebSocket.
- `/health`, `/version` and `/openapi.yaml` need no authentication.
- `/webhooks/*` and the OAuth2 routes exist only when enabled.

**Two response formats.** Most `/v1` endpoints negotiate on `Accept` between
`application/x-flatbuffers` (the default when the header is absent or `*/*`) and
`application/json`. Neither acceptable gives 406. Send an explicit `Accept`; do
not rely on the default staying what it is.

**Errors and outcomes.** A refused request has a status that fits why and a
JSON body `{"code", "error"}`, even when FlatBuffers were asked for: 401
`unauthorized`, 400 `invalid_request`/`invalid_value`, 403
`permission_denied`, 404 `object_not_found`/`verb_not_found`/`property_not_found`,
422 `compilation_error` with the diagnostics in `compile_error`, 503
`daemon_unavailable` or `server_busy`, 500 `internal_error`. An error status
means **no task ran**. Once a task runs, how it ended is not an HTTP error: the
answer is 200 with an `InvocationResponse {outcome, output}`, where
`outcome.ending` is completed, suspended, aborted (with a reason) or result
lost, and `outcome.kept` says whether its changes committed (`Yes`, `No`,
`Unknown`). As in LambdaMOO, an aborted task can have `kept: Yes`. Webhooks are
the exception: they map the abort reason to a status (408 on a time limit or
deadline, 404 when the handler verb is missing, 503 when the task was stopped,
400 when the command failed).

Nothing verifies that `openapi.yaml` matches the router. It is currently in sync
— every path in `crates/web-host/src/routes.rs` appears in the spec, with
axum's `{*path}` written as `{path}` — but a route added without a spec edit
would not fail CI.

## Authentication

Three headers carry a session on HTTP requests:

| Header | Carries |
|---|---|
| `X-Moor-Auth-Token` | The PASETO `AuthToken` for the player |
| `X-Moor-Client-Token` | The PASETO `ClientToken` for the connection |
| `X-Moor-Client-Id` | The client UUID |

Only the auth token is required; the other two let the web host reuse an existing
connection instead of making a fresh one. Read `daemon-and-rpc` for what each
token proves.

**The WebSocket does not use headers.** A browser cannot set them on an upgrade,
so credentials travel in the `Sec-WebSocket-Protocol` list: `moor` first, then
`paseto.<authToken>`, then optionally `client_id.<uuid>` and
`client_token.<token>`, plus `initial_attach.true` on a first attach. The server
answers with the `moor` subprotocol alone. `buildWsAttach` in the web SDK is the
canonical construction; copy its ordering rather than inventing your own.

This is also why a token in a subprotocol string ends up in proxy logs. Terminate
TLS in front of the web host and be careful what the proxy records.

**OAuth2**, when enabled, has two flows. The browser flow is cookie-bound:
authorize, provider callback, then exchange a one-time code. The app flow is
proof-bound for desktop and mobile, and the web host will only redirect to a URI
matching a configured allowed prefix. Both end either with MOO tokens or with a
verified external identity plus an account-choice step for a new user. Neither
flow gives a client authority the resulting player does not have.

## The WebSocket frames

Deliberately minimal. There is no envelope and no JSON control channel.

**Client to server**

| Frame | Meaning |
|---|---|
| Binary, one byte `0x00` | Keepalive. Ignored |
| Binary, one byte `0x01` | Heartbeat response |
| Binary starting `0x03` | WebRTC signalling, a JSON envelope after the prefix byte |
| Binary `0x04` then `{` | A structured action: JSON of at most 16 KiB, run as `do_action` on the listener's handler object. Never read as an input reply |
| Binary starting `0x05` | Client data: JSON `{"kind","payload"}` or a FlatBuffer `ClientDataMessage`, delivered to `do_client_data(connection, 'web, kind, payload)`, rate-limited per connection |
| Any other text or binary | A command, or a reply to a pending input request |

**Server to client**

| Frame | Meaning |
|---|---|
| Binary, one byte `0x02` | Heartbeat request. Answer with `0x01` |
| Binary starting `0x03` | WebRTC signalling answer or ICE candidate |
| Any other binary | An encoded `ClientEvent` FlatBuffer |

The distinction between a command and an input reply is **positional**, not
tagged: whether the server is currently expecting input decides how it reads your
frame. A client must therefore track its own input-request state, and must not
send a command while an input request is outstanding.

**The first frame on every connection is a `CredentialsUpdated` event** carrying
the client id and client token, with sequence zero. Store both. They are what
makes a later reattach possible, and they are re-sent on every connection,
including one created after a reattach failed.

Commands sent while a task is running are queued by the server, not dropped,
and the task's end is reported by one `TaskOutcomeEvent` carrying the same
`TaskOutcome` as the HTTP replies.

If WebRTC is enabled, the client may send an SDP offer over the WebSocket and
create a data channel with sub-protocol `moor.fb` (the default) or `moor.json`;
the server answers and then sends **ephemeral** data events
(`emit_data(..., ['ephemeral -> true])`) over that channel, latest-wins per
namespace and kind. Once the channel is open the connection gets the attribute
`'realtime`. It is an optimisation, never a requirement: everything still works
on the WebSocket alone, and neither shipped client opens a channel today.

**SSE instead of a WebSocket.** Meadow switches to it with `?transport=sse`
(`clients/web-sdk/src/sse.ts`). The browser owns acknowledgement: payloads are
base64 FlatBuffers with a generation and sequence, acks are cumulative and
coalesced over 100 ms, and the daemon keeps unacked events for five minutes
(8192 events, 16 MiB per connection). An `EventsAvailableEvent` tells the
stream to fetch more. Ephemeral events arrive as an `ephemeral` SSE event with
no id and are never acknowledged. Past a limit or after expiry the client must
start a fresh session and recover from history. The operator view is in
`book/src/web-client/deployment.md`.

## Resuming after a reconnect

Two independent mechanisms, easy to confuse.

**Session resume.** Reconnect with the stored `client_id` and `client_token`
subprotocols and *without* `initial_attach.true`. The web host then tries a
reattach. If it succeeds the connect type is `Reconnected`; if it fails, or if
the credentials were stale, it falls back to a fresh attach rather than failing
the upgrade — so a client can always reconnect, but may silently become a new
connection. Watch the connect type; do not assume continuity. Sending
`initial_attach.true` suppresses the reattach attempt entirely, which is what a
fresh login should do.

**History resume.** Scrollback is a separate `GET /v1/history` call, with one of
`since_seconds`, `since_event` or `until_event`, plus a limit. It returns
**encrypted blobs**, which the client decrypts with the age identity it derived
from the player's event-log password. `GET /v1/presentations` behaves the same
way: it returns `{id, encrypted_blob}` pairs, so restoring open panels needs the
same key. A client with no key gets nothing back and must not present that as an
error.

Read `event-log-and-history` before implementing either. The rule that decides
whether history exists at all is server-side and has nothing to do with the
client.

## Presentations and structured output

A narrative event is one of five kinds: notify, present, unpresent, traceback,
and data. Only `notify` is text. The others are the structured surface:

- **Present** carries a `Presentation`: an id, a content type, content, a
  `target` string, and a bag of string attributes. Re-sending the same id
  replaces the existing presentation.
- **Unpresent** removes one by id.
- **Data** carries a namespace, a kind and a `Var` payload. It is a non-visual
  state channel. Marked ephemeral, it is never logged or replayed, only the
  latest per key is delivered, and it is what the WebRTC channel carries.

**`target` is a client convention, not a server contract.** The daemon stores it
as an opaque string. Meadow defines the vocabulary — semantic targets like
`navigation`, `inventory`, `status`, `tools`, `communication`, `help`; explicit
docks `left`, `right`, `top`, `bottom`; `window`; and a set of editor and dialog
targets — and maps them differently on desktop and mobile. An unknown target
falls to the right dock, or the bottom on mobile. `book/src/web-client/presentations.md`
documents that vocabulary and matches the code. Another client may choose
differently, and MOO code that hard-codes Meadow's targets is coupled to Meadow.

**How a line-oriented client degrades.** The telnet host shows the intended
behaviour: it renders djot and markdown to a terminal, and it **ignores present,
unpresent and data events entirely**. It does not try to draw a panel in text.
Both content-type spellings are accepted, with and without a slash
(`text_djot` and `text/djot`), and anything unrecognised falls back to plain
text. The web SDK normalises identically. So the degradation rule across the
whole system is: **an unknown content type is plain text, and a structured event
a client cannot render is dropped, not approximated.**

## Stable, versus what you must detect

| Part of the contract | Status |
|---|---|
| The three `X-Moor-*` header names | Stable |
| The WebSocket subprotocol scheme and the one-byte frame markers | Stable |
| `CredentialsUpdated` as the first frame | Stable |
| Path shapes under `/auth`, `/v1`, `/ws/attach` | Stable; confirm against `/openapi.yaml` |
| The set of `ClientEvent` variants | **Grows.** Ignore what you do not know |
| The set of narrative event kinds and content types | **Grows.** Fall back, never fail |
| Presentation targets and attributes | **A convention.** Negotiate with the world's authors, not with the server |
| Server features: symbols, booleans, custom errors, rich notify, event log, anonymous objects and the rest | **Detect** with `GET /v1/features` |
| WebRTC, SSE, webhooks, OAuth2, CORS, rate limiting | **Optional.** Present only if the operator enabled them, or the client chose them |
| Error bodies `{"code","error"}` and the `TaskOutcome` shape | Stable; new codes and abort reasons may appear |
| The FlatBuffer schema itself | Evolves under the rules in `wire-schema` |

`/v1/features` is the feature-detection point. The web host caches the answer for
the life of the process because features do not change at runtime, so a client
may fetch it once at startup. Never infer a feature from a version string.

**Unknown events must be ignored.** The web SDK's dispatcher
(`ws-dispatch.ts`) has an explicit ignored branch (for `SetConnectionOptionEvent`
and `DisconnectEvent`) and a `default:` unknown branch. The union has already
changed under clients once: the per-ending `TaskErrorEvent`,
`TaskSuccessEvent` and `TaskSuspendedEvent` were replaced by one
`TaskOutcomeEvent`. A client that throws on an unrecognised variant will break
on the next daemon release.

## Building and serving

The repository root is one npm workspace covering `clients/meadow`,
`clients/web-sdk`, `clients/moor-web-mcp` and `crates/schema/schema`. Order
matters, and the root scripts encode it:

1. `npm ci` at the root. Always at the root, so `@moor/schema` and
   `@moor/web-sdk` resolve to this checkout.
2. `npm run web:prepare` builds the schema bindings, then the SDK. The schema
   step needs `flatc`; see `wire-schema`.
3. `npm run web:build` does that and then builds Meadow.
4. `npm run full:build` adds a release build of the single-process `moor` binary.

For development, `npm run full:dev` runs Meadow's Vite server and the
single-process server together. Vite proxies the API, WebSocket, auth, health,
version and webhook paths to the web host, so the browser sees one origin. The
Flutter client does the same with its own Vite proxy script. The port numbers
live in `clients/meadow/vite.config.ts`, `moor-dev.yaml` and the web host's
arguments; read them there rather than from memory.

In production Meadow is **static files**. It is not embedded in any Rust binary.
A frontend server — nginx in the shipped configuration — serves the build output
and reverse-proxies the same path prefixes to the web host. That is why CORS is
normally not needed and is off by default: a browser client is same-origin. Turn
CORS on only for a genuinely cross-origin client, such as a packaged desktop app.
For how that is deployed and released, read
`moor/working-in-the-repo/deployment-and-release`.

## Invariants

1. **A client renders and sends; it decides nothing.** Any client-side check is a
   convenience. The world enforces its own rules.
2. **An unknown event variant, content type or presentation target is ignored or
   degraded, never fatal.**
3. **The first WebSocket frame is `CredentialsUpdated`, and a client must store
   what it carries.** Without it there is no reattach.
4. **A frame is a command or an input reply according to session state.** Track
   the pending input request.
5. **History and presentation restore need the event-log key.** No key means an
   empty scrollback, which is a normal state and not an error.
6. **The schema is shared; the protocol layer is not.** A protocol fix must be
   made once per client stack.
7. **Build from the repository root.** A workspace package built in isolation
   resolves the wrong `@moor/schema`.

## Where the code lives

| Path | Responsibility |
|---|---|
| `crates/web-host/openapi.yaml` | The HTTP surface, embedded and served at `/openapi.yaml` |
| `crates/web-host/src/routes.rs` | The router, CORS, rate limits, body limits |
| `crates/web-host/src/host/web_host.rs` | Subprotocol parsing, the attach and reattach decision, features, health, version |
| `crates/web-host/src/host/session/mod.rs` | The WebSocket loop, the first credentials frame, heartbeat, deferred commands, ephemeral routing |
| `crates/web-host/src/host/session/websocket.rs` | Frame markers and how a client frame is classified |
| `crates/web-host/src/host/actions.rs`, `client_data.rs` | The `0x04` and `0x05` frames |
| `crates/web-host/src/host/daemon_errors.rs` | Error statuses and codes |
| `crates/web-host/src/host/auth/` | Login, `StatelessAuth`, `/auth/validate`, OAuth2 |
| `crates/web-host/src/host/handlers/` | The `/v1` endpoints, including history, presentations, SSE (`event_stream.rs`) and webhooks |
| `clients/web-sdk/src/ws.ts`, `ws-session.ts`, `ws-dispatch.ts`, `sse.ts`, `actions.ts` | Attach construction, control frames, event dispatch, the SSE transport, action frames |
| `clients/web-sdk/src/auth.ts`, `history.ts`, `narrative.ts`, `presentations.ts` | Headers, encrypted history parsing, content-type normalisation |
| `clients/meadow/src/hooks/usePresentations.ts`, `src/types/presentation.ts` | The reference target vocabulary and its placement rules |
| `clients/meadow_flutter/tool/gen_flatbuffers.sh` | The Dart binding generation and its pinned `flatc` |
| `tools/generate-api-docs.py` | Regenerates the book's API reference from the spec |
| `book/src/web-client/` | Presentations, output, accessibility, OAuth2 and deployment, from the client author's side |

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| A frame the client does not understand | A newer daemon sent an event variant the client has no case for | Route it to an ignore branch and log once. Never throw |
| A call returns 200 but nothing changed | The task ran and aborted, or its result was lost | Read `outcome.ending` and `outcome.kept`; do not retry a write whose `kept` is `Unknown` without checking the world |
| 422 from `/v1/eval` or verb programming | The code does not compile | Show `compile_error`; no task ran |
| 503 `server_busy` | The daemon's call pools are full | Back off and retry; no task ran |
| SSE stream ends with a gap or expired error | Retention ran out, or the connection expired after 30 s without liveness | Start a fresh session and recover from history and presentations |
| The WebSocket upgrade returns 401 | The auth token is missing, malformed, or not in the subprotocol list | Check the protocol list order and that `paseto.` prefixes the token |
| The upgrade succeeds but the session is new every time | The client sent `initial_attach.true`, or the stored client credentials were stale | Send the stored `client_id` and `client_token` and omit the initial-attach marker. Read the connect type in the reply |
| A token expires mid-session | The player's session was invalidated, or the connection went stale | HTTP calls return 401. Re-authenticate and reattach; the credentials frame on the new connection replaces what you stored. Do not retry the same token |
| History returns nothing at all | The player has no event-log key, or the feature is off on the server | Both are normal. Distinguish them with `/v1/features` and the pubkey endpoint before showing an error |
| History returns blobs that will not decrypt | The password changed, or the key derivation differs from the reference client | Match the derivation in `clients/meadow/src/lib/keyDerivation.ts`. Old records need the old key |
| Panels do not come back after reconnect | Presentation restore is encrypted too, and needs the same key | Unlock before calling `/v1/presentations` |
| A `/v1` call returns 406 | The `Accept` header asked for something neither format satisfies | Send `application/json` or `application/x-flatbuffers` |
| A `/v1` call returns binary when JSON was expected | No `Accept` header, so the FlatBuffers default applied | Always send `Accept` explicitly |
| Decoding fails on every event | The client was built against a different schema vintage than the daemon | Rebuild the client from the same checkout. There is no protocol version negotiation; read `wire-schema` |
| CORS errors in a browser | The client is being served cross-origin with CORS off | Serve it same-origin behind a proxy, which is the intended shape, or enable and configure CORS on the web host |
| A presentation appears in the wrong place | The world used a target this client does not know | Meadow falls back to the right dock. Agree the vocabulary with the world's authors |
| Editing the book's API reference has no effect | It is generated | Edit `crates/web-host/openapi.yaml` and rerun `tools/generate-api-docs.py` |

## Read first / read next

- Read `hosts-and-sessions` for the server side of everything here, including the
  handler object that decides which login policy a port uses.
- Read `event-log-and-history` before implementing scrollback or panel restore.
- Read `wire-schema` before regenerating bindings in any language.
- Read `moor/working-in-the-repo/deployment-and-release` for how the client is
  packaged and served alongside the Rust binaries.
- `book/src/web-client/` is written for client authors and its presentations page
  matches the code. Verify anything else there against `crates/web-host`.

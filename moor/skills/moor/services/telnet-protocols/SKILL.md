---
name: telnet-protocols
description: "How the mooR telnet host negotiates telnet options and carries GMCP, MSDP, MSSP, NAWS, TTYPE/MTTS, CHARSET, EOR/GA, MXP and MCCP2, and how structured client data reaches MOO through do_client_data, including before login. Use when enabling or debugging a telnet protocol, sending emit_data to a MUD client, handling do_client_data, reading connection_options attributes such as columns or utf8, or writing telnet socket tests. Not for line framing in general or the Session abstraction (read hosts-and-sessions), and not for how to change the schema (read wire-schema)."
metadata:
  title: Telnet option negotiation and out-of-band protocols
  tags: [moor, moor-telnet-host, telnet, gmcp, msdp, mssp, naws, ttype, mtts, charset, utf-8, latin-1, eor, go-ahead, prompt, mxp, mccp2, compression, rfc-1143, q-method, do_client_data, clientdata, emit_data, set_connection_option, connection_options, client-attributes, out-of-band, iac, subnegotiation]
  related: [moor/services/hosts-and-sessions, moor/services/wire-schema, moor/services/daemon-and-rpc]
  version: 1
---

# Telnet option negotiation and out-of-band protocols

The telnet host implements telnet option negotiation and the common MUD
protocols itself. The daemon only routes values. It does not interpret any
telnet protocol. MOO code sends and receives structured values, and never
builds or parses IAC bytes, except through the raw `notify(conn, <binary>)`
path.

This landed in mooR PR #557, merged 2026-10-04 (merge commit `3268aa1e2`). The
design document that went with it was removed from the repository at merge.
This skill and the code are the only record of the contract. Where they
disagree, the code is correct.

## Off by default, and what "passive" means

Every protocol is off by default. With the default configuration, the host is
**passive**: the bytes on the wire are what they were before the protocol layer
existed.

| | Passive (all protocols off) | Any protocol on |
|---|---|---|
| Offers at connect | None | The enabled set, if `offer_on_connect` |
| Unknown WILL/DO from the client | No reply | Refused per RFC 1143 (DONT/WONT), once |
| Raw telnet sequences | Forwarded as binary to `do_out_of_band_command`, after login only | Not forwarded raw |
| `ClientData` sent to the daemon | Never | For every protocol event (below) |
| Prompt marks | None | GA, EOR or none (below) |
| `client-echo` option | Re-sends IAC WILL/WONT ECHO on every call | Goes through the negotiator; no repeats |

## Configuration

`TelnetProtocolConfig` in `crates/telnet-host/src/config.rs`. It is the
`protocols` section of the telnet host config and of `services.telnet` in the
single-process `moor` binary. Both reject unknown keys.

| Key | CLI flag | Default |
|---|---|---|
| `offer_on_connect` | `--telnet-protocols-offer-on-connect` | false |
| `gmcp` (201), `msdp` (69), `mssp` (70), `mxp` (91), `naws` (31), `ttype` (24), `eor` (25), `charset` (42), `mccp2` (86) | `--telnet-protocols-<name>` | false |
| `max_subneg` | `--telnet-protocols-max-subneg` | 65536 bytes |
| `client_data_rate` | `--telnet-protocols-client-data-rate` | 50 per second per connection, burst twice that, 0 is unlimited |
| `mssp_values` | config file only | empty map |

When GMCP is enabled, the host waits at startup for the daemon's
`use_boolean_returns` (via `GetServerFeatures`). It applies that value to JSON
booleans from the first GMCP message onward. A change on the daemon needs a host
restart.

## Layers

| Layer | Path | Owns |
|---|---|---|
| Sans-IO protocol layer | `crates/telnet-host/src/session/telnet/` | RFC 1143 option state (`options.rs`), the `TelnetNegotiator` and its `Action`s (`negotiator.rs`), and one module per protocol: `gmcp`, `msdp`, `mssp`, `naws`, `ttype`, `charset` |
| Codec | `session/codec.rs` | IAC parsing into `TelnetEvent`, IAC escaping on output, subnegotiation cap and resync, text charset, prompt marks, MCCP2 compression |
| Action application | `session/protocol.rs` | Turns negotiator actions into frames and daemon requests without I/O. Also holds the rate limiter and the `Event::Data` encoder. Unit-tested directly |
| Session | `session/mod.rs` | Applies the plan: writes frames, sends RPC requests, maps `set_connection_option` names |
| Value <-> JSON | `crates/var/src/json.rs` (`moor_var::json`, feature `json`) | The one MOO/JSON mapping, shared with `generate_json` and `parse_json` |
| RPC | `runtime-api`, `schema`, `daemon` | `ClientData`, optional-auth `SetClientAttribute`, `GetServerStatus` |

Both `session::codec` and `session::telnet` are `pub(crate)`. Nothing outside
the telnet host reaches them.

## Inbound: `ClientData` and `do_client_data`

The host sends a `ClientRequest::ClientData`. The daemon then runs, on the
listener's handler object:

```
handler:do_client_data(obj connection, sym namespace, str kind, any payload)
```

`kind` is a **STR**, not a SYM. Client-supplied GMCP and MSDP names are never
interned, so a client cannot grow the global symbol table. `namespace` is a
host-chosen SYM.

| | Before login | After login |
|---|---|---|
| Auth on the request | Client token only. Accepted only while no player is logged in on that client | Client token and auth token, checked as `verify_tokens` |
| `player` in the task | The connection object (negative) | The logged-in player |
| Task authority | `#0`, as for `do_login_command` | The player |
| `connection` argument | The connection object | The connection object |

It is fire and forget. The daemon replies `TaskSubmitted` and does not register
the task with the task monitor. So a missing verb or a task error produces no
output to the client. The scheduler path is `submit_client_data_task` in
`crates/kernel/src/tasks/scheduler_client.rs`. That function shares
`submit_handler_task_inner` with the out-of-band path. The daemon side is
`client_data_identity` in `crates/daemon/src/rpc/daemon_api_impl.rs`.

What the host delivers:

| namespace | kind | payload | When |
|---|---|---|---|
| `'gmcp` | the package name, e.g. `"Char.Login"` | JSON body as a MOO value; no body gives `[]`; a body that is not JSON gives a STR | GMCP negotiated and a message received |
| `'msdp` | the variable or command name | the value (TABLE gives a MAP, ARRAY gives a LIST) | MSDP negotiated |
| `'client` | `"attributes"` | MAP of the changed attribute keys to new values; a removed key maps to `#-1` | Any negotiation step that changed attributes |
| `'telnet` | `"negotiate"` | `["option" -> int, "verb" -> 'will\|'wont\|'do\|'dont]` | An option the host does not implement, when not passive |
| `'telnet` | `"subneg"` | `["option" -> int, "data" -> binary]`, data unescaped | Same |

`set_connection_option(conn, "disable-oob", 1)` suppresses the `'telnet`
namespace only. Over the rate limit, messages are dropped at trace level.

## Outbound: `emit_data` is the envelope, the host is the contract

```
emit_data(conn_or_player, 'gmcp, "Char.Vitals", ["hp" -> 12, "maxhp" -> 20]);
```

`Event::Data { namespace, kind, payload }` is only the envelope. The telnet host
decides what is sent. It checks, per connection:

1. The namespace is `gmcp` or `msdp`. Others are ignored by the telnet host.
2. The option is negotiated on this connection.
3. For GMCP: if the client sent `Core.Supports.*`, the package or one of its
   parents is in the supported set. `Core.*` is always allowed. Matching is
   case-insensitive. At most 1024 packages are retained per connection.
4. The name matches `[A-Za-z0-9_.-]{1,128}`.
5. The value converts.

A failure at steps 1 to 3 is dropped at trace level. A failure at step 4 or 5 is
dropped at warn level. The connection always stays up. A
`namespace` naming a GMCP package does not make MOO code protocol-independent:
package names and value shapes are a contract between the world and its
clients.

Wire forms:

- GMCP: `IAC SB 201 <kind> SP <json> IAC SE`. An empty map payload `[]` is sent
  as the bare package name, as `Core.Ping` needs. 0xFF is escaped, though UTF-8
  JSON never contains it.
- MSDP: `MSDP_VAR name MSDP_VAL value`. A MAP becomes TABLE_OPEN/CLOSE, a LIST
  becomes ARRAY_OPEN/CLOSE, and a scalar becomes its string form.

### Value conversion (`moor_var::json`)

| MOO | JSON |
|---|---|
| INT, finite FLOAT, STR, BOOL | number, number, string, bool |
| SYM | string |
| OBJ `#-1` | null |
| other OBJ | its literal string, e.g. `"#42"` |
| LIST | array |
| MAP with STR, SYM, INT, FLOAT or OBJ keys | object, keys as strings |
| ERR, BINARY, FLYWEIGHT, LAMBDA, BOOL keys | not convertible |

Inbound JSON maps back as `parse_json` does: null gives `#-1`, an object gives
a MAP with STR keys, and booleans follow `use_boolean_returns`. The SYM-to-string
row is new: before this change, `generate_json` raised `E_TYPE` on SYM.
`moor-mcp-host` has its own, different converters. It does not use this module.

## Connection attributes the telnet host owns

MOO code reads these with `connection_options(conn)`. It never needs to poll:
each change is also delivered as `'client "attributes"`.

| Key | Type | Source |
|---|---|---|
| `columns`, `rows` | INT | NAWS. Output formatting does not yet use the width |
| `terminal_type` | STR | First TTYPE reply |
| `client_name` | STR | First TTYPE reply, or GMCP `Core.Hello.client`, which wins |
| `client_version` | STR | GMCP `Core.Hello.version` |
| `mtts` | INT | TTYPE reply `MTTS n` |
| `utf8` | BOOL | MTTS bit 4, CHARSET UTF-8 accepted, or `set_connection_option` |
| `charset` | STR | CHARSET result: `"UTF-8"` or `"ISO-8859-1"` |
| `screen-reader` | BOOL | MTTS bit 64, or the option |
| `gmcp`, `msdp`, `mxp`, `eor`, `mccp2` | BOOL | Option state |
| `gmcp_supports` | MAP STR to INT | `Core.Supports.Set`, `Add` and `Remove` |

Before login, these go to the daemon with `SetClientAttribute` without an auth
token. That is accepted only while the client has no player.

**The trap.** The daemon stores the raw MOO argument of `set_connection_option`
as an attribute before the host acts. The host then writes back the
*negotiated* value (BOOL, or absent while pending or refused). Code that reads
`connection_options` immediately after `set_connection_option` in the same task
can see either value.

## Toggling from MOO

`set_connection_option(conn, name, value)` with `gmcp`, `msdp`, `mxp`, `eor`,
`mccp2`, `naws`, `ttype` or `charset` calls `request_option`.

- Enable acts on the option's primary side.
- Disable turns off **both** sides.
- A verb goes out only when the RFC 1143 state requires it, so repeated calls
  send nothing.

`echo` is server echo. `client-echo` is its inverse.

## UTF-8 and CHARSET

- Default: input is decoded as UTF-8 with replacement, and output is UTF-8.
  `IAC IAC` in text is a literal 0xFF byte. In UTF-8 it becomes U+FFFD.
- CHARSET (RFC 2066): REQUEST permission belongs to one direction. The host
  sends `REQUEST ;UTF-8;ISO-8859-1` only once its own side (`WILL`, answered by
  `DO`) is enabled. A client may initiate after the host accepts its `WILL`. The
  host then accepts the first charset it speaks. A REQUEST that crosses the
  host's own outstanding REQUEST is answered REJECTED. An unsolicited
  ACCEPTED is ignored.
- Latin-1 selected: input bytes are transcoded to UTF-8. On output, a character
  outside Latin-1 becomes `?`, and an encoded 0xFF (`ÿ`) is written as
  `IAC IAC`.
- The MTTS UTF-8 bit sets `utf8` but does not change the codec charset.

## Prompts: GA and EOR

A mark is sent only after output that is explicitly a prompt. `no_newline` and
flushing never mean "end of prompt".

```
notify(conn, "HP:20> ", 0, 1, 'text_plain, ["prompt" -> 1]);
```

The host's own prompts are marked too: the `read()` input prompt, the
`.program` prompt, and validation re-prompts. The mark is EOR if EOR is
negotiated. Otherwise it is GA, unless SUPPRESS-GO-AHEAD is on, which gives no
mark. In passive mode there is no mark. The mark never adds or removes a
newline. Frames are written in event order on one writer. So for `emit_data`,
then a prompt notify, then `emit_data` in one task, the wire order is SB, text,
EOR, SB.

## MSSP, MCCP2, MXP, limits

- **MSSP**: answers `DO MSSP` from `mssp_values`, plus `PLAYERS` and `UPTIME`
  computed by the host. `PLAYERS` comes from a new `HostRequest::GetServerStatus`
  (`ServerStatus { connected_players }`). If that call fails, no MSSP reply is
  sent. `UPTIME` is the host start time in Unix seconds.
- **MCCP2**: on `DO MCCP2`, the host writes `IAC SB 86 IAC SE` uncompressed.
  Everything after that is zlib-compressed with a sync flush per frame.
  `DONT MCCP2` ends the stream. The dependency is `flate2` with the `zlib-rs`
  backend.
- **MXP**: when enabled, the host sends `ESC[7z` (locked). djot and markdown
  output escape `& < > "`. A `moo://cmd/...` link becomes `<SEND>` and an http(s)
  link becomes `<A>`, on lines opened with `ESC[1z`. A command link whose decoded
  text holds a control character or a renderer delimiter is not rendered as a
  link. Plain text is never in secure mode. MXP output has not been tested
  against a real MXP client.
- **Subnegotiation cap**: if a subnegotiation exceeds `max_subneg` unescaped
  data bytes, the codec discards it and resyncs at the next `IAC SE`. The stream
  stays open.
- **Binary notify after login** writes raw bytes unescaped. Before this change,
  it ended the connection.

## Schema facts

All changes are appended to `crates/schema/schema/moor_rpc.fbs`:

- table `ClientData { client_token, auth_token (optional), handler_object, data_namespace: Symbol, kind: string, payload: Var }`.
  The field is `data_namespace` because `namespace` is reserved in the
  FlatBuffers IDL. The Rust API calls it `namespace`.
- `SetClientAttribute.auth_token` is no longer `(required)`.
- `GetServerStatus` and `ServerStatus`, on the host-to-daemon unions.

The merged commit is marked breaking: rebuild the daemon and hosts together.
The Dart bindings under `clients/meadow_flutter` were not regenerated in the
PR. Check them before relying on Flutter.

## Tests

| Where | What |
|---|---|
| `crates/telnet-host/src/session/**` unit tests | Codec forms and split buffers, the RFC 1143 table and loop tests, every protocol module, action application, MXP rendering |
| `crates/telnet-host/tests/telnet_protocols.rs` | 30 tests over real TCP sockets. One daemon and four hosts: passive, offers at connect, everything on (from a YAML file), and a 64-byte subneg cap. Covers every section above |
| `crates/telnet-host/tests/common/mod.rs` | Shared daemon and host launch, also used by `integration_test.rs` |
| `crates/daemon/src/testing/rpc_integration_test.rs` | `ClientData` before and after login, auth refusals, a missing verb is silent, pre-login `SetClientAttribute` |
| `crates/kernel/testsuite/moot/json.moot` | `generate_json` and `parse_json` |

The socket suite installs `#0:do_client_data` and `#0:do_out_of_band_command`
recorders in Test.db at startup. Login is `connect #3`. The moot telnet client
decodes with `String::from_utf8`, so a moot-file test cannot see IAC bytes. Use
the raw socket helper in `telnet_protocols.rs` for anything below the text layer.

## Out of scope, deliberately

- **Routing for players with several connections.** `set_connection_option`
  needs a connection object. `client_ids_for()` resolves a connection record
  before player-wide ones. So `client_ids.first()` in
  `publish_narrative_events` is that connection's client. Do not change routing
  without a reproducer.
- **`Event::Data` in the event log.** It is still logged, if the event log is
  enabled for the player.
- **GMCP input from the browser** through the web host.
- **Plain-text `MSSP-REQUEST`.**

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| `emit_data(..., 'gmcp, ...)` sends nothing | GMCP not negotiated on that connection, the package not in `Core.Supports`, a bad name, or an unconvertible value | Check `connection_options(conn)` for `gmcp` and `gmcp_supports`. Read the host log at trace and warn |
| `do_client_data` never runs | Every protocol is off (passive), the verb is on the wrong object, or the rate limit | Enable a protocol. The verb belongs on the listener's handler object, not always `#0`. A missing verb is silent by design |
| `do_client_data` breaks after upgrade, comparing `kind` to a symbol | `kind` is a STR since the merge | Compare with a string |
| `connection_options` shows `0` or `1` for `gmcp` | Read in the same task as `set_connection_option`, before the host wrote the negotiated value | Read it later, or watch `'client "attributes"` |
| The client never gets a CHARSET REQUEST | The host side (`WILL CHARSET`/`DO`) is not enabled | Offer it with `offer_on_connect`, or the client must answer `DO CHARSET` |
| MSSP request gets no reply | `GetServerStatus` failed | Check the host log for "Unable to get server status for MSSP" |
| Moot telnet tests fail with UTF-8 decode errors | Protocol offers were enabled for the moot host | Keep moot hosts passive. Test negotiation with the raw-socket suite |
| Daemon replies "Could not decode request body" | The host and daemon are built from different schemas | Rebuild both from one checkout |

## Read first / read next

- `hosts-and-sessions` for the session model this sits inside, and the handler
  object.
- `wire-schema` before you add to `ClientData` or the status messages.
- `moor/execution/builtin-functions` for `emit_data`, `notify`,
  `set_connection_option` and the JSON builtins.

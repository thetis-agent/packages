# @thetis/provider-openrouter

The default provider. It sends model calls to OpenRouter's OpenAI-compatible chat completions endpoint with streaming and tool calls, applies the prompt caching policy at the wire, and reports usage with cache accounting. It is a `provider` package in the default `systemPackages["_system"]`, so it runs in the system userspace fence with the operator's key; the kernel sends `config.packages["@thetis/provider-openrouter"]` only there. A harness's call step reaches it through `env.kernel.providers.call`, which the kernel routes by `call.model` to this fence; the calling fence never sees the key.

## What it provides

One provider export, declared as `"thetis": { "type": "provider", "export": "createProvider" }`:

| Export | Use |
|---|---|
| `createProvider(config)` | Returns `{ models(), call(call, signal?) }`. `models()` calls `GET /models` and returns every id, so the kernel resolves any OpenRouter model id to this provider. `call()` posts to `/chat/completions` with `stream: true` and `usage: { include: true }` and yields `text`, `reasoning`, `tool_call`, `usage` and `error` events. With `call.hints.context: true`, it first yields a `request` event containing the exact serialized JSON body and capture time, after defaults and cache policy have been applied; transport/authentication headers are excluded. `signal` is the caller giving up, and it stops the HTTP request itself. |

No steps, no tools, no service, no UI, no bench suites.

What `call()` does with a `ProviderCall`:

- `call.system` becomes the first message with role `system`; an assistant message with `toolCalls` becomes `tool_calls` with JSON-encoded arguments; a `tool` message becomes `{ role: "tool", tool_call_id, name, content }`; `call.tools` become `function` tools.
- The body is `{ model, messages, tools, stream, usage, ...defaults, ...call.params }`. The cache policy from `cache` is combined with `call.hints.cache` and `cache_control` markers are written by `applyOpenAiCompatible` from `@thetis/prompt-cache`. The hint's affinity token becomes the `user` field when the body has none.
- A reasoning model's thinking arrives on the same deltas as the answer, under `reasoning` (OpenRouter's normalization) or `reasoning_content` (DeepSeek, llama.cpp, and upstreams OpenRouter passes through); whichever came becomes a `reasoning` event. It is never folded into `text`: the thinking is not the reply, and nothing downstream keeps it.
- Streamed tool call fragments are joined by index and emitted after the stream ends. Invalid JSON in arguments becomes `{ _raw: "<text>" }`.
- Every usage chunk passes through `normalizeUsage`: `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost`, `cache_read_tokens`, `cache_write_tokens`, `cache_read_ratio`, `reasoning_tokens`.
- A transient refusal (`408`, `409`, `425`, `429`, `5xx`, or a `402` whose body names `in_flight_budget`) is tried again up to `retries` times, waiting for the `Retry-After` header, else the hint in the body, else 1, 2, 4 seconds, capped at 120 seconds. A final refusal (`401`, an empty account) becomes an `error` event at once, as `openrouter <status>: <message> (<reason>)`.
- Every request is bounded twice, and neither bound is a limit on how long a good answer may take. See "Bounded waits" below.
- A stream that ends with neither `[DONE]` nor a `finish_reason` was cut under the reply. With nothing received yet the request is made again, up to `retries` times; with part of the reply received it cannot be, and the error says so (`the connection closed before the reply finished, part-way through it: no finish reason was sent`). A reply that finishes with no text and no tool call is an error too (`the model returned an empty reply (finish_reason: stop)`), because a turn that took it as the end stopped mid-work with nothing said.
- A reply that ends with `finish_reason` `length` is an error (`the reply stopped at the output limit of N tokens (max_tokens); reasoning counts against it, so raise defaults.max_tokens or ask for less at once`), because its tool call arguments would be half a JSON document. `content_filter` is an error too.

## Configuration

`config.packages["@thetis/provider-openrouter"]`:

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `${OPENROUTER_API_KEY}` | The OpenRouter key. The manifest's default is the reference; put the key in `.env` and the config service resolves it at read time. |
| `baseUrl` | `https://openrouter.ai/api/v1` | The API root. |
| `headers` | `{}` | Extra request headers, merged over `Authorization`, `HTTP-Referer` and `X-Title`. |
| `defaults` | `{}` | Request fields sent with every call, under `call.params`. Set `max_tokens` here, and whatever turns reasoning on. |
| `cache` | `{}` | The prompt caching policy: `enabled`, `ttl`, `systemTtl`, `anchorStride`, `maxBreakpoints`, `explicitVendors`, `overrides`, `hints` (`ignore`, `tune` or `override`), `affinity`. See `@thetis/prompt-cache`. |
| `retries` | `3` | How many times a transient refusal is tried again. |
| `requestTimeoutMs` | `180000` | How long the whole attempt to get a response may take: every retry and every wait between them, counted from the first request. |
| `streamStallMs` | `120000` | How long an open stream may send no bytes at all before it is abandoned. Any byte resets it. |

A configured `0` or a negative value for either bound is ignored and the default stands. There is no way to switch them off, because the shape they rule out is the one nothing else catches.

The kernel does not pass `OPENROUTER_API_KEY` into the fence, so the key reaches the provider through the configuration. `apiKey` and `baseUrl` are declared with their defaults in this package's manifest (`thetis.config.<key>.default`), which the config layers read live; the kernel compiles in no default for any package. `thetis config show @thetis/provider-openrouter` reports them with `source: default` until a layer overrides them.

## Bounded waits

Node's `fetch` has no timeout of its own. A connection that opens and then produces nothing waits for ever, and a caller that walks away from an async generator parked on an `await` does not end it: the generator sees a `return()` only when it next reaches a `yield`, which a request producing nothing never does. That is how a turn came to sit on an open socket for the whole of its budget, spend nothing more, and be thrown away with everything it had already done.

So there are two bounds, and they are deliberately about two different things:

| Bound | Covers | Reset by | What it rules out |
|---|---|---|---|
| `requestTimeoutMs` | From the first request until the response headers arrive, retries and the waits between them included. | Nothing. It is one budget for the whole attempt, so adding `retries` cannot buy more time. | A request that is accepted and never answered. |
| `streamStallMs` | An open stream, from the last byte read. | Every byte. | A stream that is open and silent. |

Neither is a limit on the reply. A model that thinks for twenty minutes sends SSE traffic while it does, and every chunk resets the stall bound; a long answer is never cut short by either. What is bounded is silence, not work, which is the same distinction `@thetis/harness-core` makes one layer up when it asks whether to keep waiting rather than killing a turn on a timer.

When a bound fires, the events already yielded stand: a stream that sent three paragraphs and then went quiet delivers those three paragraphs and then one `error` event saying what happened. When the caller's `signal` fires instead, the request is aborted and nothing further is yielded, because a caller that has given up is not waiting to be told why.

## Use

A fuller configuration, with a ceiling on output and the upstream pinned so a conversation stays on one provider's cache:

```json
"packages": {
  "@thetis/provider-openrouter": {
    "apiKey": "${OPENROUTER_API_KEY}",
    "baseUrl": "https://openrouter.ai/api/v1",
    "defaults": { "max_tokens": 32768, "provider": { "order": ["anthropic"], "allow_fallbacks": true } },
    "cache": { "ttl": "5m", "systemTtl": "1h", "hints": "tune" }
  }
}
```

Set `defaults.max_tokens`. OpenRouter reserves the model's full output allowance against the account's remaining credits for every request in flight; without a ceiling, a large prompt on a low balance is refused with `402 in_flight_budget_exhausted`. Reasoning counts against the ceiling, so leave room for it.

List the models the provider serves, and send one turn:

```sh
thetis models --user alice
thetis send --user alice "hello"
```

The model of a turn is `config.model` (`anthropic/claude-sonnet-5` by default), the one a person picked in the web gateway, or whatever a step sets in `call.model`. Model ids are OpenRouter ids. `thetis send` and `thetis chat` print the usage line with `cache_read_tokens` and `cache_write_tokens` under each reply.

## Reasoning

Nothing in the request code asks a model to think: `defaults` is spread into the body as it is, so the deployment decides. `"defaults": { "reasoning": {} }` asks OpenRouter for the model's default effort, `{ "reasoning": { "effort": "high" } }` or `{ "reasoning": { "max_tokens": 4096 } }` sizes it, and `{ "include_reasoning": true }` is the older spelling that some upstreams still answer to. A model with no reasoning to report simply sends none, and the provider yields nothing.

Reasoning tokens are output tokens: they count against `defaults.max_tokens` and against the bill, and `normalizeUsage` reports them separately as `reasoning_tokens` when the model says how many it spent.

```json
"packages": {
  "@thetis/provider-openrouter": {
    "defaults": { "max_tokens": 32768, "reasoning": { "effort": "medium" } }
  }
}
```

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: the provider export. |
| `src/index.ts` | `createProvider`, `retryAfterMs`, `refusal`, `stopMessage`, `requestScope`, the wire conversion, the SSE reader. |
| `test/retry.test.ts` | Which refusals are retried and for how long; the refusal and stop sentences. |
| `test/bounds.test.ts` | Both bounds against a local server that accepts the connection and then says nothing: the deadline, the stream stall, the caller's signal, and a normal stream that neither bound touches. |

## Tests

`npm test` from the runtime root builds every package and runs `test/retry.test.ts` and `test/bounds.test.ts` with `node --test`. Nothing in the tests reaches the network: the bounds are tested against a server on `127.0.0.1` that is written to behave the way the wedged one did.

## Content parts

The runtime 0.2 contract uses ordered content parts. This adapter sends user text, image assets, audio assets and PDFs through the per-call asset context. Unsupported kinds, roles and generated-media streams fail explicitly. Modality conversion lives in `src/content.ts`; the runtime retains unknown kinds for other providers. See the runtime `docs/content.md` guide for input shapes and supported formats.

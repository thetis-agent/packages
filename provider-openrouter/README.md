# @thetis/provider-openrouter

The default provider. It sends model calls to OpenRouter's OpenAI-compatible chat completions endpoint with streaming and tool calls, applies the prompt caching policy at the wire, and reports usage with cache accounting. It is a `provider` package in the default `systemPackages["_system"]`, so it runs in the system userspace fence with the operator's key; the kernel sends `config.packages["@thetis/provider-openrouter"]` only there. A harness's call step reaches it through `env.kernel.providers.call`, which the kernel routes by `call.model` to this fence; the calling fence never sees the key.

## What it provides

One provider export, declared as `"thetis": { "type": "provider", "export": "createProvider" }`:

| Export | Use |
|---|---|
| `createProvider(config)` | Returns `{ models(), call(call) }`. `models()` calls `GET /models` and returns every id, so the kernel resolves any OpenRouter model id to this provider. `call()` posts to `/chat/completions` with `stream: true` and `usage: { include: true }` and yields `text`, `tool_call`, `usage` and `error` events. |

No steps, no tools, no service, no UI, no bench suites.

What `call()` does with a `ProviderCall`:

- `call.system` becomes the first message with role `system`; an assistant message with `toolCalls` becomes `tool_calls` with JSON-encoded arguments; a `tool` message becomes `{ role: "tool", tool_call_id, name, content }`; `call.tools` become `function` tools.
- The body is `{ model, messages, tools, stream, usage, ...defaults, ...call.params }`. The cache policy from `cache` is combined with `call.hints.cache` and `cache_control` markers are written by `applyOpenAiCompatible` from `@thetis/prompt-cache`. The hint's affinity token becomes the `user` field when the body has none.
- Streamed tool call fragments are joined by index and emitted after the stream ends. Invalid JSON in arguments becomes `{ _raw: "<text>" }`.
- Every usage chunk passes through `normalizeUsage`: `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost`, `cache_read_tokens`, `cache_write_tokens`, `cache_read_ratio`, `reasoning_tokens`.
- A transient refusal (`408`, `409`, `425`, `429`, `5xx`, or a `402` whose body names `in_flight_budget`) is tried again up to `retries` times, waiting for the `Retry-After` header, else the hint in the body, else 1, 2, 4 seconds, capped at 120 seconds. A final refusal (`401`, an empty account) becomes an `error` event at once, as `openrouter <status>: <message> (<reason>)`.
- A reply that ends with `finish_reason` `length` is an error (`the reply stopped at the output limit of N tokens (max_tokens); reasoning counts against it, so raise defaults.max_tokens or ask for less at once`), because its tool call arguments would be half a JSON document. `content_filter` is an error too.

## Configuration

`config.packages["@thetis/provider-openrouter"]`:

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `${OPENROUTER_API_KEY}` | The OpenRouter key. The manifest's default is the reference; put the key in `.env` and the config service resolves it at read time. |
| `baseUrl` | `https://openrouter.ai/api/v1` | The API root. |
| `headers` | `{}` | Extra request headers, merged over `Authorization`, `HTTP-Referer` and `X-Title`. |
| `defaults` | `{}` | Request fields sent with every call, under `call.params`. Set `max_tokens` here. |
| `cache` | `{}` | The prompt caching policy: `enabled`, `ttl`, `systemTtl`, `anchorStride`, `maxBreakpoints`, `explicitVendors`, `overrides`, `hints` (`ignore`, `tune` or `override`), `affinity`. See `@thetis/prompt-cache`. |
| `retries` | `3` | How many times a transient refusal is tried again. |

The kernel does not pass `OPENROUTER_API_KEY` into the fence, so the key reaches the provider through the configuration. `apiKey` and `baseUrl` are declared with their defaults in this package's manifest (`thetis.config.<key>.default`), which the config layers read live; the kernel compiles in no default for any package. `thetis config show @thetis/provider-openrouter` reports them with `source: default` until a layer overrides them.

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

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: the provider export. |
| `src/index.ts` | `createProvider`, `retryAfterMs`, `refusal`, `stopMessage`, the wire conversion, the SSE reader. |
| `test/retry.test.ts` | Which refusals are retried and for how long; the refusal and stop sentences. |

## Tests

`npm test` from the runtime root builds every package and runs `test/retry.test.ts` with `node --test`. Nothing in the tests reaches the network.

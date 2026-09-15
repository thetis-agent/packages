# @thetis/prompt-cache

Prompt caching for Thetis. The package has two parts. A library resolves a caching policy from configuration, plans where the cache breakpoints go, writes them into a request body, and normalizes usage numbers; `@thetis/provider-openrouter` imports it and runs it in the system userspace fence, where the policy is owned by whoever pays. One pipeline step attaches a caching hint to the call and records where the cached prefix broke; it is a `loader` package in the default `systemPackages["*"]`, so it runs in each person's fence.

## What it provides

One step, declared in `thetis.steps`:

| Step id | Phase | Export | What it does |
|---|---|---|---|
| `cache-hints` | `call` | `cacheHints` | Sets `call.hints.cache` to a sparse hint: only the knobs this package's configuration names for the model's vendor, plus an `affinity` token. With `diagnostics` on, it also hashes the head (model, system prompt, tool list) and each message of `call.messages`, compares them with the previous turn, and stores the result in `harness["@thetis/prompt-cache"]`. |

The library, for a provider to import:

| Export | Use |
|---|---|
| `resolvePolicy(config, model)` | The policy for one model: `strategy` (`breakpoints`, `automatic` or `off`), `ttl`, `systemTtl`, `anchorStride`, `maxBreakpoints`. Vendors in `explicitVendors` (default `["anthropic"]`) get `breakpoints`; every other vendor `automatic`. The vendor is the part of the model id before `/`. |
| `readHint(raw)`, `applyHint(policy, hint, mode)` | Validate a hint that crossed the fence, dropping malformed fields, and combine it with the policy under the mode `ignore`, `tune` (default: lifetimes, stride, budget and affinity, never the strategy) or `override`. |
| `planBreakpoints(slots, opts)` | Up to four positions: the system prefix, two anchors on multiples of `anchorStride`, and the final message. A run of `tool` messages counts as one position. |
| `applyOpenAiCompatible(body, policy)`, `applyAnthropicMessages(body, policy)` | Write `cache_control` markers into a request body. Both return the number of markers written and leave the body unchanged for `automatic` and `off`. |
| `normalizeUsage(raw)` | One shape for usage: `prompt_tokens`, `completion_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cache_read_ratio`, `reasoning_tokens`, from OpenRouter or Anthropic field names. |
| `fingerprint(call)`, `diagnose(prev, next)`, `describe(d)`, `affinityOf(user)` | The diagnostics the step uses, and the token `thetis:` plus 16 hex characters of a hash of the user id. |

No tools, no service, no UI, no bench suites.

## Configuration

`config.packages["@thetis/prompt-cache"]`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` puts `strategy: "off"` in the hint. |
| `ttl` | not set | `"5m"` or `"1h"`: the lifetime asked for the conversation breakpoints. |
| `systemTtl` | not set | Lifetime of the system prefix breakpoint. |
| `anchorStride` | not set | Positions between anchors; `0` disables them. |
| `maxBreakpoints` | not set | Clamped to 4 by the provider. |
| `explicitVendors` | not set | Vendors that get the `breakpoints` strategy; the hint then names a strategy. |
| `overrides` | `{}` | Per-vendor or per-model settings (`strategy`, `ttl`, `systemTtl`, `anchorStride`, `maxBreakpoints`). A key matches a vendor or a prefix of the model id; the longest match wins. |
| `diagnostics` | `true` | Record prefix fingerprints in the harness and log a divergence to the agent's stderr. |
| `affinity` | `true` | Put the affinity token in the hint. |

A key that is not set is not in the hint. With an empty configuration the hint carries only the affinity token, and the provider's own policy applies unchanged. Whether a hint can change anything is the provider's `cache.hints` mode, not this package's. The package reads no environment variables.

## Use

Ask for hour-long conversation entries and closer anchors on Opus models, from the harness side:

```json
"packages": {
  "@thetis/prompt-cache": {
    "overrides": { "anthropic/claude-opus": { "ttl": "1h", "anchorStride": 4 } }
  }
}
```

Read the diagnostics of a session. The record is `{ head, messages, turns, divergences, last?: { kind, at?, turn } }`, where `kind` is `head` (model, system prompt or tool list changed), `rewrite` (a message at index `at` changed) or `truncate` (the history was cut to `at` messages):

```sh
thetis sessions show --user alice --session <id>
```

A divergence also logs one line from the agent:

```
prompt-cache: turn 7: message 3 changed; the prefix is re-written from there
```

On the provider side, as `@thetis/provider-openrouter` does it:

```ts
const policy = applyHint(resolvePolicy(cacheConfig, call.model), readHint(call.hints?.cache), cacheConfig.hints);
applyOpenAiCompatible(body, policy);
```

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: one step. |
| `src/step.ts` | `cacheHints`, `affinityOf`. |
| `src/policy.ts` | `resolvePolicy`, `resolveHint`, `readHint`, `applyHint`, `normalize`, the `CacheConfig` type. |
| `src/plan.ts` | `planBreakpoints`, `collapse`. |
| `src/openai.ts`, `src/anthropic.ts` | The two wire adapters. |
| `src/usage.ts` | `normalizeUsage`. |
| `src/fingerprint.ts` | `fingerprint`, `diagnose`, `describe`. |

## Tests

`npm test` from the runtime root. The files are `test/policy.test.ts`, `test/plan.test.ts`, `test/wire.test.ts`, `test/usage.test.ts` and `test/step.test.ts`.

See docs/16-prompt-cache.md in the runtime repository.

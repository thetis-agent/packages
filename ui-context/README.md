# @thetis/ui-context

The Context dock shows the latest model request and the conversation's usage. It runs as a UI package inside the person's workspace, with no build step or dependencies.

## Views

- **Request** shows the model, capture time, request parameters, every message and tool definition as expandable JSON, byte sizes and prompt-cache breakpoints. **Copy JSON** copies the entire request. OpenRouter supplies its exact serialized HTTP body after defaults, parameter overrides and cache policy; authentication headers are excluded. Other providers show their complete provider input, labelled as such.
- **Prompt** shows the captured system/developer instructions as rendered Markdown, with **Copy** and a text-selection fallback.
- **Usage** shows session cost, prompt/completion/cache/reasoning tokens, the latest call's cache hit share, and a per-turn ledger, newest first. Running, completed, failed, cancelled and interrupted turns retain the usage the provider reported. Missing values appear as unknown rather than zero.

The latest request is replaced on every model call, including tool rounds. It is available during the first turn, before the session's after-step runs. This is the most recent request, not a per-turn request archive. Older requests whose full bodies were never captured retain their saved summary. Older accounting saved by the web gateway is included once; unavailable historical usage is identified explicitly.

## Data and refresh

The manifest declares a wide `context` dock and the `context` command exported as `uiContext`. The command first calls `env.kernel.sessions.inspect(env.session)` to authorize the conversation. It then reads the harness's atomic snapshot at `home/harness-core/context/<session>.json`, with the legacy `harness["@thetis/harness-core"].lastCall` summary as a fallback. Historical accounting comes from `home/gateway-web/sessions/<user>/<session>.json`.

The command returns `{ data: { turns, status, started, lastCall, usage } }`. Active conversations waiting for their first capture show that the turn is running. An existing conversation with no capture says that no capture is available. Only a conversation with no input or turns says nothing has been sent.

Opening a stale dock, changing conversations, `turn.start`, `context.updated` and `turn.end` refresh the view. The harness emits the small `context.updated` notification only after saving its snapshot; full requests never travel over the turn event stream. A closed dock fetches nothing. Requests coalesce, stale answers are discarded, and **Refresh** is available for manual retry. Expanded rows survive updates within a conversation.

## Tests

`node --test packages/ui-context/test/ui-context.test.js` from the runtime root exercises session authorization, live capture, historical accounting and the browser's rendering/refresh races. Harness tests cover capture timing, exact request retention and failed/cancelled usage. The host suite verifies capture during the first turn through the real fence; provider tests compare captured JSON to a local HTTP server's received body.

The optional Chromium test uses the actual gateway shell and extension seam, with local fixture responses:

```sh
THETIS_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
THETIS_CHROMIUM_EXECUTABLE=/path/to/chrome \
THETIS_BROWSER_ARTIFACTS=/tmp/thetis-context-browser \
node --test packages/ui-context/test/browser-regressions.mjs
```

It checks the first-turn state, automatic updates, all three tabs, both copy controls, mobile layout and closed-dock fetching. Failure screenshots and traces are retained.

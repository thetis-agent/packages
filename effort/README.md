# @thetis/effort

How hard the model thinks, chosen per conversation. A pill beside the model picker in the web gateway's composer says the effort of the open conversation and opens a list to change it; a `call`-phase step sends the choice as the request's `reasoning` parameter.

## What it does

| Piece | Where | What |
|---|---|---|
| `applyEffort` | step, phase `call` | Reads the conversation's choice and writes `call.params.reasoning`: `{ effort }` for a level, `{ enabled: false }` for **Off**. Nothing when there is no choice, or when the fence's model list says the model does not think. |
| `effort-state` | UI command | The conversation's own choice, the remembered one, and what the step would send. |
| `effort-set` | UI command | Records a choice. `effort: ""` means the default again. `remember: false` leaves the remembered choice alone. |
| `effort-models` | UI command | The default model and, for every model that thinks, its reasoning descriptor from `kernel.models()`. |
| the pill | `composer` slot `effort` | Hidden for a model that does not think. The list is cut to the efforts the model accepts, and **Off** is left out when its thinking is mandatory. |

The efforts are OpenRouter's: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, and `none` (Off). A level the model does not take is mapped by OpenRouter to the nearest one it does; `none` on a model whose thinking is mandatory is refused by OpenRouter with its own sentence, which the turn reports as its error. The step does not second-guess the provider: the page hides what the model rejects, and the request carries what was asked.

`call.params` is spread over the request body after the provider's `defaults`, so a choice made here wins over a deployment-wide `"reasoning": { "effort": "medium" }`. No choice means the deployment's default, or the model's own, exactly as before this package was installed.

## Files

Under `effort/` in the person's home, written only by this package's commands:

- `sessions.json`: session id to effort.
- `prefs.json`: `{ "default": "<effort>" }`, the choice made last, which a conversation without a choice of its own inherits. Choosing **Default** clears both, as the model picker's **Default** does.

## What the provider has to say

The pill needs each model's `reasoning` descriptor on `kernel.models()`: `{ mandatory, defaultEnabled?, defaultEffort?, supportedEfforts?, supportsMaxTokens? }`. `@thetis/provider-openrouter` 0.3.6 carries it from OpenRouter's model listing. A provider that lists no descriptor hides the pill for its models, and the step sends nothing for them.

## Tests

```sh
node --test "packages/effort/test/*.test.js"
```

`test/browser.mjs` drives the pill in Chromium over the real gateway page with a routed fake API, the way `packages/gateway-web/test/browser-regressions.mjs` does. It is not part of `npm test`; run it with `THETIS_PLAYWRIGHT_MODULE` and `THETIS_CHROMIUM_EXECUTABLE` set as `packages/gateway-web/test/BROWSER.md` describes.

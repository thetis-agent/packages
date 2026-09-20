# @thetis/ui-context

The Context dock of the web gateway: what the model received on the last call of the open conversation, as `@thetis/harness-core` recorded it. It is a `ui` package with no build step and no dependencies. Its browser module runs in the page; its one command runs inside the person's own fence, where `@thetis/gateway-web` calls it as the person. Every person gets it by default.

## What it provides

The manifest declares `type: "ui"` and a `ui` block with `dir: "ui"`, `entry: "index.js"` and `style: "index.css"`.

| Slot | Id | Label | Notes |
|---|---|---|---|
| `dock` | `context` | Context | `wide: true`. Hint: "What the model received on the last call". |

| Verb | Export | Who may send it | What it does |
|---|---|---|---|
| `context` | `uiContext` | any signed-in person | Reads `env.kernel.sessions.inspect(env.session)` and answers `{ turns, lastCall }`. Refuses when no conversation is open. |

`lastCall` is the record `@thetis/harness-core` writes under its own key in `harness` after each call: the model, the time, the system prompt and its length, the tool names offered, and the count of messages in the exchange. It is `null` before the first call. The command computes nothing; the page draws what the harness wrote. The command has no `label` in the manifest.

## Use

The **Context** button in the rail opens the dock. The subtitle reads `turn N · <model> · <chars> chars` once a call has been made, or `turn N` before one. Two tabs:

- **Request** lists the model, when the call was made, how many tools were offered and how many messages were in the exchange, then the tool names as pills.
- **Prompt** shows the system prompt as rendered markdown in a scrolling block. A **Copy** button in the dock's actions copies it to the clipboard, or selects the block when the clipboard is not available.

Without a conversation the dock says to open one. Before the first call it reads "Nothing has been sent in this conversation yet." A refused request shows its sentence in the body.

The dock asks when the page opens, when the open conversation changes, and when a turn of that conversation ends; never while drawing. One request is in flight at a time, and an answer for a conversation no longer open is dropped.

## Files

| File | Content |
|---|---|
| `package.json` | The dock entry and the one command. |
| `index.js` | `uiContext`. |
| `ui/index.js` | `install(ext)`: registers the dock, the two tabs, the Copy button, the refresh rules. |
| `ui/index.css` | The dock's styles, under `.ui-context`. |
| `test/ui-context.test.js` | The tests. |

## Tests

`npm test` from the runtime root runs `test/ui-context.test.js`: the command over a fake kernel (the record, `null` before a call, the refusal without a conversation), the manifest's files, and the browser module over a fake seam (nothing at import, one dock registered, the two tabs drawn, the refresh on conversation change and turn end, coalescing, the dropped late answer). The browser checklist is `packages/gateway-web/test/BROWSER.md`.

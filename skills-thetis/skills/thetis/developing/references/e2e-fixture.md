# The echo provider fixture

`packages/host/test/fixtures/provider-echo/index.js` is a deterministic provider, so an end-to-end test
can assert on exact output without a model. New model behaviour in a test means teaching it a trigger.

A `tool` message as the last message wins over everything below: it yields `tool said: <content>`.

| Input text | What the provider does |
|---|---|
| `run: <cmd>` | Calls the **`shell`** tool with `<cmd>`, but only when `shell` is among `call.tools` |
| `install: <path>` | Calls the `install_package` tool with that source |
| `slow: <words>` | One text event per word, 50 ms apart, for testing streaming and cancellation |
| `system?` | The text of `call.system` |
| `tools?` | The tool names in `call.tools`, comma separated |
| `hints?` | `call.hints` as JSON |
| anything else | `echo: <text> (<config.tag>)`, where the tag is `untagged` when unset |

The `config.tag` in the fallback is how a test proves a provider received its own configuration.

Read the file before adding a trigger. It is short, and the exact conditions matter: `run:` is ignored
unless the tool is actually attached to the call, which is what makes it useful for testing that a step
attached the tools it should have.

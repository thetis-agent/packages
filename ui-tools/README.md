# @thetis/ui-tools

The Tools dock of the web gateway: every tool the open conversation can call, one section per installed package, and a last section naming the declared tools the conversation's last call did not receive. It is a `ui` package with no build step and no dependencies. Its browser module runs in the page; its one command runs inside the person's own fence, where `@thetis/gateway-web` calls it as the person. Every person gets it by default.

## What it provides

The manifest declares `type: "ui"` and a `ui` block with `dir: "ui"`, `entry: "index.js"` and `style: "index.css"`.

| Slot | Id | Label | Notes |
|---|---|---|---|
| `dock` | `tools` | Tools | `wide: true`. Hint: "Every tool this conversation can call". |

| Verb | Export | Who may send it | What it does |
|---|---|---|---|
| `tools` | `uiTools` | any signed-in person | Reduces `env.kernel.packages.list()` to `{ packages, lastCall }`: each package's name, its `thetis.label` when it has one, version, type, description and its declared tools (name, description, required parameters, and the effect it declares as `reads`), plus the time and tool names of the last call when a conversation is open. |

`lastCall` is the record `@thetis/harness-core` keeps under its own key in `harness` after each completed turn; only its `at` and `tools` travel. It is `null` without a conversation, or before the conversation's first call.

`reads` is what the tool declares about itself, and nothing is guessed from its name: `true` when the tool's manifest entry has `reads: true` (or the MCP spelling `annotations.readOnlyHint: true`), `false` for `reads: false` (or `readOnlyHint: false`), and `null` when it says nothing. An extension declares it on each tool:

```json
{ "name": "shell_read", "description": "…", "parameters": { … }, "export": "shellRead", "reads": true }
```

The old guess from the name called every tool that did not start with `read_`, `get_` or `list_` one that "changes files", which was false of read-only tools such as `moo_list_verbs`.

## Use

The **Tools** button in the rail opens the dock. The subtitle counts the tools and the packages. A search field filters the cards by name or description in the page, without asking the server again. Each extension is a section with its label (or its name), version, tool count and description, and a card per tool: the name, a badge, the description, and `requires path, contents` or `no required parameters`. The badge is `reads only` when the tool declares `reads: true`, `can change things` when it declares `reads: false`, and there is no badge when it declares nothing. With developer details on (`ext.developer()`, the person's own preference), an undeclared tool gets a dim `effect not declared` badge instead, for whoever writes the extension.

The last section, **Turned off right now**, lists the declared tools the conversation's last call did not carry, each with a `withheld` badge, and says when that call was made. This is where a project's switched-off tools show after the first turn; the dock only knows the difference between what is declared and what was sent, not which package held a tool back. Before any call the section reads "No call yet in this conversation."

The dock asks once per conversation, once more when a turn of the open conversation ends, and never while drawing. A refused request shows its sentence in the body.

## Files

| File | Content |
|---|---|
| `package.json` | The dock entry and the one command. |
| `index.js` | `uiTools` and `declaredReads`. |
| `ui/index.js` | `install(ext)`: registers the dock, watches the conversation and the turn events, draws the sections. |
| `ui/index.css` | The dock's styles, under `.ui-tools`. |
| `test/ui-tools.test.js` | The tests. |

## Tests

`npm test` from the runtime root runs `test/ui-tools.test.js`: the command over a fake kernel, and the browser module over a fake seam (nothing at import, one dock registered, one request per conversation and per turn end, the withheld set, the filter, the refusal, the badges only from a declaration and the developer-only `effect not declared`). The browser checklist is `packages/gateway-web/test/BROWSER.md`.

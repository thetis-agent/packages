# The browser seam

The page calls `install(ext)` once per package. `ext` is frozen. Its members:

| Member | Use |
|---|---|
| `ext.package` | The package name. |
| `ext.dock(id, { draw })` | `draw()` returns `{ title, subtitle?, body: Node, actions?: Node[] }`. Called on open and on `ext.redraw()`. |
| `ext.panel(id, { mount })` | `mount(root, { role, user })` draws a control panel section. It can return an unmount function. |
| `ext.place(id, { open })` | `open(root, params)` draws the place. The shell draws the header and the close button. It can return an unmount function. |
| `ext.sidebar("head", mount)` | `mount(root)` draws into the slot at the top of the sidebar. |
| `ext.chip(id, { draw, open })` | `draw(button)` sets the text and the classes. `open()` runs on click. |
| `ext.composer(id, { mount })` | `mount(root)` draws beside the model picker. |
| `ext.shelf(id, { mount })` | `mount(root)` draws the drawer. The shell owns the grip and the close. `ext.shelf.isOpen()` says whether the drawer is open. |
| `ext.statusbar(id, { draw })` | `draw(node)` draws the item. |
| `ext.transcript(render)` | `render(event, ctx)` returns a Node for a tool row, or nothing to fall through. `ctx` is `{ session, el, icon, markdown, restored }`. Besides tool events and `message.rendered`, it is offered a live `extension` event as the turn emitted it, `{ type: "extension", name, data }`, and on restore a `{ type: "marker", index, session, record }` before the saved message at `index` and once after the last (`index` = the conversation's length); a Node answered to either is placed as its own row. Markers come only when a renderer is registered, and only from the top-level transcript. |
| `ext.request(verb, { session, args })` | Sends one of the package's own verbs. Resolves to `{ text, data }`. Rejects with an Error whose message is the server's sentence. A verb the package did not declare throws at once. |
| `ext.subscribe(verb, { args, session, onEvent, onClose })` | Opens a verb declared `stream: true`. Returns the stop function. |
| `ext.can(verb)` | Whether a verb of any kind is declared and the person's role clears it. |
| `ext.raw` | Only when the package declared a `kind: "raw"` command, so guard `ext.raw?.url`. `raw.url(verb, args, { session }?)` is the route for a `fetch`, an `img` or a download; `raw.put(verb, args, blob, { onProgress, signal, session }?)` uploads a file as the whole body. |
| `ext.redraw(id?)` | Redraws this package's open dock, chips, and statusbar entries. |
| `ext.events.watch(fn)` | `fn({ session, turn, seq, event, input? })` for every turn message. Returns an unwatch function. |
| `ext.conversation` | `current` (the id of the open conversation), `watch(fn)`, `send(text)`, `open(id)`. |
| `ext.sessions` | `list()`, `watch(fn)`, `filter(fn)`. `filter` narrows the sidebar. `filter(null)` clears it. `onCreate(fn)` watches only conversations created by this page and returns an unwatch function; the shell awaits `fn(id)` before opening or sending. |
| `ext.open` | `dock(id)`, `place(id, params)`, `shelf(id)`, `panel(id)`. |
| `ext.close.shelf()` | Closes the drawer, whoever is in it. |
| `ext.dom` | `el(tag, props, ...children)`, `icon`, `clear`, `setHidden`. |
| `ext.ui` | The panel helpers: tables, badges, fields, buttons, the confirm popover, key and value lists, `section`, and `menu(at, items, { onClose }?)`, the shell's floating menu. |
| `ext.toast(text, opts)` | A toast. |
| `ext.notice(id, { title, body?, tone?, actions?, progress?, dismissible?, onDismiss? })` | A persistent card in the bottom-right corner, above the toasts. Answers `{ update(partial), close() }`. One card per id, replaced in place, so a countdown or a progress sequence is one card that changes. The gateway prefixes the id with the package name. `tone` is `info` (default), `warn`, `error` or `ok`; `body` is a string or a Node; `actions` are `[{ label, run, primary? }]`, each button disabled while its `run` promise is pending; `progress` is `{ steps: string[], at: number, failed?: boolean }`; `dismissible` defaults to true, and `onDismiss()` runs when the person closes it. An `update` to a card the person dismissed is dropped. |
| `ext.notice.close(id)` | Closes that card. |
| `ext.awaitReturn({ timeoutMs = 90000, onState?, since? })` | Answers `"back"` once the connection to Thetis went away and came back (or only came back, when it was already away), else `"timeout"`. `onState(state)` hears `waiting`, `gone`, then `back` or `timeout`. `since` (epoch ms) answers `"back"` at once when the connection already came back after that moment. The one way every package waits for an apply or a restart. |
| `ext.developer()`, `ext.onDeveloper(fn)` | The person's **Developer details** switch. `onDeveloper` calls `fn(on)` when it changes and answers the stop function. Show raw dumps, problem lists and internal rows only while it is on. |
| `ext.turns.running()`, `ext.turns.onIdle(fn)` | Whether any of the person's turns runs, subagents included; `onIdle` calls `fn()` each time that set becomes empty and answers the stop function. Wait for it before anything that restarts the person's space. |
| `ext.build` | `{ id }`, the build the page was loaded with. The page refreshes itself on a changed build; a package need not. |
| `ext.agent` | `{ name, avatar }` read when asked: what an admin called the agent in Control panel → Agent (`Thetis` by default) and its picture as a `data:` URL, or null. `watch(fn)` calls `fn({ name, avatar })` on each change and answers the stop function; `refresh()` asks the server again. Every sentence that names the agent or the server reads `ext.agent.name` when it is drawn; guard `ext.agent?.name \|\| "Thetis"` on an older gateway. |
| `ext.markdown(text, opts)` | The shell's markdown renderer. Returns a list of block nodes (append them with `el(..., ...blocks)` or `node.append(...blocks)`). Never uses `innerHTML`. |

A registration whose id is not in the package's declaration is ignored. A throwing `draw`, `mount`, `open`, or `render` is caught and reported once per package per slot. A transcript renderer that returns nothing falls through to the next one, then to the built-in row.

A notice's words are for a person: say "your space", "extension", "apply" and "Restart Thetis", never fence, reload or daemon. An older gateway may lack `notice`, `awaitReturn`, `turns` or `developer`: check before you call them, and keep working without them.

Sources: packages/gateway-web/assets/lib/ext.js, packages/gateway-web/README.md.

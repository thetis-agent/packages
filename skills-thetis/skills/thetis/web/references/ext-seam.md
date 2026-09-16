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
| `ext.shelf(id, { mount })` | `mount(root)` draws the drawer. The shell owns the grip and the close. |
| `ext.statusbar(id, { draw })` | `draw(node)` draws the item. |
| `ext.transcript(render)` | `render(event, ctx)` returns a Node for a tool row, or nothing to fall through. `ctx` is `{ session, el, icon, markdown, restored }`. |
| `ext.request(verb, { session, args })` | Sends one of the package's own verbs. Resolves to `{ text, data }`. Rejects with an Error whose message is the server's sentence. A verb the package did not declare throws at once. |
| `ext.redraw(id?)` | Redraws this package's open dock, chips, and statusbar entries. |
| `ext.events.watch(fn)` | `fn({ session, turn, seq, event, input? })` for every turn message. Returns an unwatch function. |
| `ext.conversation` | `current` (the id of the open conversation), `watch(fn)`, `send(text)`, `open(id)`. |
| `ext.sessions` | `list()`, `watch(fn)`, `filter(fn)`. `filter` narrows the sidebar. `filter(null)` clears it. |
| `ext.open` | `dock(id)`, `place(id, params)`, `shelf(id)`, `panel(id)`. |
| `ext.dom` | `el(tag, props, ...children)`, `icon`, `clear`, `setHidden`. |
| `ext.ui` | The panel helpers: tables, badges, fields, buttons, the confirm popover, key and value lists, `section`. |
| `ext.toast(text, opts)` | A toast. |
| `ext.markdown(text, opts)` | The shell's markdown renderer. Returns a Node. Never uses `innerHTML`. |

A registration whose id is not in the package's declaration is ignored. A throwing `draw`, `mount`, `open`, or `render` is caught and reported once per package per slot. A transcript renderer that returns nothing falls through to the next one, then to the built-in row.

Sources: docs/plans/gateway-ui-modular.md section 6.3, packages/gateway-web/assets/lib/ext.js.

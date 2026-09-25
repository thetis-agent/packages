# @thetis/gateway-web

The browser interface of one person: the conversation list, the transcript, the composer, the control panel, and the seam through which installed packages add to the page. It is a `service` package. `thetis serve` starts one copy inside each person's own fence. The copy listens on a unix socket, `run/web.sock` in that person's userspace, and the door on the host routes `/<person>/` to it. It holds that person's authority and nobody else's: it reaches the kernel through the fence's RPC as that person and checks the login cookie with the kernel on every request. Signing in is not here; `@thetis/gateway-login` in the system userspace exchanges a password for the cookie.

## What it provides

The manifest declares `type: "gateway"`, a `service` whose export is `startService`, and `publish: [{ port: 8777, to: "host" }]`. There is no configuration. The person served comes from `THETIS_USER`.

### Routes

All relative to `/<user>`. Every `/api/*` and `/ext/*` route needs the cookie; a non-GET request must be same-site.

| Method and path | Effect |
|---|---|
| `GET /` | The app page. Redirects to `/login` without a valid cookie. |
| `GET /assets/<file>` | The gateway's own browser files. |
| `GET /api/me` | `{ user, role, avatar }`. `avatar` is the URL of the picture the person uploaded, or `null`. |
| `GET /api/me/avatar` | That picture, with the type its own bytes say it is, `no-store`; 404 when there is none. |
| `PUT /api/me/avatar` | Replaces it. The body is the file itself — raw bytes, no multipart — up to 512 KB. The type is read off the first bytes and never from `Content-Type`: PNG, JPEG, WebP and GIF, and nothing else (an SVG is a document that can carry script, so it is not on the list). Answers `{ avatar }` with a fresh `?v=`. |
| `DELETE /api/me/avatar` | Takes it off again. Removing one that is not there is not an error. |
| `GET /api/sessions`, `POST /api/sessions` | The person's conversations, newest first; create one. A new conversation starts with the model the person chose last (`prefs/<user>.json`); the answer carries it as `model`. |
| `GET /api/sessions/<id>` | The record with `status`, `archived`, `turn`, `usage`, `model` and `title`. |
| `POST /api/sessions/<id>/send`, `/cancel`, `/archive`, `/model`, `/title` | Start a turn, stop it, archive or restore, choose the model, name the conversation. `send` takes `{ text }` or `{ input }`, where `input` is a runtime `TurnInput`: a user message whose `content` is an array of parts, `text` and `asset` among them. |
| `POST /api/media?name=<file>` | Uploads an attachment for the person: the body is the file itself, its type from `Content-Type`, at most 8 MiB. Answers the asset `{ id, mediaType, name, size }`; a message then carries an `asset` part with that `id`. |
| `GET /api/media/<id>` | Reads one of the person's own assets, inline for the image, audio and video types the transcript draws and as a download for anything else. |
| `DELETE /api/sessions/<id>` | Discards a conversation nothing was ever said in, and everything this gateway kept about it. Refuses with 409 anything with a turn, a turn in flight, or a parent (a subagent is not a conversation); 404 when it is already gone. A record with words in it is archived, never removed. |
| `GET /api/models` | The default model and the models the person's providers serve (`id`, `name`, `provider` only), cached in the gateway for a minute. |
| `GET /api/events` | The Server-Sent Events stream: every turn event of the person, opened with a snapshot of the turns in progress. |

Every route matches its own path and nothing beneath it. A predicate that reads one segment matches everything below it too, and `GET /api/me` came within a length check of answering identity for `GET /api/me/avatar`, so each one pins its segment count and anything deeper is a 404.
| `GET /api/panel`, `GET` and `POST /api/packages`, `DELETE /api/packages/<name>` (`?files=1` deletes the directory too, `?unfork=1` puts the package this fork was copied from back in its place) | The built-in Packages section of the control panel. |
| `GET /api/ui` | What installed packages add to the page, for the person's role. |
| `GET /ext/<scope>/<name>/<path>` | A browser file of an installed package, from under its declared `dir`. |
| `POST /api/ext/<scope>/<name>/<verb>` | A command an installed package declared. Body `{ session?, args? }`. |
| `GET /api/ext/<scope>/<name>/<verb>/stream?args=<json>&session=<id>` | A verb declared with `stream: true`, as Server-Sent Events: each value the export yields as `item`, then `end`, or `error`. |
| `GET` and `PUT /api/ext/<scope>/<name>/<verb>/raw?args=<json>&session=<id>` | A verb declared with `kind: "raw"`: bytes rather than JSON. `GET` serves what the export answers (its status and headers, always under `Cache-Control: no-store` and `Content-Security-Policy: default-src 'none'; sandbox`, a stream piped as it comes); `PUT` carries the body whole, at most the command's `maxBytes` (413 `That upload is larger than N KB.` past it), and answers `{ data }`. `args` is a JSON object of at most 4096 characters, as for a stream. |

JSON request bodies and stored gateway state are validated with Zod. Arrays, primitives, and incorrectly typed model, title, or archive fields receive HTTP 400. Invalid stored records name the offending field; legacy state is fully validated before migration writes any files. Unknown stored fields survive updates.

### The `thetis.ui` contract

A package declares `ui` inside the `thetis` field of its manifest. The kernel never reads the field. The gateway reads it from `kernel.packages.list()` on each request and does four things:

- serves the package's browser files at `ext/<package>/…`, only from under the declared `dir`, and only `.js`, `.css`, `.svg`, `.json` and `.md`;
- composes `api/ui`: one entry per package with a valid declaration, in install order, with the entries and verbs above the person's role left out and the hidden entries named;
- has the page import the declared `entry` and call its default export, `install(ext)`;
- forwards a declared verb to the named export of the package's `main`, after checking that the package declares the verb, that the person's role clears the command's `role`, and that `session`, when named, is one of the person's own. The export runs inside the person's fence as `(args, env)`, where `env` is the fence environment plus `user`, `role` and `session`. A string answer becomes `{ text }`, an object `{ text?, data? }`, and no answer becomes `{}`. A thrown error returns `400 { error }`; a malformed answer or data that cannot be serialized returns 502.

A command is one of three kinds, and each has its own route; a verb reached through the wrong one is refused with a sentence naming the right one. `stream: true` makes it a subscription (`/stream`). `kind: "raw"` (default `"json"`) makes it carry bytes (`/raw`): a download, an upload, a picture for an `img`. A raw export is called as `(args, env, { method, body? })`. On `GET` it answers `{ status?, headers, body }` — `status` defaults to 200, `headers` is a plain object (names are lowercased; `set-cookie`, `cache-control` and `content-security-policy` are dropped, because the gateway sets its own), `body` a `Readable`, a `Buffer` or a string. A stream has no size cap and no timeout, and `env.signal` is aborted when the browser lets go, so an export that reads a file or writes a zip stops when nobody is listening. On `PUT` it receives the body as a `Buffer` (`maxBytes` at most: a positive whole number of bytes up to 512 MiB, default 1 MiB, allowed on raw commands only), the 30 s command timeout applies, and whatever it returns is answered as `{ data }`, bounded like a command's answer (finite numbers, 256 KiB). A raw command cannot also stream. The page lists these verbs under `raw` in `api/ui`, beside `commands` and `streams`.

A bad declaration refuses that package by name; the rest still composes. A `dock`, `places`, `sidebar`, `chips`, `composer`, `shelf` or `statusbar` id belongs to the first installed package that declares it. Panel ids are namespaced by package.

A minimal manifest, from `@thetis/ui-context`:

```json
"thetis": {
  "type": "ui",
  "ui": {
    "dir": "ui",
    "entry": "index.js",
    "style": "index.css",
    "dock": [
      { "id": "context", "label": "Context", "icon": "M7.5 4 3.5 10l4 6 M12.5 4l4 6-4 6", "hint": "What the model received on the last call", "wide": true }
    ],
    "commands": [ { "verb": "context", "export": "uiContext" } ]
  }
}
```

A minimal `ui/index.js`, from `@thetis/ui-marketplace`:

```js
import { openGallery } from "./gallery.js";
import { openPage } from "./page.js";

export default function install(ext) {
  ext.place("marketplace", {
    open: (root, params) => (typeof params?.name === "string" && params.name ? openPage(ext, root, params) : openGallery(ext, root)),
  });
}
```

The panel's navigation is a tree view (`assets/lib/tree.js`: `role="tree"`, disclosure toggles, nesting to any depth, the arrow keys, what is open remembered in `localStorage`). A `panel` entry declared with `under` (a built-in section id such as `packages`, or `<package>#<id>`) is not a node of its own: its module registers `{ mount, children }`, the tree hangs what `children()` answers (`[{ id, label, note?, mark?, children? }]`, `mark` being `err` or `warn` for a dot, `children` nesting further) beneath that section, and selecting one mounts the entry with `{ child, refresh }` in the second argument, `refresh()` asking the tree to read the children again. `@thetis/ui-admin` hangs one page per configured package under Packages this way. A child may carry `marks`, a list of `{ glyph, tone, title }` drawn after its label as small squares with the sentence as the tooltip (`tone` warn, err, accent or ok); a child with a warn or err mark needs a look, and the section shows how many of its children do. `kind: "page"` names a child that is a page rather than a package, drawn in the sans face. The nav's foot lists the glyphs in use and offers "only what needs a look", which hides the children without one, remembered with the tree state. The mount's second argument also carries `open(child)`, so a page can send the reader to a sibling page.

`ext` is bound to the one package. It offers a registration function per slot (`dock`, `panel`, `place`, `sidebar`, `chip`, `composer`, `shelf`, `statusbar`), `transcript` for a renderer, `request(verb, { session, args })` for the package's own verbs, `subscribe(verb, { args, session, onEvent, onClose })` for the ones it declared with `stream: true` (it returns the stop function), `can(verb)` for whether a verb of any kind is declared and cleared, and the shell's `dom`, `ui`, `markdown`, `conversation`, `events`, `redraw` and `open`. `markdown(text, { image })` renders `![alt](src)` as an `<img>` for an `https:` source; a relative source is passed to `image(src)`, which answers a URL (a `data:` URL, as the marketplace page does) or `null`, in which case the alt text is shown.

`ext.raw` exists only when the package declared at least one `kind: "raw"` command, so a module written for this gateway must guard `ext.raw?.url` and say so when it is missing. `raw.url(verb, args, { session }?)` answers the relative route (`api/ext/<package>/<verb>/raw?args=…`) for a `fetch`, an `img`, an `object` or `location.assign` — the browser handles a `content-disposition: attachment` as a download. `raw.put(verb, args, blob, { onProgress, signal, session }?)` sends a `File` or `Blob` as the whole body and resolves with the parsed reply (`{ data }`); it is an `XMLHttpRequest`, because `fetch` has no upload progress, and `onProgress({ loaded, total })` follows the bytes up. A refusal rejects with an `Error` carrying the server's sentence (and `status`); an aborted `signal` rejects with an `AbortError`.

`ext.ui.menu(at, items, { onClose }?)` is the shell's floating menu (`assets/lib/menu.js`), the same rows as the ≡ menu in the sidebar head, appended to the body and kept inside the viewport: `at` is an element (the menu opens below it, or above it when the bottom of the window is in the way) or `{ x, y }` (a right-click). `items` are `{ label, icon?, key?, hint?, danger?, disabled?, run }` or `"-"` for a rule; `icon` is a path or list of paths for `dom.icon`, `key` the shortcut shown after the label. It answers the close function; `onClose()` runs once, however the menu went. Arrow keys wrap over the enabled rows, Home and End reach the ends, Enter or Space chooses, Escape closes (stopped on the capture phase, so the place under it stays), and so does a click elsewhere. One menu at a time: opening another closes the first. The DOM is `div.menu.is-floating[role=menu] > button.menu-item[role=menuitem]` (`.is-danger`, `[disabled]`) `> span.menu-icon + span.menu-text > span.menu-label + span.menu-key`, and `div.menu-sep` for a rule.

A transcript renderer (`ext.transcript(render)`) is offered every tool event, and, once a message bubble is complete, `{ type: "message.rendered", role, session, node, restored }`: `node` is the bubble's `.msg-text`, `role` is `user` or `assistant`, `restored` says the bubble was built from the saved record rather than settled live. A restored bubble is offered as it is built; a live one when it settles — the `message` event, or the tool call that ends its text. The answer is ignored: a renderer decorates the text in place (linking paths, say) and never replaces the row. A subagent's nested transcript offers its bubbles too, under the child's session id.

Two more kinds reach a renderer, both message-level (a Node answered is placed as its own row and ends any tool run): a live `extension` event as the turn emitted it, `{ type: "extension", name, data }`, so a package draws its own events (a compaction's card, say) and one nobody takes is ignored as before; and, while a record is restored, `{ type: "marker", index, session, record }` before the saved message at `index` and once more with `index` equal to the conversation's length after the last, so a package can draw what belongs between messages rather than to one (the same card at the compaction's cut, read from `record.harness`). Markers are offered only when at least one renderer is registered, and only by the top-level transcript; a nested one offers nothing to renderers.

## Use

A person opens `/login`, signs in, and lands on `/<person>/`. The sidebar lists their conversations grouped by day, with a search box and a `+` button. The ≡ menu in its head opens the places: **Control panel**, and whatever installed packages add (**Marketplace** from `@thetis/ui-marketplace`, **Project** from `@thetis/projects`). The footer shows who is signed in and **Log out**; clicking the face there chooses an image from the machine — the page shrinks anything larger than 256 pixels before it sends — and the × beside it goes back to the initials. The composer sends on Enter; the model pill chooses a model per conversation. A picture pasted into the box, dropped anywhere on the conversation, or picked with the paper-clip is uploaded at once and shows as a chip in a tray above the box — a thumbnail, its name, and its size once it has landed, or the reason it did not with a Retry — and goes with the message as an `asset` part; a picture alone is a message. The tray takes PNG, JPEG, WebP and GIF, and the PDF, audio and video kinds the shipped adapters translate, up to 8 MiB and ten to a message; anything else is refused with a toast. A send waits for an upload still on its way, and a refused send puts the text and the attachments back. The transcript streams the reply, shows a reasoning model's thinking in a fold above it that closes when the answer starts, folds tool calls into runs, and puts a footnote with the model, cache share, tokens and cost under each reply. A tool call that goes quiet turns amber with a line saying how long it has been silent and that the model is being asked whether to keep waiting, and then says what was decided and by whom: a continue goes back to running and greys the line, a cancel turns the card's badge to `cancelled` and the line red. Amber is deliberate and so is the stopped pulse: the work is still running, nothing has failed, and a stall that reads as a hang is exactly what this is for. The sidebar row and the tab say the same thing in three words (`shell · quiet`, `Waiting on the model`), so a conversation that is not open still shows it. The thinking is live only: nothing saves it, so a reload shows the conversation without it. The rail holds one button per registered dock. The control panel takes over the main pane; Escape or its close button returns to the conversation. Its Packages section is built in; every other section, dock, place and chip comes from an installed package.

A refresh comes back to the conversation that was on screen. The address bar names it — `/<person>/#<session id>` — and that one id is the whole of what the page stores to find its way back: it is a fact about the page rather than a preference about it, it is visible where it is kept, each browser window keeps its own, and the link it makes opens the same conversation for anyone who can read it. The tabs are not restored, only the conversation being read. A hash naming a conversation that no longer exists falls back to the newest one, and one naming an archived conversation opens it, because coming back to where you were is not a judgement about which conversations are interesting. Archiving a conversation that is open in a tab closes that tab: putting a conversation away and still sitting in it is two answers to one question. The neighbouring tab takes over, the archive bucket in the sidebar opens, and the toast's Undo brings the tab back as well as the row. The conversation comes back whole whether or not a turn is running in it: `GET /api/sessions/<id>` carries the saved messages and, separately, the turn the hub is carrying, and the page draws the record and then replays that turn's events on top. The kernel writes a turn's input into the saved conversation the moment the turn starts, so the record holds that one message twice — in `conversation` and as `turn.input` — and the transcript draws `turn.input` only when the conversation does not already end with it.

A conversation nothing was ever said in does not stay. It is not a record of anything — it is the click that made it — and a column of "New conversation" rows is something to read past to reach the one that matters. The page discards them in the two places it can be sure of: when their tab is closed here, which is a person leaving a conversation, said plainly and in time to act on; and on the next load, which sweeps whatever it never got to see closed, because a browser tab shut or a machine that died tells this page nothing. Deliberately not on `beforeunload` or `pagehide`: a request started there is not reliably sent, so the sweep would still be needed, and those events fire on the way into the back/forward cache as well, which is not leaving at all — the person presses Back and finds the conversation they were in gone. An empty conversation harms nothing until it clutters a list, and a list is only read on a load, so catching what can be caught honestly and sweeping the rest is the whole design.

The guardrails sit on both sides of that. `DELETE /api/sessions/<id>` is the floor and it checks the record rather than the page's word for it, because the list a page holds is always a moment old: anything with a turn in it, a turn in flight, or a parent is refused. The page is narrower again — it leaves alone one that was named or archived, one open in a tab here, the one being read, and any conversation made in the last two minutes, since that one is very likely being typed into in another window right now. The sweep runs after the conversation the address bar names is open, so it cannot take the one the page just came back to. And nothing about this is ever shown: it is tidying nobody asked for, so a refusal is an answer and not a fault, and 409 is the ordinary way the server says "somebody got there first".

The built-in Packages section shows one more thing than the gateway itself can work out: whether a package's version here is newer than the version the registries hold (`0.3.0 here, 0.2.0 published`) or is not in the index at all (`no registry here lists it`). That answer needs the marketplace index, and `src/panel.ts` imports no domain package and serves its rows out of `kernel.packages.list()` and nothing else — the built-in section is the bootstrap and stays free of everything the registries know. So `assets/views/panel-packages.js` asks `@thetis/ui-marketplace` for it, over that package's own `search` verb, the same soft link it already makes to open a row in the marketplace place: the request goes out only when that package has declared the verb, it goes out after the table is drawn so the section never waits on it, and a failure leaves the rows as they are. What it says about a package no registry carries is the index's own statement and nothing more, in the words `thetis packages outdated` and the marketplace card both use: the index is built from the registries this installation mirrors, so its silence is a fact about what is mirrored here and not about the world. Whether this person published it anyway, to a target nothing here mirrors, is a different question with a different answer — `publish_targets` asked about one package — and it costs a fetch of every registry per package asked about, which a table of twenty rows cannot spend. Publishing itself is not here either — the registry picker, the version choice, the fork question and the dry run in front of the confirm all live on the package's marketplace page, which is also where that second question is asked, and the detail card's hint points there.

## Files

| File | Content |
|---|---|
| `src/index.ts` | `startService(env)`: listens on `run/web.sock`, returns `{ stop }`. |
| `src/server.ts` | `createGateway(kernel, store, options)`: the routes, the cookie check, the event stream. |
| `src/ui.ts` | `validateUi`, `composeUi`, `serveExt`, `runCommand`, `openStream`, `runRaw`: the extension seam. |
| `src/panel.ts`, `src/http.ts` | The Packages routes and the HTTP helpers. |
| `src/static.ts` | `serveFile` and the table of file types the page may load. |
| `src/turns.ts` | `TurnHub`: runs turns in the background and feeds the event streams. |
| `src/store.ts` | `GatewayStore`: archive flags, names, chosen models and per-reply usage, one file per conversation under `home/gateway-web/sessions/<user>/`; an older `state.json` is migrated on first start and kept as `state.json.migrated`. Uploaded avatars live beside them in `avatars/<user>.<ext>`, the extension naming the type so the bytes and the type served with them cannot drift apart. |
| `src/client.ts` | `clientFromRpc(rpc)`: a `KernelClient` over a raw RPC function. |
| `assets/` | The browser code: plain ES modules, no build step. `lib/ext.js` is the browser side of the seam. `lib/menu.js` is the floating menu (`ext.ui.menu`) and the keyboard walk the places menu shares. `lib/attachments.js` is the composer's attachment list — what a paste or a drop yields, the uploads, and the `TurnInput` a message with pictures is sent as — kept free of the DOM so it runs under `node:test`. |

## Tests

`npm test` from the runtime root builds the package and runs `test/gateway.test.ts` (a real kernel, one gateway per person behind the login target and the door) and `test/ui.test.ts` (the seam, with the fixtures `ui-good`, `ui-bad` and `ui-dup`, and a raw-command package it writes into alice's home). Browser regressions use a small shared DOM fixture: `test/markdown.test.js` covers rendering, `test/transcript.test.js` restores saved and running turns and checks the `message.rendered` offer, `test/menu.test.js` walks the floating menu, and `test/tabs.test.js` checks events arriving during history loads and overlapping reloads. `test/turn-send.test.js` checks HTTP acknowledgements against streamed completion; `test/attachments.test.js` checks the composer's attachment list and the wire shape a message with pictures travels as; `test/ext.test.js` checks awaited local creation hooks. `test/browser-regressions.mjs` drives the real page in Chromium (opt-in, see BROWSER.md) and covers a pasted and a dropped image through upload, tray and send. The wider browser checklist is `packages/gateway-web/test/BROWSER.md`.

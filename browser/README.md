# @bitmuse/browser

A headless Chrome driven by [Playwright](https://playwright.dev), as fourteen
tools that let the model navigate and act on web pages: open a URL, read the
page as an accessibility tree with `[ref=eN]` element handles, click, type,
fill forms, wait, run page JavaScript, take screenshots, and inspect the
console, the network, tabs, cookies and storage.

It is a port of the Rust Thetis's `web-browser-*` tools and their Playwright
sidecar. Tools here are plain JavaScript in the person's own space, so
Playwright is driven in-process: no sidecar, no port, no token.

It is a tool group (`browser`): it joins a chat that mentions a browser,
Playwright, a web page, a screenshot, a login page and the like, or when
`tool_search` loads it.

## Tools

| Tool | Changes things | What it does |
|---|---|---|
| `browser_navigate` | yes | Open a URL, or back / forward / reload. Returns the page map. A bare `example.com` means https. |
| `browser_snapshot` | no | The page map again with fresh refs; filter with `text` or `regex` (+ `context` lines). |
| `browser_click` | yes | Click by ref, selector, or x/y. Says when the click opened a new tab. |
| `browser_hover` | yes | Hover to reveal menus and tooltips. |
| `browser_type` | yes | `fill` (with `submit`, `slowly`), `press_key`, `fill_form` (many fields in one call), `select_option`. |
| `browser_wait` | no | For text to appear or go, an element state, a load state, or a fixed time. |
| `browser_evaluate` | yes | Run an expression or function in the page (optionally on an element); JSON back, cut at `valueChars`. |
| `browser_screenshot` | yes | JPEG/PNG of the viewport, full page or one element, or a PDF. Written under `browser/` in home; the path comes back. |
| `browser_console` | no | Console messages and page errors since the last navigation, by level. |
| `browser_network` | no | Requests since the last navigation: `failedOnly`, `filter`, `index`; and what the host settings blocked. |
| `browser_tabs` | yes | List, open, select, close tabs. |
| `browser_state` | yes | Cookies, localStorage, sessionStorage, storageState, dialogs (arm accept/dismiss), viewport size. |
| `browser_close` | yes | Discard this chat's browser: tabs, cookies, storage. |
| `browser_status` | no | Is Chrome running, which Chrome and Playwright, this chat's tabs, the settings in force. |

Every action returns one context line (`page: <title> — <url> [tab i of n]`)
and then the page's accessibility snapshot, so the model sees what its action
did without another call. Refs belong to the snapshot that produced them; a
stale ref fails with a hint to take a fresh snapshot. A snapshot longer than
`snapshotChars` is cut with a note telling the model to filter.

## How it behaves

- **One Chrome per space, one context per chat.** The browser starts on the
  first call and each chat gets its own `BrowserContext` (cookies, storage,
  cache). A helper chat uses its parent's context by default, so it sees the
  same logged-in pages (`shareWithSubagents`).
- **Calls in one chat run in order.** Two browser calls in the same round
  queue behind each other instead of racing on the page.
- **Idle cleanup.** A chat's context closes after `idleMinutes` (15) without
  a call; the browser stops when no context is left and starts again on demand.
- **Dialogs** (alert, confirm, prompt, beforeunload) are dismissed so they
  cannot block the page. To accept one, arm it first with
  `browser_state { kind: "dialog", action: "accept" }`, then do the click.
- **Downloads** are refused in 0.1.
- The browser state lives on `globalThis`, so when the package is updated the
  new code picks up the running browser rather than leaking it.
  The package's service closes the browser when the space stops.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `executablePath` | (auto) | Chrome to drive. Empty: `/usr/bin/google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`… then Playwright's own download (`npx playwright-core install chromium`). |
| `headless` | `true` | Leave on unless the host has a display. |
| `timeoutMs` | `15000` | Per action and navigation. |
| `idleMinutes` | `15` | Close an idle chat's context. |
| `viewportWidth` / `viewportHeight` | `1280` / `800` | For new contexts. |
| `snapshotChars` | `12000` | Snapshot budget per result. |
| `valueChars` | `8000` | `browser_evaluate` result and storage value budget. |
| `screenshotDir` | `browser` | Relative to home. |
| `shareWithSubagents` | `true` | Helper chats share the parent chat's browser. |
| `allowHosts` | | If set, pages may only be opened on these hosts (`example.com` includes subdomains, `*.example.com` only subdomains). |
| `denyHosts` | | Hosts pages may never be opened on. |
| `blockPrivateNetworks` | `false` | Refuse every request, pages and sub-resources, to loopback and private addresses (checked after DNS). |
| `userAgent` | | Override the User-Agent. |

`allowHosts` and `denyHosts` judge page navigations (including frames and
popups); `blockPrivateNetworks` judges every request. A refusal names the rule
that refused it.

## Requirements

- Node 18+ and a Chrome or Chromium on the host. `playwright-core` is the only
  dependency (pinned to 1.61.0); it does not download a browser on install.
- Chrome runs with `--no-sandbox`, because a Thetis fence has no user
  namespaces for Chrome's own sandbox. The fence is the isolation.
- The fence's network decides what the browser can reach: in `egress` mode it
  reaches the internet and the local network but not the host's loopback.

## Testing

`npm test` runs `test.smoke.mjs`: every tool against a local page (forms,
late content, dialogs, console, network, storage, screenshots and PDF, a
`target=_blank` tab, history, stale refs, isolation between chats, ordering of
concurrent calls, the host policy) plus a public page when the network is there.

`npm run manifest` regenerates `thetis.tools` in `package.json` from
`scripts/manifest.mjs`, where the tool schemas live.

MIT.

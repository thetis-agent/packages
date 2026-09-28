# @thetis/browser

A headless Chrome driven by [Playwright](https://playwright.dev), as seventeen
tools that let the model navigate and act on web pages: open a URL, read the
page as an accessibility tree with `[ref=eN]` element handles, click, type,
fill forms, drag, upload and download files, wait, run page JavaScript, take
screenshots it can look at, and inspect the console, the network, tabs,
cookies and storage.

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
| `browser_screenshot` | yes | JPEG/PNG of the viewport, full page or one element, or a PDF. Written under `browser/` in home, and shown to the model as an image (see below); `show: false` only saves it. |
| `browser_upload` | yes | Put files from home into an `<input type=file>`, or into the chooser a button opens. |
| `browser_drag` | yes | Element to element (drag-and-drop), or between x/y points with the mouse (sliders, canvases); mixes allowed. |
| `browser_downloads` | no | What this chat downloaded and where it was saved; `wait` for a download a click just started. |
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
- **Screenshots the model sees.** The screenshot is saved at full size, and a
  copy scaled to at most `imageMaxWidth` (1280) wide, 7800 tall and 3.5 MB (a
  JPEG, drawn by Chrome itself) is stored as an asset and returned beside the
  text as a `tool-result`. The chat shows it on the tool card. The provider
  decides how it reaches the model: `@thetis/provider-openrouter` 0.5.0 sends
  it in a user message right after the tool results, and tells a model that
  takes no images that it was not shown. With an older provider a tool result
  carrying an image fails the call, so turn `screenshotToModel` off there.
- **Downloads** save themselves as they finish, under `downloadDir`
  (`browser/downloads/` in home), with the site's suggested name made safe (no
  directories, no leading dot) and ` (1)`, ` (2)` added rather than
  overwriting. One over `downloadMaxMb` (200) is discarded. Click the link, then
  `browser_downloads { wait: true }`.
- **Uploads** only take regular files under home, or under a directory named in
  `uploadRoots`; symlinks are resolved before the check.
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
| `screenshotDir` | `browser` | Screenshots and PDFs, relative to home. |
| `screenshotToModel` | `true` | Return screenshots to the model as images. |
| `imageMaxWidth` | `1280` | Widest image shown to the model (320-3840); the saved file keeps full size. |
| `downloadDir` | `browser/downloads` | Relative to home. |
| `downloadMaxMb` | `200` | Bigger downloads are discarded. |
| `uploadRoots` | | Directories besides home that uploads may come from, comma-separated. |
| `shareWithSubagents` | `true` | Helper chats share the parent chat's browser. |
| `allowHosts` | | If set, pages may only be opened on these hosts (`example.com` includes subdomains, `*.example.com` only subdomains). |
| `denyHosts` | | Hosts pages may never be opened on. |
| `blockPrivateNetworks` | `false` | Refuse every request, pages and sub-resources, to loopback and private addresses (checked after DNS). |
| `userAgent` | | Override the User-Agent. |

`allowHosts` and `denyHosts` judge page navigations (including frames and
popups); `blockPrivateNetworks` judges every request. A refusal names the rule
that refused it.

## Changes

- 0.2.0: renamed from `@bitmuse/browser` (the shipped tree is `@thetis` only).
  Adds `browser_upload`, `browser_drag`, `browser_downloads`, and screenshots
  returned to the model as images.
- 0.1.0: the fourteen tools, ported from the Rust Thetis.

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
concurrent calls, the host policy, uploads through an input and a chooser and
the paths they refuse, drag-and-drop and a slider, downloads with unsafe names
and a size cap, and the screenshot image asset and its scaling) plus a public
page when the network is there.

`npm run manifest` regenerates `thetis.tools` in `package.json` from
`scripts/manifest.mjs`, where the tool schemas live.

MIT.

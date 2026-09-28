// Writes package.json's thetis.tools from the definitions below. Run: node scripts/manifest.mjs
import { readFile, writeFile } from "node:fs/promises";

const TARGET = { type: "string", description: "The element: a ref like 'e7' from the latest snapshot (the reliable way), or a Playwright selector (CSS, 'text=Sign in', 'role=button[name=\"OK\"]')." };
const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}), additionalProperties: false });

const tools = [
  {
    name: "browser_navigate", export: "browserNavigate", reads: false,
    description: "Open a URL in this chat's headless browser (or go back, forward, reload) and get the page's accessibility snapshot: the tree of roles, names and `[ref=eN]` handles that every other browser_* tool addresses elements by. Normally the first browser call. A bare host like example.com means https. Each chat has its own cookies and storage; a helper chat shares its parent's by default. Reaches the network.",
    parameters: obj({
      url: { type: "string", description: "The URL to open. Required unless `action` is back, forward or reload." },
      action: { type: "string", enum: ["goto", "back", "forward", "reload"], description: "Defaults to goto, which needs `url`." },
      waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"], description: "When navigation counts as done. Default load; networkidle for a page that renders itself after load." },
    }),
  },
  {
    name: "browser_snapshot", export: "browserSnapshot", reads: true,
    description: "Re-read the current page as an accessibility snapshot with fresh `[ref=eN]` handles. Actions already return one, so use this when the page changed under you or your refs went stale (they do on every re-render). On a big page filter with `text` or `regex` instead of reading the whole tree.",
    parameters: obj({
      text: { type: "string", description: "Only lines containing this text, case-insensitive." },
      regex: { type: "string", description: "Only lines matching this regular expression (case-insensitive unless given as /re/flags)." },
      context: { type: "integer", description: "Lines of context around each match, like grep -C. Default 0." },
    }),
  },
  {
    name: "browser_click", export: "browserClick", reads: false,
    description: "Click an element on the current page, addressed by a `[ref=eN]` from the latest snapshot, a selector, or x/y viewport coordinates as a last resort. Returns the page after the click, so a navigation it caused is visible. Refs belong to the snapshot that produced them.",
    parameters: obj({
      target: { ...TARGET, description: `${TARGET.description} Omit only when giving x and y.` },
      x: { type: "number", description: "Viewport x, when there is no ref or selector." },
      y: { type: "number", description: "Viewport y, paired with x." },
      button: { type: "string", enum: ["left", "right", "middle"], description: "Default left." },
      doubleClick: { type: "boolean", description: "Double-click instead." },
      modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"] }, description: "Keys to hold during the click." },
    }),
  },
  {
    name: "browser_hover", export: "browserHover", reads: false,
    description: "Move the mouse over an element to bring out what only appears under the pointer (a menu, a tooltip, a row's buttons), then return the snapshot.",
    parameters: obj({
      target: { ...TARGET, description: `${TARGET.description} Omit only when giving x and y.` },
      x: { type: "number", description: "Viewport x." },
      y: { type: "number", description: "Viewport y, paired with x." },
    }),
  },
  {
    name: "browser_type", export: "browserType", reads: false,
    description: "Type into the page. `fill` (default) puts `text` into the field at `target`, replacing what was there; `press_key` sends one key or chord ('Enter', 'Tab', 'ArrowDown', 'Control+a') to `target` or the focused element; `fill_form` fills several fields in one call (much better than a call each); `select_option` picks `values` in a <select>. `submit` presses Enter after a fill. Returns the snapshot after.",
    parameters: obj({
      action: { type: "string", enum: ["fill", "press_key", "fill_form", "select_option"], description: "Default fill." },
      target: { ...TARGET, description: `${TARGET.description} Needed by fill and select_option.` },
      text: { type: "string", description: "The text, for fill." },
      key: { type: "string", description: "The key, for press_key." },
      fields: {
        type: "array", description: "For fill_form: the fields in order.",
        items: obj({
          target: { type: "string", description: "Ref or selector of the field." },
          value: { type: "string", description: "What to put in it; for a checkbox or radio, true or false." },
          type: { type: "string", enum: ["text", "checkbox", "radio", "select"], description: "Default text." },
        }, ["target", "value"]),
      },
      values: { type: "array", items: { type: "string" }, description: "For select_option: the option values or labels." },
      slowly: { type: "boolean", description: "Type key by key, firing the keystroke handlers an autocomplete needs." },
      submit: { type: "boolean", description: "Press Enter after filling." },
    }),
  },
  {
    name: "browser_wait", export: "browserWait", reads: true,
    description: "Wait until text appears or disappears, an element reaches a state, or loading finishes, then return the snapshot. The action tools already wait for the page to settle; use this for a spinner, a toast, a slow request. Prefer a condition over a fixed `time`.",
    parameters: obj({
      text: { type: "string", description: "Wait until this text is visible." },
      textGone: { type: "string", description: "Wait until this text is gone." },
      target: TARGET,
      state: { type: "string", enum: ["visible", "hidden", "attached", "detached"], description: "The state `target` must reach. Default visible." },
      loadState: { type: "string", enum: ["load", "domcontentloaded", "networkidle"], description: "Wait for this load state." },
      time: { type: "number", description: "Wait this many milliseconds, unconditionally." },
      timeout: { type: "integer", description: "Give up after this many milliseconds. Default the extension's timeoutMs (15000)." },
    }),
  },
  {
    name: "browser_evaluate", export: "browserEvaluate", reads: false,
    description: "Run JavaScript in the page and get its JSON return value: the escape hatch for what the accessibility tree does not show (computed styles, scroll position, app state on window, extracting a table). An expression ('document.title') or a function ('() => [...document.links].map(a => a.href)'); with `target` the element is the function's argument. Return plain data, not DOM nodes; the result is cut at 8000 chars. It can change the page.",
    parameters: obj({
      function: { type: "string", description: "The expression or (async) function source." },
      target: { ...TARGET, description: "Optional element passed to the function: a ref or a selector." },
    }, ["function"]),
  },
  {
    name: "browser_screenshot", export: "browserScreenshot", reads: false,
    description: "Save the page (or one element, or the full scrolling page) as a JPEG or PNG, or print it to PDF with action 'pdf'. The file is written under `browser/` in your home and only its path comes back; open it from Files. JPEG quality 60 by default; ask for png for exact pixels.",
    parameters: obj({
      action: { type: "string", enum: ["pdf"], description: "Print to PDF instead of an image." },
      target: { ...TARGET, description: "Capture only this element." },
      fullPage: { type: "boolean", description: "The whole scrollable page, not the viewport." },
      type: { type: "string", enum: ["png", "jpeg"], description: "Default jpeg, or png when filename ends in .png." },
      quality: { type: "integer", description: "JPEG quality 1-100. Default 60." },
      filename: { type: "string", description: "The file's name. Default a timestamp." },
      format: { type: "string", description: "PDF paper size, e.g. A4. Default Letter." },
    }),
  },
  {
    name: "browser_console", export: "browserConsole", reads: true,
    description: "Read the console messages and uncaught page errors since the last navigation, most recent last. The first place to look when a page is blank or broken.",
    parameters: obj({
      level: { type: "string", enum: ["debug", "log", "info", "warning", "error"], description: "This level or more severe. Default info." },
      limit: { type: "integer", description: "How many. Default 100 of the last 500 kept." },
    }),
  },
  {
    name: "browser_network", export: "browserNetwork", reads: true,
    description: "List the requests the page made since the last navigation, numbered, with method, status and URL; `failedOnly` for the 4xx/5xx and connection failures, `filter` by URL regex, `index` for one request in full. Also lists requests this extension's host settings blocked.",
    parameters: obj({
      index: { type: "integer", description: "One request in full, numbered as in the list (from 1)." },
      filter: { type: "string", description: "Only URLs or statuses matching this regex, case-insensitive." },
      failedOnly: { type: "boolean", description: "Only failures and status 400 and above." },
    }),
  },
  {
    name: "browser_tabs", export: "browserTabs", reads: false,
    description: "List this chat's tabs (the active one marked *), or open, switch to or close one. Every other browser tool acts on the active tab. A link that opens a new tab shows up here.",
    parameters: obj({
      action: { type: "string", enum: ["list", "new", "select", "close"], description: "Default list." },
      index: { type: "integer", description: "The tab, zero-based. Needed by select; close defaults to the active tab." },
      url: { type: "string", description: "For new: open this URL in it." },
    }),
  },
  {
    name: "browser_state", export: "browserState", reads: false,
    description: "Read or change the browser's own state rather than the page's: cookies, localStorage, sessionStorage, the whole storageState, dialogs, and the viewport size. Dialogs (alert, confirm, prompt) are dismissed automatically; to accept one, call kind 'dialog' action 'accept' BEFORE the click that opens it. Resize with kind 'viewport' to check a responsive layout.",
    parameters: obj({
      kind: { type: "string", enum: ["cookies", "localStorage", "sessionStorage", "storageState", "dialog", "viewport"], description: "Default cookies." },
      action: { type: "string", enum: ["list", "get", "set", "delete", "clear", "accept", "dismiss"], description: "Default list. accept and dismiss are for dialog." },
      name: { type: "string", description: "The cookie name or storage key." },
      value: { type: "string", description: "The value, for set." },
      domain: { type: "string", description: "Cookie domain for set. Default the page's host." },
      path: { type: "string", description: "Cookie path for set. Default /." },
      promptText: { type: "string", description: "What to answer a window.prompt with, when accepting." },
      width: { type: "integer", description: "Viewport width, for kind viewport." },
      height: { type: "integer", description: "Viewport height, for kind viewport." },
    }),
  },
  {
    name: "browser_close", export: "browserClose", reads: false,
    description: "Close this chat's browser, discarding its tabs, cookies and storage. Rarely needed (idle browsers close themselves); use it to start a login from a clean state or to recover from a wedged page.",
    parameters: obj({}),
  },
  {
    name: "browser_status", export: "browserStatus", reads: true,
    description: "Show whether the headless browser is running, which Chrome and Playwright it uses, this chat's tabs, and the settings in force. Starts nothing; 'not running' before the first navigation is normal.",
    parameters: obj({}),
  },
];

const path = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(await readFile(path, "utf8"));
pkg.thetis.tools = tools;
await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`wrote ${tools.length} tools`);

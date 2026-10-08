// The Chromium harness for @thetis/sheets: the real gateway-web page and assets, the package's real manifest
// declared through `api/ui`, its real browser modules served under `ext/@thetis/sheets/…`, and every verb
// answered by the package's own exports (index.js: uiList, uiGet, uiSave, uiCreate, uiRemove, uiAssign,
// uiExport, uiImport, uiWatch) over a temporary home — the same files a fence would hold — so a case needs no
// daemon, no fence and no model. The `watch` stream is the real generator, its items handed to the page's
// EventSource; an agent's write is the real `sheet_write` tool with an agent session, so the page sees it
// exactly as it would see Thetis. The shape follows ../../ui-workspace/test/fixtures/browser-fixture.mjs
// (`withPage`, the EventSource stub, the artifacts on failure).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pkg from "../../index.js";

const PKG = fileURLToPath(new URL("../../", import.meta.url));
const UI = join(PKG, "ui");
const ASSETS = fileURLToPath(new URL("../../../gateway-web/assets/", import.meta.url));
const ORIGIN = "http://thetis-browser.test";
export const NAME = "@thetis/sheets";
export const USER = "rae";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".md": "text/markdown" };
const manifest = JSON.parse(await readFile(join(PKG, "package.json"), "utf8"));
const EXPORTS = Object.fromEntries(manifest.thetis.ui.commands.map((c) => [c.verb, c.export]));
export const PROJECTS = [{ id: "p_0000aaaa", name: "Nova" }];

/** A fence environment over a temporary home, as the gateway hands a command (`env.cwd`, readFile, writeFile, session). */
export async function makeHome({ session = "s_aaaa" } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), "sheets-browser-"));
  const env = {
    cwd: home,
    root: home,
    store: home,
    shared: null,
    user: USER,
    role: "admin",
    session: { id: session, user: USER },
    config: {},
    readFile: (p) => readFile(resolve(home, p), "utf8"),
    writeFile: async (p, content) => {
      const file = resolve(home, p);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    kernel: { packages: { list: async () => [] } },
  };
  for (const p of PROJECTS) await env.writeFile(`projects/${p.id}.json`, JSON.stringify({ id: p.id, name: p.name, directories: [], createdAt: "", updatedAt: "" }));
  return { home, env, done: () => rm(home, { recursive: true, force: true }) };
}

/** The `api/ui` extension record, from the package's real manifest, as gateway-web composes it for a role. */
export function declaration(role) {
  const ui = manifest.thetis.ui;
  const clears = (r) => !r || r === role || (r === "member" && role === "admin");
  return {
    package: NAME,
    version: manifest.version,
    base: `ext/${NAME}/`,
    entry: ui.entry,
    style: ui.style,
    commands: ui.commands.filter((c) => clears(c.role) && !c.stream && c.kind !== "raw").map((c) => c.verb),
    streams: ui.commands.filter((c) => clears(c.role) && c.stream).map((c) => c.verb),
    raw: ui.commands.filter((c) => clears(c.role) && c.kind === "raw").map((c) => c.verb),
    frames: [],
    dock: [],
    panel: [],
    places: [],
    sidebar: (ui.sidebar ?? []).filter((e) => clears(e.role)),
    tabs: (ui.tabs ?? []).filter((e) => clears(e.role)),
    chips: [],
    composer: [],
    shelf: [],
    statusbar: [],
    hidden: [],
  };
}

/** Polls `fn` (sync or async) until it answers truthy; a wait on a condition, never a fixed sleep. */
export async function until(fn, what = "the condition", { timeout = 5000, step = 25 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const out = await fn();
    if (out) return out;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, step));
  }
}

/**
 * Opens the page in a fresh context over a fresh home, wires every route, and runs `run(f)`. `options`:
 * `role`, `viewport`, `colorScheme` ("light" | "dark"), `seed(f)` (writes sheets before the page loads),
 * `localStorage`. Every error the page or the routes report fails the case; a failed case leaves a
 * screenshot and a trace under `THETIS_BROWSER_ARTIFACTS` (default: a temp dir).
 */
export async function withPage(browser, name, options, run) {
  const { role = "admin", viewport = { width: 1300, height: 860 }, colorScheme = "light" } = options;
  const { home, env, done } = await makeHome();
  const context = await browser.newContext({ viewport, colorScheme, acceptDownloads: true });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console.error: ${message.text()}`); });
  const id = "s_aaaa";
  const session = { id, title: "Browser regression", named: true, turns: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const conversation = [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier reply" }];
  const calls = []; // every JSON command: { verb, args }
  const raw = []; // every raw route hit: { method, verb, args, status }
  const overrides = new Map(); // verb -> handler(args, { env, next })

  // ---- the watch stream: the package's real generator, its items handed to the page ----
  let watch = null; // { ctl, running }
  async function pump() {
    if (watch) return;
    const ctl = new AbortController();
    watch = { ctl };
    try {
      for await (const item of pkg.uiWatch({}, { ...env, signal: ctl.signal })) {
        if (ctl.signal.aborted) break;
        if (item?.ev === "ping") continue;
        await page.evaluate((v) => window.sheetsEmit?.(v), item).catch(() => {});
      }
    } catch (err) {
      if (!ctl.signal.aborted) errors.push(`watch: ${err.message}`);
    }
  }
  await page.exposeBinding("__sheetsWatchOpened", () => { void pump(); });

  if (options.localStorage) await page.addInitScript((entries) => { for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v); }, options.localStorage);
  await page.addInitScript(() => {
    window.__sheetsSources = [];
    window.EventSource = class extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      constructor(url) {
        super();
        this.url = String(url);
        if (this.url.includes("/watch/stream")) {
          window.__sheetsSources.push(this);
          window.__sheetsWatchOpened?.();
        } else window.reviewEvents = this;
      }
      close() { this.readyState = 2; }
    };
    window.reviewEmit = (kind, value) => window.reviewEvents.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(value) }));
    window.sheetsEmit = (value) => {
      for (const s of window.__sheetsSources) if (s.readyState !== 2) s.dispatchEvent(new MessageEvent("item", { data: JSON.stringify(value) }));
    };
  });

  async function command(verb, args) {
    const fn = pkg[EXPORTS[verb]];
    if (typeof fn !== "function") throw new Error(`${NAME} has no export for "${verb}"`);
    const next = async () => (await fn(args ?? {}, env)) ?? {};
    const override = overrides.get(verb);
    return override ? override(args ?? {}, { env, next }) : next();
  }

  await page.route(`${ORIGIN}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname.includes("/api/")) {
        const api = pathname.split("/api/")[1];
        const method = route.request().method();
        if (api === "me") return route.fulfill({ json: { user: USER, role, agent: { name: "Thetis", avatar: null } } });
        if (api === "agent") return route.fulfill({ json: { name: "Thetis", avatar: null } });
        if (api === "models") return route.fulfill({ json: { model: "echo", models: [{ id: "echo", name: "Echo" }] } });
        if (api === "restart" && method === "GET") return route.fulfill({ json: { pending: null } });
        if (api === "ui") return route.fulfill({ json: { extensions: [declaration(role)], refused: [] } });
        if (api === "sessions" && method === "GET") return route.fulfill({ json: [session] });
        if (api === `sessions/${id}`) return route.fulfill({ json: { ...session, conversation, children: [], usage: {}, turn: null } });
        if (api.startsWith(`ext/${NAME}/`)) {
          const rest = api.slice(`ext/${NAME}/`.length);
          if (rest.endsWith("/raw")) {
            const verb = rest.slice(0, -"/raw".length);
            const args = JSON.parse(url.searchParams.get("args") || "{}");
            const hit = { method, verb, args, status: 200 };
            raw.push(hit);
            const fn = pkg[EXPORTS[verb]];
            try {
              if (method === "PUT") {
                const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
                return route.fulfill({ json: { data: await fn(args, env, { method, body }) } });
              }
              const answer = await fn(args, env, { method });
              hit.headers = answer.headers;
              return route.fulfill({ status: answer.status ?? 200, headers: { ...answer.headers, "cache-control": "no-store" }, body: answer.body });
            } catch (err) {
              hit.status = 400;
              return route.fulfill({ status: 400, json: { error: err?.message || String(err) } });
            }
          }
          const verb = rest;
          const body = route.request().postDataJSON() ?? {};
          calls.push({ verb, args: body.args ?? {} });
          try {
            const out = await command(verb, body.args);
            return route.fulfill({ json: typeof out === "string" ? { text: out } : out });
          } catch (err) {
            return route.fulfill({ status: Number(err?.status) || 400, json: { error: err?.message || String(err) } });
          }
        }
        throw new Error(`Unexpected API: ${method} ${api}`);
      }
      if (pathname.includes(`/ext/${NAME}/`)) {
        const rel = normalize(decodeURIComponent(pathname.split(`/ext/${NAME}/`)[1])).replace(/^(\.\.[/\\])+/, "");
        const body = await readFile(join(UI, rel));
        return route.fulfill({ body, contentType: TYPES[extname(rel)] || "application/octet-stream" });
      }
      const file = pathname.includes("/assets/") ? pathname.split("/assets/")[1] : "index.html";
      let body = await readFile(join(ASSETS, file));
      if (file === "index.html") body = Buffer.from(body.toString().replace("{{base}}", "/review").replace("{{nonce}}", "test").replaceAll("{{agentName}}", "Thetis").replace("{{favicon}}", "assets/favicon.svg"));
      await route.fulfill({ body, contentType: TYPES[extname(file)] || "application/octet-stream" });
    } catch (error) {
      errors.push(`route: ${error.message}`);
      await route.fulfill({ status: 500, json: { error: error.message } }).catch(() => {});
    }
  });

  const f = {
    page, env, home, errors, calls, raw, role,
    callsFor: (verb) => calls.filter((c) => c.verb === verb),
    /** Overrides one command; `handler(args, { env, next })`; pass null to restore the package's own. */
    on: (verb, handler) => (handler ? overrides.set(verb, handler) : overrides.delete(verb)),
    until,
    /** Runs the package's own export as the person would through the gateway. */
    command: (verb, args) => command(verb, args),
    /** A sheet made through `create`, then filled with `rows` from A1 through the real `sheet_write` tool. */
    async seed(title, rows) {
      const { data } = await pkg.uiCreate({ title }, env);
      if (rows) await pkg.sheetWrite({ sheet: data.sheet.id, at: "A1", rows }, env);
      return data.sheet.id;
    },
    /** A write by the agent, through the tool the agent calls, in another conversation. */
    agentWrite: (args) => pkg.sheetWrite(args, { ...env, session: { id: "s_agent", user: USER } }),
    agentFormat: (args) => pkg.sheetFormat(args, { ...env, session: { id: "s_agent", user: USER } }),
    /** The workbook as it is on disk now. */
    async disk(sheetId) {
      return JSON.parse(await readFile(join(home, "sheets", sheetId, "sheet.json"), "utf8"));
    },
    /** Opens a sheet's tab from its sidebar row and waits for the grid. */
    async open(sheetId) {
      const row = page.locator(`.sht-row[data-sheet="${sheetId}"] .sht-row-open`);
      await row.waitFor();
      await row.click();
      await page.locator(`.sht-tab[data-sheet="${sheetId}"] .sht-grid`).waitFor();
      await page.locator(`.sht-tab[data-sheet="${sheetId}"] .sht-head.is-col`).first().waitFor();
    },
    /** The cell node for an address in the open tab (a cell with nothing in it has none). */
    cell: (a) => page.locator(`.sht-tab .sht-cell[data-addr="${a}"]`),
    async text(a) {
      const n = f.cell(a);
      return (await n.count()) ? n.first().innerText() : "";
    },
    /** The middle of a cell on screen, from the grid's geometry, for clicks on cells that are empty. */
    async point(a) {
      return page.evaluate((a) => {
        const m = /^([A-Z]+)(\d+)$/.exec(a);
        let col = 0;
        for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
        col -= 1;
        const row = Number(m[2]) - 1;
        const scroller = document.querySelector(".sht-tab .sht-scroller");
        const rect = scroller.getBoundingClientRect();
        const heads = [...document.querySelectorAll(".sht-tab .sht-top > .sht-heads > .sht-head.is-col, .sht-tab .sht-corner .sht-head.is-col")];
        const colHead = heads.find((h) => h.textContent === m[1]);
        const rows = [...document.querySelectorAll(".sht-tab .sht-head.is-row")];
        const rowHead = rows.find((h) => h.textContent === String(row + 1));
        if (!colHead || !rowHead) return null;
        const c = colHead.getBoundingClientRect();
        const r = rowHead.getBoundingClientRect();
        return { x: c.left + c.width / 2, y: r.top + r.height / 2, inside: c.left >= rect.left && r.top >= rect.top };
      }, a);
    },
    async clickCell(a, opts = {}) {
      const p = await f.point(a);
      assert.ok(p, `cell ${a} is on screen`);
      const { modifiers = [], ...rest } = opts;
      for (const m of modifiers) await page.keyboard.down(m);
      await page.mouse.click(p.x, p.y, rest);
      for (const m of modifiers) await page.keyboard.up(m);
    },
    menuItem: (label) => page.locator(".menu.is-floating .menu-item", { has: page.locator(".menu-label", { hasText: label }) }),
    async menuLabels() {
      await page.locator(".menu.is-floating").waitFor();
      return page.locator(".menu.is-floating .menu-item .menu-label").allInnerTexts();
    },
    /** The address box and the formula bar. */
    addr: () => page.locator(".sht-tab .sht-addr"),
    bar: () => page.locator(".sht-tab .sht-fx-input"),
    /** Waits until no save is queued or out, so the disk holds what the page shows. */
    async saved() {
      await until(async () => (await page.locator(".sht-tab .sht-save").innerText()) === "Saved", "the page to finish saving");
    },
  };

  try {
    if (options.seed) await options.seed(f);
    await page.goto(`${ORIGIN}/review/#${id}`);
    await page.waitForFunction(() => window.reviewEvents);
    await page.evaluate(() => { reviewEmit("open", {}); reviewEmit("snapshot", { running: [] }); });
    await page.locator(`.pane[data-session="${id}"]`).waitFor();
    await page.locator(".sht-list").waitFor();
    await run(f);
    assert.deepEqual(errors, [], "the browser and the fixture should report no errors");
    await context.tracing.stop();
  } catch (error) {
    const root = process.env.THETIS_BROWSER_ARTIFACTS || await mkdtemp(join(tmpdir(), "thetis-sheets-browser-"));
    await mkdir(root, { recursive: true });
    const artifact = join(root, name);
    await page.screenshot({ path: `${artifact}.png`, fullPage: true }).catch(() => {});
    await context.tracing.stop({ path: `${artifact}.zip` }).catch(() => {});
    console.error(`Browser failure artifacts: ${artifact}.{png,zip}`);
    if (errors.length) console.error(`Page errors: ${JSON.stringify(errors, null, 2)}`);
    throw error;
  } finally {
    watch?.ctl.abort();
    await context.close();
    await done();
  }
}

/** Launches the Chromium the environment names, as gateway-web's suite does. */
export async function launch() {
  const { chromium } = await import(process.env.THETIS_PLAYWRIGHT_MODULE || "playwright-core");
  return chromium.launch({ executablePath: process.env.THETIS_CHROMIUM_EXECUTABLE || undefined, headless: true, args: ["--no-sandbox"] });
}

// Optional Chromium check of the pill over the real gateway page, the way packages/gateway-web/test/
// browser-regressions.mjs does it: every asset comes from disk through Playwright's router, every API
// answer is the fixture's, and no daemon or provider is touched. It is not part of `npm test`. Run it with
// THETIS_PLAYWRIGHT_MODULE and THETIS_CHROMIUM_EXECUTABLE set, as BROWSER.md there describes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = fileURLToPath(new URL("../../gateway-web/assets/", import.meta.url));
const UI = fileURLToPath(new URL("../ui/", import.meta.url));
const ORIGIN = "http://thetis-effort.test";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

let browser;
before(async () => {
  const { chromium } = await import(process.env.THETIS_PLAYWRIGHT_MODULE || "playwright-core");
  browser = await chromium.launch({ executablePath: process.env.THETIS_CHROMIUM_EXECUTABLE || undefined });
});
after(async () => { await browser?.close(); });

const MODELS = { model: "vendor/thinker", models: [{ id: "vendor/thinker", name: "Thinker" }, { id: "vendor/forced", name: "Forced" }, { id: "vendor/plain", name: "Plain" }] };
const REASONING = {
  "vendor/thinker": { mandatory: false, defaultEffort: "medium", supportedEfforts: ["high", "medium", "low"] },
  "vendor/forced": { mandatory: true, supportedEfforts: ["max", "high", "low"], defaultEffort: "max" },
};

test("the pill shows for a thinking model, lists what it accepts, records a choice, and hides for a plain model", async () => {
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const sessions = [
    { id: "s_think", title: "Thinks", named: true, turns: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:03Z" },
    { id: "s_forced", title: "Forced", named: true, turns: 1, model: "vendor/forced", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:02Z" },
    { id: "s_plain", title: "Plain", named: true, turns: 1, model: "vendor/plain", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" },
  ];
  const state = {}; // session -> effort, what effort-set wrote
  const sets = [];
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      constructor() { super(); window.reviewEvents = this; }
      close() { this.readyState = 2; }
    };
    window.reviewEmit = (kind, value) => window.reviewEvents.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(value) }));
  });
  await page.route(`${ORIGIN}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname.includes("/ext/@thetis/harness-core/") && !pathname.includes("/api/")) {
        const file = pathname.split("/ext/@thetis/harness-core/")[1];
        return route.fulfill({ body: await readFile(join(UI, file)), contentType: TYPES[extname(file)] });
      }
      if (pathname.includes("/api/ext/@thetis/harness-core/")) {
        const verb = pathname.split("/api/ext/@thetis/harness-core/")[1];
        const body = route.request().postDataJSON() ?? {};
        if (verb === "effort-models") return route.fulfill({ json: { data: { model: MODELS.model, reasoning: REASONING } } });
        if (verb === "effort-state") return route.fulfill({ json: { data: { session: body.session, effort: state[body.session] ?? null, remembered: null, effective: state[body.session] ?? null } } });
        if (verb === "effort-set") {
          sets.push(body);
          if (body.args.effort) state[body.session] = body.args.effort; else delete state[body.session];
          return route.fulfill({ json: { data: { session: body.session, effort: state[body.session] ?? null, remembered: null } } });
        }
      }
      if (pathname.includes("/api/")) {
        const api = pathname.split("/api/")[1];
        if (api === "me") return route.fulfill({ json: { user: "review", role: "admin" } });
        if (api === "restart") return route.fulfill({ json: { pending: null, readable: true } });
        if (api === "models") return route.fulfill({ json: MODELS });
        if (api === "ui") return route.fulfill({ json: { extensions: [{ package: "@thetis/harness-core", entry: "index.js", style: "index.css", composer: [{ id: "effort", label: "Effort", order: 110 }], commands: ["retry-now", "effort-state", "effort-set", "effort-models"] }], refused: [] } });
        if (api === "sessions") return route.fulfill({ json: sessions });
        const one = sessions.find((s) => api === `sessions/${s.id}`);
        if (one) return route.fulfill({ json: { ...one, conversation: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }], children: [], usage: {}, turn: null } });
        throw new Error(`Unexpected API: ${route.request().method()} ${api}`);
      }
      const file = pathname.includes("/assets/") ? pathname.split("/assets/")[1] : "index.html";
      let body = await readFile(join(ASSETS, file));
      if (file === "index.html") body = Buffer.from(body.toString().replace("{{base}}", "/review").replace("{{nonce}}", "test"));
      await route.fulfill({ body, contentType: TYPES[extname(file)] || "application/octet-stream" });
    } catch (error) {
      errors.push(error.message);
      await route.fulfill({ status: 500, json: { error: error.message } }).catch(() => {});
    }
  });
  try {
    await page.goto(`${ORIGIN}/review/#s_think`);
    await page.waitForFunction(() => window.reviewEvents);
    await page.evaluate(() => { reviewEmit("open", {}); reviewEmit("snapshot", { running: [] }); });
    // A sidebar row's click, by title: what a person does to change conversation.
    const open = (id) => page.locator(".session-open", { hasText: sessions.find((s) => s.id === id).title }).first().click();

    // The default model thinks: the pill shows with the model's default effort as its label.
    const pill = page.locator(".ef-pill");
    await pill.waitFor({ state: "visible" });
    assert.equal(await page.locator(".ef-label").innerText(), "Medium · default");
    // It sits in the composer's tools row, beside the model picker.
    assert.equal(await page.locator("#composer-tools .picker").count(), 1);
    assert.equal(await page.locator("#composer-tools .ef-pill").count(), 1);

    // Open: Default plus the three the model accepts, plus Off, because thinking is not mandatory here.
    await page.locator(".ef-btn").click();
    if (process.env.THETIS_BROWSER_ARTIFACTS) await page.screenshot({ path: join(process.env.THETIS_BROWSER_ARTIFACTS, "effort-open.png"), clip: { x: 0, y: 500, width: 1300, height: 400 } });
    const labels = await page.locator(".ef-item .ef-item-label").allInnerTexts();
    assert.deepEqual(labels, ["Default", "High", "Medium", "Low", "Off"]);

    // Choose Low: effort-set is sent for this conversation, and the label follows.
    await page.locator('.ef-item[data-effort="low"]').click();
    await page.waitForFunction(() => document.querySelector(".ef-label")?.textContent === "Low");
    assert.deepEqual(sets.at(-1), { session: "s_think", args: { session: "s_think", effort: "low" } });
    assert.equal(await page.locator(".ef-menu").count(), 0, "the list closed on the pick");

    // A mandatory model: no Off, and its own allowlist.
    await open("s_forced");
    await page.waitForFunction(() => document.querySelector(".ef-label")?.textContent === "Max · default");
    await page.locator(".ef-btn").click();
    assert.deepEqual(await page.locator(".ef-item .ef-item-label").allInnerTexts(), ["Default", "Max", "High", "Low"]);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".ef-menu").count(), 0);

    // A plain model: the pill is hidden, the model picker still there.
    await open("s_plain");
    await page.waitForFunction(() => document.querySelector(".ef-pill")?.hasAttribute("hidden"));
    assert.equal(await page.locator("#composer-tools .picker").isVisible(), true);

    // Back to the first: the choice is remembered on the page, no refetch of the model list.
    await open("s_think");
    await page.waitForFunction(() => document.querySelector(".ef-label")?.textContent === "Low");
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: "/tmp/effort-browser.png", fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
});

// Optional Chromium check of the store, an extension's page and the "Updates ready" card over the real gateway
// page, the way packages/effort/test/browser.mjs does it: every asset comes from disk through Playwright's
// router, every API answer is this file's, and no daemon or provider is touched. It is not part of `npm test`.
// Run it with THETIS_PLAYWRIGHT_MODULE and THETIS_CHROMIUM_EXECUTABLE set, as gateway-web's BROWSER.md
// describes; THETIS_BROWSER_ARTIFACTS names a directory for screenshots.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeRows } from "../lib/rows.js";

const ASSETS = fileURLToPath(new URL("../../gateway-web/assets/", import.meta.url));
const UI = fileURLToPath(new URL("../ui/", import.meta.url));
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const NAME = "@thetis/ui-marketplace";
const ORIGIN = "http://thetis-market.test";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const shots = process.env.THETIS_BROWSER_ARTIFACTS;

let browser;
before(async () => {
  const { chromium } = await import(process.env.THETIS_PLAYWRIGHT_MODULE || "playwright-core");
  browser = await chromium.launch({ executablePath: process.env.THETIS_CHROMIUM_EXECUTABLE || undefined });
});
after(async () => {
  await browser?.close();
});

const REPO = "https://github.com/thetis-agent/packages.git";
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const sys = (name, type, extra = {}) => ({ name, version: "0.1.0", type, description: `${name.slice(8)} does its job.`, root: ROOT, thetis: { type }, source: { kind: "system", ref: "/sys" }, everyone: true, everyoneBy: "config", loadedVersion: "0.1.0", ...extra });
const installed = [
  sys("@thetis/gateway-web", "gateway", { version: "0.13.1", loadedVersion: "0.13.0", thetis: { type: "gateway", label: "web gateway", ui: { places: [{ id: "x" }] } } }),
  sys("@thetis/terminal", "tool", { description: "Long-lived shell sessions in your own space.", thetis: { type: "tool", tools: ["shell", "shell_read", "shell_send"].map((name) => ({ name, description: `${name} does one thing. And more.` })) } }),
  { ...sys("@thetis/exa", "tool", { everyone: false, everyoneBy: undefined }), description: "Web search and page contents.", source: { kind: "git", ref: `${REPO}#exa@${OLD}` }, thetis: { type: "tool", tools: [{ name: "web_search", description: "Search the web. Returns links." }] } },
];
const catalog = [sys("@thetis/store-toml", "storage", { everyone: false, everyoneBy: undefined }), sys("@thetis/skills-orleans", "skill", { everyone: false, everyoneBy: undefined })];
const index = { version: 1, updatedAt: "2026-09-27T00:00:00.000Z", registries: [{ name: "thetis", url: REPO }], packages: [{ name: "@thetis/exa", version: "0.2.0", type: "tool", description: "Web search.", keywords: [], registry: "thetis", url: REPO, dir: "exa", commit: NEW, source: `${REPO}#exa@${NEW}`, steps: [], tools: ["web_search"], service: false }] };
const rows = mergeRows(installed, index.packages, index, { catalog, user: "rae" });
const UPDATES = {
  items: [
    { name: "@thetis/gateway-web", label: "web gateway", from: "0.13.0", to: "0.13.1", apply: "apply" },
    { name: "@thetis/exa", label: "exa", from: "0.1.0", to: "0.2.0", apply: "install" },
  ],
  own: [],
  forks: [],
  shells: 0,
  applyOwnChanges: "auto",
};

function declaration() {
  const ui = manifest.thetis.ui;
  return { package: NAME, version: manifest.version, base: `ext/${NAME}/`, entry: ui.entry, style: ui.style, commands: ui.commands.map((c) => c.verb), streams: [], raw: [], dock: [], panel: [], places: ui.places, sidebar: [], chips: [], composer: [], shelf: [], statusbar: [], hidden: [] };
}

test("the card, the store and an extension's page, and Update all through a drop and a refresh", async () => {
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  const sent = [];
  let updates = UPDATES;
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.esCount = 0;
    window.EventSource = class extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      constructor() {
        super();
        window.esCount += 1;
        window.reviewEvents = this;
      }
      close() {
        this.readyState = 2;
      }
    };
    window.reviewEmit = (kind, value) => window.reviewEvents.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(value) }));
  });
  await page.route(`${ORIGIN}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname.includes(`/ext/${NAME}/`) && !pathname.includes("/api/")) {
        const file = pathname.split(`/ext/${NAME}/`)[1];
        return route.fulfill({ body: await readFile(join(UI, file)), contentType: TYPES[extname(file)] });
      }
      if (pathname.includes(`/api/ext/${NAME}/`)) {
        const verb = pathname.split(`/api/ext/${NAME}/`)[1];
        const body = route.request().postDataJSON() ?? {};
        sent.push([verb, body.args ?? {}]);
        if (verb === "updates") return route.fulfill({ json: { data: updates } });
        if (verb === "search") return route.fulfill({ json: { data: { updatedAt: index.updatedAt, registries: index.registries, total: 1, indexed: true, rows, user: "rae", role: "user" } } });
        if (verb === "config-list") return route.fulfill({ json: { data: [] } });
        if (verb === "config-show") return route.fulfill({ json: { data: { package: body.args.name, inherits: [], keys: [{ key: "apiKey", state: "missing", secret: true, declared: true }], summary: "apiKey is missing", broken: true } } });
        if (verb === "publish-targets") return route.fulfill({ json: { data: { available: false, targets: [] } } });
        if (verb === "show") return route.fulfill({ json: { data: { updatedAt: index.updatedAt, registries: index.registries, total: 1, indexed: true, row: rows.find((r) => r.name === body.args.name), readme: "### Exa\n\nThe README.", assets: {}, user: "rae", role: "user" } } });
        if (verb === "update") return route.fulfill({ json: { data: { name: body.args.name } } });
        if (verb === "fence-reload") return route.fulfill({ json: { data: { user: "rae", services: [] } } });
        throw new Error(`Unexpected verb: ${verb}`);
      }
      if (pathname.includes("/api/")) {
        const api = pathname.split("/api/")[1];
        if (api === "me") return route.fulfill({ json: { user: "rae", role: "user" } });
        if (api === "models") return route.fulfill({ json: { model: "m", models: [{ id: "m", name: "M" }] } });
        if (api === "ui") return route.fulfill({ json: { extensions: [declaration()], refused: [] } });
        if (api === "sessions") return route.fulfill({ json: [] });
        return route.fulfill({ json: {} });
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
  const online = async () => {
    await page.waitForFunction(() => window.reviewEvents);
    await page.evaluate(() => {
      reviewEmit("open", {});
      reviewEmit("snapshot", { running: [] });
    });
  };
  try {
    await page.goto(`${ORIGIN}/review/`);
    await online();

    // The card, from nothing but the page opening: no place was opened.
    const card = page.locator(`[data-notice="${NAME}:updates"]`);
    await card.waitFor();
    assert.equal(await card.locator(".notice-title").innerText(), "Updates ready");
    assert.equal(await card.locator(".notice-body").innerText(), "Updates for 2 extensions: web gateway and exa.");
    if (shots) await page.screenshot({ path: join(shots, "market-card.png") });

    // Review opens the store at its Updates section.
    await card.locator(".notice-action", { hasText: "Review" }).click();
    await page.locator("#place .mk-store #mk-updates").waitFor();
    const titles = await page.locator("#place .mk-section-title").allInnerTexts();
    assert.deepEqual(titles, ["Updates (2)", "Installed (2)", "Discover (1)"], "the gateway and the storage driver are system components, hidden by default");
    assert.equal(await page.locator("#place .mk-toolbar-system").isHidden(), true, "the type chips wait behind the toggle");
    if (shots) await page.screenshot({ path: join(shots, "market-store.png") });
    await page.locator("#place .mk-system-toggle").click();
    await page.waitForFunction(() => document.querySelector("#place .mk-section-title:nth-child(1)") && [...document.querySelectorAll("#place .mk-section-title")].map((n) => n.textContent).join("|") === "Updates (2)|Installed (3)|Discover (2)");
    assert.equal(await page.locator("#place .mk-toolbar-system").isVisible(), true);
    await page.locator("#place .mk-system-toggle").click();

    // An extension's page: what it is, what you get, what it needs, and Update at the top.
    await page.locator('#place #mk-installed .mk-card[data-name="@thetis/exa"]').click();
    await page.locator("#place .mk-hero .mk-title").waitFor();
    assert.equal(await page.locator("#place .mk-title").innerText(), "exa");
    assert.equal(await page.locator("#place .mk-gets").innerText(), "What you get: 1 tool");
    assert.equal(await page.locator("#place .mk-setup").isVisible(), true);
    assert.equal(await page.locator("#place .mk-actions .btn").first().innerText(), "Update");
    assert.deepEqual(await page.locator("#place .mk-tab").allInnerTexts(), ["Overview", "Technical details"]);
    assert.equal(await page.locator("#place .mk-readme").count(), 0, "the README waits under Technical details");
    const pageText = await page.locator("#place .mk-hero").innerText();
    assert.doesNotMatch(pageText, /workspace|reload|fence|1111111|2222222/i, "no mechanism words and no commit on the top of the page");
    if (shots) await page.screenshot({ path: join(shots, "market-page.png") });
    await page.locator("#place .mk-tab", { hasText: "Technical details" }).click();
    await page.locator("#place .mk-readme").waitFor();
    assert.match(await page.locator("#place .mk-technical .kv").innerText(), /1111111 → 2222222/, "the commit pair lives here");

    // Update all: the fetch, one drained apply, the space going away and coming back, and the refresh.
    const before = await page.evaluate(() => window.esCount);
    await card.locator(".notice-action", { hasText: "Update all" }).click();
    await page.waitForFunction(() => document.querySelector(`[data-notice$=":updates"] .notice-title`)?.textContent === "Updating");
    await page.waitForTimeout(100);
    assert.deepEqual(sent.filter(([v]) => v === "update" || v === "fence-reload"), [["update", { name: "@thetis/exa" }], ["fence-reload", { drain: true }]]);
    updates = { ...UPDATES, items: [] };
    await page.evaluate(() => window.reviewEvents.dispatchEvent(new Event("error")));
    await page.waitForFunction((n) => window.esCount > n, before, { timeout: 10000 });
    const reloaded = page.waitForEvent("load");
    await page.evaluate(() => reviewEmit("open", {}));
    await reloaded;
    await online();
    await page.locator(".toast", { hasText: "Updated: web gateway and exa." }).waitFor();
    assert.equal(await page.locator(`[data-notice="${NAME}:updates"]`).count(), 0, "nothing left to update, so no card");
    if (shots) await page.screenshot({ path: join(shots, "market-after.png") });
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: "/tmp/market-browser.png", fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
});

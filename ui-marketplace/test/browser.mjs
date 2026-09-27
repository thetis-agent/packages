// Optional Chromium check of the Extensions place, an extension's page and the "Updates ready" card over the real gateway
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
import { installedRow, mergeRows, withFolder } from "../lib/rows.js";

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
const EXA_KEY = { apiKey: { type: "string", secret: true, required: true, help: "The Exa API key; put it in .env as EXA_API_KEY and reference it, since a tool call without one fails." } };
const installed = [
  sys("@thetis/gateway-web", "gateway", { version: "0.13.1", loadedVersion: "0.13.0", thetis: { type: "gateway", label: "web gateway", ui: { places: [{ id: "x" }] } } }),
  sys("@thetis/terminal", "tool", { description: "Long-lived shell sessions in your own space.", thetis: { type: "tool", tools: ["shell", "shell_read", "shell_send"].map((name) => ({ name, description: `${name} does one thing. And more.` })) } }),
  { ...sys("@thetis/exa", "tool", { everyone: false, everyoneBy: undefined }), description: "Web search and page contents.", source: { kind: "git", ref: `${REPO}#exa@${OLD}` }, thetis: { type: "tool", label: "Exa web search", config: EXA_KEY, tools: [{ name: "web_search", description: "Search the web. Returns links." }] } },
];
const catalog = [
  sys("@thetis/store-toml", "storage", { everyone: false, everyoneBy: undefined }),
  sys("@thetis/skills-orleans", "skill", { everyone: false, everyoneBy: undefined, description: "The skills that teach an agent Microsoft Orleans." }),
  sys("@thetis/tool-operator", "tool", { everyone: false, everyoneBy: undefined, thetis: { type: "tool", audience: "admin", label: "restart tool", tools: [{ name: "restart_daemon", description: "Restart." }] } }),
  sys("@thetis/notes", "tool", { everyone: false, everyoneBy: undefined, description: "Keep notes.", thetis: { type: "tool", label: "notes", config: { token: { type: "string", secret: true, required: true, help: "Your notes service token." } }, tools: [{ name: "notes_add", description: "Add a note." }] } }),
];
const index = { version: 1, updatedAt: new Date(Date.now() - 15 * 60_000).toISOString(), registries: [{ name: "thetis", url: REPO }], packages: [{ name: "@thetis/exa", version: "0.2.0", type: "tool", description: "Web search.", keywords: [], registry: "thetis", url: REPO, dir: "exa", commit: NEW, source: `${REPO}#exa@${NEW}`, steps: [], tools: ["web_search"], service: false }] };
const draft = { ...installedRow({ name: "@rae/draft", version: "0.0.1", type: "tool", description: "A draft in my folder.", root: ROOT, thetis: { type: "tool", tools: [{ name: "draft_it" }] }, source: { kind: "local", ref: "packages/draft" } }, false), folder: { dir: "packages/draft" }, component: false };
const rows = withFolder(mergeRows(installed, index.packages, index, { catalog, user: "rae" }), [draft]);
const CONFIG = { "@thetis/exa": { package: "@thetis/exa", inherits: [], keys: [{ key: "apiKey", state: "missing", secret: true, declared: true, type: "string", required: true, help: EXA_KEY.apiKey.help }], summary: "apiKey is required and not set", broken: true } };
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
        if (verb === "config-list") return route.fulfill({ json: { data: Object.values(CONFIG).map((r) => ({ package: r.package, summary: r.summary, broken: r.broken, count: r.keys.length, keys: r.keys })) } });
        if (verb === "config-show") return route.fulfill({ json: { data: CONFIG[body.args.name] ?? { package: body.args.name, inherits: [], keys: [], summary: "every key is set", broken: false } } });
        if (verb === "install") return route.fulfill({ json: { data: { name: body.args.source } } });
        if (verb === "publish-targets") return route.fulfill({ json: { data: { available: false, targets: [] } } });
        if (verb === "show") return route.fulfill({ json: { data: { updatedAt: index.updatedAt, registries: index.registries, total: 1, indexed: true, row: rows.find((r) => r.name === body.args.name), family: [], readme: "### Exa\n\nThe README.", assets: {}, user: "rae", role: "user" } } });
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

    // Review opens the store at "Needs your attention".
    await card.locator(".notice-action", { hasText: "Review" }).click();
    await page.locator("#place .mk-store #mk-attention").waitFor();
    const titles = () => page.locator("#place .mk-section-title").allInnerTexts();
    // The configuration reports arrive after the rows: Exa's missing key then counts as well as its update.
    await page.locator('#place #mk-attention .mk-card[data-name="@thetis/exa"] [data-chip="needsSetup"]').waitFor();
    assert.deepEqual(await titles(), ["Needs your attention (2)", "Added by you (1)", "Discover (2)", "Built in (1)", "In your folder (1)", "Part of Thetis (1)"], "the storage driver and the restart tool are an admin's, so a person never sees them");
    assert.deepEqual(await page.locator("#place .mk-chip").allInnerTexts(), ["All", "Tools", "Skills", "Pages", "Models"], "the type chips are always there");
    assert.match(await page.locator("#place .mk-status").innerText(), /^2 updates ready · checked 15 min ago$/);
    assert.equal(await page.locator("#place .mk-legend").innerText(), "Tools let your assistant do things. Skills teach it how. Pages add a screen. Models add a model provider.");
    assert.equal(await page.locator("#place .mk-system-toggle").count(), 0, "no system components checkbox any more");
    assert.equal(await page.locator("#place details.mk-fold[open]").count(), 0, "the three folds start folded");
    const exaCard = page.locator('#place #mk-added .mk-card[data-name="@thetis/exa"]');
    assert.equal(await exaCard.locator(".mk-card-label").innerText(), "Exa Web Search");
    assert.equal(await exaCard.locator(".mk-card-by").innerText(), "by Thetis · Tools");
    assert.deepEqual(await exaCard.locator(".badge").allInnerTexts(), ["Needs setup", "Update available"]);
    assert.equal(await exaCard.locator('[data-chip="needsSetup"]').getAttribute("title"), "Something must be set before it works. Open it to set it up.");
    assert.doesNotMatch(await page.locator("#place .mk-store").innerText(), /\bIncluded\b|\bYours\b|Installed\b|Local only/, "none of the old badges");
    if (shots) await page.screenshot({ path: join(shots, "market-store.png") });

    // The search: a synonym finds web search, and the folds open while they have something.
    await page.locator("#place .mk-search").fill("internet");
    await page.waitForFunction(() => [...document.querySelectorAll("#place .mk-section-title")].map((n) => n.textContent).join("|").startsWith("Needs your attention (2)|Added by you (1)|Discover (0)"));
    await page.locator("#place .mk-search").fill("draft");
    await page.locator("#place details#mk-folder[open]").waitFor();
    await page.locator("#place .mk-search").fill("");
    await page.locator('#place .mk-chip[data-kind="Skills"]').click();
    await page.waitForFunction(() => document.querySelector("#place #mk-discover .mk-section-title")?.textContent === "Discover (1)");
    await page.locator('#place .mk-chip[data-kind=""]').click();
    await page.locator("#place details#mk-thetis > summary").click();
    await page.locator('#place details#mk-thetis[open] .mk-card[data-name="@thetis/gateway-web"]').waitFor();

    // A page for something not installed: what it needs before the Install, and the confirm says setup comes next.
    await page.locator('#place #mk-discover .mk-card[data-name="@thetis/notes"]').click();
    await page.locator("#place .mk-hero .mk-title").waitFor();
    assert.equal(await page.locator("#place .mk-crumb-name").innerText(), "Notes");
    assert.equal(await page.locator("#place .mk-title").getAttribute("title"), "@thetis/notes", "the package id is the title's tooltip");
    assert.equal(await page.locator("#place .mk-needs").innerText(), "Needs: your notes service token (token)");
    await page.locator("#place .mk-actions .btn", { hasText: "Install" }).click();
    await page.locator(".popover").waitFor();
    assert.match(await page.locator(".popover-note").innerText(), /You'll set it up next: your notes service token \(token\)\./);
    await page.locator(".popover .btn", { hasText: "Cancel" }).click();
    await page.locator("#place .mk-crumb .btn").click();

    // An extension's page: the chips, the reason, Update first, Installed ✓ ▾ with Remove for me, Set up, and the tabs.
    await page.locator('#place #mk-added .mk-card[data-name="@thetis/exa"]').click();
    await page.locator("#place .mk-hero .mk-title").waitFor();
    assert.equal(await page.locator("#place .mk-title").innerText(), "Exa Web Search");
    assert.equal(await page.locator("#place .mk-by").innerText(), "by Thetis · Tools");
    assert.equal(await page.locator("#place .mk-banner").innerText(), "Add the Exa API key (apiKey) in Settings to start using it.");
    assert.deepEqual(await page.locator("#place .mk-actions .btn").allInnerTexts(), ["Update", "Installed ✓ ▾", "Set up", "⋯"]);
    assert.deepEqual(await page.locator("#place .mk-tab").allInnerTexts(), ["Overview", "Settings", "README", "Details"]);
    assert.equal(await page.locator("#place .mk-readme").count(), 0, "the README waits on its tab");
    const pageText = await page.locator("#place .mk-hero").innerText();
    assert.doesNotMatch(pageText, /workspace|reload|fence|\.env|1111111|2222222/i, "no mechanism words, no .env and no commit on the top of the page");
    await page.locator("#place .mk-actions .btn", { hasText: "Installed" }).click();
    assert.deepEqual(await page.locator(".menu .menu-label").allInnerTexts(), ["Remove for me"]);
    await page.locator(".menu .menu-item", { hasText: "Remove for me" }).click();
    await page.locator(".popover").waitFor();
    assert.match(await page.locator(".popover-note").innerText(), /Your saved settings are kept\./);
    await page.locator(".popover .btn", { hasText: "Cancel" }).click();
    await page.locator("#place .mk-actions .btn", { hasText: "Set up" }).click();
    await page.locator('#place .mk-tab[data-tab="settings"][aria-selected="true"]').waitFor();
    await page.locator("#place .cf-card").waitFor();
    if (shots) await page.screenshot({ path: join(shots, "market-page.png") });
    await page.locator("#place .mk-tab", { hasText: "README" }).click();
    await page.locator("#place .mk-readme").waitFor();
    await page.locator("#place .mk-tab", { hasText: "Details" }).click();
    assert.match(await page.locator("#place .mk-technical .kv").innerText(), /1111111 → 2222222/, "the commit pair lives here");
    assert.match(await page.locator("#place .mk-technical .kv").innerText(), /@thetis\/exa/, "and the package id");

    // A part of Thetis: required, so no Remove of any kind.
    await page.locator("#place .mk-crumb .btn").click();
    await page.locator("#place details#mk-thetis[open]").waitFor();
    await page.locator('#place #mk-thetis .mk-card[data-name="@thetis/gateway-web"]').click();
    await page.locator("#place .mk-required").waitFor();
    assert.equal(await page.locator("#place .mk-required").innerText(), "Required by Thetis");
    assert.equal(await page.locator("#place .mk-actions .mk-installed").isDisabled(), true, "Installed ✓ holds nothing to do");
    await page.locator("#place .mk-crumb .btn").click();
    await page.locator("#place .mk-store #mk-attention").waitFor();

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

// An admin's place over the fixture rows the one-state tests use: families, other versions, and the
// For everyone panel with the words the contract gives it.
test("an admin: one card per family, the other versions, and For everyone", async () => {
  const { FIXTURES } = await import("./state-fixtures.js");
  const { familyOf } = await import("../lib/state.js");
  const { rows: all, user } = FIXTURES.bitmuse;
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      constructor() {
        super();
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
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.includes(`/ext/${NAME}/`) && !pathname.includes("/api/")) {
        const file = pathname.split(`/ext/${NAME}/`)[1];
        return route.fulfill({ body: await readFile(join(UI, file)), contentType: TYPES[extname(file)] });
      }
      if (pathname.includes(`/api/ext/${NAME}/`)) {
        const verb = pathname.split(`/api/ext/${NAME}/`)[1];
        const args = route.request().postDataJSON()?.args ?? {};
        const facts = { updatedAt: new Date().toISOString(), registries: [{ name: "thetis", url: REPO }], total: 1, indexed: true, user, role: "admin" };
        if (verb === "updates") return route.fulfill({ json: { data: { items: [], own: [], forks: [], shells: 0, applyOwnChanges: "auto" } } });
        if (verb === "search") return route.fulfill({ json: { data: { ...facts, rows: all } } });
        if (verb === "config-list") return route.fulfill({ json: { data: all.filter((r) => r.config).map((r) => ({ ...r.config, count: r.config.keys.length })) } });
        if (verb === "config-show") return route.fulfill({ json: { data: all.find((r) => r.name === args.name)?.config ?? { package: args.name, inherits: [], keys: [], summary: "every key is set", broken: false } } });
        if (verb === "publish-targets") return route.fulfill({ json: { data: { available: false, targets: [] } } });
        if (verb === "people") return route.fulfill({ json: { data: [{ id: "bitmuse", role: "admin" }, { id: "sam", role: "user" }] } });
        if (verb === "show") {
          const row = all.find((r) => r.name === args.name);
          return route.fulfill({ json: { data: { ...facts, row, family: familyOf(row, all).members.filter((m) => m.name !== row.name), readme: null, assets: {} } } });
        }
        throw new Error(`Unexpected verb: ${verb}`);
      }
      if (pathname.includes("/api/")) {
        const api = pathname.split("/api/")[1];
        if (api === "me") return route.fulfill({ json: { user, role: "admin" } });
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
  try {
    await page.goto(`${ORIGIN}/review/`);
    await page.waitForFunction(() => window.reviewEvents);
    await page.evaluate(() => {
      reviewEmit("open", {});
      reviewEmit("snapshot", { running: [] });
    });
    // Open the place from the ≡ menu, as a person does.
    await page.locator("#menu").click();
    await page.locator(".menu-item", { hasText: "Extensions" }).first().click();
    await page.locator("#place .mk-store #mk-added").waitFor();
    await page.locator('#place [data-chip="needsSetup"]').first().waitFor();
    const titles = await page.locator("#place .mk-section-title").allInnerTexts();
    assert.deepEqual(titles, ["Needs your attention (4)", "Added by you (2)", "Discover (2)", "Built in (2)", "In your folder (2)", "Part of Thetis (1)"]);
    assert.deepEqual(await page.locator("#place #mk-discover .mk-card").evaluateAll((n) => n.map((c) => c.dataset.name)), ["@thetis/tool-operator", "@tg/lore"], "no second Notion and no Thetis tool-exec: bitmuse has a version of each");
    const copy = page.locator('#place #mk-added .mk-card[data-name="@bitmuse/tool-exec"]');
    assert.equal(await copy.locator(".mk-card-label").innerText(), "Extensions and Helper Chats");
    assert.deepEqual(await copy.locator(".badge").allInnerTexts(), ["Update available", "Customized"]);
    if (shots) await page.screenshot({ path: join(shots, "market-admin-store.png"), fullPage: true });

    // The promoted Notion: by you, For everyone, its other versions, and how it came to be everyone's.
    await page.locator("#place details#mk-builtin > summary").click();
    await page.locator('#place #mk-builtin .mk-card[data-name="@thetis/notion"]').click();
    await page.locator("#place .mk-side").waitFor();
    assert.equal(await page.locator("#place .mk-by").innerText(), "by you · Tools");
    assert.deepEqual(await page.locator("#place .mk-hero .badge").allInnerTexts(), ["For everyone"]);
    assert.deepEqual((await page.locator("#place .mk-versions li").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()).sort(), ["@bitmuse/notion — your original · published to thetis Install", "notion-read — your copy in your folder · not installed Install"]);
    assert.match(await page.locator("#place .mk-side").innerText(), /Shared with everyone from @bitmuse\/notion by you\./);
    assert.deepEqual(await page.locator("#place .mk-tab").allInnerTexts(), ["Overview", "README", "Details", "People", "Activity"]);
    if (shots) await page.screenshot({ path: join(shots, "market-admin-notion.png"), fullPage: true });

    // The original: never shared a second time.
    await page.locator("#place .mk-version-link", { hasText: "@bitmuse/notion" }).first().click();
    await page.waitForFunction(() => document.querySelector("#place .mk-crumb-name")?.textContent === "Notion" && document.querySelector("#place .mk-title")?.title === "@bitmuse/notion");
    assert.match(await page.locator("#place .mk-side").innerText(), /Already shared with everyone as Notion\./);
    assert.equal(await page.locator("#place .mk-side .btn", { hasText: "Share with everyone" }).count(), 0);
    assert.equal(await page.locator("#place .mk-needs").innerText(), "Needs: an internal connection or personal access token from https://www.notion.so/my-integrations (token)");

    // The copy of an older official version: Use Thetis's version leads, and sharing it is not offered.
    await page.locator("#place .mk-crumb .btn").click();
    await page.locator('#place #mk-added .mk-card[data-name="@bitmuse/tool-exec"]').click();
    await page.locator("#place .mk-side").waitFor();
    assert.equal(await page.locator("#place .mk-actions .btn").first().innerText(), "Use Thetis's version");
    assert.equal(await page.locator("#place .mk-banner").innerText(), "Thetis's version 0.4.1 is newer than the 0.3.3 your copy was made from.");
    assert.match(await page.locator("#place .mk-side").innerText(), /Your copy is older than Thetis's 0\.4\.1; sharing it would replace it for everyone\./);
    assert.equal(await page.locator("#place .mk-side .btn", { hasText: "Remove for everyone" }).count(), 1);
    await page.locator("#place .mk-more").click();
    assert.deepEqual(await page.locator(".menu .menu-label").allInnerTexts(), ["Delete files…", "Technical id"]);
    await page.keyboard.press("Escape");
    if (shots) await page.screenshot({ path: join(shots, "market-admin-copy.png"), fullPage: true });

    // The server's missing key is the admin's Needs setup, with where to fix it.
    await page.locator("#place .mk-crumb .btn").click();
    await page.locator('#place #mk-attention .mk-card[data-name="@thetis/skills-hybrid"]').click();
    await page.locator("#place .mk-banner").waitFor();
    assert.match(await page.locator("#place .mk-banner").innerText(), /OPENROUTER_API_KEY is not in the server's environment.*Control panel → Extensions → Skill Loader → Settings/);
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: "/tmp/market-browser-admin.png", fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
});

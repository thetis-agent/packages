// Optional Chromium check of the Extensions place, an extension's page and the "Updates ready" card over the real gateway
// page, the way packages/harness-core/test/effort-browser.mjs does it: every asset comes from disk through Playwright's
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
const EXA_KEY = { apiKey: { type: "string", secret: true, required: true, help: "Your Exa API key, from the Exa dashboard (dashboard.exa.ai → API keys). Every search needs one." } };
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
    { name: "@thetis/gateway-web", label: "Web Gateway", from: "0.13.0", to: "0.13.1", apply: "apply" },
    { name: "@thetis/exa", label: "Exa", from: "0.1.0", to: "0.2.0", apply: "install" },
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
    assert.equal(await card.locator(".notice-body").innerText(), "Updates for 2 extensions: Web Gateway and Exa.");
    if (shots) await page.screenshot({ path: join(shots, "market-card.png") });

    // Review opens the store at "Needs your attention", and the card goes while the place is open.
    await card.locator(".notice-action", { hasText: "Review" }).click();
    await page.locator("#place .mk-store #mk-attention").waitFor();
    await page.waitForFunction((n) => !document.querySelector(`[data-notice="${n}:updates"]`), NAME);
    const titles = () => page.locator("#place .mk-section-title").allInnerTexts();
    // The configuration reports arrive after the rows: Exa's missing key then shows on its card.
    await page.locator('#place #mk-installed .mk-card[data-name="@thetis/exa"] [data-chip="needsSetup"]').waitFor();
    assert.deepEqual(await titles(), ["Needs your attention (2)", "Installed (2)", "Discover (2)", "Drafts in your folder (1)", "Part of Thetis (1)"], "the storage driver and the restart tool are an admin's, so a person never sees them");
    assert.deepEqual(await page.locator("#place .mk-chip").allInnerTexts(), ["All", "Tools", "Skills", "Pages", "Models", "Background"], "the type chips are always there");
    assert.equal(await page.locator("#place .mk-status").innerText(), "Updates ready: Exa Web Search and Web Gateway · checked 15 min ago");
    assert.equal(await page.locator("#place .mk-legend").innerText(), "Tools let your assistant do things. Skills teach it how. Pages add a screen. Models add a model provider. Background parts work without a screen or tools.");
    assert.equal(await page.locator("#place details.mk-fold[open]").count(), 0, "the folds start folded");
    // The to-do strip: one row each, a sentence and one action; Update N is exactly the Update rows.
    assert.deepEqual(await page.locator("#place .mk-todo").evaluateAll((n) => n.map((r) => [r.dataset.name, r.dataset.kind, r.querySelector(".btn").textContent])), [["@thetis/exa", "update", "Update"], ["@thetis/gateway-web", "update", "Update"]], "a fixed order: updates first, by label");
    assert.equal(await page.locator('#place .mk-todo[data-name="@thetis/exa"] .mk-todo-reason').innerText(), "Version 0.2.0 is ready; you have 0.1.0, and it still needs setting up.");
    assert.equal(await page.locator("#place #mk-attention .mk-section-head .btn").innerText(), "Update 2");
    assert.deepEqual(await page.locator("#place .mk-pill-btn").evaluateAll((n) => n.map((b) => b.firstChild.textContent)), ["All", "Installed by you", "Given to you", "Customized"]);
    const exaCard = page.locator('#place #mk-installed .mk-card[data-name="@thetis/exa"]');
    assert.equal(await exaCard.locator(".mk-card-label").innerText(), "Exa Web Search");
    assert.equal(await exaCard.locator(".mk-card-label").getAttribute("title"), "@thetis/exa", "the id is the title's tooltip, not the card's");
    assert.equal(await exaCard.getAttribute("title"), null);
    assert.equal(await exaCard.locator(".mk-card-by").innerText(), "by Thetis · Tools");
    assert.deepEqual(await exaCard.locator(".mk-card-chips .badge").allInnerTexts(), ["Needs setup", "Update available"]);
    assert.equal(await exaCard.locator('[data-chip="needsSetup"]').getAttribute("title"), "Something must be set before it works. Open it to set it up.");
    assert.equal(await exaCard.locator(".mk-card-desc").innerText(), "Web search and page contents.");
    assert.doesNotMatch(await page.locator("#place .mk-store").innerText(), /\bIncluded\b|\bYours\b|Local only|comes with Thetis/, "none of the old words");
    // The pills narrow Installed.
    await page.locator('#place .mk-pill-btn[data-pill="given"]').click();
    await page.waitForFunction(() => document.querySelector("#place #mk-installed .mk-section-title")?.textContent === "Installed (1)");
    // A pill that hides what the search found says so, and Show all takes it off; the pills count what the search leaves.
    await page.locator("#place .mk-search").fill("exa");
    await page.locator("#place .mk-hidden-by").waitFor();
    assert.equal(await page.locator("#place .mk-hidden-by").innerText(), "Exa Web Search is hidden by the 'Given to you' filter — Show all");
    assert.deepEqual(await page.locator("#place .mk-pill-n").allInnerTexts(), ["1", "1", "0", "0"]);
    await page.locator("#place .mk-hidden-by .mk-link-btn").click();
    await page.locator('#place #mk-installed .mk-card[data-name="@thetis/exa"]').waitFor();
    await page.locator("#place .mk-search").fill("");
    if (shots) await page.screenshot({ path: join(shots, "market-store.png") });

    // The search: a synonym finds web search, an empty section is not drawn, and a fold opens while it has something.
    await page.locator("#place .mk-search").fill("internet");
    await page.locator('#place #mk-installed .mk-card[data-name="@thetis/exa"]').waitFor();
    await page.waitForFunction(() => !document.querySelector("#place #mk-discover"));
    await page.locator("#place .mk-search").fill("draft");
    await page.locator("#place details#mk-drafts[open]").waitFor();
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
    assert.equal(await page.locator("#place .mk-needs").innerText(), "Needs a notes service token.");
    await page.locator("#place .mk-actions .btn", { hasText: "Install" }).click();
    await page.locator(".popover").waitFor();
    assert.match(await page.locator(".popover-note").innerText(), /^Nothing to download\. .*You'll set it up next: a notes service token\.$/);
    assert.match(await page.locator(".popover .kv").innerText(), /from\s+Thetis · Tools/, "never 'by by'");
    await page.locator(".popover .btn", { hasText: "Cancel" }).click();
    await page.locator("#place .mk-crumb .btn").click();

    // An extension's page: the chips, the reason with its link, Update first, Installed ✓ ▾ with Remove for me, Set up, and the tabs.
    await page.locator('#place #mk-installed .mk-card[data-name="@thetis/exa"]').click();
    await page.locator("#place .mk-hero .mk-title").waitFor();
    assert.equal(await page.locator("#place .mk-title").innerText(), "Exa Web Search");
    assert.equal(await page.locator("#place .mk-by").innerText(), "by Thetis · Tools");
    assert.equal(await page.locator("#place .mk-banner").innerText(), "Exa Web Search needs an Exa API key before it works. Get one at dashboard.exa.ai.");
    assert.equal(await page.locator("#place .mk-banner a").getAttribute("href"), "https://dashboard.exa.ai");
    assert.deepEqual(await page.locator("#place .mk-actions .btn").allInnerTexts(), ["Update", "Installed ✓ ▾", "Set up", "Remove for me", "⋯"], "Remove for me in plain sight, Set up while something is missing");
    assert.deepEqual(await page.locator("#place .mk-tab").allInnerTexts(), ["Overview", "Settings", "README", "Details"]);
    assert.equal(await page.locator("#place .mk-readme").count(), 0, "the README waits on its tab");
    const pageText = await page.locator("#place .mk-hero").innerText();
    assert.doesNotMatch(pageText, /workspace|reload|fence|\.env|1111111|2222222|\(apiKey\)/i, "no mechanism words, no .env, no key name and no commit on the top of the page");
    await page.locator("#place .mk-actions .btn", { hasText: "Installed" }).click();
    assert.deepEqual(await page.locator(".menu .menu-label").allInnerTexts(), ["Remove for me"]);
    await page.locator(".menu .menu-item", { hasText: "Remove for me" }).click();
    await page.locator(".popover").waitFor();
    assert.match(await page.locator(".popover-note").innerText(), /Also delete my saved settings/);
    assert.equal(await page.locator(".popover .mk-tick").isChecked(), false, "kept unless the person says so");
    await page.locator(".popover .btn", { hasText: "Cancel" }).click();
    await page.locator("#place .mk-more").click();
    assert.deepEqual(await page.locator(".menu .menu-label").allInnerTexts(), ["Copy technical id (@thetis/exa)"]);
    await page.keyboard.press("Escape");
    await page.locator("#place .mk-actions .btn", { hasText: "Set up" }).click();
    await page.locator('#place .mk-tab[data-tab="settings"][aria-selected="true"]').waitFor();
    await page.locator("#place .cf-card").waitFor();
    assert.equal(await page.locator("#place .mk-actions .btn", { hasText: "Set up" }).isVisible(), false, "Set up has nothing to add while its tab is shown");
    assert.doesNotMatch(await page.locator("#place .mk-config").innerText(), /admins only|Control panel/, "a person is not told about an admin's layer");
    if (shots) await page.screenshot({ path: join(shots, "market-page.png") });
    await page.locator("#place .mk-tab", { hasText: "README" }).click();
    await page.locator("#place .mk-readme").waitFor();
    await page.locator("#place .mk-tab", { hasText: "Details" }).click();
    const detailsText = await page.locator("#place .mk-technical .kv").innerText();
    assert.match(detailsText, /1111111 → 2222222/, "the commit pair lives here");
    assert.match(detailsText, /@thetis\/exa/, "and the package id");
    assert.match(detailsText, /kind\s+Tools/);
    assert.doesNotMatch(detailsText, /^type\b/m, "one field name, Kind");

    // A part of Thetis: required, so no Remove of any kind.
    await page.locator("#place .mk-crumb .btn").click();
    await page.locator("#place details#mk-thetis[open]").waitFor();
    await page.locator('#place #mk-thetis .mk-card[data-name="@thetis/gateway-web"]').click();
    await page.locator("#place .mk-required").waitFor();
    assert.equal(await page.locator("#place .mk-required").innerText(), "Required by Thetis");
    assert.equal(await page.locator("#place .mk-actions .mk-installed").isDisabled(), true, "Installed ✓ holds nothing to do");
    await page.locator("#place .mk-crumb .btn").click();
    await page.locator("#place .mk-store #mk-attention").waitFor();

    // Update 2: the fetch, one drained apply, the space going away and coming back, and the refresh.
    const before = await page.evaluate(() => window.esCount);
    await page.locator("#place #mk-attention .mk-section-head .btn", { hasText: "Update 2" }).click();
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
    await page.locator(".toast", { hasText: "Updated: Web Gateway and Exa." }).waitFor();
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
  const { rows: fixture, user } = FIXTURES.bitmuse;
  // Three parts of Thetis bitmuse does not have: two skill loaders nobody runs, and the model provider the whole
  // installation runs. Each part's card says whether it runs.
  const part = (name, type, extra = {}) => ({ ...installedRow(sys(name, type, { everyone: false, everyoneBy: undefined }), false), component: true, ...extra });
  const all = [...fixture, part("@thetis/skills-l1", "loader"), part("@thetis/skills-all", "loader"), part("@thetis/provider-openrouter", "provider", { hostInstalled: true })];
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
        if (verb === "holders") return route.fulfill({ json: { data: { name: args.name, users: args.name.startsWith("@bitmuse/") ? ["bitmuse"] : args.name === "@thetis/tool-operator" ? [] : ["bitmuse", "sam"] } } });
        if (verb === "show") {
          const found = all.find((r) => r.name === args.name);
          const row = found.name === "@bitmuse/tool-exec" ? { ...found, changed: ["dist/src/index.js"] } : found;
          return route.fulfill({ json: { data: { ...facts, row, family: familyOf(row, all).members.filter((m) => m.name !== row.name), readme: null, assets: {} } } });
        }
        if (verb === "changes") return route.fulfill({ json: { data: { name: args.name, base: "0.3.3", files: ["dist/src/index.js"], diff: "--- dist/src/index.js (as copied)\n+++ dist/src/index.js (yours)\n@@ -1,1 +1,1 @@\n-old\n+new", cut: false, compared: 1 } } });
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
    await page.locator("#place .mk-store #mk-installed").waitFor();
    await page.locator('#place [data-chip="needsSetup"]').first().waitFor();
    const titles = await page.locator("#place .mk-section-title").allInnerTexts();
    assert.deepEqual(titles, ["Needs your attention (5)", "Installed (4)", "Discover (2)", "Part of Thetis (4)"], "no Drafts: the folder copies of Notion are in its card");
    assert.deepEqual(await page.locator("#place .mk-todo").evaluateAll((n) => n.map((r) => [r.dataset.kind, r.querySelector(".btn").textContent])), [["update", "Update"], ["setup", "Set up"], ["setup", "Set up"], ["optional", "Set up"], ["review", "Review"]], "the same order on every load");
    assert.equal(await page.locator("#place #mk-attention .mk-section-head .btn").innerText(), "Update 1", "the copy behind Thetis's version is never counted");
    assert.equal(await page.locator("#place .mk-update-note").innerText(), "Your own copies are not touched.");
    assert.deepEqual(await page.locator("#place #mk-discover .mk-card").evaluateAll((n) => n.map((c) => c.dataset.name)), ["@thetis/tool-operator", "@tg/lore"], "no second Notion and no Thetis tool-exec: bitmuse has a version of each");
    const copy = page.locator('#place #mk-installed .mk-card[data-name="@bitmuse/tool-exec"]');
    assert.equal(await copy.locator(".mk-card-label").innerText(), "Extensions and Helper Chats");
    assert.deepEqual(await copy.locator(".badge").allInnerTexts(), ["Customized"]);
    await page.locator("#place #mk-thetis > summary").click();
    const parts = await page.locator("#place #mk-thetis .mk-card").evaluateAll((n) => n.map((c) => [c.dataset.name, [...c.querySelectorAll(".badge")].map((b) => b.textContent)]));
    assert.deepEqual(
      Object.fromEntries(parts),
      { "@thetis/gateway-web": ["Enabled", "Update available"], "@thetis/skills-l1": ["Disabled"], "@thetis/skills-all": ["Disabled"], "@thetis/provider-openrouter": ["Enabled"] },
      "every part says whether it runs: for bitmuse, for the whole installation, or not at all"
    );
    if (shots) await page.screenshot({ path: join(shots, "market-admin-store.png"), fullPage: true });
    if (shots) {
      await page.locator("#place #mk-thetis").scrollIntoViewIfNeeded();
      await page.locator("#place #mk-thetis").screenshot({ path: join(shots, "market-admin-parts.png") });
    }

    // The shared Notion: by you, the neutral setup, its other versions, and how it came to be everyone's.
    await page.locator('#place #mk-installed .mk-card[data-name="@thetis/notion"]').click();
    await page.locator("#place .mk-side").waitFor();
    assert.equal(await page.locator("#place .mk-by").innerText(), "by you · Tools");
    assert.deepEqual(await page.locator("#place .mk-hero-head .badge").allInnerTexts(), ["Needs setup", "For everyone"]);
    assert.match(await page.locator("#place .mk-banner").innerText(), /^You gave everyone Notion\. Set it up if you use it, or remove it for yourself\./);
    assert.deepEqual(await page.locator("#place .mk-banner .btn").allInnerTexts(), ["Set my key", "Set one for everyone"]);
    assert.deepEqual((await page.locator("#place .mk-versions li").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()), ["✓ Notion — you use this (shared with everyone)", "○ Notion — your original, in your folder Use instead", "○ Notion (Read Only) — a variant in your folder Use instead"]);
    assert.match(await page.locator("#place .mk-side").innerText(), /Shared with everyone from Notion by you\. Your people get this one\./);
    assert.match(await page.locator("#place .mk-side").innerText(), /Takes it away from [^.]+ now\. It stays shared, so people added later still get it\./);
    assert.equal(await page.locator("#place .mk-side .btn", { hasText: "Turn on for everyone" }).count(), 0);
    assert.deepEqual(await page.locator("#place .mk-person option").allInnerTexts(), ["sam (has it)"]);
    assert.equal(await page.locator("#place .mk-picker .btn").innerText(), "Remove for sam…");
    assert.deepEqual(await page.locator("#place .mk-tab").allInnerTexts(), ["Overview", "Settings", "README", "Details", "People", "Activity"]);
    await page.locator("#place .mk-versions .btn").first().click();
    await page.locator(".popover").waitFor();
    assert.equal(await page.locator(".popover-head span").first().innerText(), "Switch to your original Notion?");
    assert.match(await page.locator(".popover-note").innerText(), /replaces Notion \(shared with everyone\) for you\. Everyone else keeps Notion \(shared with everyone\)\./);
    await page.locator(".popover .btn", { hasText: "Cancel" }).click();
    if (shots) await page.screenshot({ path: join(shots, "market-admin-notion.png"), fullPage: true });

    // The original: already shared, Open it, and nothing else.
    await page.locator('#place .mk-version-link[title="@bitmuse/notion"]').click();
    await page.waitForFunction(() => document.querySelector("#place .mk-title")?.title === "@bitmuse/notion");
    assert.equal(await page.locator("#place .mk-title").innerText(), "Notion — your original", "never titled like the shared copy");
    assert.match(await page.locator("#place .mk-side").innerText(), /Already shared with everyone as Notion\./);
    assert.deepEqual(await page.locator(`#place .mk-side-block[aria-label="For everyone"] .btn`).allInnerTexts(), ["Open it"], "no Share, no Turn on, no Remove, no picker");
    assert.equal(await page.locator("#place .mk-needs").innerText(), "Needs an internal connection or personal access token. Get one at https://www.notion.so/my-integrations.");
    assert.equal(await page.locator("#place .mk-actions .btn").first().innerText(), "Use instead");

    // The copy of an older official version: a Review, what using Thetis's version does, and no sharing.
    await page.locator("#place .mk-crumb .btn").click();
    await page.locator('#place #mk-installed .mk-card[data-name="@bitmuse/tool-exec"]').click();
    await page.locator("#place .mk-side").waitFor();
    assert.equal(await page.locator("#place .mk-actions .btn").first().innerText(), "Use Thetis's version");
    assert.equal(await page.locator("#place .mk-banner").innerText(), "Thetis's 0.4.1 is newer than your copy (made from 0.3.3).");
    assert.match(await page.locator("#place .mk-hero").innerText(), /Use Thetis's version replaces your changes with Thetis's 0\.4\.1\. Your copy's files stay in your folder\./);
    assert.match(await page.locator("#place .mk-side").innerText(), /You can share your copy once it is based on Thetis's 0\.4\.1\./);
    // Private: no Install for sam, only the way to Thetis's version.
    assert.equal(await page.locator("#place .mk-picker").count(), 0, "no Install for anyone on a private copy");
    assert.equal(await page.locator("#place .mk-private-line").innerText(), "This is your own copy. To give sam this extension, use Thetis's version: Open Extensions and Helper Chats");
    // What it changed, and Show changes.
    await page.locator("#place .mk-changes .btn", { hasText: "Show changes" }).click();
    await page.locator("#place .mk-diff").waitFor();
    assert.deepEqual((await page.locator("#place .mk-diff .is-add").allInnerTexts()).map((t) => t.trim()), ["+new"]);
    assert.match(await page.locator("#place .mk-side").innerText(), /Only you have this\. Use Remove for me\./);
    assert.equal(await page.locator("#place .mk-side .btn", { hasText: "Remove for everyone" }).count(), 0, "a private copy is nobody else's to remove");
    await page.locator("#place .mk-more").click();
    assert.deepEqual(await page.locator(".menu .menu-label").allInnerTexts(), ["Delete files…", "Copy technical id (@bitmuse/tool-exec)"]);
    await page.keyboard.press("Escape");
    if (shots) await page.screenshot({ path: join(shots, "market-admin-copy.png"), fullPage: true });

    // The server's missing key is the admin's Needs setup, with where to fix it and the way there.
    await page.locator("#place .mk-crumb .btn").click();
    await page.locator('#place #mk-attention .mk-todo[data-name="@thetis/skills-hybrid"] .mk-todo-label').click();
    await page.locator("#place .mk-banner").waitFor();
    assert.match(await page.locator("#place .mk-banner").innerText(), /OPENROUTER_API_KEY is not in the server's environment.*Control panel → Extensions → Skill Loader → Settings/);
    assert.equal(await page.locator("#place .mk-banner .btn").last().innerText(), "Set it for everyone");

    // An admin-only extension: no Turn on for everyone, and a picker of admins only (there is none but me).
    await page.locator("#place .mk-crumb .btn").click();
    await page.locator('#place #mk-discover .mk-card[data-name="@thetis/tool-operator"]').click();
    await page.locator("#place .mk-side").waitFor();
    assert.match(await page.locator("#place .mk-side").innerText(), /Only admins can have this\./);
    assert.equal(await page.locator("#place .mk-side .btn").count(), 0);

    // At phone width the side panel comes before the tabs, and the tabs scroll rather than being cut.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#place .mk-crumb .btn").click();
    await page.locator('#place #mk-installed .mk-card[data-name="@thetis/notion"]').click();
    await page.locator("#place .mk-side").waitFor();
    const [side, tabs] = await Promise.all([page.locator("#place .mk-side").boundingBox(), page.locator("#place .mk-tabs").boundingBox()]);
    assert.ok(side.y < tabs.y, "the family and the admin's acts before a long tool list");
    assert.ok(await page.locator("#place .mk-tabs").evaluate((n) => [...n.children].every((t) => t.getBoundingClientRect().right <= n.getBoundingClientRect().right + 1)), "no tab is cut at the edge");
    if (shots) await page.screenshot({ path: join(shots, "market-admin-phone.png"), fullPage: true });
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: "/tmp/market-browser-admin.png", fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
});

// A maintainer publishing their own copy to the registry every installation ships, which takes @thetis alone:
// the confirm names the name it goes out under and that the space moves to it, and after the publish the
// page switches the space with the published commit, and says so once.
test("publishing your own copy renames it into the registry's scope, moves your space to it, and retires the promoted copy", async () => {
  const user = "bitmuse";
  const SSH = "git@github.com:thetis-agent/packages.git";
  const gcloud = {
    ...installedRow({ name: "@bitmuse/gcloud", version: "0.1.0", type: "tool", description: "The gcloud CLI as tools.", root: ROOT, thetis: { type: "tool", label: "Google Cloud", tools: [{ name: "gcloud_run", description: "Run gcloud." }] }, source: { kind: "local", ref: "packages/gcloud" } }, true),
    folder: { dir: "packages/gcloud" },
    local: true,
    own: true,
  };
  // The copy promoted here before it was published: the same @thetis name, for everyone, with no pin.
  const promoted = { ...installedRow({ ...sys("@thetis/gcloud", "tool", { everyone: true, everyoneBy: "promoted" }), thetis: { type: "tool", label: "Google Cloud", forkedFrom: undefined, tools: [{ name: "gcloud_run", description: "Run gcloud." }] } }, false), everyone: true, everyoneBy: "promoted" };
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  const sent = [];
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
        const facts = { updatedAt: new Date().toISOString(), registries: [{ name: "thetis", url: REPO }], total: 0, indexed: true, user, role: "admin" };
        const published = { ok: true, package: "@thetis/gcloud", renamedFrom: "@bitmuse/gcloud", as: "itself", fork: null, target: "thetis", url: SSH, branch: "main", directory: "gcloud", was: null, now: "0.1.0", first: true, blockers: [] };
        if (verb === "updates") return route.fulfill({ json: { data: { items: [], own: [], forks: [], shells: 0, applyOwnChanges: "auto" } } });
        if (verb === "search") return route.fulfill({ json: { data: { ...facts, rows: [gcloud] } } });
        if (verb === "config-list") return route.fulfill({ json: { data: [] } });
        if (verb === "config-show") return route.fulfill({ json: { data: { package: args.name, inherits: [], keys: [], summary: "every key is set", broken: false } } });
        if (verb === "publish-targets") return route.fulfill({ json: { data: { available: true, canRemove: false, targets: [{ name: "thetis", url: SSH }] } } });
        if (verb === "show") return route.fulfill({ json: { data: { ...facts, row: gcloud, family: [promoted], readme: null, assets: {} } } });
        if (verb === "people") return route.fulfill({ json: { data: [{ id: user, role: "admin" }] } });
        if (verb === "holders") return route.fulfill({ json: { data: { name: args.name, users: [user] } } });
        if (verb === "publish") {
          sent.push({ verb, args });
          return route.fulfill({ json: { data: args.dryRun ? { ...published, dryRun: true } : { ...published, dryRun: false, commit: NEW, committed: true, pushed: true } } });
        }
        if (verb === "use-published") {
          sent.push({ verb, args });
          return route.fulfill({ json: { data: { name: "@thetis/gcloud", from: "@bitmuse/gcloud", settings: ["project", "credentialsJson"] } } });
        }
        if (verb === "retire-promoted") {
          sent.push({ verb, args });
          return route.fulfill({ json: { data: { name: args.name, moved: ["sam"], failed: [], retired: true, keptAt: "/data/packages-retired/gcloud-x" } } });
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
    await page.locator("#menu").click();
    await page.locator(".menu-item", { hasText: "Extensions" }).first().click();
    await page.locator('#place .mk-card[data-name="@bitmuse/gcloud"]').click();
    await page.locator("#place .mk-side").waitFor();
    // ⋯ → Publish… is how a person finds it; it opens the Details tab at the Publish block.
    await page.locator("#place .mk-more").click();
    await page.locator(".menu .menu-label", { hasText: "Publish…" }).click();
    await page.locator("#place .mk-publish-block").waitFor();
    await page.locator("#place .mk-bump").selectOption("");
    await page.locator("#place .mk-publish .btn", { hasText: "Publish to thetis" }).click();
    await page.locator(".popover").waitFor();
    assert.equal(await page.locator(".popover-head span").first().innerText(), "Publish @bitmuse/gcloud as @thetis/gcloud?");
    const confirmText = (await page.locator(".popover").innerText()).replace(/\s+/g, " ");
    assert.match(confirmText, /thetis takes @thetis packages only/);
    assert.match(confirmText, /your space runs @thetis\/gcloud@0\.1\.0 with your settings, in place of @bitmuse\/gcloud; its files stay in your folder/);
    assert.match(confirmText, /your folder copy keeps the name @bitmuse\/gcloud/);
    assert.match(confirmText, /the promoted @thetis\/gcloud here is retired: everyone on it moves to @thetis\/gcloud@0\.1\.0/);
    if (shots) await page.locator(".popover").screenshot({ path: join(shots, "market-publish-rename.png") });
    await page.locator(".popover .btn", { hasText: "Publish 0.1.0" }).click();
    await page.locator(".toast", { hasText: "Your space now runs it. Your settings came with it (2). The promoted copy is retired: sam moved to it." }).waitFor();
    const used = sent.find((s) => s.verb === "use-published");
    assert.deepEqual(used?.args, { name: "@bitmuse/gcloud", package: "@thetis/gcloud", url: SSH, directory: "gcloud", commit: NEW }, "the switch names the commit the publish pushed");
    assert.deepEqual(sent.map((s) => [s.verb, !!s.args.dryRun]), [["publish", true], ["publish", false], ["use-published", false], ["retire-promoted", false]], "a dry run, the publish, the switch, then the retirement, once each");
    assert.deepEqual(sent.at(-1).args, { name: "@thetis/gcloud", url: SSH, directory: "gcloud", commit: NEW });
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: "/tmp/market-browser-publish.png", fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
});

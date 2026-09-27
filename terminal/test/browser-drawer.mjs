// Optional Chromium check of the drawer over the real web shell: it starts closed over the shells that
// were there, opens when a shell starts in this conversation, lists the others under their fold, and
// keeps Close out of the rows. Run from the runtime root, outside `npm test`:
//
//   THETIS_PLAYWRIGHT_MODULE=/abs/node_modules/playwright-core/index.mjs \
//   THETIS_CHROMIUM_EXECUTABLE=/abs/chrome \
//   node --test packages/terminal/test/browser-drawer.mjs
//
// THETIS_BROWSER_ARTIFACTS, when set, receives a screenshot of the open drawer.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withPage } from "../../gateway-web/test/browser-fixture.mjs";

let browser;
before(async () => {
  const { chromium } = await import(process.env.THETIS_PLAYWRIGHT_MODULE || "playwright-core");
  browser = await chromium.launch({ executablePath: process.env.THETIS_CHROMIUM_EXECUTABLE || undefined, headless: true, args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); });

test("the drawer starts closed, opens for a new shell here, folds the others, and keeps Close off the rows", { timeout: 30000 }, async () => {
  await withPage(browser, "terminal-drawer", { existing: true }, async ({ page, id }) => {
    await page.route(/\/review\/ext\/@thetis\/terminal\/.+$/, async (route) => {
      const file = new URL(route.request().url()).pathname.split("/ext/@thetis/terminal/")[1];
      await route.fulfill({ body: await readFile(new URL(`../ui/${file}`, import.meta.url)), contentType: file.endsWith(".css") ? "text/css" : "text/javascript" });
    });
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    await page.evaluate(async (manifest) => {
      const registry = await import("./assets/lib/registry.js");
      const { createExt } = await import("./assets/lib/ext.js");
      const declaration = { ...manifest.thetis.ui, package: manifest.name, commands: manifest.thetis.ui.commands.filter((c) => !c.stream).map((c) => c.verb), streams: ["watch"] };
      registry.declare(declaration);
      const module = await import("./ext/@thetis/terminal/index.js");
      window.termRequests = [];
      const ext = createExt(declaration);
      module.default({
        ...ext,
        subscribe: (_verb, { onEvent }) => { window.termPush = onEvent; return () => {}; },
        request: async (verb, { args } = {}) => { window.termRequests.push([verb, args]); return { data: {} }; },
      });
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "./ext/@thetis/terminal/index.css";
      document.head.append(css);
    }, manifest);
    const row = (sid, conversation, name, state = "idle") => ({ id: sid, name, conversation, state, cwd: `/home/review/${name}`, framed: true, watchers: 0 });
    const others = Array.from({ length: 5 }, (_, i) => row(`other${i}0000000`.slice(0, 12), `s_other${i}`, `npm test ${i}`));
    await page.evaluate((list) => window.termPush({ ev: "sessions", sessions: list }), [row("aaaaaaaaaaaa", id, "runtime"), ...others]);
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#shelf:not([hidden])").count(), 0, "the drawer starts closed over the shells that were already there");
    await page.evaluate((s) => window.termPush({ ev: "state", session: s }), row("bbbbbbbbbbbb", id, "cargo build", "busy"));
    await page.locator("#shelf:not([hidden]) .term-list").waitFor();
    const labels = await page.locator(".term-list .term-tab-label").allTextContents();
    assert.deepEqual(labels.sort(), ["cargo build", "runtime"], "this conversation's shells, and the others folded");
    assert.match(await page.locator(".term-group").innerText(), /Other conversations \(5\)/);
    assert.equal(await page.locator(".term-tab-kill").count(), 0, "no close on the rows");
    assert.equal(await page.locator(".term-tab-info").count(), 0, "no details without developer details");
    assert.equal(await page.locator(".term-foot-close").count(), 1, "Close shell sits in the footer");
    assert.ok((await page.locator(".term-foot-close").getAttribute("aria-label")).startsWith("Close "));
    await page.locator(".term-group").click();
    assert.equal(await page.locator(".term-list .term-tab-label").count(), 7);
    const artifacts = process.env.THETIS_BROWSER_ARTIFACTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, "terminal-drawer.png") });
    }
  });
});

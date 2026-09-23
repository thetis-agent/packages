// Optional Chromium regression over the actual web shell, extension seam and Context package.
// Uses the gateway's local fixture; no daemon, credentials or model calls are needed.
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

test("Context shows an active first turn, complete request details and live usage in the web shell", { timeout: 20000 }, async () => {
  await withPage(browser, "context-live", { existing: true }, async ({ page, id }) => {
    let data = { turns: 0, status: "running", started: true, lastCall: null, usage: [] };
    let requests = 0;
    await page.route("**/api/ext/@thetis/ui-context/context", (route) => {
      requests++;
      return route.fulfill({ json: { data } });
    });
    await page.route(/\/review\/ext\/@thetis\/ui-context\/[^/]+$/, async (route) => {
      const file = new URL(route.request().url()).pathname.split("/").at(-1);
      await route.fulfill({ body: await readFile(new URL(`../ui/${file}`, import.meta.url)), contentType: file.endsWith(".css") ? "text/css" : "text/javascript" });
    });
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    await page.evaluate(async (manifest) => {
      const registry = await import("./assets/lib/registry.js");
      const { createExt } = await import("./assets/lib/ext.js");
      const declaration = { ...manifest.thetis.ui, package: manifest.name, commands: ["context"] };
      registry.declare(declaration);
      const module = await import("./ext/@thetis/ui-context/index.js");
      module.default(createExt(declaration));
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "./ext/@thetis/ui-context/index.css";
      document.head.append(css);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.copiedContext = text; } } });
    }, manifest);
    await page.getByRole("button", { name: "Context", exact: true }).click();
    await page.getByText("The turn is running. Waiting for its first request capture…", { exact: true }).waitFor();
    const body = {
      model: "local/context-model", stream: true, temperature: 0.25, stream_options: { include_usage: true },
      messages: [
        { role: "system", content: [{ type: "text", text: "# System instructions\n\nUse the tools.", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "Inspect this request" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: '{"cmd":"ls"}' } }] },
        { role: "tool", tool_call_id: "c1", content: "result <script>window.badContext = true</script>" },
      ],
      tools: [{ type: "function", function: { name: "exec", description: "Execute a command", parameters: { type: "object", required: ["cmd"] } } }],
    };
    data = { ...data, lastCall: { model: body.model, at: "2026-09-23T12:00:00Z", system: "# System instructions\n\nUse the tools.", systemChars: 41, tools: ["exec"], messages: 4, format: "wire", request: body } };
    const notify = () => page.evaluate(async (id) => { const { broadcastTurn } = await import("./assets/lib/ext.js"); broadcastTurn({ session: id, event: { type: "context.updated" } }); }, id);
    await notify();
    await page.getByText("local/context-model", { exact: true }).waitFor();
    assert.match(await page.locator("#dock .panel-sub").innerText(), /turn 1 · running/);
    await page.getByText("Full request JSON", { exact: true }).click();
    assert.deepEqual(JSON.parse(await page.locator(".ui-context-raw").innerText()), body);
    await page.getByRole("button", { name: "Copy JSON", exact: true }).click();
    await page.waitForFunction(() => window.copiedContext);
    assert.deepEqual(JSON.parse(await page.evaluate(() => window.copiedContext)), body);
    assert.equal(await page.evaluate(() => window.badContext), undefined, "request content is displayed as text");

    await page.getByRole("tab", { name: "Prompt", exact: true }).click();
    await page.getByRole("heading", { name: "System instructions", exact: true }).waitFor();
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await page.waitForFunction(() => window.copiedContext?.startsWith("# System instructions"));
    await page.getByRole("tab", { name: "Usage", exact: true }).click();
    data = { ...data, usage: [{ id: "t1", firstMessage: 0, calls: 2, status: "running", usage: { cost: 0.032, prompt_tokens: 300, completion_tokens: 40, cache_read_tokens: 80 } }] };
    await notify();
    await page.getByText("$0.0320", { exact: true }).waitFor();
    assert.match(await page.locator(".ui-context-pane").innerText(), /running.*\$0.0320.*2 calls/s);
    data = { ...data, usage: [{ ...data.usage[0], usage: { ...data.usage[0].usage, cost: 0.05 } }] };
    await notify();
    await page.getByText("$0.0500", { exact: true }).waitFor();

    const artifacts = process.env.THETIS_BROWSER_ARTIFACTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, "context-usage.png"), fullPage: true });
    }
    await page.getByRole("tab", { name: "Request", exact: true }).click();
    assert.ok(await page.locator(".ui-context-raw").isVisible(), "expanded request JSON survives tab switches and updates");
    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); });
    await page.getByRole("button", { name: "Copy JSON", exact: true }).click();
    assert.deepEqual(JSON.parse(await page.evaluate(() => window.getSelection().toString())), body, "without clipboard access, the complete JSON is selected for copying");
    await page.evaluate(() => window.getSelection().removeAllRanges());
    if (artifacts) await page.screenshot({ path: join(artifacts, "context-request.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator(".ui-context").isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "request details fit the mobile viewport");
    if (artifacts) await page.screenshot({ path: join(artifacts, "context-mobile.png"), fullPage: true });
    await page.locator("#dock .panel-close").click();
    const before = requests;
    await notify();
    assert.equal(requests, before, "a closed dock does not fetch the request body");
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/context")),
      page.getByRole("button", { name: "Context", exact: true }).click(),
    ]);
    assert.equal(requests, before + 1);
  });
});

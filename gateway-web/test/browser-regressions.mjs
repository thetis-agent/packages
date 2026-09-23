// Optional Chromium checks over the real app. See BROWSER.md for externally installed Playwright and
// executable overrides. These use no live service, credentials, model provider or package lockfile.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { withPage } from "./browser-fixture.mjs";

let browser;
before(async () => {
  const { chromium } = await import(process.env.THETIS_PLAYWRIGHT_MODULE || "playwright-core");
  browser = await chromium.launch({ executablePath: process.env.THETIS_CHROMIUM_EXECUTABLE || undefined, headless: true, args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); });

for (const delay of ["declaration", "module"]) {
  test(`conversation creation waits for extension ${delay} startup`, { timeout: 15000 }, async () => {
    await withPage(browser, `startup-${delay}`, { extension: true, holdUi: delay === "declaration", holdModule: delay === "module" }, async (f) => {
      await f.uiRequested;
      if (delay === "module") await f.page.waitForFunction(() => window.reviewModuleEntered);
      await f.page.locator("#input").fill("Start inside the chosen project");
      await f.page.locator("#input").press("Enter");
      await f.page.waitForFunction(() => window.reviewStore.get("creating") || window.reviewOrder.includes("create"));
      assert.deepEqual(await f.page.evaluate(() => window.reviewOrder), [], "session POST must wait until extension setup completes");
      if (delay === "declaration") f.releaseUi();
      else await f.page.evaluate(() => window.reviewReleaseModule());
      await f.sendRequested;
      await f.idle();
      assert.deepEqual(await f.page.evaluate(() => window.reviewOrder), ["ready", "create"]);
      assert.deepEqual(await f.page.evaluate(() => window.reviewHooks), [f.id]);
      assert.equal(f.sends(), 1);
    });
  });
}

for (const fail of [false, true]) {
  test(`creation hooks ${fail ? "preserve the draft on failure" : "finish before the first send"}`, { timeout: 15000 }, async () => {
    await withPage(browser, fail ? "hook-failure" : "hook-await", { extension: true, holdHook: true }, async (f) => {
      await f.page.waitForFunction(() => window.reviewSetupReady);
      const draft = "Keep this draft until the project is assigned";
      await f.page.locator("#input").fill(draft);
      await f.page.locator("#input").press("Enter");
      await f.page.waitForFunction(() => window.reviewHooks.length === 1);
      assert.equal(f.sends(), 0);
      await f.page.evaluate((fail) => fail ? window.reviewFailHook() : window.reviewReleaseHook(), fail);
      if (fail) {
        await f.page.waitForFunction((draft) => document.querySelector("#input").value === draft, draft);
        assert.equal(f.sends(), 0);
        assert.equal(await f.page.locator("#input").inputValue(), draft);
        assert.match(await f.page.locator(".toast").innerText(), /Project assignment failed/);
      } else {
        await f.sendRequested;
        await f.idle();
        assert.equal(f.sends(), 1);
        assert.match(await f.page.locator(".pane.is-active .transcript").innerText(), /Keep this draft/);
      }
    });
  });
}

for (const reconnect of [false, true]) {
  test(`a late send acknowledgement cannot override ${reconnect ? "a reconnect snapshot" : "a completed turn"}`, { timeout: 15000 }, async () => {
    await withPage(browser, reconnect ? "late-ack-reconnect" : "late-ack-end", { existing: true, holdSend: true }, async (f) => {
      await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
      await f.page.locator("#input").fill("New question");
      await f.page.locator("#input").press("Enter");
      await f.sendRequested;
      if (reconnect) await f.page.evaluate(() => reviewEmit("snapshot", { running: [] }));
      else await f.emit([
        { type: "turn.start", turn: "t_browser" },
        { type: "text", delta: "Completed answer" },
        { type: "message", message: { role: "assistant", content: "Completed answer" } },
        { type: "turn.end", turn: "t_browser" },
      ]);
      assert.equal(await f.running(), false);
      f.releaseSend();
      await f.idle();
      assert.equal(await f.running(), false);
      assert.equal(await f.page.locator("#stop").isVisible(), false);
    });
  });
}

test("a stale history response retains live events received while loading", { timeout: 15000 }, async () => {
  await withPage(browser, "stale-history", { existing: true, holdRecord: true }, async (f) => {
    await f.recordRequested;
    await f.emit([{ type: "turn.start", turn: "t_browser" }, { type: "text", delta: "Live answer before snapshot" }]);
    f.releaseRecord();
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    const transcript = await f.page.locator(".pane.is-active .transcript").innerText();
    assert.match(transcript, /New question/);
    assert.match(transcript, /Live answer before snapshot/);
    assert.equal(transcript.split("Live answer before snapshot").length - 1, 1);
    assert.equal(await f.running(), true);
  });
});

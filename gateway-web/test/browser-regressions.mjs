// Optional Chromium checks over the real app. See BROWSER.md for externally installed Playwright and
// executable overrides. These use no live service, credentials, model provider or package lockfile.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { PNG_1PX, withPage } from "./browser-fixture.mjs";

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

/** Hands the page a synthetic paste or drop carrying one PNG, the way a screenshot tool or a file manager would. */
const deliver = (page, how) => page.evaluate(({ how, png }) => {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const file = new File([bytes], how === "paste" ? "image.png" : "diagram.png", { type: "image/png" });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  if (how === "paste") {
    document.querySelector("#input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  } else {
    const main = document.querySelector("main.main");
    main.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    window.reviewDropping = main.classList.contains("is-dropping");
    main.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }
}, { how, png: PNG_1PX });

for (const how of ["paste", "drop"]) {
  test(`a ${how === "paste" ? "pasted" : "dropped"} image is uploaded, shown in the tray, and sent as an asset part with the text`, { timeout: 15000 }, async () => {
    await withPage(browser, `attach-${how}`, { existing: true }, async (f) => {
      await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
      await deliver(f.page, how);
      if (how === "drop") assert.equal(await f.page.evaluate(() => window.reviewDropping), true, "the drop highlight shows while a file is over the conversation");
      assert.equal(await f.page.evaluate(() => document.querySelector("main.main").classList.contains("is-dropping")), false, "and clears on the drop");
      // The chip shows while the upload travels, then settles with the file's size; the send waits for it.
      await f.page.locator("#attachments .attachment.is-ready").waitFor();
      assert.equal(await f.page.locator("#attachments .attachment").count(), 1);
      assert.equal(await f.page.locator("#attachments img.attachment-thumb").count(), 1, "an image gets a thumbnail");
      const name = await f.page.locator(".attachment-name").innerText();
      if (how === "paste") assert.match(name, /^pasted-\d{8}-\d{6}Z\.png$/, "a clipboard image is named by the clock");
      else assert.equal(name, "diagram.png");
      assert.deepEqual(f.media(), [{ name, mediaType: "image/png", size: 70 }]);
      assert.equal(await f.page.locator("#send").isDisabled(), false, "a picture alone is a message");
      await f.page.locator("#input").fill("What is this?");
      await f.page.locator("#input").press("Enter");
      await f.sendRequested;
      await f.idle();
      assert.deepEqual(f.sent(), [{ input: { role: "user", content: [
        { type: "text", data: { text: "What is this?" } },
        { type: "asset", data: { id: "a_1", mediaType: "image/png", name } },
      ] } }]);
      assert.equal(await f.page.locator("#attachments").isVisible(), false, "the tray empties once sent");
      assert.equal(await f.page.locator("#input").inputValue(), "");
      // The person's own row shows the picture before the server echoes it.
      const row = f.page.locator(".pane.is-active .msg.is-user").last();
      assert.match(await row.innerText(), /What is this\?/);
      assert.equal(await row.locator("img.content-media").count(), 1);
    });
  });
}

test("a pasted image can be removed before sending, and a text-only send still travels as { text }", { timeout: 15000 }, async () => {
  await withPage(browser, "attach-remove", { existing: true }, async (f) => {
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    await deliver(f.page, "paste");
    await f.page.locator("#attachments .attachment.is-ready").waitFor();
    await f.page.locator(".attachment-remove").click();
    assert.equal(await f.page.locator("#attachments").isVisible(), false);
    assert.equal(await f.page.locator("#send").isDisabled(), true, "nothing to send once the picture is gone and the box is empty");
    await f.page.locator("#input").fill("Just words");
    await f.page.locator("#input").press("Enter");
    await f.sendRequested;
    await f.idle();
    assert.deepEqual(f.sent(), [{ text: "Just words" }]);
  });
});

test("a paste of plain text is left to the textarea", { timeout: 15000 }, async () => {
  await withPage(browser, "paste-text", { existing: true }, async (f) => {
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    // The clipboard API needs a secure origin the fixture does not have, so the paste is synthetic; what
    // matters is that the composer does not cancel it, which is what would keep the words out of the box.
    const cancelled = await f.page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "pasted words");
      return !document.querySelector("#input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    assert.equal(cancelled, false, "a text paste keeps its default handling");
    assert.equal(await f.page.locator("#attachments").isVisible(), false);
    assert.deepEqual(f.media(), []);
  });
});

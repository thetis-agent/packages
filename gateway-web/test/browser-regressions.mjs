// Optional Chromium checks over the real app. See BROWSER.md for externally installed Playwright and
// executable overrides. These use no live service, credentials, model provider or package lockfile.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { PNG_1PX, withPage } from "./browser-fixture.mjs";

/** A catalogue like production's: the configured default is not what a new chat starts with. */
const MODELS = {
  model: "anthropic/claude-sonnet-5",
  models: [
    { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", provider: "@thetis/provider-openrouter", contextLength: 1000000, pricing: { prompt: 0.000003, completion: 0.000015 } },
    { id: "anthropic/claude-fable-5.1", name: "Claude Fable 5.1", provider: "@thetis/provider-openrouter", contextLength: 200000 },
    { id: "mistral/small", name: "Mistral Small", provider: "@thetis/provider-openrouter", contextLength: 32000, pricing: { prompt: 0.0000001, completion: 0.0000003 } },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `vendor/model-${i}`, provider: "@thetis/provider-openrouter" })),
  ],
  yours: { model: "anthropic/claude-fable-5.1", recent: ["anthropic/claude-fable-5.1", "vendor/model-3"] },
};

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

// ---- nothing lost: the rows that stay, the retry row, the reconnect loop, the build, the address bar ----

test("a failed turn's Retry posts /resume, and the row is drawn again after a refresh from the record", { timeout: 15000 }, async () => {
  await withPage(browser, "failure-row", { existing: true }, async (f) => {
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    await f.emit([
      { type: "turn.start", turn: "t_browser" },
      { type: "text", delta: "Starting the file" },
      { type: "error", code: "provider", kind: "connection", retryable: true, message: "provider error: the connection closed part-way" },
      { type: "turn.end", turn: "t_browser" },
    ]);
    const row = f.page.locator(".pane.is-active .msg.is-end");
    await row.waitFor();
    assert.match(await row.locator(".end-text").innerText(), /The connection to the model kept dropping, so the reply stopped here/);
    assert.equal(await row.locator(".end-raw").isVisible(), false, "the raw words wait under Details");
    await row.getByRole("button", { name: "Retry" }).click();
    await f.page.waitForFunction(() => document.querySelector(".pane.is-active .end-action")?.textContent === "Retrying…");
    assert.deepEqual(f.posts(), [[`sessions/${f.id}/resume`, null]]);
    // A refresh: the page is rebuilt from the record, which now says the turn was interrupted.
    f.setRecord({ interrupted: { turn: "t_browser", at: new Date().toISOString(), why: "provider", error: { message: "provider error: the connection closed part-way", code: "provider", kind: "connection" } } });
    await f.page.reload();
    await f.reopened();
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    assert.match(await f.page.locator(".pane.is-active .msg.is-end .end-text").innerText(), /kept dropping/);
    assert.equal(await f.page.locator(".pane.is-active .msg.is-end").getByRole("button", { name: "Retry" }).count(), 1);
  });
});

test("a round being retried shows the countdown, Retry now asks harness-core, Stop cancels, and it settles into one line", { timeout: 15000 }, async () => {
  await withPage(browser, "retry-row", { existing: true }, async (f) => {
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    const until = new Date(Date.now() + 8000).toISOString();
    await f.emit([
      { type: "turn.start", turn: "t_browser" },
      { type: "text", delta: "Half a round" },
      { type: "extension", name: "harness-core.retry", data: { phase: "waiting", round: 2, attempt: 1, of: 5, inMs: 8000, until, kind: "connection", reason: "the stream closed part-way" } },
    ]);
    const row = f.page.locator(".pane.is-active .msg.is-end.is-retry");
    await row.waitFor();
    assert.match(await row.locator(".end-text").innerText(), /^The connection to the model dropped\. Retrying in [5-8] s \(2 of 6\)\.$/);
    assert.equal(await f.page.getByText("Half a round").count(), 0, "the half round is taken off the page");
    await row.getByRole("button", { name: "Retry now" }).click();
    await row.getByRole("button", { name: "Stop" }).click();
    await f.page.waitForFunction(() => true);
    await f.page.waitForTimeout(100);
    assert.deepEqual(f.posts(), [["ext/@thetis/harness-core/retry-now", { session: f.id, args: { session: f.id } }], [`sessions/${f.id}/cancel`, null]]);
    assert.match(await f.page.locator(".session-row.is-working, .session-list").first().innerText(), /Reconnecting — attempt 2 of 6/);
    await f.page.evaluate((id) => {
      reviewEmit("turn", { session: id, turn: "t_browser", seq: 4, event: { type: "extension", name: "harness-core.retry", data: { phase: "recovered", round: 2, attempt: 1, of: 5, kind: "connection" } } });
    }, f.id);
    await f.page.getByText("Reconnected after 1 retry.").waitFor();
  });
});

test("the stream reconnects by itself, and a changed build refreshes on the same conversation with the draft kept", { timeout: 20000 }, async () => {
  await withPage(browser, "reconnect-build", { existing: true }, async (f) => {
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    await f.page.evaluate(() => { window.reviewFirstSource = window.reviewEvents; reviewEmit("error", {}); });
    await f.page.waitForFunction(() => document.querySelector("#status").textContent === "Reconnecting…");
    // After a second the page asks /api/me and opens a new stream by itself.
    await f.page.waitForFunction(() => window.reviewEvents !== window.reviewFirstSource, null, { timeout: 5000 });
    await f.page.locator("#input").fill("half a thought I do not want to lose");
    f.setBuild("build-2");
    await f.page.evaluate(() => { reviewEmit("open", {}); reviewEmit("snapshot", { running: [], build: { id: "build-2" } }); });
    await f.page.waitForFunction(() => document.querySelector("#status").textContent === "connected");
    // Something is typed, so it asks rather than taking the page away.
    const card = f.page.locator(".notice");
    await card.waitFor();
    assert.match(await card.innerText(), /Thetis was updated/);
    await card.getByRole("button", { name: "Refresh" }).click();
    await f.page.waitForLoadState("load");
    await f.reopened();
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    assert.equal(new URL(f.page.url()).hash, `#${f.id}`, "the same conversation");
    await f.page.waitForFunction(() => document.querySelector("#input").value === "half a thought I do not want to lose");
  });
});

test("+ creates nothing until the first message, and a hash change switches to another conversation or a subagent", { timeout: 15000 }, async () => {
  const others = [
    { id: "s_bbbb", title: "The other one", conversation: [{ role: "user", content: "Other question" }, { role: "assistant", content: "Other reply" }] },
    { id: "s_cccc", title: "", parent: "s_bbbb", conversation: [{ role: "user", content: "child brief" }, { role: "assistant", content: "child work" }] },
  ];
  await withPage(browser, "new-and-hash", { existing: true, others }, async (f) => {
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    await f.page.locator("#new-tab").click();
    await f.page.locator(".pane.is-empty.is-active .transcript-empty.is-new").waitFor();
    assert.equal(f.creates(), false, "a + is not a conversation yet");
    assert.equal(await f.page.evaluate(() => window.reviewStore.get("current")), null);
    await f.page.evaluate(() => { location.hash = "#s_bbbb"; });
    await f.page.getByText("Other reply", { exact: true }).last().waitFor();
    assert.equal(await f.page.evaluate(() => window.reviewStore.get("current")), "s_bbbb");
    await f.page.evaluate(() => { location.hash = "#s_cccc"; });
    await f.page.getByText("child work", { exact: true }).last().waitFor();
    assert.equal(await f.page.evaluate(() => window.reviewStore.get("current")), "s_cccc");
    assert.equal(await f.page.locator(".pane.is-active").getAttribute("class"), "pane is-agent is-active", "a subagent opens as its own read-only tab");
    assert.equal(f.creates(), false);
  });
});

test("an armed restart is announced to everyone, then waited through, then Thetis is back", { timeout: 20000 }, async () => {
  const restart = { pending: { reason: "update to a01a8e0", by: "root", firesInMs: 20_000, deadlineInMs: 120_000 }, readable: true };
  await withPage(browser, "restart-notice", { existing: true, restart }, async (f) => {
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    await f.emit([{ type: "turn.start", turn: "t_browser" }, { type: "text", delta: "working on it" }]);
    const card = f.page.locator('.notice[data-notice="thetis-restart"]');
    await f.page.waitForFunction(() => /^Thetis restarts in (1\d|20) s · your reply will continue$/.test(document.querySelector('.notice[data-notice="thetis-restart"] .notice-title')?.textContent ?? ""));
    assert.match(await card.locator(".notice-body").innerText(), /Reason: update to a01a8e0\. Your conversations are kept\./);
    assert.equal(await card.locator(".notice-x").count(), 0, "not dismissible while it is true");
    for (const target of ["#send", ".rail-widen"]) {
      const covers = await f.page.evaluate((sel) => {
        const a = document.querySelector('.notice[data-notice="thetis-restart"]').getBoundingClientRect();
        const node = document.querySelector(sel);
        if (!node || !node.getClientRects().length) return false;
        const b = node.getBoundingClientRect();
        return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      }, target);
      assert.equal(covers, false, `the card never sits on ${target}`);
    }
    await f.page.evaluate(() => { window.reviewFirstSource = window.reviewEvents; reviewEmit("error", {}); });
    await f.page.waitForFunction(() => document.querySelector('.notice[data-notice="thetis-restart"] .notice-title')?.textContent.startsWith("Thetis is restarting"));
    await f.page.waitForFunction(() => window.reviewEvents !== window.reviewFirstSource, null, { timeout: 5000 });
    await f.page.evaluate(() => { reviewEmit("open", {}); reviewEmit("snapshot", { running: [] }); });
    await f.page.waitForFunction(() => document.querySelector('.notice[data-notice="thetis-restart"] .notice-title')?.textContent === "Thetis is back.");
  });
});

test("the model picker: a + draft starts on your default, can pick a model, and the pick travels with the create; examples fill the box", { timeout: 20000 }, async () => {
  await withPage(browser, "model-picker", { existing: true, models: MODELS }, async (f) => {
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    await f.page.locator("#new-tab").click();
    const empty = f.page.locator(".pane.is-empty.is-active .transcript-empty.is-new");
    await empty.waitFor();
    assert.match(await empty.locator(".empty-lead").innerText(), /Thetis works in your own space/);
    assert.equal(await empty.locator(".empty-example").count(), 3);
    // The pill shows in the draft, and it names what a new chat really starts with: the last choice.
    const pill = f.page.locator("#composer-tools .picker-btn");
    await pill.waitFor();
    assert.equal(await pill.innerText(), "claude-fable-5.1");
    await pill.click();
    const menu = f.page.locator(".picker-menu");
    assert.deepEqual(await menu.locator(".picker-head").allInnerTexts(), ["NEW CHAT", "YOUR DEFAULT", "RECENT"]);
    assert.match(await menu.locator(".picker-item").first().innerText(), /Claude Fable 5\.1/);
    assert.match(await menu.locator(".picker-item").nth(2).innerText(), /Thetis default · Claude Sonnet 5/);
    const fold = menu.locator(".picker-fold");
    assert.equal(await fold.innerText(), "All models (23)");
    assert.equal(await menu.getByText("Mistral Small").count(), 0, "the catalogue is folded");
    await fold.click();
    const mistral = menu.locator(".picker-item", { hasText: "Mistral Small" });
    assert.deepEqual(await mistral.locator(".picker-col").allInnerTexts(), ["$0.1 / $0.3", "32k"]);
    await mistral.click();
    assert.equal(await pill.innerText(), "small");
    assert.equal(f.creates(), false, "picking a model creates nothing");
    // An example fills the box and sends nothing; Enter sends it, and the create carries the pick.
    await empty.locator(".empty-example").first().click();
    assert.match(await f.page.locator("#input").inputValue(), /^What can you do here\?/);
    assert.equal(f.creates(), false);
    await f.page.locator("#input").press("Enter");
    await f.sendRequested;
    assert.deepEqual(f.createBodies(), [{ model: "mistral/small" }]);
  });
});

test("the rail: every button names itself, and widened it shows the labels in words", { timeout: 15000 }, async () => {
  await withPage(browser, "rail-labels", { existing: true, extras: true }, async (f) => {
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    const todo = f.page.locator('.rail-btn[data-dock="@review/extras#todo"]');
    await todo.waitFor();
    assert.equal(await todo.getAttribute("aria-label"), "Todo");
    assert.equal(await todo.getAttribute("title"), "Todo — The plan the agent is working to");
    assert.equal(await todo.locator(".rail-label").isVisible(), false);
    await f.page.locator(".rail-widen").click();
    assert.equal(await todo.locator(".rail-label").innerText(), "Todo");
    assert.equal(await f.page.locator("#panels-btn").isVisible(), false, "the phone's Panels button stays off a wide screen");
    // Escape closes the dock; with a place opened over it, the place goes first.
    await todo.click();
    await f.page.locator("#dock:not([hidden])").waitFor();
    await f.page.locator("#menu").click();
    assert.deepEqual(await f.page.locator(".sidebar-head .menu .menu-label").allInnerTexts(), ["Files", "Extensions", "Control panel"]);
    await f.page.locator(".sidebar-head .menu .menu-item", { hasText: "Files" }).click();
    await f.page.locator(".review-place").waitFor();
    await f.page.keyboard.press("Escape");
    assert.equal(await f.page.locator("#place").isHidden(), true);
    assert.equal(await f.page.locator("#dock").isHidden(), false, "the dock under the place is still open");
    await f.page.keyboard.press("Escape");
    assert.equal(await f.page.locator("#dock").isHidden(), true);
  });
});

test("a phone: the rail is a Panels menu, a place closes the drawer, Escape takes the top layer, the panel tree is a select, nothing scrolls sideways", { timeout: 20000 }, async () => {
  await withPage(browser, "phone", { existing: true, extras: true, viewport: { width: 390, height: 844 } }, async (f) => {
    await f.page.evaluate(() => localStorage.setItem("thetis.shelf.height", "800"));
    await f.page.getByText("Earlier reply", { exact: true }).last().waitFor();
    await f.page.locator("#panels-btn").waitFor();
    assert.equal(await f.page.locator("#rail").isVisible(), false, "no permanent rail column");
    await f.page.locator("#panels-btn").click();
    assert.deepEqual(await f.page.locator(".menu.is-floating .menu-label").allInnerTexts(), ["Todo", "Files"]);
    await f.page.locator(".menu.is-floating .menu-item", { hasText: "Todo" }).click();
    await f.page.getByText("dock todo").waitFor();
    await f.page.keyboard.press("Escape");
    assert.equal(await f.page.locator("#dock").isHidden(), true);

    // The shelf takes at most two fifths of the height, whatever height was remembered.
    await f.page.evaluate(() => window.reviewOpenShelf());
    await f.page.waitForFunction(() => { const h = document.querySelector("#shelf").getBoundingClientRect().height; return h > 100; });
    await f.page.waitForTimeout(400);
    assert.ok(await f.page.evaluate(() => document.querySelector("#shelf").getBoundingClientRect().height <= innerHeight * 0.4 + 1), "the shelf is capped at 40%");
    await f.page.locator(".shelf-close").click();

    // The menu sits in the drawer; choosing a place closes the drawer.
    await f.page.locator("#toggle-sidebar").click();
    await f.page.waitForFunction(() => document.querySelector("#sidebar").classList.contains("is-open"));
    await f.page.locator("#menu").click();
    const hints = f.page.locator(".sidebar-head .menu .menu-hint");
    assert.ok(await hints.evaluateAll((nodes) => nodes.every((n) => n.scrollWidth <= n.clientWidth + 1)), "no hint is cut off");
    await f.page.locator(".sidebar-head .menu .menu-item", { hasText: "Control panel" }).click();
    await f.page.waitForFunction(() => !document.querySelector("#sidebar").classList.contains("is-open"));
    const select = f.page.locator(".panel-select");
    await select.waitFor();
    assert.equal(await f.page.locator(".panel-tree").isVisible(), false, "the tree gives way to the select");
    assert.ok((await select.locator("option").allInnerTexts()).some((t) => t.trim() === "Extensions"));
    await f.page.getByRole("button", { name: "Manage extensions" }).waitFor();
    assert.equal(await f.page.locator(".panel-page tr.is-clickable, #place tr.is-clickable", { hasText: "@review/extras" }).count() > 0, true, "every installed extension is listed on the section itself");

    // Drawer over the place: Escape closes the drawer first, then the place.
    await f.page.locator("#place .chat-menu").click();
    await f.page.waitForFunction(() => document.querySelector("#sidebar").classList.contains("is-open"));
    await f.page.keyboard.press("Escape");
    await f.page.waitForFunction(() => !document.querySelector("#sidebar").classList.contains("is-open"));
    assert.equal(await f.page.locator("#place").isHidden(), false, "the place is still open");
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "nothing pushes the page sideways");
    await f.page.keyboard.press("Escape");
    assert.equal(await f.page.locator("#place").isHidden(), true);
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
});

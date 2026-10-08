// Lane 1: scripted Chromium regressions for @thetis/sheets over the real gateway-web page. No daemon, no
// fence, no model: `fixtures/browser-fixture.mjs` serves the real assets and modules, declares the package
// from its real manifest, and answers its verbs with the package's own exports over a temporary home; the
// agent's writes are the real `sheet_write` tool. Run from the runtime root, outside `npm test` (the root
// glob takes `*.test.js` only):
//
//   THETIS_PLAYWRIGHT_MODULE=/abs/node_modules/playwright-core/index.mjs \
//   THETIS_CHROMIUM_EXECUTABLE=/abs/chrome \
//   node --test packages/sheets/test/browser.mjs
//
// A failed case saves a screenshot and a trace under THETIS_BROWSER_ARTIFACTS (default: a temp dir).
// THETIS_SHEETS_SHOTS names a directory for the light and dark screenshots of case 13.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launch, withPage } from "./fixtures/browser-fixture.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const t = (name, fn, extra = {}) => test(name, { timeout: 30000, ...extra }, fn);
const mod = process.platform === "darwin" ? "Meta" : "Control";

const BUDGET = [
  ["Item", "Qty", "Price", "Total"],
  ["Widgets", 12, 3.5, "=B2*C2"],
  ["Gadgets", 4, 12.25, "=B3*C3"],
  ["Gizmos", 7, 2, "=B4*C4"],
  ["Sum", "=SUM(B2:B4)", null, "=SUM(D2:D4)"],
];

/** Types into the active cell and commits with `key`. */
async function enter(f, text, key = "Enter") {
  await f.page.keyboard.type(text);
  await f.page.keyboard.press(key);
}

const cellOf = async (f, id, a, tab = 0) => (await f.disk(id)).tabs[tab].cells[a];

// ---- 1. the sidebar and the tab ----

t("1. the sidebar lists the sheet; ＋ makes an Untitled sheet with its title in rename; a row opens its tab", async () => {
  let id;
  await withPage(browser, "sidebar-open", { seed: async (f) => { id = await f.seed("Q4 budget", BUDGET); } }, async (f) => {
    const { page } = f;
    const section = page.locator('.sidebar-section[data-item="@thetis/sheets#sheets"]');
    await section.locator(".sidebar-section-label", { hasText: "Sheets" }).waitFor();
    assert.equal(await section.locator(".sidebar-section-count").innerText(), "1");
    assert.equal(await page.locator(`.sht-row[data-sheet="${id}"] .sht-row-title`).innerText(), "Q4 budget");
    await f.open(id);
    assert.equal(await page.locator(".tab.is-kind.is-active .tab-title").innerText(), "Q4 budget");
    assert.ok(await page.locator(`.sht-row[data-sheet="${id}"]`).evaluate((n) => n.classList.contains("is-active")), "the open sheet's row is marked");
    assert.equal(await f.text("D2"), "42");
    assert.equal(await page.locator(".sht-tabbtn.is-on").innerText(), "Sheet1");
    // ＋ in the section's actions
    await section.locator(".sht-plus").click();
    const input = page.locator(".sht-title-edit");
    await input.waitFor();
    assert.equal(await input.inputValue(), "Untitled sheet");
    await input.fill("Hiring plan");
    await input.press("Enter");
    await f.until(async () => (await page.locator(".sht-row .sht-row-title").allInnerTexts()).includes("Hiring plan"), "the renamed sheet in the sidebar");
    const created = f.callsFor("create")[0].args;
    assert.deepEqual(created, { title: "Untitled sheet", project: null });
    assert.equal(await page.locator(".tab.is-kind.is-active .tab-title").innerText(), "Hiring plan");
  });
});

// ---- 2. typing ----

t("2. typing values and a formula shows the computed result, and the edit reaches the file", async () => {
  let id;
  await withPage(browser, "typing", { seed: async (f) => { id = await f.seed("Typing"); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    await f.clickCell("A1");
    await enter(f, "12");
    await enter(f, "30");
    await enter(f, "=A1+A2*2");
    assert.equal(await f.text("A3"), "72");
    assert.equal(await f.addr().inputValue(), "A4", "Enter moved down");
    await enter(f, "=SUM(A1:A3");
    assert.equal(await f.text("A4"), "114", "an unclosed call is closed when it is committed, as spreadsheets do");
    await f.clickCell("B1");
    await enter(f, "12%", "Tab");
    assert.equal(await f.text("B1"), "12%");
    await enter(f, "$1,234.50", "Tab");
    assert.equal(await f.text("C1"), "$1,234.50");
    assert.equal(await f.addr().inputValue(), "D1", "Tab moved right");
    await f.saved();
    assert.equal(await cellOf(f, id, "A3"), "=A1+A2*2");
    assert.equal(await cellOf(f, id, "B1"), 0.12);
    assert.equal(await cellOf(f, id, "A1"), 12);
    // Escape throws an edit away
    await f.clickCell("A1");
    await page.keyboard.type("999");
    await page.keyboard.press("Escape");
    assert.equal(await f.text("A1"), "12");
    // Delete clears
    await page.keyboard.press("Delete");
    assert.equal(await f.text("A1"), "");
    assert.equal(await f.text("A3"), "60", "the formula follows the cleared cell");
  });
});

// ---- 3. the formula bar ----

t("3. the formula bar mirrors the active cell, edits it, shows the function's help, and points at cells", async () => {
  let id;
  await withPage(browser, "formula-bar", { seed: async (f) => { id = await f.seed("Bar", BUDGET); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    await f.clickCell("D2");
    assert.equal(await f.bar().inputValue(), "=B2*C2");
    assert.equal(await f.addr().inputValue(), "D2");
    await f.clickCell("B2");
    assert.equal(await f.bar().inputValue(), "12");
    await f.bar().click();
    await f.bar().fill("20");
    await f.bar().press("Enter");
    assert.equal(await f.text("B2"), "20");
    assert.equal(await f.text("D2"), "70");
    assert.equal(await f.addr().inputValue(), "B3", "Enter in the bar commits and moves down");
    // function help and suggestions while typing in a cell
    await f.clickCell("F1");
    await page.keyboard.type("=SU");
    await page.locator(".sht-assist .sht-suggest").first().waitFor();
    const names = await page.locator(".sht-assist .sht-suggest-name").allInnerTexts();
    assert.ok(names.includes("SUM") && names.includes("SUMIF"), `suggestions: ${names}`);
    await page.keyboard.type("MIF(");
    await page.locator(".sht-assist .sht-help").waitFor();
    assert.match(await page.locator(".sht-assist .sht-help").innerText(), /^SUMIF\(/);
    assert.equal(await page.locator(".sht-assist .sht-help b").innerText(), "range", "the first argument is marked");
    // point mode: an arrow writes a reference where one may go, and the references are outlined
    await page.keyboard.press("Escape");
    await f.clickCell("F2");
    await page.keyboard.type("=");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.locator(".sht-editor").inputValue(), "=E2");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.locator(".sht-editor").inputValue(), "=D2");
    await page.keyboard.type("+");
    const p = await f.point("B5");
    await page.mouse.click(p.x, p.y);
    assert.equal(await page.locator(".sht-editor").inputValue(), "=D2+B5", "a click while pointing writes the reference");
    assert.equal(await page.locator(".sht-box.is-ref").count(), 2, "both references are outlined");
    await page.keyboard.press("Enter");
    assert.equal(await f.text("F2"), "101", "70 + 31");
    assert.equal(await page.locator(".sht-box.is-ref").count(), 0);
  });
});

// ---- 4. the keyboard ----

t("4. the keyboard walks the grid: arrows, shift to extend, ctrl to the data edge, Home, Tab, PageDown, the address box", async () => {
  let id;
  await withPage(browser, "keyboard", { seed: async (f) => { id = await f.seed("Keys", BUDGET); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    await f.clickCell("A1");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    assert.equal(await f.addr().inputValue(), "B2");
    await page.keyboard.press(`${mod}+ArrowDown`);
    assert.equal(await f.addr().inputValue(), "B5", "to the end of the data run");
    await page.keyboard.press(`${mod}+ArrowDown`);
    assert.equal(await f.addr().inputValue(), "B1000", "past the data, to the grid's edge");
    await page.keyboard.press(`${mod}+Home`);
    assert.equal(await f.addr().inputValue(), "A1");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    assert.equal(await f.addr().inputValue(), "A1:B3");
    assert.equal(await page.locator(".sht-stat-v[data-stat='sum']").innerText(), "16", "Sum of the numbers selected");
    assert.equal(await page.locator(".sht-stat-v[data-stat='count']").innerText(), "2");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press(`${mod}+Shift+ArrowRight`);
    assert.equal(await f.addr().inputValue(), "A1:D3", "ctrl+shift extends to the data edge");
    await page.keyboard.press("ArrowRight");
    assert.equal(await f.addr().inputValue(), "B1", "an arrow collapses the selection");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(await f.addr().inputValue(), "D1");
    await page.keyboard.press("Home");
    assert.equal(await f.addr().inputValue(), "A1");
    await page.keyboard.press("PageDown");
    const after = await f.addr().inputValue();
    assert.ok(/^A\d+$/.test(after) && Number(after.slice(1)) > 15, `PageDown moved a screen: ${after}`);
    await f.addr().click();
    await f.addr().fill("C40");
    await f.addr().press("Enter");
    assert.equal(await f.addr().inputValue(), "C40");
    assert.ok(await f.point("C40"), "the cell typed in the address box is on screen");
    await page.keyboard.press(`${mod}+a`);
    assert.equal(await f.addr().inputValue(), "A1:Z1000");
    await page.keyboard.press("F2");
    assert.equal(await page.locator(".sht-editor").count(), 1, "F2 edits the active cell");
    await page.keyboard.press("Escape");
  });
});

// ---- 5. formatting ----

t("5. bold from the keyboard and the toolbar, and currency from the number-format menu", async () => {
  let id;
  await withPage(browser, "formatting", { seed: async (f) => { id = await f.seed("Format", BUDGET); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    await f.clickCell("A1");
    await f.clickCell("D1", { modifiers: ["Shift"] });
    await page.keyboard.press(`${mod}+b`);
    assert.ok(await f.cell("A1").evaluate((n) => n.classList.contains("is-b")));
    assert.equal(await f.cell("D1").evaluate((n) => getComputedStyle(n).fontWeight), "700");
    assert.equal(await page.locator(".sht-tool[aria-label^='Bold']").getAttribute("aria-pressed"), "true");
    await page.locator(".sht-tool[aria-label^='Bold']").click();
    assert.ok(!(await f.cell("A1").evaluate((n) => n.classList.contains("is-b"))), "the button toggles it off");
    await page.keyboard.press(`${mod}+b`);
    await f.clickCell("C2");
    await f.clickCell("C4", { modifiers: ["Shift"] });
    await page.locator(".sht-fmt").click();
    const labels = await f.menuLabels();
    assert.ok(labels.some((l) => /Currency/.test(l)), `presets: ${labels}`);
    await f.menuItem("Currency").click();
    assert.equal(await f.text("C2"), "$3.50");
    assert.equal(await f.text("C4"), "$2.00");
    assert.equal(await page.locator(".sht-fmt-label").innerText(), "Currency");
    await f.saved();
    const tab = (await f.disk(id)).tabs[0];
    assert.equal(tab.styles.C3.fmt, "$#,##0.00");
    assert.equal(tab.styles.B1.b, true);
    // a fill colour from the palette
    await page.locator(".sht-tool[aria-label='Fill colour']").click();
    await page.locator(".sht-palette .sht-swatch[data-color='#fff2cc']").click();
    assert.equal(await f.cell("C3").evaluate((n) => getComputedStyle(n).backgroundColor), "rgb(255, 242, 204)");
  });
});

// ---- 6. the clipboard ----

t("6. copying a block with a formula and pasting it elsewhere moves the formula's references; plain text pastes as values", async () => {
  let id;
  await withPage(browser, "clipboard", { seed: async (f) => { id = await f.seed("Clip", BUDGET); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    await f.clickCell("B2");
    await f.clickCell("D3", { modifiers: ["Shift"] });
    const copied = await page.evaluate(() => {
      const dt = new DataTransfer();
      document.querySelector(".sht-sink").dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData("text/plain");
    });
    assert.equal(copied, "12\t3.5\t42\n4\t12.25\t49", "the display values as TSV");
    assert.equal(await page.locator(".sht-box.is-copy").count(), 1, "the copied range is marked");
    await f.clickCell("B8");
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      document.querySelector(".sht-sink").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, copied);
    assert.equal(await f.text("D8"), "42");
    assert.equal(await f.addr().inputValue(), "B8:D9", "the pasted block is selected");
    await f.clickCell("D9");
    assert.equal(await f.bar().inputValue(), "=B9*C9", "the formula moved with the block");
    // text from elsewhere: values and formulas through the typing parser
    await f.clickCell("F1");
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "a\t5\nb\t=G1*2\n");
      document.querySelector(".sht-sink").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    assert.equal(await f.text("F2"), "b");
    assert.equal(await f.text("G2"), "10");
    await f.saved();
    assert.equal(await cellOf(f, id, "D9"), "=B9*C9");
    assert.equal(await cellOf(f, id, "G1"), 5);
  });
});

// ---- 7. the fill handle ----

t("7. dragging the fill handle down continues a series and moves formulas", async () => {
  let id;
  await withPage(browser, "fill", { seed: async (f) => { id = await f.seed("Fill", [[1, "=A1*10"], [2, "=A2*10"]]); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    await f.clickCell("A1");
    await f.clickCell("B2", { modifiers: ["Shift"] });
    const handle = page.locator(".sht-fill");
    const box = await handle.boundingBox();
    const target = await f.point("B6");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y - 4, { steps: 6 });
    assert.equal(await page.locator(".sht-box.is-fillto").count(), 1, "the range to fill is shown while dragging");
    await page.mouse.up();
    assert.equal(await f.text("A6"), "6", "the series goes on");
    assert.equal(await f.text("B6"), "60");
    assert.equal(await f.addr().inputValue(), "A1:B6");
    await f.saved();
    assert.equal(await cellOf(f, id, "B5"), "=A5*10");
  });
});

// ---- 8. structure from the context menu ----

t("8. inserting and deleting a row from the right-click menu keeps the formulas pointing at the same cells", async () => {
  let id;
  await withPage(browser, "rows", { seed: async (f) => { id = await f.seed("Rows", BUDGET); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    const p = await f.point("A3");
    await page.mouse.click(p.x, p.y, { button: "right" });
    const labels = await f.menuLabels();
    assert.ok(labels.includes("Insert 1 row above") && labels.includes("Delete row 3") && labels.includes("Insert 1 column left"), `menu: ${labels}`);
    await f.menuItem("Insert 1 row above").click();
    assert.equal(await f.text("A4"), "Gadgets", "the row moved down");
    assert.equal(await f.text("A3"), "");
    await f.clickCell("B6");
    assert.equal(await f.bar().inputValue(), "=SUM(B2:B5)", "the sum grew over the inserted row");
    await f.clickCell("D4");
    assert.equal(await f.bar().inputValue(), "=B4*C4", "a moved formula points at its own row");
    // delete from the row header
    const head = page.locator(".sht-head.is-row", { hasText: /^2$/ });
    await head.click({ button: "right" });
    await f.menuLabels();
    await f.menuItem("Delete row 2").click();
    assert.equal(await f.text("A2"), "", "the empty inserted row is now row 2");
    await f.clickCell("B5");
    assert.equal(await f.bar().inputValue(), "=SUM(B2:B4)", "and the sum shrank");
    assert.equal(await f.text("B5"), "11", "Gadgets and Gizmos: 4 + 7");
    await f.saved();
    assert.equal(await cellOf(f, id, "B5"), "=SUM(B2:B4)");
  });
});

// ---- 9. undo and redo ----

t("9. undo and redo restore values, styles and structure exactly", async () => {
  let id;
  await withPage(browser, "undo", { seed: async (f) => { id = await f.seed("Undo", BUDGET); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    await f.clickCell("B2");
    await enter(f, "100");
    assert.equal(await f.text("D2"), "350");
    await f.clickCell("A1");
    await page.keyboard.press(`${mod}+b`);
    const p = await f.point("A2");
    await page.mouse.click(p.x, p.y, { button: "right" });
    await f.menuLabels();
    await f.menuItem("Delete row 2").click();
    assert.equal(await f.text("A2"), "Gadgets");
    await page.keyboard.press(`${mod}+z`);
    assert.equal(await f.text("A2"), "Widgets", "the deleted row is back");
    assert.equal(await f.text("D2"), "350", "with its formula and value");
    await f.clickCell("B5");
    assert.equal(await f.bar().inputValue(), "=SUM(B2:B4)", "the sum points at the whole range again");
    await page.keyboard.press(`${mod}+z`);
    assert.ok(!(await f.cell("A1").evaluate((n) => n.classList.contains("is-b"))), "bold undone");
    await page.keyboard.press(`${mod}+z`);
    assert.equal(await f.text("B2"), "12", "the value undone");
    assert.equal(await page.locator(".sht-tool[aria-label^='Undo']").isDisabled(), true, "nothing more to undo");
    await page.keyboard.press(`${mod}+y`);
    assert.equal(await f.text("B2"), "100");
    await page.keyboard.press(`${mod}+Shift+z`);
    assert.ok(await f.cell("A1").evaluate((n) => n.classList.contains("is-b")), "bold redone");
    await page.locator(".sht-tool[aria-label^='Redo']").click();
    assert.equal(await f.text("A2"), "Gadgets", "the delete redone from the button");
    await f.saved();
    const disk = (await f.disk(id)).tabs[0];
    assert.equal(disk.cells.A2, "Gadgets");
    assert.equal(disk.styles.A1?.b, true);
  });
});

// ---- 10. another writer ----

t("10. the agent's write arrives: the page reads it, flashes the cells with a note naming the agent, and keeps the selection and an edit in progress", async () => {
  let id;
  await withPage(browser, "live", { seed: async (f) => { id = await f.seed("Live", BUDGET); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    await f.clickCell("A1");
    await f.clickCell("B3", { modifiers: ["Shift"] });
    await f.agentWrite({ sheet: id, cells: { C2: 5, C3: 6 } });
    await f.until(async () => (await f.text("D2")) === "60", "the agent's value computed on the page");
    assert.equal(await f.text("D3"), "24");
    await page.locator(".sht-note:not([hidden])").waitFor();
    assert.match(await page.locator(".sht-note").innerText(), /^Thetis changed C2:C3/);
    assert.ok((await page.locator(".sht-box.is-flash").count()) >= 1, "the changed cells flash");
    assert.equal(await f.addr().inputValue(), "A1:B3", "the selection is kept");
    // an edit in progress survives another write, and the person's own edit is not flashed
    await f.clickCell("E1");
    await page.keyboard.type("draft");
    await f.agentWrite({ sheet: id, cells: { C4: 3 } });
    await f.until(async () => (await f.text("D4")) === "21", "the second write");
    assert.equal(await page.locator(".sht-editor").inputValue(), "draft", "the edit is still open with its text");
    await page.keyboard.press("Enter");
    assert.equal(await f.text("E1"), "draft");
    // an edit not yet sent when another write lands is laid on top of what is read
    await f.clickCell("E2");
    await enter(f, "mine");
    await f.agentWrite({ sheet: id, cells: { C5: 1 } });
    await f.until(async () => (await f.text("C5")) === "1", "the third write");
    assert.equal(await f.text("E2"), "mine");
    await f.saved();
    const disk = await f.disk(id);
    assert.equal(disk.tabs[0].cells.E2, "mine");
    assert.equal(disk.tabs[0].cells.E1, "draft");
    assert.equal(disk.tabs[0].cells.C4, 3, "both writers' cells are in the file");
    assert.ok(disk.changes.some((c) => c.by === "person") && disk.changes.some((c) => c.by === "agent"), "both writers are in the log");
  });
});

// ---- 11. tabs ----

t("11. adding a tab, renaming it by double-click, switching, and a formula across tabs", async () => {
  let id;
  await withPage(browser, "tabs", { seed: async (f) => { id = await f.seed("Tabs", BUDGET); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    await page.locator(".sht-tab-add").click();
    await f.until(async () => (await page.locator(".sht-tabbtn").count()) === 2, "a second tab");
    assert.equal(await page.locator(".sht-tabbtn.is-on").innerText(), "Sheet2");
    assert.equal(await f.text("A1"), "", "the new tab is empty");
    await page.locator(".sht-tabbtn.is-on").dblclick();
    const input = page.locator(".sht-tab-rename");
    await input.waitFor();
    await input.fill("Totals");
    await input.press("Enter");
    await f.until(async () => (await page.locator(".sht-tabbtn.is-on").innerText()) === "Totals", "the renamed tab");
    await f.clickCell("A1");
    await enter(f, "=Sheet1!D5*2");
    assert.equal(await f.text("A1"), "210", "(42 + 49 + 14) × 2");
    await page.locator(".sht-tabbtn", { hasText: "Sheet1" }).click();
    assert.equal(await f.text("D2"), "42", "back on the first tab");
    await f.saved();
    const disk = await f.disk(id);
    assert.deepEqual(disk.tabs.map((x) => x.name), ["Sheet1", "Totals"]);
    assert.equal(disk.tabs[1].cells.A1, "=Sheet1!D5*2");
  });
});

// ---- 12. download ----

t("12. Download this tab as CSV is a link to the export route, which answers an attachment of the values", async () => {
  let id;
  await withPage(browser, "download", { seed: async (f) => { id = await f.seed("Q4 budget", BUDGET); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    await page.locator(".sht-tool[aria-label='More']").click();
    const labels = await f.menuLabels();
    assert.deepEqual(labels, ["Import CSV as a new tab", "Download this tab as CSV", "Download this tab as TSV", "Delete sheet"]);
    // A download a link starts is not routed through the harness, so the link is caught as it is clicked
    // and its route fetched by the page, as the browser would.
    await page.evaluate(() => {
      window.__links = [];
      HTMLAnchorElement.prototype.click = function () { window.__links.push({ href: this.getAttribute("href"), download: this.hasAttribute("download") }); };
    });
    await f.menuItem("Download this tab as CSV").click();
    const [link] = await page.evaluate(() => window.__links);
    assert.ok(link?.download, "a download link");
    assert.equal(link.href, `api/ext/@thetis/sheets/export/raw?args=${encodeURIComponent(JSON.stringify({ id, tab: "Sheet1", format: "csv" }))}`);
    const got = await page.evaluate(async (href) => {
      const res = await fetch(href);
      return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), text: await res.text() };
    }, link.href);
    assert.equal(got.status, 200);
    assert.match(got.type, /^text\/csv/);
    assert.match(got.disposition, /^attachment; filename="Q4 budget - Sheet1\.csv"/);
    assert.match(got.text, /Widgets,12,3.5,42/);
    assert.ok(f.raw.some((r) => r.verb === "export" && r.args.format === "json"), "the tab loaded the workbook through the raw export");
  });
});

// ---- 13. size, freeze, phone, screenshots ----

t("13. a 20000 × 702 tab keeps only the cells in sight in the DOM and repaints a scroll fast; frozen rows stay; light and dark screenshots", async () => {
  const shots = process.env.THETIS_SHEETS_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const colorScheme of ["light", "dark"]) {
    let id;
    await withPage(browser, `big-${colorScheme}`, {
      colorScheme,
      seed: async (f) => {
        id = await f.seed("Q4 budget", [...BUDGET, [], ["Notes", "A long note that runs on over the empty cells to its right"], ["Errors", "=1/0", "=NOPE(1)"]]);
        await f.agentFormat({ sheet: id, range: "A1:D1", bold: true, fill: "#d9ead3" });
        await f.agentFormat({ sheet: id, range: "C2:D5", format: "currency" });
        await f.agentFormat({ sheet: id, range: "A5:D5", bold: true });
        await f.command("save", { id, ops: [{ op: "resize", tab: "t1", rows: 20000, cols: 702 }, { op: "set", tab: "t1", cells: { A20000: "last", ZZ1: "far" } }, { op: "freeze", tab: "t1", rows: 1, cols: 1 }] });
      },
    }, async (f) => {
      const { page } = f;
      await f.open(id);
      await f.clickCell("B3");
      await f.clickCell("D5", { modifiers: ["Shift"] });
      if (shots) await page.screenshot({ path: `${shots}/sheet-${colorScheme}.png` });
      const before = await page.locator(".sht-tab .sht-cell").count();
      assert.ok(before < 200, `only the cells in sight: ${before}`);
      const heads = await page.locator(".sht-tab .sht-head").count();
      assert.ok(heads < 150, `only the headers in sight: ${heads}`);
      await page.locator(".sht-scroller").evaluate((s) => { s.scrollTop = s.scrollHeight; });
      await f.until(async () => (await f.cell("A20000").count()) === 1, "the last row drawn after the scroll");
      assert.equal(await page.locator(".sht-top .sht-cell[data-addr='B1']").count(), 1, "the frozen header row is still drawn");
      assert.ok((await page.locator(".sht-tab .sht-cell").count()) < 200);
      // scrolling the whole 20000 × 702: what one scroll costs the page, measured on the handler itself
      const cost = await page.locator(".sht-scroller").evaluate((s) => {
        const times = [];
        for (let i = 0; i < 60; i++) {
          s.scrollTop = (i * 7919 * 24) % (s.scrollHeight - s.clientHeight);
          s.scrollLeft = (i * 37 * 100) % (s.scrollWidth - s.clientWidth);
          const t0 = performance.now();
          s.dispatchEvent(new Event("scroll"));
          times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        return { median: times[30], worst: times[59], cells: document.querySelectorAll(".sht-tab .sht-cell").length };
      });
      assert.ok(cost.median < 8, `a scroll repaints in well under a frame: ${JSON.stringify(cost)}`);
      await page.keyboard.press(`${mod}+Home`);
      assert.equal(await page.locator(".sht-scroller").evaluate((s) => s.scrollTop + s.scrollLeft), 0, "ctrl+Home goes back to the corner");
      assert.equal(await f.text("B2"), "12");
    });
  }
});

t("14. at phone width the toolbar scrolls sideways, the page does not, and the grid scrolls", async () => {
  const shots = process.env.THETIS_SHEETS_SHOTS;
  let id;
  await withPage(browser, "phone", { viewport: { width: 390, height: 780 }, seed: async (f) => { id = await f.seed("Q4 budget", BUDGET); } }, async (f) => {
    const { page } = f;
    const row = page.locator(`.sht-row[data-sheet="${id}"] .sht-row-open`);
    await page.locator("#toggle-sidebar").click(); // on a phone the sidebar is a drawer
    await page.waitForTimeout(400);
    await f.open(id);
    await page.waitForTimeout(400); // the sidebar's slide out
    const scrolls = await page.locator(".sht-toolbar").evaluate((n) => n.scrollWidth > n.clientWidth);
    assert.ok(scrolls, "the toolbar scrolls sideways on a phone");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the page itself does not scroll sideways");
    const grid = await page.locator(".sht-scroller").evaluate((s) => ({ w: s.scrollWidth > s.clientWidth, h: s.scrollHeight > s.clientHeight }));
    assert.deepEqual(grid, { w: true, h: true }, "the grid scrolls both ways");
    assert.equal(await f.text("D2"), "42");
    if (shots) await page.screenshot({ path: `${shots}/sheet-phone.png` });
  });
});

t("15. header edges resize and fit, headers and the corner select, an error shows its message, and a CSV imports as a new tab", async () => {
  let id;
  await withPage(browser, "headers-import", { seed: async (f) => { id = await f.seed("Heads", [...BUDGET, ["Bad", "=1/0"]]); } }, async (f) => {
    const { page } = f;
    await f.open(id);
    const head = (text) => page.locator(".sht-top .sht-head.is-col", { hasText: new RegExp(`^${text}$`) });
    const b = await head("B").boundingBox();
    await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width + 59, b.y + b.height / 2, { steps: 4 });
    await page.mouse.up();
    assert.equal(Math.round((await head("B").boundingBox()).width), 160, "dragged 60px wider");
    const a = await head("A").boundingBox();
    await page.mouse.dblclick(a.x + a.width - 1, a.y + a.height / 2);
    await f.until(async () => Math.round((await head("A").boundingBox()).width) < 100, "column A fitted to its text");
    await f.saved();
    const disk = (await f.disk(id)).tabs[0];
    assert.equal(disk.widths.B, 160);
    assert.ok(disk.widths.A >= 40 && disk.widths.A < 100, `fitted width ${disk.widths.A}`);
    await page.locator(".sht-head.is-row", { hasText: /^3$/ }).click();
    assert.equal(await f.addr().inputValue(), "A3:Z3", "a row header selects the row");
    await head("C").click();
    await head("D").click({ modifiers: ["Shift"] });
    assert.equal(await f.addr().inputValue(), "C1:D1000", "shift extends over columns");
    await page.locator(".sht-cornerbox").click();
    assert.equal(await f.addr().inputValue(), "A1:Z1000", "the corner selects everything");
    assert.ok((await f.cell("B6").getAttribute("title"))?.length > 3, "an error's message is on hover");
    // import
    await page.locator(".sht-tool[aria-label='More']").click();
    await f.menuLabels();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), f.menuItem("Import CSV as a new tab").click()]);
    await chooser.setFiles({ name: "people.csv", mimeType: "text/csv", buffer: Buffer.from("name,age\nAda,36\nAlan,41\n") });
    await f.until(async () => (await page.locator(".sht-tabbtn.is-on").innerText()) === "people", "the imported tab, switched to");
    assert.equal(await f.text("A2"), "Ada");
    assert.equal(await f.text("B3"), "41");
    const put = f.raw.find((r) => r.verb === "import");
    assert.deepEqual(put.args, { id, name: "people" });
  });
});

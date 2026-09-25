// Lane 1: scripted Chromium regressions for @thetis/ui-workspace over the real gateway-web page. No daemon,
// no fence, no model: `fixtures/browser-fixture.mjs` serves the real assets and modules, declares the
// package from its real manifest, and answers its commands from an in-memory tree. Run from the runtime
// root, outside `npm test` (the root glob takes `*.test.js` only):
//
//   THETIS_PLAYWRIGHT_MODULE=/abs/node_modules/playwright-core/index.mjs \
//   THETIS_CHROMIUM_EXECUTABLE=/abs/chrome \
//   node --test packages/ui-workspace/test/browser.mjs
//
// A failed case saves a screenshot and a trace under THETIS_BROWSER_ARTIFACTS (default: a temp dir).
// The gateway's raw seam (`ext.raw.url/put`), its floating menu (`ext.ui.menu`) and the `message.rendered`
// offer are all exercised; the fixture answers the raw routes from its in-memory tree.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { HOME, KEY, NOVA, ORLEANS, SHARED, USER, launch, seedFs, withPage } from "./fixtures/browser-fixture.mjs";

const TIDE = `${HOME}/src/tide.ts`;

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const t = (name, fn, extra = {}) => test(name, { timeout: 15000, ...extra }, fn);

// ---- 1. the place and the roots ----

for (const role of ["admin", "member"]) {
  t(`1. the place opens from the menu and shows Home, Shared and the project with its states (${role})`, async () => {
    await withPage(browser, `place-roots-${role}`, { role }, async (f) => {
      await f.openPlace();
      const { page } = f;
      assert.equal(await page.locator("#place:not([hidden]) .ws-place").count(), 1);
      assert.equal(await f.row(HOME).locator(".tree-label").innerText(), "Home");
      assert.equal(await f.row(HOME).locator(".ws-mode").innerText(), "rw");
      assert.equal(await f.row(SHARED).locator(".tree-label").innerText(), "Shared");
      assert.equal(await f.row(SHARED).locator(".ws-mode.is-ro").count(), 1);
      assert.deepEqual(await page.locator("#place .ws-group-label").allTextContents(), ["Projects"]);
      const project = page.locator('#place .ws-project[data-key="project:p_nova"]');
      assert.equal(await project.locator(".tree-label").innerText(), "Nova");
      assert.equal(await project.locator(".ws-dot.is-err").count(), 1, "the project dot reflects summary.broken");
      assert.equal(await project.locator(".ws-mode.is-current").count(), 1);
      assert.equal(await project.locator(".tree-count").innerText(), "2 directories");
      assert.equal(await page.locator("#place .ws-note.is-warn .ws-note-text").innerText(), "1 of 2 directories is not usable. An agent in this project cannot read it.");
      assert.equal(await f.row(NOVA).locator(".ws-mode.is-rw").count(), 1);
      assert.equal(await f.row(NOVA).locator(".ws-dot.is-ok").count(), 1);
      assert.equal(await f.row(NOVA).locator(".ws-sub").innerText(), "/srv/games");
      const broken = f.row(ORLEANS);
      assert.match(await broken.getAttribute("class"), /\bis-broken\b/);
      const note = page.locator(`#place .tree-item[data-path="${ORLEANS}"] + .ws-note.is-err`);
      assert.equal(await note.locator(".ws-note-text").innerText(), "Not mounted. An agent cannot read this directory.");
      if (role === "admin") {
        assert.equal(await note.locator(".ws-note-cmd").count(), 0);
        const bind = note.locator(".btn");
        assert.equal(await bind.innerText(), "Bind now");
        await bind.click();
        await page.locator(".toast", { hasText: "Binding orleans… your workspace restarts; the row updates when it is back." }).waitFor();
        assert.deepEqual(f.callsFor("bind").map((c) => c.args), [{ path: ORLEANS, mode: "rw" }]);
        // The explorer's state is stored under this person's name, never under the old unscoped keys.
        const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("thetis.workspace.")));
        assert.ok(keys.includes(`thetis.workspace.${USER}.expanded`), `scoped keys: ${keys}`);
        assert.ok(keys.every((k) => k.startsWith(`thetis.workspace.${USER}.`)), `every key carries the user: ${keys}`);
      } else {
        assert.equal(await note.locator(".btn").count(), 0);
        assert.equal(await note.locator("code.ws-note-cmd").innerText(), `thetis mounts add rae ${ORLEANS}`, "the CLI's mounts add, read-write by default");
        assert.equal(f.callsFor("bind").length, 0);
      }
      assert.ok(f.callsFor("roots").length >= 1);
      assert.equal(f.callsFor("roots")[0].session, f.id, "the roots are asked for the open conversation");
    });
  });
}

t("1b. Bind now: the fence closes under the request (502), one toast says the workspace restarts, the roots are polled until the row is ready; a 400 shows its sentence", async () => {
  await withPage(browser, "bind-restart", { role: "admin" }, async (f) => {
    await f.openPlace();
    const { page } = f;
    const note = page.locator(`#place .tree-item[data-path="${ORLEANS}"] + .ws-note.is-err`);
    const bind = note.locator(".btn", { hasText: "Bind now" });
    // A genuine refusal first: a 400 with a sentence is shown as it is, and nothing is polled.
    f.on("bind", () => { throw new Error(`${ORLEANS} is not a directory the host has.`); });
    await bind.click();
    const refused = page.locator(".toast.is-error .toast-text", { hasText: "is not a directory the host has." });
    await refused.waitFor();
    assert.equal(await refused.innerText(), `${ORLEANS} is not a directory the host has.`);
    await refused.locator("..").locator(".toast-x").click();
    await refused.waitFor({ state: "detached" });
    assert.equal(await bind.isDisabled(), false, "the button is back after a refusal");
    const rootsBefore = f.callsFor("roots").length;
    // Now the normal case: the bind closes the fence and the request dies with a 502; the stub then answers
    // the roots with the directory ready, as the reopened workspace would.
    f.on("bind", (args) => {
      f.on("bind", null);
      f.fs.patchRoots = (roots) => ({ ...roots, projects: roots.projects.map((p) => ({ ...p, directories: p.directories.map((d) => (d.path === ORLEANS ? { ...d, state: "ready", mode: args.mode, mount: { path: ORLEANS, mode: args.mode } } : d)), summary: { ready: 2, broken: 0 } })) });
      throw Object.assign(new Error("Bad Gateway"), { status: 502 });
    });
    await bind.click();
    const binding = page.locator(".toast .toast-text", { hasText: "Binding orleans… your workspace restarts; the row updates when it is back." });
    await binding.waitFor();
    assert.equal(await page.locator(".toast.is-error").count(), 0, "a 502 under a bind is not an error");
    await page.locator(`#place .tree-item[data-path="${ORLEANS}"]:not(.is-broken) .ws-mode.is-rw`).waitFor({ timeout: 6000 });
    await page.locator(".toast .toast-text", { hasText: "orleans is bound." }).waitFor();
    assert.equal(await page.locator(".toast .toast-text", { hasText: "Binding orleans" }).count(), 1, "the restart is said once");
    assert.equal(await note.count(), 0, "the sentence under the row is gone");
    assert.equal(await page.locator('#place .ws-project[data-key="project:p_nova"] .ws-dot.is-err').count(), 0);
    assert.equal(await page.locator("#place .ws-note.ws-summary").count(), 0, "no summary once every directory is usable");
    const polled = f.callsFor("roots").slice(rootsBefore);
    assert.ok(polled.length >= 1, "the roots were asked again after the restart");
    assert.deepEqual(f.callsFor("bind").map((c) => c.args), [{ path: ORLEANS, mode: "rw" }, { path: ORLEANS, mode: "rw" }]);
    // The 400 and the 502 above are this case's own doing; the browser logs each non-2xx answer as a console
    // error of its own, which is not an error of the page. Anything else stays and fails the case.
    const provoked = /^console\.error: Failed to load resource: the server responded with a status of (400|502) /;
    f.errors.splice(0, f.errors.length, ...f.errors.filter((e) => !provoked.test(e)));
  });
}, { timeout: 20000 });

t("1c. a project whose directories are all broken starts expanded even with stored state, and its summary sits outside the collapsible group", async () => {
  const VEGA = "/srv/games/vega";
  const fs = seedFs();
  fs.patchRoots = (roots) => ({
    ...roots,
    projects: [{ id: "p_nova", name: "Nova", current: true, directories: [
      { path: ORLEANS, name: "orleans", parent: "/srv/games", state: "unmounted", mode: "rw", kind: "dir" },
      { path: VEGA, name: "vega", parent: "/srv/games", state: "unmounted", mode: "rw", kind: "dir" },
    ], summary: { ready: 0, broken: 2 } }],
    mounts: [],
  });
  // An earlier visit left Home open and nothing else: the first-visit rule does not apply.
  await withPage(browser, "broken-group", { fs, localStorage: { [`thetis.workspace.${USER}.expanded`]: JSON.stringify([HOME]) } }, async (f) => {
    assert.equal(f.callsFor("roots").length, 0, "nothing has read the roots before the place opens");
    await f.openPlace();
    const { page } = f;
    const project = page.locator('#place .ws-project[data-key="project:p_nova"]');
    await project.waitFor();
    assert.equal(await project.getAttribute("aria-expanded"), "true", "a group with a broken directory opens");
    const summary = page.locator('#place .ws-project[data-key="project:p_nova"] + .ws-note.ws-summary');
    assert.equal(await summary.locator(".ws-note-text").innerText(), "2 of 2 directories are not usable. An agent in this project cannot read them.");
    assert.equal(await page.locator("#place .tree-group .ws-note.ws-summary").count(), 0, "the summary is not inside the group");
    await f.row(ORLEANS).waitFor();
    await f.row(VEGA).waitFor();
    assert.equal(await page.locator(`#place .tree-item[data-path="${VEGA}"] + .ws-note.is-err .btn`).innerText(), "Bind now");
    await project.click();
    await page.locator('#place .ws-project[data-key="project:p_nova"][aria-expanded="false"]').waitFor();
    assert.equal(await f.row(ORLEANS).count(), 0, "the rows fold away");
    assert.equal(await summary.count(), 1, "the sentence stays under the project row when it is collapsed");
    assert.equal(await summary.isVisible(), true);
  });
});

// ---- 2. expanding, dotfiles, the 500 cap ----

t("2. expanding a folder lists it once; dotfiles wait for the checkbox; the 500-cap note shows", async () => {
  await withPage(browser, "expand-list", {}, async (f) => {
    await f.openPlace();
    const src = `${HOME}/src`;
    await f.row(src).waitFor();
    assert.equal(f.callsFor("list").filter((c) => c.args.path === src).length, 0, "a folder is not listed before it is opened");
    await f.expand(src);
    await f.row(TIDE).waitFor();
    assert.equal(await f.row(`${src}/lib`).count(), 1);
    assert.equal(f.callsFor("list").filter((c) => c.args.path === src).length, 1, "one list request for one expansion");
    assert.equal(await f.row(`${src}/.env`).count(), 0, "dotfiles are hidden by default");
    assert.equal(await f.row(`${HOME}/.secret`).count(), 0);
    await f.page.locator("#place .ws-check-input").check();
    await f.row(`${src}/.env`).waitFor();
    assert.match(await f.row(`${src}/.env`).getAttribute("class"), /\bis-hidden\b/);
    await f.row(`${HOME}/.secret`).waitFor();
    const srcLists = f.callsFor("list").filter((c) => c.args.path === src);
    assert.equal(srcLists.length, 2);
    assert.equal(srcLists[1].args.hidden, true);
    await f.expand(`${HOME}/big`);
    const note = f.page.locator("#place .ws-note.is-info", { hasText: "The first 500 entries are shown" });
    await note.waitFor();
    assert.equal(await note.innerText(), "The first 500 entries are shown; the filter narrows only these.");
  });
});

// ---- 3. a markdown tab: rendered first, source on the toggle ----

t("3. a markdown file opens rendered in a tab with the strip filled; Source shows the editor", async () => {
  await withPage(browser, "markdown-tab", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    const readme = `${HOME}/README.md`;
    await f.row(readme).click();
    const tab = f.tab(readme);
    await tab.waitFor();
    assert.match(await tab.getAttribute("class"), /\bis-active\b/);
    assert.equal(await tab.locator(".ws-tab-name").innerText(), "README.md");
    const rendered = page.locator(`.ws-pane[data-path="${readme}"] .ws-rendered`);
    await rendered.waitFor();
    assert.equal(await rendered.locator(".md-h").first().innerText(), "Rae", "the shell's renderer drew the heading");
    assert.equal(await rendered.locator("strong").innerText(), "world");
    // A relative image resolves against the file's directory and loads through the raw route.
    const img = rendered.locator("img.md-img");
    assert.equal(await img.count(), 1);
    assert.equal(await img.getAttribute("alt"), "chart");
    assert.deepEqual(JSON.parse(new URL(await img.getAttribute("src"), "http://x/").searchParams.get("args")), { path: `${HOME}/img/chart.png` });
    await img.evaluate((node) => node.complete && node.naturalWidth > 0 ? true : new Promise((done) => { node.onload = () => done(true); node.onerror = () => done(false); }));
    assert.equal(await img.evaluate((node) => node.naturalWidth), 1, "the picture drew");
    assert.equal(await rendered.locator(".ws-img-missing").count(), 0);
    assert.deepEqual(f.rawFor("raw").map((r) => [r.args, r.status]), [[{ path: `${HOME}/img/chart.png` }, 200]]);
    const seg = page.locator(".ws-tabs-right .ws-seg");
    assert.deepEqual(await seg.locator(".ws-seg-btn").allInnerTexts(), ["Rendered", "Source"]);
    assert.equal(await seg.locator('.ws-seg-btn[data-mode="rendered"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".ws-strip .ws-strip-path").innerText(), "README.md");
    assert.equal(await page.locator(".ws-strip .ws-strip-root").innerText(), "Home · rw");
    assert.equal(await page.locator(".ws-strip .ws-strip-lang").innerText(), "Markdown");
    assert.equal(await page.locator(".ws-strip .ws-strip-size").innerText(), `${Buffer.byteLength(f.fs.text(readme))} B`);
    await seg.locator('.ws-seg-btn[data-mode="source"]').click();
    await page.locator(`.ws-pane[data-path="${readme}"] .cm-editor .cm-content`).waitFor();
    assert.equal(await rendered.count(), 0);
    assert.equal(await seg.locator('.ws-seg-btn[data-mode="source"]').getAttribute("aria-pressed"), "true");
    assert.match(await page.locator(`.ws-pane[data-path="${readme}"] .cm-content`).innerText(), /# Rae/);
    assert.deepEqual(f.callsFor("read").map((c) => c.args.path), [readme], "the text was read once; the toggle reuses it");
  });
});

t("3b. a relative image the raw route refuses becomes the placeholder on its one error, and is never asked for again", async () => {
  await withPage(browser, "markdown-missing-image", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    const broken = `${HOME}/broken.md`;
    await f.row(broken).click();
    const rendered = page.locator(`.ws-pane[data-path="${broken}"] .ws-rendered`);
    await rendered.waitFor();
    const missing = rendered.locator(".ws-img-missing");
    await missing.waitFor();
    assert.equal(await missing.count(), 1, "only the missing image is a placeholder");
    assert.equal(await missing.locator(".ws-img-missing-alt").innerText(), "missing");
    assert.equal(await missing.locator(".ws-img-missing-note").innerText(), "The image was not found at img/nope.png.");
    assert.equal(await missing.getAttribute("title"), "img/nope.png");
    const img = rendered.locator("img.md-img");
    assert.equal(await img.count(), 1, "the failed img element is gone, so nothing asks again; the good one stays");
    assert.equal(await img.getAttribute("alt"), "chart");
    await img.evaluate((node) => node.complete && node.naturalWidth > 0 ? true : new Promise((done) => { node.onload = () => done(true); node.onerror = () => done(false); }));
    await new Promise((r) => setTimeout(r, 300));
    const hits = f.rawFor("raw").map((r) => [r.args.path, r.status]).sort();
    assert.deepEqual(hits, [[`${HOME}/img/chart.png`, 200], [`${HOME}/img/nope.png`, 400]], "each image was asked exactly once");
    // The refused image is the browser's own "Failed to load resource" line, not an error of the page.
    f.errors.splice(0, f.errors.length, ...f.errors.filter((e) => !/^console\.error: Failed to load resource: the server responded with a status of 400 /.test(e)));
  });
});

// ---- 4. dirty, save, conflict, keep mine ----

t("4. typing marks the tab dirty; Ctrl+S posts write with the etag; a conflict shows the banner; Keep mine forces", async () => {
  await withPage(browser, "save-conflict", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    await f.expand(`${HOME}/src`);
    await f.row(TIDE).click();
    const editor = page.locator(`.ws-pane[data-path="${TIDE}"] .cm-editor .cm-content`);
    await editor.waitFor();
    const etagAtOpen = f.fs.etag(TIDE);
    assert.equal(f.callsFor("read")[0].args.path, TIDE);
    const tab = f.tab(TIDE);
    assert.doesNotMatch(await tab.getAttribute("class"), /\bis-dirty\b/);
    await editor.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("edited in the browser\n");
    await page.locator(`.ws-tab[data-path="${TIDE}"].is-dirty`).waitFor();
    assert.equal(await tab.locator(".ws-tab-dirty").getAttribute("aria-label"), "unsaved");
    assert.equal(await page.locator(".ws-strip-saved").innerText(), "Unsaved changes");
    assert.equal(await page.locator(".ws-tabs-right .btn", { hasText: "Save" }).isDisabled(), false);
    // The first write meets a newer file on disk: the stub answers the conflict shape once.
    f.on("write", (args, { next }) => {
      f.on("write", null);
      return { ok: false, conflict: true, current: { etag: "9999-99", size: 99, mtime: new Date().toISOString(), text: "theirs\n" } };
    });
    await page.keyboard.press("Control+s");
    const banner = page.locator('.ws-banner.is-warn[data-banner="conflict"]');
    await banner.waitFor();
    assert.match(await banner.locator(".ws-banner-text").innerText(), /This file changed on disk .* while you were editing\./);
    assert.deepEqual(await banner.locator(".btn").allInnerTexts(), ["Show diff", "Load theirs", "Keep mine"]);
    const writes = f.callsFor("write");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].args.path, TIDE);
    assert.equal(writes[0].args.etag, etagAtOpen, "the save carries the etag captured at open");
    assert.equal(writes[0].args.force, undefined);
    assert.match(writes[0].args.text, /^edited in the browser\n/);
    assert.match(await tab.getAttribute("class"), /\bis-dirty\b/, "the buffer stays dirty under a conflict");
    await banner.locator(".btn", { hasText: "Show diff" }).click();
    await page.locator(".ws-diff").waitFor();
    assert.ok((await page.locator(".ws-diff .ws-diff-line.is-add").count()) >= 1);
    await banner.locator(".btn", { hasText: "Keep mine" }).click();
    await page.locator(`.ws-tab[data-path="${TIDE}"]:not(.is-dirty)`).waitFor();
    assert.equal(await banner.count(), 0);
    const forced = f.callsFor("write");
    assert.equal(forced.length, 2);
    assert.equal(forced[1].args.force, true);
    assert.equal(forced[1].args.etag, etagAtOpen);
    assert.equal(forced[1].args.text, forced[0].args.text);
    assert.match(f.fs.text(TIDE), /^edited in the browser\n/, "the forced write reached the tree");
    assert.equal(await page.locator(".ws-strip-saved").innerText(), "Saved just now");
  });
});

t("4b. typing a slash in the editor keeps the focus in the editor (the shell's / shortcut must not take it)", async () => {
  await withPage(browser, "slash-in-editor", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    await f.expand(`${HOME}/src`);
    await f.row(TIDE).click();
    const editor = page.locator(`.ws-pane[data-path="${TIDE}"] .cm-editor .cm-content`);
    await editor.waitFor();
    await editor.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("// a comment\n");
    const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id, cm: Boolean(document.activeElement?.classList.contains("cm-content")) }));
    const leaked = await page.locator("#session-search").inputValue();
    assert.equal(focus.cm, true, `the editor should keep the focus after a slash; it is on ${focus.tag}#${focus.id} and the session search holds ${JSON.stringify(leaked)}`);
    assert.equal(leaked, "", "nothing leaked into the session search");
    await page.locator(`.ws-tab[data-path="${TIDE}"].is-dirty`).waitFor();
    assert.match(await editor.innerText(), /^\/\/ a comment/, "the whole comment landed in the file");
  });
});

// ---- 5. a read-only root ----

t("5. a file on the shared root shows the info banner, no Save, closes from its tab, and Copy to Home writes shared/<path> under the home and opens the copy", async () => {
  await withPage(browser, "readonly-copy", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    await f.expand(SHARED);
    const policy = `${SHARED}/policy.txt`;
    await f.row(policy).click();
    const tab = f.tab(policy);
    await tab.waitFor();
    await page.locator(`.ws-pane[data-path="${policy}"] .ws-view-editor.is-readonly .cm-editor`).waitFor();
    assert.match(await tab.getAttribute("class"), /\bis-ro\b/);
    assert.equal(await tab.locator(".ws-tab-lock").count(), 1, "the lock glyph stays");
    assert.equal(await tab.locator(".ws-tab-close").count(), 1, "and a read-only tab has a close button like any other");
    const banner = page.locator('.ws-banner.is-info[data-banner="readonly"]');
    await banner.waitFor();
    assert.equal(await banner.locator(".ws-banner-text").innerText(), "Shared is read-only for you. You can read and download this file. To change it, copy it to Home or ask an admin.");
    assert.equal(await page.locator(".ws-tabs-right .btn", { hasText: "Save" }).count(), 0, "no Save on a read-only file");
    assert.equal(await page.locator(".ws-tabs-right .btn", { hasText: "Copy to Home" }).count(), 1);
    assert.equal(await page.locator(".ws-strip-root").innerText(), "Shared · ro");
    assert.equal(await page.locator(".ws-strip-saved").innerText(), "Read-only");
    assert.equal(await page.locator(`.ws-pane[data-path="${policy}"] .cm-content`).getAttribute("contenteditable"), "false");
    await banner.locator(".btn", { hasText: "Copy to Home" }).click();
    const target = "shared/policy.txt"; // home-relative: the server resolves it against home, and never sees `~/`
    const copyPath = `${HOME}/${target}`;
    await f.until(() => f.callsFor("write").length === 1, "the copy's write");
    assert.equal(await page.locator('.ws-banner.is-err[data-banner="error"]').count(), 0, `the copy failed: ${await page.locator('.ws-banner.is-err .ws-banner-text').allInnerTexts()}`);
    const copyTab = f.tab(copyPath);
    await copyTab.waitFor();
    const writes = f.callsFor("write");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].args.path, target, "the copy goes to shared/<path under the shared root>, relative to home");
    assert.doesNotMatch(writes[0].args.path, /^~/, "never a literal ~");
    assert.equal(writes[0].args.text, "Shared policy\n");
    assert.equal(writes[0].args.etag, undefined);
    assert.equal(f.fs.text(copyPath), "Shared policy\n");
    assert.equal(f.fs.has(`${HOME}/~`), false, "no directory called ~");
    await page.locator(`.ws-pane[data-path="${copyPath}"] .cm-editor .cm-content`).waitFor();
    assert.match(await copyTab.getAttribute("class"), /\bis-active\b/, "the copy opens by the absolute path the write answered");
    assert.doesNotMatch(await copyTab.getAttribute("class"), /\bis-ro\b/, "the copy is writable");
    assert.equal(await page.locator(".ws-strip-root").innerText(), "Home · rw");
    assert.equal(await page.locator(".ws-strip-path").innerText(), target);
    // The two tabs are told apart by their parent labels.
    assert.equal(await tab.locator(".ws-tab-path").innerText(), "/srv/shared");
    assert.equal(await copyTab.locator(".ws-tab-path").innerText(), "…/rae/shared");
    assert.notEqual(await tab.locator(".ws-tab-path").innerText(), await copyTab.locator(".ws-tab-path").innerText());
    // The read-only tab closes from its own close button.
    await tab.hover();
    await tab.locator(".ws-tab-close").click();
    await tab.waitFor({ state: "detached" });
    assert.equal(await copyTab.count(), 1, "the copy's tab stays");
  });
});

t("5b. the Rendered view of a markdown file on the shared root shows the read-only notice and Copy to Home; the copy opens and Home re-lists with the new folder", async () => {
  await withPage(browser, "readonly-rendered-copy", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    await f.expand(SHARED);
    const guide = `${SHARED}/guide.md`;
    await f.row(guide).click();
    const pane = page.locator(`.ws-pane[data-path="${guide}"]`);
    await pane.locator(".ws-rendered .md-h").waitFor();
    assert.equal(await page.locator('.ws-tabs-right .ws-seg-btn[data-mode="rendered"]').getAttribute("aria-pressed"), "true", "rendered, not the editor");
    const banner = pane.locator('.ws-banner.is-info[data-banner="readonly"]');
    await banner.waitFor();
    assert.equal(await banner.locator(".ws-banner-text").innerText(), "Shared is read-only for you. You can read and download this file. To change it, copy it to Home or ask an admin.");
    assert.equal(await banner.locator(".btn", { hasText: "Copy to Home" }).count(), 1);
    assert.equal(await page.locator(".ws-tabs-right .btn", { hasText: "Copy to Home" }).count(), 1, "the control sits in the right cluster too");
    assert.equal(await page.locator(".ws-tabs-right .btn", { hasText: "Save" }).count(), 0);
    const homeListsBefore = f.callsFor("list").filter((c) => c.args.path === HOME).length;
    assert.equal(await f.row(`${HOME}/shared`).count(), 0, "no shared folder under Home yet");
    await page.locator(".ws-tabs-right .btn", { hasText: "Copy to Home" }).click();
    const copyPath = `${HOME}/shared/guide.md`;
    await f.until(() => f.callsFor("write").length === 1, "the copy's write");
    assert.deepEqual(f.callsFor("write").map((c) => [c.args.path, c.args.text]), [["shared/guide.md", "# Guide\n"]]);
    const copyTab = f.tab(copyPath);
    await copyTab.waitFor();
    await page.locator(`.ws-pane[data-path="${copyPath}"] .ws-rendered .md-h`).waitFor();
    assert.match(await copyTab.getAttribute("class"), /\bis-active\b/);
    assert.equal(await page.locator(`.ws-pane[data-path="${copyPath}"] .ws-banner[data-banner="readonly"]`).count(), 0, "the copy is writable: no notice");
    assert.equal(await page.locator(".ws-tabs-right .btn", { hasText: "Copy to Home" }).count(), 0);
    assert.equal(await page.locator(".ws-strip-root").innerText(), "Home · rw");
    // Home was re-listed and the new folder is in the tree without a manual refresh.
    await f.row(`${HOME}/shared`).waitFor();
    assert.ok(f.callsFor("list").filter((c) => c.args.path === HOME).length > homeListsBefore, "the Home listing was dropped and read again");
    // Switching the copy of the original to Source keeps the notice on the original tab.
    await f.tab(guide).click();
    await page.locator(`.ws-pane[data-path="${guide}"]:not([hidden])`).waitFor();
    await page.locator('.ws-tabs-right .ws-seg-btn[data-mode="source"]').click();
    await pane.locator(".cm-editor .cm-content").waitFor();
    assert.equal(await pane.locator('.ws-banner[data-banner="readonly"]').count(), 1, "the editor's notice, once");
    assert.equal(await page.locator(".ws-tabs-right .btn", { hasText: "Copy to Home" }).count(), 1);
  });
});

// ---- 6. uploads, downloads, previews and large files through the raw seam ----

/** Drops synthetic files on a node: `[{ name, size?, text? }]`; a size fills the file with zero bytes. */
const dropFiles = (locator, files) => locator.evaluate((node, files) => {
  const transfer = new DataTransfer();
  for (const f of files) transfer.items.add(new File([f.size ? new Uint8Array(f.size) : f.text ?? `contents of ${f.name}`], f.name, { type: "text/plain" }));
  node.dispatchEvent(new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  window.reviewDropping = node.classList.contains("is-drop");
  node.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
}, files);

t("6. two dropped files travel as two raw PUTs with progress; a taken name asks before it is replaced; an over-cap row is never sent; a 413 marks only its row", async () => {
  await withPage(browser, "upload-drop", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    const srcPath = `${HOME}/src`;
    const src = f.row(srcPath);
    await f.expand(srcPath);
    await dropFiles(src, [{ name: "one.txt", text: "first" }, { name: "two.txt", text: "second one" }]);
    assert.equal(await page.evaluate(() => window.reviewDropping), true, "the folder row highlights while files are over it");
    assert.doesNotMatch(await src.getAttribute("class"), /\bis-drop\b/, "and clears on the drop");
    const card = page.locator("#place .ws-place .ws-uploads");
    await card.waitFor();
    const rows = card.locator(".ws-upload-row");
    assert.equal(await rows.count(), 2);
    assert.deepEqual(await rows.locator(".ws-upload-name").allInnerTexts(), ["one.txt", "two.txt"]);
    await card.locator('.ws-upload-row[data-state="done"]').nth(1).waitFor();
    assert.deepEqual(await rows.locator(".ws-upload-status").allInnerTexts(), ["Done", "Done"]);
    assert.deepEqual(await rows.locator(".ws-upload-bar").evaluateAll((els) => els.map((e) => e.getAttribute("aria-valuenow"))), ["100", "100"]);
    const puts = f.rawFor("upload");
    assert.deepEqual(puts.map((r) => [r.method, r.args, r.size, r.status]), [
      ["PUT", { dir: srcPath, name: "one.txt" }, 5, 200],
      ["PUT", { dir: srcPath, name: "two.txt" }, 10, 200],
    ], "one PUT per file, in order, with the bytes as the whole body");
    assert.equal(f.fs.text(`${srcPath}/one.txt`), "first");
    await f.row(`${srcPath}/two.txt`).waitFor();
    assert.equal(await f.row(`${srcPath}/one.txt`).count(), 1, "the listing was refreshed with the new files");
    await page.locator(".toast .toast-text", { hasText: "Uploaded 2 files to src." }).waitFor();
    // A name already taken: the server says so, the row asks, Replace resends with `replace: true`.
    await dropFiles(src, [{ name: "one.txt", text: "first, again" }]);
    const again = card.locator(".ws-upload-row", { hasText: "one.txt" }).last();
    await card.locator('.ws-upload-row[data-state="warn"]').waitFor();
    assert.equal(await again.locator(".ws-upload-status").innerText(), "Already there");
    const pop = page.locator('.popover[role="dialog"]');
    await pop.waitFor();
    assert.equal(await pop.locator(".popover-head span").first().innerText(), "Replace one.txt?");
    assert.match(await pop.locator(".kv").innerText(), /In\s+\/home\/rae\/src/);
    await pop.locator(".popover-actions .btn.is-warn").click();
    await card.locator('.ws-upload-row[data-state="done"]', { hasText: "Replaced" }).waitFor();
    const replaced = f.rawFor("upload").slice(2);
    assert.deepEqual(replaced.map((r) => r.args), [{ dir: srcPath, name: "one.txt" }, { dir: srcPath, name: "one.txt", replace: true }]);
    assert.equal(f.fs.text(`${srcPath}/one.txt`), "first, again");
    // Over the 64 MB cap: marked in the card, never sent. Then a lower server cap: the 413 lands on its row only.
    await dropFiles(src, [{ name: "huge.bin", size: 64 * 1024 * 1024 + 1 }]);
    const huge = card.locator(".ws-upload-row", { hasText: "huge.bin" });
    await card.locator('.ws-upload-row[data-state="err"]', { hasText: "huge.bin" }).waitFor();
    assert.equal(await huge.locator(".ws-upload-status").innerText(), "Over 64 MB");
    assert.equal(f.rawFor("upload").length, 4, "the over-cap file was never sent");
    f.setUploadCap(1024);
    await dropFiles(src, [{ name: "small.txt", text: "ok" }, { name: "medium.bin", size: 2048 }]);
    await card.locator('.ws-upload-row[data-state="done"]', { hasText: "small.txt" }).waitFor();
    await card.locator('.ws-upload-row[data-state="err"]', { hasText: "medium.bin" }).waitFor();
    assert.equal(await card.locator(".ws-upload-row", { hasText: "medium.bin" }).locator(".ws-upload-status").innerText(), "That upload is larger than 1 KB.");
    assert.equal(await card.locator(".ws-upload-row", { hasText: "small.txt" }).locator(".ws-upload-status").innerText(), "Done");
    assert.deepEqual(f.rawFor("upload").slice(4).map((r) => [r.args.name, r.status]), [["small.txt", 200], ["medium.bin", 413]]);
    assert.equal(f.fs.has(`${srcPath}/medium.bin`), false);
    // The 413 above is this case's own doing; the browser logs it as a resource error, which is not an error of the page.
    f.errors.splice(0, f.errors.length, ...f.errors.filter((e) => !/^console\.error: Failed to load resource: the server responded with a status of 413 /.test(e)));
  });
});

t("6b. a text file over 200 KB opens through the raw GET with the header's etag; the 6 MB file opens read-only on its head and Show last 4 MB fetches the tail", async () => {
  await withPage(browser, "raw-text", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    const csv = `${HOME}/data.csv`;
    await f.row(csv).click();
    const editor = page.locator(`.ws-pane[data-path="${csv}"] .cm-editor .cm-content`);
    await editor.waitFor();
    assert.equal(f.callsFor("read").length, 1);
    assert.deepEqual(f.rawFor("raw").map((r) => [r.method, r.args]), [["GET", { path: csv }]], "the text came through the raw route");
    assert.equal(await page.locator(`.ws-pane[data-path="${csv}"] .cm-line`).first().innerText(), `1,row-1,${"x".repeat(40)}`);
    assert.match(await page.locator(".ws-strip-size").innerText(), /^\d+ KB$/);
    assert.ok(f.fs.text(csv).length > 200_000, "the fixture file is over the inline limit");
    const etagAtOpen = f.fs.etag(csv);
    await editor.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("id,");
    await page.locator(`.ws-tab[data-path="${csv}"].is-dirty`).waitFor();
    await page.keyboard.press("Control+s");
    await page.locator(`.ws-tab[data-path="${csv}"]:not(.is-dirty)`).waitFor();
    assert.equal(f.callsFor("write")[0].args.etag, etagAtOpen, "the save carries the etag the raw answer's header gave");
    assert.match(f.fs.text(csv), /^id,1,row-1,/);
    // The 6 MB file: read-only head, then the tail.
    const huge = `${HOME}/huge.log`;
    await f.row(huge).click();
    const pane = page.locator(`.ws-pane[data-path="${huge}"]`);
    await pane.locator(".cm-editor .cm-content").waitFor();
    const banner = page.locator('.ws-banner.is-info[data-banner="large"]');
    await banner.waitFor();
    assert.equal(await banner.locator(".ws-banner-text").innerText(), "This file is 6 MB, more than the editor opens; this is its first 4 MB, read-only.");
    assert.equal(await pane.locator(".cm-content").getAttribute("contenteditable"), "false");
    assert.match(await pane.locator(".cm-line").first().innerText(), /^line-1 /);
    assert.deepEqual(f.rawFor("raw").slice(1).map((r) => r.args), [{ path: huge, part: "head" }]);
    await banner.locator(".btn", { hasText: "Show last 4 MB" }).click();
    await banner.locator(".btn", { hasText: "Show first 4 MB" }).waitFor();
    assert.equal(await banner.locator(".ws-banner-text").innerText(), "This file is 6 MB, more than the editor opens; this is its last 4 MB, read-only.");
    assert.deepEqual(f.rawFor("raw").slice(2).map((r) => r.args), [{ path: huge, part: "tail" }]);
    assert.doesNotMatch(await pane.locator(".cm-line").first().innerText(), /^line-1 /, "the tail starts elsewhere");
    assert.equal(f.callsFor("read").filter((c) => c.args.path === huge).length, 2, "head and tail were each asked once");
  });
});

t("6c. a PNG previews from the raw URL with Fit and 1:1; Download and Download as zip go to the raw and zip routes", async () => {
  await withPage(browser, "raw-media", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    const png = `${HOME}/photo.png`;
    await f.row(png).click();
    const pane = page.locator(`.ws-pane[data-path="${png}"]`);
    const img = pane.locator(".ws-view-image .ws-media.is-fit img.ws-img");
    await img.waitFor();
    const src = await img.getAttribute("src");
    assert.match(src, /^api\/ext\/@thetis\/ui-workspace\/raw\/raw\?args=/, "the image points at the raw route");
    assert.deepEqual(JSON.parse(new URL(src, "http://x/").searchParams.get("args")), { path: png });
    await pane.locator(".ws-facts", { hasText: "1 × 1" }).waitFor();
    assert.deepEqual(f.rawFor("raw").map((r) => [r.method, r.args, r.status]), [["GET", { path: png }, 200]]);
    const seg = page.locator(".ws-tabs-right .ws-seg");
    assert.deepEqual(await seg.locator(".ws-seg-btn").allInnerTexts(), ["Fit", "1:1"]);
    await seg.locator('.ws-seg-btn[data-mode="actual"]').click();
    await pane.locator(".ws-media.is-actual").waitFor();
    // Downloads: the page navigates to the raw URL (a download the browser handles), so the request is the evidence.
    const downloads = [];
    page.on("download", (d) => downloads.push(d.suggestedFilename()));
    await f.contextMenu(f.row(`${HOME}/notes.txt`));
    await f.menuItem("Download").click();
    await f.until(() => f.rawFor("raw").length === 2, "the file download request");
    assert.deepEqual(f.rawFor("raw")[1].args, { path: `${HOME}/notes.txt`, download: true });
    await f.contextMenu(f.row(`${HOME}/src`));
    await f.menuItem("Download as zip").click();
    await page.locator(".toast .toast-text", { hasText: "Zipping src:" }).waitFor();
    await f.until(() => f.rawFor("zip").length === 1, "the zip request");
    assert.deepEqual(f.rawFor("zip")[0].args, { path: `${HOME}/src` });
    assert.ok(f.callsFor("count").filter((c) => c.args.path === `${HOME}/src`).length >= 1, "the zip counted before zipping (the menu's hint may have counted once more)");
    assert.match(await page.locator(".toast .toast-text", { hasText: "Zipping src:" }).innerText(), /^Zipping src: 3 files, \d+ B\. \.git and node_modules are left out\.$/);
    await f.until(() => downloads.length === 2, "the browser's two downloads").catch(() => {});
    assert.equal(await page.locator("#place:not([hidden]) .ws-place").count(), 1, "the place is still there after the downloads");
  });
});

t("6d. a large file on a writable root is read-only for its size alone: the large banner stands by itself, no read-only-root notice, no Copy to Home; the strip says Read-only", async () => {
  await withPage(browser, "large-strip", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    const huge = `${HOME}/huge.log`;
    await f.row(huge).click();
    const pane = page.locator(`.ws-pane[data-path="${huge}"]`);
    await pane.locator('.ws-banner.is-info[data-banner="large"]').waitFor();
    await pane.locator('.cm-content[contenteditable="false"]').waitFor();
    assert.equal(await page.locator(".ws-strip-saved").innerText(), "Read-only", "the strip agrees with the editor about a file that cannot be edited here");
    assert.equal(await page.locator(".ws-strip-root").innerText(), "Home · rw", "the root is still writable");
    assert.equal(await pane.locator(".ws-banner").count(), 1, "one banner: the size");
    assert.equal(await pane.locator('.ws-banner[data-banner="readonly"]').count(), 0, "no read-only-root notice for a size-only read-only");
    assert.equal(await page.locator(".ws-tabs-right .btn", { hasText: "Copy to Home" }).count(), 0, "no Copy to Home: the root is not the problem");
    assert.equal(await page.locator(".ws-tabs-right .btn", { hasText: "Save" }).count(), 0);
    assert.deepEqual(await page.locator(".ws-tabs-right .btn").allInnerTexts(), [], "no text buttons at all in the cluster");
  });
});

// ---- 7. delete ----

t("7. Delete confirms with the dry-run count and size; a folder needs the checkbox; confirming posts delete and closes the open tab", async () => {
  await withPage(browser, "delete-confirm", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    // A file, open in a tab.
    const notes = `${HOME}/notes.txt`;
    await f.row(notes).click();
    await f.tab(notes).waitFor();
    await page.locator(`.ws-pane[data-path="${notes}"] .cm-editor`).waitFor();
    await f.contextMenu(f.row(notes));
    await f.menuItem("Delete…").click();
    let pop = page.locator('.popover[role="dialog"]');
    await pop.waitFor();
    assert.equal(await pop.locator(".popover-head span").first().innerText(), "Delete notes.txt?");
    assert.match(await pop.locator(".kv").innerText(), /Size\s+14 B/);
    assert.match(await pop.locator(".popover-note").innerText(), /This removes the file \(14 B\) from \/home\/rae\.\s+There is no trash: it cannot be undone\./);
    assert.equal(await pop.locator(".ws-del-check").count(), 0, "a file needs no checkbox");
    assert.deepEqual(f.callsFor("delete").map((c) => c.args), [{ path: notes, dryRun: true }]);
    await pop.locator(".popover-actions .btn.is-warn").click();
    await page.locator(`.ws-tab[data-path="${notes}"]`).waitFor({ state: "detached" });
    await f.row(notes).waitFor({ state: "detached" });
    assert.deepEqual(f.callsFor("delete").map((c) => c.args), [{ path: notes, dryRun: true }, { path: notes }]);
    assert.equal(f.fs.has(notes), false);
    assert.equal(await page.locator(".ws-empty:not([hidden]) .ws-empty-title").innerText(), "Nothing open");
    // A folder.
    const src = `${HOME}/src`;
    await f.contextMenu(f.row(src));
    await f.menuItem("Delete…").click();
    pop = page.locator('.popover[role="dialog"]');
    await pop.waitFor();
    assert.equal(await pop.locator(".popover-head span").first().innerText(), "Delete src?");
    assert.match(await pop.locator(".kv").innerText(), /Contains\s+3 files, 1 folder \(\d+ B\)/);
    const button = pop.locator(".popover-actions .btn.is-warn");
    await page.locator('.popover .popover-actions .btn.is-warn[disabled]').waitFor();
    assert.equal(await button.isDisabled(), true, "Delete waits on the checkbox");
    await pop.locator(".ws-del-check").check();
    await page.locator('.popover .popover-actions .btn.is-warn:not([disabled])').waitFor();
    await button.click();
    await f.row(src).waitFor({ state: "detached" });
    assert.deepEqual(f.callsFor("delete").slice(2).map((c) => c.args), [{ path: src, dryRun: true }, { path: src }]);
    assert.equal(f.fs.has(TIDE), false);
    await page.locator(".toast", { hasText: "Deleted src" }).waitFor();
  });
});

// ---- 8. rename and new file ----

t("8. Rename and New file commit on Enter and cancel on Escape", async () => {
  await withPage(browser, "rename-new", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    await f.expand(`${HOME}/src`);
    await f.row(TIDE).click();
    await f.tab(TIDE).waitFor();
    await f.row(TIDE).focus();
    await page.keyboard.press("F2");
    const field = page.locator("#place .ws-inline-input");
    await field.waitFor();
    assert.equal(await field.inputValue(), "tide.ts");
    assert.deepEqual(await field.evaluate((i) => [i.selectionStart, i.selectionEnd]), [0, 4], "the name is selected up to the extension");
    await field.press("Escape");
    await field.waitFor({ state: "detached" });
    assert.equal(f.callsFor("rename").length, 0, "Escape posts nothing");
    assert.equal(await f.row(TIDE).count(), 1);
    await f.row(TIDE).focus();
    await page.keyboard.press("F2");
    await field.waitFor();
    await field.fill("wave.ts");
    await field.press("Enter");
    const wave = `${HOME}/src/wave.ts`;
    await f.row(wave).waitFor();
    assert.deepEqual(f.callsFor("rename").map((c) => c.args), [{ path: TIDE, name: "wave.ts" }]);
    assert.equal(await f.row(TIDE).count(), 0);
    assert.match(await f.row(wave).getAttribute("class"), /\bis-selected\b/);
    await f.tab(wave).waitFor();
    assert.equal(await f.tab(TIDE).count(), 0, "the open tab follows the rename");
    // New file, in the folder of the selection.
    await page.locator('#place .ws-head-actions [title="New file"]').click();
    const input = page.locator("#place .tree-item.is-editing .ws-inline-input");
    await input.waitFor();
    assert.equal(await input.getAttribute("placeholder"), "New file name");
    await input.press("Escape");
    await input.waitFor({ state: "detached" });
    assert.equal(f.callsFor("write").length, 0, "Escape posts nothing");
    await page.locator('#place .ws-head-actions [title="New file"]').click();
    await input.waitFor();
    await input.fill("notes2.md");
    await input.press("Enter");
    const made = `${HOME}/src/notes2.md`;
    await f.row(made).waitFor();
    assert.deepEqual(f.callsFor("write").map((c) => c.args), [{ path: made, text: "" }]);
    await f.tab(made).waitFor();
    assert.match(await f.tab(made).getAttribute("class"), /\bis-active\b/, "a new file opens");
    assert.equal(f.fs.text(made), "");
  });
});

t("8b. New file asked while the folder's listing is still on its way (right after toggling dotfiles) keeps its field when the listing lands", async () => {
  await withPage(browser, "new-file-pending", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    const src = `${HOME}/src`;
    await f.expand(src);
    await f.row(TIDE).waitFor();
    // The dotfile toggle drops every listing; src's answer is held back so the field is asked for first
    // (Home's re-list goes through, or the src row would not be on the page to ask from).
    const held = [];
    f.on("list", (args, { next }) => (args.path === src ? new Promise((resolve, reject) => held.push(() => Promise.resolve().then(next).then(resolve, reject))) : next()));
    await page.locator("#place .ws-check-input").check();
    await f.until(() => f.callsFor("list").filter((c) => c.args.path === src && c.args.hidden).length === 1, "the re-list of src");
    await f.row(src).waitFor();
    await f.contextMenu(f.row(src));
    await f.menuItem("New file").click();
    const field = page.locator("#place .tree-item.is-editing .ws-inline-input");
    await field.waitFor();
    assert.equal(await field.evaluate((n) => document.activeElement === n), true, "the field has the focus");
    await page.keyboard.type("wave");
    // Now the listing lands and the tree redraws under the field.
    for (const release of held.splice(0)) await release();
    f.on("list", null);
    await f.row(`${src}/.env`).waitFor();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await field.count(), 1, "the field survived the redraw");
    assert.equal(await field.inputValue(), "wave", "with its text");
    assert.equal(await field.evaluate((n) => document.activeElement === n), true, "and the focus");
    await page.keyboard.type(".ts");
    assert.equal(await field.inputValue(), "wave.ts");
    await page.keyboard.press("Enter");
    const made = `${src}/wave.ts`;
    await f.until(() => f.callsFor("write").length === 1, `the new file's write (field: ${await field.count()}, editing rows: ${await page.locator("#place .tree-item.is-editing").count()}, toasts: ${JSON.stringify(await page.locator(".toast-text").allInnerTexts())})`);
    assert.deepEqual(f.callsFor("write").map((c) => c.args), [{ path: made, text: "" }]);
    await f.row(made).waitFor();
    await f.tab(made).waitFor();
  });
});

// ---- 9. the context menu ----

t("9. the file menu offers the same items for one entry on an explorer row, a dock row and a chat link; ro drops Rename and Delete; Escape closes", async () => {
  await withPage(browser, "context-menu", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    await f.expand(`${HOME}/src`);
    const explorer = await f.contextMenu(f.row(TIDE));
    assert.deepEqual(explorer, ["Download", "Copy path", "Rename", "Delete…"]);
    assert.equal(await page.locator('.menu.is-floating .menu-item.is-danger .menu-label').innerText(), "Delete…");
    assert.deepEqual(await page.locator(".menu.is-floating .menu-key").allInnerTexts(), ["F2", "Del"]);
    await page.keyboard.press("Escape");
    await page.locator(".menu.is-floating").waitFor({ state: "detached" });
    assert.equal(await page.locator("#place:not([hidden])").count(), 1, "Escape closed the menu, not the place");
    await f.expand(SHARED);
    const ro = await f.contextMenu(f.row(`${SHARED}/policy.txt`));
    assert.deepEqual(ro, ["Download", "Copy path"], "a read-only entry has no Rename or Delete");
    await page.keyboard.press("Escape");
    await page.locator(".menu.is-floating").waitFor({ state: "detached" });
    // The same entry in the Files dock.
    await page.keyboard.press("Escape");
    await page.locator("#place[hidden]").waitFor({ state: "attached" });
    await page.locator(`.rail-btn[data-dock="${KEY.dock}"]`).click();
    await f.row(TIDE, "#dock").waitFor();
    const dock = await f.contextMenu(f.row(TIDE, "#dock"));
    assert.equal(dock[0], "Open in Workspace");
    assert.deepEqual(dock.slice(1), explorer, "the dock offers what the explorer offers, after the way in");
    await page.keyboard.press("Escape");
    await page.locator(".menu.is-floating").waitFor({ state: "detached" });
    // The same entry as a chat link.
    await f.emit([
      { type: "turn.start", turn: "t_browser" },
      { type: "tool.call", call: { id: "c_menu", name: "edit_path", args: { path: TIDE, old: "a", new: "b" } } },
      { type: "tool.result", id: "c_menu", name: "edit_path", result: "ok" },
    ]);
    const link = page.locator(`.pane[data-session="${f.id}"] details.tool[data-tool="c_menu"] .tool-gist a.ws-link`);
    await link.waitFor();
    const chat = await f.contextMenu(link);
    assert.deepEqual(f.callsFor("resolve").map((c) => c.args), [{ paths: [TIDE] }], "the chat asks resolve before it offers a menu");
    assert.equal(chat[0], "Open in Workspace", "Open in Workspace comes first on the chat host");
    assert.equal(chat[1], "Reveal in Files");
    assert.deepEqual(chat.slice(2), explorer, "the chat offers what the explorer offers, after the way in");
    await page.keyboard.press("Escape");
    await page.locator(".menu.is-floating").waitFor({ state: "detached" });
  });
});

t("9b. the file menu is the shell's floating menu, not the package's fallback, and its rows carry the icon, label and key", async () => {
  await withPage(browser, "shell-menu", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    await f.expand(`${HOME}/src`);
    await f.row(TIDE).click({ button: "right" });
    const menu = page.locator("div.menu.is-floating[role=menu]");
    await menu.waitFor();
    assert.equal(await page.locator(".menu.ws-menu").count(), 0, "the package's own popover is not used when ext.ui.menu exists");
    assert.equal(await page.locator(".menu").count(), 1, "one menu at a time");
    assert.equal(await menu.locator("button.menu-item[role=menuitem] > span.menu-icon svg").count(), 4, "every row has its icon");
    assert.deepEqual(await menu.locator(".menu-item .menu-text > .menu-label").allInnerTexts(), ["Download", "Copy path", "Rename", "Delete…"]);
    assert.equal(await menu.locator(".menu-item.is-danger").count(), 1);
    assert.equal(await menu.locator("div.menu-sep[role=separator]").count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".menu.is-floating") !== null), true, "the first row has the focus");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "detached" });
    await page.locator("#place .ws-inline-input").waitFor();
    assert.equal(await page.locator("#place .ws-inline-input").inputValue(), "tide.ts", "Enter chose Rename");
    await page.keyboard.press("Escape");
    await page.locator("#place .ws-inline-input").waitFor({ state: "detached" });
    assert.equal(await page.locator("#place:not([hidden])").count(), 1);
    // The ⋯ on the row anchors the menu below it.
    await f.row(TIDE).hover();
    const more = f.row(TIDE).locator("button.ws-more");
    await more.click();
    await menu.waitFor();
    const [rowBox, menuBox] = [await more.boundingBox(), await menu.boundingBox()];
    assert.ok(menuBox.y >= rowBox.y + rowBox.height, "the menu opens below its anchor");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("ws-more")), true, "Escape gives the focus back to the anchor");
  });
});

t("9c. the zip item's hint fills in with the count once the menu is open", async () => {
  await withPage(browser, "zip-hint", {}, async (f) => {
    await f.openPlace();
    const { page } = f;
    await f.contextMenu(f.row(`${HOME}/src`));
    const item = f.menuItem("Download as zip");
    assert.match(await item.locator(".menu-hint").innerText(), /^(counting…|3 files, \d+ B; \.git and node_modules are skipped)$/, "the hint starts as a promise and fills in");
    await f.until(() => f.callsFor("count").length === 1, "the menu's count");
    await item.locator(".menu-hint", { hasText: /^3 files, \d+ B; \.git and node_modules are skipped$/ }).waitFor();
  });
});

// ---- 10. the Files dock ----

t("10. the Files dock lists the current project first, a click opens the place at the file, Reveal in Files scrolls the row into view", async () => {
  await withPage(browser, "files-dock", {}, async (f) => {
    const { page } = f;
    const button = page.locator(`#rail-tabs .rail-btn[data-dock="${KEY.dock}"]`);
    assert.equal(await button.count(), 1);
    assert.equal(await button.getAttribute("aria-label"), "Files");
    await button.click();
    await page.locator("#dock:not([hidden]) .ws-dock").waitFor();
    assert.equal(await page.locator("#dock .panel-title").innerText(), "Files");
    await page.locator("#dock .panel-sub", { hasText: "Nova" }).waitFor();
    assert.equal(await page.locator("#dock .panel-sub").innerText(), "Nova · 1 directory ready, 1 needs attention");
    assert.deepEqual(await page.locator("#dock .ws-group-label").allTextContents(), ["Nova", "Workspace"]);
    assert.equal(await page.locator("#dock .ws-group-hint").innerText(), "this conversation's project");
    const paths = await page.locator("#dock .tree-item[data-path]").evaluateAll((els) => els.map((e) => e.dataset.path));
    assert.deepEqual(paths.slice(0, 2), [NOVA, ORLEANS], "the current project's directories come first");
    assert.ok(paths.indexOf(HOME) > paths.indexOf(ORLEANS) && paths.indexOf(SHARED) > paths.indexOf(HOME));
    assert.equal(await page.locator(`#dock .tree-item[data-path="${ORLEANS}"] + .ws-note.is-err .ws-note-text`).innerText(), "Not mounted. An agent cannot read this directory.");
    assert.equal(await page.locator("#dock .ws-head").count(), 0, "the dock explorer is compact: no head");
    assert.equal(await page.locator("#dock .ws-dock-legend").count(), 1);
    await f.expand(NOVA, "#dock");
    const readme = `${NOVA}/README.md`;
    await f.row(readme, "#dock").waitFor();
    await f.row(readme, "#dock").click();
    await page.locator("#place:not([hidden]) .ws-place").waitFor();
    await f.tab(readme).waitFor();
    const row = page.locator(`#place .tree-item[data-path="${readme}"].is-selected`);
    await row.waitFor();
    assert.equal(await row.isVisible(), true, "the place opens expanded to the file");
    assert.equal(await page.locator(`#place .tree-item[data-path="${NOVA}"]`).getAttribute("aria-expanded"), "true");
    await page.locator(`.ws-pane[data-path="${readme}"] .ws-rendered`).waitFor();
    // Reveal in Files from the chat menu.
    await page.keyboard.press("Escape");
    await page.locator("#place[hidden]").waitFor({ state: "attached" });
    await page.locator("#dock .panel-close").click();
    await page.locator("#dock[hidden]").waitFor({ state: "attached" });
    const plan = `${NOVA}/docs/plan.md`;
    await f.emit([
      { type: "turn.start", turn: "t_browser" },
      { type: "tool.call", call: { id: "c_reveal", name: "read_path", args: { path: plan } } },
      { type: "tool.result", id: "c_reveal", name: "read_path", result: "# Plan" },
    ]);
    const link = page.locator(`details.tool[data-tool="c_reveal"] .tool-gist a.ws-link[data-path="${plan}"]`);
    await link.waitFor();
    await f.contextMenu(link);
    await f.menuItem("Reveal in Files").click();
    await page.locator("#dock:not([hidden]) .ws-dock").waitFor();
    const revealed = page.locator(`#dock .tree-item[data-path="${plan}"].is-selected`);
    await revealed.waitFor();
    assert.equal(await page.locator(`#dock .tree-item[data-path="${NOVA}/docs"]`).getAttribute("aria-expanded"), "true");
    const box = await revealed.boundingBox();
    const body = await page.locator("#dock .panel-body").boundingBox();
    assert.ok(box && body && box.y >= body.y && box.y + box.height <= body.y + body.height, "the revealed row is inside the dock's viewport");
    assert.equal(await page.locator("#place[hidden]").count(), 1, "Reveal in Files does not open the place");
  });
});

// ---- 11. the transcript ----

t("11. tool cards get a path link and an Open pill; a result adds deduplicated chips; the link opens the place at the line", async () => {
  await withPage(browser, "transcript-links", {}, async (f) => {
    const { page } = f;
    await f.emit([
      { type: "turn.start", turn: "t_browser" },
      { type: "tool.call", call: { id: "c_edit", name: "edit_path", args: { path: TIDE, old: "line3", new: "line three" } } },
      { type: "tool.call", call: { id: "c_read", name: "read_path", args: { path: TIDE, offset: 7, limit: 3 } } },
      { type: "tool.call", call: { id: "c_dir", name: "get_directory", args: { path: `${HOME}/src` } } },
      { type: "tool.call", call: { id: "c_other", name: "bash", args: { command: "ls /home/rae" } } },
    ]);
    const pane = page.locator(`.pane[data-session="${f.id}"]`);
    const edit = pane.locator('details.tool[data-tool="c_edit"]');
    const editLink = edit.locator(".tool-gist a.ws-link");
    await editLink.waitFor();
    assert.equal(await editLink.getAttribute("data-path"), TIDE);
    assert.equal(await editLink.innerText(), TIDE);
    assert.equal(await editLink.getAttribute("data-line"), null);
    assert.equal(await edit.locator(".tool-head button.ws-open").count(), 1);
    assert.equal(await edit.locator(".tool-head button.ws-open").getAttribute("data-path"), TIDE);
    assert.match(await edit.locator(".tool-gist").innerText(), /old: line3/, "the rest of the gist is untouched");
    const readLink = pane.locator('details.tool[data-tool="c_read"] .tool-gist a.ws-link');
    await readLink.waitFor();
    assert.equal(await readLink.getAttribute("data-line"), "7", "a read's offset is the line");
    assert.equal(await pane.locator('details.tool[data-tool="c_read"] button.ws-open').getAttribute("data-line"), "7");
    await pane.locator('details.tool[data-tool="c_dir"] .tool-gist a.ws-link').waitFor();
    assert.equal(await pane.locator('details.tool[data-tool="c_other"] a.ws-link').count(), 0, "a tool that is not a files tool gets no link");
    assert.equal(await pane.locator('details.tool[data-tool="c_other"] button.ws-open').count(), 0);
    assert.equal(await pane.locator(".ws-touched").count(), 0, "no chips before a result");
    await f.emit([
      { type: "tool.result", id: "c_edit", name: "edit_path", result: "ok" },
      { type: "tool.result", id: "c_read", name: "read_path", result: "7: export const line7 = 7;" },
      { type: "tool.result", id: "c_dir", name: "get_directory", result: "tide.ts" },
      { type: "tool.result", id: "c_other", name: "bash", result: "README.md" },
    ], "t_browser2");
    const touched = pane.locator("details.tool-run > .ws-touched");
    await touched.waitFor();
    assert.equal(await touched.count(), 1);
    assert.equal(await touched.locator(".ws-touched-label").innerText(), "Files in this run:");
    assert.deepEqual(await touched.locator("a.ws-link").evaluateAll((els) => els.map((e) => e.dataset.path)), [TIDE, `${HOME}/src`], "distinct paths, first-seen order");
    assert.equal(await touched.getAttribute("data-count"), "2");
    assert.equal(await pane.locator('details.tool[data-tool="c_edit"]').getAttribute("data-ws-linked"), "1");
    // Click the read link: the place opens at the file and the line.
    await readLink.click();
    await page.locator("#place:not([hidden]) .ws-place").waitFor();
    await f.tab(TIDE).waitFor();
    await page.locator(`.ws-pane[data-path="${TIDE}"] .cm-editor .cm-content`).waitFor();
    await page.locator(".ws-strip-cursor", { hasText: "Ln 7, Col 1" }).waitFor();
    assert.equal(await page.locator(`#place .tree-item[data-path="${TIDE}"].is-selected`).count(), 1, "the explorer reveals the file");
    assert.equal(await page.locator(`.ws-pane[data-path="${TIDE}"] .cm-lineNumbers .cm-activeLineGutter`).innerText(), "7");
    assert.equal(await page.locator(`.ws-pane[data-path="${TIDE}"] .cm-activeLine`).innerText(), "export const line7 = 7;");
    assert.equal(await page.locator("details.tool-run").count(), 1, "the tool run is still one block");
  });
});

t("11b. paths in a restored message bubble become links once resolve confirms them; a bogus path stays text; the link opens the place at its line", async () => {
  const novaTide = `${NOVA}/src/tide.ts`;
  const conversation = [
    { role: "user", content: "Where is the tide computed? Also look at /nope/x.ts if it exists." },
    { role: "assistant", content: `The tide is set in ${novaTide}:7, in \`nova7\`. There is no /nope/x.ts in this project; \`docs/plan.md\` has the schedule.\n\n\`\`\`sh\ncat /srv/games/nova/src/tide.ts\n\`\`\`` },
  ];
  await withPage(browser, "prose-links", { conversation }, async (f) => {
    const { page } = f;
    const pane = page.locator(`.pane[data-session="${f.id}"]`);
    const bubble = pane.locator(".msg.is-assistant .msg-text, .msg:not(.is-user) .msg-text").last();
    const link = bubble.locator(`a.ws-link[data-path="${novaTide}"]`);
    await link.waitFor();
    await f.until(() => f.callsFor("resolve").length >= 1, "the resolve for the bubble");
    const resolves = f.callsFor("resolve");
    assert.equal(resolves.length, 2, "one resolve per bubble with candidates (the user's and the assistant's), none for text without paths");
    assert.deepEqual(resolves.map((c) => c.args.paths).flat().sort(), [novaTide, "/nope/x.ts", "/nope/x.ts", "docs/plan.md"].sort());
    assert.ok(resolves.every((c) => c.session === f.id), "asked for this conversation, so relative paths resolve against its project");
    const links = await bubble.locator("a.ws-link").evaluateAll((els) => els.map((a) => [a.dataset.path, a.dataset.line ?? null, a.textContent]));
    assert.deepEqual(links, [[novaTide, "7", `${novaTide}:7`], [`${NOVA}/docs/plan.md`, null, "docs/plan.md"]], "the absolute path with its line, and the relative one confirmed against the conversation's project (nothing by that name under home); nothing else");
    assert.equal(await bubble.locator("pre a.ws-link").count(), 0, "a fenced block is left alone");
    assert.match(await bubble.innerText(), /There is no \/nope\/x\.ts in this project/, "the bogus path is still there, as text");
    assert.equal(await bubble.locator('a.ws-link[data-path="/nope/x.ts"]').count(), 0);
    assert.equal(await pane.locator(".msg.is-user a.ws-link").count(), 0, "the person's bubble named only the bogus path");
    assert.equal(await pane.locator(".msg-text[data-ws-linked]").count(), 2, "both bubbles were looked at once");
    // The same bubble is not asked about twice, and a click opens the place at the line.
    await link.click();
    await page.locator("#place:not([hidden]) .ws-place").waitFor();
    await f.tab(novaTide).waitFor();
    await page.locator(`.ws-pane[data-path="${novaTide}"] .cm-editor .cm-content`).waitFor();
    await page.locator(".ws-strip-cursor", { hasText: "Ln 7, Col 1" }).waitFor();
    assert.equal(await page.locator(`.ws-pane[data-path="${novaTide}"] .cm-activeLine`).innerText(), "export const nova7 = 7;");
    assert.equal(f.callsFor("resolve").length, 2, "opening the file asked nothing more");
  });
});

// ---- 12. the phone ----

t("12. at phone width the explorer is the page, a file opens full width and Back returns", async () => {
  await withPage(browser, "phone", { viewport: { width: 390, height: 800 } }, async (f) => {
    const { page } = f;
    await page.locator("#toggle-sidebar").click();
    await page.locator("#sidebar.is-open").waitFor();
    await page.locator("#menu").click();
    await page.locator(`.menu-item[data-place="${KEY.place}"]`).click();
    await page.locator("#place:not([hidden]) .ws-place").waitFor();
    await page.locator("#sidebar-veil").click({ position: { x: 385, y: 700 } }); // beside the drawer, not on it
    await page.locator("#sidebar:not(.is-open)").waitFor();
    await f.row(HOME).waitFor();
    const place = page.locator("#place .ws-place");
    const explorer = page.locator("#place .ws-explorer-col");
    const editor = page.locator("#place .ws-editor");
    assert.doesNotMatch(await place.getAttribute("class"), /\bis-file\b/);
    assert.equal(await explorer.isVisible(), true, "the explorer is the list");
    assert.equal(await editor.isVisible(), false, "no editor column beside it");
    assert.equal(await page.locator("#place .ws-resize").isVisible(), false);
    const explorerBox = await explorer.boundingBox();
    assert.ok(explorerBox.width >= 380, `the explorer fills the width (${explorerBox.width})`);
    const readme = `${HOME}/README.md`;
    await f.row(readme).click();
    await page.locator("#place .ws-place.is-file").waitFor();
    await page.locator(`.ws-pane[data-path="${readme}"] .ws-rendered`).waitFor();
    assert.equal(await editor.isVisible(), true, "the file takes the page");
    assert.equal(await explorer.isVisible(), false);
    const editorBox = await editor.boundingBox();
    assert.ok(editorBox.width >= 380, `the file view fills the width (${editorBox.width})`);
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, wide: [...document.querySelectorAll("#place *")].filter((n) => n.getBoundingClientRect().right > 390).slice(0, 8).map((n) => `${n.tagName.toLowerCase()}.${[...n.classList].join(".")}@${Math.round(n.getBoundingClientRect().right)}`) }));
    assert.ok(widths.page <= 390, `the file view must not push the page wider than the phone: scrollWidth ${widths.page}; over the edge: ${widths.wide.join(", ")}`);
    // The tab bar's right cluster (Rendered | Source, Download, ⋯) is on screen, not clipped off the right.
    const cluster = await page.locator(".ws-tabs-right > *, .ws-tabs-right .ws-seg, .ws-tabs-right .btn, .ws-tabs-right .icon-btn").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [e.className, Math.round(r.left), Math.round(r.right), r.width > 0 && r.height > 0]; }));
    assert.ok(cluster.length >= 3, `the cluster is drawn: ${JSON.stringify(cluster)}`);
    for (const [cls, left, right, shown] of cluster) assert.ok(shown && left >= 0 && right <= 390, `${cls} sits on screen (${left}..${right})`);
    assert.equal(await page.locator('.ws-tabs-right [title="Download"]').isVisible(), true);
    assert.equal(await page.locator('.ws-tabs-right [title="More…"]').isVisible(), true);
    const back = page.locator("#place .ws-back");
    assert.equal(await back.isVisible(), true);
    assert.equal(await back.innerText(), "Files");
    await back.click();
    await page.locator("#place .ws-place:not(.is-file)").waitFor();
    assert.equal(await explorer.isVisible(), true, "Back returns to the list");
    assert.equal(await editor.isVisible(), false);
    assert.equal(await f.tab(readme).count(), 1, "the tab stays open behind the list");
    await f.tab(readme).evaluate((node) => node.scrollIntoView());
    assert.equal(await page.locator(`#place .tree-item[data-path="${readme}"]`).isVisible(), true);
    // In the list, a row's right-hand pills stay on screen: the name gives way, not the pill.
    for (const path of [HOME, SHARED, NOVA]) {
      const pill = await f.row(path).locator(".ws-mode").evaluate((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; });
      assert.ok(pill[0] >= 0 && pill[1] <= 390, `${path}'s mode pill is on screen (${pill})`);
    }
    const count = await page.locator('#place .ws-project[data-key="project:p_nova"] .tree-count').evaluate((e) => Math.round(e.getBoundingClientRect().right));
    assert.ok(count <= 390, `the project's count is on screen (${count})`);
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, "the list view does not widen the page either");
  });
});

// ---- 13. the console ----

t("13. the console stays clean across the place, the dock and the transcript on one page", async () => {
  await withPage(browser, "console-clean", {}, async (f) => {
    const { page } = f;
    await f.emit([
      { type: "turn.start", turn: "t_browser" },
      { type: "tool.call", call: { id: "c_clean", name: "write_path", args: { path: `${HOME}/notes.txt`, content: "x" } } },
      { type: "tool.result", id: "c_clean", name: "write_path", result: "ok" },
    ]);
    await page.locator('details.tool[data-tool="c_clean"] a.ws-link').waitFor();
    await page.locator(`.rail-btn[data-dock="${KEY.dock}"]`).click();
    await page.locator("#dock:not([hidden]) .ws-dock").waitFor();
    await page.locator("#dock .ws-dock-open").click();
    await page.locator("#place:not([hidden]) .ws-place").waitFor();
    await f.expand(`${HOME}/src`);
    await f.row(TIDE).click();
    await page.locator(`.ws-pane[data-path="${TIDE}"] .cm-editor .cm-content`).waitFor();
    await f.row(`${HOME}/README.md`).click();
    await page.locator(`.ws-pane[data-path="${HOME}/README.md"] .ws-rendered`).waitFor();
    await f.tab(TIDE).click();
    await page.locator(`.ws-pane[data-path="${TIDE}"]:not([hidden])`).waitFor();
    await page.locator(`.ws-tab[data-path="${HOME}/README.md"] .ws-tab-close`).click();
    await f.tab(`${HOME}/README.md`).waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await page.locator("#place[hidden]").waitFor({ state: "attached" });
    assert.deepEqual(f.errors, [], "no console errors, page errors or unexpected requests");
  });
});

// ---- 14. a restored transcript, decorated after the fact ----

/** A saved conversation with one files-tool call, its result, and a reply that names the path: what a reload restores. */
const restoredRead = (id, path, offset) => [
  { role: "user", content: "Read the tide file around line seven." },
  { role: "assistant", content: "", toolCalls: [{ id, name: "read_path", args: { path, offset, limit: 3 } }] },
  { role: "tool", toolCallId: id, name: "read_path", content: `${offset}: export const line${offset} = ${offset};` },
  { role: "assistant", content: `Line ${offset} of ${path} sets \`line${offset}\`.` },
];

t("14. a restored transcript gets links after the extension loads: the card, the Open pill, the strip and the bubble, with one resolve", async () => {
  await withPage(browser, "restored-links", { conversation: restoredRead("c_rread", TIDE, 7), holdModule: true }, async (f) => {
    const { page } = f;
    const pane = page.locator(`.pane[data-session="${f.id}"]`);
    const card = pane.locator('details.tool[data-tool="c_rread"]');
    await card.waitFor();
    await f.moduleRequested;
    assert.equal(await card.locator(".tool-status").textContent(), "done", "the history is drawn and settled before the module is served");
    assert.equal(await pane.locator("a.ws-link, button.ws-open, .ws-touched").count(), 0, "nothing is decorated while the module is held");
    assert.equal(f.callsFor("resolve").length, 0);
    f.releaseModule();
    const link = card.locator(".tool-gist a.ws-link");
    await link.waitFor();
    assert.deepEqual([await link.getAttribute("data-path"), await link.getAttribute("data-line"), await link.innerText()], [TIDE, "7", TIDE], "the path in the gist, at the read's offset");
    assert.equal(await card.locator("a.ws-link").count(), 1, "one link on the card");
    assert.match(await card.locator(".tool-gist").innerText(), /offset: 7\s+·\s+limit: 3/, "the rest of the gist is untouched");
    const pill = card.locator(".tool-head button.ws-open");
    assert.equal(await pill.count(), 1, "one Open pill");
    assert.deepEqual([await pill.getAttribute("data-path"), await pill.getAttribute("data-line")], [TIDE, "7"]);
    assert.equal(await card.getAttribute("data-ws-linked"), "1");
    const touched = pane.locator("details.tool-run > .ws-touched");
    await touched.waitFor();
    assert.equal(await touched.count(), 1, "one strip: the restored run has its result");
    assert.deepEqual(await touched.locator("a.ws-link").evaluateAll((els) => els.map((e) => e.dataset.path)), [TIDE]);
    assert.equal(await touched.getAttribute("data-count"), "1");
    const bubble = pane.locator(".msg.is-assistant .msg-text");
    const prose = bubble.locator(`a.ws-link[data-path="${TIDE}"]`);
    await prose.waitFor();
    assert.equal(await bubble.locator("a.ws-link").count(), 1, "the reply's path is linked once");
    assert.equal(await prose.innerText(), TIDE);
    assert.equal(await pane.locator(".msg-text[data-ws-linked]").count(), 2, "both bubbles were looked at once (the person's named no path, so it asked nothing)");
    const resolves = f.callsFor("resolve");
    assert.equal(resolves.length, 1, "exactly one resolve for the restored transcript");
    assert.deepEqual(resolves[0].args.paths, [TIDE]);
    assert.equal(resolves[0].session, f.id);
    // A live turn drawn afterwards is decorated by the offer, and the sweep that follows it changes nothing already done.
    await f.emit([
      { type: "turn.start", turn: "t_after" },
      { type: "tool.call", call: { id: "c_live", name: "get_directory", args: { path: `${HOME}/src` } } },
      { type: "tool.result", id: "c_live", name: "get_directory", result: "tide.ts" },
      { type: "turn.end" },
    ], "t_after");
    await pane.locator('details.tool[data-tool="c_live"] .tool-gist a.ws-link').waitFor();
    await pane.locator('details.tool[data-tool="c_live"]').locator("xpath=ancestor::details[contains(@class,'tool-run')]/div[contains(@class,'ws-touched')]").waitFor();
    assert.equal(await card.locator("a.ws-link").count(), 1, "the restored card still has one link");
    assert.equal(await card.locator("button.ws-open").count(), 1, "and one pill");
    assert.equal(await pane.locator("details.tool-run > .ws-touched").count(), 2, "one strip per run, none doubled");
    assert.deepEqual(await touched.first().locator("a.ws-link").evaluateAll((els) => els.map((e) => e.dataset.path)), [TIDE], "the restored run's strip is unchanged");
    assert.equal(await bubble.locator("a.ws-link").count(), 1, "the reply is not linked twice");
    assert.equal(f.callsFor("resolve").length, 1, "nothing was asked again");
  });
});

t("14b. a conversation re-opened from the sidebar is decorated on open; the first keeps its links; each is resolved once", async () => {
  const plan = `${NOVA}/docs/plan.md`;
  const first = [
    { role: "user", content: "Where is the plan?" },
    { role: "assistant", content: "", toolCalls: [{ id: "c_plan", name: "read_path", args: { path: plan } }] },
    { role: "tool", toolCallId: "c_plan", name: "read_path", content: "# Plan\n\n1. Ship." },
    { role: "assistant", content: `The plan is ${plan}.` },
  ];
  const second = [
    { role: "user", content: "Now the tide." },
    { role: "assistant", content: "", toolCalls: [{ id: "c_tide", name: "edit_path", args: { path: TIDE, old: "line3", new: "line three" } }] },
    { role: "tool", toolCallId: "c_tide", name: "edit_path", content: "ok" },
    { role: "assistant", content: `Edited ${TIDE}:3 as asked.` },
  ];
  await withPage(browser, "reopen-links", { conversation: first, others: [{ id: "s_bbbb", title: "Second", conversation: second }] }, async (f) => {
    const { page } = f;
    const paneA = page.locator(`.pane[data-session="${f.id}"]`);
    const paneB = page.locator('.pane[data-session="s_bbbb"]');
    await paneA.locator('details.tool[data-tool="c_plan"] .tool-gist a.ws-link').waitFor();
    await paneA.locator(`.msg.is-assistant .msg-text a.ws-link[data-path="${plan}"]`).waitFor();
    await paneA.locator("details.tool-run > .ws-touched").waitFor();
    assert.equal(await paneB.count(), 0, "the second conversation is not drawn until it is opened");
    await page.locator('.session[data-session="s_bbbb"] .session-open').click();
    await page.locator('.pane[data-session="s_bbbb"].is-active').waitFor();
    const card = paneB.locator('details.tool[data-tool="c_tide"]');
    const link = card.locator(".tool-gist a.ws-link");
    await link.waitFor();
    assert.deepEqual([await link.getAttribute("data-path"), await link.getAttribute("data-line")], [TIDE, null]);
    assert.equal(await card.locator("a.ws-link").count(), 1);
    assert.equal(await card.locator(".tool-head button.ws-open").count(), 1);
    const touched = paneB.locator("details.tool-run > .ws-touched");
    await touched.waitFor();
    assert.equal(await touched.count(), 1);
    assert.deepEqual(await touched.locator("a.ws-link").evaluateAll((els) => els.map((e) => e.dataset.path)), [TIDE]);
    const prose = paneB.locator(`.msg.is-assistant .msg-text a.ws-link[data-path="${TIDE}"]`);
    await prose.waitFor();
    assert.deepEqual([await prose.getAttribute("data-line"), await prose.innerText()], ["3", `${TIDE}:3`]);
    assert.equal(await paneB.locator(".msg-text a.ws-link").count(), 1);
    // Back to the first: its pane was kept, so nothing is drawn or asked again, and its links are as they were.
    await page.locator(`.session[data-session="${f.id}"] .session-open`).click();
    await page.locator(`.pane[data-session="${f.id}"].is-active`).waitFor();
    assert.equal(await paneA.locator('details.tool[data-tool="c_plan"] a.ws-link').count(), 1);
    assert.equal(await paneA.locator('details.tool[data-tool="c_plan"] button.ws-open').count(), 1);
    assert.equal(await paneA.locator("details.tool-run > .ws-touched").count(), 1);
    assert.equal(await paneA.locator(`.msg-text a.ws-link[data-path="${plan}"]`).count(), 1);
    const resolves = f.callsFor("resolve");
    assert.deepEqual(resolves.map((c) => [c.session, c.args.paths]), [[f.id, [plan]], ["s_bbbb", [TIDE]]], "one resolve per conversation, each for its own session");
  });
});

// The operations, one per tool. A port of the Rust Thetis's Playwright sidecar
// (/opt/thetis/services/playwright-sidecar/server.js), called in-process instead of over HTTP.
// Each returns a plain object; render.js turns it into the text the model reads.

import { mkdir, writeFile, stat, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { activePage, downloadsSettled } from "./core.js";

// --- the page map -------------------------------------------------------------------------------

/** The accessibility snapshot with `[ref=eN]` handles, the way every tool addresses elements. */
export async function snapshot(page) {
  try { return await page.ariaSnapshot({ mode: "ai" }); }
  catch (e) {
    // A navigation mid-snapshot is the usual cause; one retry after the page settles is enough.
    await settle(page);
    try { return await page.ariaSnapshot({ mode: "ai" }); }
    catch { return `<snapshot unavailable: ${String(e.message).split("\n")[0]}>`; }
  }
}

export function trimSnapshot(text, budget) {
  if (!text || text.length <= budget) return { snapshot: text };
  const lines = text.split("\n");
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  return {
    snapshot: kept.join("\n"),
    snapshotNote: `showing ${kept.length} of ${lines.length} lines (${used} of ${text.length} chars). `
      + "Narrow it with the `text` or `regex` argument of browser_snapshot rather than reading it all.",
  };
}

export function trimValue(text, budget, what = "value") {
  const s = String(text ?? "");
  if (s.length <= budget) return { text: s };
  return {
    text: s.slice(0, budget),
    note: `[the ${what} was ${s.length} chars and is cut to ${budget}. Return less from the page: `
      + "a length, a slice, a mapped subset or a count, rather than the whole thing.]",
  };
}

/** A ref from a snapshot (`e12`), or anything Playwright's locator takes: CSS, `text=`, `role=`, XPath. */
export function locate(page, target) {
  if (!target || typeof target !== "string" || !target.trim()) {
    throw new Error('a `target` is required: a ref such as "e12" from a snapshot, or a selector');
  }
  const t = target.trim().replace(/^\[?ref=(e\d+)\]?$/, "$1");
  if (/^e\d+$/.test(t)) return page.locator(`aria-ref=${t}`);
  return page.locator(t);
}

async function pageState(page, s, extra = {}) {
  let title = "";
  try { title = await page.title(); } catch { /* navigating */ }
  return { url: page.url(), title, tabs: s.pages.length, activeTab: s.active, ...extra };
}

/** After an action the page may navigate or re-render; a short settle lets the snapshot describe the result. */
async function settle(page) {
  try { await page.waitForLoadState("domcontentloaded", { timeout: 2000 }); } catch { /* no navigation */ }
}

async function withSnapshot(page, s, cfg, extra = {}) {
  return pageState(page, s, { ...extra, ...trimSnapshot(await snapshot(page), cfg.snapshotChars) });
}

/** Playwright evaluates a *string* as an expression, so "() => document.title" would come back undefined. */
export function toFunction(src) {
  const looksLikeFn = /^\s*(async\s*)?(\(|function\b)/.test(src) || /^\s*(async\s*)?[A-Za-z_$][\w$]*\s*=>/.test(src);
  if (!looksLikeFn) return src;
  try {
    // eslint-disable-next-line no-eval
    const fn = (0, eval)(`(${src})`);
    return typeof fn === "function" ? fn : src;
  } catch { return src; }
}

/** A bare `example.com` means https; `localhost:3000` means http. */
export function normaliseUrl(url) {
  const u = String(url).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^(localhost|[\w.-]+):\d+(\/|$)/i.test(u)) return u;
  if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(u)) return `http://${u}`;
  return `https://${u}`;
}

/** Makes a blocked navigation say which rule blocked it instead of net::ERR_BLOCKED_BY_CLIENT. */
function explain(s, e) {
  const msg = String(e?.message ?? e);
  if (/ERR_BLOCKED_BY_CLIENT/.test(msg) && s.blocked.length) {
    const b = s.blocked[s.blocked.length - 1];
    return new Error(`refused by this extension's settings: ${b.why}.`);
  }
  return e;
}

// --- operations ---------------------------------------------------------------------------------

export const ops = {
  async navigate(s, a, cfg) {
    const page = await activePage(s);
    const waitUntil = a.waitUntil || "load";
    const action = a.action || "goto";
    try {
      if (action === "back") await page.goBack({ waitUntil });
      else if (action === "forward") await page.goForward({ waitUntil });
      else if (action === "reload") await page.reload({ waitUntil });
      else {
        if (!a.url) throw new Error("navigating needs a `url`, or an `action` of back, forward or reload.");
        // Console and network history describe the page being looked at.
        s.consoles = [];
        s.requests = [];
        const resp = await page.goto(normaliseUrl(a.url), { waitUntil });
        const status = resp?.status();
        if (status && status >= 400) return withSnapshot(page, s, cfg, { status });
      }
    } catch (e) { throw explain(s, e); }
    return withSnapshot(page, s, cfg);
  },

  async snapshot(s, a, cfg) {
    const page = await activePage(s);
    const full = await snapshot(page);
    if (!a.text && !a.regex) return pageState(page, s, trimSnapshot(full, cfg.snapshotChars));
    let re;
    if (a.regex) {
      const m = /^\/(.*)\/([gimsuy]*)$/.exec(a.regex);
      re = m ? new RegExp(m[1], m[2].replace("g", "")) : new RegExp(a.regex, "i");
    } else {
      re = new RegExp(String(a.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const lines = full.split("\n");
    const around = Number.isFinite(a.context) ? Math.max(0, a.context) : 0;
    const keep = new Set();
    let hits = 0;
    lines.forEach((l, i) => {
      if (!re.test(l)) return;
      hits++;
      for (let j = Math.max(0, i - around); j <= Math.min(lines.length - 1, i + around); j++) keep.add(j);
    });
    if (!hits) {
      return pageState(page, s, {
        matches: 0,
        snapshot: "<no matching nodes>",
        hint: "Nothing in the accessibility tree matched. The text may be in an image, may not have loaded yet, "
          + "or may be worded differently: call browser_snapshot with no filter to see what is there.",
      });
    }
    const out = [];
    let prev = -1;
    for (const i of [...keep].sort((x, y) => x - y)) {
      if (prev >= 0 && i > prev + 1) out.push("  ...");
      out.push(lines[i]);
      prev = i;
    }
    return pageState(page, s, { matches: hits, ...trimSnapshot(out.join("\n"), cfg.snapshotChars) });
  },

  async click(s, a, cfg) {
    const page = await activePage(s);
    const button = a.button || "left";
    const before = s.pages.length;
    // A target=_blank link's page event can land just after the click resolves.
    let popped = false;
    const onPage = () => { popped = true; };
    s.ctx.once("page", onPage);
    try {
      if (a.x !== undefined && a.y !== undefined) {
        await page.mouse.click(Number(a.x), Number(a.y), { button, clickCount: a.doubleClick ? 2 : 1 });
      } else {
        const el = locate(page, a.target);
        const opts = { button, modifiers: a.modifiers?.length ? a.modifiers : undefined };
        if (a.doubleClick) await el.dblclick(opts);
        else await el.click(opts);
      }
    } catch (e) { s.ctx.off("page", onPage); throw explain(s, e); }
    await settle(page);
    if (!popped) await page.waitForTimeout(150).catch(() => {});
    s.ctx.off("page", onPage);
    const extra = popped || s.pages.length > before ? { note: `the click opened a new tab (${s.pages.length} now); switch to it with browser_tabs.` } : {};
    return withSnapshot(page, s, cfg, extra);
  },

  async hover(s, a, cfg) {
    const page = await activePage(s);
    if (a.x !== undefined && a.y !== undefined) await page.mouse.move(Number(a.x), Number(a.y));
    else await locate(page, a.target).hover();
    await settle(page);
    return withSnapshot(page, s, cfg);
  },

  async type(s, a, cfg) {
    const page = await activePage(s);
    const action = a.action || "fill";
    try {
      if (action === "press_key") {
        if (!a.key) throw new Error("press_key needs a `key`, e.g. 'Enter' or 'Control+a'");
        if (a.target) await locate(page, a.target).press(a.key);
        else await page.keyboard.press(a.key);
      } else if (action === "fill_form") {
        if (!Array.isArray(a.fields) || !a.fields.length) throw new Error("fill_form needs `fields`: [{ target, value, type? }]");
        for (const f of a.fields) {
          const el = locate(page, f.target);
          if (f.type === "checkbox" || f.type === "radio") await el.setChecked(f.value === true || /^(true|on|yes|1|checked)$/i.test(String(f.value)));
          else if (f.type === "select") await el.selectOption(String(f.value));
          else await el.fill(String(f.value ?? ""));
        }
      } else if (action === "select_option") {
        const values = Array.isArray(a.values) && a.values.length ? a.values.map(String) : [String(a.value ?? a.text ?? "")];
        await locate(page, a.target).selectOption(values);
      } else {
        const el = locate(page, a.target);
        const text = String(a.text ?? "");
        if (a.slowly) { await el.fill(""); await el.pressSequentially(text, { delay: 30 }); }
        else await el.fill(text);
        if (a.submit) await el.press("Enter");
      }
    } catch (e) { throw explain(s, e); }
    await settle(page);
    return withSnapshot(page, s, cfg);
  },

  async evaluate(s, a, cfg) {
    const page = await activePage(s);
    if (!a.function) throw new Error('evaluate needs a `function`, e.g. "() => document.title"');
    const fn = toFunction(a.function);
    const result = a.target ? await locate(page, a.target).evaluate(fn) : await page.evaluate(fn);
    let rendered;
    try { rendered = JSON.stringify(result, null, 2); } catch { rendered = String(result); }
    if (rendered === undefined) rendered = "undefined";
    const t = trimValue(rendered, cfg.valueChars, "returned value");
    return pageState(page, s, { result: t.text, ...(t.note ? { resultNote: t.note } : {}) });
  },

  async screenshot(s, a, cfg, env) {
    const page = await activePage(s);
    const home = env?.cwd || process.cwd();
    const dir = isAbsolute(cfg.screenshotDir) ? cfg.screenshotDir : resolve(home, cfg.screenshotDir);
    if (a.action === "pdf") {
      if (!cfg.headless) throw new Error("PDF printing needs headless mode.");
      const buf = await page.pdf({ format: a.format || "Letter", printBackground: true });
      return pageState(page, s, { ...(await save(dir, home, buf, a.filename, "pdf")), mime: "application/pdf" });
    }
    const png = a.type === "png" || (!a.type && /\.png$/i.test(String(a.filename || "")));
    const opts = { type: png ? "png" : "jpeg", fullPage: !!a.fullPage };
    if (!png) opts.quality = Number.isFinite(a.quality) ? Math.min(100, Math.max(1, a.quality)) : 60;
    const buf = a.target ? await locate(page, a.target).screenshot(opts) : await page.screenshot(opts);
    const saved = await save(dir, home, buf, a.filename, png ? "png" : "jpg");
    const out = await pageState(page, s, { ...saved, mime: png ? "image/png" : "image/jpeg" });
    // The bytes the model may be shown travel beside the text, not in it; tools.js decides whether to attach them.
    Object.defineProperty(out, "image", { value: { page, buf, mediaType: out.mime, name: basename(saved.path), fullPage: !!a.fullPage, element: !!a.target }, enumerable: false });
    return out;
  },

  async upload(s, a, cfg, env) {
    const page = await activePage(s);
    const files = Array.isArray(a.files) ? a.files : (a.file ? [a.file] : []);
    const home = env?.cwd || process.cwd();
    const paths = [];
    for (const f of files) paths.push(await uploadPath(f, home, cfg));
    const el = locate(page, a.target);
    // A file input takes the files directly. A styled button that opens a chooser is clicked and the chooser answered.
    const isInput = await el.evaluate((n) => n instanceof HTMLInputElement && n.type === "file").catch(() => false);
    try {
      if (isInput) await el.setInputFiles(paths);
      else {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: Math.min(cfg.timeoutMs, 5000) }), el.click()]);
        if (paths.length > 1 && !chooser.isMultiple()) throw new Error(`this file chooser takes one file; ${paths.length} were given`);
        await chooser.setFiles(paths);
      }
    } catch (e) {
      if (/filechooser/.test(String(e?.message)) && /Timeout/.test(String(e?.message))) {
        throw new Error("clicking that element did not open a file chooser. Target the <input type=file> itself (browser_snapshot, or a selector like 'input[type=file]'), or the button that opens the chooser.");
      }
      throw explain(s, e);
    }
    await settle(page);
    return withSnapshot(page, s, cfg, { uploaded: paths.length ? paths.map((p) => relative(home, p).startsWith("..") ? p : relative(home, p)) : ["(cleared the selection)"] });
  },

  async drag(s, a, cfg) {
    const page = await activePage(s);
    const steps = Number.isFinite(a.steps) ? Math.min(Math.max(a.steps, 1), 100) : 10;
    try {
      if (a.target && a.to) {
        await locate(page, a.target).dragTo(locate(page, a.to), { steps });
      } else {
        // Coordinates, or an element to or from a point: done with the mouse, which fires the pointer events a
        // canvas, a slider or a sortable list listens to.
        const from = a.target ? await centre(locate(page, a.target)) : point(a.fromX, a.fromY, "from");
        const to = a.to ? await centre(locate(page, a.to)) : point(a.toX, a.toY, "to");
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps });
        await page.mouse.up();
      }
    } catch (e) { throw explain(s, e); }
    await settle(page);
    return withSnapshot(page, s, cfg);
  },

  async downloads(s, a, cfg) {
    const page = await activePage(s);
    if (a.wait) {
      const ms = Number.isFinite(a.timeout) ? a.timeout : cfg.timeoutMs;
      // A click that starts a download returns before the download does; wait for one to appear, then for all to finish.
      const t0 = Date.now();
      while (!s.downloads.length && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
      await downloadsSettled(s, Math.max(0, ms - (Date.now() - t0)));
    }
    const list = s.downloads.map((d) => `${d.n}. ${d.state}: ${d.name}${d.path ? ` → ${d.path}` : ""}${d.bytes !== undefined ? ` (${d.bytes} bytes)` : ""}${d.why ? ` (${d.why})` : ""} from ${d.url}`);
    return pageState(page, s, {
      downloads: list.length ? list : ["none yet: a click on a download link saves the file here by itself"],
      ...(a.wait && s.downloads.some((d) => !d.done) ? { note: "some downloads were still running when the wait ran out" } : {}),
    });
  },

  async wait(s, a, cfg) {
    const page = await activePage(s);
    const timeout = Number.isFinite(a.timeout) ? Math.min(Math.max(a.timeout, 100), 300_000) : cfg.timeoutMs;
    if (a.text) await page.getByText(a.text).first().waitFor({ state: "visible", timeout });
    else if (a.textGone) await page.getByText(a.textGone).first().waitFor({ state: "hidden", timeout });
    else if (a.target) await locate(page, a.target).waitFor({ state: a.state || "visible", timeout });
    else if (a.loadState) await page.waitForLoadState(a.loadState, { timeout });
    else if (Number.isFinite(a.time)) await page.waitForTimeout(Math.min(a.time, timeout));
    else await page.waitForLoadState("load", { timeout });
    return withSnapshot(page, s, cfg);
  },

  async console(s, a) {
    const page = await activePage(s);
    const order = { debug: 0, log: 1, info: 1, warning: 2, warn: 2, error: 3, pageerror: 3 };
    const min = order[a.level || "info"] ?? 1;
    const matching = s.consoles.filter((m) => (order[m.type] ?? 1) >= min);
    const limit = Number.isFinite(a.limit) ? Math.max(1, a.limit) : 100;
    const items = matching.slice(-limit);
    const dropped = matching.length - items.length;
    return pageState(page, s, {
      total: s.consoles.length,
      shown: items.length,
      ...(dropped > 0 ? { note: `${dropped} older matching message(s) not shown; raise \`limit\` or filter by \`level\`.` } : {}),
      messages: items.map((m) => `[${m.type}] ${trimValue(m.text, 2000, "message").text}`),
    });
  },

  async network(s, a) {
    const page = await activePage(s);
    if (Number.isFinite(a.index)) {
      const r = s.requests[a.index - 1];
      if (!r) throw new Error(`no request #${a.index}; there are ${s.requests.length}`);
      return pageState(page, s, { request: r });
    }
    let items = s.requests.map((r, i) => ({ ...r, n: i + 1 }));
    if (a.filter) {
      const re = new RegExp(a.filter, "i");
      items = items.filter((r) => re.test(r.url) || re.test(String(r.status)));
    }
    if (a.failedOnly) items = items.filter((r) => r.status === "failed" || (typeof r.status === "number" && r.status >= 400));
    const blocked = s.blocked.slice(-20).map((b) => `${b.url} (${b.why})`);
    return pageState(page, s, {
      total: s.requests.length,
      shown: items.length,
      requests: items.map((r) => `${r.n}. ${r.method} ${r.status ?? "-"} ${r.url}${r.failure ? ` (${r.failure})` : ""}`),
      ...(blocked.length ? { blocked } : {}),
    });
  },

  async tabs(s, a, cfg) {
    if (a.action === "new") {
      const p = await s.ctx.newPage();
      s.active = Math.max(0, s.pages.indexOf(p));
      if (a.url) { try { await p.goto(normaliseUrl(a.url), { waitUntil: "load" }); } catch (e) { throw explain(s, e); } }
    } else if (a.action === "select") {
      if (!Number.isInteger(a.index) || a.index < 0 || a.index >= s.pages.length) throw new Error(`no tab #${a.index}; there are ${s.pages.length}`);
      s.active = a.index;
      await s.pages[a.index].bringToFront();
    } else if (a.action === "close") {
      const i = Number.isInteger(a.index) ? a.index : s.active;
      const p = s.pages[i];
      if (!p) throw new Error(`no tab #${i}; there are ${s.pages.length}`);
      await p.close();
    }
    const page = await activePage(s);
    const list = [];
    for (let i = 0; i < s.pages.length; i++) {
      let t = "";
      try { t = await s.pages[i].title(); } catch { /* navigating */ }
      list.push(`${i}${i === s.active ? " *" : ""}: ${t || "(untitled)"} — ${s.pages[i].url()}`);
    }
    if (a.action === "new" || a.action === "select") return withSnapshot(page, s, cfg, { tabList: list });
    return pageState(page, s, { tabList: list });
  },

  async state(s, a, cfg) {
    const page = await activePage(s);
    const kind = a.kind || "cookies";
    const action = a.action || "list";

    if (kind === "cookies") {
      if (action === "list" || action === "get") {
        const all = await s.ctx.cookies();
        const items = a.name ? all.filter((c) => c.name === a.name) : all;
        // A session cookie is often a JWT of a few kB; the name, domain and expiry are what one reads the jar for.
        return pageState(page, s, {
          cookies: items.map((c) => (typeof c.value === "string" && c.value.length > 200 ? { ...c, value: `${c.value.slice(0, 200)}… [${c.value.length} chars]` } : c)),
        });
      }
      if (action === "set") {
        if (!a.name) throw new Error("setting a cookie needs a `name`");
        const host = (() => { try { return new URL(page.url()).hostname; } catch { return ""; } })();
        if (!a.domain && !host) throw new Error("setting a cookie on a blank page needs a `domain`");
        await s.ctx.addCookies([{ name: a.name, value: String(a.value ?? ""), domain: a.domain || host, path: a.path || "/" }]);
        return pageState(page, s, { set: a.name });
      }
      if (action === "clear") { await s.ctx.clearCookies(); return pageState(page, s, { cleared: "cookies" }); }
      if (action === "delete") {
        if (!a.name) throw new Error("deleting a cookie needs a `name`");
        await s.ctx.clearCookies({ name: a.name });
        return pageState(page, s, { deleted: a.name });
      }
      throw new Error(`cookies take the actions list, get, set, delete and clear, not '${action}'`);
    }

    if (kind === "localStorage" || kind === "sessionStorage") {
      const store = kind;
      if (action === "list") {
        // Apps keep serialised state here; values are summarised and fetched one at a time with `get`.
        const items = await page.evaluate((st) => {
          const s2 = window[st]; const o = {};
          for (let i = 0; i < s2.length; i++) {
            const k = s2.key(i); const v = s2.getItem(k) ?? "";
            o[k] = v.length > 300 ? `${v.slice(0, 300)}… [${v.length} chars; use action 'get' with this key]` : v;
          }
          return o;
        }, store);
        return pageState(page, s, { [store]: items });
      }
      if (!["clear"].includes(action) && !a.name) throw new Error(`${action} on ${store} needs a \`name\` (the key)`);
      if (action === "get") {
        const v = await page.evaluate(([st, k]) => window[st].getItem(k), [store, a.name]);
        const t = trimValue(v, cfg.valueChars, `${store} value`);
        return pageState(page, s, { key: a.name, value: v === null ? "(not set)" : t.text, ...(t.note ? { valueNote: t.note } : {}) });
      }
      if (action === "set") { await page.evaluate(([st, k, v]) => window[st].setItem(k, v), [store, a.name, String(a.value ?? "")]); return pageState(page, s, { set: a.name }); }
      if (action === "delete") { await page.evaluate(([st, k]) => window[st].removeItem(k), [store, a.name]); return pageState(page, s, { deleted: a.name }); }
      if (action === "clear") { await page.evaluate((st) => window[st].clear(), store); return pageState(page, s, { cleared: store }); }
      throw new Error(`${store} takes the actions list, get, set, delete and clear, not '${action}'`);
    }

    if (kind === "storageState") {
      const st = await s.ctx.storageState();
      const t = trimValue(JSON.stringify(st, null, 2), cfg.valueChars, "storage state");
      return pageState(page, s, { storageState: t.text, ...(t.note ? { storageStateNote: t.note } : {}) });
    }

    if (kind === "dialog") {
      if (action === "accept" || action === "dismiss") {
        s.dialogPlan = { action, promptText: a.promptText };
        return pageState(page, s, { armed: `${action} the next dialog`, hint: "Now do the click that opens it." });
      }
      return pageState(page, s, {
        dialogs: s.dialogs.map((d) => `[${d.type}] ${d.message} → ${d.answered}`),
        armed: s.dialogPlan ? s.dialogPlan.action : "none (dialogs are dismissed)",
      });
    }

    if (kind === "viewport") {
      if (!Number.isFinite(a.width) || !Number.isFinite(a.height)) throw new Error("resizing needs `width` and `height`");
      await page.setViewportSize({ width: a.width, height: a.height });
      return pageState(page, s, { viewport: `${a.width}×${a.height}` });
    }

    throw new Error(`unknown state kind '${kind}'`);
  },
};

function point(x, y, what) {
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error(`a drag needs a \`${what === "from" ? "target" : "to"}\` element or \`${what}X\` and \`${what}Y\``);
  return { x: Number(x), y: Number(y) };
}

async function centre(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("that element is not visible, so it has no position to drag from or to");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A file to upload must exist, be a file, and sit under home or one of the uploadRoots settings. */
async function uploadPath(f, home, cfg) {
  const full = isAbsolute(String(f)) ? String(f) : resolve(home, String(f));
  let real;
  try { real = await realpath(full); } catch { throw new Error(`no such file to upload: ${f}`); }
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${f} is not a file`);
  const roots = [home, ...cfg.uploadRoots.map((r) => (isAbsolute(r) ? r : resolve(home, r)))];
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => r)));
  if (!realRoots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))) {
    throw new Error(`${f} is outside home and the uploadRoots setting, so it may not be uploaded`);
  }
  return real;
}

async function save(dir, home, buf, requested, ext) {
  await mkdir(dir, { recursive: true });
  let name = basename(String(requested || "").trim());
  if (!name) name = `${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
  if (!extname(name)) name += `.${ext}`;
  const full = join(dir, name);
  await writeFile(full, buf);
  const rel = relative(home, full);
  return { path: rel.startsWith("..") ? full : rel, bytes: buf.length };
}

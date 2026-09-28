// The browser, the per-chat contexts, and the queue that keeps one chat's calls in order.
//
// All of a space's package code runs in one long-lived Node process, so one Chrome is shared by
// every chat and each chat gets its own BrowserContext (Playwright's isolation unit: separate
// cookies, storage and cache). The agent re-imports a package when any of its files changes, so
// module-level variables would give every version its own browser and leak the old ones. The
// state lives on globalThis under a registered symbol instead, and every version of this module
// shares it.

import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const require = createRequire(import.meta.url);
const KEY = Symbol.for("@thetis/browser.state");

export const DEFAULTS = {
  executablePath: "",
  headless: true,
  timeoutMs: 15_000,
  idleMinutes: 15,
  viewportWidth: 1280,
  viewportHeight: 800,
  snapshotChars: 12_000,
  valueChars: 8_000,
  screenshotDir: "browser",
  downloadDir: "browser/downloads",
  downloadMaxMb: 200,
  uploadRoots: "",
  screenshotToModel: true,
  imageMaxWidth: 1280,
  shareWithSubagents: true,
  allowHosts: "",
  denyHosts: "",
  blockPrivateNetworks: false,
  userAgent: "",
};

/** The package settings over the defaults, with numbers clamped to something that works. */
export function settings(config = {}) {
  const c = { ...DEFAULTS };
  for (const [k, v] of Object.entries(config ?? {})) if (v !== undefined && v !== null && v !== "") c[k] = v;
  const num = (k, lo, hi) => { const n = Number(c[k]); c[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[k]; };
  num("timeoutMs", 1000, 300_000);
  num("idleMinutes", 1, 24 * 60);
  num("viewportWidth", 200, 7680);
  num("viewportHeight", 200, 4320);
  num("snapshotChars", 1000, 100_000);
  num("valueChars", 500, 100_000);
  num("downloadMaxMb", 1, 4096);
  num("imageMaxWidth", 320, 3840);
  c.screenshotToModel = c.screenshotToModel !== false && c.screenshotToModel !== "false";
  c.uploadRoots = pathList(c.uploadRoots);
  c.allowHosts = hostList(c.allowHosts);
  c.denyHosts = hostList(c.denyHosts);
  c.headless = c.headless !== false && c.headless !== "false";
  c.shareWithSubagents = c.shareWithSubagents !== false && c.shareWithSubagents !== "false";
  c.blockPrivateNetworks = c.blockPrivateNetworks === true || c.blockPrivateNetworks === "true";
  return c;
}

function hostList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[")) { try { return hostList(JSON.parse(s)); } catch { /* fall through */ } }
  return s.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/** Paths keep their case and may hold spaces, so only commas and newlines separate them. */
function pathList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[")) { try { return pathList(JSON.parse(s)); } catch { /* fall through */ } }
  return s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}

/** `example.com` matches itself and every subdomain; `*.example.com` only the subdomains. */
export function hostMatches(host, list) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  return list.some((p) => {
    if (p === "*") return true;
    if (p.startsWith("*.")) return h.endsWith(p.slice(1));
    return h === p || h.endsWith(`.${p}`);
  });
}

export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80");
}

function state() {
  if (!globalThis[KEY]) {
    globalThis[KEY] = { browser: null, launching: null, executable: null, sessions: new Map(), reaper: null };
  }
  return globalThis[KEY];
}

export function playwrightVersion() {
  try { return require("playwright-core/package.json").version; } catch { return null; }
}

const CANDIDATES = [
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** The Chrome to drive: the setting, else a system Chrome or Chromium, else Playwright's own download. */
export function findExecutable(cfg) {
  if (cfg.executablePath) return cfg.executablePath;
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

async function getBrowser(cfg) {
  const st = state();
  if (st.browser?.isConnected()) return st.browser;
  if (st.launching) return st.launching;
  const { chromium } = require("playwright-core");
  const executablePath = findExecutable(cfg);
  st.launching = chromium.launch({
    executablePath: executablePath ?? undefined,
    headless: cfg.headless,
    // No user namespaces inside the fence, so Chrome's own sandbox cannot start.
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  }).then((b) => {
    st.browser = b;
    st.executable = executablePath ?? "playwright's bundled chromium";
    b.on("disconnected", () => { if (st.browser === b) { st.browser = null; st.scratch = null; } st.sessions.clear(); });
    return b;
  }, (e) => {
    const msg = String(e?.message ?? e).split("\n")[0];
    throw new Error(executablePath
      ? `could not start Chrome at ${executablePath}: ${msg}`
      : `no Chrome or Chromium found (looked in ${CANDIDATES.slice(0, 6).join(", ")}) and Playwright's own download is not installed: ${msg}\n`
        + "Set the extension's `executablePath` setting to a Chrome binary, or run `npx playwright-core install chromium` in a terminal.");
  }).finally(() => { st.launching = null; });
  return st.launching;
}

/** Which browser context a call uses: the chat's own, or its parent's for a helper chat. */
export function sessionKey(env, cfg) {
  const s = env?.session ?? {};
  return String((cfg.shareWithSubagents && s.parent) || s.id || "default");
}

async function getSession(key, cfg, home) {
  const st = state();
  const s = st.sessions.get(key);
  if (s && !s.closed) { s.lastUsed = Date.now(); s.cfg = cfg; if (home) s.home = home; return s; }
  // Two calls arriving together in a new chat must get one context, not two.
  st.opening ??= new Map();
  if (st.opening.has(key)) return st.opening.get(key);
  const p = openSession(key, cfg, home).finally(() => st.opening.delete(key));
  st.opening.set(key, p);
  return p;
}

async function openSession(key, cfg, home) {
  const st = state();
  let s;
  const b = await getBrowser(cfg);
  const ctx = await b.newContext({
    viewport: { width: cfg.viewportWidth, height: cfg.viewportHeight },
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    ...(cfg.userAgent ? { userAgent: cfg.userAgent } : {}),
  });
  ctx.setDefaultTimeout(cfg.timeoutMs);
  ctx.setDefaultNavigationTimeout(cfg.timeoutMs);
  s = { key, ctx, pages: [], active: 0, consoles: [], requests: [], dialogs: [], dialogPlan: null, blocked: [], downloads: [], cfg, home, lastUsed: Date.now(), closed: false, queue: Promise.resolve() };
  ctx.on("page", (page) => attachPage(s, page));
  ctx.on("close", () => { s.closed = true; if (st.sessions.get(key) === s) st.sessions.delete(key); });
  await installPolicy(s, cfg);
  st.sessions.set(key, s);
  await ctx.newPage();
  startReaper(cfg);
  return s;
}

/** The host rules: allow/deny for page navigations, and private addresses for every request. */
async function installPolicy(s, cfg) {
  if (!cfg.allowHosts.length && !cfg.denyHosts.length && !cfg.blockPrivateNetworks) return;
  await s.ctx.route("**/*", async (route) => {
    const req = route.request();
    let why = null;
    try {
      const u = new URL(req.url());
      if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:") {
        const host = u.hostname.replace(/^\[|\]$/g, "");
        if (req.isNavigationRequest()) {
          if (cfg.denyHosts.length && hostMatches(host, cfg.denyHosts)) why = `${host} is in denyHosts`;
          else if (cfg.allowHosts.length && !hostMatches(host, cfg.allowHosts)) why = `${host} is not in allowHosts`;
        }
        if (!why && cfg.blockPrivateNetworks) {
          const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
          const bad = ips.find(isPrivateAddress);
          if (bad) why = `${host} resolves to the private address ${bad} (blockPrivateNetworks is on)`;
        }
      }
    } catch { /* not a URL we judge */ }
    if (why) {
      s.blocked.push({ url: req.url(), why, ts: Date.now() });
      if (s.blocked.length > 100) s.blocked.shift();
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
}

const cap = (arr, n = 500) => { if (arr.length > n) arr.shift(); };

function attachPage(s, page) {
  if (s.pages.includes(page)) return;
  s.pages.push(page);
  page.on("console", (m) => { s.consoles.push({ type: m.type(), text: m.text(), ts: Date.now() }); cap(s.consoles); });
  page.on("pageerror", (e) => { s.consoles.push({ type: "pageerror", text: String(e), ts: Date.now() }); cap(s.consoles); });
  page.on("requestfinished", async (req) => {
    let status = null;
    try { status = (await req.response())?.status() ?? null; } catch { /* gone */ }
    s.requests.push({ method: req.method(), url: req.url(), status, type: req.resourceType(), ts: Date.now() });
    cap(s.requests);
  });
  page.on("requestfailed", (req) => {
    s.requests.push({ method: req.method(), url: req.url(), status: "failed", failure: req.failure()?.errorText ?? "", type: req.resourceType(), ts: Date.now() });
    cap(s.requests);
  });
  // An unanswered dialog blocks the page, so one handler answers every dialog: the armed plan
  // once, else a dismiss. (A second, one-shot listener would race this one.)
  page.on("dialog", async (d) => {
    const plan = s.dialogPlan;
    s.dialogPlan = null;
    s.dialogs.push({ type: d.type(), message: d.message(), answered: plan?.action ?? "dismiss", ts: Date.now() });
    cap(s.dialogs, 50);
    try {
      if (plan?.action === "accept") await d.accept(plan.promptText ?? undefined);
      else await d.dismiss();
    } catch { /* already gone */ }
  });
  // Downloads are saved as they finish; the model reads the list with browser_downloads. A download
  // over downloadMaxMb is cancelled rather than filling the disk.
  page.on("download", (d) => saveDownload(s, d));
  page.on("close", () => {
    const i = s.pages.indexOf(page);
    if (i >= 0) s.pages.splice(i, 1);
    if (i >= 0 && i < s.active) s.active--;
    if (s.active >= s.pages.length) s.active = Math.max(0, s.pages.length - 1);
  });
}

async function saveDownload(s, d) {
  const cfg = s.cfg;
  const entry = { n: s.downloads.length + 1, url: d.url(), name: d.suggestedFilename() || "download", state: "in progress", ts: Date.now() };
  s.downloads.push(entry);
  if (s.downloads.length > 100) s.downloads.shift();
  try {
    const dir = isAbsolute(cfg.downloadDir) ? cfg.downloadDir : resolve(s.home || process.cwd(), cfg.downloadDir);
    await mkdir(dir, { recursive: true });
    const file = await uniqueName(dir, safeName(entry.name));
    const tmp = await d.path();
    const size = tmp ? (await stat(tmp)).size : 0;
    if (size > cfg.downloadMaxMb * 1024 * 1024) {
      await d.delete().catch(() => {});
      Object.assign(entry, { state: "refused", why: `${(size / 1048576).toFixed(1)} MB is over downloadMaxMb (${cfg.downloadMaxMb})` });
      return;
    }
    await d.saveAs(file);
    const rel = relative(s.home || process.cwd(), file);
    Object.assign(entry, { state: "saved", path: rel.startsWith("..") ? file : rel, bytes: size });
  } catch (e) {
    Object.assign(entry, { state: "failed", why: String(e?.message ?? e).split("\n")[0] });
  } finally {
    entry.done = true;
    for (const w of s.downloadWaiters?.splice(0) ?? []) w();
  }
}

/** A suggested name from the site is not trusted: no directories, no control characters, no dotfiles. */
export function safeName(name) {
  const base = basename(String(name)).replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
  return (base || "download").slice(0, 200);
}

async function uniqueName(dir, name) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = join(dir, i ? `${stem} (${i})${ext}` : name);
    try { await stat(candidate); } catch { return candidate; }
  }
}

/** Resolves when every download of the session has finished, or after `ms`. */
export function downloadsSettled(s, ms) {
  if (s.downloads.every((d) => d.done)) return Promise.resolve(true);
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms);
    (s.downloadWaiters ??= []).push(() => { if (s.downloads.every((d) => d.done)) { clearTimeout(timer); done(true); } });
  });
}

export async function activePage(s) {
  if (!s.pages.length) {
    const p = await s.ctx.newPage();
    attachPage(s, p);
    s.active = 0;
    return p;
  }
  if (s.active >= s.pages.length) s.active = s.pages.length - 1;
  return s.pages[s.active];
}

function startReaper(cfg) {
  const st = state();
  st.idleMs = cfg.idleMinutes * 60_000;
  if (st.reaper) return;
  st.reaper = setInterval(async () => {
    const now = Date.now();
    for (const [k, v] of st.sessions) {
      if (now - v.lastUsed > st.idleMs) { st.sessions.delete(k); await v.ctx.close().catch(() => {}); }
    }
    if (!st.sessions.size && st.browser?.isConnected() && !st.launching) {
      const b = st.browser; st.browser = null; st.scratch = null;
      await b.close().catch(() => {});
    }
  }, 60_000);
  st.reaper.unref?.();
}

/**
 * Runs `fn(session)` after every earlier call of the same chat has finished, so two calls in
 * one round cannot race on the same page.
 */
export async function withSession(key, cfg, fn, home) {
  const s = await getSession(key, cfg, home);
  const run = s.queue.then(() => { s.lastUsed = Date.now(); return fn(s); });
  s.queue = run.catch(() => {});
  return run;
}

/**
 * A copy of an image small enough for a model: at most `maxW` wide and 7800 tall (Anthropic's ceiling is
 * 8000 on either side), and under 3.5 MB (every vision API takes that). Drawn by Chrome itself on a scratch
 * page in a context of its own, so no image library is needed and no chat's tabs are touched.
 */
export async function forModel(buf, mediaType, maxW, cfg) {
  const st = state();
  const b = await getBrowser(cfg);
  if (!st.scratch || st.scratch.isClosed()) {
    const ctx = await b.newContext();
    st.scratch = await ctx.newPage();
  }
  const src = `data:${mediaType};base64,${buf.toString("base64")}`;
  const out = await st.scratch.evaluate(async ({ src, maxW, maxH, maxBytes }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    let scale = Math.min(1, maxW / w0, maxH / h0);
    let q = 0.8, url = "";
    for (let i = 0; i < 6; i++) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w0 * scale));
      c.height = Math.max(1, Math.round(h0 * scale));
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      url = c.toDataURL("image/jpeg", q);
      if (url.length * 0.75 <= maxBytes) return { url, w0, h0, w: c.width, h: c.height };
      if (q > 0.5) q -= 0.15; else scale *= 0.75;
    }
    return { url, w0, h0, w: Math.round(w0 * scale), h: Math.round(h0 * scale) };
  }, { src, maxW, maxH: 7800, maxBytes: 3.5 * 1024 * 1024 });
  return { buf: Buffer.from(out.url.slice(out.url.indexOf(",") + 1), "base64"), mediaType: "image/jpeg", width: out.w, height: out.h, from: { width: out.w0, height: out.h0 } };
}

export function peekSessions() { return state().sessions; }
export function browserInfo() {
  const st = state();
  const b = st.browser?.isConnected() ? st.browser : null;
  return { running: !!b, version: b ? b.version() : null, executable: st.executable };
}

export async function closeSession(key) {
  const st = state();
  const s = st.sessions.get(key);
  if (!s) return false;
  st.sessions.delete(key);
  await s.queue.catch(() => {});
  await s.ctx.close().catch(() => {});
  return true;
}

export async function closeAll() {
  const st = state();
  const n = st.sessions.size;
  for (const [k, s] of st.sessions) { st.sessions.delete(k); await s.ctx.close().catch(() => {}); }
  st.scratch = null;
  if (st.browser) { const b = st.browser; st.browser = null; await b.close().catch(() => {}); }
  if (st.reaper) { clearInterval(st.reaper); st.reaper = null; }
  return n;
}

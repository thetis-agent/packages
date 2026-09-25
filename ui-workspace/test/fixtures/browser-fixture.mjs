// The Chromium harness for @thetis/ui-workspace: the real gateway-web page and assets, the package's real
// manifest declared through `api/ui`, its real browser modules served under `ext/@thetis/ui-workspace/…`,
// and every package command answered from an in-memory file tree, so a case needs no daemon, no fence and
// no model. The shape follows gateway-web/test/browser-fixture.mjs (`withPage`, the EventSource stub,
// `reviewEmit`, the artifacts on failure); it is a separate file because that fixture fixes its `api/ui`
// answer to a review package and refuses every `api/ext/*` request.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("../../", import.meta.url));
const UI = join(PKG, "ui");
const ASSETS = fileURLToPath(new URL("../../../gateway-web/assets/", import.meta.url));
const ORIGIN = "http://thetis-browser.test";
export const NAME = "@thetis/ui-workspace";
export const KEY = { place: `${NAME}#workspace`, dock: `${NAME}#files` };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".md": "text/markdown" };
const manifest = JSON.parse(await readFile(join(PKG, "package.json"), "utf8"));

// ---- the roots the stub answers ----

export const HOME = "/home/rae";
export const SHARED = "/srv/shared";
export const NOVA = "/srv/games/nova";
export const ORLEANS = "/srv/games/orleans";
export const USER = "rae";
export const INLINE_LIMIT = 200_000;
export const MAX_TEXT = 4 * 1024 * 1024;
export const MAX_UPLOAD = 64 * 1024 * 1024;
export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const MEDIA = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", mp3: "audio/mpeg" };

const LANGUAGES = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", json: "json", md: "md", html: "html", css: "css", py: "py", sh: "sh", toml: "toml", yaml: "yaml", yml: "yaml" };
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const TEXTUAL = new Set(["txt", "log", "env", "gitignore", "csv", ...Object.keys(LANGUAGES)]);

function kindOf(name) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext === "md") return { language: "md", preview: "markdown" };
  if (IMAGES.has(ext)) return { language: null, preview: "image" };
  if (ext === "svg") return { language: "html", preview: "svg" };
  if (ext === "pdf") return { language: null, preview: "pdf" };
  if (TEXTUAL.has(ext) || (!ext && name.startsWith("."))) return { language: LANGUAGES[ext] ?? "plain", preview: "text" };
  return { language: null, preview: "none" };
}

const nameOf = (p) => p.slice(p.lastIndexOf("/") + 1);
const parentOf = (p) => (p.lastIndexOf("/") > 0 ? p.slice(0, p.lastIndexOf("/")) : "/");

/**
 * An in-memory tree behind the package's commands. Paths are absolute or `~/…`; `.git` inside a
 * deletion is refused with the server's sentence, as are writes on the shared root.
 */
export function createFs() {
  const nodes = new Map(); // absolute path -> { kind, text, size, mtime, binary, more }
  // Wall-clock mtimes, strictly increasing, so etags never repeat and the strip's "Saved just now" is true.
  let clock = Date.now() - 60_000;
  const tick = () => (clock = Math.max(clock + 1, Date.now()));
  // As the server: a relative path resolves against home (`~` is not expanded there, so a `~/…` request
  // would land in a directory called `~`; the fixture keeps the old shorthand for its own seeding only).
  const abs = (p) => {
    const s = String(p ?? "");
    if (s === "~") return HOME;
    if (s.startsWith("~/")) return `${HOME}/${s.slice(2)}`;
    if (s && !s.startsWith("/")) return `${HOME}/${s}`;
    return s.length > 1 ? s.replace(/\/+$/, "") : s;
  };
  const node = (p) => nodes.get(abs(p)) ?? null;
  const rootOf = (p) => {
    const a = abs(p);
    const under = (base) => a === base || a.startsWith(`${base}/`);
    if (under(HOME)) return { root: "home", mode: "rw", writable: true, display: a === HOME ? "." : a.slice(HOME.length + 1) };
    if (under(SHARED)) return { root: "shared", mode: "ro", writable: false, display: a };
    if (under(NOVA)) return { root: "mount", mode: "rw", writable: true, display: a, mount: { path: NOVA, mode: "rw" } };
    return null;
  };
  const contained = (p, { write = false } = {}) => {
    const r = rootOf(p);
    if (!r) throw new Error(`${p} is outside your home, the shared directory and your project directories.`);
    if (write && !r.writable) throw new Error(`${r.display} is on the shared directory, which is read-only for you.`);
    return { absolute: abs(p), ...r };
  };
  const etagOf = (n) => `${n.mtime}-${n.size}`;
  const iso = (ms) => new Date(ms).toISOString();

  const fs = {
    dir(p, extra = {}) {
      nodes.set(abs(p), { kind: "dir", size: 0, mtime: tick(), ...extra });
      return fs;
    },
    file(p, text = "", extra = {}) {
      const size = extra.size ?? Buffer.byteLength(text);
      nodes.set(abs(p), { kind: "file", text, size, mtime: tick(), binary: false, ...extra });
      return fs;
    },
    touch(p, text) {
      const n = node(p);
      if (!n) throw new Error(`${p} is not in the fixture tree`);
      n.text = text;
      n.size = Buffer.byteLength(text);
      n.mtime = tick();
      return etagOf(n);
    },
    has: (p) => nodes.has(abs(p)),
    etag: (p) => etagOf(node(p)),
    text: (p) => node(p)?.text ?? null,
    children(p) {
      const base = abs(p);
      return [...nodes.keys()].filter((k) => k !== base && parentOf(k) === base).sort();
    },
    under(p) {
      const base = abs(p);
      return [...nodes.keys()].filter((k) => k === base || k.startsWith(`${base}/`));
    },

    // ---- the commands ----

    /** A case may reshape the roots (`fs.patchRoots = (roots) => roots`), for a project in another state. */
    patchRoots: null,
    roots({ admin }) {
      const base = {
        user: USER,
        admin,
        home: { path: HOME, mode: "rw" },
        shared: { path: SHARED, mode: "ro" },
        projects: [
          {
            id: "p_nova",
            name: "Nova",
            current: true,
            directories: [
              { path: NOVA, name: "nova", parent: "/srv/games", state: "ready", mode: "rw", kind: "dir", mount: { path: NOVA, mode: "rw" } },
              { path: ORLEANS, name: "orleans", parent: "/srv/games", state: "unmounted", mode: "rw", kind: "dir" },
            ],
            summary: { ready: 1, broken: 1 },
          },
        ],
        mounts: [{ path: NOVA, mode: "rw" }],
      };
      return typeof fs.patchRoots === "function" ? fs.patchRoots(base) : base;
    },
    list({ path, hidden = false }) {
      const r = contained(path);
      const n = node(path);
      if (!n) throw new Error(`${r.display} does not exist.`);
      if (n.kind !== "dir") throw new Error(`${r.display} is not a directory.`);
      const entries = fs
        .children(path)
        .map((k) => ({ name: nameOf(k), n: nodes.get(k) }))
        .filter((e) => hidden || !e.name.startsWith("."))
        .map((e) => ({ name: e.name, kind: e.n.kind, size: e.n.size, mtime: iso(e.n.mtime), etag: etagOf(e.n), hidden: e.name.startsWith(".") }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
      return { path: r.absolute, root: r.root, mode: r.mode, entries, more: Boolean(n.more) };
    },
    stat({ path }) {
      const r = contained(path);
      const n = node(path);
      if (!n) throw new Error(`${r.display} does not exist.`);
      const named = n.kind === "file" ? kindOf(nameOf(r.absolute)) : { language: null, preview: "none" };
      // As the server: the NUL sniff runs on the text kinds only; an image is an image, never "binary".
      const binary = (named.preview === "text" || named.preview === "markdown") && Boolean(n.binary);
      return {
        path: r.absolute,
        display: r.display,
        root: r.root,
        mode: r.mode,
        writable: r.writable,
        ...(r.mount ? { mount: r.mount } : {}),
        kind: n.kind,
        size: n.size,
        mtime: iso(n.mtime),
        etag: etagOf(n),
        language: binary ? null : named.language,
        preview: binary ? "none" : named.preview,
        tooLarge: n.kind === "file" && n.size > MAX_TEXT,
        binary,
      };
    },
    read({ path, part }) {
      const r = contained(path);
      const n = node(path);
      if (!n) throw new Error(`${r.display} does not exist.`);
      if (n.kind === "dir") throw new Error(`${r.display} is a directory, not a file; open it in the explorer instead.`);
      const named = kindOf(nameOf(r.absolute));
      const inline = n.size <= INLINE_LIMIT;
      const out = { path: r.absolute, etag: etagOf(n), size: n.size, mtime: iso(n.mtime), language: named.language, inline, truncated: n.size > MAX_TEXT, part: part ?? null };
      if (inline) out.text = n.text;
      return out;
    },
    write({ path, text, etag, force }) {
      const r = contained(path, { write: true });
      const existing = node(path);
      if (existing?.kind === "dir") throw new Error(`${r.display} is a directory, not a file.`);
      if (existing && etag && etag !== etagOf(existing) && !force) {
        return { ok: false, conflict: true, current: { etag: etagOf(existing), size: existing.size, mtime: iso(existing.mtime), text: existing.text } };
      }
      // `atomicWrite` makes the parents (`mkdir -p`), so a copy under a new `~/srv/…` lands.
      for (let p = parentOf(r.absolute); p && p !== "/" && !nodes.has(p); p = parentOf(p)) fs.dir(p);
      fs.file(r.absolute, String(text ?? ""));
      const n = node(r.absolute);
      return { ok: true, path: r.absolute, etag: etagOf(n), size: n.size, mtime: iso(n.mtime) };
    },
    mkdir({ path }) {
      const r = contained(path, { write: true });
      if (nodes.has(r.absolute)) throw new Error(`${r.display} already exists.`);
      fs.dir(r.absolute);
      return { path: r.absolute };
    },
    rename({ path, name }) {
      const r = contained(path, { write: true });
      if (!nodes.has(r.absolute)) throw new Error(`${r.display} does not exist.`);
      if (typeof name !== "string" || !name || name.includes("/")) throw new Error("The new name must be one segment.");
      const next = `${parentOf(r.absolute)}/${name}`;
      if (nodes.has(next)) throw new Error(`${name} already exists in ${parentOf(r.display)}.`);
      for (const k of fs.under(r.absolute)) {
        const n = nodes.get(k);
        nodes.delete(k);
        nodes.set(`${next}${k.slice(r.absolute.length)}`, n);
      }
      return { path: next };
    },
    count({ path }) {
      const r = contained(path);
      if (!nodes.has(r.absolute)) throw new Error(`${r.display} does not exist.`);
      let files = 0, dirs = 0, bytes = 0;
      for (const k of fs.under(r.absolute)) {
        if (k === r.absolute) continue;
        const n = nodes.get(k);
        if (n.kind === "dir") dirs += 1;
        else { files += 1; bytes += n.size; }
      }
      const n = node(r.absolute);
      if (n.kind === "file") { files = 1; bytes = n.size; }
      return { files, dirs, bytes, capped: false, zip: { files, dirs, bytes }, skipped: { files: 0, dirs: 0 } };
    },
    delete({ path, dryRun }) {
      const r = contained(path, { write: true });
      if ([HOME, SHARED, NOVA].includes(r.absolute)) throw new Error(`${r.display} is a root of your workspace (home, shared, or a mount) and cannot be deleted; delete what is inside it instead.`);
      if (!nodes.has(r.absolute)) throw new Error(`${r.display} does not exist.`);
      if (fs.under(r.absolute).some((k) => k !== r.absolute && nameOf(k) === ".git")) throw new Error(`${r.display} holds a .git directory, which is never deleted; move it aside first.`);
      const { files, dirs, bytes } = fs.count({ path });
      if (dryRun) return { files, dirs, bytes, capped: false };
      for (const k of fs.under(r.absolute)) nodes.delete(k);
      return { removed: { files, dirs } };
    },
    resolve({ paths }) {
      const results = {};
      for (const given of (Array.isArray(paths) ? paths : []).slice(0, 64)) {
        let candidate = given;
        if (!given.startsWith("/") && !given.startsWith("~")) candidate = [`${HOME}/${given}`, `${NOVA}/${given}`].find((c) => nodes.has(c)) ?? `${HOME}/${given}`;
        const r = rootOf(candidate);
        const n = node(candidate);
        results[given] = r && n ? { absolute: r.absolute ?? abs(candidate), display: r.display, root: r.root, mode: r.mode, kind: n.kind } : null;
      }
      return { results };
    },
    bind({ path, mode }) {
      return { ok: true, path, mode };
    },

    // ---- the raw exports, as the gateway calls them: (args, { method, body }) ----

    upload({ dir, name, replace }, { body }) {
      const d = contained(dir, { write: true });
      if (node(dir)?.kind !== "dir") throw new Error(`${d.display} is not a directory.`);
      if (typeof name !== "string" || !name || name.includes("/")) throw new Error("An upload needs a file name without a slash.");
      const path = `${d.absolute}/${name}`;
      const existing = node(path);
      if (existing && !replace) return { exists: true, path };
      fs.file(path, body.toString("utf8"), { size: body.length });
      const n = node(path);
      return { path, size: n.size, etag: etagOf(n), replaced: Boolean(existing) };
    },
    /** The bytes of a file: its text, a 1×1 PNG for an image, zero bytes for the rest; `part` windows the text. */
    raw({ path, download, part }) {
      const r = contained(path);
      const n = node(path);
      if (!n) throw new Error(`${r.display} does not exist.`);
      if (n.kind !== "file") throw new Error(`${r.display} is a directory; download it as a zip instead.`);
      const named = kindOf(nameOf(r.absolute));
      const ext = nameOf(r.absolute).includes(".") ? nameOf(r.absolute).slice(nameOf(r.absolute).lastIndexOf(".") + 1).toLowerCase() : "";
      let body = named.preview === "image" ? Buffer.from(PNG_1PX, "base64") : Buffer.from(n.text ?? "");
      if (body.length < n.size && named.preview !== "image") body = Buffer.concat([body, Buffer.alloc(n.size - body.length)]);
      if (part === "head") body = body.subarray(0, MAX_TEXT);
      else if (part === "tail") body = body.subarray(Math.max(0, body.length - MAX_TEXT));
      const inline = ["image", "svg", "pdf", "audio", "text", "markdown"].includes(named.preview) && !download;
      const type = named.preview === "image" ? MEDIA[ext] ?? "application/octet-stream" : named.preview === "pdf" ? "application/pdf" : named.preview === "none" ? "application/octet-stream" : "text/plain; charset=utf-8";
      return {
        status: 200,
        headers: { "content-type": type, "content-length": String(body.length), "content-disposition": inline ? "inline" : `attachment; filename="${nameOf(r.absolute)}"`, etag: etagOf(n), "cache-control": "no-store" },
        body,
      };
    },
    zip({ path }) {
      const r = contained(path);
      if (node(path)?.kind !== "dir") throw new Error(`${r.display} is not a directory.`);
      const body = Buffer.from("PK\u0005\u0006" + "\0".repeat(18), "latin1"); // an empty zip: the end-of-central-directory record alone
      return { status: 200, headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${nameOf(r.absolute)}.zip"`, "cache-control": "no-store" }, body };
    },
  };
  return fs;
}

/** About 6 MB of numbered lines, so the head and the tail windows can be told apart. */
function hugeText() {
  const parts = [];
  let bytes = 0;
  for (let i = 1; bytes < 6 * 1024 * 1024; i++) {
    const line = `line-${i} ${"·".repeat(20)}\n`;
    parts.push(line);
    bytes += Buffer.byteLength(line);
  }
  return parts.join("");
}

/** The tree every case starts from. */
export function seedFs() {
  const fs = createFs();
  fs.dir(HOME)
    .file(`${HOME}/README.md`, "# Rae\n\nHello **world**.\n\n![chart](img/chart.png)\n\n```js\nconst tide = 1;\n```\n")
    .file(`${HOME}/broken.md`, "# Broken\n\n![chart](img/chart.png)\n\n![missing](img/nope.png)\n")
    .dir(`${HOME}/img`)
    .file(`${HOME}/img/chart.png`, "", { size: 70 })
    .file(`${HOME}/notes.txt`, "one\ntwo\nthree\n")
    .file(`${HOME}/.secret`, "s=1\n")
    .dir(`${HOME}/src`)
    .file(`${HOME}/src/tide.ts`, Array.from({ length: 12 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n") + "\n")
    .file(`${HOME}/src/.env`, "X=1\n")
    .dir(`${HOME}/src/lib`)
    .file(`${HOME}/src/lib/util.ts`, "export const util = true;\n")
    .dir(`${HOME}/big`, { more: true })
    .file(`${HOME}/big/a.txt`, "a\n")
    .file(`${HOME}/big/b.txt`, "b\n")
    .file(`${HOME}/huge.log`, hugeText())
    .file(`${HOME}/data.csv`, Array.from({ length: 5000 }, (_, i) => `${i + 1},row-${i + 1},${"x".repeat(40)}`).join("\n") + "\n")
    .file(`${HOME}/photo.png`, "", { size: 1234 })
    .file(`${HOME}/blob.bin`, "", { size: 4096 })
    .dir(SHARED)
    .file(`${SHARED}/policy.txt`, "Shared policy\n")
    .file(`${SHARED}/guide.md`, "# Guide\n")
    .dir(NOVA)
    .file(`${NOVA}/README.md`, "# Nova\n")
    .dir(`${NOVA}/src`)
    .file(`${NOVA}/src/tide.ts`, Array.from({ length: 12 }, (_, i) => `export const nova${i + 1} = ${i + 1};`).join("\n") + "\n")
    .dir(`${NOVA}/docs`)
    .file(`${NOVA}/docs/plan.md`, "# Plan\n\n1. Ship.\n");
  return fs;
}

/** The `api/ui` extension record, from the package's real manifest, as gateway-web composes it for a role. */
export function declaration(role) {
  const ui = manifest.thetis.ui;
  const clears = (r) => !r || r === role || (r === "member" && role === "admin");
  return {
    package: NAME,
    version: manifest.version,
    base: `ext/${NAME}/`,
    entry: ui.entry,
    style: ui.style,
    commands: ui.commands.filter((c) => clears(c.role) && !c.stream && c.kind !== "raw").map((c) => c.verb),
    streams: ui.commands.filter((c) => clears(c.role) && c.stream).map((c) => c.verb),
    raw: ui.commands.filter((c) => clears(c.role) && c.kind === "raw").map((c) => c.verb),
    dock: (ui.dock ?? []).filter((e) => clears(e.role)),
    panel: [],
    places: (ui.places ?? []).filter((e) => clears(e.role)),
    sidebar: [],
    chips: [],
    composer: [],
    shelf: [],
    statusbar: [],
    hidden: [],
  };
}

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Polls `fn` (sync or async) until it answers truthy; a wait on a condition, never a fixed sleep. */
export async function until(fn, what = "the condition", { timeout = 5000, step = 25 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const out = await fn();
    if (out) return out;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, step));
  }
}

/**
 * Opens the page in a fresh context, wires every route, and runs `run(f)`. `options`: `role`
 * ("admin" | "member"), `viewport`, `fs` (a tree to use instead of `seedFs()`), `localStorage` (entries
 * written before the page's scripts run, as a person's earlier visit would have left them). Every error the page or the
 * routes report fails the case; a failed case leaves a screenshot and a trace under
 * `THETIS_BROWSER_ARTIFACTS` (default: a temp dir).
 */
export async function withPage(browser, name, options, run) {
  const { role = "admin", viewport = { width: 1300, height: 900 } } = options;
  const context = await browser.newContext({ viewport });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console.error: ${message.text()}`); });
  const id = "s_aaaa";
  const session = { id, title: "Browser regression", named: true, turns: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), project: "p_nova" };
  const conversation = options.conversation ?? [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier reply" }];
  // Further restored conversations (`others: [{ id, title, conversation }]`), listed after the first and opened from the sidebar by a case.
  const others = (options.others ?? []).map((o, i) => ({ session: { ...session, id: o.id, title: o.title ?? `Other ${i + 1}`, updatedAt: new Date(Date.now() - 60_000 * (i + 1)).toISOString() }, conversation: o.conversation ?? [] }));
  const moduleGate = deferred(), moduleRequested = deferred(); // `holdModule`: the entry module is not served until the case releases it
  const state = { uploadCap: MAX_UPLOAD }; // the gateway's maxBytes for `upload`, lowered by a case to see the 413
  const fs = options.fs ?? seedFs();
  const calls = [];     // every package command: { verb, args, session }
  const raw = [];       // every raw route hit: { method, verb, args, size?, status }
  const overrides = new Map(); // verb -> handler(args, { fs, session, next })

  if (options.localStorage) await page.addInitScript((entries) => { for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v); }, options.localStorage);
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      constructor() { super(); window.reviewEvents = this; }
      close() { this.readyState = 2; }
    };
    window.reviewEmit = (kind, value) => window.reviewEvents.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(value) }));
  });

  async function command(verb, args, sess) {
    const dflt = () => {
      if (typeof fs[verb] !== "function") throw new Error(`${NAME} has no stub for "${verb}"`);
      if (verb === "roots") return fs.roots({ admin: role === "admin" });
      return fs[verb](args ?? {});
    };
    const override = overrides.get(verb);
    return override ? override(args ?? {}, { fs, session: sess, next: dflt }) : dflt();
  }

  await page.route(`${ORIGIN}/**`, async (route) => {
    try {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname.includes("/api/")) {
        const api = pathname.split("/api/")[1];
        const method = route.request().method();
        if (api === "me") return route.fulfill({ json: { user: USER, role } });
        if (api === "models") return route.fulfill({ json: { model: "echo", models: [{ id: "echo", name: "Echo" }] } });
        if (api === "ui") return route.fulfill({ json: { extensions: [declaration(role)], refused: [] } });
        if (api === "sessions" && method === "GET") return route.fulfill({ json: [session, ...others.map((o) => o.session)] });
        if (api === `sessions/${id}`) return route.fulfill({ json: { ...session, conversation, children: [], usage: {}, turn: null } });
        const other = others.find((o) => api === `sessions/${o.session.id}`);
        if (other) return route.fulfill({ json: { ...other.session, conversation: other.conversation, children: [], usage: {}, turn: null } });
        if (api.startsWith(`ext/${NAME}/`)) {
          const rest = api.slice(`ext/${NAME}/`.length);
          if (rest.endsWith("/raw")) {
            const verb = rest.slice(0, -"/raw".length);
            const args = JSON.parse(url.searchParams.get("args") || "{}");
            const hit = { method, verb, args, status: 200 };
            raw.push(hit);
            try {
              if (method === "PUT") {
                const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
                hit.size = body.length;
                if (body.length > state.uploadCap) {
                  hit.status = 413;
                  return route.fulfill({ status: 413, json: { error: `That upload is larger than ${Math.floor(state.uploadCap / 1024)} KB.` } });
                }
                return route.fulfill({ json: { data: fs[verb](args, { method, body }) } });
              }
              const answer = fs[verb](args, { method });
              return route.fulfill({ status: answer.status ?? 200, headers: { ...answer.headers, "cache-control": "no-store" }, body: answer.body });
            } catch (err) {
              hit.status = 400;
              return route.fulfill({ status: 400, json: { error: err?.message || String(err) } });
            }
          }
          const verb = rest;
          const body = route.request().postDataJSON() ?? {};
          calls.push({ verb, args: body.args ?? {}, session: body.session ?? null });
          try {
            const data = await command(verb, body.args, body.session);
            return route.fulfill({ json: { data } });
          } catch (err) {
            // A handler may carry a status (a 502 is the fence closing under a bind); the stub's own refusals are 400s.
            return route.fulfill({ status: Number(err?.status) || 400, json: { error: err?.message || String(err) } });
          }
        }
        throw new Error(`Unexpected API: ${method} ${api}`);
      }
      if (pathname.includes(`/ext/${NAME}/`)) {
        const rel = normalize(decodeURIComponent(pathname.split(`/ext/${NAME}/`)[1])).replace(/^(\.\.[/\\])+/, "");
        if (rel === manifest.thetis.ui.entry) {
          moduleRequested.resolve();
          if (options.holdModule) await moduleGate.promise;
        }
        const body = await readFile(join(UI, rel));
        return route.fulfill({ body, contentType: TYPES[extname(rel)] || "application/octet-stream" });
      }
      const file = pathname.includes("/assets/") ? pathname.split("/assets/")[1] : "index.html";
      let body = await readFile(join(ASSETS, file));
      if (file === "index.html") body = Buffer.from(body.toString().replace("{{base}}", "/review").replace("{{nonce}}", "test"));
      await route.fulfill({ body, contentType: TYPES[extname(file)] || "application/octet-stream" });
    } catch (error) {
      errors.push(`route: ${error.message}`);
      await route.fulfill({ status: 500, json: { error: error.message } }).catch(() => {});
    }
  });

  const f = {
    page, id, fs, errors, calls, raw, role,
    callsFor: (verb) => calls.filter((c) => c.verb === verb),
    /** Overrides one command's answer; `handler(args, { fs, session, next })`; pass null to restore the stub. */
    on: (verb, handler) => (handler ? overrides.set(verb, handler) : overrides.delete(verb)),
    /** Drives turn events for the open conversation through the event stream, as the gateway suite does. */
    emit: (events, turn = "t_browser") => page.evaluate(({ id, events, turn }) => {
      for (const [index, event] of events.entries()) reviewEmit("turn", { session: id, turn, seq: index + 1, event, ...(event.type === "turn.start" ? { input: "New question" } : {}) });
    }, { id, events, turn }),
    until,
    /** Opens the Workspace place from the ≡ menu and waits for the explorer. */
    async openPlace() {
      await page.locator("#menu").click();
      await page.locator(`.menu-item[data-place="${KEY.place}"]`).click();
      await page.locator("#place:not([hidden]) .ws-place .ws-explorer").waitFor();
      await page.locator(`#place .tree-item[data-path="${HOME}"]`).waitFor();
    },
    row: (path, scope = "#place") => page.locator(`${scope} .tree-item[data-path="${path}"]`),
    tab: (path) => page.locator(`.ws-tab[data-path="${path}"]`),
    async expand(path, scope = "#place") {
      const row = f.row(path, scope);
      if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
      await page.locator(`${scope} .tree-item[data-path="${path}"][aria-expanded="true"]`).waitFor();
    },
    /** Right-clicks a node and returns the menu's labels once it is up. */
    /** Right-clicks a node and returns the labels of the shell's floating menu once it is up. */
    async contextMenu(locator) {
      await locator.click({ button: "right" });
      await page.locator(".menu.is-floating").waitFor();
      return page.locator(".menu.is-floating .menu-item .menu-label").allInnerTexts();
    },
    menuItem: (label) => page.locator(".menu.is-floating .menu-item", { has: page.locator(".menu-label", { hasText: label }) }),
    rawFor: (verb) => raw.filter((r) => r.verb === verb),
    setUploadCap: (bytes) => { state.uploadCap = bytes; },
    /** Resolves once the page has asked for the entry module; with `holdModule`, `releaseModule()` then lets it load. */
    moduleRequested: moduleRequested.promise,
    releaseModule: moduleGate.resolve,
  };

  try {
    await page.goto(`${ORIGIN}/review/#${id}`);
    await page.waitForFunction(() => window.reviewEvents);
    await page.evaluate(() => { reviewEmit("open", {}); reviewEmit("snapshot", { running: [] }); });
    await page.locator(`.pane[data-session="${id}"]`).waitFor();
    // The rows the record draws as `.msg`: the person's messages and the replies that said something (a
    // reply that only called tools draws cards, and a tool message draws into its card).
    const rows = conversation.filter((m) => m.role === "user" || (m.role === "assistant" && String(typeof m.content === "string" ? m.content : "").trim())).length;
    if (rows) await page.locator(`.pane[data-session="${id}"] .msg`).nth(rows - 1).waitFor();
    await page.locator(`.rail-btn[data-dock="${KEY.dock}"]`).waitFor();
    await run(f);
    assert.deepEqual(errors, [], "the browser and the fixture should report no errors");
    await context.tracing.stop();
  } catch (error) {
    const root = process.env.THETIS_BROWSER_ARTIFACTS || await mkdtemp(join(tmpdir(), "thetis-workspace-browser-"));
    await mkdir(root, { recursive: true });
    const artifact = join(root, name);
    await page.screenshot({ path: `${artifact}.png`, fullPage: true }).catch(() => {});
    await context.tracing.stop({ path: `${artifact}.zip` }).catch(() => {});
    console.error(`Browser failure artifacts: ${artifact}.{png,zip}`);
    if (errors.length) console.error(`Page errors: ${JSON.stringify(errors, null, 2)}`);
    throw error;
  } finally {
    await context.close();
  }
}

/** Launches the Chromium the environment names, as gateway-web's suite does. */
export async function launch() {
  const { chromium } = await import(process.env.THETIS_PLAYWRIGHT_MODULE || "playwright-core");
  return chromium.launch({ executablePath: process.env.THETIS_CHROMIUM_EXECUTABLE || undefined, headless: true, args: ["--no-sandbox"] });
}

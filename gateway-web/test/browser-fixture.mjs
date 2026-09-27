// Serve the real browser modules through Playwright's router. Every API and event stream is local to
// the fixture, so these timing checks neither need a daemon nor contact a model provider.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
const ORIGIN = "http://thetis-browser.test";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const SETUP = `export default async function install(ext) {
  window.reviewModuleEntered = true;
  if (window.reviewHoldModule) await new Promise(resolve => { window.reviewReleaseModule = resolve; });
  ext.sessions.onCreate(async id => {
    window.reviewHooks.push(id);
    if (window.reviewHoldHook) await new Promise((resolve, reject) => {
      window.reviewReleaseHook = resolve;
      window.reviewFailHook = () => reject(new Error("Project assignment failed"));
    });
  });
  window.reviewOrder.push("ready");
  window.reviewSetupReady = true;
}`;

/** A second extension for the chrome checks: two docks, two places, and a shelf, each registered with a plain body. */
const EXTRAS = `export default function install(ext) {
  for (const id of ["todo", "files"]) ext.dock(id, { draw: () => ({ body: ext.dom.el("p", {}, "dock " + id) }) });
  for (const id of ["workspace", "marketplace"]) ext.place(id, { open: (root) => { root.append(ext.dom.el("p", { class: "review-place" }, "place " + id)); } });
  ext.shelf("log", { mount: (root) => { root.append(ext.dom.el("pre", {}, "log")); } });
  window.reviewOpenShelf = () => ext.open.shelf("log");
}`;
export const EXTRAS_DECLARATION = {
  package: "@review/extras",
  entry: "extras.js",
  commands: [],
  dock: [{ id: "todo", label: "Todo", hint: "The plan the agent is working to" }, { id: "files", label: "Files", hint: "This chat's folders" }],
  places: [{ id: "marketplace", label: "Extensions", hint: "Add, update and remove extensions", order: 20 }, { id: "workspace", label: "Files", hint: "Your home, your folders and your projects' directories", order: 30 }],
  shelf: [{ id: "log", label: "Log" }],
};

/** A one-pixel PNG: enough for the browser to call it an image and draw it. */
export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export async function withPage(browser, name, options, run) {
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1300, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const uiGate = deferred(), recordGate = deferred(), sendGate = deferred();
  const uiRequested = deferred(), recordRequested = deferred(), sendRequested = deferred();
  const id = "s_aaaa";
  const session = { id, title: "Browser regression", named: true, turns: options.existing ? 1 : 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const conversation = options.existing ? [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier reply" }] : [];
  let created = false, sends = 0, uploads = 0;
  const createBodies = []; // what each POST /api/sessions carried: a draft's model rides there
  const sent = [];   // the JSON bodies of every send, so a test can check the wire shape
  const media = [];  // { name, mediaType, size } of every upload
  const posts = [];  // every other POST: [path, body], so a test can check what a button asked for
  const build = { id: options.build ?? "build-1" };
  const others = options.others ?? []; // more conversations: { id, title, conversation }
  let record = options.record ?? {};   // fields laid over the conversation's record
  await page.addInitScript(({ holdHook, holdModule }) => {
    window.reviewHooks = [];
    window.reviewOrder = [];
    window.reviewHoldHook = holdHook;
    window.reviewHoldModule = holdModule;
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (init?.method === "POST" && new URL(input, document.baseURI).pathname.endsWith("/api/sessions")) window.reviewOrder.push("create");
      return fetch(input, init);
    };
    window.EventSource = class extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      constructor() { super(); window.reviewEvents = this; }
      close() { this.readyState = 2; }
    };
    window.reviewEmit = (kind, value) => window.reviewEvents.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(value) }));
  }, options);

  await page.route(`${ORIGIN}/**`, async (route) => {
    try {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/ext/@review/setup/setup.js")) return route.fulfill({ contentType: TYPES[".js"], body: SETUP });
      if (pathname.endsWith("/ext/@review/extras/extras.js")) return route.fulfill({ contentType: TYPES[".js"], body: EXTRAS });
      if (pathname.includes("/api/")) {
        const api = pathname.split("/api/")[1];
        if (api === "me") return route.fulfill({ json: { user: "review", role: "admin", build, prefs: { developer: false } } });
        if (api === "restart") return route.fulfill({ json: options.restart ?? { pending: null, readable: true } });
        const other = others.find((o) => api === `sessions/${o.id}`);
        if (other) return route.fulfill({ json: { id: other.id, title: other.title, conversation: other.conversation ?? [], children: [], usage: {}, turn: null, ...(other.parent ? { parent: other.parent } : {}) } });
        if (route.request().method() === "POST" && (api.endsWith("/resume") || api.endsWith("/cancel") || api.startsWith("ext/"))) {
          posts.push([api, route.request().postDataJSON()]);
          return route.fulfill({ status: api.endsWith("/resume") ? 202 : 200, json: {} });
        }
        if (api === "models") return route.fulfill({ json: options.models ?? { model: "echo", models: [{ id: "echo", name: "Echo" }] } });
        if (api === "panel") return route.fulfill({ json: { user: "review", role: "admin", sections: ["packages"] } });
        if (api === "packages") return route.fulfill({ json: [{ name: "@review/extras", version: "0.1.0", type: "ui", description: "Chrome checks", scope: "me", steps: [], tools: [], service: false }] });
        if (api === "ui") {
          uiRequested.resolve();
          if (options.holdUi) await uiGate.promise;
          const extensions = [...(options.extension ? [{ package: "@review/setup", entry: "setup.js", commands: [] }] : []), ...(options.extras ? [EXTRAS_DECLARATION] : [])];
          return route.fulfill({ json: { extensions, refused: [] } });
        }
        if (api === "sessions" && route.request().method() === "POST") {
          created = true;
          createBodies.push(route.request().postDataJSON());
          return route.fulfill({ status: 201, json: { id } });
        }
        if (api === "sessions") return route.fulfill({ json: [...(options.existing || created ? [session] : []), ...others.filter((o) => !o.parent).map((o) => ({ id: o.id, title: o.title, named: true, turns: 1, createdAt: session.createdAt, updatedAt: session.updatedAt }))] });
        if (api === `sessions/${id}`) {
          recordRequested.resolve();
          if (options.holdRecord) await recordGate.promise;
          return route.fulfill({ json: { ...session, conversation, children: [], usage: {}, turn: null, ...record } });
        }
        if (api === "media" && route.request().method() === "POST") {
          uploads += 1;
          const name = new URL(route.request().url()).searchParams.get("name");
          const mediaType = String(route.request().headers()["content-type"] ?? "").split(";")[0];
          const size = route.request().postDataBuffer()?.length ?? 0;
          media.push({ name, mediaType, size });
          return route.fulfill({ status: 201, json: { id: `a_${uploads}`, mediaType, name, size } });
        }
        if (api.startsWith("media/")) return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG_1PX, "base64") });
        if (api === `sessions/${id}/send`) {
          sends += 1;
          sent.push(route.request().postDataJSON());
          sendRequested.resolve();
          if (options.holdSend) await sendGate.promise;
          return route.fulfill({ status: 202, json: { session: id } });
        }
        throw new Error(`Unexpected API: ${route.request().method()} ${api}`);
      }
      const file = pathname.includes("/assets/") ? pathname.split("/assets/")[1] : "index.html";
      let body = await readFile(join(ASSETS, file));
      if (file === "index.html") body = Buffer.from(body.toString().replace("{{base}}", "/review").replace("{{nonce}}", "test"));
      await route.fulfill({ body, contentType: TYPES[extname(file)] || "application/octet-stream" });
    } catch (error) {
      errors.push(error.message);
      await route.fulfill({ status: 500, json: { error: error.message } }).catch(() => {});
    }
  });

  try {
    await page.goto(`${ORIGIN}/review/${options.existing ? `#${id}` : ""}`);
    await page.waitForFunction(() => window.reviewEvents);
    await page.evaluate(async () => { window.reviewStore = (await import("./assets/lib/store.js")).store; });
    await page.evaluate((build) => { reviewEmit("open", {}); reviewEmit("snapshot", { running: [], build }); }, build);
    await run({
      page, id, uiRequested: uiRequested.promise, recordRequested: recordRequested.promise, sendRequested: sendRequested.promise,
      releaseUi: uiGate.resolve, releaseRecord: recordGate.resolve, releaseSend: sendGate.resolve,
      sends: () => sends,
      posts: () => posts,
      creates: () => created,
      createBodies: () => createBodies,
      setBuild: (id) => { build.id = id; },
      setRecord: (fields) => { record = fields; },
      /** The page came back from a reload: the stream is a new fake, which is opened and given a snapshot. */
      reopened: async (snapshot = { running: [], build }) => {
        await page.waitForFunction(() => window.reviewEvents);
        await page.evaluate(async () => { window.reviewStore = (await import("./assets/lib/store.js")).store; });
        await page.evaluate((snapshot) => { reviewEmit("open", {}); reviewEmit("snapshot", snapshot); }, snapshot);
      },
      sent: () => sent,
      media: () => media,
      emit: (events) => page.evaluate(({ id, events }) => {
        for (const [index, event] of events.entries()) reviewEmit("turn", { session: id, turn: "t_browser", seq: index + 1, event, ...(event.type === "turn.start" ? { input: "New question" } : {}) });
      }, { id, events }),
      idle: () => page.waitForFunction((id) => !window.reviewStore.isPending(id), id),
      running: () => page.evaluate((id) => window.reviewStore.isRunning(id), id),
    });
    assert.deepEqual(errors, [], "the browser and fixture should report no errors");
    await context.tracing.stop();
  } catch (error) {
    const root = process.env.THETIS_BROWSER_ARTIFACTS || await mkdtemp(join(tmpdir(), "thetis-browser-"));
    await mkdir(root, { recursive: true });
    const artifact = join(root, name);
    await page.screenshot({ path: `${artifact}.png`, fullPage: true }).catch(() => {});
    await context.tracing.stop({ path: `${artifact}.zip` }).catch(() => {});
    console.error(`Browser failure artifacts: ${artifact}.{png,zip}`);
    throw error;
  } finally {
    uiGate.resolve(); recordGate.resolve(); sendGate.resolve();
    await context.close();
  }
}

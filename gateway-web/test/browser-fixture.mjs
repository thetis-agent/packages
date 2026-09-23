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

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export async function withPage(browser, name, options, run) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
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
  let created = false, sends = 0;
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
      if (pathname.includes("/api/")) {
        const api = pathname.split("/api/")[1];
        if (api === "me") return route.fulfill({ json: { user: "review", role: "admin" } });
        if (api === "models") return route.fulfill({ json: { model: "echo", models: [{ id: "echo", name: "Echo" }] } });
        if (api === "ui") {
          uiRequested.resolve();
          if (options.holdUi) await uiGate.promise;
          return route.fulfill({ json: { extensions: options.extension ? [{ package: "@review/setup", entry: "setup.js", commands: [] }] : [], refused: [] } });
        }
        if (api === "sessions" && route.request().method() === "POST") {
          created = true;
          return route.fulfill({ status: 201, json: { id } });
        }
        if (api === "sessions") return route.fulfill({ json: options.existing || created ? [session] : [] });
        if (api === `sessions/${id}`) {
          recordRequested.resolve();
          if (options.holdRecord) await recordGate.promise;
          return route.fulfill({ json: { ...session, conversation, children: [], usage: {}, turn: null } });
        }
        if (api === `sessions/${id}/send`) {
          sends += 1;
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
    await page.evaluate(() => { reviewEmit("open", {}); reviewEmit("snapshot", { running: [] }); });
    await run({
      page, id, uiRequested: uiRequested.promise, recordRequested: recordRequested.promise, sendRequested: sendRequested.promise,
      releaseUi: uiGate.resolve, releaseRecord: recordGate.resolve, releaseSend: sendGate.resolve,
      sends: () => sends,
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

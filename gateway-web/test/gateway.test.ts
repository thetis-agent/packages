// The web gateway end to end: a real kernel with the echo provider fixture behind the HTTP server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createKernel, defaultConfig, T, type Kernel, type TurnEvent } from "@thetis/kernel";
import { createGateway } from "../src/server.js";
import { GatewayStore } from "../src/store.js";
import type { SessionSummary } from "../src/server.js";
import type { TurnMessage } from "../src/turns.js";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = resolve(PROJECT, "packages/kernel/test/fixtures");

let home: string;
let kernel: Kernel;
let base: string;
let server: Server;
let alice: string; // cookie header
let bob: string;

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** Opens the event stream and yields parsed frames. */
async function* frames(cookie: string, signal: AbortSignal): AsyncGenerator<Frame> {
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, at);
      buf = buf.slice(at + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}

/** Collects one turn's events from the stream for a session, ending at `turn.end`. */
async function turn(cookie: string, session: string, trigger: () => Promise<unknown>): Promise<{ events: TurnEvent[]; text: string; input?: string }> {
  const control = new AbortController();
  const gen = frames(cookie, control.signal);
  const first = await gen.next();
  assert.equal(first.value?.event, "snapshot");
  await trigger();
  const events: TurnEvent[] = [];
  let text = "";
  let input: string | undefined;
  for await (const f of gen) {
    if (f.event !== "turn") continue;
    const m = f.data as unknown as TurnMessage;
    if (m.session !== session) continue;
    events.push(m.event);
    if (m.input) input = m.input;
    if (m.event.type === "text") text += m.event.delta;
    if (m.event.type === "turn.end") break;
  }
  control.abort();
  return { events, text, input };
}

async function api(cookie: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) }, redirect: "manual" });
}

async function login(id: string, password: string): Promise<Response> {
  return fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id, password, next: "/" }), redirect: "manual" });
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "thetis-web-"));
  const sys = join(home, "system-packages");
  mkdirSync(sys);
  for (const name of ["harness-core", "tool-exec"]) symlinkSync(resolve(PROJECT, "packages", name), join(sys, name));
  symlinkSync(join(FIXTURES, "provider-echo"), join(sys, "provider-echo"));
  const config = defaultConfig(join(home, "data"), PROJECT);
  config.systemPackagesDir = sys;
  config.model = "echo";
  config.fence.sandbox = (process.env.THETIS_TEST_SANDBOX as "auto" | "none") ?? "auto";
  config.fence.readOnly.push(sys, FIXTURES);
  config.systemPackages = { "*": ["@thetis/harness-core", "@thetis/tool-exec"], _system: ["@thetis/provider-echo"] };
  config.packages = { "@thetis/provider-echo": { tag: "t1" } };
  config.requestTimeoutMs = 60_000;
  kernel = createKernel(config, (c) => c.bind(T.log, () => (line: string) => process.env.THETIS_TEST_VERBOSE && console.error(line)));
  kernel.users.create("alice");
  kernel.users.create("bob");
  const store = new GatewayStore(join(home, "data", "gateway-web"));
  await store.setPassword("alice", "wonderland");
  await store.setPassword("bob", "builder");
  const assets = join(home, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "<title>app</title>");
  writeFileSync(join(assets, "login.html"), "<title>login</title>");
  server = createGateway(kernel, store, { assets, log: (line) => process.env.THETIS_TEST_VERBOSE && console.error(line) });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await kernel.shutdown();
  rmSync(home, { recursive: true, force: true });
});

test("unauthenticated requests are redirected or refused", async () => {
  const page = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/login");
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
  assert.equal((await fetch(`${base}/login`)).status, 200);
  assert.equal((await fetch(`${base}/assets/../package.json`)).status, 404);
});

test("login refuses a wrong password and a wrong user, and accepts the right pair", async () => {
  const wrong = await login("alice", "nope");
  assert.equal(wrong.status, 303);
  assert.match(wrong.headers.get("location") ?? "", /error=refused/);
  assert.equal(wrong.headers.get("set-cookie"), null);
  const unknown = await login("mallory", "wonderland");
  assert.match(unknown.headers.get("location") ?? "", /error=refused/);
  const ok = await login("alice", "wonderland");
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/");
  const setCookie = ok.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^thetis_web=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict/);
  alice = setCookie.split(";")[0];
  bob = ((await login("bob", "builder")).headers.get("set-cookie") ?? "").split(";")[0];
  const me = await api(alice, "/api/me");
  assert.deepEqual(await me.json(), { user: "alice", role: "user" });
});

test("a suspended user's cookie stops working", async () => {
  kernel.users.setStatus("bob", "suspended");
  assert.equal((await api(bob, "/api/me")).status, 401);
  kernel.users.setStatus("bob", "active");
  assert.equal((await api(bob, "/api/me")).status, 200);
});

test("create, list, send, and stream a turn", async () => {
  const created = await api(alice, "/api/sessions", { method: "POST" });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  let list = (await (await api(alice, "/api/sessions")).json()) as SessionSummary[];
  assert.deepEqual(list.map((s) => s.id), [id]);
  assert.equal(list[0].title, "");
  assert.equal(list[0].status, "idle");

  const r = await turn(alice, id, async () => {
    const res = await api(alice, `/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "hello web" }) });
    assert.equal(res.status, 202);
  });
  assert.equal(r.input, "hello web");
  assert.equal(r.text, "echo: hello web (t1)");
  assert.deepEqual(r.events.map((e) => e.type).filter((t) => ["turn.start", "message", "turn.end"].includes(t)), ["turn.start", "message", "turn.end"]);

  list = (await (await api(alice, "/api/sessions")).json()) as SessionSummary[];
  assert.equal(list[0].title, "hello web");
  assert.equal(list[0].preview, "echo: hello web (t1)");
  assert.equal(list[0].turns, 1);
  const shown = (await (await api(alice, `/api/sessions/${id}`)).json()) as { conversation: unknown[]; turn: unknown; status: string };
  assert.equal(shown.conversation.length, 2);
  assert.equal(shown.turn, null);
  assert.equal(shown.status, "idle");
});

test("a second send on a running session is refused with 409, and cancel stops the turn", async () => {
  const { id } = (await (await api(alice, "/api/sessions", { method: "POST" })).json()) as { id: string };
  const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  const r = await turn(alice, id, async () => {
    assert.equal((await api(alice, `/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: `slow: ${words}` }) })).status, 202);
    assert.equal((await api(alice, `/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "again" }) })).status, 409);
    setTimeout(async () => {
      const res = await api(alice, `/api/sessions/${id}/cancel`, { method: "POST" });
      assert.deepEqual(await res.json(), { cancelled: true });
    }, 300);
  });
  const error = r.events.find((e) => e.type === "error") as { code?: string } | undefined;
  assert.equal(error?.code, "cancelled");
  assert.ok(r.text.split(" ").filter(Boolean).length < 40);
  const res = await api(alice, `/api/sessions/${id}/cancel`, { method: "POST" });
  assert.deepEqual(await res.json(), { cancelled: false });
});

test("a page that connects mid-turn receives the input and the events so far", async () => {
  const { id } = (await (await api(alice, "/api/sessions", { method: "POST" })).json()) as { id: string };
  const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  assert.equal((await api(alice, `/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: `slow: ${words}` }) })).status, 202);
  await new Promise((r) => setTimeout(r, 400));

  const shown = (await (await api(alice, `/api/sessions/${id}`)).json()) as { status: string; conversation: unknown[]; turn: { input: string; events: { seq: number; event: TurnEvent }[] } };
  assert.equal(shown.status, "running");
  assert.equal(shown.conversation.length, 0, "the turn is not saved yet");
  assert.equal(shown.turn.input, `slow: ${words}`);
  assert.ok(shown.turn.events.length > 2, "buffered events");
  assert.equal(shown.turn.events[0].seq, 1);

  const control = new AbortController();
  const gen = frames(alice, control.signal);
  const first = (await gen.next()).value!;
  assert.equal(first.event, "snapshot");
  const running = (first.data as { running: { session: string; input: string; events: unknown[] }[] }).running;
  assert.equal(running.length, 1);
  assert.equal(running[0].session, id);
  assert.equal(running[0].input, `slow: ${words}`);
  assert.ok(running[0].events.length > 2);
  let last: TurnMessage | undefined;
  for await (const f of gen) {
    if (f.event !== "turn") continue;
    last = f.data as unknown as TurnMessage;
    if (last.event.type === "turn.end") break;
  }
  control.abort();
  assert.ok(last && last.seq > running[0].events.length, "live events continue after the snapshot");
  const list = (await (await api(alice, "/api/sessions")).json()) as SessionSummary[];
  assert.equal(list.find((s) => s.id === id)?.status, "idle");
});

test("archive and restore", async () => {
  const list = (await (await api(alice, "/api/sessions")).json()) as SessionSummary[];
  const id = list[0].id;
  assert.equal((await api(alice, `/api/sessions/${id}/archive`, { method: "POST", body: JSON.stringify({ archived: true }) })).status, 200);
  let after = (await (await api(alice, "/api/sessions")).json()) as SessionSummary[];
  assert.equal(after.find((s) => s.id === id)?.archived, true);
  assert.equal((await api(alice, `/api/sessions/${id}/archive`, { method: "POST", body: JSON.stringify({ archived: false }) })).status, 200);
  after = (await (await api(alice, "/api/sessions")).json()) as SessionSummary[];
  assert.equal(after.find((s) => s.id === id)?.archived, false);
});

test("bob cannot see or drive alice's sessions", async () => {
  const id = ((await (await api(alice, "/api/sessions")).json()) as SessionSummary[])[0].id;
  assert.deepEqual(await (await api(bob, "/api/sessions")).json(), []);
  assert.equal((await api(bob, `/api/sessions/${id}`)).status, 404);
  assert.equal((await api(bob, `/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "hi" }) })).status, 404);
  assert.equal((await api(bob, `/api/sessions/${id}/archive`, { method: "POST", body: JSON.stringify({ archived: true }) })).status, 404);
  assert.equal((await api(bob, `/api/sessions/${id}/cancel`, { method: "POST" })).status, 404);
});

test("a cross-site POST is refused", async () => {
  const res = await api(alice, "/api/sessions", { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(res.status, 403);
});

test("logout revokes the cookie", async () => {
  const res = await api(bob, "/logout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal((await api(bob, "/api/me")).status, 401);
});

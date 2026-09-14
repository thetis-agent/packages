// The web gateway end to end: a real kernel with the echo provider fixture. Most cases drive the server
// in-process through the same RPC handler a fence gets; the last case installs the package into the system
// userspace and talks to the service the agent started inside the fence.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createControlHandler, createKernel, createRpcHandler, defaultConfig, T, type Kernel, type TurnEvent } from "@thetis/kernel";
import { exec as cpExec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { clientFromRpc } from "../src/client.js";
import { createGateway } from "../src/server.js";
import { ArchiveStore } from "../src/store.js";
import type { SessionSummary } from "../src/server.js";
import type { TurnMessage } from "../src/turns.js";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = resolve(PROJECT, "packages/kernel/test/fixtures");

let home: string;
let sysenv: string;
let kernel: Kernel;

/** A userspace-like environment rooted in a directory, for the marketplace index. */
function envAt(root: string) {
  return {
    exec: (cmd: string, opts: { timeoutMs?: number } = {}) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
        cpExec(cmd, { cwd: root, shell: "/bin/bash", timeout: opts.timeoutMs ?? 60_000 }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          done({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
    readFile: (p: string) => readFile(resolve(root, p), "utf8"),
    writeFile: async (p: string, content: string) => {
      await mkdir(dirname(resolve(root, p)), { recursive: true });
      await writeFile(resolve(root, p), content);
    },
  };
}

async function cookieFor(id: string, password: string): Promise<string> {
  return ((await login(id, password)).headers.get("set-cookie") ?? "").split(";")[0];
}
let base: string;
let server: Server;
let servicePort: number;
let alice: string; // cookie header
let bob: string;

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** Opens the event stream and yields parsed frames. */
async function* frames(cookie: string, signal: AbortSignal, origin = base): AsyncGenerator<Frame> {
  const res = await fetch(`${origin}/api/events`, { headers: { cookie }, signal });
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
async function turn(cookie: string, session: string, trigger: () => Promise<unknown>, origin = base): Promise<{ events: TurnEvent[]; text: string; input?: string }> {
  const control = new AbortController();
  const gen = frames(cookie, control.signal, origin);
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

async function api(cookie: string, path: string, init: RequestInit = {}, origin = base): Promise<Response> {
  return fetch(`${origin}${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) }, redirect: "manual" });
}

async function login(id: string, password: string, origin = base): Promise<Response> {
  return fetch(`${origin}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id, password, next: "/" }), redirect: "manual" });
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createTcpServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => done(port));
    });
  });
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "thetis-web-"));
  const sys = join(home, "system-packages");
  mkdirSync(sys);
  for (const name of ["harness-core", "tool-exec", "gateway-web", "prompt-cache"]) symlinkSync(resolve(PROJECT, "packages", name), join(sys, name));
  symlinkSync(join(FIXTURES, "provider-echo"), join(sys, "provider-echo"));
  servicePort = await freePort();
  const config = defaultConfig(join(home, "data"), PROJECT);
  config.systemPackagesDir = sys;
  config.model = "echo";
  config.fence.sandbox = (process.env.THETIS_TEST_SANDBOX as "auto" | "none") ?? "auto";
  config.fence.readOnly.push(sys, FIXTURES);
  config.systemPackages = { "*": ["@thetis/harness-core", "@thetis/tool-exec"], _system: ["@thetis/provider-echo"] };
  config.packages = { "@thetis/provider-echo": { tag: "t1" }, "@thetis/gateway-web": { port: servicePort } };
  config.requestTimeoutMs = 60_000;
  const log = (line: string) => process.env.THETIS_TEST_VERBOSE && console.error(line);
  kernel = createKernel(config, (c) => c.bind(T.log, () => log));
  kernel.users.create("alice");
  kernel.users.create("bob");
  kernel.users.create("root", "admin");
  await kernel.auth.setPassword("alice", "wonderland");
  await kernel.auth.setPassword("bob", "builder");
  await kernel.auth.setPassword("root", "rootpass1");

  // The in-process server: the same RPC handler the system fence gets, without the fence.
  const systemUs = kernel.userspaces.pathFor("_system");
  const rpc = createRpcHandler(systemUs, kernel.users, kernel.packages, kernel.sessions, kernel.auth, createControlHandler(kernel));
  sysenv = join(home, "sysenv");
  mkdirSync(sysenv);
  const assets = join(home, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "<title>app</title>");
  writeFileSync(join(assets, "login.html"), "<title>login</title>");
  server = createGateway(clientFromRpc(rpc), new ArchiveStore(join(home, "archive")), { assets, log, env: envAt(sysenv) });
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
  assert.equal((await fetch(`${base}/api/sessions`, { headers: { cookie: "thetis_web=nonsense" } })).status, 401);
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

test("a suspended user's cookie stops working, and a new password revokes old logins", async () => {
  kernel.users.setStatus("bob", "suspended");
  assert.equal((await api(bob, "/api/me")).status, 401);
  kernel.users.setStatus("bob", "active");
  assert.equal((await api(bob, "/api/me")).status, 200);
  await kernel.auth.setPassword("bob", "builder");
  assert.equal((await api(bob, "/api/me")).status, 401);
  bob = ((await login("bob", "builder")).headers.get("set-cookie") ?? "").split(";")[0];
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

test("panel: sections follow the role, and admin routes are refused for a user", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const root = await cookieFor("root", "rootpass1");
  assert.deepEqual((await (await api(alice, "/api/panel")).json()).sections, ["packages", "marketplace"]);
  assert.deepEqual((await (await api(root, "/api/panel")).json()).sections, ["packages", "marketplace", "people", "models", "overview"]);
  assert.equal((await api(alice, "/api/admin/users")).status, 403);
  assert.equal((await api(alice, "/api/marketplace/refresh", { method: "POST" })).status, 403);
  assert.equal((await api(root, "/api/admin/users")).status, 200);
});

test("people: an admin adds a person, changes the role and status, and removes them", async () => {
  const root = await cookieFor("root", "rootpass1");
  const created = await api(root, "/api/admin/users", { method: "POST", body: JSON.stringify({ id: "carol", role: "user", password: "carolpass1" }) });
  assert.equal(created.status, 201);
  assert.ok(((await (await api(root, "/api/admin/users")).json()) as { id: string }[]).some((u) => u.id === "carol"));
  assert.equal((await login("carol", "carolpass1")).status, 303, "the password was set");
  assert.equal((await api(root, "/api/admin/users/carol/role", { method: "POST", body: JSON.stringify({ role: "admin" }) })).status, 200);
  assert.equal(((await (await api(root, "/api/admin/users")).json()) as { id: string; role: string }[]).find((u) => u.id === "carol")?.role, "admin");
  assert.equal((await api(root, "/api/admin/users/carol/status", { method: "POST", body: JSON.stringify({ status: "suspended" }) })).status, 200);
  assert.equal((await api(root, "/api/admin/users/root/role", { method: "POST", body: JSON.stringify({ role: "user" }) })).status, 400, "not your own account");
  assert.equal((await api(root, "/api/admin/users", { method: "POST", body: JSON.stringify({ id: "Bad Id" }) })).status, 400);
  assert.equal((await api(root, "/api/admin/users/carol", { method: "DELETE" })).status, 200);
  assert.ok(!((await (await api(root, "/api/admin/users")).json()) as { id: string }[]).some((u) => u.id === "carol"));
});

test("packages: a person installs their own package, an admin promotes it, and everyone gets it", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const bob = await cookieFor("bob", "builder");
  const root = await cookieFor("root", "rootpass1");
  const us = kernel.sessions.userspaceFor(kernel.users.authorize("alice"));
  kernel.sessions.userspaceFor(kernel.users.authorize("bob"));
  const dir = join(us.home, "packages", "hello");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@alice/hello", version: "0.1.0", type: "module", main: "index.js", thetis: { type: "tool", tools: [{ name: "greet", description: "greets", export: "greet" }] } }));
  writeFileSync(join(dir, "index.js"), "export async function greet() { return 'hi'; }");

  const installed = await api(alice, "/api/packages", { method: "POST", body: JSON.stringify({ source: "packages/hello" }) });
  const installedText = await installed.text();
  assert.equal(installed.status, 201, installedText);
  const row = JSON.parse(installedText) as { name: string; scope: string; tools: string[] };
  assert.equal(row.name, "@alice/hello");
  assert.equal(row.scope, "me");
  assert.deepEqual(row.tools, ["greet"]);
  const mine = (await (await api(alice, "/api/packages")).json()) as { name: string; scope: string }[];
  assert.ok(mine.some((p) => p.name === "@alice/hello" && p.scope === "me"));
  assert.ok(mine.some((p) => p.name === "@thetis/harness-core" && p.scope === "everyone"));
  assert.ok((await api(alice, "/api/packages", { method: "POST", body: JSON.stringify({ source: "packages/nope" }) })).status >= 400, "a bad path is refused");

  const seen = (await (await api(root, "/api/admin/packages?user=alice")).json()) as { name: string }[];
  assert.ok(seen.some((p) => p.name === "@alice/hello"));
  const forAlice = await api(root, "/api/admin/packages", { method: "POST", body: JSON.stringify({ user: "alice", source: "@thetis/prompt-cache" }) });
  assert.equal(forAlice.status, 201, "an admin installs a system package for a user");
  assert.ok((await api(alice, "/api/packages", { method: "POST", body: JSON.stringify({ source: "@thetis/gateway-web" }) })).status >= 400, "a user cannot install a system package");
  assert.equal((await api(alice, "/api/admin/packages/%40alice%2Fhello/promote", { method: "POST", body: JSON.stringify({ user: "alice" }) })).status, 403);
  const promoted = await api(root, "/api/admin/packages/%40alice%2Fhello/promote", { method: "POST", body: JSON.stringify({ user: "alice" }) });
  const promotedText = await promoted.text();
  assert.equal(promoted.status, 200, promotedText);
  assert.equal((JSON.parse(promotedText) as { name: string }).name, "@thetis/hello");
  const bobs = (await (await api(bob, "/api/packages")).json()) as { name: string; scope: string }[];
  assert.ok(bobs.some((p) => p.name === "@thetis/hello" && p.scope === "everyone"), "bob has the promoted package");
  const alices = (await (await api(alice, "/api/packages")).json()) as { name: string }[];
  assert.ok(!alices.some((p) => p.name === "@alice/hello"));
  assert.equal((await api(alice, "/api/packages/%40thetis%2Fhello", { method: "DELETE" })).status, 200, "a person can remove a package from their own space");
  assert.equal((await api(alice, "/api/packages/not-a-name", { method: "DELETE" })).status, 404);
});

test("marketplace: search reads the index the service wrote; no index is a plain 404", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const root = await cookieFor("root", "rootpass1");
  assert.equal((await api(alice, "/api/marketplace?q=x")).status, 404);
  const index = {
    version: 1, updatedAt: "2026-09-14T00:00:00.000Z", registries: [{ name: "local", url: "file:///r", commit: "abc" }],
    packages: [
      { name: "@thetis/greet", version: "1.0.0", type: "tool", description: "Say hello", keywords: ["hello"], registry: "local", url: "file:///r", dir: "greet", source: "file:///r#greet", steps: [], tools: ["greet"], service: false },
      { name: "@thetis/memo", version: "0.2.0", type: "memory", description: "Remember", keywords: [], registry: "local", url: "file:///r", dir: "memo", source: "file:///r#memo", steps: [{ id: "load", phase: "prompt" }], tools: [], service: false },
    ],
  };
  mkdirSync(join(sysenv, "marketplace"), { recursive: true });
  writeFileSync(join(sysenv, "marketplace", "index.json"), JSON.stringify(index));
  const found = (await (await api(alice, "/api/marketplace?q=hello")).json()) as { total: number; results: { name: string }[] };
  assert.equal(found.total, 2);
  assert.deepEqual(found.results.map((r) => r.name), ["@thetis/greet"]);
  const all = (await (await api(root, "/api/marketplace")).json()) as { results: { name: string }[]; updatedAt: string };
  assert.equal(all.results.length, 2);
  assert.equal(all.updatedAt, index.updatedAt);
  const models = await api(root, "/api/admin/models");
  assert.equal(models.status, 200);
  assert.equal(((await models.json()) as { model: string }).model, "echo");
  const config = (await (await api(root, "/api/admin/config")).json()) as { model: string; home?: string };
  assert.equal(config.model, "echo");
});

test("installed into the system userspace, the gateway runs inside the fence and stops on uninstall", async () => {
  const origin = `http://127.0.0.1:${servicePort}`;
  const systemUs = kernel.userspaces.pathFor("_system");
  await kernel.packages.install(systemUs, kernel.users.authorize("_system"), "@thetis/gateway-web");
  await assert.rejects(fetch(`${origin}/login`), "nothing listens before the supervisor boots");
  await kernel.services.boot();
  assert.equal((await fetch(`${origin}/login`)).status, 200, "the service inside the fence answers");
  assert.equal((await fetch(`${origin}/`, { redirect: "manual" })).headers.get("location"), "/login");

  const cookie = ((await login("alice", "wonderland", origin)).headers.get("set-cookie") ?? "").split(";")[0];
  assert.match(cookie, /^thetis_web=[a-f0-9]{64}$/);
  assert.deepEqual(await (await api(cookie, "/api/me", {}, origin)).json(), { user: "alice", role: "user" });
  const { id } = (await (await api(cookie, "/api/sessions", { method: "POST" }, origin)).json()) as { id: string };
  const r = await turn(cookie, id, async () => {
    assert.equal((await api(cookie, `/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "through the fence" }) }, origin)).status, 202);
  }, origin);
  assert.equal(r.text, "echo: through the fence (t1)");
  assert.equal(kernel.sessions.inspect("alice", id).conversation.length, 2);

  await kernel.packages.uninstall(systemUs, "@thetis/gateway-web");
  await assert.rejects(fetch(`${origin}/login`), "the server is closed after uninstall");
});

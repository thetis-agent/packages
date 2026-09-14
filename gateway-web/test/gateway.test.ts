// End-to-end through the door: one gateway per person on a unix socket, the login target, and a real
// kernel with the echo provider fixture. Exercises sign-in, sessions and the event stream, the panel,
// isolation between people, and finally the same path with the gateways running inside real fences.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { exec as cpExec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createControlHandler, createKernel, createRpcHandler, defaultConfig, T, type Kernel, type TurnEvent, type Userspace } from "@thetis/kernel";
import { createDoor } from "@thetis/door";
import { createLogin } from "@thetis/gateway-login";
import { clientFromRpc } from "../src/client.js";
import { createGateway } from "../src/server.js";
import { GatewayStore } from "../src/store.js";
import type { TurnMessage } from "../src/turns.js";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = resolve(PROJECT, "packages/kernel/test/fixtures");
const PEOPLE = ["alice", "bob", "root"] as const;

let home: string;
let sysenv: string;
let kernel: Kernel;
let base: string;
let door: Server;
let servicePort: number;
const servers: Server[] = [];
const sockets: Record<string, string> = {};

/** A userspace-like environment rooted in a directory, for the marketplace index. */
function envAt(root: string) {
  return {
    shared: join(root, "shared"),
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

async function* frames(cookie: string, signal: AbortSignal, path: string, origin = base): AsyncGenerator<{ event: string; data: unknown }> {
  const res = await fetch(`${origin}${path}`, { headers: { cookie }, signal });
  assert.equal(res.status, 200, `stream ${path}: ${res.status}`);
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

/** Collects one turn's events from a person's stream, ending at `turn.end`. */
async function turn(cookie: string, user: string, session: string, trigger: () => Promise<unknown>, origin = base): Promise<{ events: TurnEvent[]; text: string; input?: string }> {
  const control = new AbortController();
  const gen = frames(cookie, control.signal, `/${user}/api/events`, origin);
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

async function login(id: string, password: string, next = "", origin = base): Promise<Response> {
  return fetch(`${origin}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id, password, next }), redirect: "manual" });
}

async function cookieFor(id: string, password: string, origin = base): Promise<string> {
  return ((await login(id, password, "", origin)).headers.get("set-cookie") ?? "").split(";")[0];
}

function freePort(): Promise<number> {
  return new Promise((done) => {
    const probe = createTcpServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => done(port));
    });
  });
}

function listen(server: Server, where: string | number): Promise<void> {
  return new Promise((done, fail) => server.once("error", fail).listen(where as never, done));
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "thetis-web-"));
  const sys = join(home, "system-packages");
  mkdirSync(sys);
  for (const name of ["harness-core", "tool-exec", "prompt-cache", "gateway-web", "gateway-login", "gateway-cli"]) symlinkSync(resolve(PROJECT, "packages", name), join(sys, name));
  symlinkSync(join(FIXTURES, "provider-echo"), join(sys, "provider-echo"));
  servicePort = await freePort();
  const config = defaultConfig(join(home, "data"), PROJECT);
  config.systemPackagesDir = sys;
  config.model = "echo";
  config.fence.sandbox = (process.env.THETIS_TEST_SANDBOX as "auto" | "none") ?? "auto";
  config.fence.network = "none";
  config.fence.readOnly.push(sys, FIXTURES);
  config.systemPackages = { "*": ["@thetis/harness-core", "@thetis/tool-exec"], _system: ["@thetis/provider-echo"] };
  config.packages = { "@thetis/provider-echo": { tag: "t1" } };
  config.door = { host: "127.0.0.1", port: servicePort };
  config.requestTimeoutMs = 60_000;
  const log = (line: string) => process.env.THETIS_TEST_VERBOSE && console.error(line);
  kernel = createKernel(config, (c) => c.bind(T.log, () => log));
  kernel.users.create("alice");
  kernel.users.create("bob");
  kernel.users.create("root", "admin");
  await kernel.auth.setPassword("alice", "wonderland");
  await kernel.auth.setPassword("bob", "builder");
  await kernel.auth.setPassword("root", "rootpass1");
  for (const id of PEOPLE) kernel.sessions.userspaceFor(kernel.users.authorize(id));

  // In-process: one gateway per person over that person's own RPC handler, the login target over the
  // system one, and the door in front. The same handlers the fences would get, without the fences.
  const rpcFor = (us: Userspace) => createRpcHandler(us, kernel.users, kernel.packages, kernel.sessions, kernel.auth, createControlHandler(kernel));
  const assets = join(home, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "<title>app</title><base href=\"{{base}}/\">");
  const loginAssets = join(home, "login-assets");
  mkdirSync(loginAssets);
  writeFileSync(join(loginAssets, "login.html"), "<title>login</title>");
  sysenv = join(home, "sysenv");
  mkdirSync(sysenv);
  const socketsDir = join(home, "s");
  mkdirSync(socketsDir);
  for (const id of PEOPLE) {
    const server = createGateway(clientFromRpc(rpcFor(kernel.userspaces.pathFor(id))), new GatewayStore(join(home, "store", id)), { assets, log, env: envAt(sysenv), user: id, base: `/${id}` });
    sockets[id] = join(socketsDir, `${id}.sock`);
    await listen(server, sockets[id]);
    servers.push(server);
  }
  const loginServer = createLogin(clientFromRpc(rpcFor(kernel.userspaces.pathFor("_system"))), { assets: loginAssets, log });
  const loginSocket = join(socketsDir, "login.sock");
  await listen(loginServer, loginSocket);
  servers.push(loginServer);
  door = createDoor({ loginSocket, socketFor: (u) => sockets[u], log });
  await listen(door, 0);
  base = `http://127.0.0.1:${(door.address() as AddressInfo).port}`;
});

after(async () => {
  for (const s of [door, ...servers]) await new Promise<void>((done) => s.close(() => done()));
  await kernel.shutdown();
  rmSync(home, { recursive: true, force: true });
});

test("without a cookie: the root goes to sign in, a person's page goes to sign in with next, the API is 401, a stranger is 404", async () => {
  const root = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(root.status, 303);
  assert.equal(root.headers.get("location"), "/login");
  const page = await fetch(`${base}/alice/`, { redirect: "manual" });
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/login?next=%2Falice%2F");
  assert.equal((await fetch(`${base}/alice/api/me`)).status, 401);
  assert.equal((await fetch(`${base}/alice`, { redirect: "manual" })).headers.get("location"), "/alice/");
  assert.equal((await fetch(`${base}/nobody/`)).status, 404);
  assert.equal((await fetch(`${base}/login`)).status, 200);
});

test("login: a wrong password is refused; success sets the cookie and lands on the person's own prefix", async () => {
  const wrong = await login("alice", "nope");
  assert.equal(wrong.status, 303);
  assert.match(wrong.headers.get("location") ?? "", /^\/login\?error=refused/);
  assert.equal(wrong.headers.get("set-cookie"), null);
  const ok = await login("alice", "wonderland", "/bob/api/me");
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/alice/", "a next outside the person's prefix is ignored");
  const setCookie = ok.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^thetis_web=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(";")[0];
  const me = await api(cookie, "/alice/api/me");
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { user: "alice", role: "user" });
  const home = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
  assert.equal(home.headers.get("location"), "/alice/", "the root sends a signed-in person home");
  assert.equal((await api(cookie, "/alice/")).status, 200);
});

test("a suspended person cannot sign in, and a password change signs them out", async () => {
  kernel.users.setStatus("bob", "suspended");
  assert.match((await login("bob", "builder")).headers.get("location") ?? "", /error=refused/);
  kernel.users.setStatus("bob", "active");
  const bob = await cookieFor("bob", "builder");
  assert.equal((await api(bob, "/bob/api/me")).status, 200);
  await kernel.auth.setPassword("bob", "builder");
  assert.equal((await api(bob, "/bob/api/me")).status, 401);
});

test("create, list, send, and stream one turn through the door", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const created = await api(cookie, "/alice/api/sessions", { method: "POST" });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  const r = await turn(cookie, "alice", id, async () => {
    const sent = await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
    assert.equal(sent.status, 202);
  });
  assert.equal(r.text, "echo: hello (t1)");
  assert.equal(r.input, "hello");
  assert.deepEqual(r.events.map((e) => e.type).filter((t) => ["turn.start", "message", "turn.end"].includes(t)), ["turn.start", "message", "turn.end"]);
  const list = (await (await api(cookie, "/alice/api/sessions")).json()) as { id: string; title: string; preview: string; turns: number }[];
  const row = list.find((s) => s.id === id)!;
  assert.equal(row.title, "hello");
  assert.equal(row.turns, 1);
  const shown = (await (await api(cookie, `/alice/api/sessions/${id}`)).json()) as { conversation: unknown[]; status: string };
  assert.equal(shown.conversation.length, 2);
  assert.equal(shown.status, "idle");
});

test("a busy session answers 409, and cancel stops the turn", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const { id } = (await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  const r = await turn(cookie, "alice", id, async () => {
    assert.equal((await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: `slow: ${words}` }) })).status, 202);
    assert.equal((await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "again" }) })).status, 409);
    setTimeout(() => void api(cookie, `/alice/api/sessions/${id}/cancel`, { method: "POST" }), 300);
  });
  assert.equal((r.events.find((e) => e.type === "error") as { code?: string })?.code, "cancelled");
  assert.ok(r.text.split(" ").filter(Boolean).length < 40);
});

test("a page that connects mid-turn receives the snapshot of the turn in progress", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const { id } = (await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  assert.equal((await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "slow: a b c d e f g h" }) })).status, 202);
  await new Promise((r) => setTimeout(r, 120));
  const control = new AbortController();
  const gen = frames(cookie, control.signal, "/alice/api/events");
  const first = (await gen.next()).value as { event: string; data: { running: { session: string; events: unknown[] }[] } };
  assert.equal(first.event, "snapshot");
  const running = first.data.running.find((r) => r.session === id);
  assert.ok(running && running.events.length > 0, "the snapshot carries the events so far");
  control.abort();
  const rec = (await (await api(cookie, `/alice/api/sessions/${id}`)).json()) as { turn: { events: unknown[] } | null };
  assert.ok(rec.turn === null || rec.turn.events.length > 0);
});

test("archive and restore", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const { id } = (await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  assert.equal((await api(cookie, `/alice/api/sessions/${id}/archive`, { method: "POST", body: JSON.stringify({ archived: true }) })).status, 200);
  let list = (await (await api(cookie, "/alice/api/sessions")).json()) as { id: string; archived: boolean }[];
  assert.equal(list.find((s) => s.id === id)?.archived, true);
  assert.equal((await api(cookie, `/alice/api/sessions/${id}/archive`, { method: "POST", body: JSON.stringify({ archived: false }) })).status, 200);
  list = (await (await api(cookie, "/alice/api/sessions")).json()) as { id: string; archived: boolean }[];
  assert.equal(list.find((s) => s.id === id)?.archived, false);
});

test("isolation: bob's cookie is refused at alice's gateway, and alice's session is unknown at bob's", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const bob = await cookieFor("bob", "builder");
  const { id } = (await (await api(alice, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  assert.equal((await api(bob, "/alice/api/me")).status, 401, "the kernel resolves a token only for the fence's own user");
  assert.equal((await api(bob, "/alice/api/sessions")).status, 401);
  assert.equal((await api(bob, `/bob/api/sessions/${id}`)).status, 404);
  assert.equal((await api(bob, `/bob/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "hi" }) })).status, 404);
});

test("a cross-site POST is refused", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const res = await api(cookie, "/alice/api/sessions", { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(res.status, 403);
});

test("logout revokes the cookie", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  assert.equal((await api(cookie, "/alice/api/me")).status, 200);
  const res = await fetch(`${base}/logout`, { method: "POST", headers: { cookie }, redirect: "manual" });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal((await api(cookie, "/alice/api/me")).status, 401);
});

test("panel: sections follow the role, and admin routes are refused for a user", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const root = await cookieFor("root", "rootpass1");
  assert.deepEqual((await (await api(alice, "/alice/api/panel")).json()).sections, ["packages"]);
  assert.deepEqual((await (await api(root, "/root/api/panel")).json()).sections, ["packages", "people", "models", "activity", "overview"]);
  assert.equal((await api(alice, "/alice/api/admin/users")).status, 403);
  assert.equal((await api(root, "/root/api/admin/users")).status, 200);
});

test("people: an admin adds a person, changes the role and status, and removes them; the journal says so", async () => {
  const root = await cookieFor("root", "rootpass1");
  const created = await api(root, "/root/api/admin/users", { method: "POST", body: JSON.stringify({ id: "carol", role: "user", password: "carolpass1" }) });
  assert.equal(created.status, 201);
  assert.ok(((await (await api(root, "/root/api/admin/users")).json()) as { id: string }[]).some((u) => u.id === "carol"));
  assert.equal((await login("carol", "carolpass1")).status, 303, "the password was set");
  assert.equal((await api(root, "/root/api/admin/users/carol/role", { method: "POST", body: JSON.stringify({ role: "admin" }) })).status, 200);
  assert.equal(((await (await api(root, "/root/api/admin/users")).json()) as { id: string; role: string }[]).find((u) => u.id === "carol")?.role, "admin");
  assert.equal((await api(root, "/root/api/admin/users/carol/status", { method: "POST", body: JSON.stringify({ status: "suspended" }) })).status, 200);
  assert.equal((await api(root, "/root/api/admin/users/root/role", { method: "POST", body: JSON.stringify({ role: "user" }) })).status, 400, "not your own account");
  assert.equal((await api(root, "/root/api/admin/users", { method: "POST", body: JSON.stringify({ id: "Bad Id" }) })).status, 400);
  assert.equal((await api(root, "/root/api/admin/users/carol", { method: "DELETE" })).status, 200);
  assert.ok(!((await (await api(root, "/root/api/admin/users")).json()) as { id: string }[]).some((u) => u.id === "carol"));
  const rows = (await (await api(root, "/root/api/admin/journal?limit=50")).json()) as { kind: string; actor?: string; target?: string }[];
  assert.ok(rows.some((r) => r.kind === "user.create" && r.target === "carol" && r.actor === "root"));
  assert.ok(rows.some((r) => r.kind === "user.remove" && r.target === "carol"));
});

test("packages: a person installs their own package, an admin promotes it, and everyone gets it", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const bob = await cookieFor("bob", "builder");
  const root = await cookieFor("root", "rootpass1");
  const us = kernel.userspaces.pathFor("alice");
  const dir = join(us.home, "packages", "hello");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@alice/hello", version: "0.1.0", type: "module", main: "index.js", thetis: { type: "tool", tools: [{ name: "greet", description: "greets", export: "greet" }] } }));
  writeFileSync(join(dir, "index.js"), "export async function greet() { return 'hi'; }");

  const installed = await api(alice, "/alice/api/packages", { method: "POST", body: JSON.stringify({ source: "packages/hello" }) });
  const installedText = await installed.text();
  assert.equal(installed.status, 201, installedText);
  const row = JSON.parse(installedText) as { name: string; scope: string; tools: string[] };
  assert.equal(row.name, "@alice/hello");
  assert.equal(row.scope, "me");
  assert.deepEqual(row.tools, ["greet"]);
  const mine = (await (await api(alice, "/alice/api/packages")).json()) as { name: string; scope: string; description: string }[];
  assert.ok(mine.some((p) => p.name === "@alice/hello" && p.scope === "me" && p.description === ""));
  assert.ok(mine.some((p) => p.name === "@thetis/harness-core" && p.scope === "everyone" && p.description.startsWith("The default harness")));
  assert.ok((await api(alice, "/alice/api/packages", { method: "POST", body: JSON.stringify({ source: "packages/nope" }) })).status >= 400, "a bad path is refused");
  assert.ok((await api(alice, "/alice/api/packages", { method: "POST", body: JSON.stringify({ source: "@thetis/gateway-web" }) })).status >= 400, "a user cannot install a system package");

  const seen = (await (await api(root, "/root/api/admin/packages?user=alice")).json()) as { name: string }[];
  assert.ok(seen.some((p) => p.name === "@alice/hello"));
  const forAlice = await api(root, "/root/api/admin/packages", { method: "POST", body: JSON.stringify({ user: "alice", source: "@thetis/prompt-cache" }) });
  assert.equal(forAlice.status, 201, "an admin installs a system package for a user");
  assert.equal((await api(alice, "/alice/api/admin/packages/%40alice%2Fhello/promote", { method: "POST", body: JSON.stringify({ user: "alice" }) })).status, 403);
  const promoted = await api(root, "/root/api/admin/packages/%40alice%2Fhello/promote", { method: "POST", body: JSON.stringify({ user: "alice" }) });
  const promotedText = await promoted.text();
  assert.equal(promoted.status, 200, promotedText);
  assert.equal((JSON.parse(promotedText) as { name: string }).name, "@thetis/hello");
  const bobs = (await (await api(bob, "/bob/api/packages")).json()) as { name: string; scope: string }[];
  assert.ok(bobs.some((p) => p.name === "@thetis/hello" && p.scope === "everyone"), "bob has the promoted package");
  const alices = (await (await api(alice, "/alice/api/packages")).json()) as { name: string }[];
  assert.ok(!alices.some((p) => p.name === "@alice/hello"));
  assert.equal((await api(alice, "/alice/api/packages/%40thetis%2Fhello", { method: "DELETE" })).status, 200, "a person can remove a package from their own space");
  assert.equal((await api(alice, "/alice/api/packages/not-a-name", { method: "DELETE" })).status, 404);

  // A shipped package an admin installs for themselves is theirs only, until it is installed for everyone.
  const own = await api(root, "/root/api/packages", { method: "POST", body: JSON.stringify({ source: "@thetis/gateway-cli" }) });
  assert.equal(own.status, 201, await own.text());
  const roots = (await (await api(root, "/root/api/packages")).json()) as { name: string; scope: string }[];
  assert.ok(roots.some((p) => p.name === "@thetis/gateway-cli" && p.scope === "me"), "installed for one person: only me");
  assert.ok(!((await (await api(bob, "/bob/api/packages")).json()) as { name: string }[]).some((p) => p.name === "@thetis/gateway-cli"));

  // Install for everyone: a shipped package reaches every person now and every new person later.
  assert.equal((await api(alice, "/alice/api/admin/packages/everyone", { method: "POST", body: JSON.stringify({ source: "@thetis/gateway-cli" }) })).status, 403);
  const everyone = await api(root, "/root/api/admin/packages/everyone", { method: "POST", body: JSON.stringify({ source: "@thetis/gateway-cli" }) });
  const everyoneText = await everyone.text();
  assert.equal(everyone.status, 200, everyoneText);
  const got = JSON.parse(everyoneText) as { name: string; userspaces: string[] };
  assert.equal(got.name, "@thetis/gateway-cli");
  assert.ok(got.userspaces.includes("bob") && !got.userspaces.includes("_system"));
  assert.ok(((await (await api(bob, "/bob/api/packages")).json()) as { name: string; scope: string }[]).some((p) => p.name === "@thetis/gateway-cli" && p.scope === "everyone"));
  assert.ok(((await (await api(root, "/root/api/packages")).json()) as { name: string; scope: string }[]).some((p) => p.name === "@thetis/gateway-cli" && p.scope === "everyone"), "the admin's own row now says everyone");
  assert.equal((await api(root, "/root/api/admin/users", { method: "POST", body: JSON.stringify({ id: "dave" }) })).status, 201);
  assert.ok(kernel.packages.installed(kernel.userspaces.pathFor("dave")).some((p) => p.name === "@thetis/gateway-cli"), "a new person is seeded with it");
  await api(root, "/root/api/admin/users/dave", { method: "DELETE" });
});

test("marketplace: search reads the index in the shared directory; no index is a plain 404", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const root = await cookieFor("root", "rootpass1");
  assert.equal((await api(alice, "/alice/api/marketplace?q=x")).status, 404);
  const index = {
    version: 1, updatedAt: "2026-09-14T00:00:00.000Z", registries: [{ name: "local", url: "file:///r", commit: "abc" }],
    packages: [
      { name: "@thetis/greet", version: "1.0.0", type: "tool", description: "Say hello", keywords: ["hello"], registry: "local", url: "file:///r", dir: "greet", source: "file:///r#greet", steps: [], tools: ["greet"], service: false },
      { name: "@thetis/memo", version: "0.2.0", type: "memory", description: "Remember", keywords: [], registry: "local", url: "file:///r", dir: "memo", source: "file:///r#memo", steps: [{ id: "load", phase: "prompt" }], tools: [], service: false },
    ],
  };
  mkdirSync(join(sysenv, "shared", "marketplace"), { recursive: true });
  writeFileSync(join(sysenv, "shared", "marketplace", "index.json"), JSON.stringify(index));
  const found = (await (await api(alice, "/alice/api/marketplace?q=hello")).json()) as { total: number; results: { name: string }[] };
  assert.equal(found.total, 2);
  assert.deepEqual(found.results.map((r) => r.name), ["@thetis/greet"]);
  const all = (await (await api(root, "/root/api/marketplace")).json()) as { results: { name: string }[]; updatedAt: string };
  assert.equal(all.results.length, 2);
  assert.equal(all.updatedAt, index.updatedAt);
  const models = await api(root, "/root/api/admin/models");
  assert.equal(models.status, 200);
  assert.equal(((await models.json()) as { model: string }).model, "echo");
  const config = (await (await api(root, "/root/api/admin/config")).json()) as { model: string };
  assert.equal(config.model, "echo");
});

test("inside the fences: the login target in the system userspace and alice's gateway in hers serve through the door", async () => {
  const systemUs = kernel.userspaces.pathFor("_system");
  const aliceUs = kernel.userspaces.pathFor("alice");
  const system = kernel.users.authorize("_system");
  await kernel.packages.install(systemUs, system, "@thetis/gateway-login");
  await kernel.packages.install(aliceUs, system, "@thetis/gateway-web");
  await kernel.services.boot();
  const realDoor = createDoor({
    loginSocket: join(systemUs.run, "login.sock"),
    socketFor: (u) => (kernel.users.get(u)?.role !== "system" && kernel.users.get(u) && kernel.userspaces.exists(u) ? join(kernel.userspaces.pathFor(u).run, "web.sock") : undefined),
  });
  await listen(realDoor, servicePort);
  const origin = `http://127.0.0.1:${servicePort}`;
  try {
    assert.equal((await fetch(`${origin}/login`)).status, 200, "the login page comes from inside the system fence");
    const cookie = await cookieFor("alice", "wonderland", origin);
    assert.match(cookie, /^thetis_web=[a-f0-9]{64}$/);
    const me = await api(cookie, "/alice/api/me", {}, origin);
    assert.equal(me.status, 200, await me.text());
    const page = await api(cookie, "/alice/", {}, origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<base href="\/alice\/">/, "the page knows its prefix");
    assert.equal((await api(cookie, "/bob/api/me", {}, origin)).status, 503, "bob has no gateway running");
    const { id } = (await (await api(cookie, "/alice/api/sessions", { method: "POST" }, origin)).json()) as { id: string };
    const r = await turn(cookie, "alice", id, async () => {
      assert.equal((await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "fenced" }) }, origin)).status, 202);
    }, origin);
    assert.equal(r.text, "echo: fenced (t1)");
    await kernel.packages.uninstall(aliceUs, "@thetis/gateway-web");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await api(cookie, "/alice/api/me", {}, origin)).status, 503, "uninstall stopped alice's gateway");
  } finally {
    await new Promise<void>((done) => realDoor.close(() => done()));
  }
});

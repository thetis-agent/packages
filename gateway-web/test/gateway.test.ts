import { contentText } from "@thetis/runtime/lib/content";
// End-to-end through the door: one gateway per person on a unix socket, the login target, and a real
// kernel with the echo provider fixture. Exercises sign-in, sessions and the event stream, the panel,
// isolation between people, and finally the same path with the gateways running inside real fences.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { exec as cpExec } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { TurnEvent, Userspace } from "@thetis/runtime/contracts";
import { createKernel, T, type Kernel } from "@thetis/runtime";
import { createControlHandler, createRpcHandler, defaultConfig } from "@thetis/runtime/kernel";
import { memoryStore } from "@thetis/runtime/lib/store";
import { createDoor } from "@thetis/runtime/door";
import { createLogin } from "@thetis/gateway-login";
import { clientFromRpc } from "../src/client.js";
import { createGateway } from "../src/server.js";
import { GatewayStore } from "../src/store.js";
import type { TurnMessage } from "../src/turns.js";
import type { ChildRecord } from "../src/server.js";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = resolve(PROJECT, "test/host/fixtures");
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
    invokeTool: async () => "",
    storage: (): never => {
      throw new Error("no storage in this test");
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

/** Reads every `turn` message of the person's stream until `until` says so. The caller starts the turns after the snapshot arrived. */
async function collect(cookie: string, user: string, trigger: () => Promise<unknown>, until: (m: TurnMessage, all: TurnMessage[]) => boolean): Promise<TurnMessage[]> {
  const control = new AbortController();
  const gen = frames(cookie, control.signal, `/${user}/api/events`);
  assert.equal((await gen.next()).value?.event, "snapshot");
  await trigger();
  const all: TurnMessage[] = [];
  for await (const f of gen) {
    if (f.event !== "turn") continue;
    const m = f.data as unknown as TurnMessage;
    all.push(m);
    if (until(m, all)) break;
  }
  control.abort();
  return all;
}

/** Polls the person's record of a session until `ready` holds, or fails after `ms`. */
async function recordWhen<T>(cookie: string, user: string, session: string, ready: (rec: T) => boolean, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const rec = (await (await api(cookie, `/${user}/api/sessions/${session}`)).json()) as T;
    if (ready(rec)) return rec;
    assert.ok(Date.now() < deadline, `the record of ${session} did not become ready within ${ms} ms: ${JSON.stringify(rec).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

const SUBAGENT_LINE = /^\[subagent (s_[a-f0-9]+)(?: ([^\]]*))?\]/;
type Shown = { status: string; turn: { events: unknown[] } | null; children: ChildRecord[] };
const said = (messages: TurnMessage[], session: string) => messages.filter((m) => m.session === session && m.event.type === "text").map((m) => (m.event as { delta: string }).delta).join("");

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
  for (const name of ["harness-core", "tool-exec", "prompt-cache", "gateway-web", "gateway-login", "gateway-cli", "ui-admin", "ui-marketplace", "host-grants"]) symlinkSync(resolve(PROJECT, "packages", name), join(sys, name));
  symlinkSync(join(FIXTURES, "provider-echo"), join(sys, "provider-echo"));
  servicePort = await freePort();
  const config = defaultConfig(join(home, "data"), PROJECT);
  config.systemPackagesDir = sys;
  config.model = "echo";
  config.fence.sandbox = (process.env.THETIS_TEST_SANDBOX as "auto" | "none") ?? "auto";
  config.fence.network = "none";
  config.fence.readOnly.push(sys, FIXTURES);
  config.systemPackages = { "*": ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/ui-admin", "@thetis/ui-marketplace"], _system: ["@thetis/provider-echo"] };
  config.packages = { "@thetis/provider-echo": { tag: "t1" } };
  config.door = { host: "127.0.0.1", port: servicePort };
  config.requestTimeoutMs = 60_000;
  const log = (line: string) => process.env.THETIS_TEST_VERBOSE && console.error(line);
  // The records live in memory: this file is about the gateway, and no storage driver is among its system packages.
  kernel = await createKernel(config, (c) => c.bind(T.log, () => log).bind(T.store, () => memoryStore()));
  kernel.users.create("alice");
  kernel.users.create("bob");
  kernel.users.create("root", "admin");
  await kernel.auth.setPassword("alice", "wonderland");
  await kernel.auth.setPassword("bob", "builder");
  await kernel.auth.setPassword("root", "rootpass1");
  for (const id of PEOPLE) kernel.sessions.userspaceFor(kernel.users.authorize(id));

  // In-process: one gateway per person over that person's own RPC handler, the login target over the
  // system one, and the door in front. The same handlers the fences would get, without the fences.
  const rpcFor = (us: Userspace) => createRpcHandler(us, kernel, createControlHandler(kernel), async (u) => ({ model: kernel.config.model, models: await kernel.providers.listModels(u) }));
  const assets = join(home, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "<title>app</title><base href=\"{{base}}/\"><meta name=\"csp-nonce\" content=\"{{nonce}}\">");
  const loginAssets = join(home, "login-assets");
  mkdirSync(loginAssets);
  writeFileSync(join(loginAssets, "login.html"), "<title>login</title>");
  sysenv = join(home, "sysenv");
  mkdirSync(sysenv);
  const socketsDir = join(home, "s");
  mkdirSync(socketsDir);
  for (const id of PEOPLE) {
    const us = kernel.userspaces.pathFor(id);
    const client = clientFromRpc(rpcFor(us));
    const env = { ...envAt(sysenv), cwd: us.home, root: us.root, store: us.store, kernel: client };
    const server = createGateway(client, new GatewayStore(join(home, "store", id)), { assets, log, env, user: id, base: `/${id}` });
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
  assert.deepEqual(await me.json(), { user: "alice", role: "user", avatar: null }, "nobody has uploaded a picture yet");
  const home = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
  assert.equal(home.headers.get("location"), "/alice/", "the root sends a signed-in person home");
  assert.equal((await api(cookie, "/alice/")).status, 200);
});

test("a route matches its own path and nothing below it", async () => {
  // A predicate that looks at one segment matches everything under it as well. `GET /api/me` did, and it
  // came within a length check of swallowing `GET /api/me/avatar` whole, answering identity where a picture
  // was asked for. Every route pins its length now, so anything deeper is a 404 rather than a near miss.
  const cookie = await cookieFor("alice", "wonderland");
  for (const at of ["/alice/api/me/nonsense", "/alice/api/me/avatar/nonsense", "/alice/api/events/nonsense", "/alice/api/models/nonsense"]) {
    assert.equal((await api(cookie, at)).status, 404, `${at} should not be matched by the route above it`);
  }
  assert.equal((await api(cookie, "/alice/api/me")).status, 200, "and the route itself still answers");
});

test("an avatar is the bytes it really is, is served back with that type, and can be taken off again", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const at = "/alice/api/me/avatar";
  assert.equal((await api(cookie, at)).status, 404, "nobody has one to begin with");
  // A one-pixel PNG, offered as something else entirely: what a browser calls a file it was handed is the
  // uploader's word for it, so the gateway reads the first bytes and believes those instead.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const put = await api(cookie, at, { method: "PUT", body: png, headers: { "content-type": "text/plain" } });
  assert.equal(put.status, 200);
  const { avatar } = (await put.json()) as { avatar: string };
  assert.match(avatar, /^\/alice\/api\/me\/avatar\?v=\d+$/, "the URL carries when the picture was written");
  const shown = await api(cookie, at);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-type"), "image/png");
  assert.equal(shown.headers.get("cache-control"), "no-store");
  assert.equal(shown.headers.get("x-content-type-options"), "nosniff", "the browser may not guess a type of its own");
  assert.deepEqual(Buffer.from(await shown.arrayBuffer()), png);
  assert.equal(((await (await api(cookie, "/alice/api/me")).json()) as { avatar: string }).avatar, avatar);
  // A picture of another type replaces the first one, file and all: one person has one picture.
  const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(12, 1)]);
  assert.equal((await api(cookie, at, { method: "PUT", body: gif })).status, 200);
  assert.equal((await api(cookie, at)).headers.get("content-type"), "image/gif");
  const store = new GatewayStore(join(home, "store", "alice"));
  assert.equal(store.getAvatar("alice")?.mime, "image/gif");
  assert.ok(!existsSync(store.avatarPath("alice", ".png")), "the picture it replaced is gone, not left beside it");
  // Something that is not a picture at all, and something far too large, are both refused in words.
  const notAnImage = await api(cookie, at, { method: "PUT", body: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") });
  assert.equal(notAnImage.status, 415);
  assert.equal(((await notAnImage.json()) as { error: string }).error, "That file is not a PNG, JPEG, WebP or GIF image.");
  const tooBig = await api(cookie, at, { method: "PUT", body: Buffer.concat([png, Buffer.alloc(512 * 1024)]) });
  assert.equal(tooBig.status, 413);
  assert.equal(((await tooBig.json()) as { error: string }).error, "That image is larger than 512 KB.");
  assert.equal((await api(cookie, at)).headers.get("content-type"), "image/gif", "a refused upload left the old picture alone");
  assert.equal((await api(cookie, at, { method: "DELETE" })).status, 200);
  assert.equal((await api(cookie, at)).status, 404);
  assert.equal(((await (await api(cookie, "/alice/api/me")).json()) as { avatar: null }).avatar, null);
  assert.equal((await api(cookie, at, { method: "DELETE" })).status, 200, "taking off one that is not there is not an error");
});

test("the page carries a style nonce, the policy names that same nonce, and a second visit gets another", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const first = await api(cookie, "/alice/");
  const policy = first.headers.get("content-security-policy") ?? "";
  const nonce = /style-src 'self' 'nonce-([^']+)'/.exec(policy)?.[1];
  assert.ok(nonce, `the policy must carry a style nonce: ${policy}`);
  // The page and the policy have to agree, or the stylesheets an emulator writes at runtime are refused.
  assert.match(await first.text(), new RegExp(`<meta name="csp-nonce" content="${nonce.replace(/[+/=]/g, (c) => `\\${c}`)}">`));
  assert.match(policy, /script-src 'self'/, "nothing else in the policy moved");
  const again = /nonce-([^']+)/.exec((await api(cookie, "/alice/")).headers.get("content-security-policy") ?? "")?.[1];
  assert.notEqual(again, nonce, "a nonce that repeated would be worth no more than 'unsafe-inline'");
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

test("the record a page refreshed mid-turn is given carries the turn in progress, and its input is already the last message of the conversation", async () => {
  // This is what the transcript is rebuilt from after a hard refresh. Both halves matter: without `turn`
  // the in-flight turn is not on the page at all, and the fact that `conversation` already ends with the
  // very message `turn.input` holds is why the transcript must not draw both (it drew the person's own
  // message twice on every refresh made while a turn ran). If the kernel ever stops writing the input at
  // turn start, this says so, and the page's comparison of the two copies has to be looked at again.
  const cookie = await cookieFor("alice", "wonderland");
  const { id } = (await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  const asked = "slow: a b c d e f g h i j k l m n o p";
  assert.equal((await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: asked }) })).status, 202);
  await new Promise((r) => setTimeout(r, 120));
  type Mid = { status: string; conversation: { role: string; content: string }[]; turn: { input: string; events: unknown[] } | null };
  const rec = (await (await api(cookie, `/alice/api/sessions/${id}`)).json()) as Mid;
  assert.equal(rec.status, "running");
  assert.ok(rec.turn, "the gateway hands the page the turn it is carrying");
  assert.equal(rec.turn!.input, asked);
  const last = rec.conversation.at(-1);
  assert.equal(last?.role, "user");
  assert.equal(contentText(last?.content).replace(/\n\n\[Turn context: [^\n\]]*\]$/, ""), asked);
  await api(cookie, `/alice/api/sessions/${id}/cancel`, { method: "POST" });
});

test("a subagent's turn is on the parent's stream, tagged with its parent, and the record lists it under children with its label and task", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const { id } = (await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  const messages = await collect(
    cookie,
    "alice",
    async () => assert.equal((await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "spawn: hello" }) })).status, 202),
    (m) => m.session === id && m.event.type === "turn.end",
  );
  const mine = messages.filter((m) => m.session === id);
  assert.ok(mine.every((m) => m.parent === undefined), "a conversation's own messages carry no parent");
  const child = messages.filter((m) => m.parent === id);
  assert.ok(child.length > 0, "the subagent's events reach the person's stream");
  const childId = child[0].session;
  assert.match(childId, /^s_[a-f0-9]+$/);
  assert.ok(child.every((m) => m.session === childId));
  assert.equal(child.find((m) => m.event.type === "turn.start")?.input, "hello", "the child's turn.start carries its task");
  assert.deepEqual(child.map((m) => m.event.type).filter((t) => ["turn.start", "message", "turn.end"].includes(t)), ["turn.start", "message", "turn.end"]);
  assert.equal(said(messages, childId), "echo: hello (t1)");
  assert.equal(new Set(child.map((m) => m.seq)).size, child.length, "the child's messages are numbered like a turn of the hub's own");
  const result = mine.map((m) => m.event).find((e) => e.type === "tool.result") as { name: string; result: string };
  assert.equal(result.name, "spawn_subagent");
  const line = SUBAGENT_LINE.exec(result.result);
  assert.equal(line?.[1], childId, "the result line names the child");
  assert.equal(line?.[2], "helper", "and its label");
  assert.equal(said(messages, id), `tool said: [subagent ${childId} helper]\necho: hello (t1)`);
  const childEnd = messages.findIndex((m) => m.session === childId && m.event.type === "turn.end");
  const parentResult = messages.findIndex((m) => m.session === id && m.event.type === "tool.result");
  assert.ok(childEnd >= 0 && childEnd < parentResult, "the child ends before the parent's tool result arrives");

  const shown = (await (await api(cookie, `/alice/api/sessions/${id}`)).json()) as Shown;
  assert.equal(shown.children.length, 1);
  const rec = shown.children[0];
  assert.equal(rec.id, childId);
  assert.equal(rec.parent, id);
  assert.equal(rec.label, "helper");
  assert.equal(rec.task, "hello");
  assert.equal(rec.status, "idle");
  assert.equal(rec.turn, null);
  assert.equal(rec.turns, 1);
  assert.deepEqual(rec.conversation.map((m) => [m.role, contentText(m.content).replace(/\n\n\[Turn context: [^\n\]]*\]$/, "")]), [["user", "hello"], ["assistant", "echo: hello (t1)"]]);
  assert.match(contentText(rec.conversation[0].content), /\n\n\[Turn context: \w+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} [\w/]+\]$/, "the harness dated the input and the record keeps the line");
  assert.deepEqual(rec.usage, {});
  const list = (await (await api(cookie, "/alice/api/sessions")).json()) as { id: string }[];
  assert.ok(list.some((s) => s.id === id) && !list.some((s) => s.id === childId), "the list still holds root conversations only");
  const own = (await (await api(cookie, `/alice/api/sessions/${childId}`)).json()) as Shown;
  assert.equal(own.status, "idle");
  assert.deepEqual(own.children, [], "the child is a session of the person's own, with no children of its own");
});

test("a page that connects while a subagent runs sees it in the snapshot with its parent", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const { id } = (await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  assert.equal((await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "spawn: slow: a b c d e f g h" }) })).status, 202);
  const mid = await recordWhen<Shown>(cookie, "alice", id, (r) => r.children.length === 1 && r.children[0].turn !== null && r.children[0].turn.events.length > 0);
  assert.equal(mid.children[0].status, "running");
  assert.equal(mid.children[0].label, null, "the label comes with the parent's result, so a running child has none yet; the page takes it from the spawn call's args");
  assert.equal(mid.children[0].task, "slow: a b c d e f g h", "the task comes from the running turn's input while the child's record is empty");
  const control = new AbortController();
  const gen = frames(cookie, control.signal, "/alice/api/events");
  const first = (await gen.next()).value as { event: string; data: { running: { session: string; parent?: string; input: string; events: unknown[] }[] } };
  assert.equal(first.event, "snapshot");
  const parent = first.data.running.find((r) => r.session === id);
  assert.ok(parent && parent.parent === undefined, "the parent's turn is in the snapshot without a parent");
  const child = first.data.running.find((r) => r.parent === id);
  assert.ok(child, "the child's turn is in the snapshot with its parent");
  assert.equal(child.input, "slow: a b c d e f g h");
  assert.ok(child.events.length > 0, "with the events so far");
  for await (const f of gen) if (f.event === "turn" && (f.data as TurnMessage).session === id && (f.data as TurnMessage).event.type === "turn.end") break;
  control.abort();
  const done = (await (await api(cookie, `/alice/api/sessions/${id}`)).json()) as Shown;
  assert.equal(done.children[0].status, "idle");
  assert.equal(done.children[0].turn, null);
});

test("stopping the parent stops its subagent", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const { id } = (await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  let childId = "";
  const messages = await collect(
    cookie,
    "alice",
    async () => {
      assert.equal((await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "spawn: slow: a b c d e f g h" }) })).status, 202);
      const mid = await recordWhen<Shown>(cookie, "alice", id, (r) => r.children.length === 1 && r.children[0].status === "running");
      childId = mid.children[0].id;
      assert.equal((await api(cookie, `/alice/api/sessions/${id}/cancel`, { method: "POST" })).status, 200);
    },
    (_m, all) => all.some((m) => m.session === id && m.event.type === "turn.end") && all.some((m) => m.session === childId && m.event.type === "turn.end"),
  );
  const parentError = messages.find((m) => m.session === id && m.event.type === "error")?.event as { code?: string } | undefined;
  assert.equal(parentError?.code, "cancelled");
  const childError = messages.find((m) => m.session === childId && m.event.type === "error")?.event as { code?: string } | undefined;
  assert.equal(childError?.code, "cancelled", "the stop cascaded to the child");
  assert.ok(said(messages, childId).split(" ").filter(Boolean).length < 8, "the child was stopped mid-stream");
  const child = await recordWhen<Shown>(cookie, "alice", childId, (r) => r.status === "idle", 1_000);
  assert.equal(child.turn, null);
  const parent = (await (await api(cookie, `/alice/api/sessions/${id}`)).json()) as Shown;
  assert.equal(parent.status, "idle");
  assert.equal(parent.children[0].id, childId);
});

test("the stream says `sessions` when a conversation is created or archived through this gateway", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const control = new AbortController();
  const gen = frames(cookie, control.signal, "/alice/api/events");
  assert.equal((await gen.next()).value?.event, "snapshot");
  const { id } = (await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  assert.equal((await gen.next()).value?.event, "sessions");
  await api(cookie, `/alice/api/sessions/${id}/archive`, { method: "POST", body: JSON.stringify({ archived: true }) });
  assert.equal((await gen.next()).value?.event, "sessions");
  control.abort();
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

test("a conversation nothing was said in can be discarded; one with a message, one working, and one already gone are refused", async () => {
  // What the page's tidying rests on. The page's list is a moment old whenever it asks, so every reason to
  // refuse is checked here against the record itself, and each refusal is an answer the page ignores rather
  // than a fault: it never asked for this on the person's behalf.
  const cookie = await cookieFor("alice", "wonderland");
  const ids = async () => ((await (await api(cookie, "/alice/api/sessions")).json()) as { id: string }[]).map((s) => s.id);
  const create = async () => ((await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string }).id;
  const discard = (id: string) => api(cookie, `/alice/api/sessions/${id}`, { method: "DELETE" });

  const empty = await create();
  // Archived, so the gateway holds a file of its own for it: that file has to go with the record.
  await api(cookie, `/alice/api/sessions/${empty}/archive`, { method: "POST", body: JSON.stringify({ archived: true }) });
  const kept = join(home, "store", "alice", "sessions", "alice", `${empty}.json`);
  assert.ok(existsSync(kept));
  assert.ok((await ids()).includes(empty));
  assert.equal((await discard(empty)).status, 200);
  assert.ok(!(await ids()).includes(empty), "the row is gone from the list");
  assert.ok(!existsSync(kept), "and so is what the gateway kept about it, the archive mark included");
  assert.equal((await discard(empty)).status, 404, "a second page discarding the same one finds it already gone");

  const spoken = await create();
  assert.equal((await turn(cookie, "alice", spoken, async () => api(cookie, `/alice/api/sessions/${spoken}/send`, { method: "POST", body: JSON.stringify({ text: "keep me" }) }))).text, "echo: keep me (t1)");
  assert.equal((await discard(spoken)).status, 409, "a conversation with words in it is archived, never removed");
  assert.ok((await ids()).includes(spoken));

  const working = await create();
  assert.equal((await api(cookie, `/alice/api/sessions/${working}/send`, { method: "POST", body: JSON.stringify({ text: "slow: a b c d e f g h i j k l m n o p" }) })).status, 202);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await discard(working)).status, 409, "a turn in flight is a conversation in use, whatever the record says yet");
  await api(cookie, `/alice/api/sessions/${working}/cancel`, { method: "POST" });
  assert.ok((await ids()).includes(working));

  const parent = await create();
  const messages = await collect(cookie, "alice", async () => api(cookie, `/alice/api/sessions/${parent}/send`, { method: "POST", body: JSON.stringify({ text: "spawn: hello" }) }), (m) => m.session === parent && m.event.type === "turn.end");
  const child = messages.map((m) => m.session).find((s) => s !== parent);
  assert.ok(child, "the spawn made a subagent");
  assert.equal((await discard(child!)).status, 409, "a subagent is work inside a conversation, not a row anyone is tidying");
});

test("the stream says `sessions` when an empty conversation is discarded, so another page's list catches up", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const control = new AbortController();
  const gen = frames(cookie, control.signal, "/alice/api/events");
  assert.equal((await gen.next()).value?.event, "snapshot");
  const { id } = (await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  assert.equal((await gen.next()).value?.event, "sessions");
  assert.equal((await api(cookie, `/alice/api/sessions/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await gen.next()).value?.event, "sessions");
  control.abort();
});

test("model and name: the models list, a chosen model rides with the turn and its usage, and a name replaces the derived title", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const choices = (await (await api(cookie, "/alice/api/models")).json()) as { model: string; models: { id: string; provider?: string }[] };
  assert.equal(choices.model, "echo");
  assert.ok(choices.models.some((m) => m.id === "echo" && m.provider === "@thetis/provider-echo"));
  const { id } = (await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  const byDefault = await turn(cookie, "alice", id, async () => {
    assert.equal((await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "model?" }) })).status, 202);
  });
  assert.equal(byDefault.text, "echo");
  assert.equal((await api(cookie, `/alice/api/sessions/${id}/model`, { method: "POST", body: JSON.stringify({ model: "nothing-serves-this" }) })).status, 200);
  const refused = await turn(cookie, "alice", id, async () => {
    assert.equal((await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "model?" }) })).status, 202);
  });
  assert.ok(refused.events.some((e) => e.type === "error" && /nothing-serves-this/.test(e.message)), "the chosen model reaches the kernel");
  assert.equal((await api(cookie, `/alice/api/sessions/${id}/model`, { method: "POST", body: JSON.stringify({ model: "echo" }) })).status, 200);
  const chosen = await turn(cookie, "alice", id, async () => {
    assert.equal((await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ text: "model?" }) })).status, 202);
  });
  assert.equal(chosen.text, "echo");
  let row = ((await (await api(cookie, "/alice/api/sessions")).json()) as { id: string; model?: string; title: string; named: boolean }[]).find((s) => s.id === id)!;
  assert.equal(row.model, "echo");
  assert.equal(row.title, "model?");
  assert.equal(row.named, false);
  assert.equal((await api(cookie, `/alice/api/sessions/${id}/title`, { method: "POST", body: JSON.stringify({ title: "  Which   model  " }) })).status, 200);
  row = ((await (await api(cookie, "/alice/api/sessions")).json()) as { id: string; model?: string; title: string; named: boolean }[]).find((s) => s.id === id)!;
  assert.equal(row.title, "Which model");
  assert.equal(row.named, true);
  const shown = (await (await api(cookie, `/alice/api/sessions/${id}`)).json()) as { model: string | null; title: string | null };
  assert.equal(shown.model, "echo");
  assert.equal(shown.title, "Which model");
  assert.equal((await api(cookie, `/alice/api/sessions/${id}/title`, { method: "POST", body: JSON.stringify({ title: "" }) })).status, 200);
  row = ((await (await api(cookie, "/alice/api/sessions")).json()) as { id: string; title: string; named: boolean }[]).find((s) => s.id === id)!;
  assert.equal(row.named, false);
});

test("a chosen model sticks: a new conversation starts with the person's last choice, and choosing the default forgets it", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const create = async () => (await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json()) as { id: string; model: string | null };
  const first = await create();
  assert.equal((await api(cookie, `/alice/api/sessions/${first.id}/model`, { method: "POST", body: JSON.stringify({ model: "echo" }) })).status, 200);
  const second = await create();
  assert.equal(second.model, "echo", "the new conversation is created with the remembered model");
  const shown = (await (await api(cookie, `/alice/api/sessions/${second.id}`)).json()) as { model: string | null };
  assert.equal(shown.model, "echo");
  const row = ((await (await api(cookie, "/alice/api/sessions")).json()) as { id: string; model?: string }[]).find((s) => s.id === second.id)!;
  assert.equal(row.model, "echo", "the list shows it too, so the pill reads it");
  assert.equal((await api(cookie, `/alice/api/sessions/${second.id}/model`, { method: "POST", body: JSON.stringify({ model: "" }) })).status, 200);
  const third = await create();
  assert.equal(third.model, null, "back to the default once the person chose it");
  const bob = await cookieFor("bob", "builder");
  assert.equal((await api(bob, "/bob/api/sessions", { method: "POST" })).status, 201);
  assert.equal(((await (await api(bob, "/bob/api/sessions", { method: "POST" })).json()) as { model: string | null }).model, null, "one person's choice is not another's");
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

/** A command of `@thetis/ui-admin`, as the page sends it: `POST api/ext/<package>/<verb>` with `{ args }`. */
const ADMIN = "/api/ext/@thetis/ui-admin";
async function admin(cookie: string, user: string, verb: string, args: Record<string, unknown> = {}): Promise<{ status: number; data: unknown; error?: string }> {
  const res = await api(cookie, `/${user}${ADMIN}/${verb}`, { method: "POST", body: JSON.stringify({ args }) });
  const body = (await res.json()) as { data?: unknown; error?: string };
  return { status: res.status, data: body.data, error: body.error };
}

/** A command of `@thetis/ui-marketplace`, the same way. */
const MARKET = "/api/ext/@thetis/ui-marketplace";
async function market(cookie: string, user: string, verb: string, args: Record<string, unknown> = {}): Promise<{ status: number; data: unknown; error?: string }> {
  const res = await api(cookie, `/${user}${MARKET}/${verb}`, { method: "POST", body: JSON.stringify({ args }) });
  const body = (await res.json()) as { data?: unknown; error?: string };
  return { status: res.status, data: body.data, error: body.error };
}

test("panel: the built-in sections are the same for everyone; a package's admin sections and verbs follow the role", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const root = await cookieFor("root", "rootpass1");
  assert.deepEqual((await (await api(alice, "/alice/api/panel")).json()).sections, ["packages"]);
  assert.deepEqual((await (await api(root, "/root/api/panel")).json()).sections, ["packages"], "the admin sections come from @thetis/ui-admin, not from api/panel");
  const uiOf = async (cookie: string, user: string) => ((await (await api(cookie, `/${user}/api/ui`)).json()) as { extensions: { package: string; panel: { id: string; order: number }[]; commands: string[] }[] }).extensions.find((e) => e.package === "@thetis/ui-admin");
  const forRoot = await uiOf(root, "root");
  assert.deepEqual(forRoot?.panel.map((e) => [e.id, e.order]), [["people", 20], ["models", 30], ["configuration", 32], ["mounts", 35], ["ssh", 36], ["activity", 40], ["workspaces", 45], ["overview", 50]]);
  assert.deepEqual(forRoot?.commands, ["users", "user-create", "user-role", "user-status", "user-password", "user-remove", "models", "config", "config-list", "package-info", "package-log", "package-commit", "package-diff", "package-push", "package-readme", "package-where", "package-activity", "package-update", "package-fork", "package-promote", "package-remove", "package-install-for", "fleet", "config-show", "config-set", "config-unset", "config-reload", "journal", "mounts-list", "mounts-set", "mounts-browse", "ssh-list", "ssh-set", "ssh-keygen", "ssh-import", "ssh-scan", "ssh-test", "fence-reload", "status", "restart-request"]);
  const forAlice = await uiOf(alice, "alice");
  assert.deepEqual(forAlice?.panel, [], "installed for everyone, but a user sees no admin section");
  assert.deepEqual(forAlice?.commands, [], "and no admin verb");
  const refused = await admin(alice, "alice", "users");
  assert.equal(refused.status, 403, "a user is refused a role-admin verb by the gateway");
  assert.match(String(refused.error), /admin/);
  assert.equal((await admin(root, "root", "users")).status, 200);
  for (const path of ["users", "models", "journal", "config", "packages"]) assert.equal((await api(root, `/root/api/admin/${path}`)).status, 404, `api/admin/${path} is gone`);
  const marketplaceUi = ((await (await api(root, "/root/api/ui")).json()) as { extensions: { package: string; places: { id: string; order: number }[]; commands: string[] }[] }).extensions.find((e) => e.package === "@thetis/ui-marketplace");
  assert.deepEqual(marketplaceUi?.places.map((e) => [e.id, e.order]), [["marketplace", 20]]);
  assert.deepEqual(marketplaceUi?.commands, ["search", "show", "install", "remove", "delete", "update", "unfork", "publish-targets", "publish", "unpublish", "config-show", "config-list", "config-set", "config-unset", "fence-reload", "install-everyone", "install-for", "remove-for", "promote", "people"]);
  const marketplaceForAlice = ((await (await api(alice, "/alice/api/ui")).json()) as { extensions: { package: string; places: { id: string }[]; commands: string[] }[] }).extensions.find((e) => e.package === "@thetis/ui-marketplace");
  assert.deepEqual(marketplaceForAlice?.places.map((e) => e.id), ["marketplace"], "the place is everyone's");
  assert.deepEqual(marketplaceForAlice?.commands, ["search", "show", "install", "remove", "delete", "update", "unfork", "publish-targets", "publish", "unpublish", "config-show", "config-list", "config-set", "config-unset", "fence-reload"], "the admin verbs are not; a person's own configuration is, and so is reloading their own workspace: publishing is a person's own act too, and answers `available: false` where nothing can publish");
});

test("people: an admin adds a person, changes the role and status, and removes them through @thetis/ui-admin; the journal says so", async () => {
  const root = await cookieFor("root", "rootpass1");
  const people = async () => (await admin(root, "root", "users")).data as { id: string; role: string; status: string }[];
  const created = await admin(root, "root", "user-create", { id: "carol", role: "user", password: "carolpass1" });
  assert.equal(created.status, 200, created.error);
  assert.equal((created.data as { id: string }).id, "carol");
  assert.ok((await people()).some((u) => u.id === "carol"));
  assert.equal((await login("carol", "carolpass1")).status, 303, "the password was set");
  assert.equal((await admin(root, "root", "user-role", { id: "carol", role: "admin" })).status, 200);
  assert.equal((await people()).find((u) => u.id === "carol")?.role, "admin");
  assert.equal((await admin(root, "root", "user-status", { id: "carol", status: "suspended" })).status, 200);
  assert.equal((await people()).find((u) => u.id === "carol")?.status, "suspended");
  assert.equal((await admin(root, "root", "user-password", { id: "carol", password: "carolpass2" })).status, 200);
  const own = await admin(root, "root", "user-role", { id: "root", role: "user" });
  assert.equal(own.status, 400, "not your own account");
  assert.match(String(own.error), /your own account/);
  assert.equal((await admin(root, "root", "user-create", { id: "Bad Id" })).status, 400);
  assert.equal((await admin(root, "root", "user-password", { id: "carol", password: "short" })).status, 400);
  assert.equal((await admin(root, "root", "user-remove", { id: "carol" })).status, 200);
  assert.ok(!(await people()).some((u) => u.id === "carol"));
  const rows = (await admin(root, "root", "journal", { limit: 50 })).data as { kind: string; actor?: string; target?: string }[];
  assert.ok(rows.some((r) => r.kind === "user.create" && r.target === "carol" && r.actor === "root"), "the actor is the admin, not the operator");
  assert.ok(rows.some((r) => r.kind === "user.role" && r.target === "carol"));
  assert.ok(rows.some((r) => r.kind === "user.password" && r.target === "carol"));
  assert.ok(rows.some((r) => r.kind === "user.remove" && r.target === "carol"));
  assert.deepEqual(((await admin(root, "root", "journal", { limit: 50, kind: "user.remove" })).data as { kind: string }[]).map((r) => r.kind), ["user.remove"], "narrowed to one kind");
});

test("mounts: an admin binds a directory into bob's fence, sees it listed, and unbinds it", async () => {
  const root = await cookieFor("root", "rootpass1");
  const listed = async () => (await admin(root, "root", "mounts-list")).data as Record<string, { path: string; mode: string }[]>;
  assert.deepEqual((await listed()).bob ?? [], []);
  const set = await admin(root, "root", "mounts-set", { user: "bob", mounts: [{ path: "/srv/repos/x", mode: "ro" }] });
  assert.equal(set.status, 200, set.error);
  // A bind says what the host holds at the path, so an admin learns at once that this one cannot work.
  const skipped = [{ path: "/srv/repos/x", mode: "ro", present: false, kind: "none" }];
  assert.deepEqual(set.data, skipped);
  assert.deepEqual((await listed()).bob, skipped);
  assert.deepEqual((await admin(root, "root", "mounts-list", { user: "bob" })).data, { bob: skipped });
  // browse: the operator's view of the host, so a path can be picked instead of typed.
  const home = (await admin(root, "root", "mounts-browse", { path: kernel.userspaces.pathFor("bob").home })).data as { kind: string; readable: boolean; entries: { name: string }[] };
  assert.equal(home.kind, "dir");
  assert.equal(home.readable, true);
  assert.equal((await admin(root, "root", "mounts-browse", { path: "/srv/repos/x" })).status, 200);
  assert.equal((await admin(root, "root", "mounts-browse", { path: "relative" })).status, 400);
  assert.equal((await admin(root, "root", "mounts-set", { user: "bob", mounts: [{ path: "repos/x", mode: "ro" }] })).status, 400, "a relative path");
  assert.equal((await admin(root, "root", "mounts-set", { user: "bob", mounts: [{ path: "/srv/repos/x", mode: "rx" }] })).status, 400, "a mode that is not rw or ro");
  assert.equal((await admin(root, "root", "mounts-set", { user: "bob", mounts: [] })).status, 200);
  assert.deepEqual((await listed()).bob ?? [], []);
  assert.equal((await admin(await cookieFor("bob", "builder"), "bob", "mounts-browse", { path: "/" })).status, 403, "browsing the host is an admin's");
  const rows = (await admin(root, "root", "journal", { limit: 20, kind: "mounts" })).data as { kind: string; target?: string; actor?: string }[];
  assert.ok(rows.some((r) => r.target === "bob" && r.actor === "root"));
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

  // The admin verbs of @thetis/ui-marketplace replace the gateway's old /api/admin/packages routes.
  assert.equal((await api(root, "/root/api/admin/packages?user=alice")).status, 404, "api/admin is gone");
  const forAlice = await market(root, "root", "install-for", { user: "alice", source: "@thetis/prompt-cache" });
  assert.equal(forAlice.status, 200, `an admin installs a system package for a user: ${forAlice.error}`);
  assert.equal((forAlice.data as { name: string; scope: string }).scope, "me");
  assert.ok(((await (await api(alice, "/alice/api/packages")).json()) as { name: string }[]).some((p) => p.name === "@thetis/prompt-cache"));
  const refused = await market(alice, "alice", "promote", { user: "alice", name: "@alice/hello" });
  assert.equal(refused.status, 403);
  assert.match(String(refused.error), /only an admin/);
  const promoted = await market(root, "root", "promote", { user: "alice", name: "@alice/hello" });
  assert.equal(promoted.status, 200, promoted.error);
  assert.equal((promoted.data as { name: string }).name, "@thetis/hello");
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
  assert.equal((await market(alice, "alice", "install-everyone", { source: "@thetis/gateway-cli" })).status, 403);
  const everyone = await market(root, "root", "install-everyone", { source: "@thetis/gateway-cli" });
  assert.equal(everyone.status, 200, everyone.error);
  const got = everyone.data as { name: string; userspaces: string[] };
  assert.equal(got.name, "@thetis/gateway-cli");
  assert.ok(got.userspaces.includes("bob") && !got.userspaces.includes("_system"));
  assert.ok(((await (await api(bob, "/bob/api/packages")).json()) as { name: string; scope: string }[]).some((p) => p.name === "@thetis/gateway-cli" && p.scope === "everyone"));
  assert.ok(((await (await api(root, "/root/api/packages")).json()) as { name: string; scope: string }[]).some((p) => p.name === "@thetis/gateway-cli" && p.scope === "everyone"), "the admin's own row now says everyone");
  assert.equal((await admin(root, "root", "user-create", { id: "dave" })).status, 200);
  assert.ok(kernel.packages.installed(kernel.userspaces.pathFor("dave")).some((p) => p.name === "@thetis/gateway-cli"), "a new person is seeded with it");
  await admin(root, "root", "user-remove", { id: "dave" });
});

test("packages: a fork's row says what it replaced; delete with files puts the origin back; a shipped package is refused", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const root = await cookieFor("root", "rootpass1");
  const us = kernel.userspaces.pathFor("alice");
  const write = (dir: string, manifest: object) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "index.js"), "export async function t() { return 'base'; }");
  };
  const thetis = { type: "tool", tools: [{ name: "base_t", description: "t", export: "t" }] };
  write(join(us.home, "packages", "base"), { name: "@alice/base", version: "0.1.0", type: "module", main: "index.js", thetis });
  assert.equal((await api(alice, "/alice/api/packages", { method: "POST", body: JSON.stringify({ source: "packages/base" }) })).status, 201);
  write(join(us.home, "packages", "base2"), { name: "@alice/base2", version: "0.1.0-fork.1", type: "module", main: "index.js", thetis: { ...thetis, forkedFrom: { name: "@alice/base", version: "0.1.0" } } });
  const installed = await api(alice, "/alice/api/packages", { method: "POST", body: JSON.stringify({ source: "packages/base2" }) });
  const row = JSON.parse(await installed.text()) as { name: string; forkedFrom?: unknown; replaced?: string };
  assert.equal(installed.status, 201);
  assert.deepEqual(row.forkedFrom, { name: "@alice/base", version: "0.1.0" });
  assert.equal(row.replaced, "@alice/base");
  const rows = (await (await api(alice, "/alice/api/packages")).json()) as { name: string; forkedFrom?: { name: string }; replaced?: string }[];
  assert.ok(!rows.some((p) => p.name === "@alice/base"), "the origin is displaced");
  assert.equal(rows.find((p) => p.name === "@alice/base2")?.forkedFrom?.name, "@alice/base");
  assert.equal((await api(alice, "/alice/api/packages/%40thetis%2Fharness-core?files=1", { method: "DELETE" })).status, 403, "a shipped package cannot be deleted");
  assert.ok(existsSync(join(us.store, "node_modules", "@thetis", "harness-core", "package.json")));
  const deleted = await api(alice, "/alice/api/packages/%40alice%2Fbase2?files=1", { method: "DELETE" });
  const result = JSON.parse(await deleted.text()) as { name: string; path: string; restored?: string };
  assert.equal(deleted.status, 200);
  assert.equal(result.restored, "@alice/base");
  assert.ok(!existsSync(join(us.home, "packages", "base2")), "the files are gone");
  const after = (await (await api(alice, "/alice/api/packages")).json()) as { name: string }[];
  assert.ok(after.some((p) => p.name === "@alice/base") && !after.some((p) => p.name === "@alice/base2"));
  assert.deepEqual(JSON.parse(await (await api(alice, "/alice/api/packages/%40alice%2Fbase?files=1", { method: "DELETE" })).text()), { name: "@alice/base", path: join(us.home, "packages", "base") });
  assert.ok(!existsSync(join(us.home, "packages", "base")));
});

test("marketplace: search and show read the index and the README copies in the shared directory through @thetis/ui-marketplace", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const bob = await cookieFor("bob", "builder");
  const root = await cookieFor("root", "rootpass1");
  // No index yet: the rows are what is installed, and the answer says so.
  const bare = await market(alice, "alice", "search", { q: "" });
  assert.equal(bare.status, 200, bare.error);
  const bareData = bare.data as { indexed: boolean; updatedAt: string | null; total: number; rows: { name: string; installed: boolean }[]; role: string; user: string };
  assert.equal(bareData.indexed, false);
  assert.equal(bareData.updatedAt, null);
  assert.ok(bareData.rows.length > 0 && bareData.rows.every((r) => r.installed));
  assert.equal(bareData.user, "alice");
  assert.equal(bareData.role, "user");
  const index = {
    version: 1, updatedAt: "2026-09-14T00:00:00.000Z", registries: [{ name: "local", url: "file:///r", commit: "abc" }],
    packages: [
      { name: "@thetis/greet", version: "1.0.0", type: "tool", description: "Say hello", keywords: ["hello"], registry: "local", url: "file:///r", dir: "greet", commit: "a".repeat(40), source: "file:///r#greet@" + "a".repeat(40), steps: [], tools: ["greet"], service: false, readme: true },
      { name: "@thetis/memo", version: "0.2.0", type: "memory", description: "Remember", keywords: [], registry: "local", url: "file:///r", dir: "memo", commit: "b".repeat(40), source: "file:///r#memo@" + "b".repeat(40), steps: [{ id: "load", phase: "prompt" }], tools: [], service: false, readme: false },
    ],
  };
  mkdirSync(join(sysenv, "shared", "marketplace", "readme", "local"), { recursive: true });
  writeFileSync(join(sysenv, "shared", "marketplace", "index.json"), JSON.stringify(index));
  writeFileSync(join(sysenv, "shared", "marketplace", "readme", "local", "greet.md"), "# greet\n\nSays hello.\n");
  const found = await market(alice, "alice", "search", { q: "hello" });
  assert.equal(found.status, 200, found.error);
  const foundData = found.data as { indexed: boolean; total: number; rows: { name: string; installed: boolean; available: boolean; registry: string }[] };
  assert.equal(foundData.total, 2);
  assert.deepEqual(foundData.rows.map((r) => [r.name, r.installed, r.available, r.registry]), [["@thetis/greet", false, true, "local"]]);
  const all = (await market(root, "root", "search", {})).data as { updatedAt: string; rows: { name: string; installed: boolean }[]; role: string };
  assert.equal(all.updatedAt, index.updatedAt);
  assert.equal(all.role, "admin");
  assert.ok(all.rows.some((r) => r.name === "@thetis/memo" && !r.installed) && all.rows.some((r) => r.name === "@thetis/harness-core" && r.installed));
  assert.ok(all.rows.findIndex((r) => r.installed) < all.rows.findIndex((r) => !r.installed), "installed rows come first");
  const typed = (await market(bob, "bob", "search", { type: "memory" })).data as { rows: { name: string }[] };
  assert.deepEqual(typed.rows.map((r) => r.name), ["@thetis/memo"]);
  // A page: the row, the README copy, and who is looking. No README is null, not an error.
  const page = await market(bob, "bob", "show", { name: "@thetis/greet" });
  assert.equal(page.status, 200, page.error);
  const pageData = page.data as { row: { name: string; installed: boolean; tools: { name: string }[]; readme: boolean; scope: null }; readme: string; user: string };
  assert.equal(pageData.readme, "# greet\n\nSays hello.\n");
  assert.deepEqual(pageData.row.tools, [{ name: "greet", description: "" }]);
  assert.equal(pageData.row.scope, null);
  assert.equal(pageData.user, "bob");
  assert.equal(((await market(bob, "bob", "show", { name: "@thetis/memo" })).data as { readme: unknown }).readme, null);
  const own = (await market(bob, "bob", "show", { name: "@thetis/harness-core" })).data as { row: { installed: boolean; scope: string; license: string | null; tools: { name: string; description: string }[] } };
  assert.equal(own.row.scope, "everyone");
  assert.equal(own.row.license, "MIT", "an installed copy's license comes from its package.json");
  const unknown = await market(bob, "bob", "show", { name: "@thetis/nope" });
  assert.equal(unknown.status, 400);
  assert.match(String(unknown.error), /not installed here and no registry offers it/);
  assert.equal((await market(bob, "bob", "update", { name: "@thetis/harness-core" })).status, 400, "a shipped package is never behind");
  assert.equal((await market(bob, "bob", "people")).status, 403, "the people picker is an admin's");
  assert.deepEqual(((await market(root, "root", "people")).data as { id: string }[]).map((p) => p.id).sort(), ["alice", "bob", "root"]);
  assert.equal((await api(alice, "/alice/api/marketplace?q=x")).status, 404, "the gateway's own marketplace route is gone");
  const models = await admin(root, "root", "models");
  assert.equal(models.status, 200, models.error);
  assert.equal((models.data as { model: string }).model, "echo");
  assert.ok(((models.data as { models: { id: string }[] }).models ?? []).some((m) => m.id === "echo"), "what the echo provider serves");
  const config = await admin(root, "root", "config");
  assert.equal((config.data as { model: string }).model, "echo");
  assert.equal(((config.data as { packages: Record<string, { tag: string }> }).packages ?? {})["@thetis/provider-echo"]?.tag, "t1", "the configuration as the kernel reports it");
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

test("authenticated media and structured HTTP input retain attachments and isolate owners", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const bob = await cookieFor("bob", "builder");
  const bytes = new Uint8Array([0, 255, 42]);
  const upload = await api(cookie, "/alice/api/media?name=photo.png", { method: "POST", headers: { "content-type": "image/png" }, body: bytes });
  assert.equal(upload.status, 201);
  const asset = await upload.json() as { id: string; mediaType: string };
  const read = await api(cookie, `/alice/api/media/${asset.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes);
  assert.equal((await api(bob, `/bob/api/media/${asset.id}`)).status, 404);
  assert.equal((await api("", `/alice/api/media/${asset.id}`)).status, 401);
  const unsafe = await api(cookie, "/alice/api/media", { method: "POST", headers: { "content-type": "text/html" }, body: "<script>bad()</script>" });
  const unsafeAsset = await unsafe.json() as { id: string };
  const download = await api(cookie, `/alice/api/media/${unsafeAsset.id}`);
  assert.equal(download.headers.get("content-disposition"), "attachment");
  const { id } = await (await api(cookie, "/alice/api/sessions", { method: "POST" })).json() as { id: string };
  const attachment = { id: "photo", type: "asset", data: { id: asset.id, mediaType: asset.mediaType } };
  const opaque = { id: "opaque", type: "@example/future.v1", data: { untouched: null } };
  const content = [{ type: "text", data: { text: "rich?" } }, attachment, opaque];
  const result = await turn(cookie, "alice", id, async () => {
    const response = await api(cookie, `/alice/api/sessions/${id}/send`, { method: "POST", body: JSON.stringify({ input: { role: "user", content } }) });
    assert.equal(response.status, 202);
  });
  assert.ok(!result.events.some((e) => e.type === "error"));
  const rec = await (await api(cookie, `/alice/api/sessions/${id}`)).json() as { conversation: import("@thetis/runtime/contracts").Message[] };
  assert.deepEqual(rec.conversation[0].content.slice(0, 3), content);
  assert.deepEqual(rec.conversation[1].content, [attachment, opaque]);
});

test("session updates reject malformed field types instead of silently changing preferences", async () => {
  const cookie = await cookieFor("alice", "wonderland");
  const created = await api(cookie, "/alice/api/sessions", { method: "POST" });
  const { id } = await created.json() as { id: string };
  for (const [route, body] of [["model", { model: 7 }], ["title", { title: false }], ["archive", { archived: "false" }]]) {
    const response = await api(cookie, `/alice/api/sessions/${id}/${route}`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 400, `${route} rejects malformed input`);
  }
});

// The extension seam of the gateway: `thetis.ui` composed from installed packages, a package's browser
// files served under its own segment, and its declared commands run as the person. First the composition
// rules on hand-built package lists against a scratch store, then the routes through the door as alice,
// with the fixtures under test/host/fixtures installed into her own space.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { exec as cpExec } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { PackageInfo, UiDecl, Userspace } from "@thetis/runtime/contracts";
import { createKernel, T, type Kernel } from "@thetis/runtime";
import { createControlHandler, createRpcHandler, defaultConfig } from "@thetis/runtime/kernel";
import { memoryStore } from "@thetis/runtime/lib/store";
import { createDoor } from "@thetis/runtime/door";
import { createLogin } from "@thetis/gateway-login";
import { clientFromRpc } from "../src/client.js";
import { createGateway } from "../src/server.js";
import { GatewayStore } from "../src/store.js";
import { composeUi, type UiExtension } from "../src/ui.js";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = resolve(PROJECT, "test/host/fixtures");
const PEOPLE = ["alice", "bob", "root"] as const;
const GOOD = "@alice/ui-good";

let home: string;
let scratch: string;
let sysenv: string;
let kernel: Kernel;
let base: string;
let door: Server;
const servers: Server[] = [];
const sockets: Record<string, string> = {};

// ---- composition on hand-built package lists ----

/** A package in the scratch store, with the files its declaration names. */
function pkg(name: string, ui?: UiDecl, files: Record<string, string> = { "ui/index.js": "export default () => {};", "ui/index.css": "" }): PackageInfo {
  const root = join(scratch, "node_modules", name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  mkdirSync(root, { recursive: true });
  return { name, version: "1.0.0", type: "tool", description: "", root, thetis: { type: "tool", ...(ui !== undefined ? { ui } : {}) } };
}

test("composeUi: a package without ui is skipped; bad declarations are refused by name and the rest composes", () => {
  const plain = pkg("@t/plain");
  const good = pkg("@t/good", { entry: "index.js", style: "index.css", dock: [{ id: "todo", label: "Todo", extra: 1 } as never], commands: [{ verb: "plan", export: "uiPlan" }, { verb: "mark", export: "uiMark" }] });
  const badDir = pkg("@t/bad-dir", { dir: "../elsewhere" });
  const badEntry = pkg("@t/bad-entry", { entry: "../index.js" });
  const missingEntry = pkg("@t/missing-entry", { entry: "nope.js" });
  const dupVerb = pkg("@t/dup-verb", { commands: [{ verb: "a", export: "x" }, { verb: "a", export: "y" }] });
  const noExport = pkg("@t/no-export", { commands: [{ verb: "a" } as never] });
  const badId = pkg("@t/bad-id", { dock: [{ id: "Not Valid" }] });
  const dupId = pkg("@t/dup-id", { chips: [{ id: "c" }, { id: "c" }] });
  const notObject = pkg("@t/not-object", "ui" as never);
  const { extensions, refused } = composeUi([plain, good, badDir, badEntry, missingEntry, dupVerb, noExport, badId, dupId, notObject], "user", scratch);
  assert.deepEqual(extensions.map((e) => e.package), ["@t/good"]);
  const ext = extensions[0];
  assert.equal(ext.base, "ext/@t/good/");
  assert.equal(ext.entry, "index.js");
  assert.equal(ext.style, "index.css");
  assert.deepEqual(ext.dock, [{ id: "todo", label: "Todo", order: 100 }], "only validated fields cross, with the default order");
  assert.deepEqual(ext.commands, ["plan", "mark"], "commands are listed by verb");
  assert.deepEqual(ext.streams, [], "nothing here streams");
  assert.deepEqual(ext.panel, []);
  const why = Object.fromEntries(refused.map((r) => [r.package, r.message]));
  assert.match(why["@t/bad-dir"], /dir "\.\.\/elsewhere" leaves the package/);
  assert.match(why["@t/bad-entry"], /entry "\.\.\/index\.js" is not a file inside "ui"/);
  assert.match(why["@t/missing-entry"], /entry "nope\.js" is not a file inside "ui"/);
  assert.match(why["@t/dup-verb"], /commands "a" is declared twice/);
  assert.match(why["@t/no-export"], /command "a" needs an export name/);
  assert.match(why["@t/bad-id"], /dock entry has no valid id/);
  assert.match(why["@t/dup-id"], /chips "c" is declared twice/);
  assert.match(why["@t/not-object"], /ui must be an object/);
  assert.equal(refused.length, 8);
});

test("a panel entry may hang under a section; under is refused on any other slot", () => {
  const hung = pkg("@t/hung", { panel: [{ id: "settings", label: "Settings", under: "packages" }] });
  const out = composeUi([hung], "admin", "/nowhere");
  assert.equal(out.refused.length, 0);
  assert.deepEqual(out.extensions[0].panel, [{ id: "settings", label: "Settings", under: "packages", order: 100 }]);
  const wrong = pkg("@t/wrong", { dock: [{ id: "d", under: "packages" }] });
  assert.match(composeUi([wrong], "admin", "/nowhere").refused[0]?.message ?? "", /under is for panel entries only/);
});

test("composeUi: the first package to claim a shared slot id keeps it; panel ids are not deduped; roles filter", () => {
  const first = pkg("@t/first", { dock: [{ id: "todo" }], panel: [{ id: "people", role: "admin" }, { id: "packages" }], commands: [{ verb: "list", export: "a" }, { verb: "remove", export: "b", role: "admin" }] });
  const second = pkg("@t/second", { dock: [{ id: "todo" }], panel: [{ id: "people" }] });
  const third = pkg("@t/third", { panel: [{ id: "people" }], chips: [{ id: "todo" }], places: [{ id: "market", role: "admin" }] });
  const asUser = composeUi([first, second, third], "user", scratch);
  assert.deepEqual(asUser.refused, [{ package: "@t/second", message: 'dock entry "todo" is already claimed by @t/first' }]);
  assert.deepEqual(asUser.extensions.map((e) => e.package), ["@t/first", "@t/third"]);
  assert.deepEqual(asUser.extensions[0].panel.map((e) => e.id), ["packages"], "an admin-only panel entry is absent for a user");
  assert.deepEqual(asUser.extensions[0].commands, ["list"], "an admin-only command is not listed for a user");
  assert.deepEqual(asUser.extensions[0].hidden, ["panel:people"], "what was dropped is named, so the page accepts its registration quietly");
  assert.deepEqual(asUser.extensions[1].hidden, ["places:market"]);
  assert.deepEqual(asUser.extensions[1].panel.map((e) => e.id), ["people"], "two packages may both declare a panel id");
  assert.deepEqual(asUser.extensions[1].chips.map((e) => e.id), ["todo"], "a chip id does not clash with a dock id");
  assert.deepEqual(asUser.extensions[1].places, []);
  const asAdmin = composeUi([first, second, third], "admin", scratch);
  assert.deepEqual(asAdmin.extensions[0].panel.map((e) => e.id), ["people", "packages"]);
  assert.deepEqual(asAdmin.extensions[0].commands, ["list", "remove"]);
  assert.deepEqual(asAdmin.extensions[0].hidden, []);
  assert.deepEqual(asAdmin.extensions[1].places.map((e) => e.id), ["market"]);
  assert.equal(asAdmin.refused.length, 1, "a refusal does not depend on the role");
});

test("composeUi: a streaming verb is listed in streams, never in commands, and follows the role like any other", () => {
  const streamer = pkg("@t/streamer", { commands: [{ verb: "plain", export: "a" }, { verb: "tail", export: "b", stream: true }, { verb: "watch", export: "c", stream: true, role: "admin" }] });
  const bad = pkg("@t/bad-stream", { commands: [{ verb: "tail", export: "b", stream: "yes" as never }] });
  const asUser = composeUi([streamer, bad], "user", scratch);
  assert.deepEqual(asUser.extensions.map((e) => e.package), ["@t/streamer"]);
  assert.deepEqual(asUser.extensions[0].commands, ["plain"], "a streaming verb is not a command");
  assert.deepEqual(asUser.extensions[0].streams, ["tail"], "and the admin-only one is not listed for a user");
  assert.deepEqual(asUser.refused, [{ package: "@t/bad-stream", message: 'command "tail" stream must be true or false' }]);
  const asAdmin = composeUi([streamer, bad], "admin", scratch);
  assert.deepEqual(asAdmin.extensions[0].commands, ["plain"]);
  assert.deepEqual(asAdmin.extensions[0].streams, ["tail", "watch"]);
});

// ---- through the door ----

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

async function api(cookie: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) }, redirect: "manual" });
}

async function cookieFor(id: string, password: string): Promise<string> {
  const res = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id, password, next: "" }), redirect: "manual" });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function post(cookie: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await api(cookie, path, { method: "POST", body: JSON.stringify(body), headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** One Server-Sent Events stream, read as `{ event, data }` blocks the way the page's EventSource does. */
async function* frames(cookie: string, path: string, signal?: AbortSignal): AsyncGenerator<{ event: string; data: unknown }> {
  const res = await fetch(`${base}${path}`, { headers: { cookie }, signal });
  assert.equal(res.status, 200, `stream ${path}: ${res.status}`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
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

async function ui(cookie: string, user = "alice"): Promise<{ extensions: UiExtension[]; refused: { package: string; message: string }[] }> {
  const res = await api(cookie, `/${user}/api/ui`);
  assert.equal(res.status, 200);
  return (await res.json()) as { extensions: UiExtension[]; refused: { package: string; message: string }[] };
}

function listen(server: Server, where: string | number): Promise<void> {
  return new Promise((done, fail) => server.once("error", fail).listen(where as never, done));
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "thetis-ui-"));
  scratch = join(home, "scratch");
  sysenv = join(home, "sysenv");
  const sys = join(home, "system-packages");
  mkdirSync(sys);
  for (const name of ["harness-core", "tool-exec"]) symlinkSync(resolve(PROJECT, "packages", name), join(sys, name));
  symlinkSync(join(FIXTURES, "provider-echo"), join(sys, "provider-echo"));
  const config = defaultConfig(join(home, "data"), PROJECT);
  config.systemPackagesDir = sys;
  config.model = "echo";
  config.fence.sandbox = (process.env.THETIS_TEST_SANDBOX as "auto" | "none") ?? "auto";
  config.fence.network = "none";
  config.fence.readOnly.push(sys, FIXTURES);
  config.systemPackages = { "*": ["@thetis/harness-core", "@thetis/tool-exec"], _system: ["@thetis/provider-echo"] };
  config.requestTimeoutMs = 60_000;
  const log = (line: string) => process.env.THETIS_TEST_VERBOSE && console.error(line);
  // The records live in memory: this file is about the extension seam, and no storage driver is among its system packages.
  kernel = await createKernel(config, (c) => c.bind(T.log, () => log).bind(T.store, () => memoryStore()));
  kernel.users.create("alice");
  kernel.users.create("bob");
  kernel.users.create("root", "admin");
  await kernel.auth.setPassword("alice", "wonderland");
  await kernel.auth.setPassword("bob", "builder");
  await kernel.auth.setPassword("root", "rootpass1");
  for (const id of PEOPLE) kernel.sessions.userspaceFor(kernel.users.authorize(id));
  // The fixtures are copied into alice's home, because a local source must lie inside her userspace.
  const packages = join(kernel.userspaces.pathFor("alice").home, "packages");
  for (const name of ["ui-good", "ui-bad", "ui-dup"]) cpSync(join(FIXTURES, name), join(packages, name), { recursive: true });
  mkdirSync(join(packages, "plain"));
  writeFileSync(join(packages, "plain", "package.json"), JSON.stringify({ name: "@alice/plain", version: "0.1.0", type: "module", main: "index.js", thetis: { type: "tool" } }));
  writeFileSync(join(packages, "plain", "index.js"), "export const nothing = 1;");

  const rpcFor = (us: Userspace) => createRpcHandler(us, kernel, createControlHandler(kernel), async (u) => ({ model: kernel.config.model, models: await kernel.providers.listModels(u) }));
  const assets = join(home, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "index.html"), "<title>app</title>");
  const loginAssets = join(home, "login-assets");
  mkdirSync(loginAssets);
  writeFileSync(join(loginAssets, "login.html"), "<title>login</title>");
  const socketsDir = join(home, "s");
  mkdirSync(socketsDir);
  for (const id of PEOPLE) {
    const us = kernel.userspaces.pathFor(id);
    const client = clientFromRpc(rpcFor(us));
  const env = { ...envAt(sysenv), cwd: us.home, root: us.root, store: us.store, kernel: client };
    const server = createGateway(client, new GatewayStore(join(home, "store", id)), { assets, log, env, user: id, base: `/${id}`, commandTimeoutMs: 300 });
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

test("api/ui: empty before, lists ui-good after install; ui-bad and ui-dup are refused by name and ui-good still composes", async () => {
  const alice = await cookieFor("alice", "wonderland");
  assert.equal((await fetch(`${base}/alice/api/ui`)).status, 401, "the route needs the cookie");
  assert.deepEqual(await ui(alice), { extensions: [], refused: [] });
  for (const name of ["plain", "ui-good", "ui-bad", "ui-dup"]) {
    const res = await api(alice, "/alice/api/packages", { method: "POST", body: JSON.stringify({ source: `packages/${name}` }) });
    assert.equal(res.status, 201, await res.text());
  }
  const { extensions, refused } = await ui(alice);
  assert.deepEqual(extensions.map((e) => e.package), [GOOD], "plain has no ui; the refused ones are absent");
  const good = extensions[0];
  assert.equal(good.version, "0.1.0");
  assert.equal(good.base, `ext/${GOOD}/`);
  assert.equal(good.entry, "index.js");
  assert.equal(good.style, "index.css");
  assert.deepEqual(good.dock, [{ id: "good", label: "Good", icon: "M5 5h10v10H5z", hint: "The fixture's dock panel", order: 100 }]);
  assert.deepEqual(good.chips, [{ id: "good", order: 100 }]);
  assert.deepEqual(good.panel, [], "the admin-only panel entry is absent for alice");
  assert.deepEqual(good.commands, ["echo", "slow", "boom", "nofn"], "verbs only; the admin-only one is not listed for alice");
  assert.deepEqual(good.streams, ["ticks", "forever", "erupt"], "the streaming verbs are their own list; the admin-only one is not in it");
  assert.deepEqual(refused.map((r) => r.package), ["@alice/ui-bad", "@alice/ui-dup"]);
  assert.match(refused[0].message, /entry "\.\.\/index\.js" is not a file inside "ui"/);
  assert.equal(refused[1].message, `dock entry "good" is already claimed by ${GOOD}`);
  assert.equal(((await (await api(alice, "/alice/api/packages")).json()) as { name: string }[]).filter((p) => p.name.startsWith("@alice/")).length, 4, "the packages route still lists them all");
});

test("ext: a package's browser files are served from under its declared directory, and nothing else is", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const js = await api(alice, `/alice/ext/${GOOD}/index.js`);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(js.headers.get("cache-control"), "no-cache");
  assert.match(await js.text(), /export default function install/);
  const css = await api(alice, `/alice/ext/%40alice/ui-good/index.css`);
  assert.equal(css.status, 200, "an encoded scope segment is the same package");
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal((await fetch(`${base}/alice/ext/${GOOD}/index.js`)).status, 401, "the files need the cookie like the API");
  assert.equal((await api(alice, `/alice/ext/${GOOD}/../package.json`)).status, 404);
  assert.equal((await api(alice, `/alice/ext/${GOOD}/%2e%2e/package.json`)).status, 404, "an encoded step up is refused too");
  assert.equal((await api(alice, `/alice/ext/${GOOD}/%2e%2e%2Fpackage.json`)).status, 404);
  assert.equal((await api(alice, `/alice/ext/${GOOD}/`)).status, 404, "the directory itself is not a file");
  assert.equal((await api(alice, `/alice/ext/${GOOD}/missing.js`)).status, 404);
  writeFileSync(join(kernel.userspaces.pathFor("alice").home, "packages", "ui-good", "ui", "extra.ts"), "export {};");
  assert.equal((await api(alice, `/alice/ext/${GOOD}/extra.ts`)).status, 404, "an extension outside the table is not served even when the file exists");
  assert.equal((await api(alice, "/alice/ext/@alice/plain/index.js")).status, 404, "an installed package without ui serves nothing");
  assert.equal((await api(alice, "/alice/ext/@alice/ui-bad/index.js")).status, 404, "a refused package serves nothing");
  assert.equal((await api(alice, "/alice/ext/@alice/nope/index.js")).status, 404);
  assert.equal((await api(alice, `/alice/ext/${GOOD}`)).status, 404, "no path, no file");
  assert.equal((await api(alice, `/alice/ext/${GOOD}/index.js`, { method: "POST" })).status, 404);
});

test("commands: the checks in order, then the export runs as the person with the fence environment", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const bob = await cookieFor("bob", "builder");
  const { id: session } = (await (await api(alice, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  const { id: bobs } = (await (await api(bob, "/bob/api/sessions", { method: "POST" })).json()) as { id: string };
  const path = `/alice/api/ext/${GOOD}`;

  const echo = await post(alice, `${path}/echo`, { session, args: { name: "x" } });
  assert.equal(echo.status, 200, JSON.stringify(echo.body));
  assert.deepEqual(echo.body, { text: "hi x", data: { session, user: "alice", role: "user", cwd: "string", kernel: "object" } });
  const bare = await post(alice, `${path}/echo`, { args: { name: "y" } });
  assert.deepEqual(bare.body, { text: "hi y", data: { user: "alice", role: "user", cwd: "string", kernel: "object" } }, "no session named, none passed");
  assert.equal((await post(alice, `${path}/echo`, {})).status, 200, "an empty body means no arguments");

  assert.equal((await post(alice, `${path}/nope`, {})).status, 404, "an undeclared verb");
  assert.equal((await post(alice, `/alice/api/ext/@alice/plain/echo`, {})).status, 404, "a package without ui");
  assert.equal((await post(alice, `/alice/api/ext/@alice/ui-dup/echo`, {})).status, 404, "a refused package");
  const forbidden = await post(alice, `${path}/admin-only`, {});
  assert.equal(forbidden.status, 403);
  assert.match(String(forbidden.body.error), /admin/);
  assert.equal((await post(alice, `${path}/echo`, { session: bobs })).status, 404, "another person's session");
  assert.equal((await post(alice, `${path}/echo`, { session: "s_deadbeef" })).status, 404, "a session that does not exist");
  assert.equal((await post(alice, `${path}/echo`, { session: "../x" })).status, 404, "a session id of the wrong shape");
  assert.equal((await post(alice, `${path}/echo`, { args: "x" })).status, 400, "args must be an object");
  assert.equal((await post(alice, `${path}/echo`, {}, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post(bob, `${path}/echo`, {})).status, 401, "bob's cookie at alice's gateway");

  const boom = await post(alice, `${path}/boom`, {});
  assert.equal(boom.status, 400);
  assert.equal(boom.body.error, "no");
  const slow = await post(alice, `${path}/slow`, {});
  assert.equal(slow.status, 504);
  assert.match(String(slow.body.error), /did not answer "slow" in time/);
  const nofn = await post(alice, `${path}/nofn`, {});
  assert.equal(nofn.status, 500);
  assert.match(String(nofn.body.error), /does not export a function named "NOT_A_FUNCTION"/);
});

test("stream: a streaming verb yields its items and ends; a throw becomes an error event", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const { id: session } = (await (await api(alice, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  const args = encodeURIComponent(JSON.stringify({ name: "x" }));
  const ticks: { event: string; data: unknown }[] = [];
  for await (const f of frames(alice, `/alice/api/ext/${GOOD}/ticks/stream?session=${session}&args=${args}`)) ticks.push(f);
  assert.deepEqual(ticks.map((f) => f.event), ["item", "item", "item", "end"]);
  assert.deepEqual(ticks.map((f) => f.data), [{ n: 1, name: "x", session }, { n: 2, name: "x", session }, { n: 3, name: "x", session }, {}]);
  const bare: { event: string; data: unknown }[] = [];
  for await (const f of frames(alice, `/alice/api/ext/${GOOD}/ticks/stream`)) bare.push(f);
  assert.deepEqual(bare[0].data, { n: 1, name: null, session: null }, "no session named, none passed");
  const burst: { event: string; data: unknown }[] = [];
  for await (const f of frames(alice, `/alice/api/ext/${GOOD}/erupt/stream`)) burst.push(f);
  assert.deepEqual(burst.map((f) => f.event), ["item", "error"]);
  assert.deepEqual(burst[1].data, { message: "burst" });
});

test("stream: the browser letting go aborts the export's signal and closes its iterator", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const marker = join(sysenv, "ui-good-abort.txt");
  rmSync(marker, { force: true });
  const control = new AbortController();
  let seen = 0;
  await assert.rejects(async () => {
    for await (const f of frames(alice, `/alice/api/ext/${GOOD}/forever/stream`, control.signal)) if (f.event === "item" && ++seen === 2) control.abort();
  });
  assert.equal(seen, 2, "it kept yielding until the client stopped reading");
  for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((done) => setTimeout(done, 20));
  assert.equal(readFileSync(marker, "utf8"), "true", "the export's finally ran and env.signal was aborted");
});

test("stream: the checks of a command, and the two that keep the two seams apart", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const bob = await cookieFor("bob", "builder");
  const { id: bobs } = (await (await api(bob, "/bob/api/sessions", { method: "POST" })).json()) as { id: string };
  const path = `/alice/api/ext/${GOOD}`;
  const get = async (p: string): Promise<{ status: number; error?: string }> => {
    const res = await api(alice, p);
    return { status: res.status, ...((await res.json()) as { error?: string }) };
  };
  assert.equal((await get(`${path}/nope/stream`)).status, 404, "an undeclared verb");
  assert.equal((await get(`/alice/api/ext/@alice/plain/ticks/stream`)).status, 404, "a package without ui");
  const forbidden = await get(`${path}/admin-ticks/stream`);
  assert.equal(forbidden.status, 403);
  assert.match(String(forbidden.error), /admin/);
  const notAStream = await get(`${path}/echo/stream`);
  assert.equal(notAStream.status, 400);
  assert.match(String(notAStream.error), /"echo" does not stream/);
  const notACommand = await post(alice, `${path}/ticks`, {});
  assert.equal(notACommand.status, 400);
  assert.match(String(notACommand.body.error), /"ticks" streams; subscribe to it/);
  assert.equal((await get(`${path}/ticks/stream?session=${bobs}`)).status, 404, "another person's session");
  assert.equal((await get(`${path}/ticks/stream?session=s_deadbeef`)).status, 404, "a session that does not exist");
  assert.equal((await get(`${path}/ticks/stream?args=%5B1%5D`)).status, 400, "args that are not an object");
  assert.equal((await get(`${path}/ticks/stream?args=not-json`)).status, 400, "args that are not JSON");
  assert.equal((await get(`${path}/ticks/stream?args=${encodeURIComponent(JSON.stringify({ pad: "x".repeat(4096) }))}`)).status, 400, "args over 4 KiB");
  assert.equal((await fetch(`${base}${path}/ticks/stream`)).status, 401, "the route needs the cookie");
  assert.equal((await api(bob, `${path}/ticks/stream`)).status, 401, "bob's cookie at alice's gateway");
});

test("api/ui drops a package after it is removed", async () => {
  const alice = await cookieFor("alice", "wonderland");
  assert.equal((await api(alice, `/alice/api/packages/${encodeURIComponent(GOOD)}`, { method: "DELETE" })).status, 200);
  const { extensions, refused } = await ui(alice);
  assert.deepEqual(extensions.map((e) => e.package), ["@alice/ui-dup"], "with ui-good gone, ui-dup's claim stands");
  assert.deepEqual(refused.map((r) => r.package), ["@alice/ui-bad"]);
  assert.equal((await api(alice, `/alice/ext/${GOOD}/index.js`)).status, 404);
  assert.equal((await post(alice, `/alice/api/ext/${GOOD}/echo`, {})).status, 404);
});

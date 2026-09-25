// The extension seam of the gateway: `thetis.ui` composed from installed packages, a package's browser
// files served under its own segment, and its declared commands run as the person. First the composition
// rules on hand-built package lists against a scratch store, then the routes through the door as alice,
// with the fixtures under test/host/fixtures installed into her own space. The raw seam (`kind: "raw"`:
// a download or an upload, bytes rather than JSON) is exercised with a package written into her home here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { exec as cpExec } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
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
import { HttpError } from "../src/http.js";
import { composeUi, runRaw, type UiExtension } from "../src/ui.js";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = resolve(PROJECT, "test/host/fixtures");
const PEOPLE = ["alice", "bob", "root"] as const;
const GOOD = "@alice/ui-good";
const RAW = "@alice/ui-raw";

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

test("composeUi: a raw verb is listed in raw, never in commands; kind and maxBytes are checked; the role filters it", () => {
  const rawer = pkg("@t/rawer", { commands: [{ verb: "plain", export: "a" }, { verb: "up", export: "b", kind: "raw", maxBytes: 64 * 1024 * 1024 }, { verb: "down", export: "c", kind: "raw" }, { verb: "keep", export: "d", kind: "raw", role: "admin" }, { verb: "json", export: "e", kind: "json" }] as never });
  const badKind = pkg("@t/bad-kind", { commands: [{ verb: "up", export: "b", kind: "bytes" }] as never });
  const badMax = pkg("@t/bad-max", { commands: [{ verb: "up", export: "b", kind: "raw", maxBytes: 0 }] as never });
  const hugeMax = pkg("@t/huge-max", { commands: [{ verb: "up", export: "b", kind: "raw", maxBytes: 512 * 1024 * 1024 + 1 }] as never });
  const fracMax = pkg("@t/frac-max", { commands: [{ verb: "up", export: "b", kind: "raw", maxBytes: 1.5 }] as never });
  const jsonMax = pkg("@t/json-max", { commands: [{ verb: "up", export: "b", maxBytes: 10 }] as never });
  const rawStream = pkg("@t/raw-stream", { commands: [{ verb: "up", export: "b", kind: "raw", stream: true }] as never });
  const asUser = composeUi([rawer, badKind, badMax, hugeMax, fracMax, jsonMax, rawStream], "user", scratch);
  assert.deepEqual(asUser.extensions.map((e) => e.package), ["@t/rawer"]);
  assert.deepEqual(asUser.extensions[0].commands, ["plain", "json"], "a raw verb is not a command; kind json is the default");
  assert.deepEqual(asUser.extensions[0].raw, ["up", "down"], "the admin-only raw verb is not listed for a user");
  assert.deepEqual(asUser.extensions[0].streams, []);
  const why = Object.fromEntries(asUser.refused.map((r) => [r.package, r.message]));
  assert.equal(why["@t/bad-kind"], 'command "up" kind must be json or raw');
  assert.match(why["@t/bad-max"], /command "up" maxBytes must be a whole number of bytes between 1 and 536870912/);
  assert.match(why["@t/huge-max"], /maxBytes must be a whole number/);
  assert.match(why["@t/frac-max"], /maxBytes must be a whole number/);
  assert.equal(why["@t/json-max"], 'command "up" maxBytes is for raw commands only');
  assert.equal(why["@t/raw-stream"], 'command "up" cannot both stream and be raw');
  assert.equal(asUser.refused.length, 6);
  const asAdmin = composeUi([rawer], "admin", scratch);
  assert.deepEqual(asAdmin.extensions[0].raw, ["up", "down", "keep"]);
  const plain = composeUi([pkg("@t/no-raw", { commands: [{ verb: "a", export: "a" }] })], "user", scratch);
  assert.deepEqual(plain.extensions[0].raw, [], "always a list, so the page can test it");
});

test("runRaw: a PUT hands the export the body and answers its return as data; a GET hands back the stream it answered", async () => {
  const root = join(scratch, "node_modules", "@test", "rawcmd");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
  writeFileSync(
    join(root, "index.js"),
    [
      "import { Readable } from 'node:stream';",
      "export const up = (args, env, req) => ({ method: req.method, size: req.body.length, text: req.body.toString(), name: args.name, user: env.user, session: env.session ?? null });",
      "export const down = (args, env, req) => ({ status: 206, headers: { 'Content-Type': 'text/plain', ETag: 'e1', 'Set-Cookie': 'nope=1' }, body: Readable.from([Buffer.from('a'), Buffer.from('b'), args.name ?? '']) });",
      "export const bytes = () => ({ headers: {}, body: Buffer.from('raw') });",
      "export const nothing = () => undefined;",
      "export const shape = () => ({ headers: { 'x-bad': 'a\\nb' }, body: 'x' });",
    ].join("\n")
  );
  const commands = [{ verb: "up", export: "up", kind: "raw", maxBytes: 16 }, { verb: "down", export: "down", kind: "raw" }, { verb: "bytes", export: "bytes", kind: "raw" }, { verb: "nothing", export: "nothing", kind: "raw" }, { verb: "shape", export: "shape", kind: "raw" }, { verb: "json", export: "up" }];
  const ctx = {
    store: scratch,
    env: {} as never,
    kernel: { packages: { list: async () => [{ name: "@test/rawcmd", version: "1.0.0", type: "tool", root, thetis: { type: "tool", ui: { commands } } }] }, config: { effective: async () => ({}) } } as never,
  };
  const who = { id: "alice", role: "user" as const };
  assert.deepEqual(await runRaw(ctx, who, "@test", "rawcmd", "up", { method: "PUT", args: { name: "x" }, body: Buffer.from("hello") }), { data: { method: "PUT", size: 5, text: "hello", name: "x", user: "alice", session: null } });
  let askedFor = 0;
  assert.deepEqual(await runRaw(ctx, who, "@test", "rawcmd", "up", { method: "PUT", args: {}, body: async (limit) => { askedFor = limit; return Buffer.from("hi"); } }), { data: { method: "PUT", size: 2, text: "hi", name: undefined, user: "alice", session: null } });
  assert.equal(askedFor, 16, "a reader is told the command's maxBytes, so the route reads no more than that");
  await assert.rejects(runRaw(ctx, who, "@test", "rawcmd", "up", { method: "PUT", body: Buffer.alloc(17) }), (e: unknown) => e instanceof HttpError && e.status === 413 && e.message === "That upload is larger than 0 KB.");
  assert.deepEqual(await runRaw(ctx, who, "@test", "rawcmd", "nothing", { method: "PUT", body: Buffer.alloc(0) }), {}, "no answer is an empty reply, as for a command");
  const down = await runRaw(ctx, who, "@test", "rawcmd", "down", { method: "GET", args: { name: "c" } });
  assert.equal(down.status, 206);
  assert.deepEqual(down.headers, { "content-type": "text/plain", etag: "e1" }, "header names are lowercased; a cookie is not a package's to set");
  assert.ok(down.body instanceof Readable, "the stream comes back unconsumed");
  const chunks: Buffer[] = [];
  for await (const chunk of down.body) chunks.push(Buffer.from(chunk as Buffer | string));
  assert.equal(Buffer.concat(chunks).toString(), "abc");
  const bytes = await runRaw(ctx, who, "@test", "rawcmd", "bytes", { method: "GET" });
  assert.equal(bytes.status, 200, "the status defaults to 200");
  assert.deepEqual(bytes.body, Buffer.from("raw"));
  await assert.rejects(runRaw(ctx, who, "@test", "rawcmd", "nothing", { method: "GET" }), (e: unknown) => e instanceof HttpError && e.status === 502 && /invalid raw answer/.test(e.message));
  await assert.rejects(runRaw(ctx, who, "@test", "rawcmd", "shape", { method: "GET" }), (e: unknown) => e instanceof HttpError && e.status === 502, "a header value with a line break in it");
  await assert.rejects(runRaw(ctx, who, "@test", "rawcmd", "json", { method: "GET" }), (e: unknown) => e instanceof HttpError && e.status === 400 && e.message === '"json" is not raw');
  await assert.rejects(runRaw(ctx, who, "@test", "rawcmd", "up", { method: "GET", args: [1] }), (e: unknown) => e instanceof HttpError && e.status === 400 && e.message === "args must be an object");
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
  // The raw seam's package: a download, an upload and the ways each can go wrong, each behind one verb.
  mkdirSync(join(packages, "ui-raw", "ui"), { recursive: true });
  writeFileSync(join(packages, "ui-raw", "ui", "index.js"), "export default () => {};");
  writeFileSync(
    join(packages, "ui-raw", "package.json"),
    JSON.stringify({
      name: RAW, version: "0.1.0", type: "module", main: "index.js",
      thetis: { type: "tool", ui: { dir: "ui", entry: "index.js", commands: [
        { verb: "echo", export: "uiEcho" },
        { verb: "upload", export: "uiUpload", kind: "raw", maxBytes: 2048 },
        { verb: "blob", export: "uiBlob", kind: "raw" },
        { verb: "flow", export: "uiFlow", kind: "raw" },
        { verb: "hold", export: "uiHold", kind: "raw" },
        { verb: "bad-raw", export: "uiBad", kind: "raw" },
        { verb: "boom-raw", export: "uiBoom", kind: "raw" },
        { verb: "slow-raw", export: "uiSlow", kind: "raw" },
        { verb: "admin-raw", export: "uiBlob", kind: "raw", role: "admin" },
      ] } },
    })
  );
  writeFileSync(
    join(packages, "ui-raw", "index.js"),
    [
      "import { Readable } from 'node:stream';",
      "export const uiEcho = (args) => ({ text: 'hi ' + args.name });",
      "export const uiUpload = (args, env, req) => ({ method: req.method, size: req.body.length, head: req.body.subarray(0, 4).toString('latin1'), name: args.name, user: env.user, session: env.session ?? null });",
      "export const uiBlob = (args) => ({ headers: { 'Content-Type': 'text/plain; charset=utf-8', ETag: 'abc', 'Set-Cookie': 'nope=1', 'Cache-Control': 'max-age=999' }, body: 'hello ' + (args.name ?? 'nobody') });",
      "export const uiFlow = () => ({ status: 206, headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=\"a.bin\"' }, body: Readable.from([Buffer.from([0, 1]), Buffer.from([2, 255])]) });",
      "export const uiHold = (args, env) => { const body = new Readable({ read() {} }); body.push('first'); env.signal.addEventListener('abort', () => { env.writeFile('ui-raw-abort.txt', String(env.signal.aborted)); }); return { headers: { 'content-type': 'text/plain' }, body }; };",
      "export const uiBad = () => ({ nope: 1 });",
      "export const uiBoom = () => { throw new Error('no'); };",
      "export const uiSlow = () => new Promise(() => {});",
    ].join("\n")
  );

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

test("raw: an upload is read up to the command's maxBytes and answered as data; a download carries the export's headers under the gateway's policy", async () => {
  const alice = await cookieFor("alice", "wonderland");
  const bob = await cookieFor("bob", "builder");
  assert.equal((await api(alice, "/alice/api/packages", { method: "POST", body: JSON.stringify({ source: "packages/ui-raw" }) })).status, 201);
  const listed = (await ui(alice)).extensions.find((e) => e.package === RAW)!;
  assert.deepEqual(listed.commands, ["echo"], "a raw verb is not a command");
  assert.deepEqual(listed.raw, ["upload", "blob", "flow", "hold", "bad-raw", "boom-raw", "slow-raw"], "the admin-only one is not listed for alice");
  const { id: session } = (await (await api(alice, "/alice/api/sessions", { method: "POST" })).json()) as { id: string };
  const { id: bobs } = (await (await api(bob, "/bob/api/sessions", { method: "POST" })).json()) as { id: string };
  const path = `/alice/api/ext/${RAW}`;
  const at = (verb: string, args?: unknown, extra = "") => `${path}/${verb}/raw?${args === undefined ? "" : `args=${encodeURIComponent(JSON.stringify(args))}`}${extra}`;
  const put = (url: string, body: BodyInit, headers: Record<string, string> = {}) => api(alice, url, { method: "PUT", body, headers: { "content-type": "application/octet-stream", ...headers } });

  // The upload: the body whole, the export's return as `data`, the session checked like a command's.
  const png = Buffer.concat([Buffer.from("\x89PNG", "latin1"), Buffer.alloc(100, 7)]);
  const up = await put(at("upload", { name: "a.png" }, `&session=${session}`), png);
  const upText = await up.text();
  assert.equal(up.status, 200, upText);
  assert.deepEqual(JSON.parse(upText), { data: { method: "PUT", size: 104, head: "\x89PNG", name: "a.png", user: "alice", session } });
  assert.deepEqual(await (await put(at("upload"), "")).json(), { data: { method: "PUT", size: 0, head: "", user: "alice", session: null } }, "no arguments and an empty body are both allowed");
  const tooBig = await put(at("upload", { name: "b.bin" }), Buffer.alloc(2049));
  assert.equal(tooBig.status, 413);
  assert.deepEqual(await tooBig.json(), { error: "That upload is larger than 2 KB." });
  assert.equal((await put(at("upload"), "x", { "sec-fetch-site": "cross-site" })).status, 403, "a PUT is a write and must be same-site");
  assert.equal((await put(at("upload", {}, `&session=${bobs}`), "x")).status, 404, "another person's session");
  assert.equal((await put(at("upload", [1]), "x")).status, 400, "args that are not an object");
  assert.equal((await put(at("upload", { pad: "x".repeat(4096) }), "x")).status, 400, "args over 4 KiB");
  const slow = await put(at("slow-raw"), "x");
  assert.equal(slow.status, 504, "the command timeout applies to a PUT");
  assert.match(((await slow.json()) as { error: string }).error, /did not answer "slow-raw" in time/);

  // The download: status and headers from the export, `no-store` and the media policy from the gateway.
  const blob = await api(alice, at("blob", { name: "x" }));
  assert.equal(blob.status, 200);
  assert.equal(blob.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(blob.headers.get("etag"), "abc");
  assert.equal(blob.headers.get("cache-control"), "no-store", "the export's cache header did not win");
  assert.equal(blob.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(blob.headers.get("set-cookie"), null, "a package cannot set a cookie on this origin");
  assert.equal(blob.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await blob.text(), "hello x");
  const flow = await api(alice, at("flow"));
  assert.equal(flow.status, 206, "the export's status is served");
  assert.equal(flow.headers.get("content-disposition"), 'attachment; filename="a.bin"');
  assert.deepEqual(new Uint8Array(await flow.arrayBuffer()), new Uint8Array([0, 1, 2, 255]), "a stream is piped whole");
  assert.equal((await api(alice, at("flow"), { method: "POST" })).status, 404, "only GET and PUT reach the raw route");
  const bad = await api(alice, at("bad-raw"));
  assert.equal(bad.status, 502);
  assert.match(((await bad.json()) as { error: string }).error, /invalid raw answer/);
  const boom = await api(alice, at("boom-raw"));
  assert.equal(boom.status, 400);
  assert.deepEqual(await boom.json(), { error: "no" });

  // The browser letting go of a download aborts the export's signal.
  const marker = join(sysenv, "ui-raw-abort.txt");
  rmSync(marker, { force: true });
  const control = new AbortController();
  const held = await fetch(`${base}${at("hold")}`, { headers: { cookie: alice }, signal: control.signal });
  assert.equal(held.status, 200);
  const reader = held.body!.getReader();
  assert.equal(Buffer.from((await reader.read()).value!).toString(), "first");
  control.abort();
  for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((done) => setTimeout(done, 20));
  assert.equal(readFileSync(marker, "utf8"), "true", "the export's abort listener ran");

  // The checks of a command, and the ones that keep the three seams apart.
  const forbidden = await api(alice, at("admin-raw"));
  assert.equal(forbidden.status, 403);
  assert.match(((await forbidden.json()) as { error: string }).error, /only an admin can send "admin-raw"/);
  assert.equal((await api(alice, at("nope"))).status, 404, "an undeclared verb");
  const notRaw = await api(alice, at("echo"));
  assert.equal(notRaw.status, 400);
  assert.deepEqual(await notRaw.json(), { error: '"echo" is not raw' });
  const asCommand = await post(alice, `${path}/blob`, {});
  assert.equal(asCommand.status, 400);
  assert.equal(asCommand.body.error, '"blob" is raw; use its raw route');
  const asStream = await api(alice, `${path}/blob/stream`);
  assert.equal(asStream.status, 400);
  assert.deepEqual(await asStream.json(), { error: '"blob" is raw; use its raw route' });
  assert.equal((await api(alice, `/alice/api/ext/${GOOD}/ticks/raw`)).status, 400, "a stream is not raw either");
  assert.equal((await fetch(`${base}${at("blob")}`)).status, 401, "the route needs the cookie");
  assert.equal((await api(bob, at("blob"))).status, 401, "bob's cookie at alice's gateway");
  assert.equal((await api(alice, `/alice/api/packages/${encodeURIComponent(RAW)}`, { method: "DELETE" })).status, 200);
  assert.equal((await api(alice, at("blob"))).status, 404, "gone with the package");
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

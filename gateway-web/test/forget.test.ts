// The `thetis.sessions` seam and Forget, over a fake kernel: a package's archive hook hears of an archive
// and a restore with the time, and its failure never reaches the person; the forget preview says what will
// go and what stays; the forget refuses a subagent, a wrong title, a blocking hook and a running turn
// unless told to stop it; a hook that fails becomes a kept sentence; attachments go through
// `kernel.assets.remove`, or are said to stay when the server does not have it yet; records are deleted
// deepest first; and the receipt says what went and what stayed. The hook packages are written into a
// scratch store, so they run through the same loader a real package does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import type { KernelClient, PackageInfo, SessionSummaryRef, StepEnv } from "@thetis/runtime/contracts";
import { createGateway } from "../src/server.js";
import { GatewayStore } from "../src/store.js";
import { ALWAYS_KEPT, deepestFirst, sessionHooks, validateSessions } from "../src/sessions.js";

const COOKIE = "thetis_web=" + "a".repeat(64);
const A1 = "a_" + "1".repeat(32);
const A2 = "a_" + "2".repeat(32);

type Call = { pkg: string; arg: Record<string, unknown>; env: Record<string, unknown> };
const g = globalThis as unknown as { hookCalls: Call[]; hookBlock?: string; hookFail?: string };

let scratch: string;
/** Every hook the fake agent ran: package, export and the name the gateway gave the call. */
const invoked: string[] = [];

/** A package in the scratch store whose `main` is `source`. */
function pkg(name: string, sessions: unknown, source = ""): PackageInfo {
  const root = join(scratch, "node_modules", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
  writeFileSync(join(root, "index.js"), source);
  return { name, version: "1.0.0", type: "tool", description: "", root, thetis: { type: "tool", ...(sessions !== undefined ? { sessions } : {}) } } as PackageInfo;
}

/** An export that records its call (with the env's own fields) and answers `answer(arg)`. */
const recorder = (name: string, exportName: string, answer: string) => `
export async function ${exportName}(arg, env) {
  globalThis.hookCalls.push({ pkg: ${JSON.stringify(name)}, arg, env: { storageOf: env.storageOf, session: env.session, config: env.config } });
  return (${answer})(arg);
}`;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "gw-forget-"));
  g.hookCalls = [];
});
after(() => rmSync(scratch, { recursive: true, force: true }));

type Rec = { id: string; parent?: string; turns: number; running?: boolean; conversation?: unknown[] };

/** A kernel holding `recs`, in creation order; it records deletes, cancels and asset removals. `remove: false` is a kernel from before `assets.remove`. */
function fakeKernel(recs: Rec[], packages: PackageInfo[], opts: { remove?: false | ((id: string) => Promise<{ id: string; removed: boolean }>); stopAfter?: number } = {}) {
  const deleted: string[] = [];
  const cancelled: string[] = [];
  const removed: string[] = [];
  let live = [...recs];
  const ref = (r: Rec): SessionSummaryRef => ({ id: r.id, user: "alice", ...(r.parent ? { parent: r.parent } : {}), createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", turns: r.turns, first: `first words of ${r.id}`, last: "last", running: Boolean(r.running) }) as SessionSummaryRef;
  const assets: Record<string, unknown> = { put: async () => ({}), read: async () => ({}) };
  if (opts.remove !== false) assets.remove = opts.remove ?? (async (id: string) => (removed.push(id), { id, removed: true }));
  const kernel = {
    auth: { authenticate: async () => ({ id: "alice", role: "user" as const }) },
    assets,
    sessions: {
      list: async () => live.map(ref),
      inspect: async (id: string) => {
        const r = live.find((x) => x.id === id);
        if (!r) throw Object.assign(new Error(`unknown session ${id}`), { code: "not-found" });
        return { id, user: "alice", createdAt: "", updatedAt: "", turns: r.turns, conversation: r.conversation ?? [], status: r.running ? "running" : "idle" };
      },
      delete: async (id: string) => {
        deleted.push(id);
        live = live.filter((x) => x.id !== id);
      },
      cancel: async (id: string) => {
        cancelled.push(id);
        const r = live.find((x) => x.id === id);
        if (r) setTimeout(() => (r.running = false), opts.stopAfter ?? 50);
        return true;
      },
      watch: async () => new Promise<void>(() => {}),
    },
    packages: { list: async () => packages },
    config: { effective: async (name: string) => ({ from: name }) },
  } as unknown as KernelClient;
  return { kernel, deleted, cancelled, removed };
}

async function serve(kernel: KernelClient, dir: string, log: string[] = []) {
  const assets = mkdtempSync(join(tmpdir(), "gw-assets-"));
  writeFileSync(join(assets, "index.html"), "<title>app</title>");
  const store = new GatewayStore(dir);
  // The agent's `invokeTool`, as far as a hook can tell: the export loaded fresh from the store and called
  // with the env of its own package, which here only names that package where storage would be bound.
  const env = {
    invokeTool: async (ref: { package: string; export: string; name: string }, args: unknown, opts: { session: unknown; config: unknown }) => {
      invoked.push(`${ref.package} ${ref.export} ${ref.name}`);
      const mod = (await import(`${pathToFileURL(join(scratch, "node_modules", ref.package, "index.js")).href}?v=${Date.now()}`)) as Record<string, unknown>;
      const fn = mod[ref.export];
      if (typeof fn !== "function") throw new Error(`${ref.package} does not export a function named "${ref.export}"`);
      return fn(args, { storageOf: ref.package, session: opts.session, config: opts.config });
    },
  } as unknown as StepEnv;
  const server = createGateway(kernel, store, { assets, user: "alice", base: "/alice", log: (line) => log.push(line), env, store: scratch });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(`${origin}/alice${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: COOKIE, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: string } };
  };
  const close = () => new Promise<void>((done) => server.close(() => done()));
  return { call, close, store, log };
}

const until = async (ok: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < deadline, "timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const asset = (id: string) => ({ type: "asset", data: { id, mediaType: "image/png" } });

test("the seam: an export name per kind, unknown keys left alone, and a bad declaration skips the package with its reason in the log", () => {
  assert.equal(validateSessions(pkg("@t/none", undefined)), undefined);
  assert.deepEqual(validateSessions(pkg("@t/good", { archive: "onArchive", forget: "forgetSession", later: 1 })), { sessions: { archive: "onArchive", forget: "forgetSession" } });
  assert.deepEqual(validateSessions(pkg("@t/not-object", "onArchive")), { error: "sessions must be an object" });
  assert.deepEqual(validateSessions(pkg("@t/bad-name", { forget: "no such-name" })), { error: "sessions forget must name an export" });
  const log: string[] = [];
  const all = [pkg("@t/a", { archive: "a" }), pkg("@t/bad", { archive: "a", forget: 3 }), pkg("@t/f", { forget: "f" })];
  assert.deepEqual(sessionHooks(all, "archive", (l) => log.push(l)), [{ package: "@t/a", export: "a" }], "a bad declaration skips the whole package, its good half too");
  assert.deepEqual(sessionHooks(all, "forget", () => {}), [{ package: "@t/f", export: "f" }]);
  assert.match(log.join("\n"), /@t\/bad is skipped for the archive hook: sessions forget must name an export/);
});

test("deepest first: a child always goes before its parent, the later sibling first", () => {
  assert.deepEqual(deepestFirst([{ id: "r" }, { id: "c1", parent: "r" }, { id: "g", parent: "c1" }, { id: "c2", parent: "r" }]), ["g", "c2", "c1", "r"]);
});

test("archive: the mark keeps when, every archive hook hears it as the person with its own config, a failing hook is only logged, and restore clears the time", async () => {
  g.hookCalls = [];
  const packages = [
    pkg("@t/arch-ok", { archive: "onArchive" }, recorder("@t/arch-ok", "onArchive", "() => undefined")),
    pkg("@t/arch-bad", { archive: "onArchive" }, `export async function onArchive() { throw new Error("disk full"); }`),
    pkg("@t/arch-missing", { archive: "nothere" }, `export const other = 1;`),
  ];
  const { kernel } = fakeKernel([{ id: "s_a1", turns: 2 }], packages);
  const dir = mkdtempSync(join(tmpdir(), "gw-store-"));
  const { call, close, log } = await serve(kernel, dir);
  try {
    const done = await call("/api/sessions/s_a1/archive", { archived: true });
    assert.equal(done.status, 200, "a failing hook never fails the archive");
    assert.equal(done.body.archived, true);
    const at = done.body.archivedAt as string;
    assert.ok(!Number.isNaN(Date.parse(at)), "the answer carries when");
    await until(() => g.hookCalls.length === 1 && log.length >= 2);
    assert.deepEqual(g.hookCalls[0], { pkg: "@t/arch-ok", arg: { session: "s_a1", archived: true, archivedAt: at }, env: { storageOf: "@t/arch-ok", session: { id: "s_a1", user: "alice" }, config: { from: "@t/arch-ok" } } });
    assert.ok(invoked.includes("@t/arch-ok onArchive @t/arch-ok#sessions.archive"), "run through invokeTool, under the hook's own package, so its storage is its own");
    assert.match(log.join("\n"), /@t\/arch-bad archive hook failed for s_a1: disk full/);
    assert.match(log.join("\n"), /@t\/arch-missing archive hook failed for s_a1: .*does not export a function named "nothere"/);
    const list = (await call("/api/sessions")).body as unknown as { id: string; archivedAt?: string }[];
    assert.equal(list[0].archivedAt, at, "the list carries the time");
    const again = await call("/api/sessions/s_a1/archive", { archived: true });
    assert.equal(again.body.archivedAt, at, "a second archive keeps the first time");
    await until(() => g.hookCalls.length === 2);
    g.hookCalls = [];
    const restored = await call("/api/sessions/s_a1/archive", { archived: false });
    assert.deepEqual(restored.body, { id: "s_a1", archived: false, archivedAt: null });
    await until(() => g.hookCalls.length === 1);
    assert.deepEqual(g.hookCalls[0].arg, { session: "s_a1", archived: false, archivedAt: null }, "restore is told too");
    assert.equal(((await call("/api/sessions")).body as unknown as { archivedAt?: string }[])[0].archivedAt, undefined);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The conversation most forget tests use: a root with three turns, a child, a grandchild and a second child, two attachments among them. */
function family(running = false): Rec[] {
  return [
    { id: "s_a0", turns: 3, running, conversation: [{ role: "user", content: [{ type: "text", data: { text: "hello" } }, asset(A1)] }] },
    { id: "s_c1", parent: "s_a0", turns: 1, conversation: [{ role: "tool", content: [asset(A2)] }] },
    { id: "s_dd", parent: "s_c1", turns: 1, conversation: [{ role: "user", content: [asset(A1)] }] },
    { id: "s_c2", parent: "s_a0", turns: 1 },
  ];
}

/** A forget hook package: it previews one optional and one fixed item, blocks when `hookBlock` is set, and fails its forget when `hookFail` is. */
function lessons() {
  return pkg(
    "@t/lessons",
    { forget: "forgetSession" },
    recorder(
      "@t/lessons",
      "forgetSession",
      `(arg) => arg.phase === "preview"
        ? { items: [{ id: "lessons", label: "2 lessons came from this conversation", optional: true, default: true }, { id: "reflection", label: "its reflection" }], ...(globalThis.hookBlock ? { block: globalThis.hookBlock } : {}) }
        : (() => { if (globalThis.hookFail) throw new Error(globalThis.hookFail); return { removed: arg.options.lessons ? ["2 lessons", "its reflection"] : ["its reflection"], kept: arg.options.lessons ? [] : ["2 lessons stay"] }; })()`,
    ),
  );
}

test("preview: the title, turns, subtree root first, running, attachments counted once, each hook's items, and what always stays; a subagent is refused", async () => {
  g.hookCalls = [];
  g.hookBlock = undefined;
  const quiet = pkg("@t/quiet", { forget: "f" }, `export async function f() { return {}; }`);
  const broken = pkg("@t/broken", { forget: "f" }, `export async function f() { throw new Error("no index"); }`);
  const { kernel, deleted } = fakeKernel(family(), [lessons(), quiet, broken]);
  const dir = mkdtempSync(join(tmpdir(), "gw-store-"));
  const { call, close } = await serve(kernel, dir);
  try {
    const { status, body } = await call("/api/sessions/s_a0/forget/preview", {});
    assert.equal(status, 200);
    assert.deepEqual(body, {
      id: "s_a0",
      title: "first words of s_a0",
      turns: 3,
      subtree: ["s_a0", "s_c1", "s_dd", "s_c2"],
      running: false,
      attachments: 2,
      hooks: [{ package: "@t/lessons", items: [{ id: "lessons", label: "2 lessons came from this conversation", optional: true, default: true }, { id: "reflection", label: "its reflection" }] }],
      kept: ["@t/broken could not say what it would remove: no index", ...ALWAYS_KEPT],
    });
    assert.deepEqual(g.hookCalls[0].arg, { phase: "preview", session: "s_a0", sessions: ["s_a0", "s_c1", "s_dd", "s_c2"], options: {} });
    assert.deepEqual(g.hookCalls[0].env.session, { id: "s_a0", user: "alice" });
    assert.ok(invoked.includes("@t/lessons forgetSession @t/lessons#sessions.forget"));
    const child = await call("/api/sessions/s_c1/forget/preview", {});
    assert.equal(child.status, 409);
    assert.equal(child.body.error, "forget its parent conversation; a subagent goes with it");
    assert.deepEqual(deleted, [], "a preview changes nothing");
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget refuses, changing nothing: a subagent, a wrong or missing title, a blocking hook, and a running turn without stop", async () => {
  g.hookCalls = [];
  g.hookBlock = undefined;
  const recs = family(true);
  const { kernel, deleted, cancelled } = fakeKernel(recs, [lessons()]);
  const dir = mkdtempSync(join(tmpdir(), "gw-store-"));
  const { call, close } = await serve(kernel, dir);
  try {
    const child = await call("/api/sessions/s_c1/forget", { confirm: "first words of s_c1" });
    assert.deepEqual([child.status, child.body.error], [409, "forget its parent conversation; a subagent goes with it"]);
    const wrong = await call("/api/sessions/s_a0/forget", { confirm: "first words" });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error!, /title/);
    assert.equal((await call("/api/sessions/s_a0/forget", { confirm: "" })).status, 400, "three turns: the title must be typed");
    g.hookBlock = "a workflow run that uses it is still active";
    const blocked = await call("/api/sessions/s_a0/forget", { confirm: "  first words of s_a0 " });
    assert.deepEqual([blocked.status, blocked.body.error], [409, "a workflow run that uses it is still active"]);
    g.hookBlock = undefined;
    const running = await call("/api/sessions/s_a0/forget", { confirm: "first words of s_a0" });
    assert.equal(running.status, 409);
    assert.match(running.body.error!, /a turn is running/);
    assert.deepEqual(deleted, []);
    assert.deepEqual(cancelled, []);
    assert.ok(g.hookCalls.every((c) => c.arg.phase === "preview"), "no hook was asked to forget");
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget with stop: the running turn is cancelled and waited for, then everything goes deepest first, and the receipt says what went and what stayed", async () => {
  g.hookCalls = [];
  g.hookBlock = undefined;
  g.hookFail = undefined;
  const { kernel, deleted, cancelled, removed } = fakeKernel(family(true), [lessons()]);
  const dir = mkdtempSync(join(tmpdir(), "gw-store-"));
  const { call, close, store } = await serve(kernel, dir);
  try {
    store.setTitle("alice", "s_a0", "Trip plans");
    store.setArchived("alice", "s_a0", true);
    store.setUsage("alice", "s_c1", { 1: { cost: 0.5 } });
    store.setModel("alice", "s_other", "echo");
    const { status, body } = await call("/api/sessions/s_a0/forget", { confirm: "Trip plans", stop: true, options: { "@t/lessons": { lessons: false } } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(cancelled, ["s_a0"]);
    assert.deepEqual(deleted, ["s_dd", "s_c2", "s_c1", "s_a0"], "deepest first, the root last");
    assert.deepEqual(removed, [A1, A2], "each attachment once");
    const forget = g.hookCalls.find((c) => c.arg.phase === "forget")!;
    assert.deepEqual(forget.arg, { phase: "forget", session: "s_a0", sessions: ["s_a0", "s_c1", "s_dd", "s_c2"], options: { lessons: false } }, "the dialog's choice over the item's default");
    assert.deepEqual(body, {
      id: "s_a0",
      removed: ["the conversation and 3 subagent conversations", "2 attachments", "titles, model choice and usage the page kept", "its reflection"],
      kept: ["2 lessons stay", ...ALWAYS_KEPT],
    });
    assert.equal(store.title("alice", "s_a0"), undefined);
    assert.equal(store.archived("alice").size, 0);
    assert.deepEqual(store.usage("alice", "s_c1"), {});
    assert.equal(store.model("alice", "s_other"), "echo", "another conversation's marks stay");
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forget goes on past a failing hook and a server without attachment removal, and says both in kept; an optional item takes its default", async () => {
  g.hookCalls = [];
  g.hookBlock = undefined;
  g.hookFail = "the index is locked";
  const { kernel, deleted } = fakeKernel(family(), [lessons()], { remove: false });
  const dir = mkdtempSync(join(tmpdir(), "gw-store-"));
  const { call, close } = await serve(kernel, dir);
  try {
    const { status, body } = await call("/api/sessions/s_a0/forget", { confirm: "first words of s_a0" });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(g.hookCalls.find((c) => c.arg.phase === "forget")!.arg.options, { lessons: true }, "nothing chosen: the default");
    assert.deepEqual(deleted, ["s_dd", "s_c2", "s_c1", "s_a0"]);
    assert.deepEqual(body.removed, ["the conversation and 3 subagent conversations", "titles, model choice and usage the page kept"]);
    assert.deepEqual(body.kept, ["@t/lessons could not remove its part: the index is locked", "2 attachments stay until the server restarts with attachment removal.", ...ALWAYS_KEPT]);
  } finally {
    g.hookFail = undefined;
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an rpc that does not know assets.remove stops at the first try; another refusal is counted; under three turns no title is needed", async () => {
  const unknown = fakeKernel([{ id: "s_e1", turns: 2, conversation: [{ role: "user", content: [asset(A1), asset(A2)] }] }], [], {
    remove: async () => {
      throw Object.assign(new Error("unknown kernel method: assets.remove"), { code: "rpc" });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "gw-store-"));
  let served = await serve(unknown.kernel, dir);
  try {
    const { status, body } = await served.call("/api/sessions/s_e1/forget", { confirm: "" });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body, { id: "s_e1", removed: ["the conversation", "titles, model choice and usage the page kept"], kept: ["2 attachments stay until the server restarts with attachment removal.", ...ALWAYS_KEPT] });
  } finally {
    await served.close();
  }
  let tries = 0;
  const refusing = fakeKernel([{ id: "s_f1", turns: 0, conversation: [{ role: "user", content: [asset(A1), asset(A2)] }] }], [], {
    remove: async (id) => {
      tries += 1;
      if (id === A1) return { id, removed: true };
      throw new Error("invalid asset id");
    },
  });
  served = await serve(refusing.kernel, dir);
  try {
    const { body } = await served.call("/api/sessions/s_f1/forget", {});
    assert.equal(tries, 2);
    assert.deepEqual(body.removed, ["the conversation", "1 attachment", "titles, model choice and usage the page kept"]);
    assert.deepEqual(body.kept, ["1 attachment could not be removed: invalid asset id", ...ALWAYS_KEPT]);
  } finally {
    await served.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

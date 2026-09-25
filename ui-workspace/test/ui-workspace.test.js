// The server half over a temp home, a shared directory and two mounts (one rw, one ro), with a project
// whose directories are one under the rw mount and one nowhere. THETIS_MOUNTS is set before the package
// is imported, because tools-files reads it once at import. Then the browser files: every `ui/*.js`
// parses, and `ui/index.js` exports only `default`, when the other agents have put them there.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const temp = (tag) => realpathSync(mkdtempSync(join(tmpdir(), `ws-${tag}-`)));
const home = temp("home");
const shared = temp("shared");
const mountRw = temp("rw");
const mountRo = temp("ro");
const proj = join(mountRw, "proj");
const PROJECT = "p_0a1b2c3d";
const SESSION = "s_0011";

process.env.THETIS_MOUNTS = JSON.stringify([{ path: mountRw, mode: "rw" }, { path: mountRo, mode: "ro" }]);
const ws = await import("../index.js");
const filesLib = await import("../lib/files.js");
const zipLib = await import("../lib/zip.js");
const languageLib = await import("../lib/language.js");

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

before(() => {
  put(join(home, "notes.md"), "# Hi\n\nsome notes\n");
  put(join(home, "a.txt"), "alpha\n");
  put(join(home, "café.txt"), "coffee\n");
  put(join(home, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  put(join(home, "src", "index.js"), "export const x = 1;\n");
  put(join(home, "src", "util.js"), "export const y = 2;\n");
  put(join(home, ".hidden"), "h\n");
  mkdirSync(join(home, "empty"));
  symlinkSync(join(home, "src"), join(home, "link-to-src"));
  put(join(home, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
  put(join(home, "repo", "file.txt"), "tracked\n");
  put(join(home, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
  put(join(home, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>\n");
  put(join(home, "page.html"), "<p>hi</p>\n");
  put(join(home, "odd.xyz"), Buffer.from([0, 1, 2]));
  put(join(home, "projects", `${PROJECT}.json`), JSON.stringify({ id: PROJECT, name: "Nova", directories: [proj, "/nowhere/unmounted"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
  put(join(home, "projects", "sessions.json"), JSON.stringify({ [SESSION]: PROJECT }));
  put(join(shared, "readme.txt"), "shared\n");
  put(join(proj, "hello.txt"), "hello from the project\n");
  put(join(proj, "sub", "x.txt"), "x".repeat(3000));
  mkdirSync(join(proj, "sub", "void"));
  put(join(proj, "node_modules", "m", "i.js"), "module\n");
  put(join(proj, ".git", "HEAD"), "ref\n");
  put(join(mountRo, "ro.txt"), "read only\n");
  mkdirSync(join(home, "many"));
  for (let i = 0; i < 505; i++) writeFileSync(join(home, "many", `f${String(i).padStart(3, "0")}.txt`), "");
});

after(() => {
  for (const d of [home, shared, mountRw, mountRo]) rmSync(d, { recursive: true, force: true });
});

/** The env a command runs with, as the gateway builds it: the fence's, plus who asked and which conversation. */
function fakeEnv({ role = "user", user = "alice", session = SESSION, answers = {} } = {}) {
  const calls = [];
  const env = {
    user,
    role,
    cwd: home,
    shared,
    ...(session ? { session } : {}),
    readFile: (p) => readFile(resolve(home, p), "utf8"),
    writeFile: async (p, text) => put(resolve(home, p), text),
    kernel: {
      operator: {
        call: async (method, a) => {
          calls.push({ method, args: a });
          return typeof answers[method] === "function" ? answers[method](a) : (answers[method] ?? null);
        },
      },
    },
  };
  return { env, calls };
}

const data = async (p) => (await p).data;
const rejects = (p, re) => assert.rejects(p, (e) => (assert.match(e.message, re), true));

async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

// ---- manifest ----

test("manifest: ids, orders, labels and every declared export exist", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.thetis.type, "ui");
  const ui = pkg.thetis.ui;
  assert.deepEqual([ui.dir, ui.entry, ui.style], ["ui", "index.js", "index.css"]);
  const ID = /^[a-z][a-z0-9_-]{0,31}$/;
  for (const e of [...ui.places, ...ui.dock]) {
    assert.match(e.id, ID);
    assert.ok(e.label.length <= 80 && e.hint.length <= 200 && e.icon.length <= 4096);
    assert.equal(typeof e.order, "number");
  }
  assert.deepEqual(ui.places.map((p) => [p.id, p.order]), [["workspace", 30]]);
  assert.deepEqual(ui.dock.map((p) => [p.id, p.order]), [["files", 105]], "after the docks that default to 100, before Skills at 110");
  const verbs = ui.commands.map((c) => c.verb);
  assert.deepEqual(verbs, ["roots", "list", "stat", "read", "write", "mkdir", "rename", "delete", "count", "resolve", "bind"]);
  for (const c of ui.commands) {
    assert.match(c.verb, ID);
    assert.ok(c.label && c.label.length <= 80, c.verb);
    assert.equal(typeof ws[c.export], "function", `export ${c.export}`);
  }
  assert.equal(ui.commands.find((c) => c.verb === "bind").role, "admin");
  assert.equal(ui.commands.find((c) => c.verb === "delete").export, "del");
  for (const v of ["upload", "raw", "zip"]) assert.ok(!verbs.includes(v) && typeof ws[v] === "function");
  assert.deepEqual([ws.INLINE_LIMIT, ws.WRITE_INLINE_LIMIT, ws.MAX_UPLOAD], [200_000, 800_000, 64 * 1024 * 1024]);
});

// ---- roots ----

test("roots: home, shared, mounts, and the project directories with their states", async () => {
  const { env, calls } = fakeEnv();
  const r = await data(ws.roots({ session: SESSION }, env));
  assert.deepEqual(r.home, { path: home, mode: "rw" });
  assert.deepEqual(r.shared, { path: shared, mode: "ro" });
  assert.deepEqual(r.mounts, [{ path: mountRw, mode: "rw" }, { path: mountRo, mode: "ro" }]);
  assert.equal(r.user, "alice");
  assert.equal(r.admin, false);
  assert.equal(r.bound, undefined);
  assert.equal(r.projects.length, 1);
  const p = r.projects[0];
  assert.equal(p.id, PROJECT);
  assert.equal(p.name, "Nova");
  assert.equal(p.current, true);
  assert.deepEqual(p.summary, { ready: 1, broken: 1 });
  const [ready, gone] = p.directories;
  assert.deepEqual(ready, { path: proj, name: "proj", parent: mountRw, state: "ready", mode: "rw", kind: "dir" });
  assert.deepEqual(gone, { path: "/nowhere/unmounted", name: "unmounted", parent: "/nowhere", state: "unmounted", mode: null, kind: "none" });
  assert.equal(calls.length, 0, "a user asks the operator nothing");
});

test("roots: no session means no current project; env.session is the fallback", async () => {
  const { env } = fakeEnv({ session: null });
  assert.equal((await data(ws.roots({}, env))).projects[0].current, false);
  const { env: withSession } = fakeEnv();
  assert.equal((await data(ws.roots({}, withSession))).projects[0].current, true);
});

test("roots: an admin gets the bound list and a written-down mount the fence did not take is skipped", async () => {
  const { env, calls } = fakeEnv({ role: "admin", answers: { "host.grants.mountsList": { alice: [{ path: "/nowhere/unmounted", mode: "ro" }] } } });
  const r = await data(ws.roots({}, env));
  assert.equal(r.admin, true);
  assert.deepEqual(calls.map((c) => c.method), ["host.grants.mountsList"]);
  assert.deepEqual(r.bound, [{ path: "/nowhere/unmounted", mode: "ro" }]);
  const gone = r.projects[0].directories[1];
  assert.equal(gone.state, "skipped");
  assert.equal(gone.mount, "/nowhere/unmounted");
});

// ---- list ----

test("list: directories first, then files, dotfiles only on request, symlinks with their target", async () => {
  const { env } = fakeEnv();
  const r = await data(ws.list({ path: home }, env));
  assert.equal(r.path, home);
  assert.equal(r.root, "home");
  assert.equal(r.mode, "rw");
  assert.equal(r.more, false);
  const names = r.entries.map((e) => e.name);
  assert.ok(!names.includes(".hidden"));
  assert.ok(!names.includes("projects") === false, "projects is a plain directory and listed");
  const dirs = r.entries.filter((e) => e.kind === "dir").map((e) => e.name);
  assert.deepEqual(dirs, ["empty", "many", "projects", "repo", "src"]);
  assert.equal(r.entries.findIndex((e) => e.kind !== "dir"), dirs.length, "every directory comes before the first file");
  const link = r.entries.find((e) => e.name === "link-to-src");
  assert.equal(link.kind, "symlink");
  assert.equal(link.target, "dir");
  const notes = r.entries.find((e) => e.name === "notes.md");
  assert.equal(notes.kind, "file");
  assert.equal(notes.size, 17);
  assert.equal(notes.hidden, false);
  assert.match(notes.mtime, /^\d{4}-\d{2}-\d{2}T/);
  const withHidden = await data(ws.list({ path: home, hidden: true }, env));
  const hidden = withHidden.entries.find((e) => e.name === ".hidden");
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.kind, "file");
});

test("list: 500 entries then more, a file refused, a ro mount says ro", async () => {
  const { env } = fakeEnv();
  const many = await data(ws.list({ path: join(home, "many") }, env));
  assert.equal(many.entries.length, 500);
  assert.equal(many.more, true);
  assert.equal(many.entries[0].name, "f000.txt");
  await rejects(ws.list({ path: join(home, "a.txt") }, env), /is not a directory\.$/);
  await rejects(ws.list({ path: join(home, "nope") }, env), /does not exist\.$/);
  const ro = await data(ws.list({ path: mountRo }, env));
  assert.equal(ro.mode, "ro");
  assert.equal(ro.root, "mount");
});

// ---- stat ----

test("stat: the facts, the etag shape, language and preview, binary sniff", async () => {
  const { env } = fakeEnv();
  const md = await data(ws.stat({ path: join(home, "notes.md") }, env));
  assert.equal(md.path, join(home, "notes.md"));
  assert.equal(md.display, "notes.md");
  assert.deepEqual([md.root, md.mode, md.writable, md.kind], ["home", "rw", true, "file"]);
  assert.match(md.etag, /^\d+-17$/);
  assert.deepEqual([md.language, md.preview, md.tooLarge, md.binary], ["md", "markdown", false, false]);
  const bin = await data(ws.stat({ path: join(home, "bin.dat") }, env));
  assert.deepEqual([bin.language, bin.preview, bin.binary], [null, "none", false]);
  const odd = await data(ws.stat({ path: join(home, "odd.xyz") }, env));
  assert.deepEqual([odd.language, odd.preview, odd.binary], [null, "none", true]);
  const dir = await data(ws.stat({ path: join(home, "src") }, env));
  assert.deepEqual([dir.kind, dir.preview, dir.language], ["dir", "none", null]);
  const ro = await data(ws.stat({ path: join(mountRo, "ro.txt") }, env));
  assert.deepEqual([ro.root, ro.mode, ro.writable, ro.display], ["mount", "ro", false, join(mountRo, "ro.txt")]);
  assert.deepEqual(ro.mount, { path: mountRo, mode: "ro" }, "a file on a mount names its mount root, for Copy to Home");
  const sh = await data(ws.stat({ path: join(shared, "readme.txt") }, env));
  assert.deepEqual([sh.root, sh.mode, sh.writable], ["shared", "ro", false]);
  assert.equal(sh.mount, undefined);
  assert.equal(md.mount, undefined);
});

test("stat: outside and missing paths are sentences from tools-files", async () => {
  const { env } = fakeEnv();
  await rejects(ws.stat({ path: "/etc/passwd" }, env), /^\/etc\/passwd is outside the spaces you can reach \(home rw, shared ro, /);
  await rejects(ws.stat({ path: join(home, "missing.txt") }, env), /^missing\.txt does not exist\.$/);
  await rejects(ws.stat({}, env), /path is required/);
});

test("language: the table covers the contract's languages and previews", () => {
  assert.deepEqual(languageLib.kindOf("x.ts").language, "ts");
  for (const [name, language, preview] of [["a.js", "js", "text"], ["a.jsx", "jsx", "text"], ["a.tsx", "tsx", "text"], ["a.json", "json", "text"], ["a.md", "md", "markdown"], ["a.html", "html", "text"], ["a.css", "css", "text"], ["a.py", "py", "text"], ["a.sh", "sh", "text"], ["a.toml", "toml", "text"], ["a.yml", "yaml", "text"], ["Makefile", "plain", "text"], ["a.png", null, "image"], ["a.svg", "html", "svg"], ["a.pdf", null, "pdf"], ["a.mp3", null, "audio"], ["a.zip", null, "none"], ["weird.qqq", "plain", "text"], [".bashrc", "sh", "text"]]) {
    assert.deepEqual([languageLib.languageOf(name), languageLib.previewOf(name)], [language, preview], name);
  }
  assert.equal(languageLib.contentTypeOf("a.md"), "text/markdown; charset=utf-8");
  assert.equal(languageLib.contentTypeOf("a.png"), "image/png");
  assert.equal(languageLib.contentTypeOf("a.unknownbinaryext"), "text/plain; charset=utf-8");
});

// ---- read ----

test("read: inline at exactly 200 000 bytes, not one over; binary and directories refused", async () => {
  const { env } = fakeEnv();
  put(join(home, "edge.txt"), "e".repeat(ws.INLINE_LIMIT));
  put(join(home, "over.txt"), "o".repeat(ws.INLINE_LIMIT + 1));
  const edge = await data(ws.read({ path: join(home, "edge.txt") }, env));
  assert.equal(edge.inline, true);
  assert.equal(edge.text.length, ws.INLINE_LIMIT);
  assert.deepEqual([edge.truncated, edge.part, edge.language, edge.size], [false, null, "plain", ws.INLINE_LIMIT]);
  assert.match(edge.etag, /^\d+-200000$/);
  const over = await data(ws.read({ path: join(home, "over.txt") }, env));
  assert.equal(over.inline, false);
  assert.equal("text" in over, false);
  assert.equal(over.truncated, false);
  await rejects(ws.read({ path: join(home, "bin.dat") }, env), /is not a text file/);
  await rejects(ws.read({ path: join(home, "odd.xyz") }, env), /looks like a binary file/);
  await rejects(ws.read({ path: join(home, "src") }, env), /is a directory/);
  const md = await data(ws.read({ path: join(home, "notes.md") }, env));
  assert.equal(md.text, "# Hi\n\nsome notes\n");
});

test("read: a tooLarge file says truncated and which part", async () => {
  const { env } = fakeEnv();
  const big = Buffer.alloc(ws.MAX_TEXT + 10, 0x61);
  big.fill(0x7a, ws.MAX_TEXT); // the tail ends in z
  put(join(home, "big.log"), big);
  const head = await data(ws.read({ path: join(home, "big.log") }, env));
  assert.deepEqual([head.inline, head.truncated, head.part], [false, true, "head"]);
  const tail = await data(ws.read({ path: join(home, "big.log"), part: "tail" }, env));
  assert.equal(tail.part, "tail");
});

// ---- write ----

test("write: creates, answers the etag, and reports a conflict with what is there now", async () => {
  const { env } = fakeEnv();
  const path = join(home, "new", "file.txt");
  const first = await data(ws.write({ path, text: "one\n" }, env));
  assert.equal(first.ok, true);
  assert.equal(first.path, path, "the answer names the file by its absolute path");
  assert.match(first.etag, /^\d+-4$/);
  // A relative path resolves against home (the Copy to Home target), and the answer names where it landed.
  const copied = await data(ws.write({ path: "shared/policy.txt", text: "copy\n" }, env));
  assert.equal(copied.ok, true);
  assert.equal(copied.path, join(home, "shared", "policy.txt"));
  assert.equal(readFileSync(copied.path, "utf8"), "copy\n");
  assert.equal(first.size, 4);
  assert.equal(readFileSync(path, "utf8"), "one\n");
  const stale = "1-1";
  const conflict = await data(ws.write({ path, text: "two\n", etag: stale }, env));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.current.etag, first.etag);
  assert.equal(conflict.current.text, "one\n");
  assert.equal(readFileSync(path, "utf8"), "one\n", "a conflict writes nothing");
  const forced = await data(ws.write({ path, text: "two\n", etag: stale, force: true }, env));
  assert.equal(forced.ok, true);
  assert.equal(readFileSync(path, "utf8"), "two\n");
  const matching = await data(ws.write({ path, text: "three\n", etag: forced.etag }, env));
  assert.equal(matching.ok, true);
  assert.equal(readFileSync(path, "utf8"), "three\n");
  assert.deepEqual(readdirSync(join(home, "new")), ["file.txt"], "no tmp file is left behind");
});

test("write: refusals in the right words", async () => {
  const { env } = fakeEnv();
  const ro = join(mountRo, "ro.txt");
  await rejects(ws.write({ path: ro, text: "x" }, env), new RegExp(`^${ro.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is read-only \\(mount ${mountRo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\); writes need a path under home`));
  const sh = join(shared, "readme.txt");
  await rejects(ws.write({ path: sh, text: "x" }, env), /is read-only \(shared\)/);
  await rejects(ws.write({ path: join(home, "repo", ".git", "config"), text: "x" }, env), /names a \.git path, which is protected from write and delete\.$/);
  await rejects(ws.write({ path: join(home, "huge.txt"), text: "h".repeat(ws.WRITE_INLINE_LIMIT + 1) }, env), /over the 800000-byte limit of a write; upload the file instead\.$/);
  await rejects(ws.write({ path: join(home, "src"), text: "x" }, env), /is a directory, not a file\.$/);
  await rejects(ws.write({ path: join(home, "x.txt") }, env), /needs text/);
  await rejects(ws.write({ path: "/etc/x", text: "x" }, env), /is outside the spaces you can reach/);
});

test("write: exactly 800 000 bytes is still a write", async () => {
  const { env } = fakeEnv();
  const r = await data(ws.write({ path: join(home, "limit.txt"), text: "l".repeat(ws.WRITE_INLINE_LIMIT) }, env));
  assert.equal(r.size, ws.WRITE_INLINE_LIMIT);
});

// ---- mkdir, rename ----

test("mkdir: makes parents, refuses what exists and the read-only spaces", async () => {
  const { env } = fakeEnv();
  const r = await data(ws.mkdir({ path: join(home, "deep", "er", "dir") }, env));
  assert.equal(r.path, join(home, "deep", "er", "dir"));
  assert.ok(existsSync(r.path));
  await rejects(ws.mkdir({ path: join(home, "src") }, env), /already exists\.$/);
  await rejects(ws.mkdir({ path: join(home, "a.txt") }, env), /already exists and is not a directory\.$/);
  await rejects(ws.mkdir({ path: join(mountRo, "d") }, env), /is read-only/);
  const inMount = await data(ws.mkdir({ path: join(proj, "made") }, env));
  assert.ok(existsSync(inMount.path));
});

test("rename: same directory only, never over something, never a root", async () => {
  const { env } = fakeEnv();
  put(join(home, "old.txt"), "o\n");
  const r = await data(ws.rename({ path: join(home, "old.txt"), name: "renamed.txt" }, env));
  assert.equal(r.path, join(home, "renamed.txt"));
  assert.ok(existsSync(r.path) && !existsSync(join(home, "old.txt")));
  await rejects(ws.rename({ path: r.path, name: "sub/renamed.txt" }, env), /contains a slash\.$/);
  await rejects(ws.rename({ path: r.path, name: ".." }, env), /cannot be \.\.\.$/);
  await rejects(ws.rename({ path: r.path, name: "" }, env), /is required\.$/);
  await rejects(ws.rename({ path: r.path, name: "a.txt" }, env), /already exists in/);
  await rejects(ws.rename({ path: r.path, name: ".git" }, env), /names a \.git path/);
  await rejects(ws.rename({ path: home, name: "x" }, env), /is a root of your workspace and cannot be renamed\.$/);
  await rejects(ws.rename({ path: join(mountRo, "ro.txt"), name: "x" }, env), /is read-only/);
  await rejects(ws.rename({ path: join(home, "gone.txt"), name: "x" }, env), /does not exist\.$/);
  const same = await data(ws.rename({ path: r.path, name: "renamed.txt" }, env));
  assert.equal(same.path, r.path);
});

// ---- delete, count ----

test("delete: dryRun counts, the real thing removes, and the refusals", async () => {
  const { env } = fakeEnv();
  put(join(home, "tree", "a.txt"), "aa");
  put(join(home, "tree", "d", "b.txt"), "bbb");
  const dry = await data(ws.del({ path: join(home, "tree"), dryRun: true }, env));
  assert.deepEqual(dry, { files: 2, dirs: 1, bytes: 5, capped: false });
  assert.ok(existsSync(join(home, "tree", "d", "b.txt")), "a dry run deletes nothing");
  const real = await data(ws.del({ path: join(home, "tree") }, env));
  assert.deepEqual(real, { removed: { files: 2, dirs: 1 } });
  assert.ok(!existsSync(join(home, "tree")));
  put(join(home, "one.txt"), "1");
  assert.deepEqual(await data(ws.del({ path: join(home, "one.txt") }, env)), { removed: { files: 1, dirs: 0 } });
  await rejects(ws.del({ path: home }, env), /is a root of your workspace/);
  await rejects(ws.del({ path: mountRw }, env), /is a root of your workspace/);
  await rejects(ws.del({ path: join(home, "repo") }, env), /names a \.git path, which is protected from write and delete\.$/);
  await rejects(ws.del({ path: join(home, "repo", ".git") }, env), /names a \.git path/);
  assert.ok(existsSync(join(home, "repo", "file.txt")), "the whole delete was refused");
  await rejects(ws.del({ path: join(shared, "readme.txt") }, env), /is read-only \(shared\)/);
  await rejects(ws.del({ path: join(mountRo, "ro.txt") }, env), /is read-only/);
  await rejects(ws.del({ path: join(home, "never") }, env), /does not exist\.$/);
});

test("count: totals, what a zip leaves out, and the caps", async () => {
  const { env } = fakeEnv();
  const c = await data(ws.count({ path: proj }, env));
  assert.equal(c.capped, false);
  assert.equal(c.files, 4, "hello, sub/x, node_modules/m/i.js, .git/HEAD");
  assert.equal(c.dirs, 6, "sub, sub/void, made, node_modules, node_modules/m, .git");
  assert.equal(c.bytes, 23 + 3000 + 7 + 4);
  assert.deepEqual(c.zip, { files: 2, dirs: 3, bytes: 3023 });
  assert.deepEqual(c.skipped, { files: 2, dirs: 3, bytes: 11 });
  const one = await data(ws.count({ path: join(home, "a.txt") }, env));
  assert.deepEqual([one.files, one.dirs, one.bytes], [1, 0, 6]);
  const capped = await filesLib.countTree(join(home, "many"), { maxEntries: 10 });
  assert.equal(capped.capped, true);
  const bytesCapped = await filesLib.countTree(proj, { maxBytes: 100 });
  assert.equal(bytesCapped.capped, true);
});

// ---- resolve ----

test("resolve: absolute, relative to home, relative to the project, and null for the rest", async () => {
  const { env } = fakeEnv();
  const given = [join(home, "a.txt"), "a.txt", "hello.txt", "sub/x.txt", "~/notes.md", "src", "no/such/file", "/etc/passwd", join(mountRo, "ro.txt"), "link-to-src"];
  const { results } = await data(ws.resolve({ paths: given, session: SESSION }, env));
  assert.deepEqual(results[join(home, "a.txt")], { absolute: join(home, "a.txt"), display: "a.txt", root: "home", mode: "rw", kind: "file" });
  assert.equal(results["a.txt"].absolute, join(home, "a.txt"));
  assert.equal(results["hello.txt"].absolute, join(proj, "hello.txt"));
  assert.equal(results["hello.txt"].root, "mount");
  assert.equal(results["sub/x.txt"].absolute, join(proj, "sub", "x.txt"));
  assert.equal(results["~/notes.md"].absolute, join(home, "notes.md"));
  assert.equal(results["src"].kind, "dir");
  assert.equal(results["no/such/file"], null);
  assert.equal(results["/etc/passwd"], null);
  assert.deepEqual(results[join(mountRo, "ro.txt")].mode, "ro");
  assert.equal(results["link-to-src"].kind, "dir", "a symlink resolves to what it points at");
  const noSession = await data(ws.resolve({ paths: ["hello.txt"] }, fakeEnv({ session: null }).env));
  assert.equal(noSession.results["hello.txt"], null, "without a project the relative path has only the home");
  const mixed = await data(ws.resolve({ paths: [42, "", "a.txt"] }, env));
  assert.deepEqual(Object.keys(mixed.results), ["", "a.txt"]);
  assert.equal(mixed.results[""], null);
  await rejects(ws.resolve({ paths: Array(65).fill("a.txt") }, env), /at most 64 paths/);
  assert.deepEqual(await data(ws.resolve({}, env)), { results: {} });
});

// ---- zip ----

test("zip: a real archive that unzip accepts, without .git and node_modules, with empty directories", async () => {
  const { env } = fakeEnv();
  const r = await ws.zip({ path: proj }, env);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/zip");
  assert.match(r.headers["content-disposition"], /^attachment; filename="proj\.zip"/);
  const buf = await collect(r.body);
  const central = zipLib.readCentralDirectory(buf);
  const names = central.map((e) => e.name);
  assert.deepEqual(names, ["proj/hello.txt", "proj/made/", "proj/sub/", "proj/sub/void/", "proj/sub/x.txt"]);
  const x = central.find((e) => e.name === "proj/sub/x.txt");
  assert.equal(x.usize, 3000);
  assert.ok(x.csize < 3000 && x.method === 8, "a run of x deflates");
  const out = join(home, "proj.zip");
  writeFileSync(out, buf);
  const unzip = spawnSync("unzip", ["-t", out], { encoding: "utf8" });
  if (unzip.error?.code === "ENOENT") return; // no unzip here; the central directory parse above stands
  assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
  assert.match(unzip.stdout, /No errors detected/);
  const listing = spawnSync("unzip", ["-l", out], { encoding: "utf8" }).stdout;
  assert.match(listing, /proj\/hello\.txt/);
  assert.doesNotMatch(listing, /node_modules|\.git/);
});

test("zip: one file, and the refusal over the caps names the numbers before any byte", async () => {
  const { env } = fakeEnv();
  const r = await ws.zip({ path: join(home, "notes.md") }, env);
  const central = zipLib.readCentralDirectory(await collect(r.body));
  assert.deepEqual(central.map((e) => [e.name, e.usize]), [["notes.md", 17]]);
  await rejects(zipLib.zipStream(proj, { maxEntries: 2 }), /is over what one zip may hold \(2 entries or \d+ bytes; the count stopped at/);
  await rejects(zipLib.zipStream(proj, { maxBytes: 100 }), /is over what one zip may hold/);
  await rejects(ws.zip({ path: join(home, "nope") }, env), /does not exist\.$/);
  const ro = await ws.zip({ path: mountRo }, env); // a read-only space zips like any other
  assert.deepEqual(zipLib.readCentralDirectory(await collect(ro.body)).map((e) => e.name), [`${basename(mountRo)}/ro.txt`]);
});

// ---- raw ----

test("raw: content types, dispositions, the etag, and the RFC 5987 file name", async () => {
  const { env } = fakeEnv();
  const md = await ws.raw({ path: join(home, "notes.md") }, env);
  assert.equal(md.status, 200);
  assert.equal(md.headers["content-type"], "text/markdown; charset=utf-8");
  assert.equal(md.headers["content-length"], "17");
  assert.equal(md.headers["content-disposition"], "inline; filename=\"notes.md\"; filename*=UTF-8''notes.md");
  assert.match(md.headers.etag, /^\d+-17$/);
  assert.equal(md.headers["cache-control"], "no-store");
  assert.equal((await collect(md.body)).toString(), "# Hi\n\nsome notes\n");
  const svg = await ws.raw({ path: join(home, "logo.svg") }, env);
  assert.equal(svg.headers["content-type"], "text/plain; charset=utf-8");
  assert.match(svg.headers["content-disposition"], /^inline;/);
  const svgDown = await ws.raw({ path: join(home, "logo.svg"), download: true }, env);
  assert.equal(svgDown.headers["content-type"], "image/svg+xml");
  assert.match(svgDown.headers["content-disposition"], /^attachment; filename="logo\.svg"/);
  const html = await ws.raw({ path: join(home, "page.html") }, env);
  assert.equal(html.headers["content-type"], "text/plain; charset=utf-8");
  const png = await ws.raw({ path: join(home, "pic.png") }, env);
  assert.equal(png.headers["content-type"], "image/png");
  assert.match(png.headers["content-disposition"], /^inline;/);
  const odd = await ws.raw({ path: join(home, "odd.xyz") }, env);
  assert.equal(odd.headers["content-type"], "application/octet-stream");
  assert.match(odd.headers["content-disposition"], /^attachment;/);
  const bin = await ws.raw({ path: join(home, "bin.dat") }, env);
  assert.equal(bin.headers["content-type"], "application/octet-stream");
  assert.match(bin.headers["content-disposition"], /^attachment;/);
  const cafe = await ws.raw({ path: join(home, "café.txt") }, env);
  assert.equal(cafe.headers["content-disposition"], "inline; filename=\"caf_.txt\"; filename*=UTF-8''caf%C3%A9.txt");
  await rejects(ws.raw({ path: join(home, "src") }, env), /is a directory; download it as a zip instead\.$/);
  await rejects(ws.raw({ path: "/etc/passwd" }, env), /is outside the spaces/);
});

test("raw: part windows a tooLarge text file to its first or last 4 MiB", async () => {
  const { env } = fakeEnv();
  const path = join(home, "big.log");
  const tail = await ws.raw({ path, part: "tail" }, env);
  assert.equal(tail.headers["content-length"], String(ws.MAX_TEXT));
  const bytes = await collect(tail.body);
  assert.equal(bytes.length, ws.MAX_TEXT);
  assert.equal(bytes[bytes.length - 1], 0x7a, "the window ends at the end of the file");
  assert.equal(bytes[0], 0x61);
  const head = await ws.raw({ path }, env);
  assert.equal(head.headers["content-length"], String(ws.MAX_TEXT));
  const headBytes = await collect(head.body);
  assert.equal(headBytes[headBytes.length - 1], 0x61);
  const whole = await ws.raw({ path: join(home, "a.txt"), part: "tail" }, env);
  assert.equal(whole.headers["content-length"], "6", "part means nothing for a file that fits");
});

// ---- upload ----

test("upload: a body under a single-segment name, exists unless replace, and the refusals", async () => {
  const { env } = fakeEnv();
  const body = Buffer.from("uploaded bytes\n");
  const r = await ws.upload({ dir: join(home, "src"), name: "up.txt" }, env, { body });
  assert.deepEqual([r.path, r.size, r.replaced], [join(home, "src", "up.txt"), 15, false]);
  assert.match(r.etag, /^\d+-15$/);
  assert.equal(readFileSync(r.path, "utf8"), "uploaded bytes\n");
  const again = await ws.upload({ dir: join(home, "src"), name: "up.txt" }, env, { body: Buffer.from("x") });
  assert.deepEqual(again, { exists: true, path: r.path });
  assert.equal(readFileSync(r.path, "utf8"), "uploaded bytes\n", "nothing was written");
  const replaced = await ws.upload({ dir: join(home, "src"), name: "up.txt", replace: true }, env, { body: Buffer.from("x") });
  assert.deepEqual([replaced.replaced, replaced.size], [true, 1]);
  await rejects(ws.upload({ dir: join(home, "src"), name: "a/b.txt" }, env, { body }), /contains a slash\.$/);
  await rejects(ws.upload({ dir: join(home, "src"), name: ".." }, env, { body }), /cannot be \.\.\.$/);
  await rejects(ws.upload({ dir: join(home, "src"), name: "." }, env, { body }), /cannot be \.\.$/);
  await rejects(ws.upload({ dir: join(home, "src"), name: "" }, env, { body }), /is required\.$/);
  await rejects(ws.upload({ dir: join(home, "src"), name: ".git" }, env, { body }), /names a \.git path/);
  await rejects(ws.upload({ dir: join(home, "src"), name: "x.txt" }, env, {}), /needs the file's bytes/);
  await rejects(ws.upload({ dir: mountRo, name: "x.txt" }, env, { body }), /is read-only/);
  await rejects(ws.upload({ dir: join(home, "a.txt"), name: "x.txt" }, env, { body }), /is not a directory\.$/);
  await rejects(ws.upload({ dir: join(home, "nowhere"), name: "x.txt" }, env, { body }), /does not exist\.$/);
  await rejects(ws.upload({ dir: home, name: "src" }, env, { body }), /is a directory in/);
  await rejects(ws.upload({ dir: home, name: "toobig.bin" }, env, { body: Buffer.alloc(ws.MAX_UPLOAD + 1) }), /over the 67108864-byte upload limit\.$/);
  assert.ok(!existsSync(join(home, "toobig.bin")));
  const exact = await ws.upload({ dir: home, name: "exact.bin" }, env, { body: Buffer.alloc(ws.MAX_UPLOAD) });
  assert.equal(exact.size, ws.MAX_UPLOAD);
  rmSync(exact.path);
});

// ---- bind ----

test("bind: refused below admin, delegated to projects' uiMount above", async () => {
  await rejects(ws.bind({ path: "/srv/x", mode: "rw" }, fakeEnv().env), /admin/);
  const { env, calls } = fakeEnv({ role: "admin", answers: { "host.grants.mountsList": { alice: [{ path: mountRw, mode: "rw", exists: true }] }, "host.grants.mountsSet": (a) => a.mounts.map((m) => ({ ...m, exists: true })) } });
  const r = await ws.bind({ path: "/srv/x", mode: "ro" }, env);
  assert.deepEqual(calls.map((c) => c.method), ["host.grants.mountsList", "host.grants.mountsSet"]);
  assert.deepEqual(calls[1].args, { user: "alice", mounts: [{ path: mountRw, mode: "rw" }, { path: "/srv/x", mode: "ro" }] });
  assert.deepEqual(r.data.mount, { path: "/srv/x", mode: "ro", exists: true });
  await rejects(ws.bind({ path: "relative", mode: "ro" }, env), /absolute path/);
});

// ---- browser files ----

test("ui/*.js parse and ui/index.js exports only default (when the browser half is there)", () => {
  const dir = join(ROOT, "ui");
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  for (const f of files) {
    const r = spawnSync(process.execPath, ["--check", join(dir, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  if (!files.includes("index.js")) return;
  const src = readFileSync(join(dir, "index.js"), "utf8");
  const exports = [...src.matchAll(/^export\s+(default|const|let|var|function|async function|class|\{|\*)/gm)].map((m) => m[1]);
  assert.deepEqual(exports, ["default"], "ui/index.js exports only default");
});

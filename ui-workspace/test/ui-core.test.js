/* The browser core of @thetis/ui-workspace, checked without a DOM: every ui module parses, the entry
 * exports only `default`, the file menu answers the right items for each host and mode, the explorer's
 * sentence table says what each `stateOf` word means, and the model's caches, tabs and storage guards
 * behave against a fake `ext`. Nothing here starts a browser or a daemon. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fileMenu, tidy, zipHint } from "../ui/file-menu.js";
import { ICONS, iconFor } from "../ui/icons.js";
import { STATE_SENTENCES, bindCommand, bindOutcome, directoryState, isRestartError, sentenceFor, summarySentence } from "../ui/explorer.js";
import { createModel, formatBytes, isUnscopedKey, isWithin, joinPath, nameOf, parentOf, rootOf, storageKey } from "../ui/model.js";
import { toastOnce } from "../ui/dialogs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI = join(ROOT, "ui");

// ---- the modules themselves ----

test("every ui module parses, and the entry exports only default", () => {
  const files = readdirSync(UI).filter((f) => f.endsWith(".js") && statSync(join(UI, f)).isFile());
  assert.ok(files.includes("index.js"));
  for (const file of files) {
    const out = spawnSync(process.execPath, ["--check", join(UI, file)], { encoding: "utf8" });
    assert.equal(out.status, 0, `${file}: ${out.stderr}`);
  }
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as m from ${JSON.stringify("file://" + join(UI, "index.js"))}; console.log(JSON.stringify(Object.keys(m)));`], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout.trim()), ["default"]);
});

test("the stylesheet imports the editor's and the dock's sheets first, and every rule is scoped", () => {
  const css = readFileSync(join(UI, "index.css"), "utf8");
  const imports = [...css.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["./editor.css", "./dock.css"]);
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.split("{")[0].trim()).filter((s) => s && !s.startsWith("@"));
  for (const selector of rules) {
    for (const part of selector.split(",")) {
      const s = part.trim();
      if (!s || s.startsWith("@") || s.match(/^\d+%$/) || s === "to" || s === "from") continue;
      assert.ok(s.includes(".ws-") || s.includes(".menu"), `unscoped selector: ${s}`);
    }
  }
});

test("the icons are 20x20 stroke paths, one table for every module", () => {
  const wanted = ["file", "folder", "home", "project", "upload", "download", "trash", "refresh", "collapse", "newfile", "newfolder", "lock", "more", "open", "back", "warn", "image", "link", "reveal"];
  for (const name of wanted) {
    assert.ok(Array.isArray(ICONS[name]) && ICONS[name].length > 0, `missing icon ${name}`);
    for (const d of ICONS[name]) assert.match(d, /^M[\d.\s-]/, `${name}: not a path`);
  }
  assert.ok(Object.isFrozen(ICONS));
  assert.equal(iconFor({ kind: "dir", name: "src" }), ICONS.folder);
  assert.equal(iconFor({ kind: "dir", name: "src" }, { open: true }), ICONS.folderOpen);
  assert.equal(iconFor({ kind: "file", name: "a.png" }), ICONS.image);
  assert.equal(iconFor({ kind: "file", name: "a.ts" }), ICONS.file);
});

// ---- the file menu ----

const every = () => ({
  open() {},
  reveal() {},
  newFile() {},
  newFolder() {},
  upload() {},
  download() {},
  copyPath() {},
  rename() {},
  remove() {},
  count: async () => ({ files: 3, bytes: 2048, capped: false }),
});
const labels = (items) => items.map((i) => (i === "-" ? "-" : i.label));

test("fileMenu: a rw file in the explorer offers download, copy, rename and delete, in that order", () => {
  const items = fileMenu({ path: "/home/a/x.ts", name: "x.ts", kind: "file", mode: "rw", root: "home" }, "explorer", every());
  assert.deepEqual(labels(items), ["Download", "Copy path", "Rename", "-", "Delete…"]);
  const del = items.at(-1);
  assert.equal(del.danger, true);
  assert.equal(del.key, "Del");
  assert.equal(items.find((i) => i.label === "Rename").key, "F2");
});

test("fileMenu: a read-only entry has no Rename and no Delete, and never a trailing separator", () => {
  const items = fileMenu({ path: "/shared/x.ts", name: "x.ts", kind: "file", mode: "ro", root: "shared" }, "explorer", every());
  assert.deepEqual(labels(items), ["Download", "Copy path"]);
  const dir = fileMenu({ path: "/shared/docs", name: "docs", kind: "dir", mode: "ro", root: "shared" }, "explorer", every());
  assert.deepEqual(labels(dir), ["Download as zip", "Copy path"]);
});

test("fileMenu: a rw folder in the explorer starts with New file (n), New folder and Upload", () => {
  const items = fileMenu({ path: "/home/a/src", name: "src", kind: "dir", mode: "rw", root: "home" }, "explorer", every());
  assert.deepEqual(labels(items), ["New file", "New folder", "Upload files here…", "-", "Download as zip", "Copy path", "Rename", "-", "Delete…"]);
  assert.equal(items[0].key, "n");
});

test("fileMenu: from the chat, Open in Workspace and Reveal in Files come first; the dock skips Reveal", () => {
  const entry = { path: "/home/a/x.ts", name: "x.ts", kind: "file", mode: "rw", root: "home" };
  assert.deepEqual(labels(fileMenu(entry, "chat", every())), ["Open in Workspace", "Reveal in Files", "-", "Download", "Copy path", "Rename", "-", "Delete…"]);
  assert.deepEqual(labels(fileMenu(entry, "dock", every())), ["Open in Workspace", "-", "Download", "Copy path", "Rename", "-", "Delete…"]);
  const dir = { ...entry, path: "/home/a/src", name: "src", kind: "dir" };
  assert.deepEqual(labels(fileMenu(dir, "dock", every())).slice(0, 5), ["Open in Workspace", "-", "New file", "New folder", "Upload files here…"]);
  // The chat never offers the folder-only items: they belong to a tree.
  assert.ok(!labels(fileMenu(dir, "chat", every())).includes("New file"));
});

test("fileMenu: a missing action leaves its item out, and the separators tidy up", () => {
  const entry = { path: "/home/a/x.ts", name: "x.ts", kind: "file", mode: "rw", root: "home" };
  assert.deepEqual(labels(fileMenu(entry, "chat", { open() {} })), ["Open in Workspace"]);
  assert.deepEqual(labels(fileMenu(entry, "explorer", { remove() {} })), ["Delete…"]);
  assert.deepEqual(labels(fileMenu(entry, "explorer", {})), []);
  assert.deepEqual(tidy(["-", "-", { label: "a" }, "-", "-", { label: "b" }, "-"]).map((i) => i.label ?? i), ["a", "-", "b"]);
});

test("fileMenu: each item runs its action with the entry, and the zip item fills its hint from count", async () => {
  const seen = [];
  const actions = { ...every(), download: (e) => seen.push(["download", e.path]), remove: (e) => seen.push(["remove", e.path]) };
  const entry = { path: "/home/a/src", name: "src", kind: "dir", mode: "rw", root: "home" };
  const items = fileMenu(entry, "explorer", actions);
  const zip = items.find((i) => i.label === "Download as zip");
  zip.run();
  items.find((i) => i.label === "Delete…").run();
  assert.deepEqual(seen, [["download", "/home/a/src"], ["remove", "/home/a/src"]]);
  assert.equal(zip.hint, "counting…");
  assert.equal(await zip.hintLater(), "3 files, 2 KB; .git and node_modules are skipped");
  assert.equal(zipHint({ files: 1, bytes: 10, capped: true }), "over 1 file, 10 B; .git and node_modules are skipped");
  // A file has no count to wait for.
  const file = fileMenu({ ...entry, kind: "file", name: "x" }, "explorer", actions).find((i) => i.label === "Download");
  assert.equal(file.hintLater, undefined);
});

// ---- the sentences under a directory row ----

test("the sentence table covers every broken stateOf word, and a ready directory says nothing", () => {
  assert.deepEqual(Object.keys(STATE_SENTENCES).sort(), ["empty-path", "not-a-directory", "skipped", "unmounted"]);
  assert.equal(sentenceFor({ state: "ready", path: "/srv/x" }), null);
  assert.equal(sentenceFor({ state: "bound", path: "/srv/x" }), null);
  assert.equal(sentenceFor(null), null);
  assert.equal(STATE_SENTENCES.unmounted.text, "Not mounted. An agent cannot read this directory.");
  assert.equal(STATE_SENTENCES.skipped.text, "Bound, but the host path is gone.");
  assert.equal(STATE_SENTENCES["empty-path"].text, "Reachable, but nothing is at this path.");
  assert.equal(STATE_SENTENCES["not-a-directory"].text, "Reachable, but this is a file, not a directory.");
});

test("unmounted: an admin gets the Bind, a member gets the command; the other states get neither", () => {
  const dir = { state: "unmounted", path: "/srv/repos/nova" };
  assert.deepEqual(sentenceFor(dir, { admin: true, user: "root" }), { tone: "err", text: "Not mounted. An agent cannot read this directory.", bind: "/srv/repos/nova", command: null });
  assert.deepEqual(sentenceFor(dir, { admin: false, user: "rae" }), { tone: "err", text: "Not mounted. An agent cannot read this directory.", bind: null, command: "thetis mounts add rae /srv/repos/nova" });
  assert.equal(bindCommand("", "/x"), "thetis mounts add <user> /x", "the CLI's mounts add, read-write by default");
  assert.equal(bindCommand("rae", "/x", "ro"), "thetis mounts add rae /x --ro");
  for (const state of ["skipped", "empty-path", "not-a-directory"]) {
    const s = sentenceFor({ state, path: "/x" }, { admin: true, user: "root" });
    assert.equal(s.bind, null, state);
    assert.equal(s.command, null, state);
  }
  assert.equal(sentenceFor({ state: "skipped", path: "/x" }).tone, "err");
  assert.equal(sentenceFor({ state: "empty-path", path: "/x" }).tone, "warn");
  assert.equal(sentenceFor({ state: "not-a-directory", path: "/x" }).tone, "warn");
  // A directory inside the person's own home needs no mount, so no bind is offered even when it is unmounted.
  assert.equal(sentenceFor({ state: "unmounted", path: "/x", home: true }, { admin: true }).bind, null);
});

test("bind: a 502 or a lost connection is the workspace restarting, a 400 with a sentence is a refusal", () => {
  assert.equal(isRestartError({ status: 502, message: "Bad Gateway" }), true);
  assert.equal(isRestartError({ status: 0, message: "Not connected." }), true);
  assert.equal(isRestartError(new Error("The workspace ended before it answered.")), true);
  assert.equal(isRestartError({ status: 400, message: "/x is outside your home." }), false);
  assert.equal(isRestartError(null), false);
  assert.deepEqual(bindOutcome("nova", "ready"), { text: "nova is bound.", tone: "ok" });
  assert.deepEqual(bindOutcome("nova", "bound"), { text: "nova is bound.", tone: "ok" });
  assert.deepEqual(bindOutcome("nova", "skipped"), { text: "nova: Bound, but the host path is gone.", tone: "error" });
  assert.deepEqual(bindOutcome("nova", "empty-path"), { text: "nova: Reachable, but nothing is at this path.", tone: "warn" });
  assert.equal(bindOutcome("nova", null).tone, "warn");
});

test("the project summary counts what an agent cannot read, in the project page's words", () => {
  assert.equal(summarySentence({ ready: 2, broken: 0 }, 2), null);
  assert.equal(summarySentence({ ready: 1, broken: 1 }, 2), "1 of 2 directories is not usable. An agent in this project cannot read it.");
  assert.equal(summarySentence({ ready: 0, broken: 2 }, 2), "2 of 2 directories are not usable. An agent in this project cannot read them.");
  assert.equal(summarySentence({ ready: 0, broken: 1 }, 1), "1 of 1 directory is not usable. An agent in this project cannot read it.");
  assert.equal(summarySentence(null), null);
});

// ---- the model's pure helpers ----

test("path helpers", () => {
  assert.equal(parentOf("/a/b/c"), "/a/b");
  assert.equal(parentOf("/a"), "/");
  assert.equal(parentOf("/"), null);
  assert.equal(parentOf("/a/b/"), "/a");
  assert.equal(nameOf("/a/b/c.txt"), "c.txt");
  assert.equal(nameOf("/a/b/"), "b");
  assert.equal(nameOf("/"), "/");
  assert.equal(joinPath("/a", "b"), "/a/b");
  assert.equal(joinPath("/", "b"), "/b");
  assert.equal(joinPath("/a/", "b"), "/a/b");
  assert.ok(isWithin("/a/b", "/a"));
  assert.ok(isWithin("/a", "/a"));
  assert.ok(!isWithin("/ab", "/a"));
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5 MB");
  assert.equal(formatBytes(-1), "");
});

const ROOTS = {
  user: "rae",
  admin: false,
  home: { path: "/home/rae", mode: "rw" },
  shared: { path: "/shared", mode: "ro" },
  projects: [
    { id: "p1", name: "Nova", current: true, directories: [{ path: "/srv/nova", name: "nova", parent: "/srv", state: "ready", mode: "rw", kind: "dir" }, { path: "/srv/gone", name: "gone", parent: "/srv", state: "unmounted", mode: null, kind: "none" }], summary: { ready: 1, broken: 1 } },
  ],
  mounts: [{ path: "/srv/nova", mode: "rw" }],
};

test("directoryState finds a project directory's state word by path", () => {
  assert.equal(directoryState(ROOTS, "/srv/nova"), "ready");
  assert.equal(directoryState(ROOTS, "/srv/gone"), "unmounted");
  assert.equal(directoryState(ROOTS, "/srv/other"), null);
  assert.equal(directoryState(null, "/srv/nova"), null);
});

test("rootOf picks the deepest root containing a path, and never a broken directory", () => {
  assert.equal(rootOf(ROOTS, "/home/rae/x.ts").kind, "home");
  assert.equal(rootOf(ROOTS, "/shared/a").mode, "ro");
  assert.equal(rootOf(ROOTS, "/srv/nova/src/a.ts").project.id, "p1");
  assert.equal(rootOf(ROOTS, "/srv/gone/x"), null);
  assert.equal(rootOf(ROOTS, "/etc/passwd"), null);
  assert.equal(rootOf({ ...ROOTS, shared: null }, "/shared/a"), null);
});

// ---- the model against a fake ext ----

function fakeExt({ answers = {}, raw = null } = {}) {
  const calls = [];
  return {
    calls,
    ext: {
      request: async (verb, { args, session } = {}) => {
        calls.push({ verb, args, session });
        const answer = answers[verb];
        if (answer instanceof Error) throw answer;
        return { data: typeof answer === "function" ? answer(args) : answer ?? {} };
      },
      raw: raw ?? undefined,
    },
  };
}

test("model: roots are cached per session until force, and each fresh answer is an event", async () => {
  const t = fakeExt({ answers: { roots: ROOTS } });
  const model = createModel(t.ext);
  const events = [];
  model.watch((e) => events.push(e.kind));
  assert.equal(model.rootsCached("s1"), null);
  const [a, b] = await Promise.all([model.roots({ session: "s1" }), model.roots({ session: "s1" })]);
  assert.equal(a, b);
  assert.equal(t.calls.length, 1, "in-flight reads are shared");
  assert.deepEqual(t.calls[0], { verb: "roots", args: { session: "s1" }, session: "s1" });
  await model.roots({ session: "s1" });
  assert.equal(t.calls.length, 1);
  assert.equal(model.rootsCached("s1"), a);
  await model.roots({ session: "s1", force: true });
  assert.equal(t.calls.length, 2);
  await model.roots({});
  assert.equal(t.calls.length, 3);
  assert.deepEqual(t.calls[2], { verb: "roots", args: {}, session: undefined });
  assert.deepEqual(events, ["roots", "roots", "roots"]);
});

test("model: listings are cached per dotfile setting, invalidated after a write in that folder", async () => {
  let n = 0;
  const t = fakeExt({ answers: { list: (args) => ({ path: args.path, entries: [{ name: `f${++n}`, kind: "file" }], more: false, hidden: Boolean(args.hidden) }), write: { ok: true, etag: "1-1" }, mkdir: (a) => ({ path: a.path }) } });
  const model = createModel(t.ext);
  const first = await model.list("/home/rae");
  assert.equal(await model.list("/home/rae"), first);
  assert.equal(model.listing("/home/rae"), first);
  assert.deepEqual(t.calls.at(-1).args, { path: "/home/rae" });
  model.setHidden(true);
  assert.equal(model.listing("/home/rae"), null, "the other dotfile setting is another listing");
  const withDots = await model.list("/home/rae");
  assert.deepEqual(t.calls.at(-1).args, { path: "/home/rae", hidden: true });
  assert.notEqual(withDots, first);
  model.setHidden(false);
  assert.equal(model.listing("/home/rae"), first, "the earlier listing is still there");
  await model.write("/home/rae/new.txt", "");
  assert.equal(model.listing("/home/rae"), null, "a write drops the parent's listing");
  await model.list("/home/rae");
  await model.mkdir("/home/rae/dir");
  assert.equal(model.listing("/home/rae"), null);
});

test("model: a write that lands elsewhere than asked (a relative Copy to Home target) drops every ancestor's listing up to the root", async () => {
  const t = fakeExt({ answers: { list: (args) => ({ path: args.path, entries: [], more: false }), write: (args) => ({ ok: true, path: `/home/rae/${args.path}`, etag: "1-1" }) } });
  const model = createModel(t.ext);
  for (const dir of ["/", "/home", "/home/rae", "/home/rae/src", "/srv"]) await model.list(dir);
  const dropped = [];
  model.watch((e) => e.kind === "list" && dropped.push(e.path));
  await model.write("shared/policy.txt", "copy");
  assert.deepEqual(dropped, ["shared", "/home/rae/shared", "/home/rae", "/home", "/"], "the relative parent, then each ancestor of the absolute path");
  for (const dir of ["/home/rae", "/home", "/"]) assert.equal(model.listing(dir), null, dir);
  assert.notEqual(model.listing("/home/rae/src"), null, "a listing off the path stays");
  assert.notEqual(model.listing("/srv"), null);
});

test("model: readText takes the inline text, and without ext.raw refuses a large file in a sentence", async () => {
  const small = fakeExt({ answers: { read: { path: "/a/b.txt", inline: true, text: "hi", etag: "1-2", size: 2 } } });
  const out = await createModel(small.ext).readText("/a/b.txt");
  assert.equal(out.text, "hi");
  assert.equal(out.etag, "1-2");
  const large = fakeExt({ answers: { read: { path: "/a/big.txt", inline: false, etag: "9-9", size: 300_000 } } });
  await assert.rejects(createModel(large.ext).readText("/a/big.txt"), (err) => err.message.includes("not available in this gateway version") && err.message.includes("big.txt"));
  assert.equal(createModel(large.ext).hasRaw, false);
});

test("model: tabs open, activate, close, mark dirty, follow a rename, and go with a delete", async () => {
  const t = fakeExt({ answers: { rename: (a) => ({ path: `/home/rae/${a.name}` }), delete: { removed: { files: 1, dirs: 0 } } } });
  const model = createModel(t.ext);
  const events = [];
  model.watch((e) => e.kind === "tabs" && events.push(e.path));
  model.tabs.open("/home/rae/a.ts");
  model.tabs.open("/home/rae/b.md", { activate: false, line: 12 });
  assert.equal(model.tabs.active().path, "/home/rae/a.ts");
  assert.deepEqual(model.tabs.list().map((tab) => [tab.name, tab.kind, tab.dirty, tab.line]), [["a.ts", "viewer", false, null], ["b.md", "viewer", false, 12]]);
  model.tabs.activate("/home/rae/b.md");
  assert.equal(model.tabs.active().name, "b.md");
  model.tabs.update("/home/rae/b.md", { kind: "editor", mode: "rw" });
  assert.equal(model.tabs.list()[1].kind, "editor");
  model.tabs.markDirty("/home/rae/b.md", true);
  assert.equal(model.tabs.active().dirty, true);
  model.tabs.markDirty("/home/rae/b.md", true);
  assert.equal(events.filter((p) => p === "/home/rae/b.md").length, 4, "an unchanged dirty flag is no event");
  await model.rename("/home/rae/b.md", "c.md");
  assert.equal(model.tabs.active().path, "/home/rae/c.md");
  assert.equal(model.tabs.active().name, "c.md");
  model.tabs.close("/home/rae/c.md");
  assert.equal(model.tabs.active().path, "/home/rae/a.ts");
  model.select("/home/rae/a.ts");
  await model.remove("/home/rae/a.ts");
  assert.equal(model.tabs.active(), null);
  assert.equal(model.selected, "/home/rae");
  assert.deepEqual(model.tabs.list(), []);
});

test("model: without storage the explorer state still works, and every setter is an event", () => {
  const model = createModel(fakeExt().ext);
  const events = [];
  model.watch((e) => events.push(e.kind));
  assert.equal(model.explorerWidth, 280);
  model.setExplorerWidth(100);
  assert.equal(model.explorerWidth, 200, "clamped to the range");
  model.setExplorerWidth(5000);
  assert.equal(model.explorerWidth, 640);
  model.setExpanded("/a", true);
  assert.ok(model.isExpanded("/a"));
  model.setExpanded("/a", true);
  assert.equal(model.toggleExpanded("/a"), false);
  model.setExpanded("/b", true, { silent: true });
  model.collapseAll();
  assert.equal(model.expanded.size, 0);
  model.setFilter("x");
  model.setFilter("x");
  model.setHidden(true);
  model.select("/a");
  model.select("/a");
  assert.deepEqual(events, ["explorer", "explorer", "explorer", "explorer", "explorer", "selection"]);
  assert.equal(model.tabs.buffer("/nothing"), null);
});

test("model: resolve sends at most 64 distinct paths, and bind drops the roots cache", async () => {
  const t = fakeExt({ answers: { resolve: (a) => ({ results: Object.fromEntries(a.paths.map((p) => [p, null])) }), bind: { ok: true }, roots: ROOTS } });
  const model = createModel(t.ext);
  const many = Array.from({ length: 70 }, (_, i) => `/p/${i}`);
  const out = await model.resolve([...many, "/p/0", ""]);
  assert.equal(Object.keys(out).length, 64);
  assert.equal(t.calls[0].args.paths.length, 64);
  assert.deepEqual(await model.resolve([]), {});
  await model.roots({ session: "s" });
  const seen = [];
  model.watch((e) => seen.push(e.kind));
  await model.bind("/srv/gone", "rw");
  assert.deepEqual(t.calls.at(-1).args, { path: "/srv/gone", mode: "rw" });
  assert.equal(model.rootsCached("s"), null);
  assert.deepEqual(seen, ["roots"]);
});

test("toastOnce says one sentence once per moment, and never as an error", () => {
  const seen = [];
  const ext = { toast: (m, o) => seen.push([m, o?.tone]) };
  assert.equal(toastOnce(ext, "Downloading a file is not available.", { tone: "warn" }), true);
  assert.equal(toastOnce(ext, "Downloading a file is not available.", { tone: "warn" }), false, "the same sentence again is not said twice");
  assert.equal(toastOnce(ext, "Another sentence.", {}), true);
  assert.deepEqual(seen, [["Downloading a file is not available.", "warn"], ["Another sentence.", undefined]]);
});

// ---- storage scoped by person ----

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test("isUnscopedKey names the old keys and nothing else", () => {
  for (const k of ["thetis.workspace.expanded", "thetis.workspace.hidden", "thetis.workspace.explorer", "thetis.workspace.mode:md", "thetis.workspace.mode:"]) assert.equal(isUnscopedKey("local", k), true, k);
  for (const k of ["thetis.workspace.tabs", "thetis.workspace.buffer:/a/b.txt"]) assert.equal(isUnscopedKey("session", k), true, k);
  for (const k of ["thetis.workspace.rae.expanded", "thetis.workspace.rae.mode:md", "thetis.workspace.tabs", "thetis.other", "expanded", null]) assert.equal(isUnscopedKey("local", k), false, String(k));
  for (const k of ["thetis.workspace.rae.tabs", "thetis.workspace.expanded", "thetis.workspace.rae.buffer:/x"]) assert.equal(isUnscopedKey("session", k), false, k);
});

test("model: storage keys carry the user; nothing is stored before the roots name one, and the old unscoped keys are never read", async () => {
  assert.equal(storageKey("rae", "expanded"), "thetis.workspace.rae.expanded");
  assert.equal(storageKey(null, "expanded"), null);
  const local = fakeStorage({ "thetis.workspace.expanded": JSON.stringify(["/old/unscoped"]), "thetis.workspace.hidden": "true", "thetis.workspace.explorer": "500", "thetis.workspace.mode:md": "source", "thetis.other": "kept", "thetis.workspace.rae.expanded": JSON.stringify(["/home/rae/stored"]), "thetis.workspace.rae.hidden": "true", "thetis.workspace.rae.explorer": "333", "thetis.workspace.bob.expanded": "[]" });
  const session = fakeStorage({ "thetis.workspace.tabs": "{}", "thetis.workspace.buffer:/old.txt": "old", "thetis.workspace.rae.tabs": JSON.stringify({ active: "/home/rae/s.md", list: [{ path: "/home/rae/s.md", name: "s.md", kind: "viewer" }] }), "thetis.workspace.rae.buffer:/home/rae/s.md": "unsaved" });
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  try {
    const t = fakeExt({ answers: { roots: ROOTS } });
    const model = createModel(t.ext);
    const events = [];
    model.watch((e) => events.push(e.kind));
    assert.equal(model.user, null);
    assert.equal(model.expanded.size, 0, "nothing is read before the user is known");
    assert.equal(model.hidden, false);
    assert.equal(model.explorerWidth, 280);
    model.setExpanded("/home/rae/mine", true);
    model.tabs.open("/home/rae/mine.ts");
    model.tabs.setBuffer("/home/rae/mine.ts", "typed early");
    assert.equal([...local.map.keys()].filter((k) => k.startsWith("thetis.workspace.rae.")).length, 3, "the store is untouched until the user is known");
    assert.equal(session.map.size, 4);
    assert.ok(local.map.has("thetis.workspace.expanded"), "the old keys are untouched until then too");
    await model.roots({ session: "s1" });
    assert.equal(model.user, "rae");
    assert.deepEqual([...model.expanded].sort(), ["/home/rae/mine", "/home/rae/stored"], "stored folders are adopted, mine are kept, the unscoped key is ignored");
    assert.equal(model.hidden, true, "a stored choice is adopted when none was made here");
    assert.equal(model.explorerWidth, 333);
    assert.deepEqual(model.tabs.list().map((tab) => [tab.path, tab.dirty]), [["/home/rae/s.md", true], ["/home/rae/mine.ts", true]], "stored tabs first, then the ones opened meanwhile, buffers included");
    assert.equal(model.tabs.active().path, "/home/rae/mine.ts", "the tab activated here stays active");
    assert.equal(model.tabs.buffer("/home/rae/mine.ts"), "typed early");
    assert.equal(session.map.get("thetis.workspace.rae.buffer:/home/rae/mine.ts"), "typed early", "the early buffer moved into the scoped store");
    assert.deepEqual(JSON.parse(local.map.get("thetis.workspace.rae.expanded")).sort(), ["/home/rae/mine", "/home/rae/stored"]);
    for (const k of ["thetis.workspace.expanded", "thetis.workspace.hidden", "thetis.workspace.explorer", "thetis.workspace.mode:md"]) assert.equal(local.map.has(k), false, `the stale unscoped key ${k} is dropped on the first run with a known user`);
    for (const k of ["thetis.workspace.tabs", "thetis.workspace.buffer:/old.txt"]) assert.equal(session.map.has(k), false, `${k} is dropped`);
    assert.equal(local.map.get("thetis.other"), "kept", "keys that are not the workspace's are not touched");
    assert.equal(local.map.get("thetis.workspace.bob.expanded"), "[]", "another person's scoped state stays");
    model.setExpanded("/home/rae/later", true);
    assert.ok(JSON.parse(local.map.get("thetis.workspace.rae.expanded")).includes("/home/rae/later"));
    model.setExplorerWidth(400);
    assert.equal(local.map.get("thetis.workspace.rae.explorer"), "400");
    assert.ok(events.includes("explorer") && events.includes("tabs") && events.includes("roots"), "adoption is announced");
    // A choice made before the user was known wins over the stored one.
    const t2 = fakeExt({ answers: { roots: ROOTS } });
    const model2 = createModel(t2.ext);
    model2.setHidden(true);
    model2.setHidden(false);
    await model2.roots({});
    assert.equal(model2.hidden, false);
    assert.equal(local.map.get("thetis.workspace.rae.hidden"), "false");
  } finally {
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
  }
});

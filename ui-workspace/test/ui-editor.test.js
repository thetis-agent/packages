/* Pure logic of the browser editor and viewer modules: the line diff, the language table, the mode memory,
 * the strip's words. The modules import nothing from the DOM at load time, so bare Node runs them. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ago, changedLines, copyToHome, detectEol, homeCopyPath, isAuthError, isPlainTypingKey, isReadOnlyRoot, readOnlySentence, unifiedDiff, writerName } from "../ui/editor.js";
import { canonical, GRAMMARS, grammarFor, hasGrammar, languageLabel, loadLanguage } from "../ui/lang.js";
import { savedText } from "../ui/strip.js";
import { formatSize, imageNotFound, modeKey, rememberedMode, rememberMode, resolveRelative } from "../ui/viewer.js";

const ui = fileURLToPath(new URL("../ui/", import.meta.url));

test("every owned ui module passes node --check", () => {
  for (const name of ["lang.js", "editor.js", "viewer.js", "strip.js"]) execFileSync(process.execPath, ["--check", join(ui, name)]);
  assert.ok(readdirSync(join(ui, "vendor")).includes("codemirror.js"), "the vendored core is beside the modules");
});

/* ---------- the line diff ---------- */

test("changedLines marks a changed line, an inserted line and where a deletion was", () => {
  assert.deepEqual(changedLines("a\nb\nc", "a\nb\nc"), []);
  assert.deepEqual(changedLines("a\nb\nc", "a\nB\nc"), [2]);
  assert.deepEqual(changedLines("a\nb\nc", "a\nb\nx\nc"), [3]);
  assert.deepEqual(changedLines("a\nb\nc", "z\na\nb\nc"), [1]);
  assert.deepEqual(changedLines("a\nb\nc", "a\nb\nc\nd"), [4]);
  assert.deepEqual(changedLines("a\nb\nc", "a\nc"), [2], "a deleted line marks the line now in its place");
  assert.deepEqual(changedLines("a\nb\nc", "a\nb"), [2], "deleting the last line marks the new last line");
  assert.deepEqual(changedLines("", "x"), [1]);
  assert.deepEqual(changedLines("a\nb\nc\nd\ne", "a\nX\nc\nY\ne"), [2, 3, 4], "two edits mark the span between them");
});

test("changedLines never marks a line the document does not have", () => {
  const before = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const after = before.split("\n").slice(0, 10).join("\n");
  const lines = changedLines(before, after);
  assert.ok(lines.every((n) => n >= 1 && n <= 10));
});

test("unifiedDiff shows the changed span with context and the right signs", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
  const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n");
  const diff = unifiedDiff(before, after);
  assert.equal(
    diff,
    ["--- theirs", "+++ mine", "@@ -2,7 +2,7 @@", " b", " c", " d", "-e", "+E", " f", " g", " h"].join("\n")
  );
  assert.equal(unifiedDiff("same", "same"), "");
  assert.match(unifiedDiff("x", "x\ny", { context: 0, names: ["disk", "buffer"] }), /^--- disk\n\+\+\+ buffer\n@@ -2,0 \+2,1 @@\n\+y$/);
});

test("detectEol and ago", () => {
  assert.equal(detectEol("a\nb"), "LF");
  assert.equal(detectEol("a\r\nb"), "CRLF");
  assert.equal(detectEol(""), "LF");
  const now = Date.parse("2026-09-25T12:00:00Z");
  assert.equal(ago("2026-09-25T11:59:59Z", now), "just now");
  assert.equal(ago("2026-09-25T11:59:20Z", now), "40 seconds ago");
  assert.equal(ago("2026-09-25T11:57:00Z", now), "3 min ago");
  assert.equal(ago("2026-09-25T09:00:00Z", now), "3 h ago");
  assert.equal(ago("not a date", now), "");
  assert.equal(ago(now - 10_000, now), "10 seconds ago");
});

test("the conflict banner names a conversation only when the answer carries one", () => {
  assert.equal(writerName({ etag: "1-2" }), null);
  assert.equal(writerName({ conversation: "Nova bug 1183" }), "Nova bug 1183");
  assert.equal(writerName({ conversation: { id: "s_1", title: "Nova bug 1183" } }), "Nova bug 1183");
  assert.equal(writerName({ session: { id: "s_1" } }), "s_1");
  assert.equal(writerName(null), null);
});

test("homeCopyPath answers a home-relative target, never ~/: shared/<rel>, <mount name>/<rel>, else copies/<name>", () => {
  const roots = { home: { path: "/home/rae" }, shared: { path: "/srv/shared" }, projects: [{ id: "p", directories: [{ path: "/srv/games/nova", state: "ready", mode: "rw" }] }], mounts: [{ path: "/srv/games/nova", mode: "rw" }, { path: "/srv", mode: "ro" }] };
  assert.equal(homeCopyPath({ path: "/srv/shared/skills/thetis/SKILL.md", display: "/srv/shared/skills/thetis/SKILL.md", root: "shared" }, roots), "shared/skills/thetis/SKILL.md");
  assert.equal(homeCopyPath({ path: "/srv/games/nova/src/tide.ts", display: "/srv/games/nova/src/tide.ts", root: "mount", mount: { path: "/srv/games/nova", mode: "rw" } }, roots), "nova/src/tide.ts", "the stat's mount root");
  assert.equal(homeCopyPath({ path: "/srv/games/nova/src/tide.ts", root: "mount" }, roots), "nova/src/tide.ts", "without it, the deepest mount of the roots");
  assert.equal(homeCopyPath({ path: "/srv/other/a.txt", root: "mount" }, roots), "srv/other/a.txt", "a mount root that is a plain host path keeps the path under it");
  assert.equal(homeCopyPath({ path: "/srv/other/a.txt", root: "mount" }, { home: { path: "/home/rae" } }), "copies/a.txt", "no root known: a copy under copies/");
  assert.equal(homeCopyPath({ path: "/x/y.txt", root: "home" }), "copies/y.txt");
  assert.equal(homeCopyPath({ path: "/srv/shared/p.txt", root: "shared" }, null), "copies/p.txt", "shared without the roots is still never ~/");
  for (const file of [{ path: "/srv/shared/p.txt", root: "shared" }, { path: "/srv/games/nova/a", root: "mount" }]) assert.doesNotMatch(homeCopyPath(file, roots), /^[~/]/, "relative, so the server resolves it against home");
});

test("a read-only root is the root's refusal, never the size; the notice sentence names the root", () => {
  assert.equal(isReadOnlyRoot({ root: "shared", writable: false, mode: "ro" }), true);
  assert.equal(isReadOnlyRoot({ root: "mount", writable: true, mode: "rw", tooLarge: true }), false, "a large file on a rw mount is not on a read-only root");
  assert.equal(isReadOnlyRoot(null), false);
  assert.equal(readOnlySentence({ root: "shared" }), "Shared is read-only for you. You can read and download this file. To change it, copy it to Home or ask an admin.");
  assert.equal(readOnlySentence({ root: "mount" }), "mount is read-only for you. You can read and download this file. To change it, copy it to Home or ask an admin.");
  assert.equal(imageNotFound("img/nope.png"), "The image was not found at img/nope.png.");
});

test("copyToHome writes the home-relative target through the model and answers the absolute path the write names", async () => {
  const writes = [];
  const roots = { user: "rae", home: { path: "/home/rae" }, shared: { path: "/srv/shared" }, projects: [], mounts: [] };
  const model = {
    rootsCached: () => roots,
    write: async (path, text) => (writes.push([path, text]), { ok: true, path: `/home/rae/${path}`, etag: "1-1" }),
  };
  const file = { path: "/srv/shared/policy.txt", root: "shared", writable: false, mode: "ro" };
  assert.equal(await copyToHome({ model, file, text: "policy", session: "s" }), "/home/rae/shared/policy.txt");
  assert.deepEqual(writes, [["shared/policy.txt", "policy"]]);
  const noPath = { rootsCached: () => roots, write: async () => ({ ok: true, etag: "1-1" }) };
  assert.equal(await copyToHome({ model: noPath, file, text: "" }), "/home/rae/shared/policy.txt", "without a path in the answer, home + target");
  const refused = { rootsCached: () => roots, write: async () => ({ ok: false, message: "home is full." }) };
  await assert.rejects(copyToHome({ model: refused, file, text: "" }), /home is full\./);
  const late = { rootsCached: () => null, roots: async () => roots, write: async (path) => ({ ok: true, path: `/home/rae/${path}` }) };
  assert.equal(await copyToHome({ model: late, file, text: "" }), "/home/rae/shared/policy.txt", "the roots are asked when not cached");
});

test("the stat poll stops on a signed-out answer only", () => {
  assert.equal(isAuthError({ status: 401, name: "ApiError" }), true);
  assert.equal(isAuthError({ status: 403 }), true);
  assert.equal(isAuthError({ status: 502 }), false);
  assert.equal(isAuthError(new Error("Not connected.")), false);
  assert.equal(isAuthError(null), false);
});

test("a plain printable key is the editor's alone; Escape and modified keys propagate", () => {
  assert.equal(isPlainTypingKey({ key: "/" }), true);
  assert.equal(isPlainTypingKey({ key: "n" }), true);
  assert.equal(isPlainTypingKey({ key: " " }), true);
  assert.equal(isPlainTypingKey({ key: "Escape" }), false);
  assert.equal(isPlainTypingKey({ key: "s", ctrlKey: true }), false);
  assert.equal(isPlainTypingKey({ key: "s", metaKey: true }), false);
  assert.equal(isPlainTypingKey({ key: "n", altKey: true }), false);
  assert.equal(isPlainTypingKey({ key: "F2" }), false);
  assert.equal(isPlainTypingKey(null), false);
});

/* ---------- languages ---------- */

test("every stat language except plain has a grammar, and aliases fold onto them", () => {
  for (const name of ["ts", "js", "jsx", "tsx", "json", "md", "html", "css", "py", "sh", "toml", "yaml"]) assert.ok(hasGrammar(name), name);
  assert.equal(grammarFor("plain"), null);
  assert.equal(grammarFor(""), null);
  assert.equal(grammarFor("cobol"), null);
  assert.deepEqual(grammarFor("ts"), { file: "./vendor/lang-javascript.js", fn: "typescript" });
  assert.deepEqual(grammarFor("tsx"), { file: "./vendor/lang-javascript.js", fn: "tsx" });
  assert.deepEqual(grammarFor("js"), { file: "./vendor/lang-javascript.js", fn: "language" });
  assert.deepEqual(grammarFor("jsx"), { file: "./vendor/lang-javascript.js", fn: "jsx" });
  assert.deepEqual(grammarFor("sh"), { file: "./vendor/lang-legacy.js", fn: "shell" });
  assert.deepEqual(grammarFor("toml"), { file: "./vendor/lang-legacy.js", fn: "toml" });
  assert.deepEqual(grammarFor("yaml"), { file: "./vendor/lang-legacy.js", fn: "yaml" });
  assert.equal(canonical("TypeScript"), "ts");
  assert.equal(canonical(" bash "), "sh");
  assert.equal(canonical("yml"), "yaml");
  assert.equal(canonical("python"), "py");
  assert.equal(canonical("text"), "plain");
  assert.equal(canonical(undefined), "plain");
  assert.equal(languageLabel("ts"), "TypeScript");
  assert.equal(languageLabel("plain"), "Plain text");
  assert.equal(languageLabel("cobol"), "cobol");
  for (const [, [file, fn]] of Object.entries(GRAMMARS)) assert.ok(file && fn);
});

test("loadLanguage builds one LanguageSupport per language from the vendored files and none for plain", async () => {
  assert.equal(await loadLanguage("plain"), null);
  const ts = await loadLanguage("ts");
  assert.ok(ts && ts.language && ts.language.parser, "a LanguageSupport with a parser");
  assert.equal(await loadLanguage("typescript"), ts, "cached per canonical name");
  const sh = await loadLanguage("bash");
  assert.ok(sh && sh.language);
  assert.notEqual(sh, ts);
  const { LanguageSupport } = await import("../ui/vendor/codemirror.js");
  assert.ok(ts instanceof LanguageSupport);
  assert.ok(sh instanceof LanguageSupport);
});

/* ---------- the viewer's memory and helpers ---------- */

test("the mode memory is per language, falls back to the preview word and survives a broken store", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const md = { language: "md", preview: "markdown" };
  assert.equal(modeKey(md), "md");
  assert.equal(modeKey({ language: "plain", preview: "image" }), "image");
  assert.equal(rememberedMode(md, "rae", storage), null);
  rememberMode(md, "source", "rae", storage);
  assert.equal(store.get("thetis.workspace.rae.mode:md"), "source", "the key carries the person");
  assert.equal(rememberedMode(md, "rae", storage), "source");
  assert.equal(rememberedMode(md, "bob", storage), null, "another person's choice is not this one's");
  rememberMode(md, "source", null, storage);
  assert.equal(rememberedMode(md, null, storage), null, "nothing is stored or read before the person is known");
  assert.equal(store.size, 1);
  store.set("thetis.workspace.rae.mode:md", "sideways");
  assert.equal(rememberedMode(md, "rae", storage), null, "an unknown word is ignored");
  const broken = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(rememberedMode(md, "rae", broken), null);
  assert.doesNotThrow(() => rememberMode(md, "rendered", "rae", broken));
  assert.equal(rememberedMode(md, "rae", undefined), null);
});

test("resolveRelative and formatSize", () => {
  assert.equal(resolveRelative("/home/me/docs/README.md", "img/a.png"), "/home/me/docs/img/a.png");
  assert.equal(resolveRelative("/home/me/docs/README.md", "./a.png"), "/home/me/docs/a.png");
  assert.equal(resolveRelative("README.md", "a.png"), "a.png");
  assert.equal(resolveRelative("/home/me/README.md", "../x.png"), null);
  assert.equal(formatSize(612), "612 B");
  assert.equal(formatSize(2867), "2.8 KB");
  assert.equal(formatSize(11.3 * 1024 * 1024), "11.3 MB");
  assert.equal(formatSize(300 * 1024), "300 KB");
  assert.equal(formatSize("x"), "");
});

/* ---------- the strip ---------- */

test("the strip's saved field", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  assert.equal(savedText({ readOnly: true, dirty: true }, now), "Read-only");
  assert.equal(savedText({ dirty: true, saved: "2026-09-25T11:00:00Z" }, now), "Unsaved changes");
  assert.equal(savedText({ saved: "2026-09-25T11:57:00Z" }, now), "Saved 3 min ago");
  assert.equal(savedText({}, now), "");
});

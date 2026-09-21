// The two commands over a fake kernel and a temporary home with one skill pack and a project, the page's
// BM25 held to the library's, and the browser module over a fake seam: nothing at import, the one declared
// dock, no request from draw, one request per conversation and per turn end, the sections drawn from the
// answer, the search without a second request, a row that opens the skill's text through `skill` and the
// back link, and a refusal's sentence in the body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bm25Index as libIndex, bm25Search as libSearch } from "@thetis/skills";
import { LOADERS, stateOf, uiSkill, uiSkills } from "../index.js";
import { bm25Index, bm25Search } from "../ui/rank.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- a home with a pack and a project ----

function skillText(name, description, meta = [], body = `# ${name}\n\nThe body of ${name}.\n`) {
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (meta.length) lines.push("metadata:", ...meta.map((l) => `  ${l}`));
  return [...lines, "---", body].join("\n");
}

function writeSkill(dir, id, text, files = {}) {
  mkdirSync(resolve(dir, id), { recursive: true });
  writeFileSync(resolve(dir, id, "SKILL.md"), text);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(resolve(dir, id, name)), { recursive: true });
    writeFileSync(resolve(dir, id, name), content);
  }
}

function makeHome() {
  const home = mkdtempSync(resolve(tmpdir(), "ui-skills-"));
  const pack = resolve(home, "pack/skills");
  writeSkill(pack, "concise", skillText("concise", "Answer in few words. Use when the person wants brevity.", ['universal: "true"', "title: Be concise"]));
  writeSkill(pack, "packages", skillText("packages", "Installs, forks and promotes packages. Use when asked to add or change a package.", ["tags: [install, marketplace]"]), { "references/install.md": "how to install" });
  writeSkill(pack, "packages/forks", skillText("forks", "Forks a package into the person's own space. Use when a package needs a local change."));
  writeSkill(pack, "bad", "---\nname: wrong\ndescription: The name disagrees with the directory.\n---\nbody\n");
  writeSkill(resolve(home, "skills"), "mine", skillText("mine", "A skill the person wrote. Use when the request mentions mine."));
  mkdirSync(resolve(home, "projects"), { recursive: true });
  writeFileSync(resolve(home, "projects/sessions.json"), JSON.stringify({ s_1: "p_0000abcd", s_2: "p_0000abcd" }));
  writeFileSync(resolve(home, "projects/p_0000abcd.json"), JSON.stringify({ id: "p_0000abcd", name: "P", directories: [], tools: { disable: [] }, skills: { disable: ["packages"] } }));
  return { home, pack: resolve(home, "pack"), rm: () => rmSync(home, { recursive: true, force: true }) };
}

const STATE = {
  loader: "@thetis/skills-l1",
  universal: ["concise"],
  pinned: [{ id: "packages", contentHash: "abc", score: 0.5, how: "lexical" }],
  loaded: ["mine"],
  catalogue: ["concise", "mine", "packages"],
  dropped: [],
  excluded: ["packages", "packages/forks"],
  notes: ["skill bad left out: name wrong does not match the directory bad"],
};

function fakeEnv(home, pack, { session = "s_1", harness = { "@thetis/skills": STATE }, loaders = ["@thetis/skills-l1"] } = {}) {
  const packages = [
    { name: "@thetis/tools-files", version: "1.0.0", type: "tool", root: "/x", thetis: { type: "tool", tools: [] } },
    { name: "@test/pack", version: "0.0.1", type: "skill", root: pack, thetis: { type: "skill", skills: "skills" } },
    ...loaders.map((name) => ({ name, version: "0.1.0", type: "loader", root: "/y", thetis: { type: "loader" } })),
  ];
  return {
    cwd: home,
    root: home,
    readFile: async (p) => {
      try {
        return readFileSync(resolve(home, p), "utf8");
      } catch (e) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: e.code ?? "ENOENT" });
      }
    },
    kernel: { packages: { list: async () => packages }, sessions: { inspect: async (id) => ({ id, turns: 1, harness: id === "s_1" ? harness : {} }) } },
    user: "dev",
    role: "admin",
    session,
  };
}

// ---- the commands ----

test("skills merges the loader's state, the project's switches and the catalogue for the open conversation", async () => {
  const { home, pack, rm } = makeHome();
  try {
    const { data } = await uiSkills({}, fakeEnv(home, pack));
    assert.equal(data.loader, "@thetis/skills-l1");
    assert.deepEqual(data.loaders, ["@thetis/skills-l1"]);
    assert.deepEqual(data.universal, ["concise"]);
    assert.deepEqual(data.pinned, [{ id: "packages", contentHash: "abc", score: 0.5, how: "lexical" }]);
    assert.deepEqual(data.loaded, ["mine"]);
    assert.deepEqual(data.catalogue, ["concise", "mine", "packages"]);
    assert.deepEqual(data.dropped, []);
    assert.deepEqual(data.notes, STATE.notes);
    assert.deepEqual(data.excluded, ["packages", "packages/forks"], "a switched-off parent takes its nested skill with it");
    assert.deepEqual(
      data.skills.map((s) => s.id),
      ["bad", "concise", "mine", "packages", "packages/forks"]
    );
    const concise = data.skills[1];
    assert.equal(concise.brief, "`concise` (Be concise) — Answer in few words.");
    assert.equal(concise.short, "Answer in few words.");
    assert.equal(concise.title, "Be concise");
    assert.equal(concise.universal, true);
    assert.equal(concise.package, "@test/pack");
    assert.match(concise.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(concise.error, null);
    assert.deepEqual(data.skills[3].tags, ["install", "marketplace"]);
    assert.deepEqual(data.skills[3].children, ["packages/forks"]);
    assert.equal(data.skills[2].package, null, "a skill under the home has no package");
    assert.match(data.skills[0].error, /name/);
  } finally {
    rm();
  }
});

test("skills without a session answers the catalogue only; a session without state answers the empty shape", async () => {
  const { home, pack, rm } = makeHome();
  try {
    const bare = (await uiSkills({}, fakeEnv(home, pack, { session: null }))).data;
    assert.equal(bare.loader, null);
    assert.deepEqual([bare.universal, bare.pinned, bare.loaded, bare.catalogue, bare.dropped, bare.notes, bare.excluded], [[], [], [], [], [], [], []]);
    assert.equal(bare.skills.length, 5);
    const fresh = (await uiSkills({}, fakeEnv(home, pack, { session: "s_2" }))).data;
    assert.equal(fresh.loader, null);
    assert.deepEqual(fresh.excluded, ["packages", "packages/forks"], "the project's switch shows before any turn");
    const none = (await uiSkills({}, fakeEnv(home, pack, { session: "s_2", loaders: [] }))).data;
    assert.deepEqual(none.loaders, []);
  } finally {
    rm();
  }
});

test("stateOf tolerates a missing, malformed or partial record", () => {
  assert.deepEqual(stateOf(undefined), { loader: null, universal: [], pinned: [], loaded: [], catalogue: [], dropped: [], notes: [] });
  assert.deepEqual(stateOf({ "@thetis/skills": "no" }).loader, null);
  const partial = stateOf({ "@thetis/skills": { loader: "@thetis/skills-all", universal: ["a", 3], pinned: [{ id: "b" }, "c"], dropped: ["d"] } });
  assert.deepEqual(partial, { loader: "@thetis/skills-all", universal: ["a"], pinned: [{ id: "b", contentHash: "", score: null, how: "" }], loaded: [], catalogue: [], dropped: ["d"], notes: [] });
  assert.deepEqual(LOADERS, ["@thetis/skills-hybrid", "@thetis/skills-l1", "@thetis/skills-all"]);
});

test("skill answers the rendered text of one skill, and refuses a missing or unknown id", async () => {
  const { home, pack, rm } = makeHome();
  try {
    const env = fakeEnv(home, pack);
    const { data } = await uiSkill({ id: "packages" }, env);
    assert.equal(data.id, "packages");
    assert.equal(data.package, "@test/pack");
    assert.equal(data.excluded, true);
    assert.deepEqual(data.children, ["packages/forks"]);
    assert.deepEqual(data.resources, ["references/install.md"]);
    assert.match(data.text, /^# packages\n\nThe body of packages\.\n\nSkill directory: .*pack\/skills\/packages\nFiles beside SKILL\.md \(skill_fetch with file\): references\/install\.md$/);
    assert.equal((await uiSkill({ id: "mine" }, env)).data.excluded, false);
    await assert.rejects(uiSkill({}, env), { message: "skill needs an id." });
    await assert.rejects(uiSkill({ id: "nope" }, env), { message: "No skill named nope." });
  } finally {
    rm();
  }
});

test("the page's BM25 answers exactly what the library's does", () => {
  const rows = [
    { id: "concise", name: "concise", description: "Answer in few words. Use when the person wants brevity.", tags: [] },
    { id: "packages", name: "packages", description: "Installs, forks and promotes packages. Use when asked to add or change a package.", tags: ["install", "marketplace"] },
    { id: "packages/forks", name: "forks", description: "Forks a package into the person's own space.", tags: [] },
    { id: "mine", name: "mine", description: "A skill the person wrote.", tags: ["personal"] },
  ];
  const ours = bm25Index(rows);
  const theirs = libIndex(rows);
  for (const q of ["package", "install a package", "person", "forks marketplace", "nothing", "", "the and for"]) {
    assert.deepEqual(bm25Search(ours, q, 10), libSearch(theirs, q, 10), q);
  }
  assert.deepEqual(
    bm25Search(ours, "package", 10).map((h) => h.id),
    ["packages/forks", "packages"]
  );
});

test("the manifest names files that exist, and the commands' exports are functions", async () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const ui = manifest.thetis.ui;
  assert.equal(manifest.thetis.type, "ui");
  assert.equal(manifest.main, "index.js");
  for (const file of [ui.entry, ui.style]) readFileSync(resolve(root, ui.dir, file));
  const main = await import("../index.js");
  for (const command of ui.commands) assert.equal(typeof main[command.export], "function", `${command.verb} -> ${command.export}`);
  assert.deepEqual(ui.commands.map((c) => c.verb), ["skills", "skill"]);
  assert.deepEqual(ui.dock.map((d) => d.id), ["skills"]);
  assert.equal(ui.dock[0].wide, true);
  assert.ok(ui.dock[0].order > 100, "after Tools and Context, which take the default order");
});

// ---- the browser module over a fake seam ----

function node(tag, props = {}) {
  const n = { tag, props, children: [] };
  n.append = (...items) => n.children.push(...items.flat().filter((c) => c != null && c !== false));
  n.replaceChildren = () => (n.children = []);
  return n;
}
const el = (tag, props = {}, ...children) => {
  const n = node(tag, props);
  n.append(...children);
  return n;
};
const clear = (n) => (n.replaceChildren(), n);
const text = (n) => (typeof n === "string" ? n : n.children.map(text).join(""));
const find = (n, cls, out = []) => {
  if (typeof n === "string") return out;
  if (String(n.props.class ?? "").split(" ").includes(cls)) out.push(n);
  for (const c of n.children) find(c, cls, out);
  return out;
};
const ids = (n, cls = "sk-row") => find(n, cls).map((r) => r.props["data-skill"]);

/** `answer` may be a value or a function of the session; `skill` answers the `skill` verb by id. */
function fakeExt({ answer, skill = (id) => ({ id, text: `# ${id}\n\nBody of ${id}.` }), reject } = {}) {
  const log = { docks: {}, requests: [], redraws: 0, watchers: [], turnWatchers: [], rendered: [] };
  let current = "s_1";
  const ext = {
    package: "@thetis/ui-skills",
    dock: (id, impl) => (log.docks[id] = impl),
    request: async (verb, opts) => {
      log.requests.push({ verb, ...opts });
      if (reject) throw new Error(reject);
      if (verb === "skill") return { data: skill(opts.args.id) };
      return { data: typeof answer === "function" ? answer(opts.session) : answer };
    },
    redraw: () => log.redraws++,
    conversation: { get current() { return current; }, watch: (fn) => log.watchers.push(fn), set: (id) => (current = id) },
    events: { watch: (fn) => log.turnWatchers.push(fn) },
    dom: { el, clear },
    ui: { badge: (label, tone) => el("span", { class: `badge is-${tone}` }, label) },
    markdown: (md) => (log.rendered.push(md), el("div", { class: "md" }, md)),
  };
  return { ext, log };
}

const turnEnd = (session) => ({ session, event: { type: "turn.end" } });
const tick = () => new Promise((r) => setTimeout(r, 0));

let ANSWER;
test.before(async () => {
  const { home, pack, rm } = makeHome();
  try {
    ANSWER = (await uiSkills({}, fakeEnv(home, pack))).data;
  } finally {
    rm();
  }
});

test("the module does nothing at import and exports install", async () => {
  const mod = await import("../ui/index.js");
  assert.equal(typeof mod.default, "function");
  assert.equal(mod.default.name, "install");
  assert.deepEqual(Object.keys(mod), ["default"]);
});

test("install registers the skills dock; the first draw asks once and the sections come from the answer", async () => {
  const { default: install } = await import("../ui/index.js");
  const { ext, log } = fakeExt({ answer: ANSWER });
  install(ext);
  assert.equal(typeof log.docks.skills?.draw, "function");
  assert.equal(log.watchers.length, 1);
  assert.equal(log.turnWatchers.length, 1);

  const first = log.docks.skills.draw();
  assert.equal(first.title, "Skills");
  assert.equal(first.subtitle, "Asking…");
  assert.equal(log.requests.length, 0, "draw itself sends nothing");
  await tick();
  assert.deepEqual(log.requests, [{ verb: "skills", session: "s_1" }]);
  assert.equal(log.redraws, 1);

  const view = log.docks.skills.draw();
  assert.equal(view.subtitle, "5 skills · 1 always · 1 retrieved · @thetis/skills-l1");
  const sections = find(view.body, "sk-section").map((s) => s.props.class.split(" ")[1]);
  assert.deepEqual(sections, ["sk-loader", "sk-problems", "sk-universal", "sk-pinned", "sk-loaded", "sk-off", "sk-notes", "sk-catalogue"]);
  assert.equal(find(view.body, "sk-legend").length, 1, "the legend explains the four disclosure levels");
  for (const s of find(view.body, "sk-section").slice(1)) assert.equal(s.tag, "details", `${s.props.class} folds`);
  assert.equal(find(view.body, "sk-off")[0].props.open, null, "switched off starts folded");
  assert.equal(find(view.body, "sk-universal")[0].props.open, "", "always in force starts open");
  assert.match(text(find(view.body, "sk-problems")[0]), /bad/);
  assert.equal(text(find(view.body, "sk-loader-name")[0]), "@thetis/skills-l1");
  assert.deepEqual(ids(find(view.body, "sk-universal")[0]), ["concise"]);
  const pinned = find(view.body, "sk-pinned")[0];
  assert.deepEqual(ids(pinned), ["packages"]);
  assert.equal(text(find(pinned, "sk-row-score")[0]), "score 0.5 · lexical");
  assert.deepEqual(ids(find(view.body, "sk-loaded")[0]), ["mine"]);
  const off = find(view.body, "sk-off")[0];
  assert.deepEqual(ids(off), ["packages", "packages/forks"]);
  assert.ok(find(off, "sk-row").every((r) => r.props.class.includes("is-off")));
  assert.match(text(find(view.body, "sk-notes")[0]), /skill bad left out/);
  const catalogue = find(view.body, "sk-catalogue")[0];
  assert.deepEqual(ids(catalogue), ["bad", "concise", "mine", "packages", "packages/forks"]);
  assert.match(text(catalogue), /5 skills from 2 sources/);
  const families = find(catalogue, "sk-family");
  assert.deepEqual(families.map((f) => text(find(f, "section-label")[0])), ["bad", "concise", "mine", "packages"], "the catalogue is grouped by family, each a fold");
  assert.deepEqual(ids(families[3]), ["packages", "packages/forks"]);
  assert.equal(families[3].props.open, null, "families start folded");
  assert.equal(find(find(catalogue, "sk-row")[3], "sk-pill").map(text)[0], "1 nested");
  assert.equal(find(find(catalogue, "sk-row")[3], "sk-more").length, 1, "a card has a details fold");
  const badges = find(find(catalogue, "sk-row")[1], "badge").map(text);
  assert.deepEqual(badges, ["always"]);
  assert.deepEqual(find(find(catalogue, "sk-row")[3], "badge").map(text), ["pinned", "switched off"]);
  assert.deepEqual(find(find(catalogue, "sk-row")[0], "badge").map(text), ["left out"]);
  assert.ok(find(catalogue, "sk-row")[4].props.class.includes("is-nested"));
  await tick();
  assert.equal(log.requests.length, 1, "a redraw does not ask again");
});

test("without a loader the dock says so, and the universal section shows what is declared", async () => {
  const { default: install } = await import("../ui/index.js");
  const bare = { ...ANSWER, loader: null, loaders: [], universal: [], pinned: [], loaded: [], notes: [], excluded: [] };
  const { ext, log } = fakeExt({ answer: bare });
  install(ext);
  log.docks.skills.draw();
  await tick();
  const view = log.docks.skills.draw();
  assert.equal(view.subtitle, "5 skills · no loader in force");
  assert.match(text(find(view.body, "sk-loader")[0]), /No skill loader is installed\. Install one of @thetis\/skills-hybrid, @thetis\/skills-l1 or @thetis\/skills-all\./);
  assert.deepEqual(ids(find(view.body, "sk-universal")[0]), ["concise"]);
  assert.match(text(find(view.body, "sk-universal")[0]), /Declared universal/);
  assert.equal(find(view.body, "sk-pinned").length, 0);
  assert.equal(find(view.body, "sk-loaded").length, 0);
  assert.match(text(find(view.body, "sk-off")[0]), /Nothing is switched off by a project\./);

  const { ext: ext2, log: log2 } = fakeExt({ answer: { ...bare, loaders: ["@thetis/skills-l1"] } });
  install(ext2);
  log2.docks.skills.draw();
  await tick();
  assert.match(text(find(log2.docks.skills.draw().body, "sk-loader")[0]), /@thetis\/skills-l1 is installed; it writes what it did after the first turn/);
});

test("the search ranks the catalogue in the page without a request; a row opens the text and the back link returns", async () => {
  const { default: install } = await import("../ui/index.js");
  const { ext, log } = fakeExt({ answer: ANSWER });
  install(ext);
  log.docks.skills.draw();
  await tick();
  const view = log.docks.skills.draw();
  const input = find(view.body, "sk-search")[0];
  input.props.onInput({ target: { value: "package" } });
  const catalogue = find(view.body, "sk-catalogue")[0];
  assert.deepEqual(ids(catalogue), ["packages/forks", "packages"]);
  assert.match(text(find(catalogue, "sk-row-score")[0]), /^score \d/);
  input.props.onInput({ target: { value: "zzz-nothing" } });
  assert.equal(ids(find(view.body, "sk-catalogue")[0]).length, 0);
  assert.match(text(find(view.body, "sk-catalogue")[0]), /No skill matches "zzz-nothing"\./);
  assert.equal(log.requests.length, 1, "searching sends nothing");

  input.props.onInput({ target: { value: "" } });
  find(view.body, "sk-catalogue")[0];
  const row = find(view.body, "sk-row").find((r) => r.props["data-skill"] === "packages");
  find(row, "sk-row-open")[0].props.onClick();
  assert.equal(log.redraws, 2);
  let opened = log.docks.skills.draw();
  assert.equal(opened.title, "packages");
  assert.equal(opened.subtitle, "Installs, forks and promotes packages.");
  assert.ok(opened.body.props.class.includes("is-open"));
  assert.match(text(opened.body), /Reading…/);
  await tick();
  assert.deepEqual(log.requests[1], { verb: "skill", session: "s_1", args: { id: "packages" } });
  opened = log.docks.skills.draw();
  assert.equal(find(opened.body, "sk-body").length, 1);
  assert.deepEqual(log.rendered, ["# packages\n\nBody of packages."]);
  assert.equal(text(find(opened.body, "sk-body-id")[0]), "packages");
  await tick();
  assert.equal(log.requests.length, 2, "a second draw of the same skill does not ask again");

  find(opened.body, "sk-back")[0].props.onClick();
  const back = log.docks.skills.draw();
  assert.equal(back.title, "Skills");
  assert.equal(find(back.body, "sk-catalogue").length, 1);
});

test("a turn.end of the open conversation asks once more; another conversation's does not; a new conversation asks and closes the text", async () => {
  const { default: install } = await import("../ui/index.js");
  let loaded = ["mine"];
  const { ext, log } = fakeExt({ answer: () => ({ ...ANSWER, loaded }) });
  install(ext);
  log.docks.skills.draw();
  await tick();
  assert.equal(log.requests.length, 1);

  log.turnWatchers[0](turnEnd("s_other"));
  log.turnWatchers[0]({ session: "s_1", event: { type: "turn.start" } });
  await tick();
  assert.equal(log.requests.length, 1, "other sessions and other events send nothing");

  loaded = ["mine", "concise"];
  log.turnWatchers[0](turnEnd("s_1"));
  assert.deepEqual(ids(find(log.docks.skills.draw().body, "sk-loaded")[0]), ["mine"], "the old answer stays on screen while the new one is asked for");
  log.turnWatchers[0](turnEnd("s_1"));
  await tick();
  await tick();
  assert.equal(log.requests.length, 3, "one request per turn: the turn that ended mid-request queued a single follow-up");
  assert.deepEqual(ids(find(log.docks.skills.draw().body, "sk-loaded")[0]), ["mine", "concise"]);

  find(find(log.docks.skills.draw().body, "sk-row").find((r) => r.props["data-skill"] === "mine"), "sk-row-open")[0].props.onClick();
  assert.equal(log.docks.skills.draw().title, "mine");
  ext.conversation.set("s_2");
  log.watchers[0]("s_2");
  const next = log.docks.skills.draw();
  assert.equal(next.subtitle, "Asking…");
  await tick();
  assert.deepEqual(log.requests.map((r) => r.session).slice(-1), ["s_2"]);
  assert.equal(log.docks.skills.draw().title, "Skills", "a new conversation shows the list, not the skill that was open");
});

test("a refused request shows its sentence in the body", async () => {
  const { default: install } = await import("../ui/index.js");
  const { ext, log } = fakeExt({ reject: "dev may not send skills." });
  install(ext);
  log.docks.skills.draw();
  await tick();
  const view = log.docks.skills.draw();
  assert.equal(view.subtitle, "Could not list the skills");
  assert.equal(text(find(view.body, "sk-error")[0]), "dev may not send skills.");
});

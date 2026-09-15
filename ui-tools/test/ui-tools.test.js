// The `tools` command over a fake kernel, and the browser module over a fake seam: it must do nothing
// at import, register the one declared dock, never send from draw, ask once per conversation and once
// more after a turn of it ends, draw the answer (or the refusal's sentence) on redraw, name the declared
// tools the last call did not carry as withheld, and filter without a second request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { uiTools, readsOnly } from "../index.js";

const LIST = [
  {
    name: "@thetis/tools-files",
    version: "1.0.0",
    type: "tool",
    description: "Files in the home.",
    root: "/x",
    thetis: {
      type: "tool",
      tools: [
        { name: "read_path", description: "Read a file.", parameters: { type: "object", properties: { path: {}, offset: {} }, required: ["path"] }, export: "readPath" },
        { name: "write_path", description: "Write a file.", parameters: { type: "object", required: ["path", "contents"] }, export: "writePath" },
      ],
    },
  },
  { name: "@thetis/prompt-cache", version: "0.4.0", type: "step", description: "Caching.", root: "/y", thetis: { type: "step" } },
];

const AT = "2026-09-15T10:00:00.000Z";
// s_1 has had a call that carried only read_path; s_2 has none; any other session has no harness record.
const HARNESS = {
  s_1: { "@thetis/harness-core": { lastCall: { model: "m", system: "", systemChars: 0, tools: ["read_path"], messages: 2, at: AT } } },
  s_2: {},
};
const fakeEnv = (session = "s_1") => ({
  kernel: { packages: { list: async () => LIST }, sessions: { inspect: async (id) => ({ id, turns: 0, harness: HARNESS[id] }) } },
  user: "dev",
  role: "admin",
  session,
});

test("readsOnly judges by the first word of the name, plus todo_read", () => {
  for (const name of ["read_path", "search_files", "find_files", "get_directory", "list_things", "todo_read"]) assert.equal(readsOnly(name), true, name);
  for (const name of ["write_path", "edit_path", "exec", "todo_write", "ask_user", "reader", undefined]) assert.equal(readsOnly(name), false, String(name));
});

test("uiTools reduces the kernel's package list to names, declarations and the reads guess", async () => {
  const out = await uiTools({}, fakeEnv());
  assert.deepEqual(out, {
    data: {
      packages: [
        {
          name: "@thetis/tools-files",
          version: "1.0.0",
          type: "tool",
          description: "Files in the home.",
          tools: [
            { name: "read_path", description: "Read a file.", required: ["path"], reads: true },
            { name: "write_path", description: "Write a file.", required: ["path", "contents"], reads: false },
          ],
        },
        { name: "@thetis/prompt-cache", version: "0.4.0", type: "step", description: "Caching.", tools: [] },
      ],
      lastCall: { at: AT, tools: ["read_path"] },
    },
  });
});

test("uiTools answers lastCall null without a session, without a harness record, and before a call", async () => {
  assert.equal((await uiTools({}, fakeEnv(null))).data.lastCall, null, "no session");
  assert.equal((await uiTools({}, fakeEnv("s_2"))).data.lastCall, null, "no harness key");
  assert.equal((await uiTools({}, fakeEnv("s_9"))).data.lastCall, null, "no harness at all");
});

// A DOM small enough to read back: el() builds plain objects, clear() empties them.
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

// `lastCall` may be a value or a function of the session, so one seam can answer differently per conversation.
function fakeExt({ answer, lastCall = null, reject } = {}) {
  const log = { docks: {}, requests: [], redraws: 0, watchers: [], turnWatchers: [] };
  let current = "s_1";
  const ext = {
    package: "@thetis/ui-tools",
    dock: (id, impl) => (log.docks[id] = impl),
    request: async (verb, opts) => {
      log.requests.push({ verb, ...opts });
      if (reject) throw new Error(reject);
      return { data: { packages: answer, lastCall: typeof lastCall === "function" ? lastCall(opts.session) : lastCall } };
    },
    redraw: () => log.redraws++,
    conversation: { get current() { return current; }, watch: (fn) => log.watchers.push(fn), set: (id) => (current = id) },
    events: { watch: (fn) => log.turnWatchers.push(fn) },
    dom: { el, clear },
    ui: { badge: (label, tone) => el("span", { class: `badge is-${tone}` }, label) },
  };
  return { ext, log };
}

const ANSWER = (await uiTools({}, fakeEnv())).data.packages;
const turnEnd = (session) => ({ session, event: { type: "turn.end" } });
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the module does nothing at import and exports install", async () => {
  const mod = await import("../ui/index.js");
  assert.equal(typeof mod.default, "function");
  assert.equal(mod.default.name, "install");
  assert.deepEqual(Object.keys(mod), ["default"]);
});

test("install registers the tools dock; the first draw asks once, later draws do not", async () => {
  const { default: install } = await import("../ui/index.js");
  const { ext, log } = fakeExt({ answer: ANSWER });
  install(ext);
  assert.equal(typeof log.docks.tools?.draw, "function");
  assert.equal(log.watchers.length, 1);
  assert.equal(log.turnWatchers.length, 1);

  const first = log.docks.tools.draw();
  assert.equal(first.title, "Tools");
  assert.equal(first.subtitle, "Asking…");
  assert.equal(log.requests.length, 0, "draw itself sends nothing");
  await tick();
  assert.deepEqual(log.requests, [{ verb: "tools", session: "s_1" }]);
  assert.equal(log.redraws, 1);

  const second = log.docks.tools.draw();
  assert.equal(second.subtitle, "2 tools from 1 package");
  const sections = find(second.body, "ui-tools-section");
  assert.deepEqual(sections.map((s) => s.props["data-package"]), ["@thetis/tools-files", "@thetis/prompt-cache", undefined]);
  assert.equal(find(second.body, "ui-tools-card").length, 2);
  assert.deepEqual(find(second.body, "badge").map(text), ["reads only", "changes files"]);
  assert.match(text(find(second.body, "ui-tools-card-params")[1]), /requires path, contents/);
  assert.match(text(sections[2]), /Turned off right now.*No call yet in this conversation\./);
  assert.equal(find(sections[2], "ui-tools-card").length, 0);
  await tick();
  assert.equal(log.requests.length, 1, "a redraw does not ask again");
});

test("the tools the last call did not carry are withheld; a call carrying every tool withholds none", async () => {
  const { default: install } = await import("../ui/index.js");
  const withheldFor = { s_1: ["read_path"], s_2: ["read_path", "write_path"] };
  const { ext, log } = fakeExt({ answer: ANSWER, lastCall: (session) => ({ at: AT, tools: withheldFor[session] }) });
  install(ext);
  log.docks.tools.draw();
  await tick();
  const view = log.docks.tools.draw();
  const section = find(view.body, "is-withheld")[0];
  assert.deepEqual(find(section, "ui-tools-card").map((c) => c.props["data-tool"]), ["write_path"]);
  assert.deepEqual(find(section, "badge").map(text), ["withheld"]);
  assert.match(text(section), /Not sent on the last call \(.+\)\. A project or a mode package holds these back\./);
  assert.equal(find(view.body, "ui-tools-card").length, 3, "the package section still lists the tool too");
  const input = find(view.body, "ui-tools-filter")[0];
  input.props.onInput({ target: { value: "read" } });
  assert.equal(find(find(view.body, "is-withheld")[0], "ui-tools-card").length, 0, "the filter applies to the withheld cards too");

  ext.conversation.set("s_2");
  log.watchers[0]("s_2");
  log.docks.tools.draw();
  await tick();
  const full = find(log.docks.tools.draw().body, "is-withheld")[0];
  assert.equal(find(full, "ui-tools-card").length, 0);
  assert.match(text(full), /Nothing is withheld in this conversation\./);
});

test("a turn.end of the open conversation asks once more; another conversation's does not; mid-request turns coalesce", async () => {
  const { default: install } = await import("../ui/index.js");
  let tools = ["read_path"];
  const { ext, log } = fakeExt({ answer: ANSWER, lastCall: () => ({ at: AT, tools }) });
  install(ext);
  log.docks.tools.draw();
  await tick();
  assert.equal(log.requests.length, 1);

  log.turnWatchers[0](turnEnd("s_other"));
  log.turnWatchers[0]({ session: "s_1", event: { type: "turn.start" } });
  await tick();
  assert.equal(log.requests.length, 1, "other sessions and other events send nothing");

  tools = ["read_path", "write_path"];
  log.turnWatchers[0](turnEnd("s_1"));
  assert.equal(log.docks.tools.draw().subtitle, "2 tools from 1 package", "the old answer stays on screen while the new one is asked for");
  log.turnWatchers[0](turnEnd("s_1"));
  await tick();
  await tick();
  assert.equal(log.requests.length, 3, "one request per turn: the turn that ended mid-request queued a single follow-up");
  const section = find(log.docks.tools.draw().body, "is-withheld")[0];
  assert.equal(find(section, "ui-tools-card").length, 0);
  await tick();
  assert.equal(log.requests.length, 3, "and nothing more");
});

test("the filter narrows client-side, and a new conversation asks once more", async () => {
  const { default: install } = await import("../ui/index.js");
  const { ext, log } = fakeExt({ answer: ANSWER });
  install(ext);
  log.docks.tools.draw();
  await tick();
  const view = log.docks.tools.draw();
  const input = find(view.body, "ui-tools-filter")[0];
  input.props.onInput({ target: { value: "WRITE" } });
  assert.deepEqual(find(view.body, "ui-tools-card").map((c) => c.props["data-tool"]), ["write_path"]);
  input.props.onInput({ target: { value: "nothing-here" } });
  assert.equal(find(view.body, "ui-tools-card").length, 0);
  assert.match(text(find(view.body, "ui-tools-empty")[0]), /No tool matches/);
  assert.equal(log.requests.length, 1, "filtering sends nothing");

  ext.conversation.set("s_2");
  log.watchers[0]("s_2");
  assert.equal(log.redraws, 2);
  assert.equal(log.docks.tools.draw().subtitle, "Asking…");
  await tick();
  assert.deepEqual(log.requests.map((r) => r.session), ["s_1", "s_2"]);
});

test("a refused request shows its sentence in the body", async () => {
  const { default: install } = await import("../ui/index.js");
  const { ext, log } = fakeExt({ reject: "dev may not send tools." });
  install(ext);
  log.docks.tools.draw();
  await tick();
  const view = log.docks.tools.draw();
  assert.equal(view.subtitle, "Could not list the tools");
  assert.equal(text(find(view.body, "ui-tools-error")[0]), "dev may not send tools.");
});

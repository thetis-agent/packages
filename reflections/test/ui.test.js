// The browser module over a fake seam wired to the real command: the chip's label and visibility, the
// place's four tabs, a detail with its buttons, Reflect from the list, a proposal's detail in each state
// (Adopt disabled before a trial, the Run trial label, the runs, Cancel trial, Adopt anyway, the refusal shown, Retire),
// the findings by package, and the Settings tab's pickers. The DOM is gateway-web's fixture, so
// `instanceof Node` and `classList` behave as the shell expects.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../gateway-web/test/dom-fixture.js";
import install from "../ui/index.js";
import { uiCall } from "../index.js";
import { fakeKernel, get, put, sampleSession, tempHome, until } from "./helpers.js";

const A = "s_aaaa1111";
const B = "s_bbbb2222";
const T = "t_0a0b0c0d";

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
const setHidden = (node, hide) => (hide ? node.setAttribute("hidden", "") : node.removeAttribute("hidden"));
const clear = (node) => node.replaceChildren();
const buttonNamed = (node, label) => node.querySelectorAll("button").find((b) => b.textContent === label);
const buttonStarting = (node, label) => node.querySelectorAll("button").find((b) => b.textContent.startsWith(label));
const disabled = (button) => button.getAttribute("disabled") !== null;

const SKILL = `---
name: check-the-generator
description: Use when a file you are about to edit is produced by a build or a generator.
---
# Check the generator

Before you edit a generated file, find its generator and change the source.
`;

/** A library entry in the contract's shape. */
function entry(id, extra = {}) {
  return {
    id, kind: "skill", target: "check-the-generator", path: "skills/check-the-generator/SKILL.md",
    cue: "a file you are about to edit is produced by a build", lesson: "Before editing a generated file, find its generator.",
    change: SKILL, before: null, evidence: "rows 1, 2; [4], [8]", confidence: "medium", trialRequest: "opening request",
    from: [{ session: A, title: "Header fix", at: "2026-10-19T11:00:00.000Z", rows: [1, 2] }],
    versions: {}, owner: null, state: "proposed", trials: [], verdict: null, applied: null, recheck: null,
    createdAt: "2026-10-19T11:00:00.000Z", updatedAt: "2026-10-19T11:00:00.000Z", ...extra,
  };
}
const verdict = (result, extra = {}) => ({ result, why: "The runs with the change found the generator.", seen: [true, true], runs: 4, costUsd: 0.5, at: "2026-10-20T10:00:00.000Z", trial: T, ...extra });
const finding = (id, extra = {}) => ({
  id, package: "@thetis/tools-files", component: "read_file", what: "read_file cut a long line without saying so.",
  seen: [{ session: A, title: "Header fix", at: "2026-10-19T11:00:00.000Z", version: "0.4.0", events: [4], rows: [1] }],
  state: "open", since: null, closedAt: null, ...extra,
});

async function setup() {
  const { home, done } = await tempHome();
  const kernel = fakeKernel({ sessions: [sampleSession(A), sampleSession(B)] });
  const started = [];
  const allow = { cancel: false };
  // The trials host as the operator channel reaches it; local, so these tests do not lean on the shared fake.
  kernel.operator = {
    async call(name, args) {
      if (name === "host.trials.cancel") {
        if (!allow.cancel) throw new Error("The trials host could not stop it.");
        await put(home, `trials/${T}/trial.json`, { id: T, state: "cancelled", runs: [] });
        return { ok: true };
      }
      if (name !== "host.trials.start") throw new Error(`no operator call ${name}`);
      started.push(args);
      await put(home, `trials/${T}/trial.json`, { id: T, state: "running", costUsd: 0.12, runs: [{ arm: "base", n: 1, state: "running", costUsd: 0.12 }, { arm: "change", n: 1, state: "queued" }] });
      return { trial: T };
    },
  };
  kernel.packages ??= { list: async () => [] };
  const env = { cwd: home, kernel, user: "u1", role: "user", config: {} };
  const reg = { chips: {}, places: {}, opened: [], conversations: [] };
  let current = A;
  const sessions = [{ id: A, archived: true }, { id: B, archived: false }];
  const ext = {
    dom: { el, setHidden, clear },
    ui: {
      button: (label, { tone = "quiet", onClick, title, disabled } = {}) => el("button", { type: "button", class: `btn is-${tone}`, title, disabled, onClick }, label),
      kv: (pairs) => el("dl", {}, ...pairs.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
      card: (title, ...children) => el("div", { class: "card" }, title, ...children),
      field: (label, input, hint) => el("label", {}, label, input, hint),
      when: () => "just now",
    },
    markdown: (md) => el("div", { class: "md" }, md),
    request: async (verb, { args }) => uiCall(args, env),
    redraw: () => {},
    chip: (id, impl) => (reg.chips[id] = impl),
    place: (id, impl) => (reg.places[id] = impl),
    conversation: { get current() { return current; }, watch: () => {}, open: (s) => reg.conversations.push(s) },
    sessions: { list: () => sessions, watch: () => {} },
    open: { place: (id, params) => reg.opened.push({ id, params }) },
    toast: () => {},
  };
  install(ext);
  const library = (entries) => put(home, "reflections/library.json", { entries });
  return { home, env, ext, reg, started, allow, library, done, setCurrent: (s) => (current = s) };
}

/** Opens the place and waits until `ready(root)`; answers the root and the close function. */
async function opened(t, params, ready) {
  const root = el("div");
  const close = t.reg.places.reflections.open(root, params);
  await until(() => ready(root));
  return { root, close };
}

test("the chip says Not reflected on an archived conversation, and nothing on a live one", async () => {
  const t = await setup();
  try {
    const button = el("button");
    t.reg.chips.reflection.draw(button, { session: A });
    await until(async () => {
      t.reg.chips.reflection.draw(button, { session: A });
      return button.textContent === "Not reflected · Reflect";
    });
    assert.equal(button.getAttribute("hidden"), null);
    const live = el("button");
    t.reg.chips.reflection.draw(live, { session: B });
    await new Promise((r) => setTimeout(r, 20));
    t.reg.chips.reflection.draw(live, { session: B });
    assert.equal(live.getAttribute("hidden"), "");
    t.reg.chips.reflection.open({ session: A });
    assert.deepEqual(t.reg.opened.at(-1), { id: "reflections", params: { session: A } });
  } finally {
    await t.done();
  }
});

test("the chip counts the proposal and the findings of a done reflection", async () => {
  const t = await setup();
  try {
    await put(t.home, `reflections/${A}.json`, { session: A, title: "Header fix", state: "done", costUsd: 0.04, proposal: "L-aa11bb", findings: [] });
    const button = el("button");
    await until(async () => {
      t.reg.chips.reflection.draw(button, { session: A });
      return button.textContent === "Reflected · 1 proposal · $0.04";
    });
  } finally {
    await t.done();
  }
});

test("the place has four tabs, lists, opens a detail, queues a Reflect, and shows the model pickers", async () => {
  const t = await setup();
  let close = null;
  try {
    await put(t.home, `gateway-web/sessions/u1/${A}.json`, { archived: true, title: "Header fix", archivedAt: "2026-10-19T09:00:00.000Z" });
    await put(t.home, `reflections/${B}.json`, { session: B, title: "Done one", state: "done", costUsd: 0.04, proposal: null, findings: ["F-ff11ee", "F-ee22dd"] });
    let root;
    ({ root, close } = await opened(t, {}, (r) => r.textContent.includes("Header fix") && r.textContent.includes("Done one")));
    assert.deepEqual(root.querySelectorAll(".rfl-tab").map((b) => b.textContent), ["Conversations", "Proposals", "Findings", "Settings"]);
    assert.equal(root.querySelector("h1"), null, "the shell's place header is the only title");
    assert.ok(root.textContent.includes("Not reflected · Reflect"));
    assert.ok(root.textContent.includes("Reflected · 2 findings · $0.04"));

    buttonNamed(root, "Reflect").click();
    await until(async () => (await get(t.home, `reflections/${A}.json`))?.state === "queued");
    await until(() => root.textContent.includes("Queued"));

    root.querySelectorAll(".rfl-row-main")[0].click();
    await until(() => root.textContent.includes("← All conversations") && root.textContent.includes("Queued because you asked"));
    assert.ok(buttonNamed(root, "Cancel"));

    buttonNamed(root, "Settings").click();
    await until(() => root.querySelector("select"));
    const [model, trialModel] = root.querySelectorAll("select");
    assert.deepEqual(model.querySelectorAll("option").map((o) => o.textContent), ["Server default (fable)", "FABLE (fable)", "OPUS (opus)"]);
    assert.equal(trialModel.querySelectorAll("option")[0].textContent, "The model the conversation used");
    assert.ok(root.textContent.includes("Runs each way") && root.textContent.includes("Minutes per run"));
    const labels = root.querySelectorAll("label").map((l) => l.children.find((c) => c.tag === "#text")?.text);
    assert.ok(labels.includes("Reflection model") && labels.includes("Trial model") && !labels.includes("Model"), "the two pickers are told apart");
  } finally {
    close?.();
    await t.done();
  }
});

test("a conversation's detail shows its proposal, which opens in Proposals", async () => {
  const t = await setup();
  let close = null;
  try {
    await t.library([entry("L-aa11bb")]);
    await put(t.home, `reflections/${B}.json`, { session: B, title: "Done one", state: "done", proposal: "L-aa11bb", findings: [], costUsd: 0.04, model: "opus" });
    await put(t.home, `reflections/${B}.md`, "# Reflection on Done one");
    await put(t.home, `reflections/${B}/context/trajectory.md`, "[1] [USER] hi");
    let root;
    ({ root, close } = await opened(t, { session: B }, (r) => r.textContent.includes("Its proposal")));
    assert.ok(root.textContent.includes("Reflected · 1 proposal · $0.04"));
    assert.ok(root.textContent.includes("Skill check-the-generator"));
    buttonNamed(root, "Open evidence").click();
    assert.deepEqual(t.reg.opened.at(-1), { id: "workspace", params: { path: `reflections/${B}/context/trajectory.md`, view: "source" } });
    buttonNamed(root, "Open proposal").click();
    await until(() => root.textContent.includes("← All proposals"));
  } finally {
    close?.();
    await t.done();
  }
});

test("Proposals groups by state, with the rejected collapsed", async () => {
  const t = await setup();
  let close = null;
  try {
    await t.library([
      entry("L-aa11bb"),
      entry("L-bb22cc", { state: "trialling", trials: [T] }),
      entry("L-cc33dd", { state: "trialled", trials: [T], verdict: verdict("helped") }),
      entry("L-dd44ee", { state: "adopted", trials: [T], verdict: verdict("helped"), recheck: { reason: "@thetis/skills-thetis changed 0.10.0 → 0.10.1 since adoption", at: "2026-10-20T00:00:00.000Z" } }),
      entry("L-ee55ff", { state: "rejected", lesson: "A rejected idea." }),
      entry("L-ff66aa", { kind: "guide-note", target: "-", change: "Say which file you changed.", lesson: "Name the `dist/` file you changed." }),
    ]);
    let root;
    ({ root, close } = await opened(t, { tab: "proposals" }, (r) => r.textContent.includes("Needs a trial")));
    const heads = root.querySelectorAll(".rfl-h3").map((h) => h.textContent);
    assert.deepEqual(heads, ["Needs a trial", "Trialling", "Ready to decide", "Adopted"]);
    assert.ok(root.textContent.includes("Re-check"));
    assert.ok(root.textContent.includes("Trial: helped"));
    assert.ok(root.textContent.includes("From 1 conversation · proposed just now"), "a row says when it was proposed");
    const kinds = root.querySelectorAll(".rfl-row-kind");
    const note = kinds.find((k) => k.textContent === "Guide note");
    assert.ok(note && !note.querySelector("code"), "a guide note's kind is plain words");
    assert.equal(kinds.find((k) => k.textContent.startsWith("Skill")).querySelector("code").textContent, "check-the-generator");
    assert.equal(root.querySelectorAll("code").find((c) => c.textContent === "dist/")?.tag, "code", "backticks become code");
    assert.ok(!root.textContent.includes("`dist/`"));
    assert.ok(!root.textContent.includes("A rejected idea."), "the rejected are collapsed");
    buttonStarting(root, "▸ Rejected and retired (1)").click();
    assert.ok(root.textContent.includes("A rejected idea."));
  } finally {
    close?.();
    await t.done();
  }
});

test("a proposal before a trial: Adopt is disabled with the reason, and Run trial sends the edited request", async () => {
  const t = await setup();
  let close = null;
  try {
    await t.library([entry("L-aa11bb")]);
    let root;
    ({ root, close } = await opened(t, { proposal: "L-aa11bb" }, (r) => buttonStarting(r, "Run trial")));
    const run = buttonStarting(root, "Run trial");
    assert.equal(run.textContent, "Run trial (2 runs each, up to $5)");
    const adopt = buttonNamed(root, "Adopt");
    assert.ok(disabled(adopt), "Adopt is disabled before a trial");
    assert.equal(adopt.getAttribute("title"), "Run a trial first.");
    assert.ok(root.textContent.includes("Run a trial first."), "the reason is shown, not only hovered");
    assert.ok(buttonNamed(root, "Reject"));
    assert.ok(root.textContent.includes("+ # Check the generator") || root.textContent.includes("# Check the generator"), "the change is shown");

    assert.ok(root.textContent.includes("The trial runs on your files as they are now, not as they were in the conversation. Edit the request if it depends on how things were."));
    const box = root.querySelector("textarea");
    assert.equal(box.value, "Fix the header colour", "the opening request, without its turn-context line");
    box.value = "Fix the header colour in the source";
    box.dispatchEvent({ type: "input" });
    run.click();
    await until(() => t.started.length === 1);
    assert.deepEqual(t.started[0].request, { text: "Fix the header colour in the source" });
    await until(() => root.textContent.includes("Trialling…") && root.textContent.includes("Without the change, run 1"));
    assert.ok(root.textContent.includes("running · $0.12"));
    assert.ok(disabled(buttonNamed(root, "Adopt")), "Adopt waits for the trial");

    // Cancel trial: a refusal is shown where the button is; once the host stops it, the proposal is back.
    buttonNamed(root, "Stop trial").click();
    await until(() => root.textContent.includes("The trials host could not stop it."));
    assert.equal((await get(t.home, "reflections/library.json")).entries[0].state, "trialling");
    t.allow.cancel = true;
    buttonNamed(root, "Stop trial").click();
    await until(() => buttonStarting(root, "Run trial again"));
    assert.equal((await get(t.home, "reflections/library.json")).entries[0].state, "proposed");
    assert.ok(!buttonNamed(root, "Stop trial"));
    assert.ok(!root.textContent.includes("The trials host could not stop it."), "the old refusal is gone");
    assert.ok(disabled(buttonNamed(root, "Adopt")), "a cancelled trial judged nothing");
  } finally {
    close?.();
    await t.done();
  }
});

test("a trialled proposal that did not help reads Adopt anyway, opens its runs and judgement, and shows a refusal", async () => {
  const t = await setup();
  let close = null;
  try {
    await t.library([entry("L-aa11bb", { state: "trialled", trials: [T], verdict: verdict("no difference (one run each: weak)") })]);
    await put(t.home, `trials/${T}/trial.json`, { id: T, state: "done", costUsd: 0.5, runs: [{ arm: "base", n: 1, state: "done", costUsd: 0.2 }, { arm: "change", n: 1, state: "done", costUsd: 0.3 }] });
    await put(t.home, `reflections/trials/${T}/base-1.md`, "x");
    await put(t.home, `reflections/trials/${T}/change-1.md`, "x");
    await put(t.home, `reflections/trials/${T}/judge.md`, "# Judgement");
    // Written by hand after the proposal: adopt must refuse, and the place must say why.
    await put(t.home, "skills/check-the-generator/SKILL.md", "mine");
    let root;
    ({ root, close } = await opened(t, { proposal: "L-aa11bb" }, (r) => buttonNamed(r, "Adopt anyway")));
    assert.ok(root.textContent.includes("Trial: no difference (one run each: weak)"));
    assert.ok(root.textContent.includes("The change was seen in 2 of 2 runs with it."));
    assert.equal(buttonStarting(root, "Run trial").textContent, "Run trial again (2 runs each, up to $5)");

    root.querySelectorAll("button").filter((b) => b.textContent === "Open run")[1].click();
    assert.deepEqual(t.reg.opened.at(-1), { id: "workspace", params: { path: `reflections/trials/${T}/change-1.md`, view: "source" } });
    buttonNamed(root, "Open judgement").click();
    assert.deepEqual(t.reg.opened.at(-1), { id: "workspace", params: { path: `reflections/trials/${T}/judge.md` } });

    assert.ok(!disabled(buttonNamed(root, "Adopt anyway")));
    buttonNamed(root, "Adopt anyway").click();
    await until(() => root.textContent.includes("changed since the proposal; run the trial again"));
    assert.equal(await get(t.home, "skills/check-the-generator/SKILL.md"), "mine");
  } finally {
    close?.();
    await t.done();
  }
});

test("an adopted proposal shows its re-check with Run trial again, and Retire takes it back", async () => {
  const t = await setup();
  let close = null;
  try {
    await t.library([entry("L-aa11bb", { state: "trialled", trials: [T], verdict: verdict("helped") })]);
    let root;
    ({ root, close } = await opened(t, { proposal: "L-aa11bb" }, (r) => buttonNamed(r, "Adopt")));
    buttonNamed(root, "Adopt").click();
    await until(() => buttonNamed(root, "Retire"));
    assert.equal(await get(t.home, "skills/check-the-generator/SKILL.md"), SKILL);
    assert.ok(!buttonStarting(root, "Run trial"), "an adopted entry without a re-check offers no trial");

    const lib = await get(t.home, "reflections/library.json");
    lib.entries[0].recheck = { reason: "@thetis/skills-thetis changed 0.10.0 → 0.10.1 since adoption", at: "2026-10-20T00:00:00.000Z" };
    await put(t.home, "reflections/library.json", lib);
    buttonNamed(root, "← All proposals").click();
    await until(() => root.textContent.includes("Re-check"));
    root.querySelectorAll(".rfl-row-main")[0].click();
    await until(() => root.textContent.includes("Re-check: @thetis/skills-thetis changed 0.10.0 → 0.10.1 since adoption"));
    assert.equal(buttonStarting(root, "Run trial").textContent, "Run trial again (2 runs each, up to $5)");

    buttonNamed(root, "Retire").click();
    await until(() => root.textContent.includes("Retired."));
    assert.equal(await get(t.home, "skills/check-the-generator/SKILL.md"), null);
    assert.ok(!buttonNamed(root, "Retire") && !buttonNamed(root, "Reject") && !buttonStarting(root, "Adopt"));
  } finally {
    close?.();
    await t.done();
  }
});

test("a changed skill shows as a line diff against what was there", async () => {
  const t = await setup();
  let close = null;
  try {
    const before = SKILL.replace("find its generator and change the source.", "edit it.");
    await t.library([entry("L-aa11bb", { before })]);
    let root;
    ({ root, close } = await opened(t, { proposal: "L-aa11bb" }, (r) => r.querySelector(".rfl-diff")));
    const added = root.querySelectorAll(".is-add").map((n) => n.textContent);
    const removed = root.querySelectorAll(".is-del").map((n) => n.textContent);
    assert.deepEqual(removed, ["- Before you edit a generated file, edit it.\n"]);
    assert.deepEqual(added, ["+ Before you edit a generated file, find its generator and change the source.\n"]);
  } finally {
    close?.();
    await t.done();
  }
});

test("Findings: the intro, grouped by package, each with its chip and sightings; Close closes one", async () => {
  const t = await setup();
  let close = null;
  try {
    await put(t.home, "reflections/findings.json", {
      findings: [
        finding("F-ff11ee"),
        finding("F-ee22dd", { package: "@thetis/terminal", component: "run", what: "The prompt was cut by `stty`.", state: "possibly-fixed", since: "0.5.0" }),
        finding("F-dd33cc", { component: "write_file", what: "An old one.", state: "closed", closedAt: "2026-10-19T00:00:00.000Z" }),
      ],
    });
    let root;
    ({ root, close } = await opened(t, { tab: "findings" }, (r) => r.textContent.includes("The prompt was cut by")));
    assert.ok(root.textContent.includes("Problems with packages that reflections noticed. They are never shown to the assistant."));
    assert.deepEqual(root.querySelectorAll(".rfl-h3").map((h) => h.textContent), ["@thetis/terminal", "@thetis/tools-files"]);
    const chips = root.querySelectorAll(".rfl-state").map((c) => c.textContent);
    assert.deepEqual(chips, ["Possibly fixed in 0.5.0", "Open", "Closed"]);
    assert.ok(root.textContent.includes("version 0.4.0"));
    assert.ok(root.querySelectorAll("code").some((c) => c.textContent === "stty") && !root.textContent.includes("`stty`"), "backticks in what happened become code");
    buttonNamed(root, "Open conversation").click();
    assert.deepEqual(t.reg.conversations, [A]);

    assert.equal(root.querySelectorAll("button").filter((b) => b.textContent === "Close").length, 2, "a closed finding has no Close");
    root.querySelectorAll("button").filter((b) => b.textContent === "Close")[1].click();
    await until(async () => (await get(t.home, "reflections/findings.json")).findings.find((f) => f.id === "F-ff11ee").state === "closed");
    await until(() => root.querySelectorAll(".rfl-state").filter((c) => c.textContent === "Closed").length === 2);
  } finally {
    close?.();
    await t.done();
  }
});

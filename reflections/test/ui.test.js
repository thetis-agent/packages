// The browser module over a fake seam wired to the real command: the chip's label and visibility, the
// place's list, a detail with its buttons, Reflect from the list, and the Settings tab's model picker.
// The DOM is gateway-web's fixture, so `instanceof Node` and `classList` behave as the shell expects.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../../gateway-web/test/dom-fixture.js";
import install from "../ui/index.js";
import { uiCall } from "../index.js";
import { fakeKernel, get, put, sampleSession, tempHome, until } from "./helpers.js";

const A = "s_aaaa1111";
const B = "s_bbbb2222";

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

async function setup() {
  const { home, done } = await tempHome();
  const kernel = fakeKernel({ sessions: [sampleSession(A), sampleSession(B)] });
  const env = { cwd: home, kernel, user: "u1", role: "user", config: {} };
  const reg = { chips: {}, places: {}, opened: [] };
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
    conversation: { get current() { return current; }, watch: () => {}, open: () => {} },
    sessions: { list: () => sessions, watch: () => {} },
    open: { place: (id, params) => reg.opened.push({ id, params }) },
    toast: () => {},
  };
  install(ext);
  return { home, env, ext, reg, done, setCurrent: (s) => (current = s) };
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

test("the place lists, opens a detail, queues a Reflect, and shows the model picker", async () => {
  const t = await setup();
  let close = null;
  try {
    await put(t.home, `gateway-web/sessions/u1/${A}.json`, { archived: true, title: "Header fix", archivedAt: "2026-10-19T09:00:00.000Z" });
    await put(t.home, `reflections/${B}.json`, { session: B, title: "Done one", state: "done", costUsd: 0.04 });
    const root = el("div");
    close = t.reg.places.reflections.open(root, {});
    await until(() => root.textContent.includes("Header fix") && root.textContent.includes("Done one"));
    assert.ok(root.textContent.includes("Not reflected · Reflect"));
    assert.ok(root.textContent.includes("Reflected · no lesson · $0.04"));

    buttonNamed(root, "Reflect").click();
    await until(async () => (await get(t.home, `reflections/${A}.json`))?.state === "queued");
    await until(() => root.textContent.includes("Queued"));

    root.querySelectorAll(".rfl-row-main")[0].click();
    await until(() => root.textContent.includes("← All conversations") && root.textContent.includes("Queued because you asked"));
    assert.ok(buttonNamed(root, "Cancel"));

    buttonNamed(root, "Settings").click();
    await until(() => root.querySelector("select"));
    const options = root.querySelector("select").querySelectorAll("option").map((o) => o.textContent);
    assert.deepEqual(options, ["Server default (fable)", "FABLE (fable)", "OPUS (opus)"]);
  } finally {
    close?.();
    await t.done();
  }
});

test("a detail shows its lesson, Open evidence and Forget lesson; the Lessons tab names a forgotten source", async () => {
  const t = await setup();
  let close = null;
  try {
    const { writeLesson } = await import("../lib/lessons.js");
    const { guard, parseAnswer } = await import("../lib/prompt.js");
    const { GOOD_ANSWER } = await import("./helpers.js");
    const parsed = parseAnswer(GOOD_ANSWER);
    const { lesson } = guard(parsed, new Set([4, 5, 8, 9]));
    const id = await writeLesson(t.home, { lesson, rows: parsed.rows, conversation: { id: B, title: "Done one", project: null } });
    await writeLesson(t.home, { lesson, rows: parsed.rows, conversation: { id: "s_9999aaaa", title: "Gone", project: null } });
    await put(t.home, `reflections/${B}.json`, { session: B, title: "Done one", state: "done", lesson: id, costUsd: 0.04, model: "opus" });
    await put(t.home, `reflections/${B}.md`, "# Reflection on Done one");
    await put(t.home, `reflections/${B}/context/trajectory.md`, "[1] [USER] hi");
    const root = el("div");
    close = t.reg.places.reflections.open(root, { session: B });
    await until(() => root.textContent.includes("Its lesson") && root.textContent.includes("Before editing a generated file"));
    assert.ok(root.textContent.includes("Reflected · 1 lesson · $0.04"));
    buttonNamed(root, "Open evidence").click();
    assert.deepEqual(t.reg.opened.at(-1), { id: "workspace", params: { path: `~/reflections/${B}/context/trajectory.md` } });

    buttonNamed(root, "Lessons").click();
    await until(() => root.textContent.includes("No project") && root.textContent.includes("forgotten"));

    buttonNamed(root, "Conversations").click();
    await until(() => root.querySelectorAll(".rfl-row-main").length);
    root.querySelectorAll(".rfl-row-main").find((b) => b.textContent.includes("Done one")).click();
    await until(() => buttonNamed(root, "Forget lesson"));
    buttonNamed(root, "Forget lesson").click();
    await until(async () => (await get(t.home, `skills/${id}/SKILL.md`)) === null);
    await until(() => root.textContent.includes("Reflected · no lesson"));
  } finally {
    close?.();
    await t.done();
  }
});

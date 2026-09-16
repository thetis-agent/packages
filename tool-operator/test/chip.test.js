// The chip, against a fake seam. Three things are worth a test and the rest is drawing: that it is hidden
// entirely while nothing is pending, that a poll which stops answering while a restart is armed is read as the
// restart happening rather than as a fault, and that the waiting ends — at the deadline the page says what to
// check instead of spinning for ever. The last one is the reason this file exists: a spinner that never
// resolves is the failure this project keeps deleting, and only a test keeps a deadline real.
//
// Time is moved by replacing `Date.now`, so the ninety-second deadline is tested in under a second.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, "..", "ui");

/** Whatever the module's `pagehide` listener was, so a test can stop its poll. Node has no such global. */
let unload = () => {};
globalThis.addEventListener = (name, fn) => {
  if (name === "pagehide") unload = fn;
};

const { default: install } = await import("../ui/index.js");

/** The smallest node the chip can be drawn into: what it appends, what it hid, and the text it wrote. */
function node(tag = "div", props = {}, children = []) {
  const n = { tag, props, children: [...children], hidden: false };
  n.append = (...kids) => void n.children.push(...kids);
  n.classList = { add: (c) => void (n.props.class = `${n.props.class ?? ""} ${c}`.trim()) };
  return n;
}

const textOf = (n) => (typeof n === "object" && n ? n.children.map(textOf).join("") : String(n ?? ""));
const titles = (n) => [n.props?.title, ...n.children.filter((c) => typeof c === "object").map((c) => c.props?.title)].filter(Boolean).join(" ");

/** A seam that answers `restart-status` from `reply`, and records the toasts. */
function fakeExt(reply) {
  const toasts = [];
  const verbs = [];
  const slots = {};
  const ext = {
    dom: { el: (tag, props = {}, ...kids) => node(tag, props, kids), setHidden: (n, hide) => void (n.hidden = !!hide) },
    ui: { button: (label, opts = {}) => node("button", opts, [label]), confirm: async () => true },
    request: async (verb) => {
      verbs.push(verb);
      return reply(verb);
    },
    redraw: () => {},
    toast: (text, opts) => void toasts.push({ text, tone: opts?.tone }),
    statusbar: (id, impl) => void (slots[id] = impl),
  };
  return { ext, toasts, verbs, slots };
}

const settle = (ms = 0) => new Promise((done) => setTimeout(done, ms));

/** A restart armed now, counting down, as `restart.status` reports one. */
const pending = (extra = {}) => ({ reason: "the kernel changed", by: "root", at: Date.now(), deadlineAt: Date.now() + 120_000, ...extra });

test("it registers exactly the declared statusbar entry", async (t) => {
  const { ext, slots } = fakeExt(() => ({ data: { pending: null } }));
  install(ext);
  const stop = unload;
  t.after(() => stop());
  assert.deepEqual(Object.keys(slots), ["restart"]);
  assert.equal(typeof slots.restart.draw, "function");
});

test("nothing pending: the chip is hidden entirely, and draws nothing at all", async (t) => {
  const { ext, slots, verbs } = fakeExt(() => ({ data: { pending: null } }));
  install(ext);
  const stop = unload;
  t.after(() => stop());
  await settle();
  const n = node();
  slots.restart.draw(n);
  assert.equal(n.hidden, true, "a status bar that says there is no restart is noise");
  assert.deepEqual(n.children, []);
  assert.deepEqual(verbs, ["restart-status"]);
});

test("a restart counting down: the seconds, the reason in the title, and a Cancel button", async (t) => {
  const { ext, slots } = fakeExt(() => ({ data: { pending: pending({ firesAt: Date.now() + 8_000 }) } }));
  install(ext);
  const stop = unload;
  t.after(() => stop());
  await settle();
  const n = node();
  slots.restart.draw(n);
  assert.equal(n.hidden, false);
  assert.match(textOf(n), /Restart pending · [78]s/);
  assert.match(titles(n), /the kernel changed/);
  assert.match(titles(n), /asked by root/);
  assert.match(titles(n), /open shell sessions do not/);
  const cancel = n.children.find((c) => c.tag === "button");
  assert.ok(cancel, "the ten-second window is only a real offer if there is a button in it");
  assert.equal(textOf(cancel), "Cancel");
  assert.equal(typeof cancel.props.onClick, "function");
});

test("armed but not yet counting: it says it is waiting, and the title states the deadline branch", async (t) => {
  const { ext, slots } = fakeExt(() => ({ data: { pending: pending() } }));
  install(ext);
  const stop = unload;
  t.after(() => stop());
  await settle();
  const n = node();
  slots.restart.draw(n);
  assert.match(textOf(n), /Restart pending · waiting for turns to end/);
  assert.match(titles(n), /in at most \d+ seconds whatever happens/);
  assert.match(titles(n), /cut off/);
});

test("Cancel asks first, then sends restart-cancel and says what it called off", async (t) => {
  let armed = true;
  const { ext, slots, toasts, verbs } = fakeExt((verb) => {
    if (verb === "restart-cancel") {
      armed = false;
      return { text: "Called off the restart root asked for: the kernel changed" };
    }
    return { data: { pending: armed ? pending({ firesAt: Date.now() + 8_000 }) : null } };
  });
  install(ext);
  const stop = unload;
  t.after(() => stop());
  await settle();
  const n = node();
  slots.restart.draw(n);
  await n.children.find((c) => c.tag === "button").props.onClick();
  await settle();
  assert.ok(verbs.includes("restart-cancel"));
  assert.match(toasts.at(-1).text, /Called off the restart root asked for/);
  const after = node();
  slots.restart.draw(after);
  assert.equal(after.hidden, true, "nothing is pending again, so the chip goes away again");
});

test("the daemon goes, and the page waits — then stops, and says what to check", async (t) => {
  let answering = true;
  const { ext, slots, toasts, verbs } = fakeExt(() => {
    if (!answering) throw new Error("Failed to fetch");
    return { data: { pending: pending({ firesAt: Date.now() + 1_000 }) } };
  });
  const realNow = Date.now;
  install(ext);
  const stop = unload;
  t.after(() => {
    stop();
    Date.now = realNow;
  });
  await settle();
  answering = false;
  await settle(900); // one poll at the pending rate, which fails: the restart is happening

  const waiting = node();
  slots.restart.draw(waiting);
  assert.equal(waiting.hidden, false);
  assert.match(textOf(waiting), /^Restarting · waiting for Thetis · \d+s$/, "a lost request under an armed restart is the restart, not a fault");
  assert.match(titles(waiting), /waiting for it to answer again, for up to 90 seconds/);
  assert.equal(toasts.length, 0, "nothing is wrong yet, so nothing is said yet");

  Date.now = () => realNow() + 91_000; // past the deadline
  await settle(900);
  const lost = node();
  slots.restart.draw(lost);
  assert.equal(textOf(lost), "Thetis has not come back");
  assert.equal(toasts.at(-1).tone, "error");
  assert.equal(toasts.at(-1).text, "Thetis has not come back. It may have failed to start — check journalctl -u thetis-runtime.");
  const asked = verbs.length;
  await settle(900);
  assert.equal(verbs.length, asked, "the waiting really ends: it does not poll for ever behind a dead sentence");
  assert.equal(typeof lost.children[0].props.onClick, "function", "and a person who has looked can ask again");
});

test("a failed poll with nothing armed says nothing about a restart", async (t) => {
  let answering = false;
  const { ext, slots, toasts } = fakeExt(() => {
    if (!answering) throw new Error("Failed to fetch");
    return { data: { pending: null } };
  });
  install(ext);
  const stop = unload;
  t.after(() => stop());
  await settle();
  const down = node();
  slots.restart.draw(down);
  assert.equal(down.hidden, true, "a gateway hiccup is not a restart, and the chip does not invent one");
  assert.deepEqual(toasts, [], "and nothing is said about it either: there is nothing to say");
  answering = true;
  await settle(); // it keeps polling at the idle rate; nothing here has stopped
  assert.equal(down.hidden, true);
});

test("the browser module parses, and the entry defines install and nothing else", async () => {
  for (const file of readdirSync(UI).filter((f) => f.endsWith(".js"))) {
    const out = spawnSync(process.execPath, ["--check", join(UI, file)], { encoding: "utf8" });
    assert.equal(out.status, 0, `${file}: ${out.stderr}`);
  }
  const mod = await import("../ui/index.js");
  assert.deepEqual(Object.keys(mod), ["default"]);
  assert.equal(mod.default.name, "install");
});

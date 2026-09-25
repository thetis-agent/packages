// The floating menu a package opens through `ext.ui.menu`: what it draws, how the keyboard walks it, and
// the ways it closes, under the same small DOM the transcript tests use. Placement is checked only in
// the browser (BROWSER.md): the fake DOM has no layout, so every box here is the one a test hands it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeNode } from "./dom-fixture.js";

const { openMenu } = await import("../assets/lib/menu.js");

// A plain object rather than an `Event`: `target` is read-only on a real one, and the fake DOM reads only `type`.
const key = (name, target = null) => ({ type: "keydown", key: name, target, preventDefault() {}, stopPropagation() {} });
const tick = () => new Promise((done) => setTimeout(done, 1));

function items(ran) {
  return [
    { label: "Open", key: "Enter", icon: "M4 4h12v12H4z", run: () => ran.push("open") },
    { label: "Rename", key: "F2", run: () => ran.push("rename") },
    "-",
    { label: "Locked", disabled: true, run: () => ran.push("locked") },
    { label: "Delete…", key: "Del", danger: true, run: () => ran.push("delete") },
  ];
}

function opened(at = { x: 10, y: 10 }, opts = {}) {
  const ran = [];
  const close = openMenu(at, items(ran), opts);
  const menu = document.body.querySelector(".menu");
  return { ran, close, menu, rows: menu.querySelectorAll(".menu-item") };
}

test("the menu is drawn on the body with the shell's rows, a rule, a shortcut, a red row and a disabled one", () => {
  const { menu, rows, close } = opened();
  assert.equal(menu.getAttribute("role"), "menu");
  assert.ok(menu.classList.contains("is-floating"), "a body-level menu is positioned by script, not by the sidebar head");
  assert.deepEqual(rows.map((r) => r.querySelector(".menu-label").textContent), ["Open", "Rename", "Locked", "Delete…"]);
  assert.deepEqual(rows.map((r) => r.getAttribute("role")), ["menuitem", "menuitem", "menuitem", "menuitem"]);
  assert.equal(menu.querySelectorAll(".menu-sep").length, 1);
  assert.equal(rows[0].querySelector(".menu-text > .menu-key").textContent, "Enter");
  assert.equal(rows[0].querySelector(".menu-icon").childElementCount, 1, "an icon path is drawn as an svg");
  assert.equal(rows[1].querySelector(".menu-icon").childElementCount, 0, "a row without one keeps the column");
  assert.ok(rows[3].classList.contains("is-danger"));
  assert.equal(rows[2].getAttribute("disabled"), "");
  assert.equal(document.activeElement, rows[0], "the first enabled item takes the focus");
  close();
  assert.equal(document.body.querySelector(".menu"), null);
});

test("arrows wrap over the enabled rows, Home and End reach the ends, Enter and Space choose", () => {
  const { ran, rows, menu } = opened();
  menu.dispatchEvent(key("ArrowUp"));
  assert.equal(document.activeElement, rows[3], "up from the first wraps to the last, skipping nothing but the disabled row");
  menu.dispatchEvent(key("ArrowDown"));
  assert.equal(document.activeElement, rows[0]);
  menu.dispatchEvent(key("ArrowDown"));
  menu.dispatchEvent(key("ArrowDown"));
  assert.equal(document.activeElement, rows[3], "down skips the disabled row");
  menu.dispatchEvent(key("Home"));
  assert.equal(document.activeElement, rows[0]);
  menu.dispatchEvent(key("End"));
  assert.equal(document.activeElement, rows[3]);
  menu.dispatchEvent(key("Enter", rows[1]));
  assert.deepEqual(ran, ["rename"]);
  assert.equal(document.body.querySelector(".menu"), null, "a choice closes the menu");
  const again = opened();
  again.menu.dispatchEvent(key(" ", again.rows[3]));
  assert.deepEqual(again.ran, ["delete"]);
  const third = opened();
  third.menu.dispatchEvent(key("Enter", third.rows[2]));
  assert.deepEqual(third.ran, [], "a disabled row runs nothing");
  assert.ok(document.body.querySelector(".menu"), "and the menu stays");
  third.close();
});

test("a click chooses; Escape closes on the capture phase and stops there; a click elsewhere closes; one menu at a time", async () => {
  const anchor = new FakeNode("button");
  document.body.append(anchor);
  let closed = 0;
  const first = opened(anchor, { onClose: () => closed++ });
  first.rows[0].click();
  assert.deepEqual(first.ran, ["open"]);
  assert.equal(closed, 1);
  assert.equal(document.activeElement, anchor, "the anchor gets the focus back");

  const second = opened(anchor, { onClose: () => closed++ });
  const escape = key("Escape");
  let stopped = false;
  escape.stopPropagation = () => { stopped = true; };
  document.dispatchEvent(escape);
  assert.equal(stopped, true, "the place and the dock under it never hear the Escape");
  assert.equal(document.body.querySelector(".menu"), null);
  assert.equal(closed, 2);
  assert.deepEqual(second.ran, []);

  const third = opened({ x: 5, y: 5 }, { onClose: () => closed++ });
  await tick(); // the click that opened a menu must not close it on its way up
  const elsewhere = new FakeNode("div");
  document.body.append(elsewhere);
  elsewhere.click();
  assert.equal(document.body.querySelector(".menu"), null);
  assert.equal(closed, 3);
  assert.deepEqual(third.ran, []);

  opened({ x: 5, y: 5 }, { onClose: () => closed++ });
  const fifth = opened({ x: 6, y: 6 }, { onClose: () => closed++ });
  assert.equal(document.body.querySelectorAll(".menu").length, 1, "opening another closed the first");
  assert.equal(closed, 4);
  fifth.close();
  assert.equal(closed, 5);
  fifth.close();
  assert.equal(closed, 5, "closing twice tells nobody twice");
  anchor.remove();
});

test("an empty list still opens, with the sentence, and a rule alone draws no rows", () => {
  const close = openMenu({ x: 0, y: 0 }, []);
  const menu = document.body.querySelector(".menu");
  assert.equal(menu.querySelector(".menu-empty").textContent, "Nothing to do here.");
  assert.equal(menu.querySelectorAll(".menu-item").length, 0);
  close();
});

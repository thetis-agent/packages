/* Forget: the dialog that removes a conversation for good, and the receipt it leaves. Archive puts a
 * conversation away and Undo brings it back; this is the other thing, and the dialog says so before
 * anything else. It asks the server what would go (`forget/preview`) and shows exactly that: the title,
 * "This cannot be undone.", the conversation with its subagents and attachments, what each installed
 * package would remove — an optional part as a checkbox at the package's default — and a Kept list of
 * what stays whatever happens. A package that blocks the forget says why and the button stays off; a
 * running turn turns the button into Stop and forget. A conversation with three turns or more asks for
 * its title typed out, so a slip of the menu is never enough.
 *
 * There is no undo toast afterwards, because there is nothing to undo into. The receipt is a notice card
 * (Removed / Kept) that stays until it is dismissed, so what the server actually did is what is on screen.
 * One native <dialog>: it is modal, keeps the focus inside, and closes on Escape; `.forget[open]` is in
 * layers.js's OWN_ESCAPE so that Escape does not also close the dock under it. */

import { api } from "../lib/api.js";
import { el } from "../lib/dom.js";
import { notice } from "../lib/notice.js";
import { toast } from "../lib/toast.js";

/** Under this many turns the title need not be typed: there is little in the conversation to lose. The server holds the same line. */
export const TITLE_FREE_TURNS = 3;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Each package's optional items at their defaults: `{ "<package>": { "<item id>": boolean } }`, what the dialog starts from. */
export function defaultOptions(preview) {
  const out = {};
  for (const hook of preview.hooks ?? []) {
    for (const item of hook.items ?? []) {
      if (!item.optional) continue;
      (out[hook.package] ??= {})[item.id] = item.default ?? false;
    }
  }
  return out;
}

/** One sentence for the conversation and what is under it: the subagents and the attachments. */
export function scopeLine(preview) {
  const children = Math.max(0, (preview.subtree?.length ?? 1) - 1);
  const parts = [children ? `This conversation and its ${plural(children, "subagent conversation")}` : "This conversation"];
  if (preview.attachments) parts.push(`with ${plural(preview.attachments, "attachment")}`);
  return `${parts.join(", ")}.`;
}

/** Every package's items, each with the key its checkbox goes by when it is optional. */
function itemsOf(preview, options) {
  return (preview.hooks ?? []).flatMap((hook) =>
    (hook.items ?? []).map((item) => ({ label: item.label, key: item.optional ? `${hook.package}#${item.id}` : null, ticked: !item.optional || Boolean(options[hook.package]?.[item.id]) }))
  );
}

/** What goes besides the conversation: every package's fixed items, and the optional ones that are ticked. */
export function removedLines(preview, options) {
  return itemsOf(preview, options).filter((i) => i.ticked).map((i) => i.label);
}

/** What stays: the optional items left unticked, then what the server says is always true. */
export function keptLines(preview, options) {
  return [...itemsOf(preview, options).filter((i) => !i.ticked).map((i) => i.label), ...(preview.kept ?? [])];
}

/**
 * The button: what it says and whether it may be pressed. A block keeps it off whatever was typed; with
 * three turns or more the typed title must match once trimmed, "..." standing for "…", as the server checks it.
 */
const titleKey = (title) => title.trim().replace(/\u2026/g, "...").replace(/\s+/g, " ");

export function forgetState(preview, typed = "") {
  const blocked = (preview.hooks ?? []).find((hook) => hook.block)?.block ?? null;
  const needsTitle = preview.turns >= TITLE_FREE_TURNS;
  const matches = !needsTitle || titleKey(typed) === titleKey(String(preview.title ?? ""));
  return { blocked, needsTitle, label: preview.running ? "Stop and forget" : "Forget", enabled: !blocked && matches };
}

function list(lines, cls) {
  return el("ul", { class: `forget-list${cls ? ` ${cls}` : ""}` }, lines.map((line) => el("li", {}, line)));
}

function section(label, ...children) {
  return el("div", { class: "forget-section" }, el("div", { class: "forget-label" }, label), ...children);
}

/**
 * Shows the receipt of a forget as a notice card: what went and what stayed, as the server said it. It
 * stays until it is dismissed, so it can be read after the tab it was about has closed.
 */
export function showReceipt(receipt, title) {
  const body = el(
    "div",
    { class: "forget-receipt" },
    receipt.removed?.length ? section("Removed", list(receipt.removed)) : null,
    receipt.kept?.length ? section("Kept", list(receipt.kept)) : null
  );
  return notice(`forget-${receipt.id}`, { title: `Forgotten: ${title}`, tone: "ok", body });
}

/**
 * Asks what forgetting `id` would do, then shows the dialog. `onForgotten(receipt)` runs once the server
 * has answered, before the receipt is shown: the page closes the conversation's tabs and refreshes its
 * list there. Answers the receipt, or null when nothing was forgotten (refused, cancelled, failed).
 */
export async function openForget(id, { onForgotten } = {}) {
  let preview;
  try {
    preview = await api(`/api/sessions/${id}/forget/preview`, { method: "POST", body: {} });
  } catch (err) {
    toast(err.message, { tone: "error" });
    return null;
  }
  return new Promise((done) => {
    const options = defaultOptions(preview);
    const removed = list([]);
    const kept = list([], "is-kept");
    const error = el("p", { class: "forget-error", role: "alert", hidden: true });
    const go = el("button", { type: "button", class: "btn is-warn forget-go" });
    const input = el("input", { type: "text", class: "input forget-confirm", "aria-label": "The conversation's title", autocomplete: "off", spellcheck: "false" });
    const state = () => forgetState(preview, input.value ?? "");

    // An optional part is shown once: as its checkbox, inside whichever list it is in now. Ticking it moves
    // it from Kept to Removed, so the line and the control are never two things saying the same sentence.
    const boxes = new Map();
    (preview.hooks ?? []).forEach((hook) =>
      (hook.items ?? []).filter((item) => item.optional).forEach((item) => {
        const box = el("input", { type: "checkbox", class: "forget-check", "data-package": hook.package, "data-item": item.id });
        box.checked = Boolean(options[hook.package]?.[item.id]);
        box.addEventListener("change", () => {
          options[hook.package][item.id] = Boolean(box.checked);
          draw();
        });
        boxes.set(`${hook.package}#${item.id}`, el("label", { class: "forget-option" }, box, el("span", {}, item.label)));
      })
    );
    const line = (i) => el("li", {}, i.key ? boxes.get(i.key) : i.label);

    function draw() {
      const now = state();
      const items = itemsOf(preview, options);
      removed.replaceChildren(el("li", {}, scopeLine(preview)), ...items.filter((i) => i.ticked).map(line));
      kept.replaceChildren(...items.filter((i) => !i.ticked).map(line), ...(preview.kept ?? []).map((text) => el("li", {}, text)));
      go.textContent = now.label;
      go.disabled = !now.enabled;
    }

    let settled = false;
    const node = el(
      "dialog",
      { class: "forget", "aria-label": "Forget this conversation" },
      el("h2", { class: "forget-title" }, `Forget “${preview.title}”?`),
      el("p", { class: "forget-warn" }, "This cannot be undone."),
      section("Removed", removed),
      section("Kept", kept),
      preview.running ? el("p", { class: "forget-running" }, "A turn is running in this conversation. It will be stopped first.") : null,
      state().blocked ? el("p", { class: "forget-block", role: "alert" }, state().blocked) : null,
      state().needsTitle ? el("label", { class: "field forget-field" }, el("span", { class: "field-label" }, "Type the title to confirm"), input) : null,
      error,
      el("div", { class: "forget-actions" }, el("button", { type: "button", class: "btn is-quiet forget-cancel", onClick: () => node.close() }, "Cancel"), go)
    );

    node.addEventListener("close", () => {
      node.remove();
      if (!settled) done(null);
    });
    input.addEventListener("input", draw);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && state().enabled) {
        event.preventDefault();
        go.click();
      }
    });

    go.addEventListener("click", async () => {
      if (!state().enabled || go.getAttribute("aria-busy") === "true") return;
      go.disabled = true;
      go.setAttribute("aria-busy", "true");
      error.setAttribute("hidden", "");
      try {
        const receipt = await api(`/api/sessions/${id}/forget`, { method: "POST", body: { confirm: input.value ?? "", stop: Boolean(preview.running), options } });
        settled = true;
        node.close();
        try {
          await onForgotten?.(receipt);
        } catch (err) {
          console.error("after a forget:", err);
        }
        showReceipt(receipt, preview.title);
        done(receipt);
      } catch (err) {
        error.textContent = err.message;
        error.removeAttribute("hidden");
        go.removeAttribute("aria-busy");
        go.disabled = !state().enabled;
      }
    });

    draw();
    document.body.append(node);
    node.showModal();
    (state().needsTitle && !state().blocked ? input : node.querySelector(".forget-cancel"))?.focus();
  });
}

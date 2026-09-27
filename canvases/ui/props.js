/* The properties panel: one field per prop the selected artboard declares, drawn from the declaration the
 * gateway read out of its HTML, with the overrides the index holds. Typing posts the value into the frame
 * at once (`onLive`) and saves it a moment later (`onSave`, one patch per artboard, debounced); a reset
 * glyph beside an overridden field drops the override. Declaration problems are listed at the foot. */

import { X } from "./icons.js";

const SAVE_MS = 400;

export function mountProps(ext, root, { onLive, onSave }) {
  const { el, icon, clear } = ext.dom;
  const head = el("div", { class: "cv-props-head" });
  const body = el("div", { class: "cv-props-body" });
  root.append(head, body);
  let shown = null; // { file, decl, values }
  let timer = null;

  function schedule(file, values) {
    clearTimeout(timer);
    timer = setTimeout(() => onSave(file, values), SAVE_MS);
  }

  function set(key, value) {
    if (!shown) return;
    const values = { ...shown.values, [key]: value };
    shown.values = values;
    onLive(shown.file, values);
    schedule(shown.file, values);
    draw();
  }

  function reset(key) {
    if (!shown) return;
    const values = { ...shown.values };
    delete values[key];
    shown.values = values;
    onLive(shown.file, values);
    clearTimeout(timer);
    onSave(shown.file, { [key]: null });
    draw();
  }

  function field(key, spec, value, overridden) {
    const id = `cv-prop-${key}`;
    let input;
    if (spec.editor === "color") {
      const hex = typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";
      const swatch = el("input", { type: "color", id, value: hex, "aria-label": `${spec.label ?? key} color`, onInput: (e) => set(key, e.target.value) });
      const text = el("input", { type: "text", class: "cv-prop-hex", value: String(value ?? ""), spellcheck: "false", "aria-label": `${spec.label ?? key} as text`, onChange: (e) => set(key, e.target.value.trim()) });
      input = el("span", { class: "cv-prop-color" }, swatch, text);
    } else if (spec.editor === "toggle") {
      input = el("input", { type: "checkbox", id, checked: Boolean(value), onChange: (e) => set(key, e.target.checked) });
    } else if (spec.editor === "select") {
      input = el("select", { id, onChange: (e) => set(key, e.target.value) }, ...spec.options.map((o) => el("option", { value: o, selected: o === value }, o)));
    } else if (spec.editor === "number") {
      input = el("input", { type: "number", id, value: String(value ?? ""), min: spec.min, max: spec.max, step: spec.step, onInput: (e) => { const n = Number(e.target.value); if (Number.isFinite(n)) set(key, n); } });
    } else {
      input = el("input", { type: "text", id, value: String(value ?? ""), onInput: (e) => set(key, e.target.value) });
    }
    return el(
      "div",
      { class: `cv-prop${overridden ? " is-set" : ""}` },
      el("label", { class: "cv-prop-label", for: id }, spec.label ?? key),
      el("div", { class: "cv-prop-input" }, input, overridden ? el("button", { type: "button", class: "icon-btn sm cv-prop-reset", title: "Back to the artboard's default", "aria-label": `Reset ${spec.label ?? key}`, onClick: () => reset(key) }, icon(X, { size: 10, width: 2 })) : null)
    );
  }

  function draw() {
    clear(head);
    clear(body);
    if (!shown) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    head.append(el("span", { class: "cv-props-title" }, shown.title || shown.file), el("span", { class: "cv-props-note" }, "Properties"));
    const keys = Object.keys(shown.decl ?? {});
    if (!keys.length) body.append(el("div", { class: "cv-props-empty" }, "This artboard declares no properties. An artboard declares them in a #canvas-props block; ask for some in a chat."));
    for (const key of keys) {
      const spec = shown.decl[key];
      const overridden = Object.prototype.hasOwnProperty.call(shown.values, key);
      body.append(field(key, spec, overridden ? shown.values[key] : spec.default, overridden));
    }
    if (shown.problems?.length) body.append(el("ul", { class: "cv-props-problems" }, ...shown.problems.map((p) => el("li", {}, p))));
  }

  draw();
  return {
    show({ file, title, decl, values, problems }) {
      shown = { file, title, decl: decl ?? null, values: { ...(values ?? {}) }, problems: problems ?? [] };
      draw();
    },
    hide() {
      shown = null;
      draw();
    },
    shown: () => shown?.file ?? null,
    dispose() {
      clearTimeout(timer);
    },
  };
}

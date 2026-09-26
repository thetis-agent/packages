/* The browser side of @thetis/effort: a pill in the composer's tools row, beside the model picker, that
 * says how hard the model thinks in the open conversation and opens a list to change it. The list is
 * cut to what the conversation's model accepts: `effort-models` answers each thinking model's reasoning
 * descriptor once per page, the conversation's model comes from `ext.sessions` (the shell keeps it on
 * each session) or the default the same answer names, and a model with no descriptor does not think, so
 * the pill hides rather than offer a choice that changes nothing. "Off" is left out for a model whose
 * thinking is mandatory. Everything is built with `ext.dom.el`; the `.ef-` rules in index.css draw it
 * from the shell's tokens. No inline style: the page's CSP forbids it. */

const STATE = "effort-state";
const SET = "effort-set";
const MODELS = "effort-models";
const CARET = ["M5 8l5 5 5-5"];
/** Every effort the gateway knows, highest first; the model's descriptor narrows it. */
const EFFORTS = ["max", "xhigh", "high", "medium", "low", "minimal", "none"];
const WORDS = { max: "Max", xhigh: "Extra high", high: "High", medium: "Medium", low: "Low", minimal: "Minimal", none: "Off" };
const NOTES = {
  max: "Nearly all of the output allowance may go to thinking",
  xhigh: "As much thinking as max on most models",
  high: "Long thinking before each answer",
  medium: "A moderate amount of thinking",
  low: "A little thinking; faster and cheaper",
  minimal: "The least thinking the model allows",
  none: "No thinking at all",
};

export default function install(ext) {
  const { el, icon, setHidden } = ext.dom;
  const states = new Map(); // session -> { effort, remembered } from the last effort-state answer
  let models = null; // { model, reasoning: { id -> descriptor } } from effort-models, once
  let modelsLoading = null;
  let stateLoading = null;
  let open = false;
  let menu = null;
  let stopOutside = null;

  const labelEl = el("span", { class: "ef-label" });
  const button = el(
    "button",
    { type: "button", class: "ef-btn", title: "How hard the model thinks in this conversation", "aria-haspopup": "listbox", "aria-expanded": "false", onClick: () => (open ? close() : show()) },
    el("span", { class: "ef-dot" }),
    labelEl,
    icon(CARET, { size: 10, width: 2 }),
  );
  button.querySelector("svg").classList.add("ef-caret");
  const node = el("div", { class: "ef-pill", hidden: true }, button);

  // ---- what is known ----

  const current = () => ext.conversation.current;
  const session = (id) => (ext.sessions.list() ?? []).find((s) => s.id === id) ?? null;
  const modelOf = (id) => session(id)?.model || models?.model || "";
  /** The descriptor of the conversation's model: an object when it thinks, null when it does not, undefined when nothing is known yet. */
  function descriptor(id) {
    if (!models) return undefined;
    const model = modelOf(id);
    if (!model) return undefined;
    return models.reasoning[model] ?? null;
  }
  /** The efforts the conversation's model takes, highest first. */
  function offered(id) {
    const d = descriptor(id);
    let list = Array.isArray(d?.supportedEfforts) && d.supportedEfforts.length ? d.supportedEfforts.filter((e) => EFFORTS.includes(e)) : EFFORTS.slice();
    if (d?.mandatory) list = list.filter((e) => e !== "none");
    else if (!list.includes("none")) list.push("none");
    return list;
  }
  const effective = (id) => { const s = states.get(id); return s ? s.effort ?? s.remembered ?? null : null; };

  // ---- the requests ----

  function loadModels() {
    if (models || modelsLoading) return modelsLoading ?? Promise.resolve();
    modelsLoading = ext
      .request(MODELS, {})
      .then(({ data }) => { models = { model: data?.model ?? "", reasoning: data?.reasoning ?? {} }; })
      .catch((err) => { ext.toast(`The efforts could not be listed: ${err.message}`, { tone: "error" }); })
      .finally(() => { modelsLoading = null; draw(); });
    return modelsLoading;
  }

  function loadState(id = current()) {
    if (!id || !session(id)) return Promise.resolve();
    stateLoading = ext
      .request(STATE, { session: id })
      .then(({ data }) => { states.set(id, { effort: data?.effort ?? null, remembered: data?.remembered ?? null }); })
      .catch((err) => { ext.toast(`The effort could not be read: ${err.message}`, { tone: "error" }); })
      .finally(() => { stateLoading = null; draw(); });
    return stateLoading;
  }

  async function choose(id, effort) {
    const before = states.get(id);
    states.set(id, { effort: effort || null, remembered: effort || null });
    draw();
    try {
      const { data } = await ext.request(SET, { session: id, args: { session: id, effort } });
      states.set(id, { effort: data?.effort ?? null, remembered: data?.remembered ?? null });
      ext.toast(effort ? `This conversation now thinks at ${WORDS[effort].toLowerCase()} effort.` : "This conversation now thinks at the default effort.", { tone: "good" });
    } catch (err) {
      if (before) states.set(id, before); else states.delete(id);
      ext.toast(`The effort was not changed: ${err.message}`, { tone: "error" });
    }
    draw();
  }

  // ---- drawing ----

  function draw() {
    const id = current();
    const d = id ? descriptor(id) : undefined;
    // Hidden with no conversation, on a subagent's tab (not in the list), and for a model that does not think.
    const hide = !id || !session(id) || d === null || d === undefined;
    setHidden(node, hide);
    if (hide) { if (open) close(); return; }
    const effort = effective(id);
    labelEl.textContent = effort ? WORDS[effort] ?? effort : d?.defaultEffort ? `${WORDS[d.defaultEffort] ?? d.defaultEffort} · default` : "Effort";
    node.classList.toggle("is-chosen", Boolean(effort));
    node.classList.toggle("is-off", effort === "none");
    if (open) fill();
  }

  function item(effort, { label, note, selected, onPick }) {
    return el(
      "button",
      {
        type: "button",
        role: "option",
        class: `ef-item${selected ? " is-selected" : ""}`,
        "aria-selected": selected ? "true" : "false",
        "data-effort": effort,
        onClick: (event) => { event.stopPropagation(); close(); onPick(); },
      },
      el("span", { class: "ef-item-label" }, label),
      note ? el("span", { class: "ef-item-note" }, note) : null,
    );
  }

  function fill() {
    if (!menu) return;
    const id = current();
    const d = descriptor(id) ?? {};
    const state = states.get(id) ?? { effort: null, remembered: null };
    const chosen = state.effort ?? "";
    menu.replaceChildren();
    const fallback = d.defaultEnabled === false || d.defaultEffort === "none" ? "off unless the deployment asks" : d.defaultEffort ? `${WORDS[d.defaultEffort]?.toLowerCase() ?? d.defaultEffort} on this model` : "whatever the deployment or the model decides";
    menu.append(item("", { label: "Default", note: state.remembered && !chosen ? `Inherits ${WORDS[state.remembered]?.toLowerCase() ?? state.remembered}, your last choice` : `Nothing sent: ${fallback}`, selected: !chosen, onPick: () => choose(id, "") }));
    for (const effort of offered(id)) {
      menu.append(item(effort, { label: WORDS[effort] ?? effort, note: NOTES[effort], selected: chosen === effort, onPick: () => choose(id, effort) }));
    }
  }

  const items = () => [...(menu?.querySelectorAll(".ef-item") ?? [])];

  function navigate(event) {
    if (event.key === "Escape") { event.stopPropagation(); return close(true); }
    const list = items();
    if (!list.length) return;
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const at = list.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : at < 0 ? 0 : (at + step + list.length) % list.length;
    list[next]?.focus();
  }

  function show() {
    if (open) return;
    open = true;
    menu = el("div", { class: "ef-menu", role: "listbox", "aria-label": "Effort", onKeydown: navigate });
    fill();
    node.append(menu);
    node.classList.add("is-open");
    button.setAttribute("aria-expanded", "true");
    const outside = (event) => { if (!node.contains(event.target)) close(false); };
    document.addEventListener("pointerdown", outside, true);
    stopOutside = () => document.removeEventListener("pointerdown", outside, true);
    (menu.querySelector(".ef-item.is-selected") ?? items()[0])?.focus();
  }

  function close(refocus = true) {
    if (!open) return;
    const inside = menu?.contains(document.activeElement);
    stopOutside?.();
    stopOutside = null;
    menu?.remove();
    menu = null;
    open = false;
    node.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
    if (refocus && inside) button.focus();
  }

  // ---- wiring ----

  ext.composer("effort", {
    mount: (root) => {
      root.append(node);
      loadModels();
      loadState();
      draw();
    },
  });
  ext.conversation.watch(() => { close(false); loadModels(); loadState(); draw(); });
  ext.sessions.watch(() => draw()); // the model of a conversation changed: the list, and whether the pill shows, follow
}

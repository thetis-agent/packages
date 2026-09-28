/* Models: the default model and everything the providers serve. An admin reads the system's providers and
 * makes any listed model the default (Make default: the host writes the config file's `model` and it is read
 * again, live from the next turn). A user reads what their own workspace can call (their own providers
 * first, then the system's), with the models of a provider installed in their own workspace marked as
 * theirs; their own default for new chats is the picker's, which remembers the model they chose last. */

import { failedCard, toastError } from "./failed.js";

const SHOWN_LIMIT = 300;

export function mountModels(ext, root, who = {}) {
  const mine = who.role === "user";
  const { el, clear } = ext.dom;
  const { badge, busy, button, card, confirm, heading, kv, put, table } = ext.ui;
  let data = { model: "", models: [], own: [] };
  let query = "";
  let failed = null;
  const wrap = el("div", { class: "panel-col ua-models" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  const filter = el("input", { class: "input", type: "search", placeholder: "Filter models", "aria-label": "Filter models", onInput: (e) => { query = e.target.value.trim().toLowerCase(); draw(); } });

  async function load() {
    const stop = busy(wrap, "Asking the providers…");
    try {
      const out = await ext.request("models");
      data = { model: out.data?.model ?? "", models: Array.isArray(out.data?.models) ? out.data.models : [], own: Array.isArray(out.data?.own) ? out.data.own : [] };
      failed = null;
    } catch (err) {
      failed = err;
    } finally {
      stop();
    }
    draw();
  }

  async function makeDefault(anchor, id) {
    if (!id) return void ext.toast("Type or pick a model id first.", { tone: "warn" });
    if (id === data.model) return void ext.toast(`${id} is the default already.`);
    const listed = data.models.some((m) => m.id === id);
    const ok = await confirm(anchor, { title: "Make this the default?", lines: [["model", id], ["was", data.model || "—"]], note: `${listed ? "" : "No provider lists this id now, so a chat that starts with it fails until one does. "}New chats start with it from the next message, for everyone who has not picked a model of their own. Chats that already chose a model keep theirs. The server's settings file is written and read again; nothing restarts.`, confirmLabel: "Make default", tone: listed ? "primary" : "warn" });
    if (!ok) return;
    anchor.disabled = true;
    try {
      const out = await ext.request("model-set", { args: { model: id } });
      const boot = out?.data?.reload?.boot ?? [];
      ext.toast(`${out?.data?.model ?? id} is the default model now.${boot.length ? ` The file also changed ${boot.join(", ")}, which takes a restart.` : ""}`, { tone: boot.length ? "warn" : "good" });
    } catch (err) {
      anchor.disabled = false;
      return void toastError(ext, err, "The default model could not be set");
    }
    await load();
  }

  function draw() {
    clear(wrap);
    if (failed) return void put(wrap, heading("Models"), failedCard(ext, "The models", failed, { admin: !mine, retry: () => void load() }));
    const byProvider = new Map();
    for (const m of data.models) byProvider.set(m.provider ?? "?", (byProvider.get(m.provider ?? "?") ?? 0) + 1);
    const shown = data.models.filter((m) => !query || m.id.toLowerCase().includes(query) || (m.name ?? "").toLowerCase().includes(query)).slice(0, SHOWN_LIMIT);
    const own = new Set(data.own);
    const yours = (m) => (own.has(m.provider) ? el("span", {}, " ", badge("yours", "ok")) : null);
    // A default no provider lists still starts every chat, and every such chat fails: say so where it is shown.
    const unserved = data.model && data.models.length && !data.models.some((m) => m.id === data.model) ? el("span", {}, " ", badge("no provider lists it", "warn")) : null;
    const current = el("span", {}, el("code", {}, data.model || "—"), unserved);
    // An admin changes it here: any id the providers list (suggested as it is typed), or one typed whole.
    const ids = el("datalist", { id: "ua-model-ids" }, ...data.models.map((m) => el("option", { value: m.id }, m.name ?? "")));
    const pick = el("input", { class: "input", type: "text", list: "ua-model-ids", placeholder: "provider/model", "aria-label": "New default model", spellcheck: "false", autocomplete: "off", onKeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); void makeDefault(setBtn, pick.value.trim()); } } });
    const setBtn = button("Make default", { tone: "primary", title: "Start new chats with this model", onClick: () => void makeDefault(setBtn, pick.value.trim()) });
    const change = mine ? null : el("div", { class: "toolbar ua-model-set" }, pick, ids, setBtn);
    put(
      wrap,
      mine
        ? card("Default model", kv([["model", current], ["providers", el("span", {}, [...byProvider].map(([p, n]) => `${p} (${n})${own.has(p) ? ", yours" : ""}`).join(", ") || "none")]]), el("p", { class: "text-faint" }, "The picker in the composer chooses a model per conversation; this is the default a new one starts with. A provider installed in your own space serves only you, and its models are marked yours."))
        : card("Default model", kv([["model", current], ["providers", el("span", {}, [...byProvider].map(([p, n]) => `${p} (${n})`).join(", ") || "none")]]), change, el("p", { class: "text-faint" }, "What a new chat starts with until its person picks a model; the picker then remembers theirs. Changing it here changes it for everyone, from the next message. An extension can set the model for one person; a provider installed in a person's own space serves only them.")),
      el("div", { class: "toolbar" }, heading(mine ? "Models you can use" : "Models the providers serve", `${data.models.length} listed`), el("div", { class: "toolbar-gap" }), filter),
      table(
        [
          { key: "id", label: "Model", render: (m) => el("span", {}, el("code", {}, m.id), m.id === data.model ? el("span", {}, " ", badge("default", "accent")) : null, mine ? yours(m) : null) },
          { key: "name", label: "Name", render: (m) => el("span", { class: "text-dim" }, m.name ?? "") },
          { key: "provider", label: "Provider", render: (m) => el("span", { class: "text-dim" }, m.provider ?? "") },
        ],
        shown,
        { rowKey: (m) => `${m.provider ?? ""} ${m.id}`, empty: data.models.length ? "No model matches." : mine ? "No provider serves your space yet." : "No model provider is installed for everyone yet." }
      ),
      data.models.length > SHOWN_LIMIT && shown.length === SHOWN_LIMIT ? el("p", { class: "text-faint" }, `Showing the first ${SHOWN_LIMIT}. Filter to narrow the list.`) : null
    );
  }

  void load();
}

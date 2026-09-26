/* Models: the default model and everything the providers serve. Read-only: the default is set in the
 * configuration file, and a package step can set call.model for one person. An admin reads the system's
 * providers; a user reads what their own workspace can call (their own providers first, then the
 * system's), with the models of a provider installed in their own workspace marked as theirs. */

const SHOWN_LIMIT = 300;

export function mountModels(ext, root, who = {}) {
  const mine = who.role === "user";
  const { el, clear } = ext.dom;
  const { badge, busy, card, heading, kv, put, table } = ext.ui;
  let data = { model: "", models: [], own: [] };
  let query = "";
  const wrap = el("div", { class: "panel-col ua-models" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  const filter = el("input", { class: "input", type: "search", placeholder: "Filter models", "aria-label": "Filter models", onInput: (e) => { query = e.target.value.trim().toLowerCase(); draw(); } });

  async function load() {
    const stop = busy(wrap, "Asking the providers…");
    try {
      const out = await ext.request("models");
      data = { model: out.data?.model ?? "", models: Array.isArray(out.data?.models) ? out.data.models : [], own: Array.isArray(out.data?.own) ? out.data.own : [] };
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
    draw();
  }

  function draw() {
    clear(wrap);
    const byProvider = new Map();
    for (const m of data.models) byProvider.set(m.provider ?? "?", (byProvider.get(m.provider ?? "?") ?? 0) + 1);
    const shown = data.models.filter((m) => !query || m.id.toLowerCase().includes(query) || (m.name ?? "").toLowerCase().includes(query)).slice(0, SHOWN_LIMIT);
    const own = new Set(data.own);
    const yours = (m) => (own.has(m.provider) ? el("span", {}, " ", badge("yours", "ok")) : null);
    put(
      wrap,
      mine
        ? card("Default model", kv([["model", el("code", {}, data.model || "—")], ["providers", el("span", {}, [...byProvider].map(([p, n]) => `${p} (${n})${own.has(p) ? ", yours" : ""}`).join(", ") || "none")]]), el("p", { class: "text-faint" }, "The picker in the composer chooses a model per conversation; this is the default a new one starts with. A provider installed in your own workspace serves only you, and its models are marked yours."))
        : card("Default model", kv([["model", el("code", {}, data.model || "—")], ["providers", el("span", {}, [...byProvider].map(([p, n]) => `${p} (${n})`).join(", ") || "none")]]), el("p", { class: "text-faint" }, "The default is the config field model. A package step can set call.model for one person; a provider installed in a person's own space serves only them.")),
      el("div", { class: "toolbar" }, heading(mine ? "Models you can use" : "Models the providers serve", `${data.models.length} listed`), el("div", { class: "toolbar-gap" }), filter),
      table(
        [
          { key: "id", label: "Model", render: (m) => el("span", {}, el("code", {}, m.id), m.id === data.model ? el("span", {}, " ", badge("default", "accent")) : null, mine ? yours(m) : null) },
          { key: "name", label: "Name", render: (m) => el("span", { class: "text-dim" }, m.name ?? "") },
          { key: "provider", label: "Provider", render: (m) => el("span", { class: "text-dim" }, m.provider ?? "") },
        ],
        shown,
        { rowKey: (m) => `${m.provider ?? ""} ${m.id}`, empty: data.models.length ? "No model matches." : mine ? "No provider serves your workspace yet." : "No provider is installed in the system userspace." }
      ),
      data.models.length > SHOWN_LIMIT && shown.length === SHOWN_LIMIT ? el("p", { class: "text-faint" }, `Showing the first ${SHOWN_LIMIT}. Filter to narrow the list.`) : null
    );
  }

  void load();
}

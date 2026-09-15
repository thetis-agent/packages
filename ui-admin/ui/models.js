/* Models: the default model and everything the providers serve. Read-only: the default is set in the
 * configuration file, and a package step can set call.model for one person. */

const SHOWN_LIMIT = 300;

export function mountModels(ext, root) {
  const { el, clear } = ext.dom;
  const { badge, busy, card, heading, kv, put, table } = ext.ui;
  let data = { model: "", models: [] };
  let query = "";
  const wrap = el("div", { class: "panel-col ua-models" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  const filter = el("input", { class: "input", type: "search", placeholder: "Filter models", "aria-label": "Filter models", onInput: (e) => { query = e.target.value.trim().toLowerCase(); draw(); } });

  async function load() {
    const stop = busy(wrap, "Asking the providers…");
    try {
      const out = await ext.request("models");
      data = { model: out.data?.model ?? "", models: Array.isArray(out.data?.models) ? out.data.models : [] };
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
    put(
      wrap,
      card("Default model", kv([["model", el("code", {}, data.model || "—")], ["providers", el("span", {}, [...byProvider].map(([p, n]) => `${p} (${n})`).join(", ") || "none")]]), el("p", { class: "text-faint" }, "The default is the config field model. A package step can set call.model for one person; a provider installed in a person's own space serves only them.")),
      el("div", { class: "toolbar" }, heading("Models the providers serve", `${data.models.length} listed`), el("div", { class: "toolbar-gap" }), filter),
      table(
        [
          { key: "id", label: "Model", render: (m) => el("span", {}, el("code", {}, m.id), m.id === data.model ? el("span", {}, " ", badge("default", "accent")) : null) },
          { key: "name", label: "Name", render: (m) => el("span", { class: "text-dim" }, m.name ?? "") },
          { key: "provider", label: "Provider", render: (m) => el("span", { class: "text-dim" }, m.provider ?? "") },
        ],
        shown,
        { rowKey: (m) => m.id, empty: data.models.length ? "No model matches." : "No provider is installed in the system userspace." }
      ),
      data.models.length > SHOWN_LIMIT && shown.length === SHOWN_LIMIT ? el("p", { class: "text-faint" }, `Showing the first ${SHOWN_LIMIT}. Filter to narrow the list.`) : null
    );
  }

  void load();
}

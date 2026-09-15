/* Overview: how the installation is set up, as the kernel reports it with secrets hidden. */

export function mountOverview(ext, root) {
  const { el, clear } = ext.dom;
  const { busy, card, kv, put } = ext.ui;
  const wrap = el("div", { class: "panel-col ua-overview" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  const code = (text) => el("code", { class: "ua-wrap" }, text);

  async function load() {
    const stop = busy(wrap, "Reading the configuration…");
    let config = null;
    try {
      config = (await ext.request("config")).data ?? null;
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
    clear(wrap);
    if (!config) return;
    const { packages, systemPackages, fence, ...rest } = config;
    put(
      wrap,
      card("Kernel", kv(Object.entries(rest).map(([k, v]) => [k, code(typeof v === "object" ? JSON.stringify(v) : String(v))]))),
      card("System packages", kv(Object.entries(systemPackages ?? {}).map(([k, v]) => [k === "*" ? "everyone" : k, code((v ?? []).join(", ") || "none")]))),
      card("Fence", kv(Object.entries(fence ?? {}).map(([k, v]) => [k, code(Array.isArray(v) ? v.join("\n") : String(v))]))),
      card(
        "Package configuration",
        el("p", { class: "text-faint" }, "Secrets are hidden. Edit the file thetis.config.json to change these."),
        ...Object.entries(packages ?? {}).map(([name, cfg]) => el("div", { class: "ua-kv-block" }, el("div", { class: "ua-kv-title" }, el("code", {}, name)), el("pre", { class: "ua-pre" }, JSON.stringify(cfg, null, 2))))
      )
    );
  }

  void load();
}

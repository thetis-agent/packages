/* Overview: how the installation is set up, as the kernel reports it with secrets hidden. */

import { api } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { busy, card, kv, put } from "../lib/panel-ui.js";
import { toast } from "../lib/toast.js";

export function mountOverview(root) {
  const wrap = el("div", { class: "panel-col" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  async function load() {
    const stop = busy(wrap, "Reading the configuration…");
    let config = null;
    try {
      config = await api("/api/admin/config");
    } catch (err) {
      toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
    clear(wrap);
    if (!config) return;
    const { packages, systemPackages, fence, ...rest } = config;
    put(wrap, 
      card("Kernel", kv(Object.entries(rest).map(([k, v]) => [k, typeof v === "object" ? el("code", { class: "wrap" }, JSON.stringify(v)) : el("code", { class: "wrap" }, String(v))]))),
      card("System packages", kv(Object.entries(systemPackages ?? {}).map(([k, v]) => [k === "*" ? "everyone" : k, el("code", { class: "wrap" }, (v ?? []).join(", ") || "none")]))),
      card("Fence", kv(Object.entries(fence ?? {}).map(([k, v]) => [k, el("code", { class: "wrap" }, Array.isArray(v) ? v.join("\n") : String(v))]))),
      card("Package configuration", el("p", { class: "text-faint" }, "Secrets are hidden. Edit the file thetis.config.json to change these."), ...Object.entries(packages ?? {}).map(([name, cfg]) => el("div", { class: "kv-block" }, el("div", { class: "kv-title" }, el("code", {}, name)), el("pre", { class: "pre" }, JSON.stringify(cfg, null, 2)))))
    );
  }

  void load();
}

/* Overview: the installation itself first, then how it is set up. The Installation card says where the
 * runtime checkout and its packages submodule stand against their upstream, whether the daemon runs the
 * code on disk, how many workspaces run older code, and the last update's record; it checks for updates,
 * runs one, and then offers what puts the new code into service. The update is @thetis/host-update's, on
 * the host, where the checkout lives; it pulls and builds and changes nothing that is running, so the
 * reload and the restart are the same two acts the Workspaces section offers, through the same helper and
 * the same latch. Below it, the configuration as the kernel reports it with secrets hidden. */

import { reloadWorkspace } from "./workspaces.js";

const POLL_MS = 2_000;

/** Which workspaces run older code than the disk, from `status`: a fence that loaded older files, or one whose files changed under it. */
export function behindWorkspaces(status) {
  return (status?.workspaces ?? []).filter((w) => w.stale || (w.changed ?? []).length).map((w) => w.user);
}

/** The one line a checkout gets: its commit, and the strongest true thing about where it stands. `tone` is the badge's. */
export function checkoutLine(kind, c) {
  if (!c) return { text: "unknown", tone: "dim" };
  const at = kind === "runtime" ? `${c.branch} @ ${c.commit}` : `@ ${c.commit}`;
  if (c.dirty) return { text: at, note: "uncommitted changes: update by hand", tone: "warn" };
  if (c.error) return { text: at, note: c.error, tone: "warn" };
  if (c.behind) return { text: at, note: kind === "runtime" ? `${c.behind} behind ${c.upstream}` : `${c.behind} behind the pinned ${c.pinned}`, tone: "warn" };
  return { text: at, note: kind === "runtime" ? (c.fetched ? `up to date with ${c.upstream}` : `at ${c.upstream} as of the last fetch`) : "at the pinned commit", tone: "ok" };
}

export function mountOverview(ext, root, { user } = {}) {
  const { el, clear } = ext.dom;
  const { badge, busy, button, card, confirm, heading, kv, put, when } = ext.ui;
  const wrap = el("div", { class: "panel-col ua-overview" });
  root.append(el("div", { class: "panel-cols" }, wrap));
  let alive = true;
  let facts = null; // update-check's answer
  let status = null; // the kernel's status
  let last = null; // the last update's record
  let checking = false;
  let timer = null;
  const install = el("section", { class: "ua-install" });
  const rest = el("div");

  const code = (text) => el("code", { class: "ua-wrap" }, text);

  async function loadInstallation({ fetch = false } = {}) {
    const [check, state] = await Promise.all([ext.request("update-check", { args: { fetch } }).catch((err) => ({ error: err })), ext.request("status").catch(() => null)]);
    if (!alive) return;
    facts = check?.error ? { error: check.error.message } : (check?.data ?? null);
    last = facts?.last ?? last;
    status = state?.data ?? null;
    drawInstallation();
  }

  /** Polls the record while an update runs; when it ends, the checkouts and the status are read again, because both have moved. */
  async function follow() {
    clearTimeout(timer);
    try {
      const out = await ext.request("update-progress");
      if (!alive) return;
      last = out?.data?.last ?? last;
    } catch {
      return;
    }
    drawInstallation();
    if (last?.state === "running") timer = setTimeout(() => void follow(), POLL_MS);
    else {
      ext.toast(last?.ok ? `The installation is updated: runtime ${last.to?.runtime ?? "?"}, packages ${last.to?.packages ?? "?"}. Reload the workspaces and restart the daemon to run it.` : `The update failed: ${last?.error ?? "see the record below"}.`, { tone: last?.ok ? "good" : "error" });
      await loadInstallation();
    }
  }

  async function checkNow(anchor) {
    checking = true;
    drawInstallation();
    await loadInstallation({ fetch: true });
    checking = false;
    if (!alive) return;
    drawInstallation();
    const behind = (facts?.runtime?.behind ?? 0) + (facts?.packages?.behind ?? 0);
    ext.toast(facts?.error ? facts.error : behind ? `${behind} commit${behind === 1 ? "" : "s"} to take.` : "Up to date.", { tone: facts?.error ? "error" : "good" });
  }

  async function updateNow(anchor) {
    const r = facts?.runtime ?? {};
    const p = facts?.packages ?? {};
    const ok = await confirm(anchor, {
      title: "Update the installation?",
      lines: [["runtime", `${r.commit} → ${r.behind ? `${r.behind} commit${r.behind === 1 ? "" : "s"} from ${r.upstream}` : "as it is"}`], ["packages", `${p.commit} → ${p.behind ? `${p.behind} commit${p.behind === 1 ? "" : "s"}, to the pinned ${p.pinned}` : "as it is"}`], ["on", facts?.root ?? "the host"]],
      note: "On the host: git pull, the packages submodule moved to the pinned commit, npm ci and the build. It takes a few minutes. Nothing that is running changes until the workspaces are reloaded and the daemon restarted, which this card offers once it is done.",
      confirmLabel: "Update",
    });
    if (!ok) return;
    try {
      const out = await ext.request("update-run");
      last = out?.data?.last ?? last;
      if (out?.data?.state === "current") ext.toast("Nothing is behind: the checkout is already what the upstream holds.", { tone: "good" });
      else void follow();
    } catch (err) {
      ext.toast(err?.message || "The update could not start.", { tone: "error" });
    }
    drawInstallation();
  }

  /** Every workspace behind the disk, the admin's own last: reloading it closes the fence answering this page. */
  async function reloadAll(anchor) {
    const behind = behindWorkspaces(status).sort((a, b) => (a === user ? 1 : b === user ? -1 : a.localeCompare(b)));
    const ok = await confirm(anchor, { title: `Reload ${behind.length} workspace${behind.length === 1 ? "" : "s"}?`, lines: [["workspaces", behind.join(", ")]], note: "Each closes and opens again on the code on disk. Every open shell session in it ends; conversations and files are untouched. Yours goes last, and this page reconnects on its own.", confirmLabel: "Reload", tone: "warn" });
    if (!ok) return;
    const stop = busy(install, "Reloading workspaces…");
    const said = [];
    try {
      for (const who of behind) {
        const r = await reloadWorkspace(ext, who, { onLost: () => stop() });
        said.push(`${who}: ${r.state}${r.message ? ` (${r.message})` : ""}`);
      }
    } finally {
      stop();
    }
    ext.toast(said.join(" · "), { tone: said.some((s) => /refused|silent/.test(s)) ? "warn" : "good" });
    await loadInstallation();
  }

  async function restartDaemon(anchor) {
    const reason = `update: runtime at ${facts?.runtime?.commit ?? "a new commit"}`;
    const ok = await confirm(anchor, { title: "Restart the daemon?", lines: [["reason", reason]], note: "The daemon waits for every turn everywhere to end, counts down where everyone can see it, and exits so systemd starts it again on the code on disk. Every shell session open in a terminal anywhere ends.", confirmLabel: "Restart", tone: "warn" });
    if (!ok) return;
    try {
      const out = await ext.request("restart-request", { args: { reason } });
      ext.toast(out?.data?.message ?? "Asked.", { tone: out?.data?.state === "refused" ? "warn" : "good" });
    } catch (err) {
      ext.toast(err?.message || "The restart could not be asked for.", { tone: "error" });
    }
  }

  const line = (kind, c) => {
    const said = checkoutLine(kind, c);
    return el("span", {}, code(said.text), said.note ? el("span", {}, " ", badge(said.note, said.tone)) : null);
  };

  /** The incoming commits of one checkout, after a fetch: what the update would bring. */
  const incomingList = (label, c) =>
    c?.incoming?.length
      ? el("div", { class: "ua-kv-block" }, el("div", { class: "ua-kv-title" }, `${label}: ${c.incoming.length} commit${c.incoming.length === 1 ? "" : "s"} to take`), el("ul", { class: "ua-incoming" }, ...c.incoming.map((x) => el("li", {}, code(x.commit), " ", x.subject))))
      : null;

  /** The last update's record: each step with its state, and the running or the failed step's output. */
  function record(r) {
    if (!r) return null;
    const tone = r.state === "done" ? "ok" : r.state === "running" ? "accent" : "warn";
    const shown = r.steps.find((s) => s.startedAt && !s.finishedAt) ?? r.steps.find((s) => s.code !== null && s.code !== 0) ?? null;
    return el(
      "div",
      { class: "ua-kv-block" },
      el("div", { class: "ua-kv-title" }, badge(r.state, tone), ` started ${when(r.startedAt)}${r.by ? ` by ${r.by}` : ""}${r.finishedAt ? `, ended ${when(r.finishedAt)}` : ""}`),
      r.from && r.to ? el("p", { class: "text-dim" }, `runtime ${r.from.runtime} → ${r.to.runtime} · packages ${r.from.packages} → ${r.to.packages}`) : null,
      r.error ? el("p", { class: "ua-error" }, r.error) : null,
      el("ul", { class: "ua-steps" }, ...r.steps.map((s) => el("li", {}, badge(s.finishedAt ? (s.code === 0 ? "ok" : `exit ${s.code}`) : s.startedAt ? "running" : "waiting", s.finishedAt ? (s.code === 0 ? "ok" : "warn") : s.startedAt ? "accent" : "dim"), " ", s.name, " ", el("code", { class: "text-faint" }, s.cmd)))),
      shown?.output ? el("pre", { class: "ua-pre" }, shown.output.slice(-4000)) : null
    );
  }

  function drawInstallation() {
    clear(install);
    const d = status?.daemon ?? null;
    const behind = behindWorkspaces(status);
    const total = (status?.workspaces ?? []).length;
    const canUpdate = facts && !facts.error && !facts.runtime?.dirty && !facts.packages?.dirty && !facts.runtime?.error && ((facts.runtime?.behind ?? 0) > 0 || (facts.packages?.behind ?? 0) > 0) && last?.state !== "running";
    const checkBtn = button(checking ? "Checking…" : "Check for updates", { tone: "quiet", disabled: checking || last?.state === "running", onClick: () => void checkNow(checkBtn) });
    const updateBtn = button("Update now", { tone: "primary", disabled: !canUpdate, title: canUpdate ? "Pull and build on the host" : "Check for updates first; the button wakes when something is behind", onClick: () => void updateNow(updateBtn) });
    const reloadBtn = behind.length ? button(`Reload ${behind.length} workspace${behind.length === 1 ? "" : "s"}`, { tone: "warn", onClick: () => void reloadAll(reloadBtn) }) : null;
    const restartBtn = d?.stale ? button("Restart the daemon", { tone: "warn", onClick: () => void restartDaemon(restartBtn) }) : null;
    put(
      install,
      card(
        heading("Installation", "the runtime checkout, its packages, and what is running them"),
        facts?.error ? el("p", { class: "ua-error" }, facts.error) : null,
        kv(
          [
            facts?.root && ["checkout", code(facts.root)],
            ["runtime", line("runtime", facts?.runtime)],
            ["packages", line("packages", facts?.packages)],
            facts?.node && ["node", code(facts.node)],
            d && ["daemon", el("span", {}, `started ${when(d.startedAt)}`, " ", d.stale ? badge("running older code than the disk: a restart applies it", "warn") : badge("running the code on disk", "ok"))],
            status && ["workspaces", el("span", {}, `${total}`, " ", behind.length ? badge(`${behind.length} run older code: ${behind.join(", ")}`, "warn") : badge("all on the code on disk", "ok"))],
            ["last update", last ? el("span", {}, `${when(last.finishedAt ?? last.startedAt)} · `, badge(last.state, last.state === "done" ? "ok" : last.state === "running" ? "accent" : "warn")) : el("span", { class: "text-faint" }, "none from here")],
          ].filter(Boolean)
        ),
        incomingList("runtime", facts?.runtime),
        incomingList("packages", facts?.packages),
        record(last),
        el("div", { class: "card-actions" }, checkBtn, updateBtn, reloadBtn, restartBtn),
        el("p", { class: "text-faint" }, facts?.beyond ?? "Node itself, the OS packages the fence needs, and the systemd unit are updated by deploy/install.sh on the host.")
      )
    );
  }

  async function loadConfig() {
    const stop = busy(rest, "Reading the configuration…");
    let config = null;
    try {
      config = (await ext.request("config")).data ?? null;
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
    if (!alive) return;
    clear(rest);
    if (!config) return;
    const { packages, systemPackages, fence, ...kernel } = config;
    put(
      rest,
      card("Kernel", kv(Object.entries(kernel).map(([k, v]) => [k, code(typeof v === "object" ? JSON.stringify(v) : String(v))]))),
      card("System packages", kv(Object.entries(systemPackages ?? {}).map(([k, v]) => [k === "*" ? "everyone" : k, code((v ?? []).join(", ") || "none")]))),
      card("Fence", kv(Object.entries(fence ?? {}).map(([k, v]) => [k, code(Array.isArray(v) ? v.join("\n") : String(v))]))),
      card(
        "Package configuration",
        el("p", { class: "text-faint" }, "Secrets are hidden. Edit the file thetis.config.json to change these."),
        ...Object.entries(packages ?? {}).map(([name, cfg]) => el("div", { class: "ua-kv-block" }, el("div", { class: "ua-kv-title" }, el("code", {}, name)), el("pre", { class: "ua-pre" }, JSON.stringify(cfg, null, 2))))
      )
    );
  }

  put(wrap, install, rest);
  drawInstallation();
  void loadInstallation().then(() => {
    if (alive && last?.state === "running") void follow();
  });
  void loadConfig();
  return () => {
    alive = false;
    clearTimeout(timer);
  };
}

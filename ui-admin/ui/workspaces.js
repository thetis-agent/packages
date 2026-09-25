/* Workspaces: what code each workspace is actually running, and the one button that puts new code into it.
 * A package's tool and step code is re-read on every call and its browser files on every request, but a
 * service's module graph, a provider and the agent itself are read once, when the workspace opens. Nothing
 * else in the panel says which of those you are looking at, so the Code column says it in words — and the
 * fix is offered in the same row as the problem, the way the mounts table does.
 *
 * Its own section rather than a button in People, because the two workspaces that most need reloading are
 * the ones People cannot offer: `_system`, which it filters out, and your own, which its detail pane refuses
 * by design. Reloading your own closes the fence that serves this page, so the request is expected to be
 * lost: the page waits for the new workspace to answer and says the remedy when it never does.
 *
 * No button that reloads everyone. Server-side it would outlast the gateway's command timeout while still
 * succeeding, and browser-side it would kill this page halfway through the list; `thetis reload --all` on the
 * host has neither hazard, so the hint says to use it.
 *
 * The daemon card also asks for a restart, for the same reason the Reload button is in the row: this card is
 * what says the daemon is running older code than the disk, and that only a new process can replace the
 * kernel. `@thetis/tool-operator`'s chip cannot offer it — the chip is hidden whenever nothing is pending,
 * which is exactly when you would want the button, and making it permanent would be the noise being hidden
 * is there to prevent. The control is offered where it could do something (a stale daemon) and otherwise only
 * when asked for, it says beforehand when a restart could not succeed here rather than letting someone read a
 * refusal afterwards, and it carries the typed reason that is shown to everyone waiting and journalled. Every
 * sentence about the outcome is the latch's own, passed through without a word added. */

const SYSTEM = "_system";
export const SETTLE_MS = 30_000;

/**
 * A request that lost its gateway, as against one a gateway refused with a sentence. Closing the fence that
 * is answering leaves either no answer at all (status 0) or the door's own 502/503 while the socket is gone;
 * anything else came from the kernel through a gateway that is still there, and is worth reading.
 */
export function isLost(err) {
  const status = Number(err?.status);
  return !Number.isFinite(status) || status === 0 || status >= 502;
}

/**
 * Waits for the gateway to answer after its own fence was closed, up to half a minute, and says whether it
 * did. The boolean is the point: the caller has a remedy to offer once the deadline passes.
 */
export async function settle(ext, deadline = Date.now() + SETTLE_MS) {
  for (;;) {
    try {
      await ext.request("status");
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((done) => setTimeout(done, 700));
    }
  }
}

/**
 * Sends one reload and says what became of it, in four words a caller can act on: `done` with the services
 * that restarted, `refused` with the kernel's own sentence, `returned` when the fence it closed was the one
 * answering and the new one came back, and `silent` with the remedy when it never did. A lost request is the
 * expected success, not a failure, so `onLost` is called once the waiting starts. The fleet page reloads
 * several workspaces through this same function, so both places wait the same way.
 */
/** The kernel's refusal for a workspace with a turn running in it: not a failure, a question for the person. */
export function isBusy(err) {
  return /has a turn running/.test(err?.message ?? "");
}

/**
 * One reload, and what it answered: `done` with the services restarted and the turns cancelled, `busy` when a
 * turn runs there and `force` was not given, `refused` with the kernel's sentence, `returned` when the
 * fence answering this page closed and the new one answered, `silent` when it never did.
 */
export async function reloadWorkspace(ext, target, { onLost, force = false } = {}) {
  try {
    const out = await ext.request("fence-reload", { args: { user: target, ...(force ? { force: true } : {}) } });
    return { state: "done", services: out?.data?.services ?? [], cancelled: out?.data?.cancelled ?? [] };
  } catch (err) {
    // A refused verb answers at once and names its reason; a closed gateway never answers at all.
    if (isBusy(err)) return { state: "busy", message: err.message };
    if (!isLost(err)) return { state: "refused", message: err.message };
    onLost?.();
    if (await settle(ext)) return { state: "returned", services: [] };
    return { state: "silent", message: `It has not answered for ${SETTLE_MS / 1000} seconds. On the host: thetis reload --user ${target}` };
  }
}

export function mountWorkspaces(ext, root, { user }) {
  const { el, clear } = ext.dom;
  const { badge, busy, button, card, confirm, heading, kv, put, table, tags } = ext.ui;
  let daemon = null; // { startedAt, uptimeSecs, supervised, codeAt, stale }
  let pending = null; // the restart a later change fills in, or null
  let rows = [];
  let revealed = false; // the operator asked for the restart control although the daemon is not running stale code
  let said = null; // { state, message }: the last thing the latch said about a restart, kept where it was asked for
  const lost = new Map(); // user -> the sentence for a workspace that never answered again
  const wrap = el("div", { class: "panel-col ua-workspaces" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  async function load() {
    const stop = busy(wrap, "Reading the workspaces…");
    try {
      const out = await ext.request("status");
      daemon = out?.data?.daemon ?? null;
      // Read defensively: a daemon without the restart feature has no such field, and null is the common answer.
      pending = out?.data?.restart && typeof out.data.restart === "object" ? out.data.restart : null;
      rows = Array.isArray(out?.data?.workspaces) ? out.data.workspaces : [];
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
    draw();
  }

  /**
   * Sends the reload through `reloadWorkspace` and says what it answered. The fence it closes may be the one
   * answering this request, so a lost request is the expected success, not a failure: the page then waits
   * until the new workspace answers, and after the deadline the row says what to run on the host.
   */
  async function reload(target, anchor, force = false) {
    lost.delete(target);
    const out = await reloadWorkspace(ext, target, { force, onLost: () => ext.toast(`${target} is reloading. Waiting for the workspace to answer again…`, { tone: "good" }) });
    // A turn is running there. The kernel refused rather than kill it, and killing it is what a reload used to
    // do: two and a half hours of a turn once died that way, recorded no further than what it was asked. So this
    // is a second question, not a failure: cancel the turn, which ends it as a cancel with what it has said and
    // done kept, and then reload.
    if (out.state === "busy") {
      const ok = await confirm(anchor, { title: "Cancel the running turn and reload?", lines: [["workspace", target]], note: `${out.message}. Cancelling ends the turn as a cancel: what it has said and done so far is kept, and the conversation stays.`, confirmLabel: "Cancel the turn and reload", tone: "warn" });
      if (ok) return reload(target, anchor, true);
      return void (await load());
    }
    if (out.cancelled?.length) ext.toast(`Cancelled the turn running in ${out.cancelled.join(", ")}.`, { tone: "warn" });
    if (out.state === "done") ext.toast(out.services.length ? `${target} was reloaded: ${out.services.join(", ")} restarted.` : `${target} was reloaded. Nobody runs a service there, so it reopens on the next request.`, { tone: "good" });
    else if (out.state === "refused") {
      ext.toast(out.message, { tone: "error" });
      return void (await load());
    } else if (out.state === "returned") ext.toast(`${target} answered again.`, { tone: "good" });
    else {
      lost.set(target, out.message);
      ext.toast(`${target} has not answered for ${SETTLE_MS / 1000} seconds. On the host: thetis reload --user ${target}`, { tone: "error" });
    }
    await load();
  }

  async function ask(anchor, row) {
    const me = row.user === user;
    const changed = Array.isArray(row.changed) ? row.changed : [];
    const lines = [
      ["workspace", row.user],
      ...(changed.length ? [["applies", changed.map((c) => `${c.name} ${c.loaded} → ${c.onDisk}`).join(", ")]] : []),
      ["restarts", "the gateway, the terminal, every service"],
      ["keeps", "conversations and files"],
    ];
    const note = [
      row.user === SYSTEM
        ? "The providers and the sign-in page restart on the code that is on disk now."
        : `${me ? "Your" : `${row.user}'s`} gateway, terminal and every service in the workspace restart on the code that is on disk now.`,
      "Every open shell session in it stops, and whatever is running in one stops with it.",
      "Conversations and files are untouched. A turn running there is refused, and can then be cancelled and the reload forced.",
      row.user === SYSTEM ? "The sign-in page is unavailable for a second; anyone already signed in is unaffected." : null,
      me ? "This is the workspace serving this page, so the page will wait for it to answer again." : null,
    ]
      .filter(Boolean)
      .join(" ");
    return confirm(anchor, { title: "Reload this workspace?", lines, note, confirmLabel: "Reload", tone: "warn" });
  }

  /**
   * Why a restart could not succeed on this host, or null when it could. Said next to the control and the
   * control is off: a button that can only collect a refusal should say so before it is pressed. `supervised`
   * and `restartPolicy` are read in the daemon, where they are true — the deployed unit's policy, not this
   * checkout's file, because that is what decides whether a clean exit comes back.
   */
  function blocker() {
    if (!daemon.supervised) return "This daemon was not started by systemd, so exiting would stop Thetis rather than restart it: nothing would bring it back. An operator starts it under systemd at the host; the control is off until then.";
    const policy = daemon.restartPolicy ?? null;
    if (policy === null) return "The restart policy of the systemd unit that runs this daemon could not be read, so there is no way to know whether the process would come back. An operator puts that right at the host; the control is off until then.";
    if (policy !== "always") return `The systemd unit that runs this daemon says Restart=${policy}, not Restart=always, so the process would exit and stay down rather than come back. An operator puts that right at the host; the control is off until then.`;
    return null;
  }

  /**
   * The restart control. Offered when a restart could do something — the daemon is running older code than the
   * disk — and otherwise only once the operator asks, because a prominent button for a thing nobody needs is
   * how a page teaches people to ignore it. A restart already pending is the chip's business, not this card's:
   * asking again could only answer "already armed".
   */
  function restartBlock() {
    if (pending) return null;
    if (!daemon.stale && !revealed) {
      const show = button("Ask for a restart anyway…", { title: "Show the restart control", onClick: () => { revealed = true; draw(); } });
      return el("div", { class: "ua-line" }, el("span", { class: "text-faint" }, "This daemon is running the code on disk, so nothing here needs a restart."), show);
    }
    const why = blocker();
    const go = button("Restart the daemon…", { tone: "warn", disabled: !!why, title: why ? "A restart could not succeed on this host" : "Ask the daemon to restart itself", onClick: () => void arm(go) });
    return el("div", { class: "ua-code" }, el("div", { class: "ua-line" }, go, why ? badge("not possible here", "err") : null), why ? el("p", { class: "text-faint" }, why) : null);
  }

  /**
   * Asks for the restart. The reason is typed into the confirm itself, because it is shown to everyone waiting
   * and written to the journal, so it cannot be something the page made up. The latch's answer — armed, already
   * armed, or refused — is shown word for word and kept in the card: those sentences say what happened, why, and
   * what to do instead, and a paraphrase would lose the part that matters.
   */
  async function arm(anchor) {
    const reason = el("input", { class: "input ua-reason", type: "text", placeholder: "what changed, and why a reload cannot pick it up", "aria-label": "Reason", autocomplete: "off" });
    setTimeout(() => reason.focus(), 0);
    const ok = await confirm(anchor, {
      title: "Ask the daemon to restart?",
      lines: [["restarts", "the kernel, the door, every workspace"], ["reason", reason]],
      note: "Every workspace goes down and comes back: conversations come back with their history, open shell sessions do not, and whatever is running in one stops with it. Nothing happens the moment you confirm — Thetis waits for every turn everywhere to finish, counts down where everyone can see it, and can be called off from the chip in the status bar until it fires. The reason is shown to everyone waiting and recorded.",
      confirmLabel: "Ask for a restart",
      tone: "warn",
    });
    if (!ok) return;
    const text = reason.value.trim();
    if (!text) return void ext.toast("A restart needs a reason: it is shown to everyone waiting and recorded.", { tone: "error" });
    try {
      const out = await ext.request("restart-request", { args: { reason: text } });
      const state = out?.data?.state ?? null;
      const message = typeof out?.data?.message === "string" && out.data.message.trim() ? out.data.message : null;
      // A kernel that answered without a sentence is not reported as armed: a restart announced on no evidence
      // is worse than one nobody mentioned, and `thetis restart status` at the host settles it.
      said = message ? { state, message } : { state: "unknown", message: "The kernel answered the restart request without a sentence of its own, so this page cannot tell you what it did. Do not assume either way: thetis restart status on the host says whether anything is armed." };
      ext.toast(said.message, { tone: said.state === "armed" || said.state === "again" ? "warn" : "error" });
    } catch (err) {
      said = { state: "failed", message: err.message };
      ext.toast(err.message, { tone: "error" });
    }
    await load();
  }

  /** What a fence or the daemon is running, in the same words for both. */
  const running = (from, codeAt, stale) => (stale ? `running code from ${clock(from)} · newer on disk since ${clock(codeAt)}` : "running the code on disk");

  /**
   * The packages this workspace has not loaded, from `status`: name, the version its fence read and the one
   * on disk. "Running older code" names neither the package nor the version, and a package shipped with the
   * service is installed the moment its files land, so nothing else on this page would say it. The scope is
   * dropped for reading; the whole names are in the title.
   */
  function changedLine(row) {
    const changed = Array.isArray(row.changed) ? row.changed : [];
    if (!changed.length) return null;
    const say = (c, name) => `${name} ${c.loaded} → ${c.onDisk}`;
    return el("span", { class: "text-dim ua-changed", title: changed.map((c) => say(c, c.name)).join(", ") }, changed.map((c) => say(c, c.name.slice(c.name.indexOf("/") + 1))).join(", "));
  }

  /**
   * What this workspace is running, and what it is meant to be running and is not. `status` answers those two
   * separately, and they are shown separately for the same reason: the list used to be every installed package
   * that *declares* a service, so one that had failed to start looked exactly like one that was serving, and a
   * dead marketplace sat on this page looking healthy. A failure is not another dim tag -- it is the one thing
   * in this row somebody has to act on -- so it is a warning badge that says since when and what it said, and
   * the remedy is the Reload control already on the row.
   */
  function servicesCell(row) {
    const down = Array.isArray(row.down) ? row.down : [];
    const short = (name) => name.slice(name.indexOf("/") + 1);
    return el(
      "div",
      { class: "ua-code" },
      tags(row.services ?? [], "dim", down.length ? "none running" : "no service"),
      ...down.map((d) => el("span", { class: "ua-line", title: `${d.name} has not been running since ${clock(d.since)}: ${d.error}` }, badge(`${short(d.name)} not running`, "warn")))
    );
  }

  function codeCell(row) {
    const note = lost.get(row.user);
    // No fence open is not staleness: the next request opens the workspace on whatever is on disk then.
    const line = row.openedAt ? el("span", {}, running(row.openedAt, row.codeAt, row.stale)) : el("span", { class: "text-faint" }, "not running · opens on the next request");
    return el("div", { class: "ua-code" }, el("span", { class: "ua-line" }, line, row.stale ? badge("newer code on disk", "warn") : null), changedLine(row), note ? el("code", { class: "ua-wrap ua-lost" }, note) : null);
  }

  function daemonCard() {
    if (!daemon) return null;
    return card(
      "This daemon",
      kv([
        ["code", el("span", { class: "ua-line" }, el("span", {}, running(daemon.startedAt, daemon.codeAt, daemon.stale)), daemon.stale ? badge("newer code on disk", "warn") : null)],
        ["started", el("span", { class: "text-dim" }, daemon.startedAt ? `${clock(daemon.startedAt)} · up ${upFor(daemon.uptimeSecs)}` : "not known")],
        // The deployed unit's own `Restart=`, because that, not supervision alone, decides whether a clean exit comes back.
        ["supervision", el("span", { class: "ua-line" }, daemon.supervised ? badge("systemd", "ok") : badge("not supervised", "warn"), el("span", { class: "text-dim" }, daemon.restartPolicy ? `Restart=${daemon.restartPolicy}` : "restart policy not known"))],
      ]),
      pending ? el("p", { class: "text-dim" }, `A restart of the daemon is pending: ${typeof pending.reason === "string" && pending.reason ? pending.reason : "no reason was recorded"}${pending.by ? ` (asked by ${pending.by})` : ""}. The chip in the status bar counts it down and calls it off, as thetis restart cancel does on the host.`) : null,
      // The remedy names this card's own control only when that control could work; `blocker()` says the rest.
      el("p", { class: "text-faint" }, `A reload cannot replace the kernel, the door or thetis.config.json: those are read once by this process, so ${daemon.stale ? "putting the code on disk into service needs" : "changing them needs"} a new one — ${blocker() ? "run" : "ask for a restart here, or run"} sudo systemctl restart thetis-runtime.service on the host.`),
      restartBlock(),
      said ? el("p", { class: said.state === "armed" || said.state === "again" ? "text-dim" : "ua-refused" }, said.message) : null
    );
  }

  function draw() {
    clear(wrap);
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("Workspaces", `${rows.length} ${rows.length === 1 ? "workspace" : "workspaces"}`)),
      daemonCard(),
      table(
        [
          {
            key: "user",
            label: "Workspace",
            render: (r) => el("span", { class: "ua-line" }, el("code", {}, r.user), r.user === user ? el("span", { class: "text-faint" }, " (me)") : null, r.user === SYSTEM ? badge("system", "accent") : null),
          },
          { key: "code", label: "Code", render: codeCell },
          { key: "services", label: "Services", render: servicesCell },
          {
            key: "actions",
            label: "",
            // A workspace with no fence open has nothing to reload: a button there would only look like one.
            render: (r) => {
              if (!r.openedAt) return el("span", { class: "text-faint" }, "—");
              const b = button("Reload", { tone: "warn", onClick: () => void go() });
              async function go() {
                if (!(await ask(b, r))) return;
                b.disabled = true;
                try {
                  await reload(r.user, b);
                } finally {
                  b.disabled = false;
                }
              }
              return b;
            },
          },
        ],
        rows,
        { rowKey: (r) => r.user, empty: "No workspace has been opened yet." }
      ),
      el(
        "p",
        { class: "panel-hint" },
        "A package's tool and step code is re-read on every call, and its browser files on every request: new code in those is already live. A service's code, a provider and the agent itself are read once, when the workspace opens, so a reload is how new code in those reaches a running system. Reloading your own workspace reopens this page, and it waits. There is no button for everyone at once: thetis reload --all on the host takes them one at a time and cannot cut off the page that asked. The kernel, the door and thetis.config.json need the daemon restarted on the host instead."
      )
    );
  }

  void load();
}

/** A moment as a clock time, which is what an operator compares. Null and unparsable say so. The kernel sends
 * ISO strings; the latch's own clocks are epoch milliseconds, and both read the same here. */
function clock(at) {
  const ms = typeof at === "number" ? at : Date.parse(at ?? "");
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "an unknown time";
}

function upFor(secs) {
  const n = Number(secs);
  if (!Number.isFinite(n)) return "an unknown time";
  if (n < 90) return `${Math.max(0, Math.round(n))} s`;
  const m = Math.round(n / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

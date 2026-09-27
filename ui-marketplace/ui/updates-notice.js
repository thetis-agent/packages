/* The "Updates ready" card, and the one way an update is put into service from the page.
 *
 * `createUpdater(deps)` holds the whole flow and touches nothing but `deps`, so a test can drive it with fakes;
 * `extDeps(ext)` builds the real ones from the seam. The UI module starts one updater when the page boots
 * (index.js), and the gallery and the extension page call the same one, so there is one Update and not three.
 *
 * What it does:
 * - It asks the `updates` command when the page opens, when the tab becomes visible again, when the last
 *   running reply ends, and every ten minutes. While a reply is running it does not ask, and it never shows
 *   or changes a card: the card appears when the person looks up from the reply.
 * - "Updates ready" lists what has an update. [Review] opens the Updates view; [Update all] fetches what has to
 *   be fetched, applies, waits for the space to come back, and refreshes the page on the same conversation.
 *   After the refresh one toast says what was updated. × hides the card until the set of updates changes.
 * - The person's own changes (an agent's edits to their extensions) apply by themselves when a reply ends,
 *   nothing else is running and no terminal is open, when their setting says `auto`. Otherwise the card says
 *   "Changes ready" with [Apply].
 * - A copy of an extension that carries nothing the official version lacks gets "Use Thetis's version".
 * - Applying never cancels a reply. A running reply pauses at a safe point and continues afterwards. Open
 *   terminal sessions close, so that is asked once, and only when there are some.
 *
 * Nothing here is a recorded intention. What is pending is recomputed from the server every time; the only
 * things kept are per-viewer conveniences: what the person hid (localStorage), and, across the one page
 * refresh an update causes, the sentence to show afterwards (sessionStorage). */

const TEN_MINUTES = 10 * 60_000;
const DISMISSED = "thetis.ui-marketplace.dismissed";
const AFTER = "thetis.ui-marketplace.after";
const AUTO = "thetis.ui-marketplace.auto";

/** "a", "a and b", "a, b and c". */
export function listOf(words) {
  const w = words.filter(Boolean);
  if (w.length <= 1) return w.join("");
  return `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The key that says "this exact set", so × hides a card until something in it changes. */
export const signatureOf = {
  updates: (items) => items.map((i) => `${i.name}@${i.to}`).sort().join(","),
  own: (own) => own.map((o) => `${o.name}@${o.at ?? ""}`).sort().join(","),
  forks: (forks) => forks.map((f) => `${f.name}:${f.state}`).sort().join(","),
};

/** A request that lost its gateway (expected while the space starts again), as against one refused with a sentence. */
export const lostGateway = (err) => {
  const status = Number(err?.status);
  return !Number.isFinite(status) || status === 0 || status >= 502;
};

/** A kernel from before drain refuses while a reply runs. The page waits and asks again; it never forces. */
export const isBusy = (err) => err?.code === "busy" || /turn running|\bbusy\b/i.test(String(err?.message ?? ""));

/** "Use Thetis's version", or, when a copy was made from somebody else's extension, "Use the original". */
export const useLabel = (forks) => (forks.every((f) => !f.origin || String(f.origin).startsWith("@thetis/")) ? "Use Thetis's version" : "Use the original");

/** What the card says, for each of its states. Kept together so the words can be read and tested in one place. */
export const words = {
  updates: (items) => ({ title: "Updates ready", body: `Updates for ${plural(items.length, "extension")}: ${listOf(items.map((i) => i.label))}.` }),
  own: (own, shells) => ({ title: "Changes ready", body: `Your changes to ${listOf(own.map((o) => o.label))} are ready to use.${shells ? ` ${shellsLine(shells)}` : ""}` }),
  forks: (forks) =>
    forks.length === 1
      ? forks[0].state === "superseded"
        ? { title: "Your changes are in the official version", body: `Everything your copy of ${forks[0].label} changed is in the official version now. ${useLabel(forks)} to get its fixes; your files are kept.` }
        : { title: "Your copy has no changes", body: `Your copy of ${forks[0].label} is the same as the official version. ${useLabel(forks)} to get its fixes; your files are kept.` }
      : { title: "Your copies can go back to the official versions", body: `The official versions of ${listOf(forks.map((f) => f.label))} have everything your copies have. Your files are kept.` },
  applying: (running) => (running ? "Pausing your reply at a safe point… it continues afterwards." : "Applying… a few seconds, your conversations are kept."),
  slow: { title: "This is taking longer than usual", body: "Your space has not answered yet. Your conversations and files are kept." },
  failed: { title: "The update could not be applied", body: "Nothing was lost. Try again in a minute." },
  applied: (labels) => `Applied your changes to ${listOf(labels)}.`,
  updated: (labels) => `Updated: ${listOf(labels)}.`,
};

/** The line about terminal sessions, said before anything that closes them. */
export const shellsLine = (n) => `${plural(n, "terminal session")} will close.`;

/**
 * The updater. `deps`:
 * - `request(verb, args)` → the command's `data`; throws an error with `status` and `message`.
 * - `notice(id, spec)` → a handle or null; `closeNotice(id)`. Null when the page has no notice seam.
 * - `running()` → whether any reply of this person runs; `onIdle(fn)` → unsubscribe.
 * - `awaitReturn({ timeoutMs })` → "back" | "timeout".
 * - `reloadPage()`, `toast(text, opts)`, `openReview()`.
 * - `local` and `session`: `{ get(key), set(key, value), remove(key) }`, each already safe to call.
 * - `every(ms, fn)` → stop; `later(ms, fn)`; `onVisible(fn)` → stop; `now()`.
 * - `ask(text)` → Promise<boolean>, the fallback question when there is no notice seam.
 */
export function createUpdater(deps) {
  let last = null;
  let busy = false;
  let pending = false;
  const stops = [];

  const readJson = (store, key) => {
    try {
      return JSON.parse(store.get(key) ?? "null");
    } catch {
      return null;
    }
  };
  const dismissed = () => readJson(deps.local, DISMISSED) ?? {};
  const dismiss = (kind, sig) => deps.local.set(DISMISSED, JSON.stringify({ ...dismissed(), [kind]: sig }));
  const show = (id, spec) => deps.notice(id, { dismissible: true, ...spec });
  const close = (id) => deps.closeNotice(id);

  /** Waits for the running replies to end, or a while at most. */
  function idle(ms = 5 * 60_000) {
    if (!deps.running()) return new Promise((done) => deps.later(3000, done));
    return new Promise((done) => {
      let off = () => {};
      const finish = () => {
        off();
        done();
      };
      off = deps.onIdle(finish) ?? (() => {});
      deps.later(ms, finish);
    });
  }

  /** Asks once before closing terminal sessions, on the card itself. Resolves true to go on. */
  function askShells(id, n, title = "Update now?") {
    const body = `${shellsLine(n)} Conversations and files are kept.`;
    return new Promise((resolve) => {
      const card = show(id, { title, body, tone: "warn", actions: [{ label: "Update", primary: true, run: () => resolve(true) }, { label: "Not now", run: () => resolve(false) }], onDismiss: () => resolve(false) });
      if (!card) Promise.resolve(deps.ask(`${title} ${body}`)).then(resolve, () => resolve(false));
    });
  }

  /**
   * Starts the person's space again on the files on disk, waits for it to answer, then refreshes the page with
   * `message` to show afterwards. `refresh: false` keeps the page and says the message on the card instead,
   * for a change that touched no browser code. Answers whether it got through.
   */
  async function apply(id, message, { refresh = true } = {}) {
    const say = (body, extra = {}) => show(id, { title: "Updating", body, dismissible: false, ...extra });
    const wasRunning = deps.running();
    say(words.applying(wasRunning));
    // The moment before asking: a space that went away and came back while the request was still waiting
    // (a drain can hold it until the reply reaches a safe point) counts as back.
    const since = deps.now();
    for (let tries = 0; ; tries += 1) {
      try {
        await deps.request("fence-reload", { drain: true });
        break;
      } catch (err) {
        if (lostGateway(err)) break; // the space closed under the request: that is the reload happening
        if (isBusy(err) && tries < 5) {
          say("Waiting for the reply to finish…");
          await idle();
          say(words.applying(deps.running()));
          continue;
        }
        show(id, { ...words.failed, tone: "error", details: String(err?.message ?? err), actions: [{ label: "Try again", primary: true, run: () => void apply(id, message, { refresh }) }] });
        return false;
      }
    }
    const back = await deps.awaitReturn({ timeoutMs: wasRunning ? 180_000 : 90_000, since });
    if (back !== "back") {
      show(id, { ...words.slow, tone: "warn", actions: [{ label: "Try again", primary: true, run: () => deps.reloadPage() }] });
      return false;
    }
    if (refresh) {
      deps.session.set(AFTER, message);
      deps.reloadPage();
    } else {
      show(id, { title: message, tone: "ok" });
      deps.later(8000, () => close(id));
    }
    return true;
  }

  /** Draws, or takes away, the card for each list. Only ever called between replies. */
  function draw(data) {
    const hidden = dismissed();
    const items = data.items ?? [];
    const itemsSig = signatureOf.updates(items);
    if (!items.length || hidden.updates === itemsSig) close("updates");
    else show("updates", { ...words.updates(items), tone: "info", actions: [{ label: "Review", run: () => deps.openReview() }, { label: "Update all", primary: true, run: () => void updateAll() }], onDismiss: () => dismiss("updates", itemsSig) });

    const forks = data.forks ?? [];
    const forksSig = signatureOf.forks(forks);
    if (!forks.length || hidden.forks === forksSig) close("updates-forks");
    else show("updates-forks", { ...words.forks(forks), tone: "info", actions: [{ label: useLabel(forks), primary: true, run: () => void switchBack(forks) }], onDismiss: () => dismiss("forks", forksSig) });
  }

  /**
   * The person's own changes: applied by themselves when a reply has just ended and that is safe and wanted,
   * otherwise offered. `auto` is true only for the check a reply's end starts, so opening the page or coming
   * back to the tab never applies anything by surprise.
   */
  function drawOwn(data, { auto = false } = {}) {
    const own = data.own ?? [];
    if (!own.length) return close("updates-own");
    const sig = signatureOf.own(own);
    const tried = readJson(deps.session, AUTO);
    // Once per set of changes: if the same changes are still here after an automatic apply, applying again would
    // only loop, so the card offers the button instead.
    if (auto && data.applyOwnChanges !== "ask" && !(data.watched ?? data.shells) && tried?.sig !== sig) {
      deps.session.set(AUTO, JSON.stringify({ sig, at: deps.now() }));
      return void applyOwn(data);
    }
    if (dismissed().own === sig) return close("updates-own");
    show("updates-own", { ...words.own(own, data.shells), tone: "info", actions: [{ label: "Apply", primary: true, run: () => void applyOwn(data, { asked: true }) }], onDismiss: () => dismiss("own", sig) });
  }

  /**
   * Asks the server, and draws what it says, unless a reply is running or an update is already under way.
   * `reason` is "idle" when the last running reply just ended, which is the one moment own changes apply by themselves.
   */
  async function check(reason = "") {
    if (busy) return;
    if (deps.running()) {
      pending = true;
      return;
    }
    pending = false;
    let data;
    try {
      data = await deps.request("updates", {});
    } catch {
      return; // the card stays as it was; the next check asks again
    }
    if (busy) return;
    if (deps.running()) {
      pending = true;
      return;
    }
    last = data ?? {};
    drawOwn(last, { auto: reason === "idle" });
    draw(last);
  }

  /**
   * Update some, or all, of what the last answer listed: install what has to be fetched, one by one with
   * progress on the card, then apply once. A failed install is named in the final sentence and the others go on.
   */
  async function updateSome(names) {
    if (busy) return false;
    busy = true;
    try {
      // A list of names the last answer does not carry is asked about again, rather than updated from a stale list.
      const known = (d) => !names || names.every((n) => (d?.items ?? []).some((i) => i.name === n));
      const data = last && known(last) ? last : await deps.request("updates", {});
      last = data;
      const chosen = (data.items ?? []).filter((i) => !names || names.includes(i.name));
      if (!chosen.length) return false;
      if (data.shells > 0 && !(await askShells("updates", data.shells))) {
        busy = false;
        draw(data);
        return false;
      }
      const installs = chosen.filter((i) => i.apply === "install");
      const failed = [];
      for (const [n, item] of installs.entries()) {
        show("updates", { title: "Updating", body: `Fetching ${item.label}… ${n + 1} of ${installs.length}`, dismissible: false, progress: { steps: installs.map((i) => i.label), at: n } });
        try {
          await deps.request("update", { name: item.name });
        } catch (err) {
          failed.push({ label: item.label, message: String(err?.message ?? err) });
        }
      }
      const done = chosen.filter((i) => !failed.some((f) => f.label === i.label)).map((i) => i.label);
      if (!done.length) {
        show("updates", { ...words.failed, tone: "error", details: failed.map((f) => `${f.label}: ${f.message}`).join("\n"), actions: [{ label: "Try again", primary: true, run: () => void updateSome(names) }] });
        return false;
      }
      const miss = failed.length ? ` ${listOf(failed.map((f) => f.label))} could not be fetched and stays as it was.` : "";
      return await apply("updates", `${words.updated(done)}${miss}`);
    } finally {
      busy = false;
    }
  }

  const updateAll = () => updateSome(null);

  /** Asks the server now and keeps the answer, drawing nothing: for a page that is about to act on one extension. */
  async function refresh() {
    last = (await deps.request("updates", {})) ?? {};
    return last;
  }

  async function applyOwn(data, { asked = false } = {}) {
    if (busy) return false;
    busy = true;
    try {
      const own = data.own ?? [];
      if (asked && data.shells > 0 && !(await askShells("updates-own", data.shells, "Apply now?"))) {
        busy = false;
        drawOwn({ ...data, applyOwnChanges: "ask" });
        return false;
      }
      return await apply("updates-own", words.applied(own.map((o) => o.label)), { refresh: own.some((o) => o.ui) });
    } finally {
      busy = false;
    }
  }

  /** Switches each copy back to its official version (the files stay), then applies once. */
  async function switchBack(forks) {
    if (busy) return false;
    busy = true;
    try {
      if (last?.shells > 0 && !(await askShells("updates-forks", last.shells, `${useLabel(forks)} now?`))) {
        busy = false;
        draw(last);
        return false;
      }
      show("updates-forks", { title: "Going back to the official version", body: words.applying(false), dismissible: false });
      let lost = false;
      for (const f of forks) {
        try {
          await deps.request("unfork", { name: f.name });
        } catch (err) {
          // Switching the web gateway back replaces the process answering this request.
          if (lostGateway(err)) lost = true;
          else {
            show("updates-forks", { ...words.failed, tone: "error", details: String(err?.message ?? err) });
            return false;
          }
        }
      }
      if (lost && (await deps.awaitReturn({ timeoutMs: 90_000 })) !== "back") {
        show("updates-forks", { ...words.slow, tone: "warn", actions: [{ label: "Try again", primary: true, run: () => deps.reloadPage() }] });
        return false;
      }
      return await apply("updates-forks", `Back on the official ${listOf(forks.map((f) => f.label))}.`);
    } finally {
      busy = false;
    }
  }

  function start() {
    const after = deps.session.get(AFTER);
    if (after) {
      deps.session.remove(AFTER);
      deps.toast(after, { tone: "good" });
    }
    void check();
    stops.push(deps.onVisible(() => void check()));
    stops.push(deps.onIdle(() => void check("idle")));
    stops.push(deps.every(TEN_MINUTES, () => void check()));
  }

  function stop() {
    for (const s of stops.splice(0)) if (typeof s === "function") s();
  }

  return {
    start,
    stop,
    check,
    refresh,
    updateAll,
    updateSome,
    applyOwn,
    switchBack,
    get last() {
      return last;
    },
    get busy() {
      return busy;
    },
    get pending() {
      return pending;
    },
  };
}

/** Storage that never throws: a private window or blocked site data is a page without the convenience. */
function safeStore(get) {
  const store = () => {
    try {
      return get();
    } catch {
      return null;
    }
  };
  return {
    get: (key) => {
      try {
        return store()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        store()?.setItem(key, value);
      } catch {
        /* a convenience, not state */
      }
    },
    remove: (key) => {
      try {
        store()?.removeItem(key);
      } catch {
        /* a convenience, not state */
      }
    },
  };
}

/**
 * Which replies are running, from the turn events, for a page whose seam has no `ext.turns` yet. It only knows
 * the replies it saw start, which is the best a page that just opened can do.
 */
function turnsFromEvents(ext) {
  const running = new Set();
  const idle = new Set();
  ext.events.watch((message) => {
    const { session, event } = message ?? {};
    if (!session || !event) return;
    if (event.type === "turn.start") running.add(session);
    if (event.type === "turn.end") {
      running.delete(session);
      if (!running.size) for (const fn of [...idle]) fn();
    }
  });
  return {
    running: () => running.size > 0,
    onIdle: (fn) => {
      idle.add(fn);
      return () => idle.delete(fn);
    },
  };
}

/** Waits for the space to answer again, for a page whose seam has no `ext.awaitReturn` yet. */
async function pollReturn(ext, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  await new Promise((done) => setTimeout(done, 1500));
  for (;;) {
    try {
      await ext.request("updates");
      return "back";
    } catch {
      if (Date.now() >= deadline) return "timeout";
      await new Promise((done) => setTimeout(done, 700));
    }
  }
}

/** A card's raw error text goes under a Details fold, never in the sentence itself. */
function withDetails(ext, spec) {
  if (!spec.details) return spec;
  const { el } = ext.dom;
  const { details, ...rest } = spec;
  return { ...rest, body: el("div", {}, el("p", { class: "notice-body" }, spec.body ?? ""), el("details", { class: "mk-details" }, el("summary", {}, "Details"), el("pre", { class: "mk-wrap" }, details))) };
}

/** The real dependencies, from the seam. Every newer seam function is guarded, so an older gateway still works. */
export function extDeps(ext) {
  const turns = ext.turns && typeof ext.turns.running === "function" ? ext.turns : turnsFromEvents(ext);
  const hasNotice = typeof ext.notice === "function";
  return {
    request: async (verb, args) => (await ext.request(verb, { args }))?.data ?? {},
    notice: (id, spec) => (hasNotice ? ext.notice(id, withDetails(ext, spec)) : null),
    closeNotice: (id) => {
      if (hasNotice && typeof ext.notice.close === "function") ext.notice.close(id);
    },
    running: () => !!turns.running(),
    onIdle: (fn) => turns.onIdle(fn),
    awaitReturn: (opts) => (typeof ext.awaitReturn === "function" ? ext.awaitReturn(opts) : pollReturn(ext, opts?.timeoutMs ?? 90_000)),
    reloadPage: () => location.reload(),
    toast: (text, opts) => ext.toast(text, opts),
    openReview: () => ext.open.place("marketplace", { view: "updates" }),
    local: safeStore(() => globalThis.localStorage),
    session: safeStore(() => globalThis.sessionStorage),
    every: (ms, fn) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    },
    later: (ms, fn) => setTimeout(fn, ms),
    onVisible: (fn) => {
      const on = () => {
        if (document.visibilityState === "visible") fn();
      };
      document.addEventListener("visibilitychange", on);
      return () => document.removeEventListener("visibilitychange", on);
    },
    now: () => Date.now(),
    ask: (text) => globalThis.confirm?.(text) ?? false,
  };
}

/** The one updater of this page, set by index.js when the module installs; the gallery and the extension page use it. */
let current = null;
export const setUpdater = (u) => (current = u);
export const updater = () => current;

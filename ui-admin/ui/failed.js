/* When a section's command fails, the section says so, instead of drawing what an empty answer would look
 * like. "0 mounts" from an error is a lie the reader acts on; "Mounts could not be read" is the truth, and
 * it comes with what fixes it. A load error in a host package (the daemon holding a stale copy of one of
 * its modules) is the common case, and only a restart of Thetis fixes that, so an admin gets that button in
 * the same card. The raw text is kept, folded under Details, because it is what someone at the host needs.
 * A toast never carries a module error raw either: `toastError` says the plain sentence. */

/** The raw text of an error, whatever threw it. */
const rawOf = (err) => String(err?.message ?? err ?? "").trim();

/** An error the gateway lost rather than one it answered: status 0 (no answer) or the door's own 502/503/504. */
export function isLost(err) {
  const status = Number(err?.status);
  return Number.isFinite(status) && (status === 0 || status >= 502);
}

/** A module the daemon loaded that does not match what calls it: only a restart replaces it. */
const LOAD_ERROR = /does not provide an export named|does not export a method named|Cannot find (module|package)|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|SyntaxError|Unexpected token|no host package named|is not a constructor/i;

/**
 * An error in plain words: `reason` (why, one clause), `fix` (what fixes it, one sentence), `restart` (only a
 * restart of Thetis fixes it), and `raw` for the Details fold. A refusal the kernel wrote as a sentence is
 * passed through, since it is already plain; anything that looks like code is not.
 */
export function plainFailure(err, { admin = false } = {}) {
  const raw = rawOf(err);
  if (LOAD_ERROR.test(raw)) {
    return { reason: "part of Thetis needs a restart to load this page", fix: admin ? "Restart Thetis to load it; running replies pause at a safe point and continue after." : "Ask an admin to restart Thetis.", restart: true, raw };
  }
  const status = Number(err?.status);
  if (isLost(err)) return { reason: "Thetis did not answer", fix: "It may be restarting. Try again in a moment.", restart: false, raw };
  if (status === 401 || status === 403 || /unauthori[sz]ed|only an admin/i.test(raw)) return { reason: "you are not allowed to read it", fix: admin ? "Sign in again." : "An admin can read it for you.", restart: false, raw };
  if (/timed? ?out|timeout/i.test(raw)) return { reason: "it took too long to answer", fix: "Try again.", restart: false, raw };
  // A sentence without code in it is the kernel's or a package's own refusal: short, and said as it is.
  const codeLike = !raw || raw.length > 200 || /\n\s+at |\bat file:|node:|\.js:\d+|[{}<>]|Error:/.test(raw);
  if (!codeLike) return { reason: raw.replace(/[.\s]+$/, ""), fix: "Try again; if it keeps happening, Details has what to report.", restart: false, raw };
  return { reason: "something went wrong on the server", fix: "Try again; if it keeps happening, Details has what to report.", restart: false, raw };
}

/** "Mounts could not be read: <reason>. <fix>" as one string, for a place that has no room for a card. */
export function failureSentence(what, err, opts) {
  const f = plainFailure(err, opts);
  return `${what} could not be read: ${f.reason}. ${f.fix}`;
}

/** A toast for a failed act: the plain sentence, never a module error. `lead` names what was being done. */
export function toastError(ext, err, lead = null) {
  const f = plainFailure(err, { admin: ext.can?.("status") ?? false });
  const text = f.restart ? `${lead ? `${lead}: ` : ""}${f.reason}. ${f.fix}` : `${lead ? `${lead}: ` : ""}${f.reason.charAt(0).toUpperCase()}${f.reason.slice(1)}.`;
  ext.toast(text, { tone: "error" });
}

/**
 * Asks the latch for a restart, from a page that failed to load. Behind a confirm, with the reason filled in:
 * it is shown to everyone waiting and written to the journal. The latch's own sentence is the answer.
 */
export async function askRestart(ext, anchor, what) {
  const reason = `${what} could not load: part of Thetis needs a restart`;
  const ok = await ext.ui.confirm(anchor, { title: "Restart Thetis?", lines: [["reason", reason]], note: "Running replies pause at a safe point and continue after the restart. Open terminal sessions end. This page reconnects by itself.", confirmLabel: "Restart Thetis", tone: "warn" });
  if (!ok) return null;
  try {
    const out = await ext.request("restart-request", { args: { reason } });
    const said = out?.data?.message || "Asked.";
    ext.toast(said, { tone: out?.data?.state === "refused" ? "warn" : "good" });
    return out?.data ?? null;
  } catch (err) {
    toastError(ext, err, "The restart could not be asked for");
    return null;
  }
}

/**
 * The card a section draws instead of its content when its command failed. `what` is the subject ("Mounts",
 * "The people"), `retry` reads again, and the admin's Restart Thetis is offered when only a restart fixes it.
 */
export function failedCard(ext, what, err, { admin = false, retry = null } = {}) {
  const { el } = ext.dom;
  const { button, card } = ext.ui;
  const f = plainFailure(err, { admin });
  const actions = [];
  if (f.restart && admin && ext.can?.("restart-request") !== false) {
    const b = button("Restart Thetis", { tone: "warn", onClick: () => void askRestart(ext, b, what) });
    actions.push(b);
  }
  if (retry) actions.push(button("Try again", { onClick: () => retry() }));
  const node = card(
    null,
    el("p", { class: "ua-failed-line" }, el("b", {}, `${what} could not be read: `), `${f.reason}. `, f.fix),
    actions.length ? el("div", { class: "card-actions" }, ...actions) : null,
    f.raw ? el("details", { class: "ua-details" }, el("summary", {}, "Details"), el("pre", { class: "ua-pre" }, f.raw)) : null
  );
  node.classList.add("ua-failed");
  return node;
}

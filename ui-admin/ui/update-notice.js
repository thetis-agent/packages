/* The admin's bottom-right card for updating Thetis: `ext.notice("thetis-update")`, declared in the manifest
 * for admins only. It asks host-update on load and every 30 minutes while the page is visible
 * (`fetch: "stale"`, so the real git fetch happens at most once per half hour for the whole installation,
 * however many admin tabs are open), and draws whatever `describe` says about the flow it shares with the
 * Overview: "Thetis update available · N changes" with one button, the progress of the job, "Back online",
 * or a failure with its fix. A card the admin dismisses stays away until it means something new. */

import { CHECK_EVERY_MS, describe } from "./update-flow.js";

export const NOTICE_ID = "thetis-update";

/**
 * The actions a card names, wired to the flow and the page. `log` opens the Overview, where the job's step
 * log and the checkout's changed files are; `copy` puts a card's command on the clipboard.
 */
export function actionRunner(ext, flow) {
  return (action) => {
    switch (action.id) {
      case "update":
      case "retry":
        return flow.apply();
      case "restart":
        return flow.restart();
      case "cancel":
        return flow.cancel();
      case "wait":
        return flow.wait();
      case "changes":
        return flow.toggleChanges();
      case "reload":
        return location.reload();
      case "log":
        return ext.open?.panel?.("overview");
      case "copy":
        return navigator.clipboard?.writeText(action.text ?? "").then(() => ext.toast("Copied.", { tone: "good" }), () => ext.toast(action.text ?? "", { tone: "info" }));
      default:
        return undefined;
    }
  };
}

/**
 * The body as the notice draws it: a string for one line, and for several (the list of changes) a node with a
 * line each, because the notice sets a string body as one paragraph. `el` is the page's; without it, the string.
 */
export function bodyOf(text, el) {
  if (!text) return undefined;
  if (!el || !String(text).includes("\n")) return text;
  return el("div", { class: "notice-body" }, ...String(text).split("\n").map((line) => el("div", {}, line)));
}

/** What `ext.notice` takes, from a described card. */
export function noticeOptions(card, run, onDismiss, el = null) {
  return {
    title: card.title,
    body: bodyOf(card.body, el),
    tone: card.tone === "error" ? "error" : card.tone === "warn" ? "warn" : card.tone === "ok" ? "ok" : "info",
    actions: (card.actions ?? []).map((a) => ({ label: a.label, primary: Boolean(a.primary), run: () => run(a) })),
    ...(card.progress ? { progress: { steps: card.progress.steps, at: card.progress.at, ...(card.progress.failed ? { failed: true } : {}) } } : {}),
    dismissible: card.dismissible !== false,
    onDismiss,
  };
}

/**
 * Installs the card. Nothing happens without `ext.notice` (an older gateway) or for a person whose role does
 * not clear `update-check` (the gateway lists no admin verb to a user, and this is the same test). Answers
 * the stop function.
 */
export function installUpdateNotice(ext, flow, { every = CHECK_EVERY_MS, doc = globalThis.document } = {}) {
  if (typeof ext.notice !== "function" || !ext.can?.("update-check")) return () => {};
  const run = actionRunner(ext, flow);
  let handle = null;
  let shownKey = null;
  let dismissed = null;
  let lastCheck = 0;

  function draw(state) {
    const card = describe(state);
    if (!card || card.key === dismissed) {
      if (handle) handle.close?.();
      handle = null;
      shownKey = null;
      return;
    }
    const options = noticeOptions(
      card,
      run,
      () => {
        dismissed = card.key;
        handle = null;
        shownKey = null;
        flow.dismiss();
      },
      ext.dom?.el ?? null
    );
    // The same card replaced in place; a new one when it means something new.
    if (handle && shownKey === card.key && typeof handle.update === "function") handle.update(options);
    else handle = ext.notice(NOTICE_ID, options);
    shownKey = card.key;
  }

  const visible = () => !doc || doc.visibilityState !== "hidden";
  const check = () => {
    lastCheck = Date.now();
    return flow.refresh({ fetch: "stale" });
  };

  const stop = flow.subscribe(draw);
  void flow.resume().then(() => check());
  const timer = setInterval(() => {
    if (visible()) void check();
  }, every);
  const onVisible = () => {
    if (visible() && Date.now() - lastCheck >= every) void check();
  };
  doc?.addEventListener?.("visibilitychange", onVisible);
  return () => {
    stop();
    clearInterval(timer);
    doc?.removeEventListener?.("visibilitychange", onVisible);
    handle?.close?.();
  };
}

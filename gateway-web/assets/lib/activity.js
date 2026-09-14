/* What a conversation is doing right now, worked out from its turn events. The sidebar draws it, the
 * favicon and the tab title count it. Every session's events arrive on the stream, so a conversation
 * that is not open still shows its step. */

import { store } from "./store.js";

/** Must equal --sheen in theme.css: the sidebar sheen is phase-locked to wall time with this period. */
export const SHEEN_MS = 2600;

function fresh(since) {
  return { state: "working", step: "Starting", tool: false, since, steps: 0, cost: 0, tokens: 0, outcome: null };
}

/** Applies one turn event to a session's activity record. `startedAt` is the turn's start when known. */
export function applyActivity(session, event, startedAt) {
  const had = store.activityOf(session);
  switch (event.type) {
    case "turn.start":
      return store.setActivity(session, fresh(Date.parse(startedAt || "") || Date.now()));
    case "step.start": {
      const record = had?.state === "working" ? had : fresh(Date.now());
      const builtin = event.step?.package === "@thetis/kernel";
      return store.setActivity(session, { ...record, step: builtin ? "Thinking" : stepName(event.step), tool: false });
    }
    case "text": {
      if (had?.state !== "working") return;
      if (had.step === "Writing a reply") return;
      return store.setActivity(session, { ...had, step: "Writing a reply", tool: false });
    }
    case "tool.call": {
      const record = had?.state === "working" ? had : fresh(Date.now());
      return store.setActivity(session, { ...record, step: event.call?.name || "tool", tool: true, steps: record.steps + 1 });
    }
    case "tool.result": {
      if (had?.state !== "working") return;
      return store.setActivity(session, { ...had, step: "Thinking", tool: false });
    }
    case "usage": {
      if (had?.state !== "working") return;
      const u = event.usage ?? {};
      return store.setActivity(session, { ...had, cost: had.cost + (typeof u.cost === "number" ? u.cost : 0), tokens: had.tokens + (typeof u.completion_tokens === "number" ? u.completion_tokens : 0) });
    }
    case "error": {
      const record = had ?? fresh(Date.now());
      if (event.code === "cancelled") return store.setActivity(session, { ...record, state: "stopped", outcome: "Stopped by you" });
      return store.setActivity(session, { ...record, state: "failed", outcome: event.message || "the turn failed" });
    }
    case "turn.end": {
      if (!had) return;
      if (had.state === "working") return store.setActivity(session, null);
      // A failure or a stop stays on the row until the next turn starts, so it is seen.
      return store.setActivity(session, { ...had, since: Date.now() });
    }
    default:
      return;
  }
}

function stepName(step) {
  const id = step?.id || step?.export || "";
  return id ? id.replace(/[-_]+/g, " ") : "Working";
}

/** Phase-locks a row's sheen to wall time so a redraw does not restart it and every working row moves together.
 * Set through the CSSOM: the page's Content Security Policy allows no style attributes. */
export function applyActivityPhase(node, activity) {
  if (activity?.state !== "working") return;
  node.style.setProperty("--phase", `-${String(Date.now() % SHEEN_MS)}ms`);
}

/** How many conversations are working right now. */
export function countWorking() {
  let n = 0;
  for (const record of store.get("activity").values()) if (record.state === "working") n += 1;
  return n;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

export function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 45_000) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  return new Date(Date.now() - ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Money: two decimals above a cent, four below, because "$0.00" reads as free. */
export function fmtCost(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

export function fmtTokens(n) {
  if (typeof n !== "number") return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** `anthropic/claude-sonnet-5` -> `claude-sonnet-5`; a `:free` or `:beta` suffix is kept. */
export function shortModel(id) {
  return String(id || "").split("/").pop() || "";
}

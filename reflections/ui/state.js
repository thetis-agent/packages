/* The words and tones of a reflection's state, a proposal's and a finding's, shared by the chip and the
 * place. Pure, so a test needs no DOM. `state` "none" is an archived conversation with no record: never
 * reflected, and never reflected automatically either, so its label carries the button that would. */

export const money = (n) => (typeof n === "number" && Number.isFinite(n) ? `$${n < 0.01 && n > 0 ? n.toFixed(3) : n.toFixed(2)}` : "");
/** Whole dollars without cents: "$5", "$2.50". */
export const dollars = (n) => (typeof n === "number" && Number.isFinite(n) ? (Number.isInteger(n) ? `$${n}` : money(n)) : "");
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** A skipped record's reason, short enough for a chip. */
export function shortReason(reason) {
  const r = String(reason ?? "");
  if (r.startsWith("too short")) return "too short";
  if (r === "switched off for this project") return "off for this project";
  if (r.startsWith("switched off")) return "switched off";
  if (r === "daily cost cap reached") return "daily cap reached";
  return r || "skipped";
}

/** What a done reflection gave: "1 proposal · 2 findings", or "nothing to propose". */
function gave(record) {
  const proposals = typeof record?.proposal === "string" && record.proposal ? 1 : 0;
  const findings = Array.isArray(record?.findings) ? record.findings.length : 0;
  const parts = [proposals && plural(proposals, "proposal"), findings && plural(findings, "finding")].filter(Boolean);
  return parts.length ? parts.join(" · ") : "nothing to propose";
}

/** `{ label, tone, action }` for a record (or `{ state: "none" }`); `action` names the button the place shows first. */
export function describe(record) {
  const state = record?.state ?? "none";
  switch (state) {
    case "queued":
      return { label: "Queued", tone: "dim", action: "cancel" };
    case "running":
      return { label: "Reflecting…", tone: "accent", action: "cancel", busy: true };
    case "done":
      return { label: ["Reflected", gave(record), money(record.costUsd)].filter(Boolean).join(" · "), tone: "ok", action: "again" };
    case "skipped":
      return { label: `Skipped: ${shortReason(record.reason)}`, tone: "dim", action: "reflect" };
    case "failed":
      return { label: "Failed · Retry", tone: "err", action: "retry" };
    case "cancelled":
      return { label: "Cancelled · Reflect", tone: "dim", action: "reflect" };
    default:
      return { label: "Not reflected · Reflect", tone: "dim", action: "reflect" };
  }
}

/** Whether the chip shows for a conversation: archived, or anything recorded that is still worth seeing. */
export function chipVisible(record, archived) {
  const state = record?.state ?? "none";
  if (archived) return true;
  // A restore cancels what had not run; that is the expected end of a restore and not worth a chip.
  return state !== "none" && state !== "cancelled";
}

/** The sentence under a state in the detail: why it is what it is. */
export function explain(record) {
  switch (record?.state) {
    case "queued":
      return record.note ?? (record.manual ? "Queued because you asked. It runs as soon as the reflection before it is done." : "Queued when you archived it. It runs as soon as the reflection before it is done.");
    case "running":
      return `Reading the conversation${record.model ? ` with ${record.model}` : ""}. This takes a minute or a few.`;
    case "done":
      return record.proposal ? "Reflected. It proposed one change; nothing changes until you trial it and adopt it." : `Reflected. ${capital(record.reason ?? "nothing to propose")}.`;
    case "skipped":
      return `Not reflected automatically: ${record.reason ?? "skipped"}${record.detail ? ` (${record.detail})` : ""}. Reflect runs it anyway.`;
    case "failed":
      return `The reflection failed: ${record.error ?? "no reason was recorded"}.`;
    case "cancelled":
      return `Cancelled: ${record.reason ?? "cancelled"}.`;
    default:
      return record?.reason === "archived before Reflections was installed"
        ? "Archived before Reflections was installed, so it was never reflected on. Reflect runs it now."
        : "Archived without a reflection. Reflect runs one now.";
  }
}

// ---- proposals ----

export const KINDS = Object.freeze({ skill: "Skill", "project-instructions": "Project instructions", "guide-note": "Guide note", config: "Setting" });

/** What a proposal changes, in a line: "Skill thetis-packages", "Project instructions for Nova", "Guide note". */
export function changeLabel(entry) {
  const kind = KINDS[entry?.kind] ?? String(entry?.kind ?? "Change");
  if (entry?.kind === "guide-note") return kind;
  if (entry?.kind === "project-instructions") return `${kind} for ${entry.targetName ?? entry.target ?? "a project"}`;
  return entry?.target ? `${kind} ${entry.target}` : kind;
}

/** The groups of the Proposals tab, in order; the last is drawn collapsed. */
export const GROUPS = Object.freeze([
  { id: "proposed", label: "Needs a trial", states: ["proposed"] },
  { id: "trialling", label: "Trialling", states: ["trialling"] },
  { id: "trialled", label: "Ready to decide", states: ["trialled"] },
  { id: "adopted", label: "Adopted", states: ["adopted"] },
  { id: "closed", label: "Rejected and retired", states: ["rejected", "retired"], collapsed: true },
]);

/** The tone of a trial's verdict: helped is good news, hurt is bad, the rest says little. */
export function verdictTone(result) {
  const r = String(result ?? "");
  if (r.startsWith("helped")) return "ok";
  if (r.startsWith("hurt")) return "err";
  if (r.startsWith("inconclusive")) return "warn";
  return "dim";
}

/** A proposal's pill: the trial running, else the verdict, else where it stands. */
export function proposalChip(entry) {
  const state = entry?.state;
  if (state === "trialling") return { label: "Trialling…", tone: "accent", busy: true };
  if (state === "rejected") return { label: "Rejected", tone: "dim" };
  if (state === "retired") return { label: "Retired", tone: "dim" };
  const v = entry?.verdict;
  if (v?.result) return { label: `Trial: ${v.result}`, tone: verdictTone(v.result) };
  if (v?.error) return { label: "Trial failed", tone: "err" };
  return { label: "No trial yet", tone: "dim" };
}

/** Whether a trial may start, and the reason when not. */
export function canTrial(entry) {
  const state = entry?.state;
  if (state === "trialling") return { ok: false, reason: "A trial is running." };
  if (state === "proposed" || state === "trialled" || state === "adopted") return { ok: true };
  return { ok: false, reason: state === "retired" ? "It was retired." : "It was rejected." };
}

/** The Run trial button: "Run trial (2 runs each, up to $5)", or "Run trial again (…)" after one. */
export function trialLabel(entry, { runs = 2, costUsd = 5 } = {}) {
  const again = (entry?.trials?.length ?? 0) > 0 || Boolean(entry?.verdict);
  return `Run trial${again ? " again" : ""} (${plural(runs, "run")} each, up to ${dollars(costUsd)})`;
}

/**
 * The Adopt button for an entry: `null` when it has none (adopted without a re-check, rejected, retired),
 * else `{ label, disabled, reason }`. Before a trial it is disabled with the reason; after a verdict
 * other than helped it reads "Adopt anyway".
 */
export function adoptButton(entry) {
  const state = entry?.state;
  if (state === "rejected" || state === "retired") return null;
  if (state === "adopted" && !entry.recheck) return null;
  if (state === "trialling") return { label: "Adopt", disabled: true, reason: "Wait for the trial to finish." };
  // A proposal back from a cancelled or failed trial has no judgement yet, whatever its verdict says.
  if (state === "proposed" || !entry?.verdict?.result) return { label: "Adopt", disabled: true, reason: "Run a trial first." };
  return { label: String(entry.verdict.result).startsWith("helped") ? "Adopt" : "Adopt anyway", disabled: false, reason: null };
}

/** How many runs saw the change, from a verdict's `seen` in whatever form it was recorded. */
export function seenLine(seen) {
  if (seen === true) return "The change was seen in the trial.";
  if (seen === false) return "The change was not seen in any run: the trial may not have tested it.";
  const list = Array.isArray(seen) ? seen : seen && typeof seen === "object" ? Object.values(seen) : null;
  if (!list?.length) return null;
  const yes = list.filter((x) => x === true || x?.seen === true).length;
  return yes ? `The change was seen in ${yes} of ${plural(list.length, "run")} with it.` : "The change was not seen in any run: the trial may not have tested it.";
}

export const ARMS = Object.freeze({ base: "Without the change", change: "With the change" });

/** A run's state in words. */
export function runState(state) {
  return { queued: "waiting", running: "running", done: "done", failed: "failed", cancelled: "cancelled", budget: "stopped at the cost cap", timeout: "stopped at the time limit" }[state] ?? (state || "waiting");
}

// ---- findings ----

/** A finding's pill: Open, Possibly fixed in 0.5.0, Closed. */
export function findingChip(f) {
  if (f?.state === "closed") return { label: "Closed", tone: "dim" };
  if (f?.state === "possibly-fixed") return { label: f.since ? `Possibly fixed in ${f.since}` : "Possibly fixed", tone: "ok" };
  return { label: "Open", tone: "warn" };
}

/** Findings by package, open ones first in each, packages by name. */
export function groupFindings(findings) {
  const rank = { open: 0, "possibly-fixed": 1, closed: 2 };
  const groups = new Map();
  for (const f of findings ?? []) groups.set(f.package ?? "unknown", [...(groups.get(f.package ?? "unknown") ?? []), f]);
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, items]) => [name, items.sort((a, b) => (rank[a.state] ?? 0) - (rank[b.state] ?? 0))]);
}

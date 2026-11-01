/* The words and tones of a reflection's state, a proposal's and a finding's, shared by the chip and the
 * place. Pure, so a test needs no DOM. `state` "none" is an archived conversation with no record: never
 * reflected, and never reflected automatically either, so its label carries the button that would. */

export const money = (n) => (typeof n === "number" && Number.isFinite(n) ? `$${n < 0.01 && n > 0 ? n.toFixed(3) : n.toFixed(2)}` : "");
/** Whole dollars without cents: "$5", "$2.50". */
export const dollars = (n) => (typeof n === "number" && Number.isFinite(n) ? (Number.isInteger(n) ? `$${n}` : money(n)) : "");
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Whether a record was skipped by the daily limit; a record older than `skip` carries the reason alone. */
export const isCapSkip = (r) => r?.state === "skipped" && (r.skip === "cap" || r.reason === "daily cost cap reached");

/** A skipped record's reason, short enough for a chip. */
export function shortReason(reason) {
  const r = String(reason ?? "");
  if (r.startsWith("too short")) return "too short";
  if (r === "switched off for this project") return "off for this project";
  if (r.startsWith("switched off")) return "switched off";
  if (r === "daily cost cap reached") return "daily limit";
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
      return { label: isCapSkip(record) ? "Not reflected: daily limit" : `Skipped: ${shortReason(record.reason)}`, tone: "dim", action: "reflect" };
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
      return record.proposal ? "Reflected. It proposed one change; nothing changes until you adopt it." : `Reflected. ${capital(record.reason ?? "nothing to propose")}.`;
    case "skipped":
      if (isCapSkip(record)) return `Not reflected: the daily limit was reached${record.detail ? ` (${record.detail})` : ""}. Reflect runs it anyway.`;
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

/** Where a proposal goes, as a card says it: "Guide note", "Torchship instructions", "Skill thetis-packages". */
export function whereLabel(entry) {
  if (entry?.kind === "project-instructions") return `${entry.targetName ?? entry.target ?? "Project"} instructions`;
  return changeLabel(entry);
}

/** The groups of the Proposals tab, in order; the last is drawn collapsed. */
export const GROUPS = Object.freeze([
  { id: "proposed", label: "Not tried", states: ["proposed"] },
  { id: "trialling", label: "Trialling", states: ["trialling"] },
  { id: "trialled", label: "Ready", states: ["trialled"] },
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

/** Whether an entry's file moved since the proposal (`staleness` as the ops answer it). */
export const outOfDate = (entry) => entry?.staleness === "mergeable" || entry?.staleness === "conflict";

/**
 * A proposal's pill: the trial running; Out of date; the verdict of a trial of this text; Edited; Not tried.
 * A verdict marked `stale` was for an earlier text, so it does not speak for this one.
 */
export function proposalChip(entry) {
  const state = entry?.state;
  if (state === "trialling") return { label: "Trialling…", tone: "accent", busy: true };
  if (state === "rejected") return { label: "Rejected", tone: "dim" };
  if (state === "retired") return { label: "Retired", tone: "dim" };
  if (outOfDate(entry)) return { label: "Out of date", tone: "warn" };
  const v = entry?.verdict && !entry.verdict.stale ? entry.verdict : null;
  if (v?.result) return { label: `Trial: ${v.result}`, tone: verdictTone(v.result) };
  if (state === "adopted") return { label: "Adopted", tone: "ok" };
  if (entry?.edited) return { label: "Edited", tone: "dim" };
  if (entry?.rebasedAt) return { label: "Updated", tone: "dim" }; // merged into today's file by Update, not by the person's hand
  if (v?.error) return { label: "Trial failed", tone: "err" };
  return { label: "Not tried", tone: "dim" };
}

/** Whether a trial may start, and the reason when not. */
export function canTrial(entry) {
  const state = entry?.state;
  if (state === "trialling") return { ok: false, reason: "A trial is running." };
  if (state === "proposed" || state === "trialled" || state === "adopted") return { ok: true };
  return { ok: false, reason: state === "retired" ? "It was retired." : "It was rejected." };
}

/** The trial button: "Try first (up to $5)", or "Try again (up to $5)" after one. */
export function trialLabel(entry, { costUsd = 5 } = {}) {
  const again = (entry?.trials?.length ?? 0) > 0 || Boolean(entry?.verdict);
  return `${again ? "Try again" : "Try first"} (up to ${dollars(costUsd)})`;
}

/** What is shown in place of the trial button when a trial cannot test the proposal. */
export const OFFLINE_NOTE = "A trial runs offline, so it cannot test this.";
export const CONFLICT_NOTE = "The file changed in the same place. Edit it to include the change.";

/**
 * A proposal's main button: `null` when it has none (adopted without a re-check, rejected, retired), else
 * `{ label, action: "adopt" | "update" | "edit", untried, disabled, reason }`. Out of date, it is Update
 * when the change merges and Edit when it does not. Not tried, Adopt goes ahead without a trial
 * (`untried`). After a trial it is Adopt, or "Adopt anyway" when the trial said hurt or inconclusive.
 */
export function adoptButton(entry) {
  const state = entry?.state;
  if (state === "rejected" || state === "retired") return null;
  if (state === "adopted" && !entry.recheck) return null;
  if (state === "trialling") return { label: "Adopt", action: "adopt", untried: false, disabled: true, reason: "Wait for the trial to finish." };
  if (entry?.staleness === "mergeable") return { label: "Update", action: "update", untried: false, disabled: false, reason: "The file changed since the proposal. Update merges the change into it." };
  if (entry?.staleness === "conflict") return { label: "Edit", action: "edit", untried: false, disabled: false, reason: CONFLICT_NOTE };
  if (state === "proposed") return { label: "Adopt", action: "adopt", untried: true, disabled: false, reason: null };
  const result = entry?.verdict && !entry.verdict.stale ? String(entry.verdict.result ?? "") : "";
  const anyway = result.startsWith("hurt") || result.startsWith("inconclusive");
  return { label: anyway ? "Adopt anyway" : "Adopt", action: "adopt", untried: false, disabled: false, reason: null };
}

/** Whether the person may edit a proposal: before it is adopted, and not while a trial runs. */
export const canEdit = (entry) => entry?.state === "proposed" || entry?.state === "trialled";

/** A JSON value as the popover says it: the value, or "not set". */
const valueText = (json) => (json === null || json === undefined ? "not set" : String(json));

/**
 * The popover Adopt asks with: `{ title, lines, note, confirmLabel }`. Untried, it says so; a setting says
 * what it is now and what this sets, when that moved since the proposal.
 */
export function adoptPopover(entry) {
  const button = adoptButton(entry) ?? { label: "Adopt", untried: false };
  const moved = entry?.kind === "config" && entry.current !== undefined && entry.current !== entry.before;
  const notes = [
    button.untried ? "It applies to new conversations from now on. You can retire it later." : "It applies to new conversations from now on. Retire undoes it.",
    moved ? `It is ${valueText(entry.current)} now; this sets ${valueText(entry.change)}.` : null,
  ].filter(Boolean);
  const v = entry?.verdict && !entry.verdict.stale ? entry.verdict : null;
  return {
    title: button.untried ? "Adopt without trying it?" : "Adopt this change?",
    lines: [["Change", whereLabel(entry)], ...(v?.result ? [["Trial", v.result]] : [])],
    note: notes.join(" "),
    confirmLabel: button.label === "Adopt anyway" ? "Adopt anyway" : "Adopt",
  };
}

// ---- To review ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "30 Oct", in UTC. */
export function shortDate(iso) {
  const d = new Date(iso ?? "");
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The count line: "4 proposals · 6 findings · 11 not reflected", or "Nothing to review." */
export function reviewLine(counts = {}) {
  const parts = [
    counts.proposals ? plural(counts.proposals, "proposal") : null,
    counts.findings ? plural(counts.findings, "finding") : null,
    counts.skipped ? `${counts.skipped} not reflected` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing to review.";
}

/** "Seen in 3 conversations". */
export const seenIn = (entry) => `Seen in ${plural(entry?.from?.length ?? 0, "conversation")}`;

/** "Seen 16 times, last 30 Oct". */
export function findingSeen(f) {
  const n = f?.seen?.length ?? 0;
  const last = shortDate(f?.lastAt ?? (f?.seen ?? []).reduce((m, x) => (String(x?.at ?? "") > m ? String(x.at) : m), ""));
  return `Seen ${n === 1 ? "once" : `${n} times`}${last ? `, last ${last}` : ""}`;
}

/** About what a batch costs: whole dollars from $10, cents below. */
const about = (usd) => (typeof usd === "number" && Number.isFinite(usd) ? (usd >= 10 ? dollars(Math.round(usd)) : money(usd)) : null);

/** "11 archived conversations were not reflected: the $5 daily limit was reached." */
export function skippedLine({ count = 0, capUsd } = {}) {
  const limit = dollars(capUsd);
  return `${count === 1 ? "1 archived conversation was" : `${count} archived conversations were`} not reflected: the ${limit ? `${limit} ` : ""}daily limit was reached.`;
}

/** "Reflect them (about $14)", "Reflect it (about $1.28)", or without the estimate when none is known. */
export function reflectSkippedLabel({ count = 0, estimateUsd } = {}) {
  const cost = about(estimateUsd);
  return `Reflect ${count === 1 ? "it" : "them"}${cost ? ` (about ${cost})` : ""}`;
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

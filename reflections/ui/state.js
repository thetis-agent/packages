/* The words and tones of a reflection's state, shared by the chip and the place. Pure, so a test needs no
 * DOM. `state` "none" is an archived conversation with no record: never reflected, and never reflected
 * automatically either, so its label carries the button that would. */

export const money = (n) => (typeof n === "number" && Number.isFinite(n) ? `$${n < 0.01 && n > 0 ? n.toFixed(3) : n.toFixed(2)}` : "");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A skipped record's reason, short enough for a chip. */
export function shortReason(reason) {
  const r = String(reason ?? "");
  if (r.startsWith("too short")) return "too short";
  if (r === "switched off for this project") return "off for this project";
  if (r.startsWith("switched off")) return "switched off";
  if (r === "daily cost cap reached") return "daily cap reached";
  return r || "skipped";
}

/** `{ label, tone, action }` for a record (or `{ state: "none" }`); `action` names the button the place shows first. */
export function describe(record, { lessons = 0 } = {}) {
  const state = record?.state ?? "none";
  switch (state) {
    case "queued":
      return { label: "Queued", tone: "dim", action: "cancel" };
    case "running":
      return { label: "Reflecting…", tone: "accent", action: "cancel", busy: true };
    case "done": {
      const cost = money(record.costUsd);
      return { label: ["Reflected", lessons ? plural(lessons, "lesson") : "no lesson", cost].filter(Boolean).join(" · "), tone: "ok", action: "again" };
    }
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
      return record.lesson ? "Reflected, and one lesson was kept as a skill." : `Reflected. ${capital(record.reason ?? "no lesson")}.`;
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

const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

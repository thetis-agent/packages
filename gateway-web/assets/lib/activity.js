/* What each conversation is doing, and how a conversation list is ordered.
 *
 * Pure: no DOM, no store, no globals, no clock of its own. views/sessions.js
 * draws what these return and app.js feeds them frames; both are testable only
 * because nothing in here reaches for anything (activity.test.ts).
 *
 * ---------------------------------------------------------------------------
 * What this wire can carry, and what it cannot
 *
 * The legacy sidebar drew its liveness from an `activity` frame the host
 * pushed for *every* conversation the account could see, whether or not this
 * tab was watching it, each snapshot carrying a host-assigned `rev`.
 *
 * This wire has no such frame. wire.ts sends `event` frames only for
 * conversations this socket has subscribed to (`#streams`, filled by `open`),
 * so activity here is *derived from the event stream* and exists only for
 * conversations with an open tab. A conversation sitting unopened in the
 * sidebar cannot be shown working, because nothing about it reaches this tab
 * at all. That is a wire limit, not a drawing decision.
 *
 * `waiting` is missing for the same reason and one more: no frame on this wire
 * means "stopped to ask you something". `turn-finished` carries `stopped_by`
 * (answer/limit/cancel/crash/restart — contracts/turn-events' `end.reason`),
 * none of which is a question. So this module has `working`, `failed` and
 * `idle`, and says nothing it cannot know.
 *
 * ---------------------------------------------------------------------------
 * Why ordering is still merged (the `rev` reasoning, lifted)
 *
 * Legacy merged activity snapshots by `rev` because a pushed change and a
 * `sessions` reply travel different paths and can arrive in either order;
 * taking whichever landed last left a row saying "working" after the push that
 * said it had finished.
 *
 * The same crossing exists here, in a different pair. Activity comes off one
 * ordered stream per socket, so it cannot race itself — but the row's title,
 * preview and recency come from a `sessions` *reply*, and app.js asks for that
 * list at exactly the moments they change (a message sent, a turn finished).
 * A reply requested before a turn ended can land after it, carrying the older
 * row. `updatedMs` is the host's own monotonic stamp for that row — the store
 * moves it on every recorded change (core/session-store.ts `record`) — so it
 * serves as the `rev`: `mergeSessions` keeps the newer of a held and an
 * incoming row rather than trusting arrival order.
 */

/** One pass of the sheen over a working row. Matches `--sheen` in theme.css. */
export const SHEEN_MS = 2600;

/** A conversation nothing is known about. Frozen: it is handed out, not owned. */
export const IDLE = Object.freeze({ state: "idle", step: null, steps: 0, sinceMs: null, outcome: null, cost: 0 });

/** What each derived step is called. A tool is named by its own name instead. */
const STEP_LABEL = {
  starting: "Starting up",
  thinking: "Thinking",
  writing: "Writing a reply",
  retrieving: "Searching memory",
};

/* How a turn ended, when that is worth a word on the row. `answer` is the
 * ordinary ending and says nothing; the rest are `end.reason` in
 * contracts/turn-events/schema.json, exhaustively. */
const OUTCOME = {
  answer: null,
  cancel: { state: "idle", label: "Stopped by you" },
  restart: { state: "idle", label: "Interrupted by a restart" },
  limit: { state: "failed", label: "hit its step limit" },
  crash: { state: "failed", label: "crashed" },
};

/** Elapsed time, short enough for a 272px column: "12s", "4m", "1h 12m". */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

/* Time since, which reads differently from elapsed time — "2m" beside a
 * working row means it has been at it for two minutes, beside an idle row it
 * means two minutes ago. The row's dot and wording carry that distinction. */
export function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** When a conversation last moved, and the key `mergeSessions` orders by. */
export const stampOf = (session) => Number(session?.updatedMs || session?.createdMs || 0);

/** The row's name. Falsy — absent, or an empty string a stale host could send — is "Untitled". */
export const titleOf = (session) => (session && session.title) || "Untitled";

/** A conversation's second line when it is not working. */
export const previewOf = (session) => (session && session.preview) || "No messages yet";

/* The second line's parts for a working row: the step, then the tallies.
 *
 * A derived step gets words; a tool is named bare, in mono. "Running
 * web-search" says nothing "web-search" under a moving sheen does not, and the
 * verb costs the width that makes the tool's own name readable at 272px. */
export function describeStep(activity) {
  const step = activity.step || "starting";
  const label = STEP_LABEL[step] || null;
  const facts = [];
  if (activity.steps > 1) facts.push(`${activity.steps} steps`);
  if (activity.cost >= 0.005) facts.push(`$${activity.cost.toFixed(2)}`);
  return { label, tool: label ? null : step, facts };
}

/** A one-line description of a row's state, for its hover title. */
export function describeState(activity) {
  if (activity.state === "working") {
    const { label, tool } = describeStep(activity);
    return `working — ${(label || `running ${tool}`).toLowerCase()}`;
  }
  if (activity.state === "failed") return `stopped: ${activity.outcome || "error"}`;
  return activity.outcome ? activity.outcome.toLowerCase() : null;
}

/** The cost carried by an `assistant` frame's usage counters, if it carries one. */
function costOf(frame, held) {
  const usage = frame.usage;
  const cost = usage && typeof usage.cost === "number" ? usage.cost : 0;
  return held.cost + cost;
}

/* How a `turn-finished` frame lands. `stopped_by` is `end.reason`, validated
 * at the process boundary before it ever reaches this tab, so an unrecognised
 * value means the contract moved: it is treated as a failure and named as
 * itself rather than quietly reported as a clean answer. */
function finish(frame) {
  const reason = frame.stopped_by;
  const known = Object.prototype.hasOwnProperty.call(OUTCOME, reason) ? OUTCOME[reason] : undefined;
  if (known === null) return { ...IDLE };
  if (known) return { ...IDLE, state: known.state, outcome: frame.code || known.label };
  return { ...IDLE, state: "failed", outcome: frame.code || String(reason || "error") };
}

/* One event frame folded into a conversation's activity.
 *
 * `at` is epoch milliseconds, passed in rather than read here so this stays
 * testable without a wall clock. Returns `held` itself when nothing moved, so
 * a caller can skip a redraw by identity.
 */
export function applyActivity(held, frame, at) {
  const from = held || IDLE;
  switch (frame.kind) {
    case "turn-started":
      return { ...IDLE, state: "working", step: "starting", sinceMs: at };
    case "turn-finished":
      return finish(frame);
    case "reasoning":
      return { ...from, state: "working", step: "thinking" };
    case "delta":
      return { ...from, state: "working", step: "writing" };
    case "assistant":
      return { ...from, state: "working", step: "writing", cost: costOf(frame, from) };
    case "tool-call":
      return { ...from, state: "working", step: frame.name || "thinking", steps: from.steps + 1 };
    case "tool-result":
      return { ...from, state: "working", step: "thinking" };
    case "retrieve":
      return { ...from, state: "working", step: "retrieving" };
    default:
      // `user` and `note` say nothing about what the conversation is doing, and
      // a kind this build does not know must not invent a state for it.
      return from;
  }
}

/** A conversation whose turn was cancelled from this tab, without waiting for a frame. */
export const cancelled = () => ({ ...IDLE, outcome: OUTCOME.cancel.label });

/* Folds a `sessions` reply into what is already held, keeping the newer of a
 * held and an incoming row by `updatedMs` — see the `rev` note at the top.
 *
 * Membership still comes from the reply: a row the host no longer lists is
 * gone, however new the copy held here is. Only the *contents* of a row that
 * appears in both are contested, and only there does the stamp decide. */
export function mergeSessions(held, incoming) {
  const known = new Map((held || []).map((session) => [session.id, session]));
  return incoming.map((row) => {
    const previous = known.get(row.id);
    return previous && stampOf(previous) > stampOf(row) ? previous : row;
  });
}

/** Most-recent-first. Ties keep their incoming order, which is the store's (id-sorted). */
export function sortSessions(sessions) {
  return [...sessions].sort((left, right) => stampOf(right) - stampOf(left));
}

/** The conversations a sidebar shows: everything the host listed, minus the archive. */
export const activeSessions = (sessions) => (sessions || []).filter((session) => !session.archived);

/** The archived ones, which legacy kept in a collapsed section at the bottom. */
export const archivedSessions = (sessions) => (sessions || []).filter((session) => Boolean(session.archived));

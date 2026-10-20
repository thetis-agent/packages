// The exporter: one archived conversation, with its subagents, as the evidence files a reflection reads.
// The grammar is Harness²'s trajectory, adapted to a conversation: every event numbered once, across the
// conversation and then each subagent in turn, so a citation `[n]` names exactly one event wherever it is.
//
//   [n] [USER] what the person wrote (the turn-context line cut)
//   [n] [ASSISTANT] what the assistant wrote
//   [n] [ACTION] tool({"args": …})          arguments cut at ACTION_CHARS
//   [n] [OBSERVATION] what the tool answered  cut at observationChars
//   [n] [ERROR] a tool error, or a reply that stopped
//
// Every cut is said where it happens, `[cut by the exporter: N chars]`, so the reader never mistakes the
// exporter's work for the assistant's. Over the transcript budget, whole events are left out of the middle
// (the ask and the plan are at the head, where it went is at the tail) and the export says it is partial.
// Pure: it takes records and answers text, so a test needs no kernel.
import { TURN_CONTEXT } from "./records.js";

export const ACTION_CHARS = 2000;
/** The share of the budget subagents may take when the whole does not fit; the conversation itself is the evidence that matters most. */
const SUBAGENT_SHARE = 0.4;
/** What the head keeps of an event list cut for length; the tail keeps the rest. */
const HEAD_SHARE = 1 / 3;
export const SUBAGENT_LINE = /^\[subagent (s_[a-f0-9]+)(?: ([^\]]*))?\]/;
const COMPACTION = "@thetis/compaction";

const fmt = (n) => n.toLocaleString("en-US");
export const marker = (n) => `[cut by the exporter: ${fmt(n)} chars]`;

/** `text` cut to `max` characters, keeping the head and the tail with the marker between: a log's error is at its end. */
export function clip(text, max) {
  const t = String(text ?? "");
  if (t.length <= max) return t;
  const head = Math.ceil((max * 2) / 3);
  const tail = max - head;
  return `${t.slice(0, head)}\n${marker(t.length - max)}\n${tail > 0 ? t.slice(t.length - tail) : ""}`;
}

/** The text of a message's content: its text parts, and its attachments counted rather than dropped. */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text = content.filter((p) => p?.type === "text" && typeof p.data?.text === "string").map((p) => p.data.text).join("");
  const assets = content.filter((p) => p?.type === "asset").length;
  return text + (assets ? `${text ? " " : ""}[${assets} attachment${assets === 1 ? "" : "s"}]` : "");
}

/** The messages of a record as they stand: the saved conversation, plus a running turn's input and checkpoint. */
export function messagesOf(record) {
  const saved = Array.isArray(record?.conversation) ? record.conversation : [];
  if (record?.status !== "running" || !record.turn) return saved;
  return [...saved, ...(record.turn.messages ?? []), ...(record.turn.streamed ?? [])];
}

/**
 * The events of one record, unnumbered: `{ kind, text, message }`, where `message` is the index of the
 * message it came from. Text is already cut to its limit.
 */
export function eventsOf(record, { observationChars }) {
  const out = [];
  const messages = messagesOf(record);
  messages.forEach((m, i) => {
    if (!m || typeof m !== "object") return;
    if (m.role === "user") {
      const text = textOf(m.content).replace(TURN_CONTEXT, "").trim();
      out.push({ kind: "USER", text: clip(text || "(empty)", observationChars), message: i });
    } else if (m.role === "assistant") {
      const text = textOf(m.content).trim();
      if (text) out.push({ kind: "ASSISTANT", text: clip(text, observationChars), message: i });
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        out.push({ kind: "ACTION", text: `${tc?.name ?? "tool"}(${clip(JSON.stringify(tc?.args ?? {}), ACTION_CHARS)})`, message: i });
      }
    } else if (m.role === "tool") {
      const text = textOf(m.content).trim();
      // harness-core answers a tool that threw, or one that never ran, with `error: …`.
      const kind = /^error:/i.test(text) ? "ERROR" : "OBSERVATION";
      const child = SUBAGENT_LINE.exec(text);
      out.push({ kind, text: clip(text || "(empty)", observationChars), message: i, ...(child ? { child: child[1] } : {}) });
    }
  });
  const stop = record?.interrupted;
  if (stop && record?.status !== "running") {
    const why = stop.why ? ` (${stop.why})` : "";
    out.push({ kind: "ERROR", text: clip(`the last reply stopped before it finished${why}: ${stop.error?.message ?? "no reason recorded"}`, observationChars), message: messages.length });
  }
  return out;
}

const line = (e) => `[${e.n}] [${e.kind}] ${e.text}`;
const size = (events) => events.reduce((sum, e) => sum + line(e).length + 2, 0);

/**
 * Keeps whole events from the head (a third of `budget`) and the tail (the rest), dropping the middle. Answers
 * the kept events with a gap marker where the middle was, and the range that was left out.
 */
function cutMiddle(events, budget) {
  if (size(events) <= budget) return { events, dropped: null };
  const head = [];
  let used = 0;
  for (const e of events) {
    const s = line(e).length + 2;
    if (used + s > budget * HEAD_SHARE) break;
    head.push(e);
    used += s;
  }
  const tail = [];
  for (let i = events.length - 1; i >= head.length; i--) {
    const s = line(events[i]).length + 2;
    if (used + s > budget) break;
    tail.unshift(events[i]);
    used += s;
  }
  const gone = events.slice(head.length, events.length - tail.length);
  if (!gone.length) return { events, dropped: null };
  const dropped = { from: gone[0].n, to: gone.at(-1).n, count: gone.length, chars: size(gone) };
  const gap = { gap: true, text: `[events [${dropped.from}]–[${dropped.to}] left out by the exporter for length: ${fmt(dropped.count)} events, ${fmt(dropped.chars)} chars]` };
  return { events: [...head, gap, ...tail], dropped };
}

const render = (events) => events.map((e) => (e.gap ? e.text : line(e))).join("\n\n");

/**
 * The evidence files of one conversation.
 *
 * @param root      the conversation's record (`kernel.sessions.inspect`), with `id`.
 * @param children  its subagents, every depth, parents before children: `[{ id, label?, parent, record }]`.
 * @param opts      `{ title, observationChars, inputChars, reserve? }`; `reserve` is what other evidence (the
 *                  harness, the library) takes of `inputChars`.
 * @returns `{ files: { "task.md", "trajectory.md", "compaction.md"?, "subagents/<id>.md"... }, events, visible:
 *          Set<number>, partial: string|null }`. `events` is the total; `visible` the numbers the reader sees.
 */
export function exportConversation(root, children = [], { title = "", observationChars, inputChars, reserve = 0 }) {
  let n = 0;
  const number = (events) => events.map((e) => ({ ...e, n: ++n }));
  const rootEvents = number(eventsOf(root, { observationChars }));
  const subs = children.map((c) => {
    const events = number(eventsOf(c.record, { observationChars }));
    return { ...c, events, from: events[0]?.n ?? null, to: events.at(-1)?.n ?? null };
  });
  const byId = new Map(subs.map((s) => [s.id, s]));
  // A spawn result names its child; the reader is told where that child's own events are.
  const annotate = (events) =>
    events.map((e) => {
      const s = e.child ? byId.get(e.child) : null;
      if (!s || s.from === null) return e;
      return { ...e, text: `${e.text}\n(Its own trajectory: context/subagents/${s.id}.md, events [${s.from}]–[${s.to}].)` };
    });

  const firstUser = rootEvents.find((e) => e.kind === "USER");
  const task = `# Task\n\nThe person's first message in this conversation${firstUser ? ` ([${firstUser.n}] in the trajectory)` : ""}:\n\n${firstUser ? firstUser.text : "(the conversation has no message from the person)"}\n`;

  let compaction = null;
  const state = root?.harness?.[COMPACTION];
  if (state && typeof state.summary === "string" && state.summary.trim() && Number.isInteger(state.cut) && state.cut > 0) {
    const covered = rootEvents.filter((e) => e.message < state.cut);
    const upTo = covered.at(-1)?.n;
    compaction = `# Compaction\n\nThis conversation outgrew its context window. From then on the assistant saw the summary below in place of ${upTo ? `events [1]–[${upTo}]` : "its older messages"}; those events are in trajectory.md as they happened.\n\n${clip(state.summary.trim(), Math.floor(inputChars / 4))}\n`;
  }

  const budget = Math.max(0, inputChars - reserve - task.length - (compaction?.length ?? 0));
  const subTotal = subs.reduce((sum, s) => sum + size(s.events), 0);
  const rootTotal = size(rootEvents);
  let rootCut = { events: rootEvents, dropped: null };
  const subCuts = new Map(subs.map((s) => [s.id, { events: s.events, dropped: null }]));
  if (rootTotal + subTotal > budget) {
    // Subagents get at most their share; whatever the conversation does not need of its part goes to them.
    let subAllot = Math.min(subTotal, Math.floor(budget * SUBAGENT_SHARE));
    let rootAllot = budget - subAllot;
    if (rootTotal < rootAllot) {
      subAllot += rootAllot - rootTotal;
      rootAllot = rootTotal;
    }
    rootCut = cutMiddle(rootEvents, rootAllot);
    for (const s of subs) {
      const share = subTotal ? Math.floor((subAllot * size(s.events)) / subTotal) : 0;
      subCuts.set(s.id, cutMiddle(s.events, share));
    }
  }

  const visible = new Set();
  const take = (events) => {
    for (const e of events) if (!e.gap) visible.add(e.n);
  };
  take(rootCut.events);
  for (const c of subCuts.values()) take(c.events);

  const files = {};
  files["task.md"] = task;
  const head = `# Conversation ${root?.id ?? ""}${title ? ` "${title}"` : ""}\n\n${root?.turns ?? 0} turn${root?.turns === 1 ? "" : "s"}, events [1]–[${rootEvents.at(-1)?.n ?? 0}]${subs.length ? `, ${subs.length} subagent${subs.length === 1 ? "" : "s"} in context/subagents/` : ""}.\n\n`;
  files["trajectory.md"] = `${head}${render(annotate(rootCut.events)) || "(no events)"}\n`;
  if (compaction) files["compaction.md"] = compaction;
  for (const s of subs) {
    const label = s.label ? ` (${s.label})` : "";
    const range = s.from === null ? "no events" : `events [${s.from}]–[${s.to}]`;
    files[`subagents/${s.id}.md`] = `# Subagent ${s.id}${label}\n\nStarted by ${s.parent ?? root?.id}; ${range}.\n\n${render(annotate(subCuts.get(s.id).events)) || "(no events)"}\n`;
  }

  const drops = [];
  if (rootCut.dropped) drops.push(`events [${rootCut.dropped.from}]–[${rootCut.dropped.to}] of the conversation`);
  const subDropped = [...subCuts.values()].filter((c) => c.dropped);
  if (subDropped.length) drops.push(`${fmt(subDropped.reduce((sum, c) => sum + c.dropped.count, 0))} events from the middle of ${subDropped.length} subagent${subDropped.length === 1 ? "" : "s"}`);
  const chars = (rootCut.dropped?.chars ?? 0) + subDropped.reduce((sum, c) => sum + c.dropped.chars, 0);
  const partial = drops.length ? `the exporter left out ${drops.join(" and ")} (${fmt(chars)} chars) to fit the ${fmt(inputChars)}-character budget` : null;

  return { files, events: n, visible, partial };
}

/** The descendants of `id` in `list` (kernel session summaries), parents before children. */
export function descendantsOf(list, id) {
  const out = [];
  const walk = (parent) => {
    for (const s of list.filter((x) => x.parent === parent).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      out.push(s);
      walk(s.id);
    }
  };
  walk(id);
  return out;
}

/** Each child's label as its parent's spawn result gave it. */
export function labelsOf(record) {
  const labels = new Map();
  for (const m of messagesOf(record)) {
    if (m?.role !== "tool") continue;
    const hit = SUBAGENT_LINE.exec(textOf(m.content));
    if (hit?.[2]?.trim()) labels.set(hit[1], hit[2].trim());
  }
  return labels;
}

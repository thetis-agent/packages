// The events of an exported conversation, read back from `reflections/<s>/context/`: the place unfolds a
// citation `[n]` in place, Copy puts a finding's cited events in its issue, and a proposal's cited actions
// say whether a trial can test it. Numbers are the exporter's (`export.js`): one per event across the
// conversation and then each subagent, so `[n]` names one event in one of those files.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { list, readJson, readText } from "./files.js";
import { readStamps } from "./harness.js";
import { LIVE_ONLY, contextDir, isSessionId } from "./records.js";

/** The most of one event the place and an issue show. */
export const EVENT_CHARS = 2000;
/** The longest range `[a]–[b]` read as every event in it. */
const RANGE_MAX = 200;
const KINDS = "USER|ASSISTANT|ACTION|OBSERVATION|ERROR";
const START = new RegExp(`^\\[(\\d+)\\] \\[(${KINDS})\\] `);
const NEXT = new RegExp(`^(?:\\[\\d+\\] \\[(?:${KINDS})\\] |\\[events \\[\\d+\\])`);

/** Every event a text cites: `[n]`, and each of `[a]–[b]` (or `[a]-[b]`) for a short range. */
export function citedEvents(text) {
  const out = new Set();
  const t = String(text ?? "");
  for (const m of t.matchAll(/\[(\d{1,7})\]\s*[-–]\s*\[(\d{1,7})\]/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (b >= a && b - a <= RANGE_MAX) for (let k = a; k <= b; k++) out.add(k);
  }
  for (const m of t.matchAll(/\[(\d{1,7})\]/g)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/**
 * A proposal's evidence by conversation: a reinforcing reflection adds a line `s_…: rows …; [n]`, and the
 * lines before any such prefix are `fallback`'s (the first conversation's). Answers `Map(session → text)`.
 */
export function evidenceBySession(text, fallback) {
  const out = new Map();
  let current = fallback;
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*(s_[a-f0-9]+):\s*/.exec(line);
    if (m) current = m[1];
    if (!isSessionId(current)) continue;
    out.set(current, `${out.get(current) ?? ""}${m ? line.slice(m[0].length) : line}\n`);
  }
  return out;
}

/** The exported files of one conversation's events: the trajectory, then each subagent's. */
export async function eventFiles(home, s) {
  if (!isSessionId(s)) return [];
  const dir = contextDir(s);
  const subs = (await list(home, `${dir}/subagents`)).filter((n) => /^s_[a-f0-9]+\.md$/.test(n)).sort();
  return [`${dir}/trajectory.md`, ...subs.map((n) => `${dir}/subagents/${n}`)];
}

/** Event `n` in an exported text: `{ n, kind, text }`, or null. The text runs to the next event or gap. */
export function eventIn(text, n) {
  const lines = String(text ?? "").split("\n");
  const head = `[${n}] [`;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(head)) continue;
    const m = START.exec(lines[i]);
    if (!m || Number(m[1]) !== n) continue;
    const body = [lines[i].slice(m[0].length)];
    for (let k = i + 1; k < lines.length && !NEXT.test(lines[k]); k++) body.push(lines[k]);
    return { n, kind: m[2], text: body.join("\n").trim() };
  }
  return null;
}

/**
 * Event `n` of conversation `s`, from its reflection's export: `{ session, n, kind, text, cut, file }`, the
 * text at most EVENT_CHARS (`cut` the characters left out), or null when no exported file holds it.
 */
export async function readEvent(home, s, n, max = EVENT_CHARS) {
  for (const file of await eventFiles(home, s)) {
    const text = await readText(home, file);
    if (!text || !text.includes(`[${n}] [`)) continue;
    const hit = eventIn(text, n);
    if (!hit) continue;
    const cut = Math.max(0, hit.text.length - max);
    return { session: s, ...hit, text: cut ? `${hit.text.slice(0, max)}…` : hit.text, cut, file };
  }
  return null;
}

// ---- what a trial can test ----

// One read per exported file while it is unchanged: the place asks on every refresh.
const ACTIONS = Symbol.for("@thetis/reflections.actions");
const actionCache = (globalThis[ACTIONS] ??= new Map());

/** `Map(n → tool name)` of every [ACTION] in a conversation's export, subagents included. */
export async function actionsOf(home, s) {
  const out = new Map();
  for (const file of await eventFiles(home, s)) {
    const path = resolve(home, file);
    let mtime;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    let hit = actionCache.get(path);
    if (!hit || hit.mtime !== mtime) {
      const map = new Map();
      for (const m of String((await readText(home, file)) ?? "").matchAll(/^\[(\d+)\] \[ACTION\] ([^\s(]+)\(/gm)) map.set(Number(m[1]), m[2]);
      hit = { mtime, map };
      actionCache.set(path, hit);
      if (actionCache.size > 200) actionCache.delete(actionCache.keys().next().value);
    }
    for (const [n, tool] of hit.map) out.set(n, tool);
  }
  return out;
}

/** `Map(tool → package)` from the tools snapshots the stamps of `sessions` name. */
export async function toolPackages(home, sessions) {
  const out = new Map();
  for (const s of sessions) {
    if (!isSessionId(s)) continue;
    const shas = new Set((await readStamps(home, s)).map((x) => x?.tools).filter((x) => typeof x === "string" && /^[a-f0-9]{6,64}$/.test(x)));
    for (const sha of shas) {
      const tools = await readJson(home, `harness-core/snapshots/${s}/${sha}.json`, null);
      for (const t of Array.isArray(tools) ? tools : []) if (typeof t?.name === "string" && typeof t?.package === "string" && !out.has(t.name)) out.set(t.name, t.package);
    }
  }
  return out;
}

/**
 * What `trialable` reads of an entry: `{ actions: [{ session, n, tool }], tools: Map(tool → package) }`, the
 * cited events that were actions, and the packages of the tools each conversation (and its subagents) had.
 */
export async function trialStamps(home, entry) {
  const actions = [];
  const sessions = new Set();
  for (const [s, text] of evidenceBySession(entry?.evidence, entry?.from?.[0]?.session)) {
    const cited = citedEvents(text);
    if (!cited.length) continue;
    const acts = await actionsOf(home, s);
    for (const n of cited) if (acts.has(n)) actions.push({ session: s, n, tool: acts.get(n) });
    sessions.add(s);
    for (const f of await eventFiles(home, s)) {
      const m = /subagents\/(s_[a-f0-9]+)\.md$/.exec(f);
      if (m) sessions.add(m[1]);
    }
  }
  return { actions, tools: actions.length ? await toolPackages(home, sessions) : new Map() };
}

/** The bare name of a package, so a fork (`@bitmuse/moor`) counts as the package it forks (`@thetis/moor`). */
const bare = (name) => String(name ?? "").replace(/^@[^/]+\//, "");

/** The live-only packages among a proposal's cited actions; none means a trial can test it. */
export function livePackages(stamps, liveOnly = LIVE_ONLY) {
  const live = new Set(liveOnly.map(bare));
  const out = new Set();
  for (const a of stamps?.actions ?? []) {
    const pkg = stamps.tools?.get(a.tool);
    if (pkg && live.has(bare(pkg))) out.add(pkg);
  }
  return [...out].sort();
}

/** Whether a trial, which runs offline, can test an entry: false when a cited action used a live-only package's tool. */
export const trialable = (entry, stamps, liveOnly = LIVE_ONLY) => livePackages(stamps, liveOnly).length === 0;

// The records under `reflections/` in the home, and the small facts every part reads beside them: the
// configuration with its floors, the project a conversation belongs to, the per-project switches, the
// day's spend, and the gateway's marks (titles and archived) for the conversations themselves.
//
// A record is the queue. The archive hook writes `queued` or `skipped`, a person's Reflect writes `queued`,
// the service moves `queued` to `running` to `done` or `failed`, and a restore or a Cancel writes
// `cancelled`. Nothing else holds the state, so what the place shows is what will happen.
import { list, readJson, writeJson } from "./files.js";

export const NAME = "@thetis/reflections";
export const DIR = "reflections";
export const STATES = Object.freeze(["queued", "running", "done", "skipped", "failed", "cancelled"]);
export const ACTIVE = Object.freeze(["queued", "running"]);

export const DEFAULTS = Object.freeze({ maxTokens: 16000, minTurns: 3, observationChars: 20000, inputChars: 600000, dailyCostUsd: 5, enabled: true, trialRuns: 2, trialCostUsd: 5, trialMinutes: 20, trialScratchMb: 8192 });
/** Below this an observation loses the error at the end of a build log, so the setting is never allowed under it. */
export const OBSERVATION_FLOOR = 10000;
/** A transcript budget under this cannot hold the mission and a conversation worth reading. */
export const INPUT_FLOOR = 40000;

const SESSION = /^s_[a-f0-9]+$/;
const PROJECT = /^p_[0-9a-f]{8}$/;
export const isSessionId = (id) => typeof id === "string" && SESSION.test(id);
export const isProjectId = (id) => typeof id === "string" && PROJECT.test(id);

export const recordPath = (s) => `${DIR}/${s}.json`;
export const reflectionPath = (s) => `${DIR}/${s}.md`;
export const contextDir = (s) => `${DIR}/${s}/context`;
export const LIBRARY = `${DIR}/library.json`;
export const FINDINGS = `${DIR}/findings.json`;
/** Where the service writes what it made of one trial: each run's trajectory and the judgement. */
export const trialDir = (t) => `${DIR}/trials/${t}`;
/** Where @thetis/host-trials writes one trial, in the person's home. */
export const hostTrialDir = (t) => `trials/${t}`;
export const SWITCHES = `${DIR}/projects.json`;
export const SPEND = `${DIR}/spend.json`;
export const INSTALLED = `${DIR}/installed.json`;

const number = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : fallback);

/** The configuration as the code uses it: defaults filled, numbers floored where a smaller one would only hurt. */
export function settingsOf(config = {}) {
  const c = config && typeof config === "object" ? config : {};
  const model = typeof c.model === "string" && c.model.trim() ? c.model.trim() : "";
  return {
    model,
    maxTokens: Math.max(1000, Math.floor(number(c.maxTokens, DEFAULTS.maxTokens))),
    minTurns: Math.max(0, Math.floor(number(c.minTurns, DEFAULTS.minTurns))),
    observationChars: Math.max(OBSERVATION_FLOOR, Math.floor(number(c.observationChars, DEFAULTS.observationChars))),
    inputChars: Math.max(INPUT_FLOOR, Math.floor(number(c.inputChars, DEFAULTS.inputChars))),
    dailyCostUsd: Math.max(0, number(c.dailyCostUsd, DEFAULTS.dailyCostUsd)),
    enabled: c.enabled === undefined || c.enabled === null ? DEFAULTS.enabled : c.enabled !== false && c.enabled !== "false",
    trialRuns: Math.min(5, Math.max(1, Math.floor(number(c.trialRuns, DEFAULTS.trialRuns)))),
    trialCostUsd: Math.max(0, number(c.trialCostUsd, DEFAULTS.trialCostUsd)),
    trialMinutes: Math.max(1, number(c.trialMinutes, DEFAULTS.trialMinutes)),
    trialScratchMb: Math.max(256, Math.floor(number(c.trialScratchMb, DEFAULTS.trialScratchMb))),
    trialModel: typeof c.trialModel === "string" && c.trialModel.trim() ? c.trialModel.trim() : "",
  };
}

// ---- records ----

export async function readRecord(home, s) {
  if (!isSessionId(s)) return null;
  const r = await readJson(home, recordPath(s), null);
  return r && typeof r === "object" && r.session === s && STATES.includes(r.state) ? r : null;
}

export async function writeRecord(home, record) {
  await writeJson(home, recordPath(record.session), record);
}

/** Every record, any order. Files that are not `s_<hex>.json` are not records. */
export async function readRecords(home) {
  const names = (await list(home, DIR)).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter(isSessionId);
  return (await Promise.all(names.map((s) => readRecord(home, s)))).filter(Boolean);
}

/**
 * A record that starts over: the facts of the conversation kept, everything a previous attempt said
 * dropped, so a stale error or cost never shows beside a new state.
 */
export function freshRecord(base, state, extra = {}) {
  const now = new Date().toISOString();
  const kept = { session: base.session, title: base.title ?? null, project: base.project ?? null };
  return { ...kept, state, ...(state === "queued" ? { queuedAt: now } : {}), updatedAt: now, ...extra };
}

// ---- projects ----

/** The project a conversation belongs to, from @thetis/projects' assignments, or null. */
export async function projectOf(home, s) {
  const map = await readJson(home, "projects/sessions.json", {});
  const p = map && typeof map === "object" ? map[s] : null;
  return isProjectId(p) ? p : null;
}

/** A project's name from its record, or null when the project is gone. */
export async function projectName(home, p) {
  if (!isProjectId(p)) return null;
  const record = await readJson(home, `projects/${p}.json`, null);
  return record && record.id === p ? (typeof record.name === "string" && record.name.trim() ? record.name.trim() : p) : null;
}

/** Every project @thetis/projects keeps: `[{ id, name }]`. */
export async function listProjects(home) {
  const ids = (await list(home, "projects")).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter(isProjectId);
  const out = [];
  for (const id of ids) {
    const name = await projectName(home, id);
    if (name) out.push({ id, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `{ "<project id>": false }` for each project switched off; on is the absence of an entry. */
export async function readSwitches(home) {
  const map = await readJson(home, SWITCHES, {});
  return map && typeof map === "object" && !Array.isArray(map) ? map : {};
}

export async function setSwitch(home, p, enabled) {
  const map = await readSwitches(home);
  if (enabled) delete map[p];
  else map[p] = false;
  await writeJson(home, SWITCHES, map);
  return map;
}

// ---- the day's spend ----

/** Today, in UTC: the day the cap counts. */
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

/** `{ day, usd, unknown }` for today; yesterday's file reads as nothing spent. */
export async function readSpend(home, now = new Date()) {
  const s = await readJson(home, SPEND, null);
  const day = today(now);
  if (!s || s.day !== day) return { day, usd: 0, unknown: 0 };
  return { day, usd: number(s.usd, 0), unknown: Math.max(0, Math.floor(number(s.unknown, 0))) };
}

/** Adds one reflection's cost to today; `usd` undefined counts it as one whose cost was not reported. */
export async function addSpend(home, usd, now = new Date()) {
  const s = await readSpend(home, now);
  if (typeof usd === "number" && Number.isFinite(usd)) s.usd = Math.round((s.usd + usd) * 1e6) / 1e6;
  else s.unknown += 1;
  await writeJson(home, SPEND, s);
  return s;
}

// ---- the gateway's marks ----

/**
 * The web gateway's marks for this person's conversations: `{ "<id>": { title?, archived, archivedAt? } }`.
 * Archiving and naming are the gateway's, kept one file per conversation in its directory of the home;
 * read on every call, because the person archives and renames while this runs.
 */
export async function gatewayMarks(home, user) {
  const marks = {};
  if (typeof user !== "string" || !/^[a-zA-Z0-9_-]+$/.test(user)) return marks;
  const dir = `gateway-web/sessions/${user}`;
  for (const file of await list(home, dir)) {
    if (!file.endsWith(".json")) continue;
    const entry = await readJson(home, `${dir}/${file}`, null);
    if (!entry || typeof entry !== "object") continue;
    marks[file.slice(0, -5)] = {
      title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : undefined,
      archived: entry.archived === true,
      archivedAt: typeof entry.archivedAt === "string" ? entry.archivedAt : undefined,
    };
  }
  return marks;
}

/** One conversation's mark, without reading the rest: what the archive hook needs, and it must be fast. */
export async function markOf(home, user, s) {
  if (typeof user !== "string" || !/^[a-zA-Z0-9_-]+$/.test(user) || !isSessionId(s)) return undefined;
  const entry = await readJson(home, `gateway-web/sessions/${user}/${s}.json`, null);
  if (!entry || typeof entry !== "object") return undefined;
  return { title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : undefined, archived: entry.archived === true, archivedAt: typeof entry.archivedAt === "string" ? entry.archivedAt : undefined };
}

/** The line harness-core appends to each message of the person; it says when, not what. */
export const TURN_CONTEXT = /\s*\[Turn context:[^\]]*(?:\]|…)?\s*$/;

/** A conversation's title: the name it was given, else its first message cut to a line. */
export function titleOf(mark, summary) {
  if (mark?.title) return mark.title;
  const first = String(summary?.first ?? "").replace(TURN_CONTEXT, "").replace(/\s+/g, " ").trim();
  return first ? (first.length > 60 ? `${first.slice(0, 59)}…` : first) : "Untitled conversation";
}

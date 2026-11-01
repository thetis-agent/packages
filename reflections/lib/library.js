// The library: the changes reflections proposed (`reflections/library.json`) and the findings about
// packages (`reflections/findings.json`). Nothing here reaches a conversation until a person adopts an
// entry. A trial, which runs the request with and without the change, is optional: an entry is adopted
// after one, or directly (`untried`). The person may edit an entry first, and update one whose file moved.
//
//   proposed → trialling → trialled → adopted | rejected;  adopted → retired;  trialled → trialling again
//   proposed | trialled → adopted (untried from proposed);  an edit puts trialled back to proposed
//
// An entry names its component (Harness² `prompts.py:1136`): a skill, a project's instructions, a guide
// note, or a package's config key. `owner` is the package whose component it changes, `versions` what that
// package and the packages its rows name were at when it was proposed, and `before` what was there then,
// so an adopt over a file that moved since merges the change into it (`merge.js`) or refuses, and a retire
// puts it back. A guide note and a config key are not checked: a note is appended unless it is there, and
// the place shows a key's value now before it is set.
//
// The UI's ops call `listEntries`, `getEntry`, `rejectEntry`, `startTrial`, `adoptEntry`, `editEntry`,
// `rebaseEntry`, `retireEntry`, `listFindings`, `closeFinding` and `findingText`; each throws a sentence on
// misuse. The service calls the sweeps.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { loadSkills } from "@thetis/skills";
import { list, readJson, readText, remove, writeJson, writeText } from "./files.js";
import { readEvent } from "./events.js";
import { firstModel, installedPackages, readStamps, versionMap } from "./harness.js";
import { merge3 } from "./merge.js";
import { OPENING, changeProblem, cleanChange } from "./prompt.js";
import { FINDINGS, LIBRARY, TURN_CONTEXT, hostTrialDir, isProjectId, isSessionId, listProjects, projectOf, trialDir } from "./records.js";

export { trialable } from "./events.js";

export const ENTRY_STATES = Object.freeze(["proposed", "trialling", "trialled", "adopted", "rejected", "retired"]);
export const FINDING_STATES = Object.freeze(["open", "possibly-fixed", "closed"]);
export const HARNESS = "@thetis/harness-core";
export const PROJECTS = "@thetis/projects";
const ENTRY_ID = /^L-[0-9a-f]{6}$/;
const FINDING_ID = /^F-[0-9a-f]{6}$/;
const TRIAL_ID = /^t_[0-9a-f]{8}$/;
/** The longest trial request a person may write. */
export const REQUEST_CHARS = 20000;

const fail = (message) => {
  throw new Error(message);
};
const now = () => new Date().toISOString();

/** Whether an entry's change is in the real home now: applied and not retired. */
const isAdopted = (e) => !!e.applied && e.state !== "retired";

/**
 * The person a host.trials call is about. A person's own call is pinned to them by the kernel whatever it
 * names, but an admin's is forwarded as it is, so the call must name them: `env.user` when the caller has it
 * (a UI command), else the userspace the home sits in (`<THETIS_HOME>/userspaces/<user>/home`, the service's
 * and a hook's `cwd`).
 */
export function trialUser({ home, user } = {}) {
  if (typeof user === "string" && /^[a-zA-Z0-9_-]+$/.test(user)) return user;
  const m = /[\\/]userspaces[\\/]([a-zA-Z0-9_-]+)[\\/]home[\\/]?$/.exec(String(home ?? ""));
  return m ? m[1] : null;
}

/** `args` with `user` when the person is known. */
export const forUser = (env, args) => {
  const user = trialUser(env);
  return user ? { user, ...args } : args;
};

// ---- the files ----

export async function readLibrary(home) {
  const lib = await readJson(home, LIBRARY, null);
  const entries = Array.isArray(lib?.entries) ? lib.entries.filter((e) => e && typeof e === "object" && ENTRY_ID.test(e.id)) : [];
  return { entries };
}

/** A whole-file write of the library. Outside a test's setup, every change goes through `updateLibrary`. */
export const writeLibrary = (home, lib) => writeJson(home, LIBRARY, { entries: lib.entries });

export async function readFindings(home) {
  const f = await readJson(home, FINDINGS, null);
  const findings = Array.isArray(f?.findings) ? f.findings.filter((x) => x && typeof x === "object" && FINDING_ID.test(x.id)) : [];
  for (const x of findings) if (!Array.isArray(x.seen)) x.seen = [];
  return { findings };
}

/** A whole-file write of the findings. Outside a test's setup, every change goes through `updateFindings`. */
export const writeFindings = (home, f) => writeJson(home, FINDINGS, { findings: f.findings });

// ---- one writer at a time ----
//
// The service's sweep and the place's ops both read-modify-write library.json and findings.json, in the same
// fence process, possibly from two instances of this module (a loader may import it again). Each file has
// one queue, kept on globalThis under a registered symbol so every instance shares it. Inside the queue the
// file is read fresh, `mutate` changes it synchronously, and it is written only when it changed. Anything
// slow (a host call, a config write, applying a change, the judge) happens outside, followed by a short
// update that checks the state again.

const QUEUES = Symbol.for("@thetis/reflections.fileQueues");
const queues = (globalThis[QUEUES] ??= new Map());

/** Runs `fn` after every earlier job on `key` settled; the next job waits for this one, whatever it does. */
export function serial(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

async function update(key, read, write, mutate) {
  return serial(key, async () => {
    const fresh = await read();
    const was = JSON.stringify(fresh);
    const out = mutate(fresh);
    if (out && typeof out.then === "function") throw new Error("an update's mutate must be synchronous");
    if (JSON.stringify(fresh) !== was) await write(fresh);
    return out;
  });
}

/** Reads the library inside its queue, lets `mutate(lib)` change it (it may answer a value or throw), and writes it when it changed. */
export const updateLibrary = (home, mutate) => update(`library:${resolve(home, LIBRARY)}`, () => readLibrary(home), (lib) => writeLibrary(home, lib), mutate);

/** As `updateLibrary`, for the findings. */
export const updateFindings = (home, mutate) => update(`findings:${resolve(home, FINDINGS)}`, () => readFindings(home), (f) => writeFindings(home, f), mutate);

export function newId(prefix, taken) {
  for (;;) {
    const id = `${prefix}-${randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

/** Hands `fn` the entry inside the library's queue, and keeps what it answers (or nothing, on undefined). `fn` is synchronous. */
function updateEntry(home, id, fn) {
  return updateLibrary(home, (lib) => {
    const i = lib.entries.findIndex((e) => e.id === id);
    if (i < 0) fail(`There is no proposal ${id}.`);
    const next = fn(lib.entries[i]);
    if (next === undefined) return lib.entries[i];
    lib.entries[i] = { ...next, updatedAt: now() };
    return lib.entries[i];
  });
}

function wantEntryId(id) {
  if (typeof id !== "string" || !id) fail("id is required: the proposal's id, such as L-1a2b3c.");
  if (!ENTRY_ID.test(id)) fail(`${JSON.stringify(id)} is not a proposal id.`);
  return id;
}

/** Semantic-ish order of two versions: numeric parts compared in turn; -1, 0 or 1. */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b ?? "").split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---- what a change is about ----

/** The skills every source has, the winning one for each id: `loadSkills` over the installed packages and the home. */
export function skillsOf(home, packages) {
  try {
    return loadSkills({ cwd: home }, packages);
  } catch {
    return [];
  }
}

/** `id → { package }` for the guard: `package` is null for a skill whose winning source is the home. */
export function skillMap(skills) {
  return new Map(skills.map((s) => [s.id, { package: s.source?.package ?? null }]));
}

/**
 * Where a skill change goes, and what is there now: `{ source: "home"|"shipped"|"new", path, owner, text }`.
 * A home skill keeps its path; a shipped one is overridden at `skills/<id>/SKILL.md` in the home (later
 * sources win on an equal id, @thetis/skills `load.js`); a new one goes there too.
 */
export async function skillTarget(home, packages, id) {
  const hit = skillsOf(home, packages).find((s) => s.id === id);
  const fallback = `skills/${id}/SKILL.md`;
  if (!hit) return { source: "new", path: fallback, owner: null, text: null };
  let text = null;
  try {
    text = await readFile(hit.source.path, "utf8");
  } catch {
    text = null;
  }
  if (hit.source?.package) return { source: "shipped", path: fallback, owner: hit.source.package, text };
  return { source: "home", path: relative(home, hit.source.path).split("\\").join("/"), owner: null, text };
}

const configTarget = (target) => {
  const m = /^(\S+)\s+(\S+)$/.exec(String(target ?? ""));
  return m ? { package: m[1], key: m[2] } : { package: "", key: "" };
};

async function guideNotes(kernel) {
  try {
    const eff = await kernel.config.effective(HARNESS);
    return Array.isArray(eff?.guideNotes) ? eff.guideNotes.filter((n) => typeof n === "string") : [];
  } catch {
    return [];
  }
}

/** A key's value at the person's own layer, or undefined when the layer does not set it. */
async function userValue(kernel, pkg, key) {
  try {
    const report = await kernel.config.show(pkg);
    const k = report?.keys?.find((x) => x?.key === key);
    return k && k.source === "user" && k.state === "set" ? k.value : undefined;
  } catch {
    return undefined;
  }
}

/** What the component holds now, in the form `before` keeps: a text, a JSON text, or null. */
export async function currentOf({ home, kernel }, entry, packages) {
  if (entry.kind === "skill") {
    const pkgs = packages ?? (await installedPackages({ home, kernel }));
    return (await skillTarget(home, pkgs, entry.target)).text;
  }
  if (entry.kind === "project-instructions") return readText(home, `projects/${entry.target}.md`);
  if (entry.kind === "guide-note") return JSON.stringify(await guideNotes(kernel));
  if (entry.kind === "config") {
    const { package: pkg, key } = configTarget(entry.target);
    const v = await userValue(kernel, pkg, key);
    return v === undefined ? null : JSON.stringify(v);
  }
  return null;
}

/** The words for where a change goes, as an adopt's refusal names it. */
export function whereOf(entry) {
  if (entry.kind === "skill") return entry.path ?? `skills/${entry.target}/SKILL.md`;
  if (entry.kind === "project-instructions") return `projects/${entry.target}.md`;
  if (entry.kind === "guide-note") return "The guide notes";
  return `${entry.target}`;
}

/** The Change a trial applies to its change arm, from an entry (@thetis/host-trials §2.3). */
export function changeOf(entry) {
  if (entry.kind === "skill") return { kind: "skill", id: entry.target, path: entry.path, content: entry.change };
  if (entry.kind === "project-instructions") return { kind: "project-instructions", project: entry.target, content: entry.change };
  if (entry.kind === "guide-note") return { kind: "guide-note", note: entry.change };
  if (entry.kind === "config") {
    const { package: pkg, key } = configTarget(entry.target);
    return { kind: "config", package: pkg, key, value: JSON.parse(entry.change) };
  }
  fail(`A proposal of kind ${JSON.stringify(entry.kind)} cannot be trialled.`);
}

/**
 * The Change that takes an applied entry back out, for the base arm of a trial run on a home that already
 * has it: what retire would do, as a Change. Removals are `content: null` (the file goes) and `value: null`
 * (the key is unset); a guide note comes out as the whole `guideNotes` list without it.
 */
export async function inverseOf({ kernel }, entry) {
  const before = entry.applied?.before ?? null;
  if (entry.kind === "skill") return { kind: "skill", id: entry.target, path: entry.path, content: entry.skillSource === "home" ? before : null };
  if (entry.kind === "project-instructions") return { kind: "project-instructions", project: entry.target, content: before };
  if (entry.kind === "guide-note") {
    const notes = await guideNotes(kernel);
    const i = notes.indexOf(entry.change);
    if (i >= 0) notes.splice(i, 1);
    return { kind: "config", package: HARNESS, key: "guideNotes", value: notes };
  }
  if (entry.kind === "config") {
    const { package: pkg, key } = configTarget(entry.target);
    return { kind: "config", package: pkg, key, value: before === null ? null : JSON.parse(before) };
  }
  fail(`A proposal of kind ${JSON.stringify(entry.kind)} cannot be trialled.`);
}

// ---- writing from a reflection ----

/**
 * Records a guarded proposal from one reflection. A `reinforces` appends this conversation to the named
 * entry's `from` and `evidence` and changes nothing else; otherwise a new entry is written.
 *
 * @param proposal      what the guard kept.
 * @param conversation  `{ session, title, project }`.
 * @returns `{ id, reinforced?, rejected? }`.
 */
export async function recordProposal({ home, kernel }, { proposal, conversation, rows = [], packages }) {
  const at = now();
  const from = { session: conversation.session, title: conversation.title ?? null, at, rows: proposal.rows ?? [], ...(conversation.project ? { project: conversation.project } : {}) };
  if (proposal.reinforces) {
    return updateLibrary(home, (lib) => {
      const e = lib.entries.find((x) => x.id === proposal.reinforces);
      if (!e) fail(`There is no proposal ${proposal.reinforces}.`);
      e.from = [...(e.from ?? []).filter((f) => f.session !== conversation.session), from];
      e.evidence = [e.evidence, `${conversation.session}: ${proposal.evidence}`].filter(Boolean).join("\n");
      e.updatedAt = at;
      return { id: e.id, reinforced: true, ...(e.state === "rejected" ? { rejected: true } : {}) };
    });
  }
  // What is there now, and the versions, are read outside the queue: they are slow and touch no library file.
  const pkgs = packages ?? (await installedPackages({ home, kernel }));
  const today = versionMap(pkgs);
  const entry = {
    id: null,
    kind: proposal.kind,
    target: proposal.kind === "guide-note" ? "-" : proposal.target,
    path: null,
    cue: proposal.cue,
    lesson: proposal.lesson,
    change: proposal.change,
    before: null,
    evidence: proposal.evidence,
    confidence: proposal.confidence,
    trialRequest: proposal.trial || OPENING,
    from: [from],
    versions: {},
    owner: null,
    state: "proposed",
    trials: [],
    verdict: null,
    applied: null,
    recheck: null,
    createdAt: at,
    updatedAt: at,
  };
  if (entry.kind === "skill") {
    const t = await skillTarget(home, pkgs, entry.target);
    entry.path = t.path;
    entry.owner = t.owner;
    entry.skillSource = t.source;
    entry.before = t.text;
  } else {
    entry.owner = entry.kind === "guide-note" ? HARNESS : entry.kind === "config" ? configTarget(entry.target).package : PROJECTS;
    entry.before = await currentOf({ home, kernel }, entry, pkgs);
  }
  const named = new Set(entry.owner ? [entry.owner] : []);
  for (const n of entry.from[0].rows) {
    const c = rows[n - 1]?.component ?? "";
    const m = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)/i.exec(c);
    if (m) named.add(m[1]);
  }
  for (const name of named) if (today[name]) entry.versions[name] = today[name];
  return updateLibrary(home, (lib) => {
    entry.id = newId("L", new Set(lib.entries.map((e) => e.id)));
    lib.entries.push(entry);
    return { id: entry.id };
  });
}

/**
 * Records the guarded findings of one reflection; a `same-as` appends a sighting to the named finding and
 * reopens it when it was possibly fixed, or closed and now seen at a newer version. This conversation's
 * older sightings, from an earlier reflection of it, are replaced; a finding left with none goes.
 *
 * @returns the ids, one per finding, in order.
 */
export function recordFindings(home, findings, { session, title }) {
  return updateFindings(home, (store) => {
    const at = now();
    const ids = [];
    for (const f of findings) {
      const sighting = { session, title: title ?? null, at, version: f.version || null, events: f.events ?? [], rows: f.rows ?? [] };
      const same = f.sameAs ? store.findings.find((x) => x.id === f.sameAs) : null;
      if (same) {
        const highest = same.seen.reduce((h, s) => (compareVersions(s.version, h) > 0 ? s.version : h), null);
        same.seen = [...same.seen.filter((s) => s.session !== session), sighting];
        if (same.state === "possibly-fixed") {
          same.state = "open";
          same.since = null;
        } else if (same.state === "closed" && sighting.version && (!highest || compareVersions(sighting.version, highest) > 0)) {
          same.state = "open";
          same.closedAt = null;
        }
        ids.push(same.id);
        continue;
      }
      const id = newId("F", new Set(store.findings.map((x) => x.id)));
      store.findings.push({ id, package: f.package, component: f.component, what: f.what, seen: [sighting], state: "open", since: null, closedAt: null, createdAt: at });
      ids.push(id);
    }
    const keep = new Set(ids);
    for (const x of store.findings) if (!keep.has(x.id)) x.seen = x.seen.filter((s) => s.session !== session);
    store.findings = store.findings.filter((x) => x.seen.length);
    return ids;
  });
}

// ---- what a reflection reads of the library ----

const kindTarget = (e) => (e.kind === "guide-note" || !e.target || e.target === "-" ? e.kind : `${e.kind} ${e.target}`);

/** `library/INDEX.md`: what was proposed, the findings still open, and what was tried and rejected. */
export function indexMarkdown(lib, store) {
  const live = lib.entries.filter((e) => e.state !== "rejected");
  const rejected = lib.entries.filter((e) => e.state === "rejected");
  const open = store.findings.filter((f) => f.state === "open" || f.state === "possibly-fixed");
  const out = ["# The library", "", "Changes already proposed or adopted, and findings already open. Reinforce one with `reinforces: L-…` or `same-as: F-…` instead of writing it again.", "", "## Changes", ""];
  if (live.length) for (const e of live) out.push(`- ${e.id} · ${e.state} · ${kindTarget(e)} · ${e.cue} · ${e.lesson}`);
  else out.push("(none)");
  out.push("", "## Findings", "");
  if (open.length) for (const f of open) out.push(`- ${f.id} · ${f.package} ${f.component} · ${f.what}${f.state === "possibly-fixed" ? ` (possibly fixed in ${f.since})` : ""}`);
  else out.push("(none)");
  out.push("", "## Tried and rejected", "", "Do not propose these again.", "");
  if (rejected.length) for (const e of rejected) out.push(`- ${e.id} · ${kindTarget(e)} · ${e.lesson}${e.verdict?.result ? ` — the trial: ${e.verdict.result}${e.verdict.why ? `: ${e.verdict.why}` : ""}` : " — rejected without a trial"}`);
  else out.push("(none)");
  return `${out.join("\n")}\n`;
}

// ---- the UI's functions ----

const isFile = (e) => e?.kind === "skill" || e?.kind === "project-instructions";

/**
 * Whether an entry's file moved since the proposal: "fresh" (it did not, or the entry is not a file, or it
 * is past deciding), "mergeable" (the change merges cleanly into today's file) or "conflict".
 */
export function staleness(entry, current) {
  if (!isFile(entry) || !["proposed", "trialled"].includes(entry.state)) return "fresh";
  // No file and an empty one are the same: an exporter wrote `before: ""` for a project with no instructions.
  if ((current ?? "") === (entry.before ?? "")) return "fresh";
  return merge3(entry.before ?? "", entry.change ?? "", current ?? "").ok ? "mergeable" : "conflict";
}

/** `entries` with `staleness`, and `current` for a file entry, read once for all of them. */
async function withStaleness({ home, kernel }, entries) {
  if (!entries.some((e) => isFile(e) && ["proposed", "trialled"].includes(e.state))) return entries.map((e) => ({ ...e, staleness: "fresh" }));
  const packages = await installedPackages({ home, kernel });
  const out = [];
  for (const e of entries) {
    if (!isFile(e) || !["proposed", "trialled"].includes(e.state)) {
      out.push({ ...e, staleness: "fresh" });
      continue;
    }
    const current = await currentOf({ home, kernel }, e, packages);
    out.push({ ...e, staleness: staleness(e, current) });
  }
  return out;
}

/** Every entry, the most recently changed first; with `env` (`{ kernel }`), each with its `staleness`. */
export async function listEntries(home, env) {
  const { entries } = await readLibrary(home);
  const sorted = entries.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return env?.kernel ? withStaleness({ home, kernel: env.kernel }, sorted) : sorted;
}

/** The files of one trial: the judgement and each run's trajectory as the service wrote them. */
export async function trialFilesOf(home, t) {
  const dir = trialDir(t);
  const names = await list(home, dir);
  const runs = names
    .filter((n) => /^(base|change)-\d+\.md$/.test(n))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((n) => ({ name: n.slice(0, -3), path: `${dir}/${n}` }));
  return { trial: t, dir, judge: names.includes("judge.md") ? `${dir}/judge.md` : null, runs, status: `${hostTrialDir(t)}/trial.json` };
}

/**
 * One entry, with `trialFiles`: one `{ trial, dir, judge, runs: [{ name, path }], status }` per trial, oldest
 * first. With `env` (`{ kernel }`) also `current`, what its component holds now, and `staleness`.
 */
export async function getEntry(home, id, env) {
  wantEntryId(id);
  const e = (await readLibrary(home)).entries.find((x) => x.id === id);
  if (!e) fail(`There is no proposal ${id}.`);
  const trialFiles = [];
  for (const t of e.trials ?? []) if (TRIAL_ID.test(t)) trialFiles.push(await trialFilesOf(home, t));
  if (!env?.kernel) return { ...e, trialFiles };
  const current = await currentOf({ home, kernel: env.kernel }, e);
  return { ...e, trialFiles, current, staleness: staleness(e, current) };
}

const stateRefusal = (e) =>
  e.state === "trialling" ? "Its trial is still running." : e.state === "rejected" ? "It was rejected." : e.state === "retired" ? "It was retired." : null;

export async function rejectEntry(home, id) {
  wantEntryId(id);
  return updateEntry(home, id, (e) => {
    if (e.state === "trialling") fail("Its trial is still running; wait for it to finish.");
    if (e.state === "rejected") fail("It is already rejected.");
    if (e.applied && e.state !== "retired") fail("This change is adopted; retire it first.");
    if (e.state === "retired") fail("It was retired.");
    return { ...e, state: "rejected", rejectedAt: now() };
  });
}

/** The person's first message in a conversation, without the turn-context line harness-core adds. */
export async function openingRequest(kernel, s) {
  let record;
  try {
    record = await kernel.sessions.inspect(s);
  } catch {
    fail("The conversation it came from is gone; write the request the trial should send.");
  }
  const first = (record?.conversation ?? []).find((m) => m?.role === "user");
  const content = first?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => p?.type === "text" && typeof p.data?.text === "string").map((p) => p.data.text).join("") : "";
  const clean = text.replace(TURN_CONTEXT, "").trim();
  if (!clean) fail("The conversation it came from has no first message to send; write the request the trial should send.");
  return { text: clean, record };
}

/** The model a trial runs on: the setting, else turn 1's from the stamp, else the conversation's last, else the server's. */
async function trialModel({ home, kernel }, settings, s, record) {
  if (settings?.trialModel) return settings.trialModel;
  const stamped = firstModel(await readStamps(home, s));
  if (stamped) return stamped;
  let rec = record;
  if (!rec) {
    try {
      rec = await kernel.sessions.inspect(s);
    } catch {
      rec = null;
    }
  }
  const last = rec?.harness?.[HARNESS]?.lastCall?.model;
  if (typeof last === "string" && last) return last;
  const def = (await kernel.models?.())?.model;
  if (typeof def === "string" && def) return def;
  fail("There is no model to run the trial on: set one in the Reflections settings.");
}

/**
 * Starts a trial of an entry through @thetis/host-trials: the request with and without the change,
 * `settings.trialRuns` runs each. Answers `{ trial }`.
 *
 * @param env       `{ home, kernel }`.
 * @param settings  what `settingsOf` answers.
 * @param opts      `{ request? }`: a request in place of the entry's own.
 */
export async function startTrial({ home, kernel, user }, settings, id, { request } = {}) {
  wantEntryId(id);
  const e = (await readLibrary(home)).entries.find((x) => x.id === id);
  if (!e) fail(`There is no proposal ${id}.`);
  if (!["proposed", "trialled", "adopted"].includes(e.state)) fail(stateRefusal(e) ?? `A proposal that is ${e.state} cannot be trialled.`);
  const source = e.from?.[0]?.session;
  let text;
  let record = null;
  if (request !== undefined && request !== null && String(request).trim()) {
    if (typeof request !== "string") fail("request must be text.");
    if (request.length > REQUEST_CHARS) fail(`The request is over ${REQUEST_CHARS.toLocaleString("en-US")} characters.`);
    text = request.trim();
  } else if (e.trialRequest && e.trialRequest !== OPENING) {
    text = e.trialRequest;
  } else {
    if (!isSessionId(source)) fail("The conversation it came from is gone; write the request the trial should send.");
    ({ text, record } = await openingRequest(kernel, source));
  }
  const model = await trialModel({ home, kernel }, settings, source, record);
  const project = e.kind === "project-instructions" ? e.target : (isSessionId(source) ? await projectOf(home, source) : null) ?? (isProjectId(e.from?.[0]?.project) ? e.from[0].project : null);
  const args = forUser({ home, user }, {
    session: source ?? null,
    request: { text },
    ...(project ? { project } : {}),
    model,
    // An adopted change is already in the real home: the base arm takes it out, and the change arm runs
    // the home as it is. Either way the change arm is the one with the change.
    arms: isAdopted(e) ? [{ id: "base", change: await inverseOf({ kernel }, e) }, { id: "change", change: null }] : [{ id: "base", change: null }, { id: "change", change: changeOf(e) }],
    runs: settings?.trialRuns ?? 2,
    costUsd: settings?.trialCostUsd ?? 5,
    minutes: settings?.trialMinutes ?? 20,
    scratchMb: settings?.trialScratchMb ?? 8192,
  });
  if (!kernel?.operator?.call) fail("Trials need @thetis/host-trials, and this kernel has no operator channel.");
  const res = await kernel.operator.call("host.trials.start", args);
  const trial = res?.trial;
  if (typeof trial !== "string" || !TRIAL_ID.test(trial)) fail("The trial did not start: host.trials.start answered no trial id.");
  // The host call ran outside the library's queue: check the entry did not move meanwhile, else cancel what started.
  let moved = null;
  try {
    await updateEntry(home, id, (cur) => {
      if (cur.state !== e.state || (cur.trials ?? []).length !== (e.trials ?? []).length) {
        moved = cur.state;
        return undefined;
      }
      return { ...cur, state: "trialling", previousState: cur.state, trials: [...(cur.trials ?? []), trial], trialStartedAt: now() };
    });
  } catch (err) {
    await kernel.operator.call("host.trials.cancel", forUser({ home, user }, { trial })).catch(() => {});
    throw err;
  }
  if (moved !== null) {
    await kernel.operator.call("host.trials.cancel", forUser({ home, user }, { trial })).catch(() => {});
    fail(`It became ${moved} while the trial was starting, so the trial was cancelled; look at it again.`);
  }
  return { trial };
}

/**
 * Cancels an entry's running trial through @thetis/host-trials and puts the entry back where it was, with the
 * verdict "cancelled by you". A trial that had already finished is not an error: the entry goes back the same.
 */
export async function cancelTrial({ home, kernel, user }, id) {
  wantEntryId(id);
  const e = (await readLibrary(home)).entries.find((x) => x.id === id);
  if (!e) fail(`There is no proposal ${id}.`);
  if (e.state !== "trialling") fail("No trial of it is running.");
  const t = e.trials?.at(-1);
  if (TRIAL_ID.test(String(t))) {
    try {
      await kernel.operator.call("host.trials.cancel", forUser({ home, user }, { trial: t }));
    } catch (err) {
      const status = await readJson(home, `${hostTrialDir(t)}/trial.json`, null);
      if (!status || ["queued", "running"].includes(status.state)) throw err;
    }
  }
  return updateEntry(home, id, (cur) => {
    // Judged or cancelled meanwhile: it already went back, and that answer stands.
    if (cur.state !== "trialling" || cur.trials?.at(-1) !== t) return undefined;
    const next = { ...cur, state: backFromTrial(cur), ...unjudged(cur, { result: "inconclusive", why: "cancelled by you", error: "cancelled", at: now(), trial: t ?? null }) };
    delete next.previousState;
    return next;
  });
}

const JUDGED = new Set(["helped", "hurt", "no difference", "not reached"]);

/**
 * The verdict fields of an entry whose trial ended without a judgement (cancelled, failed). A judged verdict
 * from an earlier trial stands, so a stopped re-trial does not throw away what the last good one showed; the
 * unfinished trial is kept beside it as `lastTrial`.
 */
export function unjudged(cur, failure) {
  const prev = cur.verdict;
  if (prev && JUDGED.has(String(prev.result).replace(/ \(.*$/, ""))) return { verdict: prev, lastTrial: failure };
  return { verdict: failure, lastTrial: null };
}

/** The state an entry goes back to when its trial ends without a judgement. */
export const backFromTrial = (e) => (e.previousState && e.previousState !== "trialling" ? e.previousState : "proposed");

async function removeIfEmpty(home, dir) {
  if (!dir || dir === "skills" || dir === ".") return;
  if ((await list(home, dir)).length === 0) await remove(home, dir);
}

const parentDir = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Applies an entry's change to the real home or config; `text` is a file's whole new text (the change, or it merged). */
async function apply({ home, kernel }, e, current, text = e.change) {
  if (e.kind === "skill") return writeText(home, e.path, text);
  if (e.kind === "project-instructions") return writeText(home, `projects/${e.target}.md`, text);
  if (e.kind === "guide-note") {
    const notes = JSON.parse(current ?? "[]");
    if (notes.includes(e.change)) return;
    return kernel.config.set(HARNESS, "guideNotes", [...notes, e.change]);
  }
  if (e.kind === "config") {
    const { package: pkg, key } = configTarget(e.target);
    return kernel.config.set(pkg, key, JSON.parse(e.change));
  }
  fail(`A proposal of kind ${JSON.stringify(e.kind)} cannot be adopted.`);
}

/** The sentence an adopt or an update refuses with when the file moved where the change is. */
const conflictSentence = (e) => `${whereOf(e)} changed in the same place since; edit the proposal.`;

/**
 * Adopts an entry: `trialled`, `proposed` with `untried` (recorded as `applied.untried`), or `adopted` with a
 * re-check. A skill or instructions file that moved since the proposal gets the change merged in, or the
 * adopt refuses: "<where> changed in the same place since; edit the proposal." A guide note is appended
 * unless it is there; a config key is set whatever it is now (the place showed it).
 */
export async function adoptEntry({ home, kernel }, id, { untried = false } = {}) {
  wantEntryId(id);
  // Checked inside the queue, applied outside it (a config write or a file is slow), recorded inside again.
  const e = await updateEntry(home, id, (cur) => {
    if (cur.state === "proposed" && untried !== true) fail("It has not been tried. Adopt it without a trial, or try it first.");
    if (cur.state === "adopted" && !cur.recheck) fail("It is already adopted.");
    if (!["proposed", "trialled", "adopted"].includes(cur.state)) fail(stateRefusal(cur) ?? `A proposal that is ${cur.state} cannot be adopted.`);
    return undefined;
  });
  const packages = await installedPackages({ home, kernel });
  const current = await currentOf({ home, kernel }, e, packages);
  let text = e.change;
  if (isFile(e)) {
    const expected = e.applied ? e.applied.after : e.before;
    if (current !== expected) {
      const merged = merge3(expected ?? "", e.change ?? "", current ?? "");
      if (!merged.ok) fail(conflictSentence(e));
      text = merged.text;
    }
  }
  await apply({ home, kernel }, e, current, text);
  const after = await currentOf({ home, kernel }, e, packages);
  const at = now();
  const today = versionMap(packages);
  return updateEntry(home, id, (cur) => {
    if (cur.state !== e.state || (cur.trials ?? []).length !== (e.trials ?? []).length || cur.change !== e.change) fail(`It became ${cur.state === e.state ? "edited" : cur.state} while it was being adopted; the change was written to ${whereOf(e)} all the same. Look at it again.`);
    return {
      ...cur,
      state: "adopted",
      applied: cur.applied ? { ...cur.applied, after, at } : { before: current, after, at, ...(e.state === "proposed" ? { untried: true } : {}) },
      recheck: null,
      // The owner's version as adopted: a re-check compares against it.
      versions: cur.owner && today[cur.owner] ? { ...cur.versions, [cur.owner]: today[cur.owner] } : cur.versions,
    };
  });
}

/** An entry that can be edited or updated: not yet adopted, and not past deciding. */
function wantEditable(e) {
  if (e.state === "adopted") fail("It is adopted; retire it before you change it.");
  if (!["proposed", "trialled"].includes(e.state)) fail(stateRefusal(e) ?? `A proposal that is ${e.state} cannot be changed.`);
}

/** The verdict of a trial of the earlier text: it stands, marked as being about that text. */
const staleVerdict = (v) => (v ? { verdict: { ...v, stale: true } } : {});

/**
 * Replaces an entry's change with the person's text, checked against the guard's limits (`prompt.js`).
 * `before` becomes what is there now, so the text is the change from today; a trialled entry goes back to
 * `proposed` and its verdict is kept, marked `stale`.
 */
export async function editEntry({ home, kernel }, id, change) {
  wantEntryId(id);
  if (typeof change !== "string") fail("change must be text: the new note, file or JSON value.");
  const e = (await readLibrary(home)).entries.find((x) => x.id === id);
  if (!e) fail(`There is no proposal ${id}.`);
  wantEditable(e);
  const packages = await installedPackages({ home, kernel });
  const ctx = {
    packages: new Map(packages.map((p) => [p.name, { version: p.version, config: p.thetis?.config ?? {} }])),
    projects: new Set((await listProjects(home)).map((p) => p.id)),
    skills: skillMap(skillsOf(home, packages)),
  };
  const why = changeProblem(e.kind, e.target, change, ctx);
  if (why) fail(`That does not hold: ${why}.`);
  const text = cleanChange(e.kind, change);
  const current = await currentOf({ home, kernel }, e, packages);
  return updateEntry(home, id, (cur) => {
    if (cur.state !== e.state || cur.change !== e.change) fail("It changed while you were editing it; look at it again.");
    if (text === cur.change && current === cur.before) return undefined;
    return { ...cur, change: text, before: current, edited: { at: now() }, state: cur.state === "trialled" ? "proposed" : cur.state, ...staleVerdict(cur.verdict) };
  });
}

/** Updates an out-of-date file entry: its change merged into today's file becomes the change, and today's file `before`. */
export async function rebaseEntry({ home, kernel }, id) {
  wantEntryId(id);
  const e = (await readLibrary(home)).entries.find((x) => x.id === id);
  if (!e) fail(`There is no proposal ${id}.`);
  wantEditable(e);
  if (!isFile(e)) fail("Only a skill or project instructions can be out of date.");
  const current = await currentOf({ home, kernel }, e);
  if (current === e.before) fail(`It is up to date: ${whereOf(e)} is as the proposal saw it.`);
  const merged = merge3(e.before ?? "", e.change ?? "", current ?? "");
  if (!merged.ok) fail(conflictSentence(e));
  return updateEntry(home, id, (cur) => {
    if (cur.state !== e.state || cur.change !== e.change || cur.before !== e.before) fail("It changed while it was being updated; look at it again.");
    return { ...cur, change: merged.text, before: current, rebasedAt: now(), ...staleVerdict(cur.verdict) };
  });
}

/** Retires an adopted entry: puts back what was there before it. */
export async function retireEntry({ home, kernel }, id) {
  wantEntryId(id);
  const e = await updateEntry(home, id, (cur) => {
    if (cur.state === "trialling") fail("Its trial is still running; wait for it to finish.");
    if (cur.state === "retired") fail("It is already retired.");
    if (!cur.applied) fail("It was never adopted, so there is nothing to retire.");
    return undefined;
  });
  const before = e.applied.before;
  if (e.kind === "skill") {
    if (before === null || e.skillSource === "shipped" || e.skillSource === "new") {
      await remove(home, e.path);
      await removeIfEmpty(home, parentDir(e.path));
    } else await writeText(home, e.path, before);
  } else if (e.kind === "project-instructions") {
    if (before === null) await remove(home, `projects/${e.target}.md`);
    else await writeText(home, `projects/${e.target}.md`, before);
  } else if (e.kind === "guide-note") {
    const notes = await guideNotes(kernel);
    const i = notes.indexOf(e.change);
    if (i >= 0) {
      notes.splice(i, 1);
      if (notes.length) await kernel.config.set(HARNESS, "guideNotes", notes);
      else await kernel.config.unset(HARNESS, "guideNotes");
    }
  } else if (e.kind === "config") {
    const { package: pkg, key } = configTarget(e.target);
    if (before === null) await kernel.config.unset(pkg, key);
    else await kernel.config.set(pkg, key, JSON.parse(before));
  }
  return updateEntry(home, id, (cur) => {
    if (cur.state !== e.state || !cur.applied) fail(`It became ${cur.state} while it was being retired; what was there before was put back all the same. Look at it again.`);
    return { ...cur, state: "retired", recheck: null, applied: { ...cur.applied, retiredAt: now() } };
  });
}

/** Every finding, by package, the most recently seen first within one. */
export async function listFindings(home) {
  const { findings } = await readFindings(home);
  const last = (f) => f.seen.reduce((m, s) => (String(s.at) > m ? String(s.at) : m), "");
  return findings.sort((a, b) => a.package.localeCompare(b.package) || last(b).localeCompare(last(a)));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "30 Oct", in UTC; with `year`, "30 Oct 2026". */
export function shortDate(iso, { year = false } = {}) {
  const d = new Date(iso ?? "");
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ""}`;
}

/** A fence for `text` in Markdown: longer than any run of backticks in it. */
const fence = (text) => "`".repeat(Math.max(3, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length + 1)));

/** How many cited events an issue carries in all; past it the rest are counted, not copied. */
const ISSUE_EVENTS = 40;

/**
 * What Fix this and Copy hand the person for a finding: `{ prompt, issue, project }`. `prompt` is a new
 * conversation's first message; `issue` the same facts as a Markdown issue, with each sighting's cited
 * events; `project` where it was seen most (the mode of the sightings' projects, ties to the latest
 * sighting), or null.
 */
export async function findingText(home, id) {
  if (typeof id !== "string" || !FINDING_ID.test(id)) fail("id is required: the finding's id, such as F-1a2b3c.");
  const f = (await readFindings(home)).findings.find((x) => x.id === id);
  if (!f) fail(`There is no finding ${id}.`);
  const seen = [...f.seen].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  const last = seen.at(-1) ?? null;
  const counts = new Map();
  const latest = new Map();
  for (const [i, x] of seen.entries()) {
    const p = isSessionId(x.session) ? await projectOf(home, x.session) : null;
    counts.set(p, (counts.get(p) ?? 0) + 1);
    latest.set(p, i);
  }
  let project = null;
  let best = -1;
  for (const [p, n] of counts) if (n > best || (n === best && latest.get(p) > latest.get(project))) [project, best] = [p, n];
  const where = `${f.package}${f.component ? ` (${f.component})` : ""}`;
  const times = seen.length === 1 ? "once" : `${seen.length} times`;
  const lastAt = shortDate(last?.at);
  const lastLine = `Seen ${times}${lastAt ? `, last on ${lastAt}` : ""}${last?.title ? ` in "${last.title}"` : ""}.`;
  const prompt = `Fix a problem Reflections found in ${where}:\n\n${f.what}\n\n${lastLine} Reproduce it first, then fix it, and show me the test that proves the fix.`;
  const version = seen.reduce((h, s) => (s.version && (!h || compareVersions(s.version, h) > 0) ? s.version : h), null);
  const first = String(f.what ?? "").split(/(?<=\.)\s/)[0];
  const out = [`# ${f.package}: ${first.length > 100 ? `${first.slice(0, 99)}…` : first}`, "", `- Package: \`${f.package}${version ? `@${version}` : ""}\``, `- Component: \`${f.component ?? "unknown"}\``, "", f.what, "", `## Seen ${times}`];
  let budget = ISSUE_EVENTS;
  for (const x of [...seen].reverse()) {
    out.push("", `### ${shortDate(x.at, { year: true }) ?? "Undated"}${x.title ? ` · "${x.title}"` : ""}${x.version ? ` · ${f.package}@${x.version}` : ""}`);
    const events = [...new Set((x.events ?? []).filter((n) => Number.isInteger(n) && n > 0))];
    const missing = [];
    for (const n of events) {
      const ev = budget > 0 ? await readEvent(home, x.session, n) : null;
      if (!ev) {
        missing.push(n);
        continue;
      }
      budget--;
      const fenceOf = fence(ev.text);
      out.push("", `[${n}] ${ev.kind}`, fenceOf, ev.text, fenceOf);
    }
    if (missing.length) out.push("", `Cited, not copied here: ${missing.map((n) => `[${n}]`).join(", ")}.`);
  }
  return { prompt, issue: `${out.join("\n")}\n`, project };
}

export async function closeFinding(home, id) {
  if (typeof id !== "string" || !FINDING_ID.test(id)) fail("id is required: the finding's id, such as F-1a2b3c.");
  return updateFindings(home, (store) => {
    const f = store.findings.find((x) => x.id === id);
    if (!f) fail(`There is no finding ${id}.`);
    if (f.state === "closed") fail("It is already closed.");
    f.state = "closed";
    f.closedAt = now();
    return f;
  });
}

// ---- the sweeps ----

/** An open finding whose package is installed at a newer version than any sighting becomes `possibly-fixed`. */
export function sweepFindings(home, installed) {
  return updateFindings(home, (store) => {
    let changed = 0;
    for (const f of store.findings) {
      if (f.state !== "open") continue;
      const highest = f.seen.reduce((h, s) => (s.version && (!h || compareVersions(s.version, h) > 0) ? s.version : h), null);
      const is = installed[f.package];
      if (highest && is && compareVersions(is, highest) > 0) {
        f.state = "possibly-fixed";
        f.since = is;
        changed++;
      }
    }
    return changed;
  });
}

/** An adopted entry whose owner is installed at another version than it was adopted against gets a re-check. */
export function recheckAdopted(home, installed) {
  return updateLibrary(home, (lib) => {
    let changed = 0;
    for (const e of lib.entries) {
      if (e.state !== "adopted" || !e.owner) continue;
      const was = e.versions?.[e.owner];
      const is = installed[e.owner];
      if (!was || !is || was === is) continue;
      const reason = `${e.owner} changed ${was} → ${is} since adoption`;
      if (e.recheck?.reason === reason) continue;
      e.recheck = { reason, at: now() };
      e.updatedAt = e.recheck.at;
      changed++;
    }
    return changed;
  });
}

// ---- forget ----


/** What a forget of `sessions` would do to the library and the findings. */
export async function forgetPlan(home, sessions) {
  const set = new Set(sessions);
  const { entries } = await readLibrary(home);
  const { findings } = await readFindings(home);
  const touched = entries.filter((e) => (e.from ?? []).some((f) => set.has(f.session)));
  const only = touched.filter((e) => (e.from ?? []).every((f) => set.has(f.session)));
  return {
    removable: only.filter((e) => !isAdopted(e)),
    adopted: only.filter(isAdopted),
    shared: touched.filter((e) => !only.includes(e)),
    findings: findings.filter((f) => f.seen.some((s) => set.has(s.session))),
  };
}

/**
 * Forgets `sessions` in the library and the findings. With `proposals`, the entries that came only from them
 * and are not adopted go, with their trial files; `from` items for them leave every other entry; their
 * sightings leave every finding, and a finding with none left goes.
 */
export async function forgetInLibrary(home, sessions, { proposals = true, kernel, user, log = () => {} } = {}) {
  const set = new Set(sessions);
  const isFrom = (e) => (e.from ?? []).some((f) => set.has(f.session));
  const onlyFrom = (e) => (e.from ?? []).length > 0 && e.from.every((f) => set.has(f.session));
  const { gone, trials, adoptedKept } = await updateLibrary(home, (lib) => {
    const only = lib.entries.filter(onlyFrom);
    const goneIds = new Set(proposals ? only.filter((e) => !isAdopted(e)).map((e) => e.id) : []);
    const trialIds = lib.entries.filter((e) => goneIds.has(e.id)).flatMap((e) => (e.trials ?? []).filter((t) => TRIAL_ID.test(t)));
    for (const e of lib.entries) if (isFrom(e) && !onlyFrom(e)) e.from = e.from.filter((f) => !set.has(f.session));
    lib.entries = lib.entries.filter((e) => !goneIds.has(e.id));
    return { gone: goneIds.size, trials: trialIds, adoptedKept: only.filter(isAdopted).length };
  });
  for (const t of trials) {
    await remove(home, trialDir(t));
    await remove(home, hostTrialDir(t));
    // The host keeps its own copy (the spec, with the request's text) outside the home; ask it to drop it.
    if (kernel?.operator?.call) {
      try {
        await kernel.operator.call("host.trials.forget", forUser({ home, user }, { trial: t }));
      } catch (err) {
        log(`reflections: the trials host could not forget ${t}: ${err?.message ?? err}`);
      }
    }
  }
  const { touched, removed } = await updateFindings(home, (store) => {
    const before = store.findings.length;
    let n = 0;
    for (const f of store.findings) {
      const k = f.seen.length;
      f.seen = f.seen.filter((x) => !set.has(x.session));
      if (f.seen.length !== k) n++;
    }
    store.findings = store.findings.filter((f) => f.seen.length);
    return { touched: n, removed: before - store.findings.length };
  });
  return { removed: gone, adoptedKept, findingsTouched: touched, findingsRemoved: removed };
}

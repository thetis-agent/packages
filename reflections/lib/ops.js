// What the Reflections place and chip ask, answered from the files in the home. The UI commands run in
// the person's gateway, the service in their fence; the records are where the two meet, so a place opened
// while the service is down still lists, cancels and forgets, and a Reflect waits in the queue until the
// service is back. The proposals and findings are `library.js`'s: an op here checks its arguments, calls
// the library, and adds what the place draws beside them (titles, project names, the trial's files).
// A file path answered here is relative to the home: Files resolves that against the home, and has no `~/`.
import { list as listDir, readJson, readText } from "./files.js";
import { REQUEST_CHARS, adoptEntry, cancelTrial, closeFinding, getEntry, listEntries, listFindings, openingRequest, rejectEntry, retireEntry, startTrial } from "./library.js";
import {
  ACTIVE, INSTALLED, NAME, contextDir, hostTrialDir, trialDir, freshRecord, gatewayMarks, isProjectId, isSessionId, listProjects, projectOf, readRecord, readRecords, readSpend,
  readSwitches, reflectionPath, setSwitch, settingsOf, titleOf, writeRecord,
} from "./records.js";

export const OPS = Object.freeze([
  "list", "get", "reflect", "cancel", "settings", "set-setting", "project-switch",
  "proposals", "proposal", "trial", "trial-cancel", "adopt", "reject", "retire", "findings", "finding-close",
]);

const fail = (message) => {
  throw new Error(message);
};

const ENTRY = /^L-[A-Za-z0-9]{1,40}$/;
const FINDING = /^F-[A-Za-z0-9]{1,40}$/;
const TRIAL = /^t_[A-Za-z0-9]{1,40}$/;

function wantSession(s) {
  if (typeof s !== "string" || !s) fail("session is required: the conversation's id, such as s_1a2b3c4d5e6f.");
  if (!isSessionId(s)) fail(`${JSON.stringify(s)} is not a conversation id.`);
  return s;
}

function wantEntry(id) {
  if (typeof id !== "string" || !id) fail("id is required: the proposal's id, such as L-ab12cd.");
  if (!ENTRY.test(id)) fail(`${JSON.stringify(id)} is not a proposal id.`);
  return id;
}

function wantFinding(id) {
  if (typeof id !== "string" || !id) fail("id is required: the finding's id, such as F-ab12cd.");
  if (!FINDING.test(id)) fail(`${JSON.stringify(id)} is not a finding id.`);
  return id;
}

/** The library answers an array or `{ entries }` / `{ findings }`; both read as the array. */
const arrayOf = (out, key) => (Array.isArray(out) ? out : Array.isArray(out?.[key]) ? out[key] : []);

async function kernelList(env) {
  try {
    return await env.kernel.sessions.list();
  } catch {
    return null;
  }
}

/** The configuration as it is now, read again from the kernel so a setting just changed shows at once. */
async function currentSettings(env) {
  try {
    return settingsOf(await env.kernel.config.effective(NAME));
  } catch {
    return settingsOf(env.config);
  }
}

/** What the Run trial button promises: the runs each way and the cap, from the settings. */
const trialOf = (s) => ({ runs: s.trialRuns, costUsd: s.trialCostUsd, minutes: s.trialMinutes });

/** The first message of the person in a conversation, as a trial would send it; null when it cannot be read. */
async function openingText(env, s) {
  if (!isSessionId(s)) return null;
  try {
    return (await openingRequest(env.kernel, s)).text;
  } catch {
    return null;
  }
}

/** One trial's state and files, from `home/trials/<t>/trial.json` and `reflections/trials/<t>/`. */
async function trialView(home, t) {
  if (typeof t !== "string" || !TRIAL.test(t)) return null;
  const trial = await readJson(home, `${hostTrialDir(t)}/trial.json`, null);
  const exported = new Set(await listDir(home, trialDir(t)));
  const runs = (Array.isArray(trial?.runs) ? trial.runs : []).map((r) => {
    const name = `${r.arm}-${r.n}.md`;
    return {
      arm: r.arm,
      n: r.n,
      state: r.state ?? null,
      costUsd: typeof r.costUsd === "number" ? r.costUsd : null,
      error: r.error ?? null,
      startedAt: r.startedAt ?? null,
      finishedAt: r.finishedAt ?? null,
      file: /^[a-z]+-\d+\.md$/.test(name) && exported.has(name) ? `${trialDir(t)}/${name}` : null,
    };
  });
  return {
    id: t,
    state: trial?.state ?? null,
    error: trial?.error ?? null,
    costUsd: typeof trial?.costUsd === "number" ? trial.costUsd : null,
    createdAt: trial?.createdAt ?? null,
    finishedAt: trial?.finishedAt ?? null,
    runs,
    judge: exported.has("judge.md") ? `${trialDir(t)}/judge.md` : null,
  };
}

export function createOps(env) {
  const home = env.cwd;
  const lib = { home, kernel: env.kernel, user: env.user };

  /** Project ids to names, for an entry whose target is a project. */
  const projectNames = async () => new Map((await listProjects(home)).map((p) => [p.id, p.name]));

  /** An entry as the place draws it: the project's name when it targets one, and each source's state. */
  function annotate(entry, names, summaries) {
    const from = (Array.isArray(entry.from) ? entry.from : []).map((f) => ({ ...f, gone: summaries ? !summaries.has(f.session) : false }));
    const targetName = entry.kind === "project-instructions" ? names.get(entry.target) ?? (isProjectId(entry.target) ? "a removed project" : null) : null;
    return { ...entry, from, targetName };
  }

  const ops = {
    /** Every record, every archived conversation without one, the day's spend, and how many trials run. */
    async list() {
      const [records, marks, all, installed, settings, entries] = await Promise.all([
        readRecords(home), gatewayMarks(home, env.user), kernelList(env), readJson(home, INSTALLED, null), currentSettings(env), listEntries(home),
      ]);
      const summaries = new Map((all ?? []).map((s) => [s.id, s]));
      const titles = new Map();
      for (const r of records) titles.set(r.session, r.title);
      // The name the person gave wins; else the title recorded at archive; else the first message.
      for (const s of all ?? []) if (!s.parent) titles.set(s.id, marks[s.id]?.title ?? titles.get(s.id) ?? titleOf(undefined, s));
      const items = records.map((r) => ({
        ...r,
        title: titles.get(r.session) ?? r.title,
        archived: marks[r.session]?.archived ?? false,
        gone: all ? !summaries.has(r.session) : false,
      }));
      const seen = new Set(records.map((r) => r.session));
      for (const s of all ?? []) {
        if (s.parent || seen.has(s.id) || !marks[s.id]?.archived) continue;
        const at = marks[s.id].archivedAt;
        // Only an archive the hook saw writes a record; anything else predates this package, or a gateway that had no hook yet.
        const before = !at || !installed?.at || at < installed.at;
        items.push({ session: s.id, title: titles.get(s.id), state: "none", reason: before ? "archived before Reflections was installed" : "not reflected", archived: true, archivedAt: at ?? null, turns: s.turns });
      }
      const rank = (i) => (i.state === "running" ? 0 : i.state === "queued" ? 1 : 2);
      items.sort((a, b) => rank(a) - rank(b) || String(b.finishedAt ?? b.updatedAt ?? b.archivedAt ?? "").localeCompare(String(a.finishedAt ?? a.updatedAt ?? a.archivedAt ?? "")));
      const trialling = arrayOf(entries, "entries").filter((e) => e?.state === "trialling").length;
      return { items, spend: await readSpend(home), cap: settings.dailyCostUsd, trialling };
    },

    /** One conversation: its record, the reflection text, its proposal and findings, and where the evidence is. */
    async get({ session } = {}) {
      const s = wantSession(session);
      const [record, marks, all, entries, findings] = await Promise.all([readRecord(home, s), gatewayMarks(home, env.user), kernelList(env), listEntries(home), listFindings(home)]);
      const summary = all?.find((x) => x.id === s) ?? null;
      const title = record?.title ?? (summary ? titleOf(marks[s], summary) : s);
      const byEntry = new Map(arrayOf(entries, "entries").map((e) => [e.id, e]));
      const byFinding = new Map(arrayOf(findings, "findings").map((f) => [f.id, f]));
      const proposal = typeof record?.proposal === "string" ? byEntry.get(record.proposal) ?? { id: record.proposal, missing: true } : null;
      const found = (Array.isArray(record?.findings) ? record.findings : []).map((id) => byFinding.get(id) ?? { id, missing: true });
      const evidence = (await listDir(home, contextDir(s))).length ? `${contextDir(s)}/trajectory.md` : null;
      return {
        record: record ?? { session: s, title, state: "none" },
        archived: marks[s]?.archived ?? false,
        gone: all ? !summary : false,
        reflection: await readText(home, reflectionPath(s)),
        proposal,
        findings: found,
        evidence,
      };
    },

    /** Queues a reflection a person asked for. It runs past the switches and the daily cap: those govern only the automatic one. */
    async reflect({ session } = {}) {
      const s = wantSession(session);
      const record = await readRecord(home, s);
      if (record && ACTIVE.includes(record.state)) fail(`This conversation is already ${record.state === "running" ? "being reflected on" : "queued"}.`);
      const all = await kernelList(env);
      const summary = all?.find((x) => x.id === s);
      if (all && !summary) fail("That conversation is gone, so there is nothing to reflect on.");
      if (summary?.parent) fail("A subagent is reflected on with its parent conversation; reflect on that one.");
      const marks = await gatewayMarks(home, env.user);
      const base = { session: s, title: summary ? titleOf(marks[s], summary) : record?.title ?? s, project: await projectOf(home, s) };
      const next = freshRecord(base, "queued", { manual: true, ...(record?.archivedAt ? { archivedAt: record.archivedAt } : marks[s]?.archivedAt ? { archivedAt: marks[s].archivedAt } : {}) });
      await writeRecord(home, next);
      return next;
    },

    async cancel({ session } = {}) {
      const s = wantSession(session);
      const record = await readRecord(home, s);
      if (!record || !ACTIVE.includes(record.state)) fail("Nothing is queued or running for this conversation.");
      const next = { ...record, state: "cancelled", reason: "cancelled by you", updatedAt: new Date().toISOString() };
      await writeRecord(home, next);
      return next;
    },

    /** Every proposal, with what the Run trial button promises. */
    async proposals() {
      const [entries, names, all, settings] = await Promise.all([listEntries(home), projectNames(), kernelList(env), currentSettings(env)]);
      const summaries = all ? new Map(all.map((s) => [s.id, s])) : null;
      return { entries: arrayOf(entries, "entries").map((e) => annotate(e, names, summaries)), trial: trialOf(settings) };
    },

    /** One proposal: the entry, its last trial (state, runs and files) and the request a trial would send. */
    async proposal({ id } = {}) {
      const want = wantEntry(id);
      const got = await getEntry(home, want);
      const entry = got?.entry ?? got;
      if (!entry || entry.id !== want) fail(`There is no proposal ${want}; it may have been forgotten.`);
      const [names, all, settings] = await Promise.all([projectNames(), kernelList(env), currentSettings(env)]);
      const summaries = all ? new Map(all.map((s) => [s.id, s])) : null;
      const trials = Array.isArray(entry.trials) ? entry.trials : [];
      const opening = entry.trialRequest === "opening request";
      const text = opening ? await openingText(env, entry.from?.[0]?.session) : typeof entry.trialRequest === "string" ? entry.trialRequest : null;
      return {
        entry: annotate(entry, names, summaries),
        trial: trials.length ? await trialView(home, trials.at(-1)) : null,
        request: { text, source: opening ? "opening request" : "proposal" },
        settings: trialOf(settings),
      };
    },

    /** Runs a trial of a proposal: the request with and without its change. `request`, when given, replaces the proposal's. */
    async trial({ id, request } = {}) {
      const want = wantEntry(id);
      const opts = {};
      if (request !== undefined && request !== null) {
        if (typeof request !== "string" || !request.trim()) fail("request must be the text the trial sends, or left out.");
        if (request.length > REQUEST_CHARS) fail(`request is over ${REQUEST_CHARS} characters.`);
        opts.request = request.trim();
      }
      return startTrial(lib, await currentSettings(env), want, opts);
    },

    /** Stops a proposal's running trial; the proposal goes back to where it was. */
    async "trial-cancel"({ id } = {}) {
      return cancelTrial(lib, wantEntry(id));
    },

    /** Applies a trialled proposal to your home or settings. */
    async adopt({ id } = {}) {
      return adoptEntry(lib, wantEntry(id));
    },

    async reject({ id } = {}) {
      return rejectEntry(home, wantEntry(id));
    },

    /** Undoes an adopted proposal: what was there before it comes back. */
    async retire({ id } = {}) {
      return retireEntry(lib, wantEntry(id));
    },

    /** Every finding, with each sighting's conversation marked gone when it was forgotten. */
    async findings() {
      const [findings, all] = await Promise.all([listFindings(home), kernelList(env)]);
      const summaries = all ? new Set(all.map((s) => s.id)) : null;
      return {
        findings: arrayOf(findings, "findings").map((f) => ({ ...f, seen: (Array.isArray(f.seen) ? f.seen : []).map((x) => ({ ...x, gone: summaries ? !summaries.has(x.session) : false })) })),
      };
    },

    async "finding-close"({ id } = {}) {
      return closeFinding(home, wantFinding(id));
    },

    /** The Settings card: the models to choose from, the cap and today's spend, the trial settings, the project switches. */
    async settings() {
      const settings = await currentSettings(env);
      let models = [];
      let serverDefault = "";
      let modelsError = null;
      try {
        const choices = await env.kernel.models();
        serverDefault = typeof choices?.model === "string" ? choices.model : "";
        models = (choices?.models ?? []).filter((m) => typeof m?.id === "string").map((m) => ({ id: m.id, name: m.name ?? m.id, provider: m.provider ?? null }));
      } catch (e) {
        modelsError = e?.message ?? String(e);
      }
      const switches = await readSwitches(home);
      const projects = (await listProjects(home)).map((p) => ({ ...p, enabled: switches[p.id] !== false }));
      return { ...settings, serverDefault, models, modelsError, spend: await readSpend(home), projects };
    },

    /** Changes one setting at the person's own layer; a null or empty value goes back to the default. */
    async "set-setting"({ key, value } = {}) {
      const kinds = { model: "string", dailyCostUsd: "number", minTurns: "number", enabled: "boolean", trialRuns: "runs", trialCostUsd: "positive", trialMinutes: "minutes", trialScratchMb: "scratch", trialModel: "string" };
      if (!Object.hasOwn(kinds, key)) fail(`key must be one of ${Object.keys(kinds).join(", ")}.`);
      if (value === null || value === undefined || value === "") {
        await env.kernel.config.unset(NAME, key);
        return ops.settings();
      }
      const kind = kinds[key];
      const finite = typeof value === "number" && Number.isFinite(value);
      if (kind === "number" && !(finite && value >= 0)) fail(`${key} must be a number, 0 or more.`);
      if (kind === "positive" && !(finite && value > 0)) fail(`${key} must be a number above 0.`);
      if (kind === "minutes" && !(finite && value >= 1)) fail(`${key} must be a number, 1 or more.`);
      if (kind === "scratch" && !(Number.isInteger(value) && value >= 256)) fail(`${key} must be a whole number of megabytes, 256 or more.`);
      if (kind === "runs" && !(Number.isInteger(value) && value >= 1 && value <= 5)) fail(`${key} must be a whole number from 1 to 5.`);
      if (kind === "boolean" && typeof value !== "boolean") fail(`${key} must be true or false.`);
      if (kind === "string" && (typeof value !== "string" || value.length > 200)) fail(`${key} must be a model id.`);
      await env.kernel.config.set(NAME, key, kind === "string" ? value.trim() : value);
      return ops.settings();
    },

    /** Switches automatic reflection on or off for one project. */
    async "project-switch"({ project, enabled } = {}) {
      if (!isProjectId(project)) fail("project is required: the project's id, such as p_1a2b3c4d.");
      if (typeof enabled !== "boolean") fail("enabled must be true or false.");
      await setSwitch(home, project, enabled);
      return ops.settings();
    },
  };
  return ops;
}

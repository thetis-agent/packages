// What the Reflections place and chip ask, answered from the files in the home. The UI commands run in
// the person's gateway, the service in their fence; the records are where the two meet, so a place opened
// while the service is down still lists, cancels and forgets, and a Reflect waits in the queue until the
// service is back.
import { list as listDir, readJson, readText } from "./files.js";
import { listLessons, removeLessons } from "./lessons.js";
import {
  ACTIVE, INSTALLED, NAME, contextDir, freshRecord, gatewayMarks, isProjectId, isSessionId, listProjects, projectOf, readRecord, readRecords, readSpend,
  readSwitches, reflectionPath, setSwitch, settingsOf, titleOf, writeRecord,
} from "./records.js";

export const OPS = Object.freeze(["list", "get", "reflect", "cancel", "forget-lesson", "settings", "set-setting", "project-switch"]);

const fail = (message) => {
  throw new Error(message);
};

function wantSession(s) {
  if (typeof s !== "string" || !s) fail("session is required: the conversation's id, such as s_1a2b3c4d5e6f.");
  if (!isSessionId(s)) fail(`${JSON.stringify(s)} is not a conversation id.`);
  return s;
}

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

/** The lessons with each source's title, and each scope's name: what the Lessons tab draws. */
async function lessonsView(home, titles) {
  const lessons = await listLessons(home);
  const projects = new Map((await listProjects(home)).map((p) => [`p-${p.id.slice(2)}`, p.name]));
  return lessons.map((l) => ({
    ...l,
    scopeName: l.scope === "general" ? "No project" : projects.get(l.scope) ?? `A removed project (${l.scope})`,
    fromTitle: l.from ? titles.get(l.from) ?? null : null,
  }));
}

export function createOps(env) {
  const home = env.cwd;

  const ops = {
    /** Every record, every archived conversation without one, the lessons, and the day's spend. */
    async list() {
      const [records, marks, all, installed, settings] = await Promise.all([readRecords(home), gatewayMarks(home, env.user), kernelList(env), readJson(home, INSTALLED, null), currentSettings(env)]);
      const summaries = new Map((all ?? []).map((s) => [s.id, s]));
      const titles = new Map();
      for (const r of records) titles.set(r.session, r.title);
      // The name the person gave wins; else the title recorded at archive; else the first message.
      for (const s of all ?? []) if (!s.parent) titles.set(s.id, marks[s.id]?.title ?? titles.get(s.id) ?? titleOf(undefined, s));
      const lessons = await lessonsView(home, titles);
      const count = (s) => lessons.filter((l) => l.from === s && l.present).length;
      const items = records.map((r) => ({
        ...r,
        title: titles.get(r.session) ?? r.title,
        archived: marks[r.session]?.archived ?? false,
        gone: all ? !summaries.has(r.session) : false,
        lessons: count(r.session),
      }));
      const seen = new Set(records.map((r) => r.session));
      for (const s of all ?? []) {
        if (s.parent || seen.has(s.id) || !marks[s.id]?.archived) continue;
        const at = marks[s.id].archivedAt;
        // Only an archive the hook saw writes a record; anything else predates this package, or a gateway that had no hook yet.
        const before = !at || !installed?.at || at < installed.at;
        items.push({ session: s.id, title: titles.get(s.id), state: "none", reason: before ? "archived before Reflections was installed" : "not reflected", archived: true, archivedAt: at ?? null, turns: s.turns, lessons: count(s.id) });
      }
      const rank = (i) => (i.state === "running" ? 0 : i.state === "queued" ? 1 : 2);
      items.sort((a, b) => rank(a) - rank(b) || String(b.finishedAt ?? b.updatedAt ?? b.archivedAt ?? "").localeCompare(String(a.finishedAt ?? a.updatedAt ?? a.archivedAt ?? "")));
      return { items, lessons, spend: await readSpend(home), cap: settings.dailyCostUsd };
    },

    /** One conversation: its record, the reflection text, its lessons and where the evidence is. */
    async get({ session } = {}) {
      const s = wantSession(session);
      const [record, marks, all] = await Promise.all([readRecord(home, s), gatewayMarks(home, env.user), kernelList(env)]);
      const summary = all?.find((x) => x.id === s) ?? null;
      const title = record?.title ?? (summary ? titleOf(marks[s], summary) : s);
      const titles = new Map([[s, title]]);
      const lessons = (await lessonsView(home, titles)).filter((l) => l.from === s);
      const evidence = (await listDir(home, contextDir(s))).length ? `~/${contextDir(s)}/trajectory.md` : null;
      return {
        record: record ?? { session: s, title, state: "none" },
        archived: marks[s]?.archived ?? false,
        gone: all ? !summary : false,
        reflection: await readText(home, reflectionPath(s)),
        lessons,
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

    /** Removes one lesson: the skill, its provenance, and the record's link to it. */
    async "forget-lesson"({ id } = {}) {
      if (typeof id !== "string" || !/^lessons\/[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) fail("id is required: the lesson's skill id, such as lessons/general/check-the-generator.");
      const removed = await removeLessons(home, [id]);
      if (!removed.length) fail(`There is no lesson ${id}; it may have been removed already.`);
      for (const r of await readRecords(home)) {
        if (r.lesson === id) await writeRecord(home, { ...r, lesson: null, lessonForgottenAt: new Date().toISOString() });
      }
      return { removed };
    },

    /** The Settings card: the model and the models to choose from, the cap and today's spend, the project switches. */
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
      const kinds = { model: "string", dailyCostUsd: "number", minTurns: "number", enabled: "boolean" };
      if (!Object.hasOwn(kinds, key)) fail(`key must be one of ${Object.keys(kinds).join(", ")}.`);
      if (value === null || value === undefined || value === "") {
        await env.kernel.config.unset(NAME, key);
        return ops.settings();
      }
      if (kinds[key] === "number" && !(typeof value === "number" && Number.isFinite(value) && value >= 0)) fail(`${key} must be a number, 0 or more.`);
      if (kinds[key] === "boolean" && typeof value !== "boolean") fail(`${key} must be true or false.`);
      if (kinds[key] === "string" && (typeof value !== "string" || value.length > 200)) fail(`${key} must be a model id.`);
      await env.kernel.config.set(NAME, key, kinds[key] === "string" ? value.trim() : value);
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

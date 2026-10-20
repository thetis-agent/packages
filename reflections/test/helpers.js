// A fake fence for the tests: a temporary home and a kernel whose conversations, models, packages,
// configuration and one provider answer from tables, and a fake @thetis/host-trials behind
// `kernel.operator.call`. No network, no daemon: `providers.call` plays a script.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

export const text = (t) => [{ type: "text", data: { text: t } }];
export const user = (t, i = 0) => ({ role: "user", content: text(`${t}\n\n[Turn context: 2026-10-19 10:0${i} UTC]`) });
export const assistant = (t, calls) => ({ role: "assistant", content: text(t), ...(calls ? { toolCalls: calls } : {}) });
export const call = (id, name, args = {}) => ({ id, name, args });
export const result = (id, name, t) => ({ role: "tool", toolCallId: id, name, content: text(t) });

export async function tempHome() {
  const home = await mkdtemp(resolve(tmpdir(), "reflections-"));
  return { home, done: () => rm(home, { recursive: true, force: true }) };
}

export async function put(home, rel, value) {
  const file = resolve(home, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

export async function get(home, rel) {
  try {
    const t = await readFile(resolve(home, rel), "utf8");
    return rel.endsWith(".json") ? JSON.parse(t) : t;
  } catch {
    return null;
  }
}

/** A record as `kernel.sessions.inspect` answers it. */
export function record(id, conversation, extra = {}) {
  return { id, user: "u1", createdAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T11:00:00.000Z", turns: conversation.filter((m) => m.role === "user").length, conversation, harness: {}, status: "idle", ...extra };
}

export const SKILL = `---
name: generated-files
description: "Before editing a file, check whether a build or a generator produces it, and change the source instead. Use when a file you are about to edit is produced by a build or a generator."
---
# Generated files

Find the generator first: search for the file's name in the build scripts.
`;

/** A good answer: two rows with their components, one finding, and a new skill resting on both rows. */
export const GOOD_ANSWER = `<rows>
row: 1
approach: Edited the generated file dist/app.js directly.
component: judgement
observed: The build overwrote the edit [4] and the person said it was gone [5].
verdict: hurt
row: 2
approach: Found the generator in src/ and changed the source.
component: @thetis/tools-files search_files
observed: The change survived the next build [8] and the person confirmed it [9].
verdict: helped
</rows>

<findings>
finding: 1
package: @thetis/tools-files
component: edit_path
version: 0.4.0
what: edit_path wrote into a generated file without saying the build rebuilds it.
evidence: rows 1; [3], [4]
same-as: none
</findings>

<proposal>
kind: skill
target: generated-files
reinforces: none
cue: a file you are about to edit is produced by a build or a generator
lesson: A skill that sends the assistant to the generator before it edits a generated file, because the build overwrote the edit.
evidence: rows 1, 2; [4], [5], [8], [9]
confidence: medium, one conversation but a clear before and after
trial: opening request
change:
~~~
${SKILL}~~~
</proposal>`;

/** The installed packages the fake kernel lists, as `kernel.packages.list()` answers them. */
export function fakePackages(extra = []) {
  return [
    { name: "@thetis/harness-core", version: "0.8.0", type: "harness", description: "", root: "/nonexistent/harness-core", thetis: { config: { guideNotes: { type: "array", default: [] }, maxRounds: { type: "number", default: 40 }, secretKey: { type: "string", secret: true } } } },
    { name: "@thetis/tools-files", version: "0.4.0", type: "tool", description: "", root: "/nonexistent/tools-files", thetis: {} },
    { name: "@thetis/projects", version: "0.3.0", type: "tool", description: "", root: "/nonexistent/projects", thetis: {} },
    { name: "@thetis/reflections", version: "0.2.0", type: "tool", description: "", root: "/nonexistent/reflections", thetis: {} },
    ...extra,
  ];
}

/**
 * A fake @thetis/host-trials as `kernel.operator.call` reaches it. `start` writes `trials/<t>/trial.json`
 * (queued) in the home and answers the id; `status` reads it; `cancel` marks a running one cancelled and
 * refuses a finished one. `finishTrial` writes a finished one.
 */
export function fakeOperator(home, { admin = false } = {}) {
  const calls = [];
  let k = 0;
  return {
    calls,
    async call(method, args = {}) {
      calls.push({ method, args });
      // An admin's call reaches the host as it is, not pinned to anyone: the host needs to be told who.
      if (admin && method === "host.trials.start" && !args.user) throw new Error("name the person the trial is for (user)");
      if (method === "host.trials.forget") {
        if (!/^t_[0-9a-f]{8}$/.test(String(args.trial))) throw new Error("trial must be a trial id");
        return { trial: args.trial };
      }
      if (method === "host.trials.start") {
        const trial = `t_${(++k).toString(16).padStart(8, "0")}`;
        await put(home, `trials/${trial}/trial.json`, { id: trial, user: "u1", session: args.session, state: "queued", model: args.model, project: args.project ?? null, request: args.request, arms: args.arms, runs: [], costUsd: 0, createdAt: new Date().toISOString() });
        return { trial };
      }
      if (method === "host.trials.status") {
        const t = await get(home, `trials/${args.trial}/trial.json`);
        if (!t) throw new Error(`no trial ${args.trial}`);
        return t;
      }
      if (method === "host.trials.cancel") {
        const t = await get(home, `trials/${args.trial}/trial.json`);
        if (!t) throw new Error(`no trial ${args.trial}`);
        if (["done", "failed", "cancelled"].includes(t.state)) throw new Error("the trial already finished");
        await put(home, `trials/${args.trial}/trial.json`, { ...t, state: "cancelled" });
        return { trial: args.trial };
      }
      if (method === "host.trials.list") return [];
      throw new Error(`no method ${method}`);
    },
  };
}

/**
 * Writes a finished trial the way host-trials does: `trial.json` with its runs, and per run `record.json`
 * holding what `conversation(arm, n)` answers, plus a stamp line per run when `stamp(arm, n)` is given.
 */
export async function finishTrial(home, t, { runs = 1, state = "done", runState = () => "done", conversation = (arm) => [user("Fix the header colour"), assistant(arm === "change" ? "Found the generator; changed src/header.js." : "Edited dist/app.js.")], stamp = null, costUsd = 0.3, error } = {}) {
  const trial = await get(home, `trials/${t}/trial.json`);
  const list = [];
  for (let n = 1; n <= runs; n++) {
    for (const arm of ["base", "change"]) {
      const session = `s_${arm === "base" ? "b" : "c"}${n}000000`;
      list.push({ arm, n, state: runState(arm, n), session, costUsd: 0.1, tokens: {}, startedAt: "x", finishedAt: "y" });
      await put(home, `trials/${t}/${arm}-${n}/record.json`, record(session, conversation(arm, n)));
      if (stamp) await put(home, `trials/${t}/${arm}-${n}/harness/turns/${session}.jsonl`, `${JSON.stringify(stamp(arm, n))}\n`);
    }
  }
  await put(home, `trials/${t}/trial.json`, { ...trial, state, runs: list, costUsd, ...(error ? { error } : {}), finishedAt: new Date().toISOString() });
}

/**
 * The fake kernel. `sessions` is `[{ summary, record }]`; `script(request, n)` answers the events of one
 * provider call (`{ hang: true }` waits for the abort). `config` is the effective configuration of
 * @thetis/reflections; every other package's configuration is its manifest defaults under a user layer
 * kept in `kernel.layers`. `packages` is what `kernel.packages.list()` answers. With `home`, `operator`
 * is the fake host-trials over it; with `admin`, it refuses a start that names no user, as the kernel's
 * unpinned admin path does.
 */
export function fakeKernel({ sessions = [], script = () => [{ type: "text", delta: GOOD_ANSWER }, { type: "usage", usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.04 } }], models = ["fable", "opus"], config = {}, packages = fakePackages(), home = null, admin = false } = {}) {
  const calls = [];
  const sets = [];
  const layers = {};
  const byId = new Map(sessions.map((s) => [s.summary.id, s]));
  const SELF = "@thetis/reflections";
  const defaults = (name) => Object.fromEntries(Object.entries(packages.find((p) => p.name === name)?.thetis?.config ?? {}).filter(([, d]) => "default" in d).map(([k, d]) => [k, structuredClone(d.default)]));
  const kernel = {
    calls,
    sets,
    layers,
    packages: { list: async () => structuredClone(packages) },
    ...(home ? { operator: fakeOperator(home, { admin }) } : {}),
    config: {
      effective: async (name = SELF) => (name === SELF ? { ...config } : { ...defaults(name), ...structuredClone(layers[name] ?? {}) }),
      show: async (name) => ({ package: name, inherits: [], summary: "", broken: false, keys: Object.entries(layers[name] ?? {}).map(([key, value]) => ({ key, state: "set", source: "user", value: structuredClone(value), secret: false, declared: true })) }),
      set: async (name, key, value) => {
        sets.push({ name, key, value });
        if (name === SELF) config[key] = value;
        else (layers[name] ??= {})[key] = structuredClone(value);
        return {};
      },
      unset: async (name, key) => {
        sets.push({ name, key, value: undefined });
        if (name === SELF) delete config[key];
        else delete layers[name]?.[key];
        return {};
      },
    },
    models: async () => ({ model: models[0], models: models.map((id) => ({ id, name: id.toUpperCase() })) }),
    sessions: {
      list: async () => [...byId.values()].map((s) => ({ first: "", last: "", running: false, createdAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T11:00:00.000Z", turns: 3, ...s.summary })),
      inspect: async (id) => {
        const s = byId.get(id);
        if (!s) throw new Error(`no session ${id}`);
        return structuredClone(s.record);
      },
    },
    providers: {
      call: async (request, onEvent, signal) => {
        calls.push(request);
        for (const e of await script(request, calls.length)) {
          if (e.hang) {
            await new Promise((done) => signal?.addEventListener("abort", done, { once: true }));
            throw new Error("aborted");
          }
          if (e.throw) throw new Error(e.throw);
          onEvent(e);
        }
      },
    },
    remove(id) {
      byId.delete(id);
    },
  };
  return kernel;
}

/** A conversation of three turns with the events GOOD_ANSWER cites, as `{ summary, record }`. */
export function sampleSession(id = "s_aaaa1111", extra = {}) {
  const conversation = [
    user("Fix the header colour", 0), // 1
    assistant("I will edit it.", [call("c1", "edit_path", { path: "dist/app.js" })]), // 2, 3
    result("c1", "edit_path", "ok"), // 4
    user("It is gone after the build", 1), // 5
    assistant("Looking for the source.", [call("c2", "search_files", { pattern: "header" })]), // 6, 7
    result("c2", "search_files", "src/header.js:3"), // 8
    user("That worked, thanks", 2), // 9
    assistant("Done."), // 10
  ];
  return { summary: { id, turns: 3, first: "Fix the header colour", ...extra }, record: record(id, conversation) };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until `check()` is truthy, or fails after `ms`. */
export async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await wait(10);
  }
}

/** A guard context that lets GOOD_ANSWER through: every event visible, today's packages, no library. */
export function guardContext(extra = {}) {
  return {
    visible: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    versions: { "@thetis/tools-files": "0.4.0", "@thetis/harness-core": "0.8.0" },
    packages: new Map(fakePackages().map((p) => [p.name, { version: p.version, config: p.thetis?.config ?? {} }])),
    projects: new Set(["p_0a1b2c3d"]),
    entries: new Set(),
    findings: new Set(),
    skills: new Map(),
    ...extra,
  };
}

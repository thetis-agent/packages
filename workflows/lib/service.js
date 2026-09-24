// The service: every definition and run of one person, the queue that runs them, and the ops the socket
// answers. It holds the runs in memory (loaded from disk when it starts) and writes a run's file on every
// change, each write whole and renamed into place, and each followed by a `{ ev: "run" }` event without
// `vars`. `broadcast` is the host's; the service knows nothing of sockets.
import {
  blank,
  draftModified,
  isRunId,
  isStepId,
  isWorkflowId,
  listVersions,
  listWorkflowIds,
  newWorkflowId,
  normalise,
  publishDraft,
  readDraft,
  readPublished,
  readVersion,
  removeWorkflow,
  writeDraft,
} from "./definition.js";
import { firstError, validate } from "./validate.js";
import { ACTIVE, isActive, newRun, newestFirst, oldestFirst, readQueue, readRuns, writeQueue, writeRun, withoutVars } from "./runs.js";
import { decide, executeRun, retry } from "./engine.js";
import { list as listDir, readJson } from "./files.js";

export const DEFAULT_CONCURRENCY = 1;
export const DEFAULT_COST_CAP = 40;
export const SNAPSHOT_RUNS = 50;
export const TOUCH_MS = 500;
/** How long `stop` waits for in-flight runs to let go before it returns anyway. */
export const STOP_WAIT_MS = 1000;
/** How long `cancel` waits for a running step to stop before it writes the run as cancelled. */
export const CANCEL_WAIT_MS = 5000;
/** How long the kernel's model list is trusted before it is asked again. */
const MODELS_TTL_MS = 60_000;
const MAX_ENQUEUE = 200;

const fail = (message) => {
  throw new Error(message);
};
const positive = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

function wantWorkflowId(id) {
  if (typeof id !== "string" || !id) fail("id is required: the workflow's id, such as wf_1a2b3c4d.");
  if (!isWorkflowId(id)) fail(`${JSON.stringify(id)} is not a workflow id; a workflow id is wf_ and 8 hex digits.`);
  return id;
}
function wantRunId(id) {
  if (typeof id !== "string" || !id) fail("id is required: the run's id, such as r_0a1b2c3d4e.");
  if (!isRunId(id)) fail(`${JSON.stringify(id)} is not a run id; a run id is r_ and 10 hex digits.`);
  return id;
}

/**
 * `env` is the `ServiceEnv`: `cwd` (the home), `config`, `log`, `kernel`, `invokeTool`, `readFile`,
 * `writeFile`. `broadcast(line)` sends an event to every subscribed connection.
 */
export function createService(env, { broadcast = () => {}, user } = {}) {
  const home = env.cwd;
  const kernel = env.kernel;
  const log = env.log ?? (() => {});
  const config = env.config ?? {};
  const concurrency = Math.max(1, Math.floor(positive(config.concurrency, DEFAULT_CONCURRENCY)));
  const defaultCap = positive(config.costCapUsd, DEFAULT_COST_CAP);
  const who = user ?? process.env.THETIS_USER ?? "";

  const runs = new Map(); // id -> run
  const executing = new Map(); // id -> { controller, done }
  const writers = new Map(); // id -> { busy, again, timer }
  const definitions = new Map(); // "wf@N" -> definition, the versions runs are executing
  let queue = { paused: false };
  let stopping = false;
  let models = null;

  // ---- persistence ----

  /** Writes the run's file (coalescing writes that arrive while one is in flight) and broadcasts it. */
  function persist(run) {
    let w = writers.get(run.id);
    if (!w) writers.set(run.id, (w = { busy: null, again: false, timer: null }));
    clearTimeout(w.timer);
    w.timer = null;
    broadcast({ ev: "run", run: withoutVars(run) });
    if (w.busy) {
      w.again = true;
      return w.busy;
    }
    const write = async () => {
      do {
        w.again = false;
        try {
          await writeRun(home, run);
        } catch (e) {
          log(`workflows: could not write run ${run.id}: ${e?.message ?? e}`);
        }
      } while (w.again);
      w.busy = null;
    };
    w.busy = write();
    return w.busy;
  }

  function touch(run) {
    let w = writers.get(run.id);
    if (!w) writers.set(run.id, (w = { busy: null, again: false, timer: null }));
    if (w.timer) return;
    w.timer = setTimeout(() => {
      w.timer = null;
      void persist(run);
    }, TOUCH_MS);
    w.timer.unref?.();
  }

  async function flush() {
    for (const [id, w] of writers) {
      if (w.timer) {
        clearTimeout(w.timer);
        w.timer = null;
        const run = runs.get(id);
        if (run) await writeRun(home, run).catch(() => {});
      }
      if (w.busy) await w.busy;
    }
  }

  function queueState() {
    const all = [...runs.values()];
    return { paused: queue.paused, running: [...executing.keys()], queued: all.filter((r) => r.state === "queued").length };
  }
  const announceQueue = () => broadcast({ ev: "queue", queue: queueState() });

  // ---- definitions ----

  async function definitionOf(run) {
    const key = `${run.workflow}@${run.version}`;
    if (definitions.has(key)) return definitions.get(key);
    const d = await readVersion(home, run.workflow, run.version);
    if (d) definitions.set(key, d);
    return d;
  }

  async function modelIds() {
    if (models && Date.now() - models.at < MODELS_TTL_MS) return models.ids;
    try {
      const choices = await kernel.models();
      const ids = (choices?.models ?? []).map((m) => m?.id).filter((id) => typeof id === "string");
      models = { at: Date.now(), ids, choices };
      return ids;
    } catch {
      return undefined;
    }
  }

  const check = async (definition) => validate(definition, { models: await modelIds() });

  // ---- the queue ----

  function start(run, { resume = false } = {}) {
    const controller = new AbortController();
    const slot = { controller, done: null };
    executing.set(run.id, slot);
    const save = (r) => (controller.signal.aborted ? undefined : persist(r));
    const touchRun = (r) => {
      if (!controller.signal.aborted) touch(r);
    };
    slot.done = (async () => {
      try {
        const definition = await definitionOf(run);
        if (!definition) {
          run.state = "failed";
          run.reason = `Version ${run.version} of this workflow is gone, so the run cannot go on.`;
          run.updatedAt = new Date().toISOString();
          await persist(run);
          return;
        }
        await executeRun(run, definition, { kernel, env, signal: controller.signal, save, touch: touchRun, user: who, resume });
      } catch (e) {
        if (!controller.signal.aborted) {
          run.state = "failed";
          run.reason = `The workflow service failed while running this: ${e?.message ?? e}`;
          await persist(run);
        }
        log(`workflows: run ${run.id} stopped on an error: ${e?.stack ?? e}`);
      } finally {
        if (executing.get(run.id) === slot) executing.delete(run.id);
        if (!stopping) {
          announceQueue();
          pump();
        }
      }
    })();
    announceQueue();
    return slot;
  }

  /** Starts queued runs, oldest first, until `concurrency` are going. */
  function pump() {
    if (stopping || queue.paused) return;
    const waiting = [...runs.values()].filter((r) => r.state === "queued" && !executing.has(r.id)).sort(oldestFirst);
    for (const run of waiting) {
      if (executing.size >= concurrency) break;
      start(run);
    }
  }

  async function load() {
    queue = await readQueue(home);
    for (const run of await readRuns(home)) runs.set(run.id, run);
    // A run left running by a service that stopped is resumed at its step, whatever the queue says.
    for (const run of [...runs.values()].filter((r) => r.state === "running").sort(oldestFirst)) start(run, { resume: true });
    pump();
  }

  // ---- ops ----

  function need(id) {
    const run = runs.get(wantRunId(id));
    if (!run) fail(`There is no run ${id}. List the runs to find it.`);
    return run;
  }

  async function needDraft(id) {
    const draft = await readDraft(home, wantWorkflowId(id));
    if (!draft) fail(`There is no workflow ${id}. It may have been removed; list the workflows to find it.`);
    return draft;
  }

  function stats(id) {
    const mine = [...runs.values()].filter((r) => r.workflow === id);
    return {
      total: mine.length,
      active: mine.filter(isActive).length,
      needs: mine.filter((r) => r.state === "needs").length,
      lastAt: mine.reduce((at, r) => (r.createdAt > at ? r.createdAt : at), "") || null,
    };
  }

  const ops = {
    async list() {
      const out = [];
      for (const id of await listWorkflowIds(home)) {
        const draft = await readDraft(home, id);
        if (!draft) continue;
        const versions = await listVersions(home, id);
        out.push({
          id,
          name: draft.name,
          description: draft.description,
          published: versions.at(-1) ?? null,
          draftVersion: draft.version,
          updatedAt: await draftModified(home, id),
          runs: stats(id),
        });
      }
      return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    },

    async get({ id } = {}) {
      const draft = await needDraft(id);
      return { draft, versions: await listVersions(home, id), published: await readPublished(home, id) };
    },

    async create({ name, from } = {}) {
      if (typeof name !== "string" || !name.trim()) fail("name is required: what to call the new workflow.");
      let id;
      do id = newWorkflowId();
      while (await readDraft(home, id));
      let draft;
      if (from !== undefined && from !== null && from !== "") {
        const source = await needDraft(from);
        draft = normalise({ ...structuredClone(source), name: name.trim() }, { id, version: 1 });
      } else draft = blank(id, name.trim());
      await writeDraft(home, draft);
      broadcast({ ev: "workflow", id });
      log(`workflows: created ${id} (${draft.name})`);
      return draft;
    },

    async save({ id, definition } = {}) {
      const current = await needDraft(id);
      if (!isObject(definition)) fail("definition is required: the whole workflow definition as an object.");
      const draft = normalise(definition, { id, version: current.version });
      await writeDraft(home, draft);
      broadcast({ ev: "workflow", id });
      return { draft, validation: await check(draft) };
    },

    async publish({ id } = {}) {
      const draft = await needDraft(id);
      const validation = await check(draft);
      if (!validation.ok) fail(`This workflow cannot be published until its errors are fixed: ${firstError(validation)}`);
      const { version } = await publishDraft(home, draft);
      broadcast({ ev: "workflow", id });
      log(`workflows: published ${id} as version ${version}`);
      return { version, validation };
    },

    async remove({ id } = {}) {
      await needDraft(id);
      await removeWorkflow(home, id);
      // Runs are kept, but one that has not started, or waits for a person, cannot go on without its
      // definition, so it is ended now rather than failing later for a reason nobody asked about.
      for (const run of runs.values()) {
        if (run.workflow === id && (run.state === "queued" || run.state === "waiting")) {
          run.state = "cancelled";
          run.reason = "The workflow was removed.";
          run.updatedAt = new Date().toISOString();
          await persist(run);
        }
      }
      broadcast({ ev: "workflow", id });
      announceQueue();
      return {};
    },

    async validate({ definition } = {}) {
      if (!isObject(definition)) fail("definition is required: the workflow definition to check, as an object.");
      return check(normalise(definition));
    },

    async enqueue({ id, text } = {}) {
      wantWorkflowId(id);
      if (typeof text !== "string") fail("text is required: the input to run the workflow on.");
      const definition = await readPublished(home, id);
      if (!definition) {
        if (!(await readDraft(home, id))) fail(`There is no workflow ${id}.`);
        fail("This workflow has never been published. Publish it first; a run always uses a published version.");
      }
      const inputs = definition.input?.kind === "text" ? (text.trim() ? [text] : []) : text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!inputs.length) fail(definition.input?.kind === "text" ? "The input is empty; write what the run should work on." : "The input has no lines; each non-empty line queues one run.");
      if (inputs.length > MAX_ENQUEUE) fail(`That is ${inputs.length} runs at once; queue at most ${MAX_ENQUEUE} in one go.`);
      definitions.set(`${id}@${definition.version}`, definition);
      let number = [...runs.values()].filter((r) => r.workflow === id).reduce((n, r) => Math.max(n, r.number ?? 0), 0);
      const now = new Date().toISOString();
      const cap = positive(definition.costCapUsd, defaultCap);
      const made = [];
      for (const input of inputs) {
        let run;
        do run = newRun({ definition, input, number: ++number, costCapUsd: cap, now });
        while (runs.has(run.id));
        runs.set(run.id, run);
        await persist(run);
        made.push(withoutVars(run));
      }
      log(`workflows: queued ${made.length} run${made.length === 1 ? "" : "s"} of ${id} v${definition.version}`);
      announceQueue();
      pump();
      return { runs: made };
    },

    async runs({ workflow, limit } = {}) {
      if (workflow !== undefined && workflow !== null) wantWorkflowId(workflow);
      const n = limit === undefined || limit === null ? SNAPSHOT_RUNS : Math.floor(Number(limit));
      if (!Number.isFinite(n) || n < 1) fail("limit must be a number of runs, at least 1.");
      return [...runs.values()]
        .filter((r) => !workflow || r.workflow === workflow)
        .sort(newestFirst)
        .slice(0, Math.min(n, 1000))
        .map(withoutVars);
    },

    /** `{ "<conversation id>": "<title>" }` for every conversation a run opened with a title. */
    async titles() {
      const out = {};
      for (const r of runs.values()) Object.assign(out, r.titles ?? {});
      return out;
    },

    async run({ id } = {}) {
      return structuredClone(need(id));
    },

    async cancel({ id } = {}) {
      const run = need(id);
      if (!ACTIVE.includes(run.state)) fail(`Run ${id} has already ended (${run.state}); there is nothing to cancel.`);
      const slot = executing.get(id);
      if (slot) {
        slot.controller.abort();
        const current = run.history.at(-1);
        const conversation = current?.status === "running" ? current.conversation : null;
        if (conversation) await kernel.sessions.cancel(conversation).catch(() => {});
        await Promise.race([slot.done, sleep(CANCEL_WAIT_MS)]);
      }
      const now = new Date().toISOString();
      for (const e of run.history) {
        if (e.status === "running") {
          e.status = "failed";
          e.endedAt = now;
          e.note = "Cancelled.";
        }
      }
      run.state = "cancelled";
      run.reason = "Cancelled by you.";
      run.updatedAt = now;
      await persist(run);
      announceQueue();
      return structuredClone(run);
    },

    async retry({ id, from } = {}) {
      const run = need(id);
      if (from !== undefined && from !== null && !isStepId(from)) fail(`${JSON.stringify(from)} is not a step id.`);
      const definition = await definitionOf(run);
      if (!definition) fail(`Version ${run.version} of this workflow is gone, so the run cannot be retried.`);
      retry(run, definition, from ?? undefined);
      await persist(run);
      announceQueue();
      pump();
      return structuredClone(run);
    },

    async approve({ id, decision, note } = {}) {
      const run = need(id);
      if (decision !== "approved" && decision !== "rejected") fail('decision must be "approved" or "rejected".');
      if (note !== undefined && note !== null && typeof note !== "string") fail("note must be text.");
      const definition = await definitionOf(run);
      if (!definition) fail(`Version ${run.version} of this workflow is gone, so the run cannot go on.`);
      decide(run, definition, decision, note ?? "");
      await persist(run);
      announceQueue();
      pump();
      return structuredClone(run);
    },

    async queue({ paused } = {}) {
      if (paused !== undefined && paused !== null) {
        if (typeof paused !== "boolean") fail("paused must be true or false.");
        if (paused !== queue.paused) {
          queue = { paused };
          await writeQueue(home, queue);
          log(`workflows: queue ${paused ? "paused" : "resumed"}`);
          pump();
          announceQueue();
        }
      }
      return queueState();
    },

    async catalog() {
      await modelIds();
      const choices = models?.choices ?? { model: "", models: [] };
      const projects = [];
      for (const name of (await listDir(home, "projects")).sort()) {
        const m = /^(p_[0-9a-f]{8})\.json$/.exec(name);
        if (!m) continue;
        const record = await readJson(home, `projects/${name}`, null);
        if (record?.id === m[1]) projects.push({ id: m[1], name: typeof record.name === "string" ? record.name : m[1] });
      }
      let packages = [];
      try {
        packages = await kernel.packages.list();
      } catch (e) {
        log(`workflows: could not list packages: ${e?.message ?? e}`);
      }
      const tools = [];
      for (const p of packages ?? []) {
        for (const t of p?.thetis?.tools ?? []) {
          if (t && typeof t.name === "string") tools.push({ package: p.name, export: t.export ?? t.name, name: t.name, description: t.description ?? "" });
        }
      }
      return {
        models: (choices.models ?? []).filter((m) => typeof m?.id === "string").map((m) => (m.name ? { id: m.id, label: m.name } : { id: m.id })),
        defaultModel: choices.model ?? "",
        projects,
        tools,
      };
    },
  };

  return {
    ops,
    /** Loads the runs and starts the queue. The caller need not await it for anything but `ready`. */
    ready: null,
    start() {
      this.ready = load().catch((e) => log(`workflows: could not load runs: ${e?.stack ?? e}`));
      return this.ready;
    },
    /** The latest runs, without vars: what a subscription starts with. */
    snapshot: () => [...runs.values()].sort(newestFirst).slice(0, SNAPSHOT_RUNS).map(withoutVars),
    runs: () => [...runs.values()],
    executing: () => [...executing.keys()],
    /** Aborts every in-flight run without changing its state, so the next start resumes it. */
    async stop() {
      stopping = true;
      const slots = [...executing.values()];
      for (const s of slots) s.controller.abort();
      await Promise.race([Promise.all(slots.map((s) => s.done)), sleep(STOP_WAIT_MS)]);
      await flush().catch(() => {});
    },
  };
}

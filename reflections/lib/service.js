// The service: the queue that turns `queued` records into reflections, one at a time, in the person's
// own fence. The records are the queue, so there is no socket and nothing to keep in step: the archive
// hook and the place write a record, a watch on `reflections/` (and a sweep every half minute, for a
// watch that missed something) brings the service to it.
//
// On start a `running` record is one a stopped service left, and it goes back to `queued` to run again.
// Before each reflection the daily cap is checked against `reflections/spend.json`; a reflection a person
// asked for with Reflect is theirs and runs past it. A record that turns `cancelled`, or disappears, while
// its reflection runs stops it, and nothing it would have written is written.
import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readJson, remove, writeJson } from "./files.js";
import { reflect } from "./reflect.js";
import { DIR, INSTALLED, NAME, addSpend, readRecord, readRecords, readSpend, settingsOf, writeRecord } from "./records.js";

export const SWEEP_MS = 30_000;
const DEBOUNCE_MS = 200;
/** How long `stop` waits for the reflection in flight to let go. */
const STOP_WAIT_MS = 2000;

const money = (n) => `$${n.toFixed(2)}`;

/**
 * `env` is the `ServiceEnv`: `cwd` (the home), `kernel`, `config`, `log`. `opts.reflect` replaces the
 * reflection for a test; `opts.sweepMs` the safety sweep.
 */
export function createService(env, opts = {}) {
  const home = env.cwd;
  const kernel = env.kernel;
  const log = env.log ?? (() => {});
  const run = opts.reflect ?? reflect;
  const sweepMs = opts.sweepMs ?? SWEEP_MS;
  let current = null; // { session, startedAt, controller, done }
  let stopping = false;
  let watcher = null;
  let interval = null;
  let debounce = null;
  let pumping = null;

  /** The configuration as it is now: a change in the place reaches the next reflection without a restart. */
  async function settings() {
    try {
      return settingsOf(await kernel.config.effective(NAME));
    } catch {
      return settingsOf(env.config);
    }
  }

  async function wanted(session, startedAt) {
    const r = await readRecord(home, session);
    return !!r && r.state === "running" && r.startedAt === startedAt;
  }

  async function job(queuedRecord) {
    const s = queuedRecord.session;
    // Read again: a restore or a Cancel may have landed since the list was read, and it wins.
    const record = await readRecord(home, s);
    if (record?.state !== "queued") return;
    const config = await settings();
    if (!record.manual) {
      const spend = await readSpend(home);
      if (spend.usd >= config.dailyCostUsd) {
        await writeRecord(home, { ...record, state: "skipped", reason: "daily cost cap reached", detail: `${money(spend.usd)} spent today of the ${money(config.dailyCostUsd)} cap; press Reflect to run it anyway`, updatedAt: new Date().toISOString() });
        log(`reflections: ${s} skipped, the daily cap is reached`);
        return;
      }
    }
    const startedAt = new Date().toISOString();
    let running = { ...record, state: "running", startedAt, updatedAt: startedAt };
    delete running.error;
    delete running.reason;
    delete running.detail;
    await writeRecord(home, running);
    const controller = new AbortController();
    current = { session: s, startedAt, controller };
    log(`reflections: reflecting on ${s}`);
    try {
      const out = await run({ home, kernel }, config, running, {
        signal: controller.signal,
        stillWanted: () => wanted(s, startedAt),
        onModel: async (model) => {
          if (!(await wanted(s, startedAt))) return;
          running = { ...running, model };
          await writeRecord(home, running);
        },
      });
      if (out.costUsd !== undefined || out.model) await addSpend(home, out.costUsd);
      if (out.discarded) {
        log(`reflections: ${s} was cancelled or forgotten while it ran; its result is dropped`);
        return;
      }
      const { discarded, ...fields } = out;
      void discarded;
      await writeRecord(home, { ...running, ...fields, state: "done", finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      log(`reflections: ${s} done${fields.lesson ? `, lesson ${fields.lesson}` : ""}`);
    } catch (e) {
      if (e?.spent) await addSpend(home, e.spent.costUsd);
      // A stop leaves the record running, and the next start queues it again; a cancel already wrote its state.
      if (stopping) return;
      if (!(await wanted(s, startedAt))) {
        // Forgotten while it ran: the evidence exported before the call goes with the record.
        if (!(await readRecord(home, s))) await remove(home, `${DIR}/${s}`);
        return;
      }
      const now = new Date().toISOString();
      await writeRecord(home, { ...running, ...(e?.spent ?? {}), state: "failed", error: e?.message ?? String(e), finishedAt: now, updatedAt: now });
      log(`reflections: ${s} failed: ${e?.message ?? e}`);
    } finally {
      current = null;
    }
  }

  /** Runs queued records, oldest first, one at a time, until none is left. */
  function pump() {
    if (pumping || stopping) return pumping ?? Promise.resolve();
    pumping = (async () => {
      try {
        for (;;) {
          if (stopping) return;
          const next = (await readRecords(home)).filter((r) => r.state === "queued").sort((a, b) => String(a.queuedAt ?? a.updatedAt ?? "").localeCompare(String(b.queuedAt ?? b.updatedAt ?? "")))[0];
          if (!next) return;
          await job(next);
        }
      } catch (e) {
        log(`reflections: the queue stopped on an error: ${e?.stack ?? e}`);
      } finally {
        pumping = null;
      }
    })();
    return pumping;
  }

  /** Looks at the files again: a cancelled or forgotten running record stops its reflection, and queued ones start. */
  async function sweep() {
    if (stopping) return;
    if (current && !(await wanted(current.session, current.startedAt))) current.controller.abort();
    await pump();
  }

  function nudge() {
    clearTimeout(debounce);
    debounce = setTimeout(() => void sweep().catch((e) => log(`reflections: sweep failed: ${e?.message ?? e}`)), DEBOUNCE_MS);
    debounce.unref?.();
  }

  return {
    async start() {
      await mkdir(resolve(home, DIR), { recursive: true });
      if (!(await readJson(home, INSTALLED, null))) await writeJson(home, INSTALLED, { at: new Date().toISOString() });
      for (const r of await readRecords(home)) {
        if (r.state !== "running") continue;
        await writeRecord(home, { ...r, state: "queued", queuedAt: r.queuedAt ?? new Date().toISOString(), note: "queued again: the service stopped while it ran", updatedAt: new Date().toISOString() });
        log(`reflections: ${r.session} was running when the service stopped; queued again`);
      }
      try {
        watcher = watch(resolve(home, DIR), { persistent: false }, nudge);
        watcher.on("error", (e) => log(`reflections: the watch on ${DIR}/ failed (${e?.message ?? e}); the sweep goes on`));
      } catch (e) {
        log(`reflections: could not watch ${DIR}/ (${e?.message ?? e}); sweeping every ${sweepMs / 1000} s instead`);
      }
      interval = setInterval(nudge, sweepMs);
      interval.unref?.();
      void pump();
    },

    sweep,
    pump,
    /** Resolves once nothing is being reflected and nothing queued is waiting to start. */
    async idle() {
      while (pumping) await pumping;
    },

    async stop() {
      stopping = true;
      clearTimeout(debounce);
      clearInterval(interval);
      watcher?.close();
      current?.controller.abort();
      if (pumping) await Promise.race([pumping, new Promise((r) => setTimeout(r, STOP_WAIT_MS).unref?.())]);
    },
  };
}

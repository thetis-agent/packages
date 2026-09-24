/* The two UI verbs the manifest declares, as the views use them. `call(op, args)` answers the op's result
 * (the `data` of the gateway's answer) and throws the service's own sentence on a refusal. `createFeed`
 * keeps one `watch` subscription for the place: the latest runs (without `vars`), the queue, and a signal
 * when a definition changes. The stream ends on any failure without retrying by itself (ext.subscribe says
 * so), so the feed retries, says that it is doing so, and treats the next snapshot as the truth. */

export function createService(ext) {
  async function call(op, args = {}) {
    const out = await ext.request("call", { args: { op, ...args } });
    return out?.data;
  }

  function createFeed() {
    const runs = new Map();
    const listeners = new Set();
    let queue = null;
    let status = "connecting"; // connecting | live | lost
    let stop = null;
    let timer = null;
    let retries = 0;
    let closed = false;

    const emit = (change) => {
      for (const fn of listeners) {
        try {
          fn(change);
        } catch (err) {
          console.error("workflows: a feed listener threw", err);
        }
      }
    };

    function onEvent(event) {
      if (!event || typeof event !== "object") return;
      if (event.ev === "snapshot") {
        runs.clear();
        for (const r of event.runs ?? []) if (r?.id) runs.set(r.id, r);
        status = "live";
        retries = 0;
        emit({ kind: "snapshot" });
      } else if (event.ev === "run" && event.run?.id) {
        runs.set(event.run.id, { ...runs.get(event.run.id), ...event.run });
        emit({ kind: "run", run: event.run });
      } else if (event.ev === "forgotten" && event.id) {
        runs.delete(event.id);
        emit({ kind: "forgotten", id: event.id });
      } else if (event.ev === "workflow") {
        emit({ kind: "workflow", id: event.id });
      } else if (event.ev === "queue" && event.queue) {
        queue = event.queue;
        emit({ kind: "queue", queue });
      }
    }

    function open() {
      if (closed) return;
      status = "connecting";
      try {
        stop = ext.subscribe("watch", {
          onEvent,
          onClose: (err) => {
            stop = null;
            if (closed) return;
            status = "lost";
            emit({ kind: "status", error: err?.message ?? null });
            const wait = Math.min(15000, 1000 * 2 ** retries++);
            timer = setTimeout(open, wait);
          },
        });
      } catch (err) {
        status = "lost";
        emit({ kind: "status", error: err?.message ?? String(err) });
      }
    }

    return {
      start: open,
      close() {
        closed = true;
        clearTimeout(timer);
        stop?.();
        listeners.clear();
      },
      listen(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      /** Runs newest first. */
      runs: () => [...runs.values()].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))),
      run: (id) => runs.get(id) ?? null,
      get queue() {
        return queue;
      },
      set queue(q) {
        queue = q;
      },
      get status() {
        return status;
      },
    };
  }

  return { call, createFeed };
}

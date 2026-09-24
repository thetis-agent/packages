// A fake fence for the engine and the service: a temporary home with readFile/writeFile relative to it,
// an invokeTool that answers from a table, and a kernel whose conversations answer from a script.
//
// The script is `(call) => steps`, where `call` is `{ session, input, model, n }` (n counts every send)
// and each step is a turn event to emit, `{ hang: true }` (wait until the turn is cancelled or aborted),
// or `{ throw: "message" }`. A cancelled hang ends the way the kernel's does: an `error` event with code
// `cancelled`, and the send resolves.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

export const text = (t) => [{ type: "text", data: { text: t } }];

/** One model call's worth of events: its usage, then the assistant message carrying the same usage. */
export function reply(t, usage = { prompt_tokens: 1000, completion_tokens: 50, cost: 0.1 }) {
  return [
    { type: "usage", usage },
    { type: "message", message: { role: "assistant", content: text(t) }, usage },
  ];
}

export const toolCall = (name, args = {}) => ({ type: "tool.call", call: { id: `c_${Math.random().toString(16).slice(2, 8)}`, name, args } });

export function fakeKernel(script = () => reply("ok"), { models = ["fable", "opus", "sonnet"], packages = [] } = {}) {
  const sessions = new Map();
  const sends = [];
  const cancels = [];
  const hanging = new Map(); // session -> resolve
  let n = 0;
  let ids = 0;

  const kernel = {
    sends,
    cancels,
    sessions: {
      async create() {
        const id = `s_${(++ids).toString(16).padStart(6, "0")}`;
        sessions.set(id, { id, user: "alice", conversation: [], status: "idle" });
        return { id, user: "alice" };
      },
      async send(session, input, onEvent, opts = {}, signal) {
        const rec = sessions.get(session);
        if (!rec) throw new Error(`no session ${session}`);
        const call = { session, input, model: opts.model, n: n++ };
        sends.push(call);
        rec.conversation.push({ role: "user", content: text(String(input)) });
        rec.status = "running";
        try {
          for (const step of script(call) ?? []) {
            if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
            if (step.hang) {
              const how = await new Promise((done) => {
                hanging.set(session, done);
                signal?.addEventListener("abort", () => done("abort"), { once: true });
              });
              hanging.delete(session);
              if (how === "abort") throw Object.assign(new Error("the turn was cancelled"), { code: "cancelled" });
              onEvent({ type: "error", message: "the turn was cancelled", code: "cancelled" });
              return;
            }
            if (step.throw) throw new Error(step.throw);
            await new Promise((r) => setImmediate(r));
            if (step.type === "message") rec.conversation.push(step.message);
            onEvent(step);
          }
        } finally {
          rec.status = "idle";
        }
      },
      async cancel(session) {
        cancels.push(session);
        const done = hanging.get(session);
        if (done) done("cancel");
        return !!done;
      },
      async inspect(session) {
        const rec = sessions.get(session);
        if (!rec) throw new Error(`no session ${session}`);
        return structuredClone(rec);
      },
      async list() {
        return [...sessions.values()];
      },
      _set(id, rec) {
        sessions.set(id, { id, user: "alice", status: "idle", ...rec });
      },
    },
    async models() {
      return { model: models[0], models: models.map((id) => ({ id, name: id.toUpperCase() })) };
    },
    packages: { list: async () => packages },
    config: { effective: async (name) => ({ package: name }) },
  };
  return kernel;
}

export async function makeEnv({ kernel = fakeKernel(), tools = {} } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), "workflows-home-"));
  const invoked = [];
  const env = {
    cwd: home,
    root: home,
    store: home,
    shared: home,
    readFile: (p) => readFile(resolve(home, p), "utf8"),
    writeFile: async (p, content) => {
      const file = resolve(home, p);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    async invokeTool(ref, args, opts) {
      invoked.push({ ref, args, opts });
      const fn = tools[ref.name];
      if (!fn) throw new Error(`unknown tool: ${ref.name}`);
      return fn(args, opts);
    },
    kernel,
    config: {},
    log: () => {},
  };
  return { home, env, kernel, invoked, done: () => rm(home, { recursive: true, force: true }) };
}

/** Waits until `fn()` is truthy, or fails after `ms`. */
export async function until(fn, ms = 3000, what = "the condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

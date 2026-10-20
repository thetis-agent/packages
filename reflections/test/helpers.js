// A fake fence for the tests: a temporary home and a kernel whose conversations, models, configuration
// and one provider answer from tables. No network, no daemon: `providers.call` plays a script.
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

/** A good answer: two rows and a lesson resting on a row that helped. */
export const GOOD_ANSWER = `<rows>
row: 1
approach: Edited the generated file dist/app.js directly.
observed: The build overwrote the edit [4] and the person said it was gone [5].
verdict: hurt
row: 2
approach: Found the generator in src/ and changed the source.
observed: The change survived the next build [8] and the person confirmed it [9].
verdict: helped
</rows>

<lesson>
cue: a file you are about to edit is produced by a build or a generator
lesson: Before editing a generated file, find its generator and change the source instead
evidence: rows 1, 2; [4], [5], [8], [9]
confidence: medium, one conversation but a clear before and after
facts:
- in this workspace, dist/ is rebuilt from src/ by npm run build [8]
</lesson>`;

/**
 * The fake kernel. `sessions` is `[{ summary, record }]`; `script(request, n)` answers the events of one
 * provider call (`{ hang: true }` waits for the abort). `config` is the effective configuration.
 */
export function fakeKernel({ sessions = [], script = () => [{ type: "text", delta: GOOD_ANSWER }, { type: "usage", usage: { prompt_tokens: 1000, completion_tokens: 200, cost: 0.04 } }], models = ["fable", "opus"], config = {} } = {}) {
  const calls = [];
  const sets = [];
  const byId = new Map(sessions.map((s) => [s.summary.id, s]));
  const kernel = {
    calls,
    sets,
    config: {
      effective: async () => ({ ...config }),
      set: async (name, key, value) => {
        sets.push({ name, key, value });
        config[key] = value;
        return {};
      },
      unset: async (name, key) => {
        sets.push({ name, key, value: undefined });
        delete config[key];
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

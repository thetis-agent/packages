// Fixtures: a temporary home with a fake fence environment, skills written from parts, a deterministic fake
// embeddings endpoint, and a corpus whose digest looks like a real one so the vector file can be named after it.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

export function home(prefix = "skills-hybrid-") {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  const env = {
    cwd: dir,
    async readFile(p) {
      try {
        return readFileSync(resolve(dir, p), "utf8");
      } catch (e) {
        throw Object.assign(new Error(p), { code: e.code });
      }
    },
    async writeFile(p, c) {
      mkdirSync(dirname(resolve(dir, p)), { recursive: true });
      writeFileSync(resolve(dir, p), c);
    },
  };
  const skill = (id, description, body = `Body of ${id}.\n`, meta = []) => {
    mkdirSync(resolve(dir, "skills", id), { recursive: true });
    writeFileSync(resolve(dir, "skills", id, "SKILL.md"), `---\nname: ${id.split("/").pop()}\ndescription: ${description}\n${meta.length ? `metadata:\n${meta.map((m) => `  ${m}`).join("\n")}\n` : ""}---\n${body}`);
  };
  return { dir, env, skill, rm: () => rmSync(dir, { recursive: true, force: true }) };
}

export const session = { id: "s-1", user: "alice" };

export const ctxOf = (env, extra = {}) => ({
  session,
  env,
  packages: { list: () => [] },
  call: { model: "m", system: "BASE", messages: [], tools: [], params: {} },
  harness: {},
  config: {},
  conversation: [{ role: "user", content: "install a package" }],
  ...extra,
});

export const toolEnv = (env, extra = {}) => ({ ...env, session, config: {}, kernel: { packages: { list: async () => [] } }, ...extra });

/** A fake embedding: 8 numbers from the text's tokens, so related texts are near and the answer never changes. */
export function fakeVector(text) {
  const v = new Array(8).fill(0);
  for (const w of String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const h = createHash("sha256").update(w).digest();
    for (let i = 0; i < 8; i++) v[i] += (h[i] / 255) * 2 - 1;
  }
  return v.map((x) => Math.round(x * 1e6) / 1e6);
}

/** A fetch that answers like an embeddings endpoint, recording every request; `fail` makes it refuse. */
export function fakeFetch({ fail } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    if (fail) return { ok: false, status: 503, text: async () => "down" };
    return { ok: true, status: 200, json: async () => ({ data: body.input.map((t, index) => ({ index, embedding: fakeVector(t) })) }) };
  };
  fn.calls = calls;
  return fn;
}

/** Stubs `globalThis.fetch` for the duration of `run`. */
export async function withFetch(fn, run) {
  const prev = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await run();
  } finally {
    globalThis.fetch = prev;
  }
}

/** A corpus whose records are ordinary skills and whose sha256 has the real shape. */
export function corpus() {
  const record = (id, description, tags = []) => ({
    id,
    name: id.split(".").pop(),
    description,
    tags,
    canary: `⟦c:${id.split(".").pop()}⟧`,
    body: `---\nname: ${id.split(".").pop()}\ndescription: ${description}\n---\n⟦c:${id.split(".").pop()}⟧\nBody of ${id}.\n`,
  });
  const records = [
    record("cap.a.install", "Installs a package. Use when asked to install.", ["packages"]),
    record("cap.a.fork", "Forks a package. Use when a fork is wanted.", ["packages"]),
    record("cap.b.projects", "Creates a project workspace. Use when a project is mentioned.", ["projects"]),
    record("cap.b.concise", "Short answers. Use always.", []),
  ];
  const sha256 = `sha256:${createHash("sha256").update(JSON.stringify(records)).digest("hex")}`;
  return { id: "caps@t", version: "1", sha256, records };
}

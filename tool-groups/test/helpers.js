// Fixtures: a temporary home with a fake fence environment and an in-memory storage, package infos built from
// parts, a deterministic fake embeddings endpoint, and the predecessor's routing table as packages.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

export const session = { id: "s-1", user: "alice" };

export function home(prefix = "tool-groups-") {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  const docs = new Map();
  const env = {
    cwd: dir,
    session,
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
    storage(namespace) {
      const key = (k) => `${namespace}/${k}`;
      return {
        get: async (k) => (docs.has(key(k)) ? structuredClone(docs.get(key(k))) : undefined),
        set: async (k, doc) => void docs.set(key(k), structuredClone(doc)),
        delete: async (k) => void docs.delete(key(k)),
        list: async () => [...docs.keys()],
        clear: async () => docs.clear(),
      };
    },
  };
  const skill = (id, description, tags = []) => {
    mkdirSync(resolve(dir, "skills", id), { recursive: true });
    writeFileSync(resolve(dir, "skills", id, "SKILL.md"), `---\nname: ${id.split("/").pop()}\ndescription: ${description}\n${tags.length ? `metadata:\n  tags: [${tags.join(", ")}]\n` : ""}---\nBody of ${id}.\n`);
  };
  return { dir, env, docs, skill, rm: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A PackageInfo from parts. `tools` are names, or `{ name, description, group }`. */
export function pkg(name, tools, { description = `The ${name} package.`, everyone = false, toolGroup } = {}) {
  return {
    name,
    version: "1.0.0",
    type: "tool",
    description,
    root: "",
    everyone,
    thetis: {
      type: "tool",
      ...(toolGroup ? { toolGroup } : {}),
      tools: tools.map((t) => (typeof t === "string" ? { name: t, description: `${t} does its thing.`, export: "run" } : { export: "run", description: `${t.name} does its thing.`, ...t })),
    },
  };
}

/** The predecessor's table, as it would arrive from ctx.packages: files and the search tool are core, the rest is routable. */
export function table() {
  const g = (id, brief, tags, tools, extra = {}) => pkg(`@bench/tg-${id}`, tools, { description: brief, toolGroup: { id, brief, tags, ...extra } });
  return [
    pkg("@thetis/tool-groups", ["tool_search"], { description: "Scopes the tool list." }),
    g("files", "Reading, searching, writing and deleting files on the host.", ["file", "files", "read", "write", "edit", "search", "grep", "directory", "path", "code", "source"], ["read_path", "edit_path", "search_files", "find_files", "write_path", "list_path", "delete_path"], { alwaysOn: true }),
    g("shell", "Terminal sessions for builds, tests, git and long-running processes.", ["run", "build", "test", "tests", "compile", "command", "shell", "terminal", "bash", "process", "script", "cargo", "npm", "python", "git", "clone", "install", "deploy"], ["terminal_open", "terminal_run", "git_clone"]),
    g("ssh", "The named ssh host registry, for shell sessions on other machines.", ["ssh", "remote", "host", "hosts", "machine", "server", "box"], ["ssh_host_list", "ssh_host_set"]),
    g("selfmod", "The dev kit: editing and rebuilding your own loop, gateways and tools.", ["yourself", "loop", "gateway", "devkit", "component", "wasm", "rebuild", "recompile", "dependency", "crate", "restart", "scaffold"], ["new_tool", "write_code", "restart_orchestrator"]),
    g("branch", "This conversation's sandbox branch: status, history, trunk merges, rollback.", ["branch", "trunk", "merge", "commit", "rollback", "revert", "reset", "conflict"], ["branch_status", "update_from_trunk"]),
    g("subagents", "Spawning sub-agents, inspecting them and cancelling them.", ["subagent", "subagents", "delegate", "delegation", "spawn", "concurrently", "parallel", "parallelise", "parallelize", "fan-out", "background"], ["spawn_agent", "agent_status"]),
    g("bigquery", "BigQuery: listing, describing, profiling, querying and costing tables.", ["bigquery", "bq", "sql", "dataset", "warehouse", "gcp", "partition", "analytics"], ["bq_query", "bq_list_tables"]),
    g("notion", "Notion: pages, databases, comments and users in a workspace.", ["notion", "wiki"], ["notion_search", "notion_update_page"]),
    g("web", "Web search, page fetching and cited summarisation.", ["web", "internet", "online", "arxiv", "paper", "papers", "research", "url", "link", "article", "news", "blog", "google"], ["web_search", "web_fetch"]),
    g("moo", "Torchship mooR: inspect and modify the live world through its web-host API.", ["moo", "moor", "torchship", "object", "verb", "objdef"], ["moo_eval", "moo_get_object"]),
  ];
}

export const ctxOf = (env, extra = {}) => ({
  session,
  env,
  packages: { list: () => table() },
  call: { model: "m", system: "BASE", messages: [], tools: [], params: {} },
  harness: {},
  config: {},
  conversation: [{ role: "user", content: "hi" }],
  ...extra,
});

/** A call with every tool of every package attached, as attachTools leaves it. */
export const attached = (packages) => packages.flatMap((p) => p.thetis.tools.map((t) => ({ name: t.name, description: t.description, parameters: {}, package: p.name, export: t.export })));

export const toolEnv = (env, packages = table(), extra = {}) => ({ ...env, session, config: {}, kernel: { packages: { list: async () => packages } }, ...extra });

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

export const noNetwork = async () => {
  throw new Error("the network was touched");
};

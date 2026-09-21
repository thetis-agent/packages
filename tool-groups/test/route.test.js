// The routing: the predecessor's scenarios, always-on survival, the pin across turns, a package installed
// mid-conversation, skill edges, the dense fallback and its absence, the prompt section's bytes, the scoping
// step, and a stray call admitting its group.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearCache, STATE as SKILLS_STATE } from "@thetis/skills";
import { route, scope, STATE } from "../index.js";
import { deriveGroups, routable } from "../lib/groups.js";
import { routeOnce, section, strayCalls, HEADING, INTRO } from "../lib/route.js";
import { CACHE_PATH } from "../lib/dense.js";
import { home, ctxOf, table, pkg, attached, fakeFetch, fakeVector, noNetwork } from "./helpers.js";

const withKey = { embeddings: { apiKey: "test-key", model: "fake", dimensions: 8 } };
const groupsOf = () => deriveGroups(table()).groups;

/** A fetch stub for the whole call, since the step reads globalThis.fetch. */
async function withFetch(fn, run) {
  const prev = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await run();
  } finally {
    globalThis.fetch = prev;
  }
}

test("the predecessor's routing scenarios: must-include and must-exclude sets, and the always-on floor in every route", async () => {
  const groups = groupsOf();
  const scenarios = [
    ["Refactor the parser in src/lib.rs and run the tests", ["files", "shell"], ["notion", "bigquery", "ssh"]],
    ["How many rows are in the events table? Query BigQuery.", ["bigquery"], ["notion", "ssh", "selfmod"]],
    ["Update the status of the launch page in Notion", ["notion"], ["bigquery", "ssh"]],
    ["Add a new tool to your own loop and rebuild it", ["selfmod"], ["notion", "bigquery"]],
    ["Is there arxiv research on tool retrieval?", ["web"], ["notion", "ssh"]],
    ["Merge trunk into this branch and resolve the conflicts", ["branch"], ["notion", "bigquery"]],
    ["Open a shell on the build-box host over ssh", ["ssh", "shell"], ["notion", "bigquery"]],
    ["hi", ["tool-groups", "files"], ["notion", "bigquery"]],
  ];
  for (const [query, must, mustNot] of scenarios) {
    const { active, why } = await routeOnce({ groups, query, config: { denseMode: "off" } });
    for (const id of must) assert.ok(active.includes(id), `${query}: ${id} missing from ${active}`);
    for (const id of mustNot) assert.ok(!active.includes(id), `${query}: ${id} leaked into ${active}`);
    assert.ok(active.includes("tool-groups") && active.includes("files"), "always-on groups survive every route");
    assert.equal(why["tool-groups"], "always-on");
    assert.equal(why.files, "always-on");
  }
  const routed = await routeOnce({ groups, query: "spawn a subagent to read the logs", config: { denseMode: "off" } });
  assert.equal(routed.why.subagents, "tag");
  assert.equal(routed.mode, "lexical");
  assert.deepEqual(routed.ranked, [{ id: "subagents", score: 2 / 3 }, { id: "files", score: 0.5 }].filter((h) => h.id !== "files"));
  const configured = await routeOnce({ groups: deriveGroups(table(), { alwaysOn: ["moo"] }).groups, query: "hi", config: { denseMode: "off" } });
  assert.equal(configured.why.moo, "configured");
  const edge = await routeOnce({ groups, query: "hi", skillIds: ["web", "nonsense"], config: { denseMode: "off" } });
  assert.equal(edge.why.web, "skill");
  assert.ok(!("nonsense" in edge.why));
});

test("the pin is routed on the first turn, read back on every later turn, and grows only by evidence", async () => {
  const h = home();
  try {
    const first = await withFetch(noNetwork, () => route(ctxOf(h.env, { config: { denseMode: "off" }, conversation: [{ role: "user", content: "run the tests and tell me what fails\n\n[Turn context: Monday 2026-09-21 20:40 UTC]" }] })));
    const state = first.harness[STATE];
    assert.deepEqual(state.active, ["tool-groups", "files", "shell"]);
    assert.deepEqual(state.why, { "tool-groups": "always-on", files: "always-on", shell: "tag" });
    assert.equal(state.mode, "lexical");
    assert.deepEqual(state.notes, []);
    assert.equal(state.catalogue.length, groupsOf().length);
    assert.ok(state.catalogue.find((c) => c.id === "shell").tools.includes("terminal_run"));
    assert.equal(first.call.system, `BASE\n\n${section(groupsOf(), state.active)}`);
    assert.ok(first.call.system.includes("- `shell` [loaded] — Terminal sessions"));
    assert.ok(first.call.system.includes("- `web` [available] — Web search"));
    assert.ok(!first.call.system.includes("`files`"), "always-on groups are not listed");
    assert.ok(!first.call.system.includes("Turn context"));
    assert.deepEqual(h.docs.get("sessions/s-1"), { active: state.active, loaded: {} }, "the active set is written for tool_search to read");

    // A later turn about something else: the same pin, the same bytes, no network.
    const later = ctxOf(h.env, { config: { denseMode: "off" }, harness: first.harness, conversation: [{ role: "user", content: "run the tests" }, { role: "assistant", content: "ok" }, { role: "user", content: "now update the launch page in Notion" }] });
    const second = await withFetch(noNetwork, () => route(later));
    assert.deepEqual(second.harness[STATE].active, state.active);
    assert.equal(second.call.system, first.call.system);
    assert.equal(second.harness[STATE].mode, "lexical");

    // A package installed mid-conversation appears as available; the active set does not move.
    const more = [...table(), pkg("@alice/miro", ["miro_list_boards"], { description: "Miro boards." })];
    const third = await withFetch(noNetwork, () => route({ ...later, harness: second.harness, packages: { list: () => more } }));
    assert.deepEqual(third.harness[STATE].active, state.active);
    assert.ok(third.harness[STATE].catalogue.some((c) => c.id === "miro" && c.alwaysOn === false));
    assert.ok(third.call.system.endsWith("- `miro` [available] — Miro boards."));

    // A group that vanished is dropped with a note; the always-on ones are forced back in whatever the pin says.
    const fewer = table().filter((p) => !p.name.endsWith("tg-shell"));
    const fourth = await withFetch(noNetwork, () => route({ ...later, harness: { [STATE]: { active: ["shell"], why: { shell: "tag" } } }, packages: { list: () => fewer } }));
    assert.deepEqual(fourth.harness[STATE].active, ["tool-groups", "files"]);
    assert.deepEqual(fourth.harness[STATE].notes, ["tool group shell is no longer installed; dropped from the pin"]);
    assert.deepEqual(fourth.harness[STATE].why, { "tool-groups": "always-on", files: "always-on" });
  } finally {
    h.rm();
  }
});

test("a pinned or universal skill tagged tool-group:<id> admits the group, and the skills loader may be absent", async () => {
  const h = home();
  try {
    clearCache();
    h.skill("torchship", "Building on Torchship. Use when the world is mentioned.", ["moo", "tool-group:moo"]);
    h.skill("research", "Reading papers. Use when research is wanted.", ["tool-group:web", "tool-group:nonsense"]);
    const harness = { [SKILLS_STATE]: { loader: "@thetis/skills-hybrid", universal: ["torchship"], pinned: [{ id: "research" }] } };
    const out = await withFetch(noNetwork, () => route(ctxOf(h.env, { harness, config: { denseMode: "off" }, conversation: [{ role: "user", content: "hello there" }] })));
    assert.deepEqual(out.harness[STATE].active, ["tool-groups", "files", "web", "moo"]);
    assert.equal(out.harness[STATE].why.moo, "skill");
    assert.equal(out.harness[STATE].why.web, "skill");
    assert.deepEqual(out.harness[STATE].notes, ["skill research points at unknown tool group nonsense"]);
    assert.equal(out.harness[SKILLS_STATE], harness[SKILLS_STATE], "the skills state is untouched");
    const none = await withFetch(noNetwork, () => route(ctxOf(h.env, { config: { denseMode: "off" }, conversation: [{ role: "user", content: "hello there" }] })));
    assert.deepEqual(none.harness[STATE].active, ["tool-groups", "files"]);
  } finally {
    h.rm();
  }
});

test("the dense fallback: with a key and no tag match, the top denseFallback groups by cosine; without a key, lexical with a note", async () => {
  const h = home();
  try {
    const query = "Describe the room the player is standing in and change its exit";
    const fetch = fakeFetch();
    const out = await withFetch(fetch, () => route(ctxOf(h.env, { config: withKey, conversation: [{ role: "user", content: query }] })));
    const state = out.harness[STATE];
    assert.equal(state.mode, "fallback");
    const dense = state.active.filter((id) => state.why[id] === "dense");
    assert.equal(dense.length, 2, `two groups admitted densely: ${JSON.stringify(state.why)}`);
    assert.deepEqual(state.notes, []);
    assert.equal(fetch.calls.length, 2, "one batch for the groups, one for the query");
    assert.equal(fetch.calls[0].headers.Authorization, "Bearer test-key");
    assert.equal(fetch.calls[0].body.input.length, routable(groupsOf()).length, "only routable groups are embedded");
    assert.ok(fetch.calls[0].body.input[0].includes("terminal open"), "tool names are split on underscores");
    assert.deepEqual(fetch.calls[1].body.input, [query], "the query is embedded and never cached");
    const cached = JSON.parse(await h.env.readFile(CACHE_PATH));
    assert.equal(Object.keys(cached).length, routable(groupsOf()).length);
    assert.ok(Object.keys(cached).every((k) => k.startsWith("fake|8|")));
    // The ranking is what the vectors say.
    const expected = routable(groupsOf()).map((g) => ({ id: g.id, score: cos(fakeVector(query), fakeVector(fetch.calls[0].body.input[routable(groupsOf()).findIndex((x) => x.id === g.id)])) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    assert.deepEqual(dense, expected.slice(0, 2).map((x) => x.id));

    // A tag match means no dense call at all in fallback mode.
    const again = fakeFetch();
    const tagged = await withFetch(again, () => route(ctxOf(h.env, { config: withKey, conversation: [{ role: "user", content: "run the tests" }] })));
    assert.equal(tagged.harness[STATE].mode, "lexical");
    assert.equal(again.calls.length, 0);

    // Without a key: lexical, nothing touches the network, one note says why.
    const lexical = await withFetch(noNetwork, () => route(ctxOf(h.env, { config: { embeddings: { apiKey: "${OPENROUTER_API_KEY}" } }, conversation: [{ role: "user", content: query }] })));
    assert.deepEqual(lexical.harness[STATE].active, ["tool-groups", "files"]);
    assert.deepEqual(lexical.harness[STATE].notes, ["no embeddings key: the dense fallback is skipped, routing is lexical"]);
    assert.ok(!JSON.stringify(lexical.harness).includes("OPENROUTER"));
    // A refused request: the same fallback with a different note.
    const refused = await withFetch(fakeFetch({ fail: true }), () => route(ctxOf({ ...h.env, readFile: async (p) => (p === CACHE_PATH ? "{}" : h.env.readFile(p)) }, { config: withKey, conversation: [{ role: "user", content: query }] })));
    assert.equal(refused.harness[STATE].mode, "lexical");
    assert.match(refused.harness[STATE].notes[0], /embeddings unavailable \(embeddings 503: down\); routing is lexical/);
    assert.ok(!refused.harness[STATE].notes[0].includes("test-key"));
    // denseFallback 0 turns it off.
    const off = fakeFetch();
    const zero = await withFetch(off, () => route(ctxOf(h.env, { config: { ...withKey, denseFallback: 0 }, conversation: [{ role: "user", content: query }] })));
    assert.equal(off.calls.length, 0);
    assert.deepEqual(zero.harness[STATE].active, ["tool-groups", "files"]);
  } finally {
    h.rm();
  }
});

test("fusion mode fuses the lexical and dense lists and admits the top denseFallback whatever the tags said", async () => {
  const h = home();
  try {
    const out = await withFetch(fakeFetch(), () => route(ctxOf(h.env, { config: { ...withKey, denseMode: "fusion", denseFallback: 3 }, conversation: [{ role: "user", content: "run the tests on the remote host" }] })));
    const state = out.harness[STATE];
    assert.equal(state.mode, "fusion");
    assert.ok(state.active.includes("shell") && state.active.includes("ssh"));
    assert.equal(state.why.shell, "tag");
    assert.equal(state.why.ssh, "tag");
    assert.equal(Object.values(state.why).filter((r) => r === "fusion").length, 1, `three fused, two of them already by tag: ${JSON.stringify(state.why)}`);
    assert.ok(state.ranked.length >= 3);
  } finally {
    h.rm();
  }
});

test("the prompt section has the predecessor's wording and is byte-stable; listAlwaysOn lists the core too; nothing routable means no section", () => {
  const groups = groupsOf();
  const text = section(groups, ["tool-groups", "files", "web"]);
  assert.ok(text.startsWith(`${HEADING}\n${INTRO}\n\n- \`shell\` [available] — `));
  assert.equal(HEADING, "# Tool groups");
  assert.equal(INTRO, "Your tool list is scoped to what this conversation looks like it needs, so a tool you have may not be in it right now. Call tool_search the moment you suspect a tool exists but cannot see it; do not work around the gap. Nothing is ever unloaded.");
  assert.equal(text, section(groups, ["files", "web", "tool-groups"]));
  assert.ok(text.includes("- `web` [loaded] — Web search, page fetching and cited summarisation."));
  assert.ok(!text.includes("`files`"));
  assert.ok(section(groups, ["files"], { listAlwaysOn: true }).includes("- `files` [loaded] — Reading, searching"));
  assert.equal(section(deriveGroups([pkg("@thetis/tool-groups", ["tool_search"])]).groups, ["tool-groups"]), "");
});

test("the scoping step keeps the tools of active groups in attach order, never drops tool_search, names the rest as withheld, and leaves a project's switch-off alone", async () => {
  const h = home();
  try {
    const tools = attached(table());
    const pin = { active: ["tool-groups", "files", "web"], why: {} };
    const out = await scope(ctxOf(h.env, { harness: { [STATE]: pin }, call: { model: "m", messages: [], tools, params: {}, hints: { cache: { x: 1 } } } }));
    assert.deepEqual(out.call.tools.map((t) => t.name), ["tool_search", "read_path", "edit_path", "search_files", "find_files", "write_path", "list_path", "delete_path", "web_search", "web_fetch"]);
    assert.deepEqual(out.call.hints.cache, { x: 1 });
    assert.deepEqual(out.call.hints.withheld, tools.map((t) => t.name).filter((n) => !out.call.tools.some((t) => t.name === n)));
    assert.ok(out.call.hints.withheld.includes("terminal_run") && !out.call.hints.withheld.includes("tool_search"));
    // A tool no group knows (attached by a step, not declared by a package) is kept.
    const stray = await scope(ctxOf(h.env, { harness: { [STATE]: pin }, call: { model: "m", messages: [], tools: [...tools, { name: "synthetic", description: "", parameters: {}, package: "@x/y", export: "z" }], params: {} } }));
    assert.ok(stray.call.tools.some((t) => t.name === "synthetic"));
    // Without a pin, or with nothing routable, the step does nothing.
    assert.equal(await scope(ctxOf(h.env, { call: { model: "m", messages: [], tools, params: {} } })), undefined);
    assert.equal(await scope(ctxOf(h.env, { harness: { [STATE]: pin }, packages: { list: () => [pkg("@thetis/tool-groups", ["tool_search"])] }, call: { model: "m", messages: [], tools: tools.slice(0, 1), params: {} } })), undefined);
    // Everything active: nothing to do, no hints written.
    const all = await scope(ctxOf(h.env, { harness: { [STATE]: { active: groupsOf().map((g) => g.id) } }, call: { model: "m", messages: [], tools, params: {} } }));
    assert.equal(all, undefined);
    // The project switched terminal_run off (the projects step removes it); it is not offered back through withheld.
    await h.env.writeFile("projects/sessions.json", JSON.stringify({ "s-1": "p_00000001" }));
    await h.env.writeFile("projects/p_00000001.json", JSON.stringify({ id: "p_00000001", tools: { disable: ["terminal_run"] } }));
    const project = await scope(ctxOf(h.env, { harness: { [STATE]: pin }, call: { model: "m", messages: [], tools, params: {} } }));
    assert.ok(!project.call.hints.withheld.includes("terminal_run"));
    assert.ok(project.call.hints.withheld.includes("terminal_open"));
  } finally {
    h.rm();
  }
});

test("a call to a withheld tool admits its group on the next turn, with the reason call", async () => {
  const h = home();
  try {
    const { groups, byTool } = deriveGroups(table());
    const conversation = [{ role: "user", content: "hi" }, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "bq_query", args: {} }] }, { role: "tool", content: "ok", toolCallId: "c1", name: "bq_query" }, { role: "tool", content: "error: unknown tool: zzz", toolCallId: "c2", name: "zzz" }];
    assert.deepEqual(strayCalls(conversation, byTool, groups, ["tool-groups", "files"]), ["bigquery"]);
    assert.deepEqual(strayCalls(conversation, byTool, groups, ["tool-groups", "files", "bigquery"]), []);
    const first = await withFetch(noNetwork, () => route(ctxOf(h.env, { config: { denseMode: "off" } })));
    const next = await withFetch(noNetwork, () => route(ctxOf(h.env, { config: { denseMode: "off" }, harness: first.harness, conversation })));
    assert.deepEqual(next.harness[STATE].active, ["tool-groups", "files", "bigquery"]);
    assert.equal(next.harness[STATE].why.bigquery, "call");
    assert.ok(next.call.system.includes("- `bigquery` [loaded]"));
  } finally {
    h.rm();
  }
});

function cos(a, b) {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) (d += a[i] * b[i]), (na += a[i] * a[i]), (nb += b[i] * b[i]);
  return Math.round((d / Math.sqrt(na * nb)) * 1e6) / 1e6;
}

test("a group without a vector is left out of the dense list rather than sinking it: the rest are ranked and a note says so", async () => {
  const h = home();
  try {
    // A cache with vectors for every routable group but one, and no key: the query comes from a bench file.
    const fetch = fakeFetch();
    const query = "Describe the room the player is standing in and change its exit";
    await withFetch(fetch, () => route(ctxOf(h.env, { config: withKey, conversation: [{ role: "user", content: query }] })));
    const cache = JSON.parse(await h.env.readFile(CACHE_PATH));
    const { groups } = deriveGroups(table());
    const moo = groups.find((g) => g.id === "moo");
    const { contentHashOf } = await import("../lib/dense.js");
    delete cache[`fake|8|${contentHashOf(moo)}`];
    await h.env.writeFile(CACHE_PATH, JSON.stringify(cache));
    const { denseRank } = await import("../lib/dense.js");
    const out = await denseRank({ ...h.env, readFile: async (p) => (p === "bench/corpus.json" ? JSON.stringify({ sha256: "sha256:" + "0".repeat(64) }) : h.env.readFile(p)) }, routable(groups), query, { embeddings: { model: "fake", dimensions: 8 } }, { fetch: noNetwork, vectorsDir: await benchDir(query) });
    assert.ok(out.hits, "the groups with a vector are ranked");
    assert.ok(!out.hits.some((hit) => hit.id === "moo"));
    assert.equal(out.hits.length, routable(groups).length - 1);
    assert.equal(out.note, `no embeddings key: 1 of ${routable(groups).length} groups have no vector and are not ranked densely`);
  } finally {
    h.rm();
  }
});

/** A vectors directory holding a bench file for the all-zero digest with this one query's vector. */
async function benchDir(query) {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const { queryHashOf, clearVectorCache } = await import("@thetis/skills");
  clearVectorCache();
  const dir = `${mkdtempSync(resolve(tmpdir(), "tg-vectors-"))}/`;
  writeFileSync(`${dir}${"0".repeat(64)}.json`, JSON.stringify({ model: "fake", dimensions: 8, vectors: {}, queries: { [queryHashOf(query)]: fakeVector(query) } }));
  return dir;
}

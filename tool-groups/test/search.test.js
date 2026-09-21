// tool_search: the catalogue, loading by query and by id, the refusal of an unknown id, persistence through
// storage into the next turn's pin, and the dense ranking when a key is configured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { route, toolSearch, STATE } from "../index.js";
import { home, ctxOf, toolEnv, fakeFetch, noNetwork, pkg } from "./helpers.js";

async function withFetch(fn, run) {
  const prev = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await run();
  } finally {
    globalThis.fetch = prev;
  }
}

test("with no arguments the catalogue; with a query every group whose tags match; with load those ids; unknown ids are refused by name", async () => {
  const h = home();
  try {
    const env = toolEnv(h.env);
    const listing = await withFetch(noNetwork, () => toolSearch({}, env));
    assert.ok(listing.startsWith("Tool groups:\n\n- `shell` [available] — Terminal sessions"));
    assert.ok(listing.endsWith("\n\nCall this again with a query or load to add one."));
    assert.ok(!listing.includes("`files`"), "always-on groups are not in the catalogue");

    const loaded = await withFetch(noNetwork, () => toolSearch({ query: "open a shell on the build host" }, env));
    const lines = loaded.split("\n");
    assert.equal(lines[0], "Loaded `shell`, `ssh` for the rest of this conversation.");
    assert.ok(loaded.includes("`shell`: Terminal sessions for builds, tests, git and long-running processes.\n  - terminal_open: terminal_open does its thing."));
    assert.ok(loaded.includes("These tools are in your list from the next turn; a call to one of them by name works now."));
    assert.ok(loaded.includes("- `shell` [loaded] — ") && loaded.includes("- `web` [available] — "));
    assert.ok(loaded.includes("Note: no embeddings key"), "the dense ranking was skipped and says so");
    assert.deepEqual(h.docs.get("sessions/s-1"), { active: [], loaded: { shell: "search", ssh: "search" } });

    const again = await withFetch(noNetwork, () => toolSearch({ query: "shell" }, env));
    assert.ok(again.startsWith("Nothing to add: `shell` is already loaded."));

    // No tag matches: the best-ranked group is loaded anyway, so a real need gets the closest thing.
    const closest = await withFetch(noNetwork, () => toolSearch({ query: "zzz qqq" }, env));
    assert.match(closest, /^Loaded `[a-z-]+` for the rest of this conversation\./);

    const explicit = await withFetch(noNetwork, () => toolSearch({ load: ["moo"] }, env));
    assert.ok(explicit.startsWith("Loaded `moo` for the rest of this conversation."));
    await assert.rejects(toolSearch({ load: ["moo", "nonsense", "web"] }, env), /^Error: unknown tool group: nonsense\. The groups are:\n- `shell`/);
    assert.equal(h.docs.get("sessions/s-1").loaded.web, undefined, "a refused load changes nothing");
    await assert.rejects(toolSearch({ query: "" , load: [] }, env).then(() => {}, (e) => { throw e; }).then(() => { throw new Error("no refusal"); }), /no refusal/, "an empty query lists the catalogue instead of refusing");
  } finally {
    h.rm();
  }
});

test("what tool_search loaded is merged into the pin on the next turn with the reason search, and the prompt grows by those lines", async () => {
  const h = home();
  try {
    const first = await withFetch(noNetwork, () => route(ctxOf(h.env, { config: { denseMode: "off" } })));
    assert.deepEqual(first.harness[STATE].active, ["tool-groups", "files"]);
    const env = toolEnv(h.env);
    const listing = await withFetch(noNetwork, () => toolSearch({}, env));
    assert.ok(!listing.includes("[loaded]"), "nothing routable is loaded yet");
    await withFetch(noNetwork, () => toolSearch({ load: ["web"] }, env));
    const next = await withFetch(noNetwork, () => route(ctxOf(h.env, { config: { denseMode: "off" }, harness: first.harness, conversation: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }, { role: "user", content: "and now?" }] })));
    assert.deepEqual(next.harness[STATE].active, ["tool-groups", "files", "web"]);
    assert.equal(next.harness[STATE].why.web, "search");
    assert.equal(next.call.system, first.call.system.replace("- `web` [available]", "- `web` [loaded]"));
    assert.deepEqual(h.docs.get("sessions/s-1"), { active: ["tool-groups", "files", "web"], loaded: { web: "search" } });
    const marked = await withFetch(noNetwork, () => toolSearch({}, env));
    assert.ok(marked.includes("- `web` [loaded]"));
    // Nothing is ever removed: a third turn reads the same set.
    const third = await withFetch(noNetwork, () => route(ctxOf(h.env, { config: { denseMode: "off" }, harness: next.harness })));
    assert.deepEqual(third.harness[STATE].active, ["tool-groups", "files", "web"]);
  } finally {
    h.rm();
  }
});

test("with a key the ranking is fused with the dense list; without routable groups the tool says so", async () => {
  const h = home();
  try {
    const fetch = fakeFetch();
    const env = toolEnv(h.env, undefined, { config: { embeddings: { apiKey: "k", model: "fake", dimensions: 8 } } });
    const out = await withFetch(fetch, () => toolSearch({ query: "spawn a subagent" }, env));
    assert.ok(out.startsWith("Loaded `subagents` for the rest of this conversation."));
    assert.ok(!out.includes("Note:"));
    assert.equal(fetch.calls.length, 2);
    const none = await withFetch(noNetwork, () => toolSearch({ query: "anything" }, toolEnv(h.env, [pkg("@thetis/tool-groups", ["tool_search"]), pkg("@thetis/tools-files", ["read_path"], { everyone: true })])));
    assert.equal(none, "Every tool is in your list already: no group is scoped in this workspace.");
  } finally {
    h.rm();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderCall, ToolEnv } from "@thetis/runtime/contracts";
import { listConversations, readConversation, searchConversations, summarizeConversation } from "../src/index.js";

const text = (t: string) => [{ type: "text", data: { text: t } }];
const user = (t: string) => ({ role: "user", content: text(t) });
const assistant = (t: string, toolCalls?: unknown[]) => ({ role: "assistant", content: text(t), ...(toolCalls ? { toolCalls } : {}) });
const result = (id: string, t: string) => ({ role: "tool", toolCallId: id, content: text(t) });

interface Fake {
  id: string;
  updatedAt: string;
  parent?: string;
  running?: boolean;
  interrupted?: { why: string; at: string };
  conversation: unknown[];
  turn?: unknown;
  harness?: Record<string, unknown>;
}

/** A person with these conversations, a home holding the web gateway's marks, and a provider that answers `answer`. */
function space(sessions: Fake[], marks: Record<string, { title?: string; archived?: boolean }> = {}, answer = "the summary") {
  const home = mkdtempSync(join(tmpdir(), "tool-exec-conv-"));
  const dir = join(home, "gateway-web", "sessions", "alice");
  mkdirSync(dir, { recursive: true });
  for (const [id, entry] of Object.entries(marks)) writeFileSync(join(dir, `${id}.json`), JSON.stringify(entry));
  const calls: ProviderCall[] = [];
  const opened: string[] = [];
  const kernel = {
    sessions: {
      list: async () => sessions.map((s) => {
        const users = s.conversation.filter((m) => (m as { role: string }).role === "user");
        const replies = s.conversation.filter((m) => (m as { role: string }).role === "assistant");
        const first = users[0] ? (users[0] as { content: { data: { text: string } }[] }).content[0].data.text : "";
        const last = replies.at(-1) ? (replies.at(-1) as { content: { data: { text: string } }[] }).content[0]?.data.text ?? "" : "";
        return { id: s.id, user: "alice", parent: s.parent, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: s.updatedAt, turns: users.length, first, last, running: !!s.running, interrupted: s.interrupted };
      }),
      inspect: async (id: string) => {
        opened.push(id);
        const s = sessions.find((x) => x.id === id);
        if (!s) throw new Error(`session ${id} not found`);
        return { id, user: "alice", parent: s.parent, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: s.updatedAt, turns: 1, conversation: s.conversation, harness: s.harness ?? {}, turn: s.turn, status: s.running ? "running" : "idle" };
      },
    },
    providers: {
      call: async (call: ProviderCall, onEvent: (e: unknown) => void) => {
        calls.push(call);
        onEvent({ type: "text", delta: answer });
        onEvent({ type: "usage", usage: { cost: 0.0123 } });
      },
    },
    models: async () => ({ model: "acme/default", models: [] }),
  };
  const env = { cwd: home, session: { id: "s_5e1f", user: "alice" }, kernel } as unknown as ToolEnv;
  return { env, calls, opened };
}

const three = (): Fake[] => [
  { id: "s_a1", updatedAt: "2026-09-28T10:00:00.000Z", conversation: [user("Plan the database schema\n\n[Turn context: Monday 2026-09-28 10:00 UTC]"), assistant("Use Postgres with three tables.")] },
  { id: "s_b2", updatedAt: "2026-09-29T10:00:00.000Z", conversation: [user("Fix the login bug"), assistant("Fixed in auth.ts.")] },
  { id: "s_c3", updatedAt: "2026-09-30T10:00:00.000Z", parent: "s_b2", conversation: [user("survey the auth code"), assistant("auth.ts holds the login.")] },
  { id: "s_5e1f", updatedAt: "2026-09-30T12:00:00.000Z", running: true, conversation: [user("what did I do about the schema?")] },
];

test("list_conversations shows the active top-level conversations newest first, with names, marks and first and last messages", async () => {
  const { env } = space(three(), { s_a1: { title: "Schema plan", archived: true }, s_b2: { title: "Login bug" } });
  const out = String(await listConversations({}, env));
  assert.match(out, /^active conversations, newest first: 1-2 of 2\n/);
  const [, first, , second] = out.split("\n");
  assert.match(first, /^- s_5e1f  2026-09-30 12:00  1 turn  running  \(this conversation\)$/);
  assert.match(second, /^- s_b2  2026-09-29 10:00  "Login bug"  1 turn  1 subagent$/);
  assert.match(out, /first: Fix the login bug\n  last: Fixed in auth.ts\./);
  assert.doesNotMatch(out, /s_a1|s_c3/, "the archived conversation and the subagent are not listed by default");
});

test("list_conversations picks archived, running, subagents, a parent's children, a query and a date range", async () => {
  const { env } = space(three(), { s_a1: { title: "Schema plan", archived: true } });
  assert.match(String(await listConversations({ show: "archived" }, env)), /^archived conversations.*\n- s_a1 .*"Schema plan".*archived/);
  assert.match(String(await listConversations({ show: "running" }, env)), /1-1 of 1\n- s_5e1f/);
  const kids = String(await listConversations({ parent: "s_b2" }, env));
  assert.match(kids, /^subagents of s_b2, newest first: 1-1 of 1\n- s_c3 .*subagent of s_b2/);
  assert.match(String(await listConversations({ subagents: true, show: "all" }, env)), /1-4 of 4/);
  assert.match(String(await listConversations({ query: "LOGIN", show: "all" }, env)), /1-1 of 1\n- s_b2/);
  const day = String(await listConversations({ show: "all", since: "2026-09-28", until: "2026-09-28" }, env));
  assert.match(day, /1-1 of 1\n- s_a1/, "a date-only until covers that whole day");
  assert.doesNotMatch(String(await listConversations({ show: "all" }, env)), /Turn context/);
  await assert.rejects(Promise.resolve(listConversations({ show: "open" }, env)), /show must be one of/);
});

test("list_conversations pages with offset and says how to get the rest", async () => {
  const many: Fake[] = Array.from({ length: 5 }, (_, i) => ({ id: `s_${i}0`, updatedAt: `2026-09-2${i}T00:00:00.000Z`, conversation: [user(`task ${i}`)] }));
  const { env } = space(many);
  const out = String(await listConversations({ limit: 2 }, env));
  assert.match(out, /1-2 of 5/);
  assert.match(out, /3 more: call again with offset 2\.$/);
  assert.match(String(await listConversations({ limit: 2, offset: 4 }, env)), /5-5 of 5\n- s_00/);
});

test("a home without the web gateway's files lists everything as unarchived and unnamed", async () => {
  const { env } = space(three());
  (env as { cwd: string }).cwd = mkdtempSync(join(tmpdir(), "tool-exec-bare-"));
  assert.match(String(await listConversations({}, env)), /1-3 of 3/);
});

const withTools = (): Fake[] => [{
  id: "s_d4", updatedAt: "2026-09-30T09:00:00.000Z",
  conversation: [
    user("Read the config please\n\n[Turn context: Tuesday 2026-09-30 09:00 UTC]"),
    assistant("", [{ id: "c1", name: "read_path", args: { path: "config.toml" } }]),
    result("c1", `[db]\nurl = "postgres://x"\n${"padding ".repeat(100)}`),
    assistant("The database is Postgres."),
    user("thanks"),
    assistant("You're welcome."),
  ],
}];

test("read_conversation shows the newest messages numbered, tool calls brief, the turn context line cut", async () => {
  const { env } = space(withTools(), { s_d4: { title: "Config" } });
  const out = String(await readConversation({ id: "[subagent s_d4 config]", limit: 5 }, env));
  const lines = out.split("\n");
  assert.match(lines[0], /^s_d4  2026-09-30 09:00  "Config"  2 turns  created 2026-09-01 00:00  6 messages$/);
  assert.equal(lines[1], "#2 assistant:");
  assert.equal(lines[2], '  → read_path {"path":"config.toml"}');
  assert.match(lines[3], /^#3 read_path result: \[db\] url = |^#3 read_path result: \[db\]/);
  assert.match(out, /… \[\d{3} chars\]/, "a long tool result is cut and says how long it was");
  assert.match(out, /\[showing messages #2-6 of 6\. Earlier: offset 1\.\]$/);
  const all = String(await readConversation({ id: "s_d4", offset: 1, tools: "none" }, env));
  assert.match(all, /#1 user: Read the config please\n#4 assistant: The database is Postgres\./);
  assert.doesNotMatch(all, /Turn context|read_path/);
  assert.match(String(await readConversation({ id: "s_d4", offset: -2 }, env)), /#5 user: thanks\n#6 assistant: You're welcome\.\n\[showing messages #5-6 of 6\. Earlier: offset 1\.\]$/);
});

test("read_conversation of a running conversation shows its reply so far; an unknown id is refused", async () => {
  const sessions: Fake[] = [{
    id: "s_e5", updatedAt: "2026-09-30T09:00:00.000Z", running: true,
    conversation: [user("first"), assistant("one")],
    turn: { id: "t_1", startedAt: "", messages: [user("second")], streamed: [assistant("working on it")] },
  }];
  const { env } = space(sessions);
  const out = String(await readConversation({ id: "s_e5" }, env));
  assert.match(out, /#2 assistant: one\n-- the running turn, as far as its checkpoint has it --\n#3 user: second\n#4 assistant: working on it/);
  await assert.rejects(Promise.resolve(readConversation({ id: "s_ff" }, env)), /no conversation s_ff of yours/);
  await assert.rejects(Promise.resolve(readConversation({ id: "nope" }, env)), /id must be a conversation id/);
});

test("read_conversation names a subagent by the label its parent's spawn_subagent result gave it, and notes compaction", async () => {
  const sessions: Fake[] = [
    { id: "s_b2", updatedAt: "2026-09-29T10:00:00.000Z", harness: { "@thetis/compaction": { cut: 1, summary: "earlier" } }, conversation: [user("go"), assistant("", [{ id: "c1", name: "spawn_subagent", args: { task: "x" } }]), result("c1", "[subagent s_c3 auth survey]\ndone")] },
    { id: "s_c3", updatedAt: "2026-09-30T10:00:00.000Z", parent: "s_b2", conversation: [user("x")] },
  ];
  const { env } = space(sessions);
  const out = String(await readConversation({ id: "s_b2" }, env));
  assert.match(out, /\nsubagents, newest first: s_c3 \(auth survey\)\n/);
  assert.match(out, /messages #1-1 were compacted/);
});

test("search_conversations finds matches newest first, grouped, leaves out this conversation and tool results by default", async () => {
  const { env, opened } = space([...three(), ...withTools()], { s_b2: { title: "Login bug" } });
  const out = String(await searchConversations({ pattern: "auth" }, env));
  assert.match(out, /^3 matches for \/auth\/ in 2 conversations \(searched 4 of 4 conversations, newest first\)\.\n/);
  assert.match(out, /- s_c3  2026-09-30 10:00  subagent of s_b2\n  #1 user: survey the auth code\n  #2 assistant: auth\.ts holds the login\./);
  assert.ok(out.indexOf("s_c3") < out.indexOf("s_b2"), "newest conversation first");
  assert.match(out, /- s_b2  2026-09-29 10:00  "Login bug"\n  #2 assistant: Fixed in auth\.ts\./);
  assert.ok(!opened.includes("s_5e1f"), "this conversation is never opened");
  assert.match(String(await searchConversations({ pattern: "postgres://" }, env)), /^no match/);
  const tools = String(await searchConversations({ pattern: "postgres://", roles: ["tool"] }, env));
  assert.match(tools, /#3 read_path result: …?.*postgres:\/\/x/);
  assert.match(String(await searchConversations({ pattern: "config\\.toml", roles: ["assistant", "tool"] }, env)), /#2 assistant: read_path \{"path":"config\.toml"\}/);
});

test("search_conversations cuts the turn context line, honours case, roles, id, dates, and says why it stopped", async () => {
  const { env } = space([...three(), ...withTools()]);
  assert.match(String(await searchConversations({ pattern: "Turn context" }, env)), /^no match/);
  assert.match(String(await searchConversations({ pattern: "Postgres", ignore_case: false }, env)), /^2 matches .*\n- s_d4/);
  assert.match(String(await searchConversations({ pattern: "postgres", ignore_case: false }, env)), /^no match/);
  assert.match(String(await searchConversations({ pattern: "auth", id: "s_b2" }, env)), /searched conversation s_b2/);
  assert.match(String(await searchConversations({ pattern: "auth", until: "2026-09-29" }, env)), /^1 match .*\n- s_b2/);
  const capped = String(await searchConversations({ pattern: "a", max_results: 1, per_conversation: 1 }, env));
  assert.match(capped, /Stopped at max_results \(1\)/);
  assert.match(capped, /… \d+ more in this conversation: search it alone with id s_/);
  assert.match(String(await searchConversations({ pattern: "zzz", max_conversations: 1 }, env)), /^no match for \/zzz\/ in 1 of 4 conversations\. Stopped at max_conversations \(1\)/);
  await assert.rejects(Promise.resolve(searchConversations({ pattern: "(" }, env)), /not a valid regular expression/);
  await assert.rejects(Promise.resolve(searchConversations({ pattern: "x*" }, env)), /matches empty text/);
  await assert.rejects(Promise.resolve(searchConversations({ pattern: "a", id: "s_99" }, env)), /no conversation s_99 of yours/);
});

test("summarize_conversation sends the transcript in one request with no tools, on this turn's model, and reports the cost", async () => {
  const { env, calls } = space(withTools(), {}, "They read the config; the database is Postgres.");
  (env as { model?: string }).model = "acme/fast-1";
  const out = String(await summarizeConversation({ id: "s_d4", focus: "the database" }, env));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "acme/fast-1");
  assert.deepEqual(calls[0].tools, []);
  const prompt = (calls[0].messages[0].content as unknown as { data: { text: string } }[])[0].data.text;
  assert.match(prompt, /<transcript>\n#1 user: Read the config please\n\n#2 assistant:\n  → read_path/);
  assert.match(prompt, /in particular: the database/);
  assert.doesNotMatch(prompt, /Turn context/);
  assert.match(out, /^s_d4 .*6 messages\n\nThey read the config; the database is Postgres\.\n\n\[summary of 6 messages by acme\/fast-1, \$0\.0123\. read_conversation/);
});

test("summarize_conversation falls to the default model, keeps head and tail of a long transcript, and fails as an error", async () => {
  const long: Fake[] = [{ id: "s_f6", updatedAt: "2026-09-30T09:00:00.000Z", conversation: Array.from({ length: 200 }, (_, i) => (i % 2 ? assistant(`reply ${i} ${"x".repeat(3000)}`) : user(`ask ${i}`))) }];
  const { env, calls } = space(long);
  const out = String(await summarizeConversation({ id: "s_f6" }, env));
  assert.equal(calls[0].model, "acme/default");
  const prompt = (calls[0].messages[0].content as unknown as { data: { text: string } }[])[0].data.text;
  assert.match(prompt, /#1 user: ask 0/);
  assert.match(prompt, /#200 assistant: reply 199/);
  assert.match(prompt, /\[… \d+ messages left out here for length …\]/);
  assert.ok(prompt.length < 180_000);
  assert.match(out, /; \d+ messages in the middle were left out for length\. /);

  const failing = space(withTools());
  (failing.env.kernel.providers as { call: unknown }).call = async (_c: unknown, onEvent: (e: unknown) => void) => onEvent({ type: "error", message: "rate limited" });
  await assert.rejects(Promise.resolve(summarizeConversation({ id: "s_d4" }, failing.env)), /the summary failed: rate limited/);
});

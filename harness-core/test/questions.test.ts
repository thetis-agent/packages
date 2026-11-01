import { contentText, textContent } from "@thetis/runtime/lib/content";
// Questions for the person: a tool declared `endsTurn` ends the loop once it returns, and a tool declared
// `needsPerson` is not offered where nobody can answer. Over a scripted provider and a temporary home.
import { test, after } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import type { Message, PackageInfo, PackageStepContext, ProviderCall, ProviderEvent, SessionInfo, ToolSpec } from "@thetis/runtime/contracts";
import { attachTools, callModel, unattendedPath } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "thetis-questions-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const plan = {
  name: "@thetis/tools-plan",
  version: "0.5.0",
  type: "tool",
  description: "",
  root: "",
  thetis: {
    type: "tool",
    tools: [
      { name: "ask_user", description: "Ask.", export: "askUser", endsTurn: true, needsPerson: true },
      { name: "todo", description: "List.", export: "todo" },
    ],
  },
} as unknown as PackageInfo;
const spec = (name: string): ToolSpec => ({ name, description: "", parameters: {}, package: "@thetis/tools-plan", export: name });

type Script = (round: number, call: ProviderCall, onEvent: (e: ProviderEvent) => void) => Promise<void>;

function turn(script: Script, over: { input?: Message[]; conversation?: Message[]; invoke?: (name: string) => string; session?: SessionInfo } = {}) {
  const invoked: string[] = [];
  let rounds = 0;
  const home = mkdtempSync(join(root, "turn-"));
  const ctx = {
    emit: () => {},
    signal: new AbortController().signal,
    session: over.session ?? { id: "s1", user: "alice" },
    turn: { id: "t1", input: over.input ?? [{ role: "user", content: textContent("go") }] },
    conversation: over.conversation ?? [{ role: "user", content: textContent("go") }],
    call: { model: "m", messages: [], tools: [spec("ask_user"), spec("todo")], params: {} },
    harness: {},
    packages: { has: () => true, get: () => plan, list: () => [plan] },
    config: {},
    env: {
      cwd: home,
      readFile: async (p: string) => readFileSync(join(home, p), "utf8"),
      writeFile: async (p: string, c: string) => {
        mkdirSync(dirname(join(home, p)), { recursive: true });
        writeFileSync(join(home, p), c);
      },
      invokeTool: async (ref: ToolSpec) => {
        invoked.push(ref.name);
        return over.invoke ? over.invoke(ref.name) : `ran ${ref.name}`;
      },
      kernel: {
        providers: { call: (call: ProviderCall, onEvent: (e: ProviderEvent) => void) => script(++rounds, call, onEvent) },
        config: { effective: async () => ({}) },
      },
    },
  } as unknown as PackageStepContext;
  const status = () => JSON.parse(readFileSync(join(home, "harness-core/context/s1.json"), "utf8")).usage.at(-1).status;
  return { ctx, invoked, rounds: () => rounds, status, home };
}

const ask = (onEvent: (e: ProviderEvent) => void, id = "q1") => onEvent({ type: "tool_call", call: { id, name: "ask_user", args: { questions: [{ question: "colour?" }] } } });

test("a successful endsTurn call ends the turn: no second provider call, status complete", async () => {
  const t = turn(async (round, _c, onEvent) => {
    if (round === 1) {
      onEvent({ type: "text", delta: "One thing first." });
      return ask(onEvent);
    }
    onEvent({ type: "text", delta: "waiting for your answers" });
  }, { invoke: () => "Shown to the person as a form." });
  const out = await callModel(t.ctx);
  assert.equal(t.rounds(), 1);
  assert.deepEqual(out.conversation!.map((m) => m.role), ["user", "assistant", "tool"], "the record ends with the result, which the next message answers");
  assert.equal(contentText(out.conversation!.at(-1)!.content), "Shown to the person as a form.");
  assert.equal(t.status(), "complete");
});

test("an error: result from an endsTurn tool lets the loop go on", async () => {
  const t = turn(async (round, _c, onEvent) => (round === 1 ? ask(onEvent) : onEvent({ type: "text", delta: "I assumed blue." })), {
    invoke: () => {
      throw new Error("Nobody reads this conversation while it runs, so no one can answer.");
    },
  });
  const out = await callModel(t.ctx);
  assert.equal(t.rounds(), 2);
  assert.match(contentText(out.conversation!.at(-2)!.content), /^error: Nobody reads/);
  assert.equal(contentText(out.conversation!.at(-1)!.content), "I assumed blue.");
});

test("a round with an endsTurn call and another call runs both, then ends", async () => {
  const t = turn(async (round, _c, onEvent) => {
    if (round > 1) return onEvent({ type: "text", delta: "never" });
    onEvent({ type: "tool_call", call: { id: "a", name: "todo", args: {} } });
    ask(onEvent, "b");
  });
  const out = await callModel(t.ctx);
  assert.deepEqual(t.invoked, ["todo", "ask_user"]);
  assert.equal(t.rounds(), 1);
  assert.deepEqual(out.conversation!.filter((m) => m.role === "tool").map((m) => m.toolCallId), ["a", "b"]);
});

test("a tool without endsTurn does not end the turn", async () => {
  const t = turn(async (round, _c, onEvent) => (round === 1 ? onEvent({ type: "tool_call", call: { id: "a", name: "todo", args: {} } }) : onEvent({ type: "text", delta: "done" })));
  await callModel(t.ctx);
  assert.equal(t.rounds(), 2);
});

test("the resume path ends too: an ask_user that never ran runs, and no model call follows", async () => {
  const conversation: Message[] = [
    { role: "user", content: textContent("go") },
    { role: "assistant", content: textContent(""), toolCalls: [{ id: "q1", name: "ask_user", args: {} }] },
    { role: "tool", content: textContent("error: the turn was stopped before this tool ran"), toolCallId: "q1", name: "ask_user", extensions: { "@thetis/harness-core": { notRun: true } } },
  ];
  const t = turn(async (_r, _c, onEvent) => onEvent({ type: "text", delta: "never" }), { input: [], conversation });
  const out = await callModel(t.ctx);
  assert.deepEqual(t.invoked, ["ask_user"]);
  assert.equal(t.rounds(), 0);
  assert.equal(contentText(out.conversation!.at(-1)!.content), "ran ask_user");
  assert.equal(t.status(), "complete");
});

test("attachTools leaves needsPerson tools out of a subagent and of an unattended conversation", async () => {
  const names = async (t: ReturnType<typeof turn>) => (await attachTools({ ...t.ctx, call: { ...t.ctx.call, tools: [] } })).call!.tools.map((x) => x.name);
  const attended = turn(async () => {});
  assert.deepEqual(await names(attended), ["ask_user", "todo"]);
  const child = turn(async () => {}, { session: { id: "s1", user: "alice", parent: "s0" } });
  assert.deepEqual(await names(child), ["todo"]);
  const run = turn(async () => {});
  await run.ctx.env.writeFile(unattendedPath("s1"), JSON.stringify({ by: "@thetis/workflows", run: "r1", at: "2026-11-01T00:00:00.000Z" }));
  assert.deepEqual(await names(run), ["todo"]);
  assert.throws(() => unattendedPath("../x"), /invalid session id/);
});

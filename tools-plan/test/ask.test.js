// ask_user tests: the fixed return text, the 1-4 question bound, and that the record
// lands on disk under questions/<session id>.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { askUser } from "../lib/ask-user.js";

async function makeEnv() {
  const home = await mkdtemp(resolve(tmpdir(), "tp-ask-"));
  return { home, env: { cwd: home, session: { id: "s-ask" } } };
}

test("ask_user returns the fixed resumption text", async () => {
  const { home, env } = await makeEnv();
  const out = await askUser({ questions: [{ question: "Which color?", options: ["red", "blue"] }] }, env);
  assert.equal(
    out,
    "Questions recorded; the page shows them as a form. End your reply with one short line " +
      "saying you are waiting for the answers, and stop. They arrive as the next user message."
  );
  await rm(home, { recursive: true, force: true });
});

test("ask_user records the questions with a timestamp under questions/<session id>.json", async () => {
  const { home, env } = await makeEnv();
  await askUser({ questions: [{ question: "Proceed?" }], intro: "one thing" }, env);
  const raw = await readFile(resolve(home, "questions", "s-ask.json"), "utf8");
  const data = JSON.parse(raw);
  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0].intro, "one thing");
  assert.equal(data.entries[0].questions[0].question, "Proceed?");
  assert.ok(data.entries[0].at);
  await rm(home, { recursive: true, force: true });
});

test("ask_user refuses zero or more than 4 questions", async () => {
  const { home, env } = await makeEnv();
  await assert.rejects(askUser({ questions: [] }, env), /1 to 4 entries/);
  const five = Array.from({ length: 5 }, (_, i) => ({ question: `q${i}` }));
  await assert.rejects(askUser({ questions: five }, env), /1 to 4 entries/);
  await rm(home, { recursive: true, force: true });
});

test("ask_user mints default ids when none given, and clips overly long options", async () => {
  const { home, env } = await makeEnv();
  await askUser(
    {
      questions: [
        { question: "First?" },
        { question: "Second?", options: ["x".repeat(200)] },
      ],
    },
    env
  );
  const raw = await readFile(resolve(home, "questions", "s-ask.json"), "utf8");
  const data = JSON.parse(raw);
  const qs = data.entries[0].questions;
  assert.equal(qs[0].id, "q-1");
  assert.equal(qs[1].id, "q-2");
  assert.equal(qs[1].options[0].length, 120);
  await rm(home, { recursive: true, force: true });
});

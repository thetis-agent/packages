// A process handle over a child that ignores SIGTERM: close must still return, by killing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { Userspace } from "@thetis/contracts";
import { ProcessHandle } from "../src/handle.js";

const us = { id: "alice", root: "/nowhere", home: "/nowhere", store: "/nowhere", run: "/nowhere", mounts: [] } as unknown as Userspace;

test("close waits for the agent to exit and kills one that ignores SIGTERM", async () => {
  const lines: string[] = [];
  const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.error('ready')"], { stdio: ["pipe", "pipe", "pipe"] });
  const handle = new ProcessHandle(stubborn, us, async () => null, { requestTimeoutMs: 1000, exitGraceMs: 300, log: (l) => lines.push(l) });
  // The handle relays the child's stderr to the log; the handler is in place once the child says so.
  while (!lines.some((l) => /ready/.test(l))) await new Promise((r) => setTimeout(r, 10));
  const started = Date.now();
  await handle.close();
  const took = Date.now() - started;
  assert.ok(took >= 250 && took < 2000, `close took ${took} ms`);
  assert.equal(stubborn.exitCode ?? stubborn.signalCode, "SIGKILL");
  assert.ok(lines.some((l) => /did not exit/.test(l)));

  const polite = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"] });
  const quick = new ProcessHandle(polite, us, async () => null, { requestTimeoutMs: 1000, exitGraceMs: 5000, log: () => {} });
  const t = Date.now();
  await quick.close();
  assert.ok(Date.now() - t < 1000, "a child that honours SIGTERM is not waited on for the grace period");
  assert.equal(polite.signalCode, "SIGTERM");
  await assert.rejects(quick.request("ping", {}), /closed/);
});

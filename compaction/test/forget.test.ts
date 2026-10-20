// The forget hook over a temporary home: the dock's request files are the one thing it removes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetSession } from "../src/index.js";

const homes: string[] = [];
after(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "compaction-forget-"));
  homes.push(h);
  mkdirSync(join(h, "compaction/requests"), { recursive: true });
  return h;
}

test("preview answers nothing and removes nothing", async () => {
  const h = home();
  writeFileSync(join(h, "compaction/requests/s_a.json"), JSON.stringify({ at: "2026-10-19T10:00:00.000Z" }));
  assert.deepEqual(await forgetSession({ phase: "preview", session: "s_a", sessions: ["s_a"] }, { cwd: h }), {});
  assert.ok(existsSync(join(h, "compaction/requests/s_a.json")));
});

test("forget removes the request files of the subtree, reports only the pending ones, and leaves other conversations'", async () => {
  const h = home();
  writeFileSync(join(h, "compaction/requests/s_a.json"), JSON.stringify({ at: "2026-10-19T10:00:00.000Z", instructions: "keep the paths" }));
  writeFileSync(join(h, "compaction/requests/s_b.json"), ""); // consumed
  writeFileSync(join(h, "compaction/requests/s_keep.json"), JSON.stringify({ at: "2026-10-19T10:00:00.000Z" }));
  const out = await forgetSession({ phase: "forget", session: "s_a", sessions: ["s_a", "s_b", "s_c"] }, { cwd: h });
  assert.deepEqual(out, { removed: ["1 compaction request not yet carried out."] });
  assert.ok(!existsSync(join(h, "compaction/requests/s_a.json")));
  assert.ok(!existsSync(join(h, "compaction/requests/s_b.json")), "a consumed request goes too, unreported");
  assert.ok(existsSync(join(h, "compaction/requests/s_keep.json")));
});

test("forget is idempotent and ignores ids that could not be a session", async () => {
  const h = home();
  writeFileSync(join(h, "compaction/requests/s_a.json"), "{}");
  const args = { phase: "forget" as const, session: "s_a", sessions: ["s_a", "../x"] };
  assert.equal(((await forgetSession(args, { cwd: h })) as { removed: string[] }).removed.length, 1);
  assert.deepEqual(await forgetSession(args, { cwd: h }), { removed: [] });
  const bare = mkdtempSync(join(tmpdir(), "compaction-forget-bare-"));
  homes.push(bare);
  assert.deepEqual(await forgetSession(args, { cwd: bare }), { removed: [] });
});

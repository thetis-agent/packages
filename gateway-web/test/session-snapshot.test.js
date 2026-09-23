import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../dist/src/server.js";
import { GatewayStore } from "../dist/src/store.js";

for (const during of ["list", "child", "inspect"]) {
  test(`the session snapshot includes a turn that finishes during ${during}`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "gateway-snapshot-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    let watched;
    let completed = false;
    const record = (id) => ({
      id, user: "alice", ...(id === "s_2" ? { parent: "s_1" } : {}),
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      status: completed || id === "s_2" ? "idle" : "running", turns: completed ? 1 : 0, harness: {},
      conversation: [{ role: "user", content: "hello" }, ...(completed && id === "s_1" ? [{ role: "assistant", content: "the completed answer" }] : [])],
      ...(!completed && id === "s_1" ? { turn: { id: "t_1", input: "hello", startedAt: "2026-01-01T00:00:00Z" } } : {}),
    });
    const complete = () => {
      if (completed) return;
      completed = true;
      watched({ session: "s_1", event: { type: "message", message: { role: "assistant", content: "the completed answer" } } });
      watched({ session: "s_1", event: { type: "turn.end", session: "s_1", turn: "t_1" } });
    };
    const kernel = {
      auth: { authenticate: async () => ({ id: "alice", role: "user" }) },
      sessions: {
        watch: (fn) => { watched = fn; return new Promise(() => {}); },
        list: async () => { if (during === "list") complete(); return [record("s_1"), record("s_2")]; },
        inspect: async (id) => {
          const saved = record(id);
          if ((during === "child" && id === "s_2") || (during === "inspect" && id === "s_1")) complete();
          return saved;
        },
      },
    };
    const server = createGateway(kernel, new GatewayStore(home), { user: "alice" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    watched({ session: "s_1", input: "hello", event: { type: "turn.start", session: "s_1", turn: "t_1" } });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/s_1`, { headers: { cookie: `thetis_web=${"a".repeat(64)}` } });
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.conversation.at(-1).content, "the completed answer");
    assert.equal(snapshot.turn, null);
    assert.equal(snapshot.status, "idle");
  });
}

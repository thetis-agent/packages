// The pool's close is a drain: a request already inside the fence finishes before the fence goes, and a
// request that arrives while the close is under way waits for it and lands in the fence opened next.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fence, FenceHandle, Userspace } from "@thetis/contracts";
import { FencePool } from "../src/pool.js";

const us = { id: "alice" } as Userspace;

/** A fence whose requests resolve when the test says so, numbered by the order they were opened. */
function fakeFence() {
  const opened: { n: number; closed: boolean; mounts: number; answer: (op: string) => void; pending: Map<string, (v: unknown) => void> }[] = [];
  const fence: Fence = {
    async open(u) {
      const pending = new Map<string, (v: unknown) => void>();
      const rec = { n: opened.length + 1, closed: false, mounts: u.mounts?.length ?? 0, answer: (op: string) => pending.get(op)?.(`${op} from fence ${rec.n}`), pending };
      opened.push(rec);
      const handle: FenceHandle = {
        request: (op) => new Promise((done) => pending.set(op, done)),
        close: async () => {
          rec.closed = true;
        },
      };
      return handle;
    },
  };
  return { fence, opened };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("close waits for a quiet moment; a request meanwhile still enters the old fence; the next opens a new one with the userspace refreshed", async () => {
  const { fence, opened } = fakeFence();
  let mounts = 0;
  const pool = new FencePool(fence, () => ({}) as never, undefined, (u) => ({ ...u, mounts: Array(mounts).fill({ path: "/x", mode: "rw" }) }));
  const first = pool.request(us, "tool", {});
  await tick();
  assert.equal(opened.length, 1);
  const closing = pool.close(us.id);
  await tick();
  assert.equal(opened[0].closed, false, "the fence stays while its request runs");
  const second = pool.request(us, "child-step", {});
  await tick();
  assert.equal(opened.length, 1, "a request during the drain goes into the fence that is still open");
  opened[0].answer("tool");
  assert.equal(await first, "tool from fence 1");
  await tick();
  assert.equal(opened[0].closed, false, "still one request in flight");
  opened[0].answer("child-step");
  assert.equal(await second, "child-step from fence 1");
  await closing;
  assert.equal(opened[0].closed, true);
  mounts = 1;
  const third = pool.request(us, "next", {});
  await tick();
  assert.equal(opened.length, 2, "a request after the close opens the next fence");
  opened[1].answer("next");
  assert.equal(await third, "next from fence 2");
  assert.equal(opened[1].mounts, 1, "the new fence saw the userspace as it is now");
});

test("a close with nothing in flight is immediate, and a second close joins the first", async () => {
  const { fence, opened } = fakeFence();
  const pool = new FencePool(fence, () => ({}) as never);
  await pool.handle(us);
  const a = pool.close(us.id);
  const b = pool.close(us.id);
  await Promise.all([a, b]);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].closed, true);
});

test("the pool stamps each fence it opens with the versions it read, and forgets them with the handle", async () => {
  const { fence, opened } = fakeFence();
  let versions: Record<string, string> = { "@thetis/skills-hybrid": "0.2.1" };
  const pool = new FencePool(fence, () => ({}) as never, undefined, undefined, () => ({ ...versions }));
  assert.deepEqual(pool.loadedVersions(), {}, "nothing is open, so nothing is loaded");
  await pool.handle(us);
  assert.deepEqual(pool.loadedVersions(), { alice: { "@thetis/skills-hybrid": "0.2.1" } });
  versions = { "@thetis/skills-hybrid": "0.2.2" };
  await pool.handle(us);
  assert.deepEqual(pool.loadedVersions(), { alice: { "@thetis/skills-hybrid": "0.2.1" } }, "the open fence still holds what it read");
  await pool.close(us.id);
  assert.deepEqual(pool.loadedVersions(), {}, "a closed fence loaded nothing");
  await pool.handle(us);
  assert.deepEqual(pool.loadedVersions(), { alice: { "@thetis/skills-hybrid": "0.2.2" } }, "the fence opened next reads the disk as it is now");
  assert.equal(opened.length, 2);
});

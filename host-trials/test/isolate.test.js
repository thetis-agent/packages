// The pure half of the isolation: which paths get an overlay, and in what order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { overlayPlan, parseMountinfo, within } from "../lib/isolate.js";
import { createAccount } from "../lib/accounting.js";

const MOUNTINFO = [
  "22 1 0:21 / / rw,relatime shared:1 - zfs rpool/root rw",
  "40 22 0:35 / /tank/data rw,relatime shared:9 - zfs tank/data rw",
  "41 40 0:36 / /tank/data/Dev rw,relatime shared:10 - zfs tank/data/Dev rw",
  "42 22 0:37 / /opt/zero/data rw,relatime shared:11 - zfs tank/zero rw",
  "43 42 0:38 / /opt/zero/data/userspaces/ann/home/big rw - zfs tank/big rw",
  "44 22 0:39 / /tmp rw - tmpfs tmpfs rw",
  "45 22 0:40 / /mnt/with\\040space rw - ext4 /dev/sdb1 rw",
].join("\n");

test("mountinfo is read with its escapes undone", () => {
  const m = parseMountinfo(MOUNTINFO);
  assert.equal(m.length, 7);
  assert.deepEqual(m[1], { mountPoint: "/tank/data", fstype: "zfs", source: "tank/data" });
  assert.equal(m[6].mountPoint, "/mnt/with space");
});

test("within is a path prefix by whole segments", () => {
  assert.ok(within("/a/b", "/a"));
  assert.ok(within("/a", "/a"));
  assert.ok(!within("/ab", "/a"));
  assert.ok(within("/x", "/"));
});

test("every root and every mount beneath one is overlaid, shallowest first", () => {
  const points = parseMountinfo(MOUNTINFO).map((m) => m.mountPoint);
  const plan = overlayPlan(["/opt/zero/data", "/tank/data/Dev/thetis-agent/runtime"], points);
  assert.deepEqual(plan, ["/opt/zero/data", "/tank/data/Dev/thetis-agent/runtime", "/opt/zero/data/userspaces/ann/home/big"]);
});

test("a root beneath another is covered by it unless it is a mount point of its own", () => {
  const points = parseMountinfo(MOUNTINFO).map((m) => m.mountPoint);
  assert.deepEqual(overlayPlan(["/tank/data", "/tank/data/Dev/x", "/tank/data/y"], points), ["/tank/data", "/tank/data/Dev"]);
  assert.deepEqual(overlayPlan(["/tank/data/Dev", "/tank/data"], points), ["/tank/data", "/tank/data/Dev"]);
  assert.deepEqual(overlayPlan(["/a", "/a"], []), ["/a"]);
  // A mount above a root, or beside it, is none of its business.
  assert.deepEqual(overlayPlan(["/tmp/h"], points), ["/tmp/h"]);
});

test("cost: usage events count, a message's usage only when no usage event came first in that conversation", () => {
  const a = createAccount();
  assert.ok(a.add("s1", { type: "usage", usage: { cost: 0.01, prompt_tokens: 100, completion_tokens: 10 } }));
  assert.ok(!a.add("s1", { type: "message", message: {}, usage: { cost: 0.01, prompt_tokens: 100 } }), "the same call reported twice");
  assert.ok(a.add("s1", { type: "message", message: {}, usage: { cost: 0.02, input_tokens: 50, output_tokens: 5 } }), "a later call with only a message");
  assert.ok(a.add("s2", { type: "usage", usage: { cost: 0.005 } }), "a subagent's conversation counts too");
  assert.ok(!a.add("s1", { type: "text", delta: "x" }));
  a.add("s1", { type: "usage", usage: { cost: "free", prompt_tokens: -3 } });
  assert.equal(a.costUsd, 0.035);
  assert.equal(a.tokens, 165);
});

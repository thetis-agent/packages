// The frame tokens: minted for one person, one verb and one set of arguments; looked up until they expire;
// the oldest of a person's evicted past the cap; and gone on revoke. The clock and the randomness are injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameTokens, TOKEN } from "../src/frames.js";

const record = (user = "alice", n = 0) => ({ user, role: "user" as const, pkg: "@t/canvas", verb: "frame", args: { canvas: `c_${n}` } });

test("a minted token is 64 hex characters and looks up to a copy of its record", () => {
  const tokens = new FrameTokens();
  const token = tokens.mint(record());
  assert.match(token, TOKEN);
  const found = tokens.lookup(token);
  assert.deepEqual(found, record());
  assert.notEqual(tokens.mint(record()), token, "each mint is its own token");
  assert.equal(tokens.lookup("0".repeat(64)), undefined, "an unknown token names nothing");
  found!.args.canvas = "changed";
  assert.equal(tokens.lookup(token)!.args.canvas, "c_0", "what a lookup hands out is a copy; the held record does not move");
});

test("a token expires at its ttl, and an expired one is forgotten on the lookup that finds it so", () => {
  let now = 1_000;
  const tokens = new FrameTokens({ ttlMs: 100, now: () => now });
  const token = tokens.mint(record());
  now = 1_099;
  assert.ok(tokens.lookup(token));
  now = 1_100;
  assert.equal(tokens.lookup(token), undefined);
  assert.equal(tokens.size, 0, "forgotten, not merely refused");
});

test("a person keeps at most perUser tokens: the oldest go first, and another person's are untouched", () => {
  let now = 0;
  const tokens = new FrameTokens({ perUser: 3, now: () => now++ });
  const mine = [0, 1, 2].map((n) => tokens.mint(record("alice", n)));
  const bobs = tokens.mint(record("bob"));
  const fourth = tokens.mint(record("alice", 3));
  assert.equal(tokens.lookup(mine[0]), undefined, "alice's oldest was evicted");
  assert.ok(tokens.lookup(mine[1]) && tokens.lookup(mine[2]) && tokens.lookup(fourth));
  assert.ok(tokens.lookup(bobs), "bob's token was not counted against alice");
  assert.equal(tokens.size, 4);
});

test("expired tokens are swept on a mint, so a long-lived gateway does not hold every token ever minted", () => {
  let now = 0;
  const tokens = new FrameTokens({ ttlMs: 10, now: () => now });
  tokens.mint(record("alice", 1));
  tokens.mint(record("bob", 2));
  now = 50;
  tokens.mint(record("alice", 3));
  assert.equal(tokens.size, 1);
});

test("revoke forgets one token; revokeUser forgets every token of that person", () => {
  const tokens = new FrameTokens();
  const a1 = tokens.mint(record("alice", 1));
  const a2 = tokens.mint(record("alice", 2));
  const b = tokens.mint(record("bob"));
  tokens.revoke(a1);
  assert.equal(tokens.lookup(a1), undefined);
  assert.ok(tokens.lookup(a2));
  tokens.revokeUser("alice");
  assert.equal(tokens.lookup(a2), undefined);
  assert.ok(tokens.lookup(b));
});

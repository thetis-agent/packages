// A key a fence gets instead of a host credential: made once, kept, and never world-readable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKey, withKeyPresence } from "../src/ssh.js";

test("a generated key is private, carries its comment, and is granted as a real key", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "thetis-keygen-")), "alice");
  const made = generateKey(dir, "thetis-alice");
  assert.match(made.publicKey, /^ssh-ed25519 \S+ thetis-alice$/, made.publicKey);
  assert.equal(statSync(made.key).mode & 0o777, 0o600, "the private half is the owner's alone");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  // It is an ordinary grant from here on: the same presence check answers for it.
  assert.equal(withKeyPresence([{ key: made.key }])[0].present, true);
});

test("an existing key is kept, because generating over a registered one breaks it silently", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "thetis-keygen-keep-")), "alice");
  const first = generateKey(dir, "thetis-alice");
  const before = readFileSync(first.key, "utf8");
  const again = generateKey(dir, "thetis-alice");
  assert.equal(again.publicKey, first.publicKey, "the public half a person registered has to survive");
  assert.equal(readFileSync(first.key, "utf8"), before);
});

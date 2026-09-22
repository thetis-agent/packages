// The key mechanism: a grant list parsed strictly, a key the host made carrying its public half and
// fingerprint, a missing one present false with nulls, an imported key read back, refused when not a
// key, and never overwritten; and a generated key private, kept, and never world-readable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeKeys, generateKey, importKey, parseSshGrants, withKeyPresence } from "../lib/ssh.js";

test("grants are parsed strictly and deduplicate nothing: the lines are kept as given, blanks dropped", () => {
  assert.deepEqual(parseSshGrants([{ key: "/k", hosts: ["a", " ", "a", "b"] }]), [{ key: "/k", hosts: ["a", "a", "b"] }]);
  assert.deepEqual(parseSshGrants([{ key: "/k", hosts: [] }]), [{ key: "/k" }], "no hosts: none written");
  assert.throws(() => parseSshGrants([{ key: "relative/path" }]), /absolute and normalized/);
  assert.throws(() => parseSshGrants([{ key: "/k", hosts: "github.com" }]), /a list of known_hosts lines/);
  assert.throws(() => parseSshGrants(Array(17).fill({ key: "/k" })), /at most 16/);
  assert.throws(() => parseSshGrants("nope"), /at most 16/);
});

test("a key the host made carries its public half and fingerprint; a missing one is present false with nulls; an imported key is read back, refused when not a key, and never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-ssh-"));
  try {
    const made = generateKey(join(dir, "alice"), "thetis-alice");
    assert.equal(made.key, join(dir, "alice", "id_ed25519"));
    assert.match(made.publicKey, /^ssh-ed25519 /);
    assert.match(made.fingerprint ?? "", /^SHA256:/);
    const [there, gone] = describeKeys([{ key: made.key, hosts: ["github.com ssh-ed25519 AAAA"] }, { key: join(dir, "nowhere") }]);
    assert.deepEqual(there, { key: made.key, hosts: ["github.com ssh-ed25519 AAAA"], present: true, publicKey: made.publicKey, fingerprint: made.fingerprint });
    assert.deepEqual(gone, { key: join(dir, "nowhere"), present: false, publicKey: null, fingerprint: null });
    assert.equal(withKeyPresence, describeKeys, "the former name");
    // Without the .pub beside it the public half is derived from the key itself.
    rmSync(`${made.key}.pub`);
    assert.equal(describeKeys([{ key: made.key }])[0].publicKey, made.publicKey);

    const material = readFileSync(made.key, "utf8");
    const imported = importKey(join(dir, "bob"), "github", material);
    assert.equal(imported.key, join(dir, "bob", "github"));
    assert.equal(imported.publicKey, made.publicKey, "the same key: the same public half");
    assert.equal(imported.fingerprint, made.fingerprint);
    assert.equal(readFileSync(`${imported.key}.pub`, "utf8").trim(), made.publicKey);
    assert.throws(() => importKey(join(dir, "bob"), "github", material), /already exists/);
    assert.throws(() => importKey(join(dir, "bob"), "notes", "hello, not a key"), /not a private key/);
    assert.equal(existsSync(join(dir, "bob", "notes")), false, "a refused import leaves nothing behind");
    assert.throws(() => importKey(join(dir, "bob"), "garbage", "-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n-----END OPENSSH PRIVATE KEY-----"), /not a private key ssh-keygen can read/);
    assert.equal(existsSync(join(dir, "bob", "garbage")), false);
    assert.throws(() => importKey(join(dir, "bob"), "bad.pub", material), /not ending in \.pub/);
    assert.throws(() => importKey(join(dir, "bob"), "../escape", material), /one plain name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a generated key is private, carries its comment, and is granted as a real key", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "thetis-keygen-")), "alice");
  const made = generateKey(dir, "thetis-alice");
  assert.match(made.publicKey, /^ssh-ed25519 \S+ thetis-alice$/, made.publicKey);
  assert.equal(statSync(made.key).mode & 0o777, 0o600, "the private half is the owner's alone");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  // It is an ordinary grant from here on: the same presence check answers for it.
  assert.equal(describeKeys([{ key: made.key }])[0].present, true);
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

test("an existing key is kept, because generating over a registered one breaks it silently", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "thetis-keygen-keep-")), "alice");
  const first = generateKey(dir, "thetis-alice");
  const before = readFileSync(first.key, "utf8");
  const again = generateKey(dir, "thetis-alice");
  assert.equal(again.publicKey, first.publicKey, "the public half a person registered has to survive");
  assert.equal(readFileSync(first.key, "utf8"), before);
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

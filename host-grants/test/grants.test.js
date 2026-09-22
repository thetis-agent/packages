// The exports over a fake env: the checks every grant makes, what is written, what the journal says, and
// that the fence is reopened. The mechanism underneath (parsing, presence, keys) has tests of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as grants from "../index.js";
import { code, fakeEnv } from "./helpers.js";

test("mountsSet: validates the list, writes the record, journals the change, and reopens the fence", async () => {
  const { env, home, journal, reloaded } = fakeEnv();
  try {
    const set = (user, mounts) => grants.mountsSet({ user, mounts }, env);
    await assert.rejects(set("nobody", []), code("not-found"));
    await assert.rejects(set("_system", []), /takes no mounts/);
    await assert.rejects(set("alice", "nope"), /list of at most 32/);
    await assert.rejects(set("alice", Array.from({ length: 33 }, () => ({ path: "/x", mode: "ro" }))), /at most 32/);
    for (const path of ["relative", "/a/../b", "/a/", "/a//b", "/", ""]) {
      await assert.rejects(set("alice", [{ path, mode: "rw" }]), (e) => e.code === "invalid" && /invalid mount path/.test(e.message), path);
    }
    await assert.rejects(set("alice", [{ path: "/srv/x", mode: "rwx" }]), /invalid mount mode/);
    await assert.rejects(set("alice", [null]), /invalid mount path/);
    assert.deepEqual(reloaded, [], "nothing changed until the list is valid");
    const mounts = [{ path: "/srv/x", mode: "ro" }, { path: home, mode: "rw" }];
    // The answer and the list say what the host holds now: the temporary home is there, /srv/x is not.
    const state = [{ path: "/srv/x", mode: "ro", present: false, kind: "none" }, { path: home, mode: "rw", present: true, kind: "dir" }];
    assert.deepEqual(await set("alice", mounts), state);
    assert.deepEqual(env.records.mounts.get("alice"), mounts, "written to the kernel's record");
    assert.deepEqual(reloaded, ["alice"], "the fence is reopened so it binds the mounts");
    assert.deepEqual(journal, [{ kind: "mounts", target: "alice", data: { mounts } }], "the operator: no actor on the row, the kernel writes the default");
    assert.deepEqual(await grants.mountsList({ user: "alice" }, env), { alice: state });
    assert.deepEqual(await grants.mountsList({}, env), { alice: state });
    // Through an admin's fence the row names the admin.
    await grants.mountsSet({ user: "alice", mounts: [mounts[1]], actor: "root" }, env);
    assert.equal(journal.at(-1).actor, "root");
    await set("alice", []);
    assert.deepEqual(await grants.mountsList({}, env), {}, "an empty list removes the entry");
    // browse: the operator sees the host filesystem, and learns what a path is when it is not a directory.
    mkdirSync(join(home, "repos"));
    mkdirSync(join(home, ".hidden"));
    writeFileSync(join(home, "note.txt"), "");
    const listing = await grants.mountsBrowse({ path: home }, env);
    assert.equal(listing.readable, true);
    assert.equal(listing.parent, join(home, ".."), "the parent is where the picker goes up to");
    assert.deepEqual(listing.entries, [{ name: "repos", path: join(home, "repos") }], "hidden names are left out");
    assert.deepEqual((await grants.mountsBrowse({ path: home, all: "true" }, env)).entries.map((e) => e.name), [".hidden", "repos"]);
    assert.equal((await grants.mountsBrowse({ path: "/srv/x" }, env)).kind, "none");
    assert.equal((await grants.mountsBrowse({ path: join(home, "note.txt") }, env)).kind, "file");
    assert.equal((await grants.mountsBrowse({}, env)).path, "/", "no path is the root");
    await assert.rejects(grants.mountsBrowse({ path: "relative" }, env), /absolute and normalized/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sshSet and sshList: the same checks as mounts, the journal names key paths only, and presence tells a key that is there from one written down", async () => {
  const { env, home, journal, reloaded } = fakeEnv();
  try {
    const set = (user, ssh) => grants.sshSet({ user, ssh }, env);
    await assert.rejects(set("nobody", []), code("not-found"));
    await assert.rejects(set("_system", []), /takes no ssh/);
    await assert.rejects(set("alice", "nope"), /at most 16/);
    await assert.rejects(set("alice", [{ key: "relative" }]), /absolute and normalized/);
    await assert.rejects(set("alice", [{ key: "/k", hosts: "github.com" }]), /a list of known_hosts lines/);
    assert.deepEqual(reloaded, []);
    const made = await grants.sshKeygen({ user: "alice" }, env);
    const ssh = [{ key: made.key, hosts: ["github.com ssh-ed25519 AAAA", " ", "github.com ssh-ed25519 AAAA"] }, { key: "/nowhere/id_ed25519" }];
    const after = await set("alice", ssh);
    assert.deepEqual(after, [
      { key: made.key, hosts: ["github.com ssh-ed25519 AAAA", "github.com ssh-ed25519 AAAA"], present: true, publicKey: made.publicKey, fingerprint: made.fingerprint },
      { key: "/nowhere/id_ed25519", present: false, publicKey: null, fingerprint: null },
    ]);
    assert.deepEqual(journal.at(-1), { kind: "ssh", target: "alice", data: { ssh: [made.key, "/nowhere/id_ed25519"] } }, "paths, never material");
    assert.deepEqual(reloaded, ["alice", "alice"]);
    assert.deepEqual(await grants.sshList({ user: "alice" }, env), { alice: after });
    assert.deepEqual(Object.keys(await grants.sshList({}, env)), ["alice"]);
    await set("alice", []);
    assert.deepEqual(await grants.sshList({}, env), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sshKeygen and sshImport: the key lands under <home>/fence-keys/<user>, is granted with its hosts in place of any grant of the same path, and nobody unknown gets one", async () => {
  const { env, home, journal, reloaded } = fakeEnv();
  try {
    await assert.rejects(grants.sshKeygen({ user: "nobody" }, env), code("not-found"));
    await assert.rejects(grants.sshKeygen({ user: "_system" }, env), /takes no ssh/);
    assert.equal(existsSync(join(home, "fence-keys")), false, "a refused keygen writes nothing");
    const made = await grants.sshKeygen({ user: "alice", ssh: [{ key: "/generated", hosts: ["github.com ssh-ed25519 AAAA"] }] }, env);
    assert.equal(made.key, join(home, "fence-keys", "alice", "id_ed25519"));
    assert.match(made.publicKey, /^ssh-ed25519 \S+ thetis-alice$/);
    assert.match(made.fingerprint ?? "", /^SHA256:/);
    assert.equal(statSync(made.key).mode & 0o777, 0o600);
    assert.deepEqual(env.records.ssh.get("alice"), [{ key: made.key, hosts: ["github.com ssh-ed25519 AAAA"] }]);
    assert.deepEqual(journal.at(-1), { kind: "ssh", target: "alice", data: { ssh: [made.key] } });
    assert.deepEqual(reloaded, ["alice"]);
    // Again: the same key, kept, and the grant replaced rather than doubled; no hosts this time means none.
    const again = await grants.sshKeygen({ user: "alice" }, env);
    assert.equal(again.publicKey, made.publicKey);
    assert.deepEqual(env.records.ssh.get("alice"), [{ key: made.key }]);
    // Import: the material is written once under the name, the answer is the public half, the journal the path.
    const material = readFileSync(made.key, "utf8");
    await assert.rejects(grants.sshImport({ user: "nobody", name: "github", privateKey: material }, env), code("not-found"));
    await assert.rejects(grants.sshImport({ user: "alice", name: "../x", privateKey: material }, env), /one plain name/);
    await assert.rejects(grants.sshImport({ user: "alice", name: "notes", privateKey: "hello" }, env), /not a private key/);
    const imported = await grants.sshImport({ user: "alice", name: "github", privateKey: material, hosts: ["gh ssh-ed25519 BBBB"], actor: "root" }, env);
    assert.equal(imported.key, join(home, "fence-keys", "alice", "github"));
    assert.equal(imported.publicKey, made.publicKey);
    assert.deepEqual(env.records.ssh.get("alice"), [{ key: made.key }, { key: imported.key, hosts: ["gh ssh-ed25519 BBBB"] }]);
    assert.deepEqual(journal.at(-1), { kind: "ssh", target: "alice", data: { ssh: [made.key, imported.key] }, actor: "root" });
    assert.ok(!JSON.stringify(journal).includes("PRIVATE KEY"), "no material in any row");
    await assert.rejects(grants.sshImport({ user: "alice", name: "github", privateKey: material }, env), /already exists/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

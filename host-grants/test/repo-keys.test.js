// Repository keys over a fake env, with no network: `scan: false` and explicit hosts at the exports, a fake
// ssh-keyscan and a fake git for the mechanism. The key lands at fence-keys/_system/<alias>, the grant is the
// system's and carries its repo, a person's grant never does, and the journal never carries material.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoute } from "@thetis/runtime/lib/git-url";
import * as grants from "../index.js";
import { directUrl, keyscan, mergeHosts, routeOf, testKey } from "../lib/repo-keys.js";
import { parseSshGrants } from "../lib/ssh.js";
import { code, fakeEnv } from "./helpers.js";

const REPO = "git@github.com:thirteen-games/thetis-packages.git";
const HOST = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

/** A script on disk standing in for a command: prints `out` and `err`, records its arguments, exits `status`. */
function fakeCommand(dir, name, { out = "", err = "", status = 0 } = {}) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "$@" > "${path}.args"\nprintf '%s' '${out}'\nprintf '%s' '${err}' >&2\nexit ${status}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("repoKeygen, repoList, repoRevoke: the key is the installation's, at fence-keys/_system/<alias>, one per repository whatever the spelling", async () => {
  const { env, home, journal, reloaded } = fakeEnv();
  try {
    const alias = repoRoute(REPO).alias;
    await assert.rejects(grants.repoKeygen({ repo: "/srv/registry.git", scan: false }, env), code("invalid"));
    await assert.rejects(grants.repoKeygen({ repo: "", scan: false }, env), /not a hosted repository/);
    assert.equal(existsSync(join(home, "fence-keys")), false, "a refused keygen writes nothing");

    const made = await grants.repoKeygen({ repo: REPO, scan: false, hosts: [HOST, " "], actor: "root" }, env);
    const key = join(home, "fence-keys", "_system", alias);
    assert.equal(made.key, key);
    assert.equal(made.repo, REPO);
    assert.equal(made.alias, alias);
    assert.deepEqual(made.hosts, [HOST]);
    assert.equal(made.present, true);
    assert.match(made.publicKey, /^ssh-ed25519 \S+ thetis@github\.com\/thirteen-games\/thetis-packages$/);
    assert.match(made.fingerprint, /^SHA256:/);
    assert.deepEqual(env.records.ssh.get("_system"), [{ key, hosts: [HOST], repo: REPO }]);
    assert.deepEqual(journal.at(-1), { kind: "ssh", target: "_system", data: { repo: REPO, key }, actor: "root" });
    assert.deepEqual(reloaded, ["_system"]);
    assert.deepEqual(await grants.repoList({}, env), [made]);

    // Another spelling of the same repository: the same key, kept, and one grant; no hosts given keeps the old ones.
    const again = await grants.repoKeygen({ repo: "https://github.com/Thirteen-Games/thetis-packages", scan: false }, env);
    assert.equal(again.publicKey, made.publicKey, "an existing key survives: it may already be a deploy key");
    assert.equal(env.records.ssh.get("_system").length, 1);
    assert.deepEqual(again.hosts, [HOST]);

    // A second repository gets its own key.
    const other = await grants.repoKeygen({ repo: "git@github.com:thirteen-games/other.git", scan: false, hosts: [HOST] }, env);
    assert.notEqual(other.key, key);
    assert.notEqual(other.publicKey, made.publicKey);
    assert.equal((await grants.repoList({}, env)).length, 2);

    // The all-users ssh listing shows the system's grants with their repo.
    const listed = (await grants.sshList({}, env))._system;
    assert.deepEqual(listed.map((g) => g.repo), ["https://github.com/Thirteen-Games/thetis-packages", "git@github.com:thirteen-games/other.git"]);

    // Revoke with keepKey: the grant goes, the file stays; revoking again removes the kept file; a third time is not-found.
    const rest = await grants.repoRevoke({ repo: REPO, keepKey: true }, env);
    assert.deepEqual(rest.map((g) => g.repo), ["git@github.com:thirteen-games/other.git"]);
    assert.equal(existsSync(key), true);
    assert.deepEqual(reloaded.at(-1), "_system");
    await assert.rejects(grants.repoRevoke({ repo: REPO, keepKey: true }, env), code("not-found"));
    await grants.repoRevoke({ repo: REPO }, env);
    assert.equal(existsSync(key), false);
    assert.equal(existsSync(`${key}.pub`), false);
    await assert.rejects(grants.repoRevoke({ repo: REPO }, env), code("not-found"));
    assert.deepEqual(await grants.repoRevoke({ repo: "git@github.com:thirteen-games/other.git" }, env), []);
    assert.deepEqual(env.records.ssh.all(), {}, "no grants left: the system record is gone");
    assert.ok(!JSON.stringify(journal).includes("PRIVATE KEY"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("repoImport: the material lands once at the alias, is proved a key, and is never journalled; an existing file is refused", async () => {
  const { env, home, journal } = fakeEnv();
  try {
    const source = (await grants.sshKeygen({ user: "alice" }, env)).key;
    const material = readFileSync(source, "utf8");
    await assert.rejects(grants.repoImport({ repo: REPO, scan: false, privateKey: "hello" }, env), /not a private key/);
    const imported = await grants.repoImport({ repo: REPO, scan: false, hosts: [HOST], privateKey: material }, env);
    assert.equal(imported.key, join(home, "fence-keys", "_system", repoRoute(REPO).alias));
    assert.equal(imported.fingerprint, (await grants.sshList({ user: "alice" }, env)).alice[0].fingerprint);
    await assert.rejects(grants.repoImport({ repo: REPO, scan: false, privateKey: material }, env), /already exists/);
    assert.deepEqual(journal.at(-1), { kind: "ssh", target: "_system", data: { repo: REPO, key: imported.key } });
    assert.ok(!JSON.stringify(journal).includes("PRIVATE KEY"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the system takes only repository keys, and a person takes none", async () => {
  const { env, home } = fakeEnv();
  try {
    for (const call of [grants.sshSet({ user: "_system", ssh: [] }, env), grants.sshKeygen({ user: "_system" }, env), grants.sshImport({ user: "_system", name: "x", privateKey: "" }, env)]) {
      await assert.rejects(call, (e) => e.code === "invalid" && /takes no ssh: its keys are repository keys.*repoKeygen/.test(e.message));
    }
    await assert.rejects(grants.mountsSet({ user: "_system", mounts: [] }, env), /takes no mounts$/);
    await assert.rejects(grants.sshSet({ user: "alice", ssh: [{ key: "/k", repo: REPO }] }, env), /names no repository/);
    assert.throws(() => parseSshGrants([{ key: "/k" }], { system: true }), /names its repository/);
    assert.throws(() => parseSshGrants([{ key: "/k", repo: "/srv/local.git" }], { system: true }), /unusable repo/);
    assert.deepEqual(parseSshGrants([{ key: "/k", repo: ` ${REPO} ` }], { system: true }), [{ key: "/k", repo: REPO }]);
    await assert.rejects(grants.repoTest({ repo: REPO }, env), code("not-found"));
    await assert.rejects(grants.repoTest({ repo: "nope" }, env), code("invalid"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("keyscan: -T 10, the port when there is one, key lines only, and nothing found is a refusal", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-keyscan-"));
  try {
    const found = fakeCommand(dir, "keyscan", { out: `# github.com:22 SSH-2.0\n${HOST}\n\n`, err: "# github.com:22 SSH-2.0-babeld\n" });
    assert.deepEqual(keyscan(routeOf(REPO), { command: found }), [HOST]);
    assert.equal(readFileSync(`${found}.args`, "utf8").trim(), "-T 10 github.com");
    keyscan(routeOf("ssh://git@git.example.org:2222/o/r.git"), { command: found });
    assert.equal(readFileSync(`${found}.args`, "utf8").trim(), "-T 10 -p 2222 git.example.org");
    const none = fakeCommand(dir, "none", { err: "getaddrinfo nowhere: Name or service not known", status: 1 });
    assert.throws(() => keyscan(routeOf("git@nowhere:o/r.git"), { command: none }), /no host keys for nowhere: getaddrinfo/);
    assert.deepEqual(mergeHosts(["a", " b "], ["b", "", "c"]), ["a", "b", "c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("testKey: ls-remote HEAD over the direct ssh url with this key alone, git's own words on a refusal, and a timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-repotest-"));
  try {
    assert.equal(directUrl(REPO), "ssh://git@github.com/thirteen-games/thetis-packages.git");
    assert.equal(directUrl("ssh://deploy@git.example.org:2222/o/r"), "ssh://deploy@git.example.org:2222/o/r.git");
    // A git that echoes what it was handed: the arguments and the ssh command.
    const git = join(dir, "git");
    writeFileSync(git, `#!/bin/sh\necho "$@" > "${git}.args"\necho "$GIT_SSH_COMMAND|$GIT_TERMINAL_PROMPT|$SSH_AUTH_SOCK" > "${git}.env"\nprintf 'abc123\\tHEAD\\n'\n`);
    chmodSync(git, 0o755);
    const ok = await testKey({ key: "/keys/k", hosts: [HOST], url: directUrl(REPO), git });
    assert.deepEqual(ok, { ok: true, head: "abc123" });
    assert.equal(readFileSync(`${git}.args`, "utf8").trim(), "ls-remote ssh://git@github.com/thirteen-games/thetis-packages.git HEAD");
    const [ssh, prompt, sock] = readFileSync(`${git}.env`, "utf8").trim().split("|");
    for (const opt of ["-i '/keys/k'", "IdentitiesOnly=yes", "IdentityAgent=none", "BatchMode=yes", "ConnectTimeout=10", "StrictHostKeyChecking=yes", "UserKnownHostsFile="]) {
      assert.ok(ssh.includes(opt), `${opt} in ${ssh}`);
    }
    assert.equal(prompt, "0");
    assert.equal(sock, "", "no agent: the answer is about this key alone");

    const refused = fakeCommand(dir, "refused", { err: "git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n", status: 128 });
    assert.deepEqual(await testKey({ key: "/keys/k", url: "ssh://git@github.com/o/r.git", git: refused }), {
      ok: false,
      error: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    });

    const slow = join(dir, "slow");
    writeFileSync(slow, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(slow, 0o755);
    const t = Date.now();
    const late = await testKey({ key: "/keys/k", url: "ssh://git@github.com/o/r.git", git: slow, timeout: 300 });
    assert.equal(late.ok, false);
    assert.match(late.error, /no answer/);
    assert.ok(Date.now() - t < 5000, "gives up at the timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

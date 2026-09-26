// The ssh commands over a fake operator and a fake exec: what each sends the kernel, what each refuses
// before the kernel is asked, that key material never appears in a refusal, and how ssh-keyscan's and
// ssh's words come back. Then the browser module's pure helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as commands from "../index.js";

function fakeEnv(answers = {}, { user = "root", exec } = {}) {
  const calls = [];
  const env = {
    user,
    role: "admin",
    exec: exec ?? (async () => ({ code: 0, stdout: "", stderr: "" })),
    kernel: {
      operator: {
        call: async (method, args) => {
          calls.push({ method, args });
          if (answers[method] instanceof Error) throw answers[method];
          return typeof answers[method] === "function" ? answers[method](args) : answers[method] ?? null;
        },
      },
    },
  };
  return { env, calls };
}

const refuses = (fn, args, env, pattern) => assert.rejects(fn(args, env), pattern);

test("ssh-list passes through, for everyone or one person", async () => {
  const { env, calls } = fakeEnv({ "host.grants.sshList": (a) => (a.user ? { [a.user]: [] } : { bob: [{ key: "/k/id_ed25519", present: true }] }) });
  assert.deepEqual(await commands.sshList({}, env), { data: { bob: [{ key: "/k/id_ed25519", present: true }] } });
  assert.deepEqual(await commands.sshList({ user: "bob" }, env), { data: { bob: [] } });
  assert.deepEqual(calls.map((c) => c.args), [{}, { user: "bob" }]);
  await refuses(commands.sshList, { user: "Bob!" }, env, /lowercase letters/);
});

test("ssh-set sends the whole list and refuses what the kernel would", async () => {
  const { env, calls } = fakeEnv({ "host.grants.sshSet": (a) => a.ssh.map((g) => ({ ...g, present: true })) });
  const out = await commands.sshSet({ user: "bob", ssh: [{ key: "/home/k/id_ed25519", hosts: ["github.com ssh-ed25519 AAAA", " ", "github.com ssh-ed25519 AAAA"] }, { key: "/home/k/deploy" }] }, env);
  assert.deepEqual(calls[0].args, { user: "bob", ssh: [{ key: "/home/k/id_ed25519", hosts: ["github.com ssh-ed25519 AAAA"] }, { key: "/home/k/deploy" }] }, "hosts trimmed, deduplicated, and left out when empty");
  assert.equal(out.data.length, 2);
  await refuses(commands.sshSet, { user: "bob", ssh: [{ key: "relative/key" }] }, env, /absolute normalized path/);
  await refuses(commands.sshSet, { user: "bob", ssh: [{ key: "/a/../b" }] }, env, /absolute normalized path/);
  await refuses(commands.sshSet, { user: "bob", ssh: [{ key: "/" }] }, env, /absolute normalized path/);
  await refuses(commands.sshSet, { user: "bob", ssh: [{ key: "/k", hosts: "github.com" }] }, env, /list of known_hosts lines/);
  await refuses(commands.sshSet, { user: "bob", ssh: [{ key: "/k" }, { key: "/k" }] }, env, /listed twice/);
  await refuses(commands.sshSet, { user: "bob", ssh: Array.from({ length: 17 }, (_, i) => ({ key: `/k${i}` })) }, env, /at most 16/);
  await refuses(commands.sshSet, { user: "bob", ssh: "no" }, env, /at most 16/);
});

test("ssh-keygen asks for a generated key with the hosts given", async () => {
  const { env, calls } = fakeEnv({ "host.grants.sshKeygen": () => ({ key: "/home/fence-keys/bob/id_ed25519", publicKey: "ssh-ed25519 AAAA thetis-bob", fingerprint: "SHA256:x" }) });
  const out = await commands.sshKeygen({ user: "bob", hosts: ["github.com ssh-ed25519 AAAA", ""] }, env);
  assert.deepEqual(calls[0].args, { user: "bob", ssh: [{ key: "/generated", hosts: ["github.com ssh-ed25519 AAAA"] }] });
  assert.equal(out.data.publicKey, "ssh-ed25519 AAAA thetis-bob");
  await commands.sshKeygen({ user: "bob" }, env);
  assert.deepEqual(calls[1].args, { user: "bob", ssh: [{ key: "/generated" }] }, "no hosts: none sent");
  await refuses(commands.sshKeygen, { user: "bob", hosts: "github.com" }, env, /list of known_hosts lines/);
});

test("ssh-import checks the name and the shape of the material, and never repeats the material", async () => {
  const material = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETSECRETSECRET\n-----END OPENSSH PRIVATE KEY-----\n";
  const { env, calls } = fakeEnv({ "host.grants.sshImport": (a) => ({ key: `/home/fence-keys/bob/${a.name}`, publicKey: "ssh-ed25519 BBBB", fingerprint: "SHA256:y" }) });
  const out = await commands.sshImport({ user: "bob", name: "github", privateKey: material, hosts: ["github.com ssh-ed25519 AAAA"] }, env);
  assert.deepEqual(calls[0].args, { user: "bob", name: "github", privateKey: material, hosts: ["github.com ssh-ed25519 AAAA"] });
  assert.equal(out.data.key, "/home/fence-keys/bob/github");
  for (const [args, pattern] of [
    [{ user: "bob", name: "Git Hub", privateKey: material }, /key name is lowercase/],
    [{ user: "bob", name: "github", privateKey: "" }, /private key is missing/],
    [{ user: "bob", name: "github", privateKey: "ssh-ed25519 AAAA not a private key" }, /no PRIVATE KEY line/],
    [{ user: "bob", name: "github", privateKey: "PRIVATE KEY ".repeat(2000) }, /longer than 16 KB/],
  ]) {
    await assert.rejects(commands.sshImport(args, env), (err) => {
      assert.match(err.message, pattern);
      assert.ok(!err.message.includes("SECRET") && !err.message.includes("AAAA"), "a refusal never carries the material");
      return true;
    });
  }
  assert.equal(calls.length, 1, "a refused import never reaches the kernel");
});

test("ssh-scan runs ssh-keyscan in this fence and parses its lines; a bad host never reaches the shell", async () => {
  const ran = [];
  const { env } = fakeEnv({}, { exec: async (cmd) => { ran.push(cmd); return { code: 0, stdout: "# github.com:22 SSH-2.0\ngithub.com ssh-ed25519 AAAAC3\ngithub.com ssh-rsa AAAAB3\n\n", stderr: "" }; } });
  const out = await commands.sshScan({ host: "github.com" }, env);
  assert.deepEqual(out.data, { host: "github.com", lines: ["github.com ssh-ed25519 AAAAC3", "github.com ssh-rsa AAAAB3"] });
  assert.equal(ran[0], "ssh-keyscan -T 5 github.com");
  await commands.sshScan({ host: "git.example.org:2222" }, env);
  assert.equal(ran[1], "ssh-keyscan -T 5 -p 2222 git.example.org");
  for (const host of ["github.com; rm -rf /", "$(id)", "a b", "", "-oProxyCommand=x"]) await refuses(commands.sshScan, { host }, env, /hostname/);
  assert.equal(ran.length, 2);
  const empty = fakeEnv({}, { exec: async () => ({ code: 1, stdout: "", stderr: "getaddrinfo nope: Name or service not known" }) });
  await refuses(commands.sshScan, { host: "nope.invalid" }, empty.env, /found nothing for nope.invalid: getaddrinfo/);
});

test("ssh-test answers ssh's exit code and words, for the admin's own workspace", async () => {
  const ran = [];
  const { env } = fakeEnv({}, { exec: async (cmd) => { ran.push(cmd); return { code: 1, stdout: "", stderr: "Hi bitmuse! You've successfully authenticated, but GitHub does not provide shell access.\n" }; } });
  const out = await commands.sshTest({ target: "git@github.com" }, env);
  assert.deepEqual(out.data, { target: "git@github.com", code: 1, output: "Hi bitmuse! You've successfully authenticated, but GitHub does not provide shell access." });
  assert.equal(ran[0], "ssh -T -o BatchMode=yes -o ConnectTimeout=10 git@github.com");
  await refuses(commands.sshTest, { target: "git@github.com && whoami" }, env, /user@host/);
  await refuses(commands.sshTest, { host: "github.com" }, env, /user@host/);
});

test("the section's helpers: the host of a known_hosts line, a grant's hosts, a key's name", async () => {
  const { hostOfLine, hostsOf, keyName } = await import("../ui/ssh.js");
  assert.equal(hostOfLine("github.com ssh-ed25519 AAAA"), "github.com");
  assert.equal(hostOfLine("[git.example.org]:2222,10.0.0.1 ssh-rsa BBBB"), "[git.example.org]:2222");
  assert.equal(hostOfLine(""), "");
  assert.deepEqual(hostsOf({ key: "/k", hosts: ["github.com ssh-ed25519 A", "github.com ssh-rsa B", "gitlab.com ssh-ed25519 C"] }), ["github.com", "gitlab.com"]);
  assert.deepEqual(hostsOf({ key: "/k" }), []);
  assert.equal(keyName("/home/fence-keys/bob/id_ed25519"), "id_ed25519");
});

test("a key of the person's own is one under their fence-keys directory; anything else an admin granted", async () => {
  const { isOwnKey } = await import("../ui/ssh.js");
  assert.equal(isOwnKey("/opt/zero/data/fence-keys/bob/id_ed25519", "bob"), true);
  assert.equal(isOwnKey("/opt/zero/data/fence-keys/bob/github", "bob"), true);
  assert.equal(isOwnKey("/opt/zero/data/fence-keys/bobby/id_ed25519", "bob"), false, "another person's directory is not bob's");
  assert.equal(isOwnKey("/opt/zero/data/fence-keys/alice/id_ed25519", "bob"), false);
  assert.equal(isOwnKey("/home/alice/.ssh/deploy", "bob"), false);
  assert.equal(isOwnKey("/opt/zero/data/fence-keys/bob/id_ed25519", ""), false);
  assert.equal(isOwnKey("", "bob"), false);
});

test("a user's ssh verbs pass their own id through; the kernel pins it whatever is sent", async () => {
  const { env, calls } = fakeEnv({ "host.grants.sshList": (a) => ({ [a.user]: [] }), "host.grants.sshSet": () => [] }, { user: "bob" });
  env.role = "user";
  assert.deepEqual(await commands.sshList({ user: "bob" }, env), { data: { bob: [] } });
  await commands.sshSet({ user: "bob", ssh: [] }, env);
  assert.deepEqual(calls.map((c) => [c.method, c.args.user]), [["host.grants.sshList", "bob"], ["host.grants.sshSet", "bob"]]);
});

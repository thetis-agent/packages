// The Registries verbs over a fake operator: every one is declared for admins only, the list is the
// configured registries merged with host-grants' repository keys and the index's last refresh, and each
// write sends exactly the config.set and host.grants calls it should -- with a refused argument reaching
// nothing, and a private key never echoed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as commands from "../index.js";
import { deployKeysUrl } from "../lib/registries.js";
import { authBadgeOf, refreshLine } from "../ui/registries.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = "https://github.com/thetis-agent/packages.git";
const PRIVATE = "git@github.com:thirteen-games/thetis-packages.git";
const MATERIAL = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA-hunter2\n-----END OPENSSH PRIVATE KEY-----\n";
const VERBS = ["registries", "registry-add", "registry-edit", "registry-remove", "registry-key", "registry-key-revoke", "registry-test"];

const keyState = (repo, extra = {}) => ({ repo, key: `/home/fence-keys/_system/thetis-repo-${repo.length}`, alias: "thetis-repo-abc", present: true, publicKey: "ssh-ed25519 AAAAC3Nz thetis", fingerprint: "SHA256:abc", hosts: ["github.com ssh-ed25519 AAAA"], ...extra });

/**
 * An admin's env: `registries` is the configured value (undefined leaves the manifest default in place),
 * `keys` what host-grants holds, `index` the marketplace index in the shared directory. config.set and the
 * repo verbs change the fakes, so a later read in the same verb sees the write, as the kernel's would.
 */
function fakeEnv({ registries, keys = [], index, repoList } = {}) {
  const shared = mkdtempSync(join(tmpdir(), "ui-market-reg-"));
  mkdirSync(join(shared, "marketplace"), { recursive: true });
  if (index) writeFileSync(join(shared, "marketplace", "index.json"), JSON.stringify(index));
  let value = registries ?? [{ name: "thetis", url: PUBLIC }];
  let source = registries ? "system" : "default";
  let held = [...keys];
  const calls = [];
  const answers = {
    "config.show": () => ({ package: "@thetis/marketplace", inherits: [], keys: [{ key: "registries", state: "set", value, source, secret: false, declared: true }, { key: "refreshMinutes", state: "set", value: 30, source: "default", secret: false, declared: true }], summary: "every key is set", broken: false }),
    "config.set": (a) => ((value = a.value), (source = "system"), { package: a.name, keys: [], inherits: [], summary: "", broken: false }),
    "host.grants.repoList": repoList ?? (() => held),
    "host.grants.repoKeygen": (a) => {
      const k = held.find((x) => x.repo === a.repo) ?? keyState(a.repo);
      held = [...held.filter((x) => x !== k), k];
      return k;
    },
    "host.grants.repoImport": (a) => {
      const k = keyState(a.repo, { fingerprint: "SHA256:imported" });
      held.push(k);
      return k;
    },
    "host.grants.repoRevoke": (a) => ((held = held.filter((k) => k.repo !== a.repo)), held),
    "host.grants.repoTest": (a) => (a.repo === PRIVATE ? { repo: a.repo, ok: true, head: "a".repeat(40) } : { repo: a.repo, ok: false, error: "ERROR: Repository not found." }),
  };
  const env = {
    user: "root",
    role: "admin",
    shared,
    readFile: (p) => import("node:fs/promises").then((fs) => fs.readFile(p, "utf8")),
    kernel: {
      operator: {
        call: async (method, args) => {
          calls.push({ method, args });
          const answer = answers[method];
          if (!answer) throw new Error(`unexpected operator call ${method}`);
          return answer(args);
        },
      },
    },
  };
  const writes = () => calls.filter((c) => c.method !== "config.show" && c.method !== "host.grants.repoList");
  return { env, calls, writes, cleanup: () => rmSync(shared, { recursive: true, force: true }) };
}

test("every registry verb is declared for admins only, so the gateway answers 403 to anybody else before this code runs", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const declared = manifest.thetis.ui.commands.filter((c) => VERBS.includes(c.verb));
  assert.deepEqual(declared.map((c) => c.verb).sort(), [...VERBS].sort());
  for (const c of declared) {
    assert.equal(c.role, "admin", `${c.verb} must carry role: "admin"`);
    assert.equal(typeof commands[c.export], "function", `${c.verb} names an export that exists`);
  }
});

test("registries: the configured list merged with the repository keys and the index's last refresh; a key no registry names is listed apart", async () => {
  const index = { version: 1, updatedAt: "2026-09-23T00:00:00.000Z", registries: [{ name: "thetis", url: PUBLIC, commit: "c".repeat(40) }, { name: "team", url: PRIVATE, error: "git clone failed: Permission denied (publickey)." }], packages: [] };
  // The key was made under another spelling of the same repository: sameRepository matches it.
  const t = fakeEnv({ registries: [{ name: "thetis", url: PUBLIC }, { name: "team", url: PRIVATE, note: "kept" }, { url: "/srv/local-reg.git" }], keys: [keyState("ssh://git@github.com/Thirteen-Games/thetis-packages"), keyState("git@gitlab.com:x/y.git", { present: false })], index });
  try {
    const data = (await commands.registries({}, t.env)).data;
    assert.equal(data.source, "system");
    assert.equal(data.updatedAt, "2026-09-23T00:00:00.000Z");
    assert.equal(data.keysError, null);
    const [pub, team, local] = data.registries;
    assert.deepEqual([pub.name, pub.auth, pub.key, pub.error, pub.commit, pub.keyable], ["thetis", "none", null, null, "c".repeat(40), true]);
    assert.equal(pub.deployKeysUrl, "https://github.com/thetis-agent/packages/settings/keys");
    assert.equal(team.auth, "ssh");
    assert.deepEqual(team.key, { repo: "ssh://git@github.com/Thirteen-Games/thetis-packages", alias: "thetis-repo-abc", present: true, publicKey: "ssh-ed25519 AAAAC3Nz thetis", fingerprint: "SHA256:abc", hosts: 1 }, "the public part only: the key's host path is not the page's business");
    assert.equal(team.error, "git clone failed: Permission denied (publickey).");
    assert.equal(team.deployKeysUrl, "https://github.com/thirteen-games/thetis-packages/settings/keys");
    assert.deepEqual([local.name, local.auth, local.keyable, local.deployKeysUrl], ["local-reg", "none", false, null], "a nameless entry takes slugOfUrl; a local path cannot take a key");
    assert.deepEqual(data.orphans.map((k) => [k.repo, k.present, k.deployKeysUrl]), [["git@gitlab.com:x/y.git", false, null]]);
    assert.deepEqual(t.writes(), [], "reading writes nothing");
  } finally {
    t.cleanup();
  }
});

test("registries: the shipped default is listed like any other, and host-grants failing still shows the registries with the reason", async () => {
  const t = fakeEnv({ repoList: () => Promise.reject(new Error("host.grants.repoList is not a method")) });
  try {
    const data = (await commands.registries({}, t.env)).data;
    assert.equal(data.source, "default");
    assert.deepEqual(data.registries.map((r) => [r.name, r.url, r.auth]), [["thetis", PUBLIC, "none"]]);
    assert.equal(data.keysError, "host.grants.repoList is not a method");
    assert.equal(data.updatedAt, null, "no index is no refresh, not a failure");
  } finally {
    t.cleanup();
  }
});

test("registry-add: the key first, then the whole list through config.set; the name defaults to the url's slug", async () => {
  const t = fakeEnv();
  try {
    const out = (await commands.registryAdd({ url: PRIVATE, auth: "generate" }, t.env)).data;
    assert.equal(out.name, "thetis-packages");
    assert.equal(out.key.fingerprint, "SHA256:abc");
    assert.equal(out.deployKeysUrl, "https://github.com/thirteen-games/thetis-packages/settings/keys");
    assert.deepEqual(out.registries.map((r) => [r.name, r.auth]), [["thetis", "none"], ["thetis-packages", "ssh"]], "the answer is the section again, drawn from the new facts");
    assert.deepEqual(t.writes(), [
      { method: "host.grants.repoKeygen", args: { repo: PRIVATE } },
      { method: "config.set", args: { name: "@thetis/marketplace", key: "registries", value: [{ name: "thetis", url: PUBLIC }, { name: "thetis-packages", url: PRIVATE }] } },
    ]);
  } finally {
    t.cleanup();
  }
});

test("registry-add: a pasted key goes to repoImport and nowhere else; none sends no host call at all", async () => {
  const t = fakeEnv({ registries: [] });
  try {
    await commands.registryAdd({ name: "team", url: PRIVATE, auth: "import", privateKey: MATERIAL }, t.env);
    await commands.registryAdd({ name: "open", url: "https://git.example.com/o/r.git" }, t.env);
    assert.deepEqual(t.writes(), [
      { method: "host.grants.repoImport", args: { repo: PRIVATE, privateKey: MATERIAL } },
      { method: "config.set", args: { name: "@thetis/marketplace", key: "registries", value: [{ name: "team", url: PRIVATE }] } },
      { method: "config.set", args: { name: "@thetis/marketplace", key: "registries", value: [{ name: "team", url: PRIVATE }, { name: "open", url: "https://git.example.com/o/r.git" }] } },
    ]);
  } finally {
    t.cleanup();
  }
});

test("registry-add: what is refused reaches nothing, and a refusal never echoes the key", async () => {
  const t = fakeEnv();
  try {
    await assert.rejects(commands.registryAdd({}, t.env), /needs a url/);
    await assert.rejects(commands.registryAdd({ url: "git@github.com:o/r.git", name: "bad name" }, t.env), /registry name is/);
    await assert.rejects(commands.registryAdd({ url: "git@github.com:o/r.git", auth: "password" }, t.env), /auth is none, generate or import/);
    await assert.rejects(commands.registryAdd({ url: "/srv/reg.git", auth: "generate" }, t.env), /not a hosted git url/);
    await assert.rejects(commands.registryAdd({ url: "https://github.com/thetis-agent/packages" }, t.env), /thetis is already that repository/);
    await assert.rejects(commands.registryAdd({ url: "git@github.com:o/r.git", name: "thetis" }, t.env), /already called thetis/);
    const err = await commands.registryAdd({ url: PRIVATE, auth: "import", privateKey: "hunter2-not-a-key" }, t.env).then(() => null, (e) => e);
    assert.match(err.message, /does not look like a private key/);
    assert.ok(!err.message.includes("hunter2"));
    assert.deepEqual(t.writes(), []);
  } finally {
    t.cleanup();
  }
});

test("registry-remove: the list without it, then its key revoked -- kept on request, left alone when another registry names the repository", async () => {
  const t = fakeEnv({ registries: [{ name: "thetis", url: PUBLIC }, { name: "team", url: PRIVATE }, { name: "open", url: "https://git.example.com/o/r.git" }], keys: [keyState(PRIVATE)] });
  try {
    const out = (await commands.registryRemove({ name: "team", keepKey: true }, t.env)).data;
    assert.deepEqual([out.removed, out.revoked, out.keptKey], ["team", PRIVATE, true]);
    await commands.registryRemove({ name: "open" }, t.env);
    assert.deepEqual(t.writes(), [
      { method: "config.set", args: { name: "@thetis/marketplace", key: "registries", value: [{ name: "thetis", url: PUBLIC }, { name: "open", url: "https://git.example.com/o/r.git" }] } },
      { method: "host.grants.repoRevoke", args: { repo: PRIVATE, keepKey: true } },
      { method: "config.set", args: { name: "@thetis/marketplace", key: "registries", value: [{ name: "thetis", url: PUBLIC }] } },
    ], "a registry without a key revokes nothing");
    await assert.rejects(commands.registryRemove({ name: "nope" }, t.env), /no registry is called nope/);
  } finally {
    t.cleanup();
  }
  const shared = fakeEnv({ registries: [{ name: "a", url: PRIVATE }, { name: "b", url: "https://github.com/thirteen-games/thetis-packages" }], keys: [keyState(PRIVATE)] });
  try {
    assert.equal((await commands.registryRemove({ name: "a" }, shared.env)).data.revoked, null);
    assert.deepEqual(shared.writes().map((c) => c.method), ["config.set"], "the other registry still reads that repository with the key");
  } finally {
    shared.cleanup();
  }
});

test("registry-key, registry-key-revoke and registry-test act on the configured url, never one the browser sends", async () => {
  const t = fakeEnv({ registries: [{ name: "team", url: PRIVATE }, { name: "local", url: "/srv/reg.git" }], keys: [keyState("git@gitlab.com:x/y.git")] });
  try {
    const keyed = (await commands.registryKey({ name: "team", auth: "generate", url: "git@evil.example:o/r.git" }, t.env)).data;
    assert.equal(keyed.registries[0].auth, "ssh");
    const tested = (await commands.registryTest({ name: "team" }, t.env)).data;
    assert.deepEqual(tested, { name: "team", ok: true, head: "a".repeat(40), error: null });
    await commands.registryKeyRevoke({ name: "team" }, t.env);
    await commands.registryKeyRevoke({ repo: "git@gitlab.com:x/y.git", keepKey: true }, t.env);
    assert.deepEqual(t.writes(), [
      { method: "host.grants.repoKeygen", args: { repo: PRIVATE } },
      { method: "host.grants.repoTest", args: { repo: PRIVATE } },
      { method: "host.grants.repoRevoke", args: { repo: PRIVATE, keepKey: false } },
      { method: "host.grants.repoRevoke", args: { repo: "git@gitlab.com:x/y.git", keepKey: true } },
    ]);
    await assert.rejects(commands.registryKey({ name: "local", auth: "generate" }, t.env), /not a hosted git url/);
    await assert.rejects(commands.registryKey({ name: "team", auth: "none" }, t.env), /registry-key-revoke/);
    await assert.rejects(commands.registryKeyRevoke({ repo: "git@github.com:o/unknown.git" }, t.env), /no repository key is held/);
    await assert.rejects(commands.registryKeyRevoke({}, t.env), /name the registry/);
    assert.equal(t.writes().length, 4, "refusals reach nothing");
  } finally {
    t.cleanup();
  }
});

test("registry-test: a refused read comes back as git's own words", async () => {
  const t = fakeEnv({ registries: [{ name: "open", url: "https://github.com/o/r.git" }] });
  try {
    assert.deepEqual((await commands.registryTest({ name: "open" }, t.env)).data, { name: "open", ok: false, head: null, error: "ERROR: Repository not found." });
  } finally {
    t.cleanup();
  }
});

test("registry-edit: renames and re-points a registry; one holding a key cannot move to another repository", async () => {
  const t = fakeEnv({ registries: [{ name: "thetis", url: PUBLIC }, { name: "team", url: PRIVATE, extra: 1 }], keys: [keyState(PRIVATE)] });
  try {
    await commands.registryEdit({ name: "thetis", newName: "upstream", url: "https://github.com/thetis-agent/packages-next.git" }, t.env);
    await commands.registryEdit({ name: "team", newName: "private", url: "ssh://git@github.com/thirteen-games/thetis-packages.git" }, t.env);
    assert.deepEqual(t.writes(), [
      { method: "config.set", args: { name: "@thetis/marketplace", key: "registries", value: [{ name: "upstream", url: "https://github.com/thetis-agent/packages-next.git" }, { name: "team", url: PRIVATE, extra: 1 }] } },
      { method: "config.set", args: { name: "@thetis/marketplace", key: "registries", value: [{ name: "upstream", url: "https://github.com/thetis-agent/packages-next.git" }, { name: "private", url: "ssh://git@github.com/thirteen-games/thetis-packages.git", extra: 1 }] } },
    ], "another spelling of the same repository keeps its key");
    await assert.rejects(commands.registryEdit({ name: "private", url: "git@github.com:o/other.git" }, t.env), /revoke it before pointing/);
    await assert.rejects(commands.registryEdit({ name: "upstream", newName: "private" }, t.env), /already called private/);
    await assert.rejects(commands.registryEdit({ name: "upstream" }, t.env), /nothing changed/);
  } finally {
    t.cleanup();
  }
});

test("the page's words: the deploy keys link is GitHub's only, and the badges say what the facts say", () => {
  assert.equal(deployKeysUrl("git@github.com:Thirteen-Games/Thetis-Packages.git"), "https://github.com/Thirteen-Games/Thetis-Packages/settings/keys", "the path keeps its case, as written");
  assert.equal(deployKeysUrl("git@gitlab.com:o/r.git"), null);
  assert.equal(deployKeysUrl("/srv/reg.git"), null);
  assert.deepEqual(authBadgeOf({ auth: "none", key: null }), { text: "no authentication", tone: "dim" });
  assert.deepEqual(authBadgeOf({ auth: "ssh", key: { present: true } }), { text: "SSH key", tone: "ok" });
  assert.deepEqual(authBadgeOf({ auth: "ssh", key: { present: false } }), { text: "SSH · key missing", tone: "err" });
  assert.equal(refreshLine({ error: "boom" }).tone, "err");
  assert.equal(refreshLine({ commit: "abcdef0123" }).text, "Mirrored at abcdef0.");
  assert.equal(refreshLine({}).tone, "dim");
});

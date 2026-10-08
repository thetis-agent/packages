// Smoke test: policy and splitting offline, then the tools against the local gcloud
// (no credentials needed: help, lint, status and a refused command).
import assert from "node:assert/strict";
import { exec as cpExec } from "node:child_process";
import { writeFile } from "node:fs/promises";
import * as m from "./index.js";

let failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

function makeEnv(config = {}) {
  return {
    config,
    cwd: process.cwd(),
    writeFile: (p, s) => writeFile(p, s),
    exec: (cmd, opts = {}) => new Promise((res) => {
      cpExec(cmd, { cwd: opts.cwd, timeout: opts.timeoutMs, env: { ...process.env, ...(opts.env ?? {}) }, maxBuffer: 64 << 20 },
        (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    }),
  };
}

await t("splitArgs honours quotes and ignores operators", () => {
  assert.deepEqual(m.splitArgs(`logging read "severity>=ERROR AND x='y'" --limit=5 | head`),
    ["logging", "read", "severity>=ERROR AND x='y'", "--limit=5", "|", "head"]);
  assert.deepEqual(m.splitArgs(`a 'b c' d\\ e`), ["a", "b c", "d e"]);
  assert.throws(() => m.splitArgs(`a "b`));
});

await t("argsOf strips a leading gcloud", () => {
  assert.deepEqual(m.argsOf({ command: "gcloud projects list" }), ["projects", "list"]);
  assert.deepEqual(m.argsOf({ args: ["projects", "list"] }), ["projects", "list"]);
  assert.throws(() => m.argsOf({}));
});

await t("always-denied covers every release track", () => {
  assert.match(m.checkPolicy("compute ssh"), /always refused/);
  assert.match(m.checkPolicy("beta compute ssh"), /always refused/);
  assert.match(m.checkPolicy("auth print-access-token"), /always refused/);
  assert.equal(m.checkPolicy("auth list"), null);
  assert.equal(m.checkPolicy("compute instances list"), null);
});

await t("deny: GA denies all tracks, alpha only alpha", () => {
  const cfg = { deny: ["compute instances delete", "alpha"] };
  assert.ok(m.checkPolicy("compute instances delete", cfg));
  assert.ok(m.checkPolicy("beta compute instances delete", cfg));
  assert.ok(m.checkPolicy("alpha run services list", cfg));
  assert.equal(m.checkPolicy("beta run services list", cfg), null);
});

await t("allow admits exactly its track; string lists parse", () => {
  const cfg = { allow: "compute instances, beta run" };
  assert.equal(m.checkPolicy("compute instances list", cfg), null);
  assert.ok(m.checkPolicy("beta compute instances list", cfg));
  assert.equal(m.checkPolicy("beta run services list", cfg), null);
  assert.ok(m.checkPolicy("run services list", cfg));
  assert.equal(m.checkPolicy("projects list", { allow: '["projects"]' }), null);
});

await t("read-only mode", () => {
  const cfg = { mode: "read-only" };
  assert.equal(m.checkPolicy("compute instances list", cfg), null);
  assert.equal(m.checkPolicy("projects get-iam-policy", cfg), null);
  assert.match(m.checkPolicy("compute instances delete", cfg), /read-only/);
  assert.match(m.checkPolicy("run deploy", cfg), /read-only/);
});

const env = makeEnv();
await t("lint parses the command path from a real gcloud", async () => {
  const l = await m.lint(env, ["compute", "--project=x", "instances", "list", "--zones=a"]);
  assert.deepEqual(l, { ok: true, path: "compute instances list" });
  const bad = await m.lint(env, ["compute", "instances", "list", "--zone=a"]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /UnrecognizedArguments/);
});

await t("gcloud_run refuses a denied command without running it", async () => {
  const r = await m.gcloudRun({ args: ["beta", "compute", "ssh", "vm-1", "--zone=a"] }, env);
  assert.match(r, /^refused: .*always refused/);
});

await t("gcloud_run refuses a malformed command", async () => {
  const r = await m.gcloudRun({ command: "compute instances list --zone=a" }, env);
  assert.match(r, /refused before running/);
});

await t("gcloud_run dry_run and read-only", async () => {
  const r = await m.gcloudRun({ args: ["compute", "instances", "delete", "vm-1", "--zone=a"], dry_run: true }, env);
  assert.match(r, /^would run: gcloud compute instances delete/);
  const ro = await m.gcloudRun({ args: ["compute", "instances", "delete", "vm-1", "--zone=a"] }, makeEnv({ mode: "read-only" }));
  assert.match(ro, /read-only/);
});

await t("gcloud_run runs a harmless command and quotes shell characters", async () => {
  const r = await m.gcloudRun({ args: ["config", "get-value", "core/disable_usage_reporting;echo PWNED"] }, env);
  assert.match(r, /^\$ gcloud config get-value/);
  assert.doesNotMatch(r.replace(/^\$.*$/m, ""), /^PWNED$/m);
});

await t("gcloud_run passes the project setting as environment", async () => {
  const r = await m.gcloudRun({ args: ["config", "get-value", "project"] }, makeEnv({ project: "my-proj-123" }));
  assert.match(r, /exit 0/);
  assert.match(r, /my-proj-123/);
});

await t("gcloud_help returns the synopsis", async () => {
  const r = await m.gcloudHelp({ command: "compute instances list" }, env);
  assert.match(r, /SYNOPSIS/);
  await assert.rejects(m.gcloudHelp({ command: "compute instances list --zone=a" }, env));
});

await t("gcloud_status reports version, accounts and policy", async () => {
  const r = await m.gcloudStatus({}, makeEnv({ deny: ["iam"], mode: "read-only" }));
  assert.match(r, /^gcloud \d/);
  assert.match(r, /accounts: /);
  assert.match(r, /mode: read-only/);
  assert.match(r, /deny: iam/);
});

await t("credentialsJson is written for the call and removed after", async () => {
  const fake = JSON.stringify({ type: "service_account", project_id: "p", client_email: "x@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----\n" });
  const e = makeEnv({ credentialsJson: fake });
  const r = await m.runGcloud(e, ["config", "get-value", "auth/credential_file_override"]);
  const path = String(r.stdout).trim();
  assert.match(path, /thetis-gcloud\/k\.[^/]+\/key\.json$/);
  const gone = await e.exec(`test -e '${path}' && echo there || echo gone`);
  assert.equal(gone.stdout.trim(), "gone");
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

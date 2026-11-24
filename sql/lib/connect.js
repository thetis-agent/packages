// From a profile name to an open session: the proxy when the profile names a
// Cloud SQL instance, the engine when the profile does not say it, the
// password from wherever the profile keeps it. The password goes to the
// driver and nowhere else.

import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { settings, profile, DEFAULTS } from "./config.js";
import { ensureProxy, googleCredential, run } from "./proxy.js";
import { open } from "./drivers.js";

const secretCache = new Map();   // passwordSecret → { value, at }
const engineCache = new Map();   // instance → engine

/** Reads a Secret Manager secret with gcloud: `projects/p/secrets/s/versions/v`, `s`, or `s@version`. */
async function accessSecret(env, s, p, ref) {
  const hit = secretCache.get(ref);
  if (hit && hit.at > Date.now() - 10 * 60_000) return hit.value;
  let secret = ref, version = "latest", project = p.project;
  const full = /^projects\/([^/]+)\/secrets\/([^/]+)(?:\/versions\/([^/]+))?$/.exec(ref);
  if (full) { project = full[1]; secret = full[2]; version = full[3] || "latest"; }
  else if (ref.includes("@")) { [secret, version] = ref.split("@"); }
  const args = ["secrets", "versions", "access", version, `--secret=${secret}`];
  if (project) args.push(`--project=${project}`);
  const r = await run("gcloud", args, { timeoutMs: 30_000, env: await gcloudVars(env, s, p) });
  if (r.code !== 0) {
    const why = r.stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ");
    throw new Error(`could not read the password from Secret Manager (${ref}): ${why || `gcloud exit ${r.code}`}${/PERMISSION|denied/i.test(why) ? ". The account needs roles/secretmanager.secretAccessor on that secret." : ""}`);
  }
  const value = r.stdout.replace(/\r?\n$/, "");
  secretCache.set(ref, { value, at: Date.now() });
  return value;
}

/** gcloud's environment for a profile: the same Google credential the proxy uses, when one is set. */
async function gcloudVars(env, s, p) {
  if (!(s.googleCredentialFile || s.googleCredentialsJson || p.credentialFile)) return {};
  const cred = await googleCredential(env, s, p);
  return { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: cred.file };
}

/** The password for a profile, or null when it logs in without one. */
export async function passwordFor(env, s, p) {
  if (p.iamAuth) return "";
  if (Object.prototype.hasOwnProperty.call(s.passwords, p.name)) return String(s.passwords[p.name] ?? "");
  if (typeof p.passwordFile === "string" && p.passwordFile.trim()) {
    const home = env?.cwd || process.env.HOME || homedir();
    const f = isAbsolute(p.passwordFile) ? p.passwordFile : resolve(home, p.passwordFile.trim());
    try { return (await fs.readFile(f, "utf8")).replace(/\r?\n$/, ""); } catch (e) { throw new Error(`could not read passwordFile ${p.passwordFile}: ${e.code ?? e.message}`); }
  }
  if (typeof p.passwordSecret === "string" && p.passwordSecret.trim()) return accessSecret(env, s, p, p.passwordSecret.trim());
  if (typeof p.password === "string") return p.password;
  return null;
}

/** mysql or postgres for a Cloud SQL instance, from its databaseVersion. */
async function engineOf(env, s, p) {
  const instance = p.instance;
  if (engineCache.has(instance)) return engineCache.get(instance);
  const [project, , name] = instance.split(":");
  const r = await run("gcloud", ["sql", "instances", "describe", name, `--project=${project}`, "--format=value(databaseVersion)"], { timeoutMs: 30_000, env: await gcloudVars(env, s, p) });
  const v = r.stdout.trim().toUpperCase();
  const engine = v.startsWith("MYSQL") ? "mysql" : v.startsWith("POSTGRES") ? "postgres" : "";
  if (!engine) throw new Error(`connection "${p.name}": say its engine (mysql or postgres)${v.startsWith("SQLSERVER") ? "; SQL Server is not supported" : ""}. gcloud could not tell: ${r.stderr.trim().split("\n").at(-1) || v || "no answer"}`);
  engineCache.set(instance, engine);
  return engine;
}

/** Where a profile is reached now: `{ target, proxy? }`, starting the proxy when it needs one. */
export async function resolveTarget(env, s, p) {
  let proxy = null;
  const t = { engine: p.engine, user: p.user, database: p.database, ssl: p.ssl, options: p.options, connectTimeoutMs: DEFAULTS.connectTimeoutMs };
  if (p.via === "direct") {
    t.host = p.host; t.socketPath = p.socketPath; t.port = p.port ?? (p.engine === "postgres" ? 5432 : 3306);
  } else {
    if (!/^[^:]+:[^:]+:[^:]+$/.test(p.instance)) throw new Error(`connection "${p.name}": instance is the instance connection name, project:region:instance, not "${p.instance}"`);
    if (!t.engine) t.engine = await engineOf(env, s, p);
    proxy = await ensureProxy(env, s, p);
    t.host = proxy.host; t.port = proxy.port; t.viaProxy = true;
    // The proxy already encrypts the hop to Google; TLS to it would fail.
    t.ssl = undefined;
  }
  if (!t.user) throw new Error(`connection "${p.name}" has no user`);
  const pw = await passwordFor(env, s, p);
  if (pw === null && !p.iamAuth && !p.socketPath) {
    // Not fatal: some local servers trust the network. Say so if the login fails.
    t.noPassword = true;
  }
  t.password = pw ?? undefined;
  return { target: t, proxy };
}

/**
 * Runs body(session, ctx) on a fresh connection to the named profile and
 * closes it after. ctx carries the settings, the profile and the proxy used.
 */
export async function withSession(env, name, body) {
  const s = settings(env?.config);
  const p = profile(s, name);
  const { target, proxy } = await resolveTarget(env, s, p);
  let session;
  try {
    session = await open(target);
  } catch (e) {
    if (target.noPassword && /denied|password|authentication/i.test(String(e?.message))) {
      e.message += ` (no password is set for "${p.name}": add it to the secret \`passwords\` setting as {"${p.name}": "…"}, or give the profile passwordFile or passwordSecret)`;
    }
    throw e;
  }
  try {
    return await body(session, { s, p, proxy, target });
  } finally {
    await session.close();
  }
}

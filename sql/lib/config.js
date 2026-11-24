// The package's settings, read once per call into one plain object, and the
// connection profiles resolved from them: what engine, where it listens (a
// host and port, or a Cloud SQL instance reached through the proxy), who logs
// in, and where the password comes from. No secret is ever put in an answer.

import { createHash } from "node:crypto";

export const DEFAULTS = {
  maxRows: 100,
  hardMaxRows: 5000,
  timeoutMs: 30_000,
  connectTimeoutMs: 20_000,
  maxChars: 20_000,
  proxyMode: "auto",
  proxyImage: "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.3",
  proxyNetwork: "bridge",
  proxyBinary: "cloud-sql-proxy",
  proxyIdleMinutes: 30,
  proxyMemory: "256m",
  proxyStartTimeoutMs: 45_000,
};

export const ENGINES = new Set(["mysql", "postgres"]);
export const PROXY_MODES = new Set(["auto", "docker", "binary"]);
const CONNECTION_KEYS = new Set([
  "engine", "host", "port", "user", "database", "instance", "project", "proxy", "privateIp", "psc", "iamAuth",
  "impersonate", "credentialFile", "password", "passwordFile", "passwordSecret", "ssl", "readOnly", "timeoutMs",
  "description", "options", "socketPath",
]);

const str = (v) => (typeof v === "string" ? v.trim() : "");
export function clampInt(v, dflt, lo, hi) {
  const n = Number(v);
  if (v === undefined || v === null || v === "" || !Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
export function boolArg(v, dflt = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(1|true|yes|on)$/i.test(v.trim());
  if (typeof v === "number") return v !== 0;
  return dflt;
}

function objectSetting(v, key) {
  if (v === undefined || v === null || v === "") return {};
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { throw new Error(`the \`${key}\` setting is not JSON: it is an object of name → value`); }
  }
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`the \`${key}\` setting is an object of name → value`);
  return v;
}

/** The package settings with defaults applied. */
export function settings(config = {}) {
  const c = config ?? {};
  const mode = str(c.proxyMode) || DEFAULTS.proxyMode;
  if (!PROXY_MODES.has(mode)) throw new Error(`the \`proxyMode\` setting is auto, docker or binary, not "${mode}"`);
  return {
    connections: objectSetting(c.connections, "connections"),
    passwords: objectSetting(c.passwords, "passwords"),
    defaultConnection: str(c.default),
    project: str(c.project),
    readOnly: boolArg(c.readOnly, false),
    maxRows: clampInt(c.maxRows, DEFAULTS.maxRows, 1, DEFAULTS.hardMaxRows),
    timeoutMs: clampInt(c.timeoutMs, DEFAULTS.timeoutMs, 1_000, 300_000),
    maxChars: clampInt(c.maxChars, DEFAULTS.maxChars, 2_000, 200_000),
    proxyMode: mode,
    proxyImage: str(c.proxyImage) || DEFAULTS.proxyImage,
    proxyNetwork: str(c.proxyNetwork) || DEFAULTS.proxyNetwork,
    proxyBinary: str(c.proxyBinary) || DEFAULTS.proxyBinary,
    proxyIdleMinutes: clampInt(c.proxyIdleMinutes, DEFAULTS.proxyIdleMinutes, 0, 24 * 60),
    proxyMemory: str(c.proxyMemory) || DEFAULTS.proxyMemory,
    googleCredentialFile: str(c.googleCredentialFile),
    googleCredentialsJson: str(c.googleCredentialsJson),
  };
}

/** The connection names, in the order they were written. */
export function connectionNames(s) {
  return Object.keys(s.connections);
}

/**
 * One connection profile, checked. `name` defaults to the `default` setting,
 * else the only profile there is. Answers the profile with `name` and `via`
 * (`direct`, `docker` or `binary`) filled in; the password is not resolved here.
 */
export function profile(s, name) {
  const names = connectionNames(s);
  if (!names.length) {
    throw new Error(
      "no connections are set up. Set the `connections` setting of this package to an object of name → profile, e.g. " +
      '{"dev": {"engine": "mysql", "instance": "my-project:us-central1:my-instance", "user": "app", "database": "app"}} ' +
      "for a Cloud SQL instance through the proxy, or {\"local\": {\"engine\": \"postgres\", \"host\": \"10.0.0.5\", \"port\": 5432, \"user\": \"me\", \"database\": \"db\"}} " +
      "for a direct one, and the password in the secret `passwords` setting as {\"dev\": \"…\"}. The person does that under Extensions › sql › Configure, or you call configure_package with what they give you.",
    );
  }
  let n = str(name) || s.defaultConnection || (names.length === 1 ? names[0] : "");
  if (!n) throw new Error(`name a \`connection\`: one of ${names.join(", ")} (or set the \`default\` setting)`);
  const raw = s.connections[n];
  if (!raw) throw new Error(`no connection named "${n}": the connections are ${names.join(", ")}`);
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`connection "${n}" is not an object`);
  const unknown = Object.keys(raw).filter((k) => !CONNECTION_KEYS.has(k));
  if (unknown.length) throw new Error(`connection "${n}" has key(s) this package does not know: ${unknown.join(", ")}. The keys are ${[...CONNECTION_KEYS].join(", ")}.`);

  const p = { ...raw, name: n };
  p.engine = str(raw.engine).toLowerCase();
  if (p.engine === "postgresql" || p.engine === "pg") p.engine = "postgres";
  if (p.engine === "mariadb") p.engine = "mysql";
  if (p.engine && !ENGINES.has(p.engine)) throw new Error(`connection "${n}": engine is mysql or postgres, not "${raw.engine}"`);
  p.instance = str(raw.instance);
  p.host = str(raw.host);
  p.socketPath = str(raw.socketPath);

  const proxy = raw.proxy;
  if (p.instance) {
    if (proxy === false || proxy === "none" || proxy === "direct") throw new Error(`connection "${n}" names an instance and turns the proxy off: give host and port instead of instance for a direct connection`);
    const m = proxy === undefined || proxy === true || proxy === null || proxy === "" ? s.proxyMode : String(proxy);
    if (!PROXY_MODES.has(m)) throw new Error(`connection "${n}": proxy is auto, docker or binary, not "${proxy}"`);
    p.via = m;
  } else {
    if (!p.host && !p.socketPath) throw new Error(`connection "${n}" has neither \`instance\` (a Cloud SQL instance, reached through the proxy) nor \`host\` (a direct connection)`);
    p.via = "direct";
  }
  if (p.via === "direct" && !p.engine) {
    const port = Number(raw.port);
    p.engine = port === 5432 ? "postgres" : port === 3306 ? "mysql" : "";
    if (!p.engine) throw new Error(`connection "${n}": say its engine (mysql or postgres)`);
  }
  p.port = raw.port === undefined || raw.port === null || raw.port === "" ? null : clampInt(raw.port, null, 1, 65535);
  p.user = str(raw.user);
  p.database = str(raw.database);
  p.readOnly = boolArg(raw.readOnly, false) || s.readOnly;
  p.timeoutMs = raw.timeoutMs === undefined ? s.timeoutMs : clampInt(raw.timeoutMs, s.timeoutMs, 1_000, 300_000);
  p.iamAuth = boolArg(raw.iamAuth, false);
  p.privateIp = boolArg(raw.privateIp, false);
  p.psc = boolArg(raw.psc, false);
  p.impersonate = str(raw.impersonate);
  p.credentialFile = str(raw.credentialFile);
  p.project = str(raw.project) || s.project;
  return p;
}

/** Where a profile's password comes from, in words (never the value). */
export function passwordSource(s, p) {
  if (p.iamAuth) return "IAM database login through the proxy (no password)";
  if (Object.prototype.hasOwnProperty.call(s.passwords, p.name)) return "the `passwords` setting";
  if (str(p.passwordFile)) return `file ${p.passwordFile}`;
  if (str(p.passwordSecret)) return `Secret Manager ${p.passwordSecret}`;
  if (typeof p.password === "string" && p.password !== "") return "the profile's own `password` key (move it to the secret `passwords` setting)";
  return "none";
}

/** A short stable hash, for container names and cache keys. */
export function shortHash(v, n = 8) {
  return createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0, n);
}

/** A profile as one line for sql_status, with nothing secret in it. */
export function describeProfile(s, p) {
  const where = p.via === "direct"
    ? p.socketPath ? `socket ${p.socketPath}` : `${p.host}:${p.port ?? (p.engine === "postgres" ? 5432 : 3306)}`
    : `${p.instance} via the Cloud SQL proxy (${p.via}${p.privateIp ? ", private IP" : p.psc ? ", PSC" : ""}${p.impersonate ? `, as ${p.impersonate}` : ""})`;
  const bits = [
    `${p.name}${p.name === (s.defaultConnection || (connectionNames(s).length === 1 ? p.name : "")) ? " (default)" : ""}`,
    p.engine || "engine from the instance",
    where,
    `user ${p.user || (p.iamAuth ? "(the service account)" : "?")}`,
    p.database ? `database ${p.database}` : "no default database",
    p.readOnly ? "read-only" : "read-write",
    `password: ${passwordSource(s, p)}`,
  ];
  return `${bits.join(" · ")}${p.description ? `\n    ${String(p.description).slice(0, 200)}` : ""}`;
}

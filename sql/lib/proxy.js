// The Cloud SQL Auth Proxy, run for a connection profile that names an
// instance instead of a host. Two ways to run it:
//
//   docker  a container of gcr.io/cloud-sql-connectors/cloud-sql-proxy on a
//           Docker bridge network, reached at the container's own address.
//           This works from a fence in network mode `egress`, which has no
//           route to the host's loopback, so nothing is published on a port.
//   binary  a `cloud-sql-proxy` child process on 127.0.0.1 and a free port.
//
// One proxy per instance and set of flags, shared by every call and kept
// running between them: starting one costs a few seconds (a certificate
// exchange with the Cloud SQL Admin API). Each proxy is started with
// --run-connection-test, so a missing roles/cloudsql.client or a wrong
// instance name fails the start with Google's own reason instead of a closed
// socket later. Its state is a JSON file under <userspace>/run/sql-proxy, so
// a reload of this package's code finds the proxies the old code started, and
// the service stops the ones idle longer than `proxyIdleMinutes`.

import { execFile, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { promises as fs, existsSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { shortHash } from "./config.js";

const PROXY_PORT = 5432;     // the listener inside the container; the engine does not care
const LABEL = "thetis.sql-proxy";

// ------------------------------------------------------------- utilities --

export function run(cmd, args, { timeoutMs = 60_000, input, env: vars } = {}) {
  return new Promise((res) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 << 20, env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1", ...(vars ?? {}) } }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === "number" ? err.code : 127) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error: err && typeof err.code !== "number" ? String(err.message) : "" });
    });
    if (input !== undefined) { child.stdin?.end(input); } else child.stdin?.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when something accepts a TCP connection at host:port within ms. */
export function canConnect(host, port, ms = 1_500) {
  return new Promise((res) => {
    const s = createConnection({ host, port });
    const done = (ok) => { s.removeAllListeners(); s.destroy(); res(ok); };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => res(port)); });
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function stateRoot(env) {
  const root = process.env.THETIS_USERSPACE || dirname(env?.cwd || process.env.HOME || homedir());
  return join(root, "run", "sql-proxy");
}

async function readState(dir) {
  const out = [];
  let names = [];
  try { names = await fs.readdir(dir); } catch { return out; }
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    try { out.push(JSON.parse(await fs.readFile(join(dir, n), "utf8"))); } catch { /* half-written; ignore */ }
  }
  return out;
}
async function writeState(dir, st) {
  await fs.mkdir(dir, { recursive: true });
  const f = join(dir, `${st.key}.json`);
  await fs.writeFile(`${f}.tmp`, JSON.stringify(st, null, 1));
  await fs.rename(`${f}.tmp`, f);
}
async function dropState(dir, key) {
  await fs.rm(join(dir, `${key}.json`), { force: true });
  await fs.rm(join(dir, `${key}.log`), { force: true });
}

// --------------------------------------------------------- availability --

let dockerProbe = null;
/** Whether Docker answers here: { ok, version?, why? }. Cached for a minute. */
export async function dockerAvailable() {
  if (dockerProbe && dockerProbe.at > Date.now() - 60_000) return dockerProbe.value;
  const r = await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
  const value = r.code === 0 && r.stdout.trim()
    ? { ok: true, version: r.stdout.trim() }
    : { ok: false, why: process.env.THETIS_DOCKER || existsSync("/var/run/docker.sock") ? (r.stderr.trim().split("\n").at(-1) || r.error || `docker exit ${r.code}`) : "this space has no Docker (THETIS_DOCKER is not set)" };
  dockerProbe = { at: Date.now(), value };
  return value;
}

/** Whether the proxy binary runs here: { ok, version?, why? }. */
export async function binaryAvailable(bin) {
  const r = await run(bin, ["--version"], { timeoutMs: 15_000 });
  return r.code === 0 ? { ok: true, version: r.stdout.trim().replace(/^cloud-sql-proxy version\s*/, "") } : { ok: false, why: r.code === 127 || /ENOENT/.test(r.error) ? `${bin} is not on the PATH` : (r.stderr.trim() || `exit ${r.code}`) };
}

/** Which way a profile's proxy runs: the mode it asks for, or for `auto` Docker when it answers, else the binary. */
export async function chooseMode(want, s) {
  if (want === "docker" || want === "binary") return want;
  if ((await dockerAvailable()).ok) return "docker";
  if ((await binaryAvailable(s.proxyBinary)).ok) return "binary";
  const d = await dockerAvailable();
  throw new Error(`no way to run the Cloud SQL proxy here: Docker is not available (${d.why}) and ${s.proxyBinary} is not installed. Give this space Docker, or install cloud-sql-proxy and set \`proxyBinary\` to its path.`);
}

// ----------------------------------------------------------- credentials --

/**
 * The Google credential the proxy authenticates with, as a host path a
 * container can mount: the profile's `credentialFile`, the
 * `googleCredentialsJson` secret (written to a private file), the
 * `googleCredentialFile` setting, GOOGLE_APPLICATION_CREDENTIALS, gcloud's
 * application-default login, or the active gcloud account's own key.
 */
export async function googleCredential(env, s, p) {
  const home = env?.cwd || process.env.HOME || homedir();
  const abs = (f) => (isAbsolute(f) ? f : resolve(home, f));
  if (p.credentialFile) return { file: abs(p.credentialFile), source: `the profile's credentialFile ${p.credentialFile}` };
  if (s.googleCredentialsJson) {
    let key;
    try { key = JSON.parse(s.googleCredentialsJson); } catch { throw new Error("the `googleCredentialsJson` setting is not JSON: paste the whole service account key file"); }
    const dir = join(home, ".cache", "thetis-sql");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});
    const file = join(dir, `key-${shortHash(s.googleCredentialsJson, 12)}.json`);
    if (!existsSync(file)) { await fs.writeFile(file, s.googleCredentialsJson, { mode: 0o600 }); }
    return { file, source: `the googleCredentialsJson setting${key.client_email ? ` (${key.client_email})` : ""}`, account: key.client_email };
  }
  if (s.googleCredentialFile) return { file: abs(s.googleCredentialFile), source: `the googleCredentialFile setting ${s.googleCredentialFile}` };
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return { file: process.env.GOOGLE_APPLICATION_CREDENTIALS, source: "GOOGLE_APPLICATION_CREDENTIALS" };
  const gdir = process.env.CLOUDSDK_CONFIG || join(home, ".config", "gcloud");
  const adc = join(gdir, "application_default_credentials.json");
  if (existsSync(adc)) return { file: adc, source: "gcloud's application-default login" };
  const acct = await run("gcloud", ["config", "get-value", "account"], { timeoutMs: 20_000 });
  const account = acct.code === 0 ? acct.stdout.trim().split("\n").at(-1) : "";
  if (account && account !== "(unset)") {
    const f = join(gdir, "legacy_credentials", account, "adc.json");
    if (existsSync(f)) return { file: f, source: `gcloud's active account ${account}`, account };
  }
  throw new Error(
    "no Google credentials for the Cloud SQL proxy. Set `googleCredentialsJson` (secret: a service account key with roles/cloudsql.client) or " +
    "`googleCredentialFile` (a key file in this space) on this package, or a profile's `credentialFile`, or log gcloud in in this space.",
  );
}

// ------------------------------------------------------------- the proxy --

/** The flags a profile's proxy runs with, other than where it listens and the credential. */
function flagsOf(p) {
  const f = [];
  if (p.privateIp) f.push("--private-ip");
  if (p.psc) f.push("--psc");
  if (p.iamAuth) f.push("--auto-iam-authn");
  if (p.impersonate) f.push(`--impersonate-service-account=${p.impersonate}`);
  return f;
}

/** The identity of a proxy: two profiles on one instance with the same flags share one. */
export function proxyKey(mode, p, cred) {
  return `${mode}-${shortHash([p.instance, flagsOf(p), cred.file, process.getuid?.() ?? 0])}`;
}

function containerName(key) {
  const user = String(process.env.THETIS_USER || "user").toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `thetis-sqlproxy-${user}-${key.replace(/^docker-/, "")}`;
}

async function inspect(name) {
  const r = await run("docker", ["inspect", name], { timeoutMs: 20_000 });
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout)[0] ?? null; } catch { return null; }
}

function containerAddress(info, network) {
  const nets = info?.NetworkSettings?.Networks ?? {};
  const n = nets[network] ?? Object.values(nets)[0];
  return n?.IPAddress || null;
}

/** The last lines the proxy wrote. */
export async function proxyLogs(env, st, lines = 60) {
  if (st.mode === "docker") {
    const r = await run("docker", ["logs", "--tail", String(lines), st.container], { timeoutMs: 20_000 });
    return (r.stdout + r.stderr).trim() || (r.code ? `docker logs failed: ${r.stderr.trim()}` : "(no output)");
  }
  try {
    const t = await fs.readFile(join(stateRoot(env), `${st.key}.log`), "utf8");
    return t.trim().split("\n").slice(-lines).join("\n") || "(no output)";
  } catch { return "(no log file)"; }
}

/** Why a proxy start failed, from its log: Google's own sentence when there is one. */
function reasonFrom(log) {
  const lines = log.split("\n").map((l) => l.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s*/, "").trim()).filter(Boolean);
  const terminal = lines.find((l) => /terminal error|failed|error/i.test(l) && !/^Connection test (started|failed)$/.test(l));
  let why = terminal || lines.at(-1) || "it exited without saying why";
  if (/cloudsql\.instances\.connect|NOT_AUTHORIZED|403/.test(why)) why += "\n→ The Google account the proxy uses needs roles/cloudsql.client (it carries cloudsql.instances.connect) on the project, and the Cloud SQL Admin API enabled.";
  else if (/instance does not exist|not found|404|invalid instance connection name/i.test(why)) why += "\n→ Check the instance connection name: project:region:instance, as `gcloud sql instances list --format='value(connectionName)'` prints it.";
  else if (/private ip|no private ip|PRIVATE/i.test(why)) why += "\n→ The instance has no address of the kind asked for: drop privateIp/psc, or run where the VPC is reachable.";
  else if (/credentials|could not find default/i.test(why)) why += "\n→ The credential file could not be used: see googleCredentialsJson / googleCredentialFile.";
  return why;
}

/** A proxy's state if it is up: checks the container or process and the port. */
async function liveState(env, st) {
  if (st.mode === "docker") {
    const info = await inspect(st.container);
    if (!info?.State?.Running) return null;
    const host = containerAddress(info, st.network);
    if (!host) return null;
    return { ...st, host };
  }
  if (!(await isProxyPid(st.pid, st.bin))) return null;
  return (await canConnect(st.host, st.port)) ? st : null;
}

/** A pid that is alive and runs the proxy binary it was started as: a pid from an earlier fence may belong to anything now. */
async function isProxyPid(pid, bin) {
  if (!pidAlive(pid)) return false;
  const name = String(bin || "cloud-sql-proxy").split("/").at(-1);
  try { return (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).includes(name); } catch { return true; }
}

/** The Docker network proxies run on: the setting, or one of this user's own, made when missing. */
export async function proxyNetwork(s) {
  if (s.proxyNetwork) return s.proxyNetwork;
  const user = String(process.env.THETIS_USER || "user").toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const name = `thetis-sql-${user}`;
  const r = await run("docker", ["network", "inspect", name, "--format", "{{.Name}}"], { timeoutMs: 20_000 });
  if (r.code === 0) return name;
  const c = await run("docker", ["network", "create", "--driver", "bridge", "--label", `${LABEL}=1`, name], { timeoutMs: 30_000 });
  if (c.code !== 0 && !/already exists/.test(c.stderr)) throw new Error(`could not create the Docker network ${name} for the proxy: ${c.stderr.trim()}. Set \`proxyNetwork\` to an existing one (e.g. bridge).`);
  return name;
}

async function startDocker(env, s, p, cred, key) {
  const name = containerName(key);
  const network = await proxyNetwork(s);
  const old = await inspect(name);
  if (old) await run("docker", ["rm", "-f", name], { timeoutMs: 30_000 });
  const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
  const args = [
    "run", "-d", "--name", name,
    "--label", `${LABEL}=1`, "--label", `${LABEL}.user=${process.env.THETIS_USER ?? ""}`, "--label", `${LABEL}.instance=${p.instance}`,
    "--network", network, "--memory", s.proxyMemory, "--cpus", "0.5", "--restart", "no",
    "--user", `${uid}:${gid}`, "--read-only",
    "-v", `${cred.file}:/config/credentials.json:ro`,
    s.proxyImage,
    "--address", "0.0.0.0", "--port", String(PROXY_PORT),
    "--credentials-file", "/config/credentials.json",
    "--run-connection-test", "--structured-logs=false",
    ...flagsOf(p),
    p.instance,
  ];
  const r = await run("docker", args, { timeoutMs: 180_000 });
  if (r.code !== 0) {
    const why = r.stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${r.code}`;
    throw new Error(`docker could not start the Cloud SQL proxy container: ${why}${/pull|manifest|not found/i.test(why) ? ` (image ${s.proxyImage}; set \`proxyImage\` to one this host can pull)` : ""}`);
  }
  return { mode: "docker", container: name, network, port: PROXY_PORT };
}

async function startBinary(env, s, p, cred, key) {
  const dir = stateRoot(env);
  await fs.mkdir(dir, { recursive: true });
  const port = await freePort();
  const logFile = join(dir, `${key}.log`);
  const fd = openSync(logFile, "w");
  const args = ["--address", "127.0.0.1", "--port", String(port), "--credentials-file", cred.file, "--run-connection-test", ...flagsOf(p), p.instance];
  let child;
  try {
    child = spawn(s.proxyBinary, args, { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env } });
  } finally { closeSync(fd); }
  const spawned = await new Promise((res) => { child.once("spawn", () => res(null)); child.once("error", (e) => res(e)); });
  if (spawned) throw new Error(`could not run ${s.proxyBinary}: ${spawned.message}`);
  child.unref();
  return { mode: "binary", pid: child.pid, bin: s.proxyBinary, host: "127.0.0.1", port };
}

/** Waits for the proxy's connection test: passed, failed, or still nothing by the deadline. */
async function awaitReady(env, st, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const log = await proxyLogs(env, st, 200);
    if (/Connection test passed/.test(log)) return { ok: true };
    if (/Connection test failed|terminal error|proxy server error/.test(log)) return { ok: false, why: reasonFrom(log), log };
    const alive = st.mode === "docker" ? (await inspect(st.container))?.State?.Running : await isProxyPid(st.pid, st.bin);
    if (!alive) {
      await sleep(300);
      const last = await proxyLogs(env, st, 200);
      return { ok: false, why: reasonFrom(last), log: last };
    }
    await sleep(500);
  }
  return { ok: false, why: `no answer from the connection test in ${Math.round(timeoutMs / 1000)} s`, log: await proxyLogs(env, st, 40) };
}

async function stopOne(env, st) {
  if (st.mode === "docker") await run("docker", ["rm", "-f", st.container], { timeoutMs: 30_000 });
  else if (await isProxyPid(st.pid, st.bin)) {
    try { process.kill(-st.pid, "SIGTERM"); } catch { try { process.kill(st.pid, "SIGTERM"); } catch { /* gone */ } }
  }
  await dropState(stateRoot(env), st.key);
}

const starting = new Map();

/**
 * A running proxy for profile `p`, started when there is none: `{ host, port, key, mode, started }`.
 * Concurrent calls for the same proxy share one start.
 */
export async function ensureProxy(env, s, p) {
  const mode = await chooseMode(p.via, s);
  if (mode === "docker" && !(await dockerAvailable()).ok) throw new Error(`the proxy is set to run in Docker, and Docker is not available: ${(await dockerAvailable()).why}`);
  const cred = await googleCredential(env, s, p);
  if (!existsSync(cred.file)) throw new Error(`the Google credential file ${cred.file} (${cred.source}) does not exist`);
  const key = proxyKey(mode, p, cred);
  const dir = stateRoot(env);
  const known = (await readState(dir)).find((x) => x.key === key);
  if (known) {
    const live = await liveState(env, known);
    if (live) {
      await writeState(dir, { ...known, lastUsed: Date.now() });
      return { ...live, started: false };
    }
    await stopOne(env, known);
  }
  if (starting.has(key)) return starting.get(key);
  const job = (async () => {
    const base = { key, instance: p.instance, flags: flagsOf(p), credential: cred.source, createdAt: Date.now(), lastUsed: Date.now(), idleMinutes: s.proxyIdleMinutes };
    const placed = mode === "docker" ? await startDocker(env, s, p, cred, key) : await startBinary(env, s, p, cred, key);
    const st = { ...base, ...placed };
    await writeState(dir, st);
    const ready = await awaitReady(env, st, 45_000);
    if (!ready.ok) {
      await stopOne(env, st);
      throw new Error(`the Cloud SQL proxy for ${p.instance} did not come up (${mode}): ${ready.why}`);
    }
    const live = await liveState(env, st);
    if (!live) { await stopOne(env, st); throw new Error(`the Cloud SQL proxy for ${p.instance} passed its connection test and then went away`); }
    if (mode === "docker" && !(await canConnect(live.host, live.port, 3_000))) {
      await stopOne(env, st);
      throw new Error(`the proxy container is up at ${live.host}:${live.port} on the Docker network "${live.network}", but this space cannot reach that address. Set \`proxyNetwork\` to a network this space can route to, or use proxyMode binary.`);
    }
    await writeState(dir, live);
    return { ...live, started: true };
  })();
  starting.set(key, job);
  try { return await job; } finally { starting.delete(key); }
}

/** Every proxy this space's state knows of, each with `up` and, for Docker, its address. */
export async function listProxies(env) {
  const out = [];
  for (const st of await readState(stateRoot(env))) {
    const live = await liveState(env, st);
    out.push({ ...(live ?? st), up: !!live });
  }
  return out;
}

/** Stops the proxies matching `pred` (all by default). Answers what it stopped. */
export async function stopProxies(env, pred = () => true) {
  const stopped = [];
  for (const st of await readState(stateRoot(env))) {
    if (!pred(st)) continue;
    await stopOne(env, st);
    stopped.push(st);
  }
  return stopped;
}

/** Proxies unused for longer than their idle time, stopped. 0 minutes means never. */
export async function reapIdle(env, now = Date.now()) {
  return stopProxies(env, (st) => st.idleMinutes > 0 && now - (st.lastUsed ?? st.createdAt ?? 0) > st.idleMinutes * 60_000);
}

/** Containers labelled as this user's proxies that no state file knows: left behind by a crash. */
export async function orphanContainers(env) {
  if (!(await dockerAvailable()).ok) return [];
  const r = await run("docker", ["ps", "-a", "--filter", `label=${LABEL}=1`, "--filter", `label=${LABEL}.user=${process.env.THETIS_USER ?? ""}`, "--format", "{{.Names}}"], { timeoutMs: 20_000 });
  if (r.code !== 0) return [];
  const known = new Set((await readState(stateRoot(env))).map((s) => s.container).filter(Boolean));
  return r.stdout.split("\n").map((x) => x.trim()).filter((x) => x && !known.has(x));
}

export async function removeContainers(names) {
  for (const n of names) await run("docker", ["rm", "-f", n], { timeoutMs: 30_000 });
}

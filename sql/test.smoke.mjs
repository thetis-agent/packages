// Smoke test. Run: node test.smoke.mjs
//
// Always: the manifest against the exports, and the SQL text helpers.
// With Docker: a real MySQL 8.0 and PostgreSQL 16 in containers, every tool
// driven through the same (args, env) interface the kernel uses, directly and
// through a stand-in Cloud SQL proxy in both modes (a container, a process),
// including a proxy whose connection test fails. With SQL_TEST_REAL_PROXY=1,
// also the real proxy image against a real instance (SQL_TEST_INSTANCE),
// which needs Google credentials with roles/cloudsql.client.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as index from "./index.js";
import { splitStatements, classify, bindParams, parseObjectRef, codeOnly } from "./lib/sqltext.js";
import { settings, profile } from "./lib/config.js";
import { stopProxies, listProxies } from "./lib/proxy.js";

const here = new URL(".", import.meta.url).pathname;

// --- manifest ↔ exports --------------------------------------------------------
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
for (const t of pkg.thetis.tools) {
  assert.equal(typeof index[t.export], "function", `export ${t.export} for ${t.name}`);
  assert.ok(t.description.length > 60, `${t.name} has a description`);
  assert.equal(t.parameters.type, "object");
  assert.equal(typeof t.reads, "boolean", `${t.name} declares reads`);
  assert.ok(t.name.startsWith("sql_"));
}
assert.equal(typeof index[pkg.thetis.service.export], "function");
assert.equal(pkg.thetis.config.passwords.secret, true);
assert.equal(pkg.thetis.config.googleCredentialsJson.secret, true);
for (const [k, d] of Object.entries(pkg.thetis.config)) {
  assert.match(k, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.ok(["string", "number", "boolean", "object", "array"].includes(d.type), k);
  if (d.default !== undefined) assert.equal(Array.isArray(d.default) ? "array" : typeof d.default, d.type, `${k} default type`);
}
console.log(`manifest: ${pkg.thetis.tools.length} tools wired: ok`);

// --- SQL text ------------------------------------------------------------------
assert.deepEqual(splitStatements("select 1; select ';' ; -- x;\n select 2", "mysql"), ["select 1", "select ';'", "-- x;\n select 2"]);
assert.deepEqual(splitStatements("select $$a;b$$; select 'it''s;'", "postgres"), ["select $$a;b$$", "select 'it''s;'"]);
assert.deepEqual(splitStatements("select 'a\\';b'; select 2", "mysql"), ["select 'a\\';b'", "select 2"]);
assert.deepEqual(splitStatements("  -- only a comment\n", "mysql"), []);
assert.deepEqual(splitStatements("select 1;", "mysql"), ["select 1"]);
assert.equal(classify("/* hi */ (SELECT 1)", "mysql").read, true);
assert.equal(classify("with x as (select 1) select * from x", "postgres").read, true);
assert.equal(classify("with d as (delete from t returning *) select * from d", "postgres").read, false);
assert.equal(classify("select 'delete' from t", "postgres").read, true);
assert.equal(classify("select * from t into outfile '/tmp/x'", "mysql").read, false);
assert.equal(classify("update t set a = 1", "mysql").fullTable, true);
assert.equal(classify("delete from t where id = 1", "mysql").fullTable, false);
assert.equal(classify("delete from t -- where id = 1", "mysql").fullTable, true);
assert.equal(classify("alter table t add c int", "mysql").implicitCommit, true);
assert.equal(classify("alter table t add c int", "postgres").implicitCommit, false);
assert.equal(classify("explain analyze select 1", "postgres").analyzes, true);
assert.equal(classify("CALL p()", "mysql").read, false);
assert.deepEqual(bindParams("select * from t where a = :a and b = :b and c = :a", "postgres", { a: 1, b: "x" }), { text: "select * from t where a = $1 and b = $2 and c = $1", values: [1, "x"] });
assert.deepEqual(bindParams("select * from t where a = :a and b = :a", "mysql", { a: 1 }), { text: "select * from t where a = ? and b = ?", values: [1, 1] });
assert.deepEqual(bindParams("select now()::date, ':x', a from t where b = :b", "postgres", { b: 2 }), { text: "select now()::date, ':x', a from t where b = $1", values: [2] });
assert.deepEqual(bindParams("select @v := 1, :b", "mysql", { b: 2 }), { text: "select @v := 1, ?", values: [2] });
assert.deepEqual(bindParams("select ?", "mysql", [{ a: 1 }]), { text: "select ?", values: ['{"a":1}'] });
assert.throws(() => bindParams("select :a", "mysql", {}), /no "a"/);
assert.throws(() => bindParams("select 1", "mysql", { a: 1 }), /never uses/);
assert.deepEqual(parseObjectRef('"My Schema"."T.1"'), { schema: "My Schema", name: "T.1" });
assert.deepEqual(parseObjectRef("`db`.`t`"), { schema: "db", name: "t" });
assert.deepEqual(parseObjectRef("t"), { schema: null, name: "t" });
assert.equal(codeOnly("select 'x' -- c\n", "mysql"), "select ''  ");
console.log("sql text: ok");

// --- profiles ------------------------------------------------------------------
{
  const s = settings({ connections: { a: { engine: "mysql", instance: "p:r:i", user: "u" }, b: { host: "h", port: 5432, user: "u" } }, default: "b" });
  assert.equal(profile(s).name, "b");
  assert.equal(profile(s).engine, "postgres");
  assert.equal(profile(s, "a").via, "auto");
  assert.throws(() => profile(s, "zzz"), /no connection named/);
  assert.throws(() => profile(settings({ connections: { x: { host: "h", user: "u", pasword: "x" } } }), "x"), /does not know: pasword/);
  assert.throws(() => profile(settings({})), /no connections are set up/);
  assert.equal(profile(settings({ readOnly: true, connections: { a: { host: "h", engine: "mysql", user: "u" } } })).readOnly, true);
  assert.throws(() => settings({ proxyMode: "ssh" }), /auto, docker or binary/);
}
console.log("profiles: ok");

// --- integration ---------------------------------------------------------------
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
let docker = false;
try { sh("docker", ["version", "--format", "{{.Server.Version}}"]); docker = true; } catch { /* none */ }
if (!docker) {
  console.log("integration: skipped (no Docker here)");
  process.exit(0);
}

const tag = `sqlsmoke-${process.pid}`;
const containers = [];
const work = mkdtempSync(join(tmpdir(), "sqlsmoke-"));
process.env.THETIS_USERSPACE = work;
process.env.THETIS_USER = `smoke${process.pid}`;
const cleanup = () => {
  for (const c of containers) { try { sh("docker", ["rm", "-f", c]); } catch { /* gone */ } }
  // Proxy containers this run started, whatever state the run ended in.
  try {
    const left = sh("docker", ["ps", "-aq", "--filter", `label=thetis.sql-proxy.user=${process.env.THETIS_USER}`]).split("\n").filter(Boolean);
    if (left.length) sh("docker", ["rm", "-f", ...left]);
  } catch { /* none */ }
  try { sh("docker", ["rmi", "-f", `${tag}-proxy`]); } catch { /* gone */ }
  rmSync(work, { recursive: true, force: true });
};
process.on("exit", cleanup);

const ip = (name) => sh("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name]);
const start = (name, image, envs) => {
  sh("docker", ["run", "-d", "--name", name, "--network", "bridge", ...envs.flatMap((e) => ["-e", e]), image]);
  containers.push(name);
};
start(`${tag}-my`, "mysql:8.0", ["MYSQL_ROOT_PASSWORD=rootpw", "MYSQL_DATABASE=app", "MYSQL_USER=app", "MYSQL_PASSWORD=apppw"]);
start(`${tag}-pg`, "postgres:16", ["POSTGRES_PASSWORD=pgpw", "POSTGRES_DB=app"]);
const myIp = ip(`${tag}-my`), pgIp = ip(`${tag}-pg`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms = 120_000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try { if (await fn()) return; } catch (e) { last = e; }
    await sleep(1000);
  }
  throw new Error(`${what} did not come up: ${last?.message ?? "timeout"}`);
}

// A stand-in proxy image: the fake script as the entrypoint, built once.
writeFileSync(join(work, "Dockerfile"), 'FROM node:22-alpine\nCOPY fake-proxy.mjs /fake-proxy.mjs\nENTRYPOINT ["node", "/fake-proxy.mjs"]\n');
writeFileSync(join(work, "fake-proxy.mjs"), readFileSync(join(here, "test/fake-proxy.mjs")));
sh("docker", ["build", "-q", "-t", `${tag}-proxy`, work]);
const keyFile = join(work, "key.json");
writeFileSync(keyFile, JSON.stringify({ type: "service_account", client_email: "smoke@example.iam.gserviceaccount.com", private_key: "x" }));

const connections = {
  my: { engine: "mysql", host: myIp, port: 3306, user: "app", database: "app" },
  myroot: { engine: "mysql", host: myIp, port: 3306, user: "root", database: "app" },
  myro: { engine: "mysql", host: myIp, port: 3306, user: "root", database: "app", readOnly: true },
  pg: { engine: "postgres", host: pgIp, user: "postgres", database: "app" },
  cs_docker: { engine: "mysql", instance: `p:${myIp}_3306:inst`, proxy: "docker", user: "app", database: "app" },
  cs_binary: { engine: "postgres", instance: `p:${pgIp}_5432:inst`, proxy: "binary", user: "postgres", database: "app" },
  cs_denied: { engine: "mysql", instance: `p:${myIp}_3306:inst-denied`, proxy: "docker", user: "app" },
};
const config = {
  connections,
  passwords: { my: "apppw", myroot: "rootpw", myro: "rootpw", pg: "pgpw", cs_docker: "apppw", cs_binary: "pgpw", cs_denied: "apppw" },
  default: "my",
  proxyImage: `${tag}-proxy`,
  proxyBinary: join(here, "test/fake-proxy.mjs"),
  googleCredentialFile: keyFile,
  timeoutMs: 20_000,
};
const env = { config, cwd: work, log: () => {} };
const call = (fn, args = {}, cfg = config) => index[fn](args, { ...env, config: cfg });

await waitFor("mysql", async () => /logged in as app/.test(await call("sqlStatus", { connection: "my" })));
await waitFor("postgres", async () => /logged in as postgres/.test(await call("sqlStatus", { connection: "pg" })));
console.log("containers up");

// Setup through sql_execute: a script in one transaction (postgres), and MySQL DDL without one.
let r = await call("sqlExecute", { connection: "myroot", sql: "CREATE TABLE players (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(40) NOT NULL, score BIGINT DEFAULT 0, born DATE, meta JSON, KEY ix_score (score)) COMMENT 'people'; INSERT INTO players (name, score, born, meta) VALUES ('ann', 10, '2001-02-03', '{\"a\":1}'), ('bob', 9007199254740993, NULL, NULL), ('c|d', 3, '1999-12-31', NULL); GRANT SELECT, INSERT, UPDATE, DELETE ON app.* TO 'app'@'%'" });
assert.match(r, /no transaction \(MySQL commits DDL on the spot\)/, r);
assert.match(r, /3 row\(s\) affected/, r);
r = await call("sqlExecute", { connection: "pg", sql: "CREATE SCHEMA game; CREATE TABLE game.cards (id serial PRIMARY KEY, title text NOT NULL, cost int CHECK (cost >= 0), at timestamptz DEFAULT now()); COMMENT ON TABLE game.cards IS 'the cards'; INSERT INTO game.cards (title, cost, at) VALUES ('Imp', 1, '2026-01-02 03:04:05+00'), ('Dragon', 9, '2026-01-02 03:04:05+00'); CREATE VIEW game.cheap AS SELECT * FROM game.cards WHERE cost < 5" });
assert.match(r, /committed as one transaction/, r);

// Reads.
r = await call("sqlQuery", { sql: "SELECT id, name, score, born, meta FROM players ORDER BY id" });
assert.match(r, /my \(mysql, direct\) · 3 row\(s\)/, r);
assert.match(r, /9007199254740993/, r);          // past 2^53, kept exact as a string
assert.match(r, /2001-02-03/, r);                 // dates as the server wrote them
assert.match(r, /c¦d/, r);                        // a pipe in a cell does not split the table
r = await call("sqlQuery", { sql: "SELECT * FROM players WHERE name = :n", params: { n: "ann" }, format: "json" });
assert.equal(JSON.parse(r.split("\n").slice(1).join("\n"))[0].name, "ann");
r = await call("sqlQuery", { sql: "SELECT id FROM players ORDER BY id", max_rows: 2 });
assert.match(r, /2\+ row\(s\) \(stopped at 2/, r);
r = await call("sqlQuery", { sql: "DELETE FROM players" });
assert.match(r, /^refused: DELETE is not a read/, r);
r = await call("sqlQuery", { sql: "SELECT 1; SELECT 2" });
assert.match(r, /2 statements/, r);
{
  const t0 = Date.now();
  r = await call("sqlQuery", { connection: "pg", sql: "SELECT pg_sleep(5)", timeout_s: 1 });
  assert.match(r, /statement timeout/, r);
  assert.ok(Date.now() - t0 < 4_000, "the server stopped it at the timeout");
}
r = await call("sqlQuery", { sql: "SELECT 1 FROM WHERE" });
assert.match(r, /the database refused it \[ER_PARSE_ERROR/, r);

r = await call("sqlQuery", { connection: "pg", sql: "SELECT title, cost, at FROM game.cards WHERE cost > $1 ORDER BY id", params: [0] });
assert.match(r, /Imp \| 1 \| 2026-01-02 03:04:05\+00/, r);
// Even a statement that would write is stopped by the READ ONLY transaction, should it pass the gate.
r = await call("sqlQuery", { connection: "pg", sql: "SELECT nextval('game.cards_id_seq')" });
assert.match(r, /read-only transaction|25006/, r);
r = await call("sqlQuery", { connection: "pg", sql: "with d as (delete from game.cards returning *) select * from d" });
assert.match(r, /^refused: this WITH holds a statement that changes data/, r);
r = await call("sqlQuery", { connection: "pg", sql: "SELECT 1 FROM nope" });
assert.match(r, /relation "nope" does not exist/, r);
assert.match(r, /line 1, column 15/, r);
console.log("query: ok");

// Metadata.
r = await call("sqlSchemas", { connection: "myroot" });
assert.match(r, /\bapp\b/, r);
r = await call("sqlTables");
assert.match(r, /players \| BASE TABLE \| InnoDB/, r);
r = await call("sqlDescribe", { table: "players", preview_rows: 2, ddl: true, connection: "myroot" });
assert.match(r, /id int NOT NULL PK auto_increment/, r);
assert.match(r, /ix_score \(score\)/, r);
assert.match(r, /CREATE TABLE `players`/, r);
assert.match(r, /first 2 row\(s\)/, r);
r = await call("sqlSchemas", { connection: "pg" });
assert.match(r, /game/, r);
assert.match(r, /databases on this server: app, postgres/, r);
r = await call("sqlTables", { connection: "pg", schema: "game" });
assert.match(r, /cards \| table/, r);
assert.match(r, /cheap \| view/, r);
assert.match(r, /the cards/, r);
r = await call("sqlDescribe", { connection: "pg", table: "game.cards" });
assert.match(r, /id integer NOT NULL DEFAULT nextval/, r);
assert.match(r, /CHECK \(\(cost >= 0\)\)/, r);
assert.match(r, /CREATE UNIQUE INDEX cards_pkey/, r);
r = await call("sqlDescribe", { connection: "pg", table: "game.cheap" });
assert.match(r, /view SQL:/, r);
r = await call("sqlDescribe", { connection: "pg", table: "game.missing" });
assert.match(r, /no table or view/, r);
console.log("metadata: ok");

// Changes.
r = await call("sqlExecute", { sql: "UPDATE players SET score = score + 1" });
assert.match(r, /^refused: statement 1 is UPDATE with no WHERE/, r);
r = await call("sqlExecute", { sql: "UPDATE players SET score = score + 1 WHERE id = :id", params: { id: 1 }, dry_run: true });
assert.match(r, /DRY RUN/, r);
assert.match(r, /1 row\(s\) affected/, r);
r = await call("sqlQuery", { sql: "SELECT score FROM players WHERE id = 1" });
assert.match(r, /\n10$/, r);                      // the dry run left it alone
r = await call("sqlExecute", { sql: "UPDATE players SET score = 11 WHERE id = 1; INSERT INTO players (name) VALUES ('eve')" });
assert.match(r, /committed as one transaction/, r);
assert.match(r, /2\. INSERT: 1 row\(s\) affected, insert id 4/, r);
r = await call("sqlExecute", { sql: "INSERT INTO players (name) VALUES ('fay'); INSERT INTO nope VALUES (1)" });
assert.match(r, /statement 2 of 2 failed; the 1 statement\(s\) before it were rolled back/, r);
r = await call("sqlQuery", { sql: "SELECT COUNT(*) AS n FROM players WHERE name = 'fay'" });
assert.match(r, /\n0$/, r);
r = await call("sqlExecute", { connection: "myro", sql: "DELETE FROM players WHERE id = 1" });
assert.match(r, /^refused: the connection "myro" is read-only/, r);
r = await call("sqlExecute", { sql: "DELETE FROM players WHERE id = 1" }, { ...config, readOnly: true });
assert.match(r, /read-only \(the package's `readOnly` setting\)/, r);
r = await call("sqlExecute", { connection: "pg", sql: "UPDATE game.cards SET cost = 2 WHERE title = 'Imp' RETURNING id, cost" });
assert.match(r, /UPDATE: 1 row\(s\)/, r);
r = await call("sqlExecute", { connection: "pg", sql: "ALTER TABLE game.cards ADD COLUMN rare bool", dry_run: true });
assert.match(r, /DRY RUN/, r);
r = await call("sqlDescribe", { connection: "pg", table: "game.cards" });
assert.doesNotMatch(r, /rare/, r);                // postgres DDL rolls back
r = await call("sqlExecute", { connection: "myroot", sql: "ALTER TABLE players ADD COLUMN x INT", dry_run: true });
assert.match(r, /^cannot dry-run: MySQL commits ALTER/, r);
console.log("execute: ok");

// Through the proxy: a container on the bridge network, and a local process.
r = await call("sqlStatus", { connection: "cs_docker" });
assert.match(r, /via the proxy docker, started now/, r);
assert.match(r, /logged in as app/, r);
r = await call("sqlQuery", { connection: "cs_docker", sql: "SELECT name FROM players ORDER BY id LIMIT 1" });
assert.match(r, /via the proxy docker\)/, r);     // reused, not started again
assert.doesNotMatch(r, /started now/, r);
assert.match(r, /\nann$/, r);
r = await call("sqlQuery", { connection: "cs_binary", sql: "SELECT title FROM game.cards ORDER BY id LIMIT 1" });
assert.match(r, /via the proxy binary, started now/, r);
assert.match(r, /\nImp$/, r);
r = await call("sqlProxy", { action: "list" });
assert.match(r, /inst · docker thetis-sqlproxy-/, r);
assert.match(r, /inst · binary pid \d+ · up at 127\.0\.0\.1:\d+/, r);
r = await call("sqlProxy", { action: "logs", connection: "cs_docker" });
assert.match(r, /Connection test passed/, r);
r = await call("sqlStatus");
assert.match(r, /cs_docker · mysql · p:[\d.]+_3306:inst via the Cloud SQL proxy \(docker\)/, r);
assert.match(r, /password: the `passwords` setting/, r);
assert.doesNotMatch(r, /apppw|rootpw|pgpw/, r);   // no password in any answer
assert.match(r, /proxies:/, r);
await assert.rejects(() => call("sqlQuery", { connection: "cs_denied", sql: "SELECT 1" }), (e) => {
  assert.match(e.message, /did not come up \(docker\).*NOT_AUTHORIZED/s);
  assert.match(e.message, /roles\/cloudsql\.client/);
  return true;
});
// Idle reaping: a proxy past its idle time is stopped by the service's tick.
const svc = await index.startService({ ...env, log: () => {} });
await svc.stop();
const { reapIdle } = await import("./lib/proxy.js");
let gone = await reapIdle(env, Date.now() + 31 * 60_000);
assert.equal(gone.length, 2, `reaped ${gone.length}`);
assert.equal((await listProxies(env)).length, 0);
// And the next query starts it again by itself.
r = await call("sqlQuery", { connection: "cs_docker", sql: "SELECT 1 AS one" });
assert.match(r, /started now/, r);
r = await call("sqlProxy", { action: "stop" });
assert.match(r, /stopped 1/, r);
console.log("proxy: ok");

if (process.env.SQL_TEST_REAL_PROXY) {
  const inst = process.env.SQL_TEST_INSTANCE;
  const cfg = { connections: { real: { instance: inst, user: process.env.SQL_TEST_USER || "root", proxy: "docker" } }, googleCredentialFile: process.env.SQL_TEST_KEY };
  try {
    r = await call("sqlStatus", { connection: "real" }, cfg);
    console.log(`real proxy: ${r.split("\n")[1]}`);
  } catch (e) {
    console.log(`real proxy: ${e.message.split("\n")[0]}`);
  }
  await stopProxies({ ...env, config: cfg });
}

await stopProxies(env);
console.log("smoke: all ok");

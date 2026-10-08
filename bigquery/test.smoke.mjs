// Smoke test: a small in-memory BigQuery and OAuth token endpoint behind a
// real local HTTP server, and the tools driven through the same (args, env)
// interface the kernel uses. Needs no Google credentials. Run: node test.smoke.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, createVerify } from "node:crypto";
import * as bq from "./client.js";
import * as index from "./index.js";

// --- manifest ↔ exports --------------------------------------------------------
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
assert.equal(pkg.name, "@thetis/bigquery");
for (const t of pkg.thetis.tools) {
  assert.equal(typeof index[t.export], "function", `export ${t.export} for ${t.name}`);
  assert.ok(t.description.length > 40, `${t.name} has a description`);
  assert.equal(t.parameters.type, "object");
  assert.equal(typeof t.reads, "boolean", `${t.name} declares reads`);
  assert.ok(t.name.startsWith("bigquery_"));
}
assert.equal(pkg.thetis.config.credentialsJson.secret, true);
assert.equal(pkg.thetis.tools.find((t) => t.name === "bigquery_execute").reads, false);
console.log(`manifest: ${pkg.thetis.tools.length} tools wired: ok`);

// --- helpers -------------------------------------------------------------------
assert.deepEqual(bq.parseTableRef("`p-1.ds.t`"), { projectId: "p-1", datasetId: "ds", tableId: "t" });
assert.deepEqual(bq.parseTableRef("example.com:p:ds.t"), { projectId: "example.com:p", datasetId: "ds", tableId: "t" });
assert.deepEqual(bq.parseTableRef("t", { project: "p", dataset: "d" }), { projectId: "p", datasetId: "d", tableId: "t" });
assert.throws(() => bq.parseTableRef("t", { project: "p" }), /names no dataset/);
assert.deepEqual(bq.parseDatasetRef("other.ds", { project: "p" }), { projectId: "other", datasetId: "ds" });

assert.deepEqual(bq.queryParameters({ n: 3, f: 1.5, b: true, s: "x", a: [1, 2], d: { type: "DATE", value: "2026-01-01" } }), [
  { name: "n", parameterType: { type: "INT64" }, parameterValue: { value: "3" } },
  { name: "f", parameterType: { type: "FLOAT64" }, parameterValue: { value: "1.5" } },
  { name: "b", parameterType: { type: "BOOL" }, parameterValue: { value: "true" } },
  { name: "s", parameterType: { type: "STRING" }, parameterValue: { value: "x" } },
  { name: "a", parameterType: { type: "ARRAY", arrayType: { type: "INT64" } }, parameterValue: { arrayValues: [{ value: "1" }, { value: "2" }] } },
  { name: "d", parameterType: { type: "DATE" }, parameterValue: { value: "2026-01-01" } },
]);
assert.throws(() => bq.queryParameters("not json"), /params/);

const schema = {
  fields: [
    { name: "id", type: "INTEGER" },
    { name: "big", type: "INT64" },
    { name: "t", type: "TIMESTAMP" },
    { name: "ok", type: "BOOLEAN" },
    { name: "tags", type: "STRING", mode: "REPEATED" },
    { name: "kv", type: "RECORD", mode: "REPEATED", fields: [{ name: "k", type: "STRING" }, { name: "v", type: "FLOAT" }] },
    { name: "none", type: "STRING" },
  ],
};
const row = { f: [{ v: "7" }, { v: "9007199254740993" }, { v: "1791432005359664" }, { v: "true" }, { v: [{ v: "a" }, { v: "b" }] }, { v: [{ v: { f: [{ v: "x" }, { v: "1.5" }] } }] }, { v: null }] };
assert.deepEqual(bq.decodeRows(schema, [row]), [
  { id: 7, big: "9007199254740993", t: "2026-10-08T04:00:05.359664Z", ok: true, tags: ["a", "b"], kv: [{ k: "x", v: 1.5 }], none: null },
]);
assert.equal(bq.renderRows([{ a: "x,y", b: null }], ["a", "b"], "csv"), 'a,b\n"x,y",');
assert.equal(bq.renderRows([{ a: "l1\nl2", b: { c: 1 } }], ["a", "b"]), "a | b\nl1⏎l2 | {\"c\":1}");
assert.deepEqual(bq.renderSchema(schema.fields.slice(4, 6)), ["tags STRING REPEATED", "kv RECORD REPEATED", "  k STRING", "  v FLOAT"]);
assert.match(bq.explainError({ bq: { message: "Syntax error at [2:3]", errors: [{ reason: "invalidQuery" }] } }, "SELECT\n  FRM x"), /2 \|   FRM x\n\s+\|   \^/);
assert.match(bq.explainError({ status: 403, bq: { message: "Access Denied", errors: [{ reason: "accessDenied" }] } }), /IAM/);
assert.equal(bq.cost(2 ** 40), "≈ $6.25");
const g = index.groupShards(["events_20260101", "events_20260102", "events_intraday_20260103", "users"].map((tableId) => ({ tableReference: { tableId }, type: "TABLE" })));
assert.deepEqual(g.map((x) => x.name), ["events_*", "events_intraday_20260103", "users"]);
assert.equal(g[0].count, 2);
console.log("helpers: ok");

// --- an in-memory BigQuery ---------------------------------------------------------
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TOKEN = "ya29.fake-token";
let tokenCalls = 0;
const seen = [];

const tables = {
  ds: {
    events_20260101: { type: "TABLE", schema: { fields: [{ name: "name", type: "STRING" }, { name: "n", type: "INTEGER" }] }, numRows: "2", numBytes: "100" },
    events_20260102: { type: "TABLE", schema: { fields: [{ name: "name", type: "STRING" }, { name: "n", type: "INTEGER" }] }, numRows: "2", numBytes: "100" },
    users: { type: "TABLE", schema: { fields: [{ name: "id", type: "STRING", mode: "REQUIRED" }] }, timePartitioning: { type: "DAY", field: "day" }, numRows: "1", numBytes: "10" },
    v: { type: "VIEW", schema: { fields: [{ name: "id", type: "STRING" }] }, view: { query: "SELECT id FROM ds.users" } },
  },
};
const jobs = new Map();

function statementOf(sql) {
  const w = sql.trim().split(/\s+/)[0].toUpperCase();
  return { SELECT: "SELECT", WITH: "SELECT", DELETE: "DELETE", INSERT: "INSERT", CREATE: "CREATE_TABLE", DECLARE: "SCRIPT" }[w] ?? "SELECT";
}
const bytesOf = (sql) => (/huge/.test(sql) ? 50e9 : 1000);

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const url = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.pathname === "/token") {
    const p = new URLSearchParams(body);
    const [h, c, s] = p.get("assertion").split(".");
    const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, s, "base64url");
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    if (!ok || claims.iss !== "sa@p.iam.gserviceaccount.com") return send(400, { error: "invalid_grant", error_description: "bad signature" });
    tokenCalls++;
    return send(200, { access_token: TOKEN, expires_in: 3600 });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: 401, message: "no auth" } });
  const path = url.pathname.replace(/^\/bq/, "");
  seen.push(`${req.method} ${path}`);
  let m;
  if (req.method === "GET" && path === "/projects/p/datasets")
    return send(200, { datasets: [{ datasetReference: { projectId: "p", datasetId: "ds" }, location: "US" }] });
  if (req.method === "GET" && path === "/projects/p/datasets/ds")
    return send(200, { location: "US", access: [{ role: "READER", specialGroup: "projectReaders" }, { role: "WRITER", userByEmail: "sa@p.iam.gserviceaccount.com" }] });
  if ((m = /^\/projects\/p\/datasets\/ds\/tables$/.exec(path)))
    return send(200, { tables: Object.entries(tables.ds).map(([tableId, t]) => ({ tableReference: { projectId: "p", datasetId: "ds", tableId }, type: t.type, timePartitioning: t.timePartitioning })) });
  if ((m = /^\/projects\/p\/datasets\/ds\/tables\/([^/]+)$/.exec(path))) {
    const t = tables.ds[decodeURIComponent(m[1])];
    return t ? send(200, { location: "US", ...t }) : send(404, { error: { code: 404, message: `Not found: Table p:ds.${m[1]}`, errors: [{ reason: "notFound" }] } });
  }
  if ((m = /^\/projects\/p\/datasets\/ds\/tables\/([^/]+)\/data$/.exec(path))) {
    assert.equal(url.searchParams.get("formatOptions.useInt64Timestamp"), "true");
    return send(200, { totalRows: "2", rows: [{ f: [{ v: "a" }, { v: "1" }] }, { f: [{ v: "b" }, { v: "2" }] }] });
  }
  if (req.method === "POST" && path === "/projects/p/jobs") {
    const j = JSON.parse(body);
    assert.equal(j.configuration.dryRun, true);
    const sql = j.configuration.query.query;
    if (/SELEC\b/.test(sql)) return send(400, { error: { code: 400, message: "Syntax error: Unexpected identifier \"SELEC\" at [1:1]", errors: [{ reason: "invalidQuery" }] } });
    return send(200, { statistics: { totalBytesProcessed: String(bytesOf(sql)), query: { statementType: statementOf(sql), referencedTables: [{ projectId: "p", datasetId: "ds", tableId: "users" }], schema: { fields: [{ name: "n", type: "INTEGER" }] } } } });
  }
  if (req.method === "POST" && path === "/projects/p/queries") {
    const q = JSON.parse(body);
    assert.equal(q.useLegacySql, false);
    assert.ok(Number(q.maximumBytesBilled) > 0, "every run carries maximumBytesBilled");
    assert.equal(q.formatOptions.useInt64Timestamp, true);
    const jobId = `job_${jobs.size + 1}`;
    const type = statementOf(q.query);
    const all = type === "SELECT" ? Array.from({ length: 5 }, (_, i) => ({ f: [{ v: String(i) }] })) : [];
    const job = { type, all, sql: q.query, slow: /slow/.test(q.query), polls: 0 };
    jobs.set(jobId, job);
    const ref = { projectId: "p", jobId, location: "US" };
    if (job.slow) return send(200, { jobReference: ref, jobComplete: false });
    return send(200, {
      jobReference: ref, jobComplete: true, totalBytesProcessed: "1000", totalBytesBilled: "10485760",
      ...(type === "SELECT" ? { schema: { fields: [{ name: "n", type: "INTEGER" }] }, totalRows: String(all.length), rows: all.slice(0, q.maxResults) } : { numDmlAffectedRows: "3", dmlStats: { deletedRowCount: "3" } }),
    });
  }
  if ((m = /^\/projects\/p\/queries\/([^/]+)$/.exec(path))) {
    const job = jobs.get(m[1]);
    if (job.slow) return send(200, { jobReference: { projectId: "p", jobId: m[1], location: "US" }, jobComplete: false });
    const start = Number(url.searchParams.get("startIndex") ?? 0), max = Number(url.searchParams.get("maxResults") ?? 100);
    return send(200, { jobComplete: true, schema: { fields: [{ name: "n", type: "INTEGER" }] }, totalRows: String(job.all.length), rows: job.all.slice(start, start + max) });
  }
  if ((m = /^\/projects\/p\/jobs\/([^/]+)(\/cancel)?$/.exec(path))) {
    const job = jobs.get(m[1]);
    if (m[2]) return send(200, { job: { jobReference: { projectId: "p", jobId: m[1], location: "US" }, status: { state: "DONE" } } });
    return send(200, {
      jobReference: { projectId: "p", jobId: m[1], location: "US" }, user_email: "sa@p.iam.gserviceaccount.com",
      status: { state: job.slow ? "RUNNING" : "DONE" }, configuration: { query: { query: job.sql } },
      statistics: { creationTime: "1791432005000", query: { statementType: job.type, totalBytesBilled: "10485760" } },
    });
  }
  send(404, { error: { code: 404, message: `no route ${req.method} ${path}` } });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const key = JSON.stringify({
  type: "service_account", project_id: "p", private_key_id: "k1", client_email: "sa@p.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: `${base}/token`,
});
const env = (cfg = {}) => ({ config: { credentialsJson: key, apiUrl: `${base}/bq`, ...cfg }, exec: async () => ({ code: 1, stdout: "", stderr: "not here" }), readFile: async () => key });

try {
  // credentials
  await assert.rejects(() => index.bigqueryStatus({}, { config: {}, exec: async () => ({ code: 1, stdout: "", stderr: "" }) }), /no BigQuery credentials/);
  await assert.rejects(() => index.bigqueryStatus({}, { config: { credentialsJson: "{}" } }), /not a service account key/);
  let out = await index.bigqueryStatus({}, env());
  assert.match(out, /account: sa@p\.iam\.gserviceaccount\.com/);
  assert.match(out, /project: p /);
  assert.match(out, /credential: works/);
  out = await index.bigqueryStatus({}, { ...env(), config: { credentialFile: "/k.json", apiUrl: `${base}/bq` } });
  assert.match(out, /credentialFile \/k\.json/);
  assert.equal(tokenCalls, 1, "the token is cached across calls");
  console.log("credentials: ok");

  // metadata
  out = await index.bigqueryDatasets({}, env());
  assert.match(out, /ds\s+US/);
  out = await index.bigqueryDatasets({ dataset: "ds" }, env());
  assert.match(out, /WRITER: sa@p/);
  assert.match(out, /tables: 4 \(3 after grouping date shards\)/);
  out = await index.bigqueryTables({ dataset: "ds" }, env());
  assert.match(out, /events_\*\s+TABLE ×2 date shards 20260101…20260102/);
  assert.match(out, /users\s+TABLE\s+partitioned by DAY\(day\)/);
  out = await index.bigqueryTable({ table: "ds.events_*", preview_rows: 2 }, env());
  assert.match(out, /showing the latest, events_20260102/);
  assert.match(out, /name \| n\na \| 1\nb \| 2/);
  out = await index.bigqueryTable({ table: "v", dataset: "ds", preview_rows: 2 }, env());
  assert.match(out, /view SQL:\nSELECT id FROM ds\.users/);
  assert.match(out, /no preview: a VIEW/);
  out = await index.bigqueryTable({ table: "ds.nope" }, env());
  assert.match(out, /BigQuery error \(notFound\)/);
  console.log("metadata: ok");

  // queries
  out = await index.bigqueryQuery({ sql: "SELECT n FROM ds.users", max_rows: 2 }, env());
  assert.match(out, /^SELECT · 5 row\(s\) \(showing 2\) · scanned 1.00 KB, billed 10.5 MB/);
  assert.match(out, /n\n0\n1\nmore: bigquery_job job_id="p:US\.job_\d+" start_row=2/);
  const jid = /job_id="([^"]+)"/.exec(out)[1];
  out = await index.bigqueryJob({ job_id: jid, start_row: 2, max_rows: 2, format: "csv" }, env());
  assert.match(out, /rows 2–3 of 5:\nn\n2\n3\nmore: start_row=4/);
  out = await index.bigqueryQuery({ sql: "SELECT huge FROM ds.users" }, env());
  assert.match(out, /^refused: it would scan 50.0 GB, over the 25 GB cap/);
  out = await index.bigqueryQuery({ sql: "SELECT n FROM ds.users", max_gb: 0.0000001 }, env());
  assert.match(out, /over the 1e-7 GB cap you passed as max_gb/);
  out = await index.bigqueryQuery({ sql: "SELECT huge FROM ds.users", max_gb: 999 }, env());
  assert.match(out, /refused/, "max_gb cannot raise the cap");
  out = await index.bigqueryQuery({ sql: "DELETE FROM ds.users WHERE true" }, env());
  assert.match(out, /^refused: this is a DELETE statement and bigquery_query runs SELECT only/);
  out = await index.bigqueryQuery({ sql: "SELECT n FROM ds.users", dry_run: true }, env());
  assert.match(out, /^dry run, nothing was run: SELECT · would scan 1.00 KB/);
  out = await index.bigqueryQuery({ sql: "SELEC 1" }, env());
  assert.match(out, /invalidQuery[\s\S]*1 \| SELEC 1\n\s+\| \^/);
  out = await index.bigqueryQuery({ sql: "SELECT slow FROM ds.users", timeout_s: 5 }, env());
  assert.match(out, /^still running after 5s as job p:US\.job_\d+/);
  const slow = /job_id="([^"]+)"/.exec(out)[1];
  out = await index.bigqueryJob({ job_id: slow }, env());
  assert.match(out, /still RUNNING/);
  out = await index.bigqueryJob({ job_id: slow, cancel: true }, env());
  assert.match(out, /cancel requested/);
  console.log("queries: ok");

  // writes
  out = await index.bigqueryExecute({ sql: "DELETE FROM ds.users WHERE true" }, env());
  assert.match(out, /^DELETE · 3 row\(s\) affected · 3 deleted · scanned/);
  assert.doesNotMatch(out, /no rows/);
  out = await index.bigqueryExecute({ sql: "DELETE FROM ds.users WHERE true" }, env({ readOnly: true }));
  assert.match(out, /^refused: this package is read-only/);
  out = await index.bigqueryExecute({ sql: "SELECT 1" }, env());
  assert.match(out, /plain SELECT: run it with bigquery_query/);
  console.log("writes: ok");
} finally {
  server.close();
}
console.log("all ok");

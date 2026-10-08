// Shared BigQuery REST client, credentials, value decoding and rendering.
//
// Every bigquery_* tool imports this one module. It talks to the BigQuery v2
// REST API (https://bigquery.googleapis.com/bigquery/v2) with fetch, so the
// space needs no SDK and no gcloud: a service account key in the settings is
// signed into an OAuth token here (RS256 JWT, node:crypto) and cached until
// shortly before it expires. Without a key it falls back to the space's own
// gcloud login (`gcloud auth print-access-token`), whose token never leaves
// this module.
//
// Two habits keep a model from spending money by accident: every query is
// dry-run first, which costs nothing and answers the statement type and the
// bytes it would scan, and every real run carries maximumBytesBilled, so a
// query BigQuery finds bigger than the cap fails before it is billed.

import { createSign } from "node:crypto";

export const DEFAULT_API_URL = "https://bigquery.googleapis.com/bigquery/v2";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_GB = 25;
export const DEFAULT_MAX_ROWS = 100;
export const HARD_MAX_ROWS = 1000;
export const MAX_OUTPUT_CHARS = 20_000;
// On-demand analysis price per TiB scanned (US multi-region, 2026). Only an
// estimate: a project on reservations (editions) pays for slots instead.
export const USD_PER_TIB = 6.25;
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const JOB_LABELS = { client: "thetis" };

const MISSING_CREDENTIALS =
  "no BigQuery credentials. Set `credentialsJson` on this package to a service account key (the whole " +
  "JSON file from IAM → Service accounts → Keys), or `credentialFile` to the path of one in this space, " +
  "or log gcloud in yourself in a terminal (`gcloud auth login --no-launch-browser`). The person can do it " +
  "in the control panel (Configure on the package), or you can call configure_package with the value they " +
  "give you. The account needs roles/bigquery.jobUser on the project to run queries, and " +
  "roles/bigquery.dataViewer (read) or dataEditor (write) on the datasets.";

// ---------------------------------------------------------------- helpers ---

export function clip(s, n = MAX_OUTPUT_CHARS, hint = "ask for fewer rows or columns") {
  s = String(s ?? "");
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.85), tail = n - head;
  return `${s.slice(0, head)}\n… [${s.length - n} characters cut; ${hint}] …\n${s.slice(-tail)}`;
}

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

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** Decimal byte sizes, the way the console shows them. */
export function bytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0, x = v;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  return `${i ? x.toFixed(x < 10 ? 2 : x < 100 ? 1 : 0) : x} ${units[i]}`;
}

/** "≈ $0.12" for a byte count at the on-demand price. */
export function cost(n) {
  const usd = (Number(n) / 2 ** 40) * USD_PER_TIB;
  if (!Number.isFinite(usd)) return "";
  return usd < 0.01 ? "< $0.01" : `≈ $${usd.toFixed(2)}`;
}

export function when(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().replace(/\.\d{3}Z$/, "Z") : "-";
}

// -------------------------------------------------------------- references --

/**
 * Splits a table reference: `project.dataset.table`, `project:dataset.table`,
 * `dataset.table` or `table`, backticks allowed. Missing parts come from the
 * defaults. The project may contain dashes and a domain prefix (`example.com:proj`).
 */
export function parseTableRef(ref, defaults = {}) {
  let s = str(ref).replace(/`/g, "");
  if (!s) throw new Error("name a table, e.g. `my_dataset.my_table`");
  let project = null;
  const colon = s.lastIndexOf(":");
  if (colon > 0) { project = s.slice(0, colon); s = s.slice(colon + 1); }
  const parts = s.split(".");
  if (!project && parts.length >= 3) project = parts.splice(0, parts.length - 2).join(".");
  if (parts.length > 2) throw new Error(`not a table reference: ${ref}`);
  const tableId = parts.pop();
  const datasetId = parts.pop() ?? str(defaults.dataset);
  project = project ?? str(defaults.project);
  if (!datasetId) throw new Error(`\`${ref}\` names no dataset: write it as dataset.table, or set the package's \`dataset\` setting`);
  if (!project) throw new Error("no project: set the package's `project` setting or write project.dataset.table");
  return { projectId: project, datasetId, tableId };
}

export function parseDatasetRef(ref, defaults = {}) {
  let s = str(ref).replace(/`/g, "");
  if (!s) s = str(defaults.dataset);
  if (!s) throw new Error("name a dataset (bigquery_datasets lists them), or set the package's `dataset` setting");
  let project = null;
  const colon = s.lastIndexOf(":");
  if (colon > 0) { project = s.slice(0, colon); s = s.slice(colon + 1); }
  const parts = s.split(".");
  if (!project && parts.length >= 2) project = parts.splice(0, parts.length - 1).join(".");
  project = project ?? str(defaults.project);
  if (!project) throw new Error("no project: set the package's `project` setting or write project.dataset");
  return { projectId: project, datasetId: parts[0] };
}

// ---------------------------------------------------------- query params ----

function paramType(v) {
  if (typeof v === "boolean") return { type: "BOOL" };
  if (typeof v === "number") return { type: Number.isInteger(v) ? "INT64" : "FLOAT64" };
  if (Array.isArray(v)) {
    const first = v.find((x) => x !== null && x !== undefined);
    return { type: "ARRAY", arrayType: first === undefined ? { type: "STRING" } : paramType(first) };
  }
  return { type: "STRING" };
}

function paramValue(v) {
  if (Array.isArray(v)) return { arrayValues: v.map(paramValue) };
  return { value: v === null || v === undefined ? null : String(v) };
}

/**
 * Named query parameters from `{name: value}`. A value of the form
 * `{type: "DATE", value: "2026-01-01"}` names its type; anything else is
 * inferred (integer → INT64, other number → FLOAT64, boolean → BOOL, list →
 * ARRAY, else STRING). Referenced in SQL as @name.
 */
export function queryParameters(params) {
  if (params === undefined || params === null || params === "") return undefined;
  let p = params;
  if (typeof p === "string") {
    try { p = JSON.parse(p); } catch { throw new Error("`params` must be an object {name: value}, e.g. {\"day\": \"2026-01-01\"}"); }
  }
  if (typeof p !== "object" || Array.isArray(p)) throw new Error("`params` must be an object {name: value}");
  return Object.entries(p).map(([name, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v.type === "string") {
      const type = v.type.toUpperCase();
      if (type === "ARRAY" || type.startsWith("ARRAY<")) {
        const inner = type.startsWith("ARRAY<") ? type.slice(6, -1) : str(v.arrayType).toUpperCase() || "STRING";
        return { name, parameterType: { type: "ARRAY", arrayType: { type: inner } }, parameterValue: paramValue(v.value ?? []) };
      }
      return { name, parameterType: { type }, parameterValue: paramValue(v.value) };
    }
    return { name, parameterType: paramType(v), parameterValue: paramValue(v) };
  });
}

// ------------------------------------------------------------ values -------

function timestampOf(v) {
  // useInt64Timestamp: microseconds since the epoch, as a decimal string.
  if (!/^-?\d+$/.test(String(v))) return v;
  const us = BigInt(v);
  let ms = us / 1000n, rem = us % 1000n;
  if (rem < 0n) { rem += 1000n; ms -= 1n; }
  const iso = new Date(Number(ms)).toISOString();
  return rem ? iso.replace("Z", `${String(rem).padStart(3, "0")}Z`) : iso;
}

function scalar(field, v) {
  if (v === null || v === undefined) return null;
  switch (String(field.type).toUpperCase()) {
    case "RECORD":
    case "STRUCT":
      return decodeRow(field.fields ?? [], v);
    case "INTEGER":
    case "INT64": {
      const n = Number(v);
      return Number.isSafeInteger(n) ? n : String(v);
    }
    case "FLOAT":
    case "FLOAT64": {
      const n = Number(v);
      return Number.isFinite(n) ? n : String(v);
    }
    case "BOOLEAN":
    case "BOOL":
      return v === true || v === "true";
    case "TIMESTAMP":
      return timestampOf(v);
    default:
      return v;
  }
}

function value(field, v) {
  if (String(field.mode).toUpperCase() === "REPEATED") return (Array.isArray(v) ? v : []).map((x) => scalar(field, x?.v));
  return scalar(field, v);
}

/** One `{f: [{v}]}` row into a plain object, by the schema's fields. */
export function decodeRow(fields, row) {
  const out = {};
  const cells = row?.f ?? [];
  fields.forEach((field, i) => { out[field.name] = value(field, cells[i]?.v); });
  return out;
}

export function decodeRows(schema, rows) {
  const fields = schema?.fields ?? [];
  return (rows ?? []).map((r) => decodeRow(fields, r));
}

// ------------------------------------------------------------ rendering -----

function cell(v, width) {
  let s = v === null || v === undefined ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v);
  s = s.replace(/\r?\n/g, "⏎").replace(/\|/g, "¦");
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as `table` (pipes, one line per row), `csv` or `json` (an array). */
export function renderRows(rows, columns, format = "table", cellChars = 300) {
  const cols = columns?.length ? columns : rows[0] ? Object.keys(rows[0]) : [];
  if (format === "json") return JSON.stringify(rows);
  if (format === "csv") return [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
  return [cols.join(" | "), ...rows.map((r) => cols.map((c) => cell(r[c], cellChars)).join(" | "))].join("\n");
}

/** A schema as indented lines: `name TYPE [REPEATED|NOT NULL] — description`. */
export function renderSchema(fields, depth = 0, out = []) {
  for (const f of fields ?? []) {
    const mode = f.mode === "REPEATED" ? " REPEATED" : f.mode === "REQUIRED" ? " NOT NULL" : "";
    const desc = f.description ? ` — ${String(f.description).replace(/\s+/g, " ").slice(0, 200)}` : "";
    out.push(`${"  ".repeat(depth)}${f.name} ${f.type}${mode}${desc}`);
    if (f.fields) renderSchema(f.fields, depth + 1, out);
  }
  return out;
}

export function countFields(fields) {
  return (fields ?? []).reduce((n, f) => n + 1 + countFields(f.fields), 0);
}

/**
 * A BigQuery error as one paragraph a model can act on. `sql`, when given,
 * lets a syntax error point at its line.
 */
export function explainError(err, sql) {
  const e = err?.bq ?? {};
  const reason = e.errors?.[0]?.reason ?? e.status ?? "";
  let msg = String(e.message ?? err?.message ?? err);
  const lines = [];
  const at = /\[(\d+):(\d+)\]/.exec(msg);
  if (sql && at) {
    const ln = Number(at[1]), col = Number(at[2]);
    const src = String(sql).split("\n")[ln - 1];
    if (src !== undefined) lines.push(`  ${ln} | ${src}`, `  ${" ".repeat(String(ln).length)} | ${" ".repeat(Math.max(0, col - 1))}^`);
  }
  let hint = "";
  if (reason === "accessDenied" || err?.status === 403)
    hint = "This is the credential's IAM, not a setting of this package: the account needs roles/bigquery.jobUser on the project to run jobs, dataViewer to read a dataset, dataEditor to write one. bigquery_status shows which account this is.";
  else if (reason === "bytesBilledLimitExceeded")
    hint = "BigQuery stopped it before billing anything. Scan less: select fewer columns, filter on the partition column or the _TABLE_SUFFIX of a sharded table, or ask the person to raise `maxGbBilled`.";
  else if (reason === "notFound" || err?.status === 404)
    hint = "bigquery_datasets and bigquery_tables list what exists; names are case-sensitive.";
  else if (reason === "responseTooLarge")
    hint = "Aggregate or LIMIT the result.";
  else if (reason === "rateLimitExceeded" || reason === "quotaExceeded")
    hint = "Wait and try again, or run fewer queries at once.";
  return [`BigQuery error${reason ? ` (${reason})` : ""}: ${msg}`, ...lines, ...(hint ? [hint] : [])].join("\n");
}

// ---------------------------------------------------------- credentials -----

const tokenCache = new Map();

function parseKey(text, where) {
  let key;
  try { key = JSON.parse(text); } catch { throw new Error(`${where} is not JSON: paste the whole service account key file`); }
  if (key?.type !== "service_account" || !key.client_email || !key.private_key)
    throw new Error(`${where} is not a service account key (it needs type "service_account", client_email and private_key)`);
  return key;
}

export function signJwt(key, now = Math.floor(Date.now() / 1000)) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) });
  const claims = b64({ iss: key.client_email, scope: SCOPE, aud: key.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(key.private_key, "base64url");
  return `${head}.${claims}.${sig}`;
}

async function keyToken(key, timeoutMs) {
  const id = `${key.client_email}#${key.private_key_id ?? ""}`;
  const hit = tokenCache.get(id);
  if (hit && hit.exp - 120_000 > Date.now()) return hit.token;
  const uri = key.token_uri || "https://oauth2.googleapis.com/token";
  const res = await fetch(uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(key) }),
    signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token)
    throw new Error(`Google refused the service account key for ${key.client_email}: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}. The key may be deleted or disabled; make a new one in IAM → Service accounts → Keys.`);
  tokenCache.set(id, { token: body.access_token, exp: Date.now() + Number(body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function gcloudToken(env, cfg) {
  const account = str(cfg.account);
  const id = `gcloud#${account}`;
  const hit = tokenCache.get(id);
  if (hit && hit.exp > Date.now()) return { token: hit.token, account: hit.account };
  if (typeof env?.exec !== "function") throw new Error(MISSING_CREDENTIALS);
  const vars = { CLOUDSDK_CORE_DISABLE_PROMPTS: "1" };
  if (account) vars.CLOUDSDK_CORE_ACCOUNT = account;
  const r = await env.exec("gcloud auth print-access-token </dev/null 2>&1 && gcloud config get-value account 2>/dev/null", { timeoutMs: 30_000, env: vars });
  const [token, who] = String(r.stdout ?? "").trim().split("\n");
  if (r.code !== 0 || !/^ya29\.|^[A-Za-z0-9._-]{40,}$/.test(token ?? "")) throw new Error(MISSING_CREDENTIALS);
  // gcloud tokens live about an hour; reuse one for ten minutes.
  tokenCache.set(id, { token, account: account || who || "gcloud's active account", exp: Date.now() + 600_000 });
  return { token, account: account || who || "gcloud's active account" };
}

/**
 * The credential the package settings describe: `credentialsJson`, else
 * `credentialFile`, else gcloud's own login. Answers who it acts as and a
 * function that yields a bearer token.
 */
export async function credentials(cfg, env) {
  let key = null, source = null;
  if (str(cfg.credentialsJson)) { key = parseKey(str(cfg.credentialsJson), "the `credentialsJson` setting"); source = "credentialsJson setting"; }
  else if (str(cfg.credentialFile)) {
    let text;
    try { text = await env.readFile(str(cfg.credentialFile)); } catch (e) { throw new Error(`could not read credentialFile ${cfg.credentialFile}: ${e?.message ?? e}`); }
    key = parseKey(text, `credentialFile ${cfg.credentialFile}`);
    source = `credentialFile ${cfg.credentialFile}`;
  }
  const timeoutMs = clampInt(cfg.timeoutMs, DEFAULT_TIMEOUT_MS, 5_000, 600_000);
  if (key) return { who: key.client_email, source, keyProject: key.project_id, token: () => keyToken(key, timeoutMs) };
  const g = await gcloudToken(env, cfg);
  return { who: g.account, source: "gcloud login in this space", keyProject: null, token: async () => (await gcloudToken(env, cfg)).token };
}

// --------------------------------------------------------------- client -----

/** Builds a client from this package's config block and the tool env. */
export async function createClient(config, env) {
  const cfg = config && typeof config === "object" ? config : {};
  const cred = await credentials(cfg, env);
  const project = str(cfg.project) || cred.keyProject || "";
  if (!project) throw new Error("no project: set the package's `project` setting to the Google Cloud project id that runs (and pays for) the queries");
  const apiUrl = (str(cfg.apiUrl) || DEFAULT_API_URL).replace(/\/+$/, "");
  const timeoutMs = clampInt(cfg.timeoutMs, DEFAULT_TIMEOUT_MS, 5_000, 600_000);
  const maxGb = Number(cfg.maxGbBilled ?? DEFAULT_MAX_GB);
  const settings = {
    project,
    dataset: str(cfg.dataset),
    location: str(cfg.location),
    readOnly: boolArg(cfg.readOnly, false),
    maxGb: Number.isFinite(maxGb) && maxGb > 0 ? maxGb : DEFAULT_MAX_GB,
    maxRows: clampInt(cfg.maxRows, DEFAULT_MAX_ROWS, 1, HARD_MAX_ROWS),
    maxChars: clampInt(cfg.maxChars, MAX_OUTPUT_CHARS, 2_000, 200_000),
    timeoutMs,
  };

  async function call(method, path, { query, body, timeout } = {}) {
    const url = new URL(`${apiUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const token = await cred.token();
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout((timeout ?? timeoutMs) + 15_000),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error(json?.error?.message ?? `HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.bq = json?.error ?? null;
      throw err;
    }
    return json ?? {};
  }

  const p = (id) => encodeURIComponent(id);

  /** Every page of a list call, up to `limit` items. */
  async function all(path, key, query = {}, limit = 10_000) {
    const out = [];
    let pageToken;
    do {
      const r = await call("GET", path, { query: { ...query, maxResults: 1000, pageToken } });
      out.push(...(r[key] ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken && out.length < limit);
    return out;
  }

  function jobConfig(sql, opts = {}) {
    const q = {
      query: sql,
      useLegacySql: false,
      ...(opts.params ? { parameterMode: "NAMED", queryParameters: opts.params } : {}),
      ...(opts.dataset ? { defaultDataset: opts.dataset } : {}),
      ...(opts.useCache === false ? { useQueryCache: false } : {}),
      ...(opts.maxBytes ? { maximumBytesBilled: String(opts.maxBytes) } : {}),
    };
    return q;
  }

  return {
    cred,
    settings,
    apiUrl,
    call,

    listDatasets: (projectId = project) => all(`/projects/${p(projectId)}/datasets`, "datasets"),
    getDataset: (r) => call("GET", `/projects/${p(r.projectId)}/datasets/${p(r.datasetId)}`),
    listTables: (r) => all(`/projects/${p(r.projectId)}/datasets/${p(r.datasetId)}/tables`, "tables", {}, 50_000),
    getTable: (r) => call("GET", `/projects/${p(r.projectId)}/datasets/${p(r.datasetId)}/tables/${p(r.tableId)}`),
    tableData: (r, { maxResults, startIndex, selectedFields } = {}) =>
      call("GET", `/projects/${p(r.projectId)}/datasets/${p(r.datasetId)}/tables/${p(r.tableId)}/data`, {
        query: { maxResults, startIndex, selectedFields, "formatOptions.useInt64Timestamp": true },
      }),

    /** A dry run: free, answers statementType, totalBytesProcessed, referencedTables and the output schema. */
    async dryRun(sql, opts = {}) {
      const job = await call("POST", `/projects/${p(project)}/jobs`, {
        body: {
          configuration: { dryRun: true, query: jobConfig(sql, opts) },
          ...(opts.location || settings.location ? { jobReference: { projectId: project, location: opts.location || settings.location } } : {}),
        },
      });
      return job;
    },

    /** Runs a query and waits up to `timeoutMs` for its first page. */
    async query(sql, opts = {}) {
      const wait = opts.timeoutMs ?? timeoutMs;
      const started = Date.now();
      let r = await call("POST", `/projects/${p(project)}/queries`, {
        timeout: Math.min(wait, 200_000),
        body: {
          ...jobConfig(sql, opts),
          timeoutMs: Math.min(wait, 200_000),
          maxResults: opts.maxResults,
          labels: JOB_LABELS,
          formatOptions: { useInt64Timestamp: true },
          ...(opts.location || settings.location ? { location: opts.location || settings.location } : {}),
          requestId: crypto.randomUUID(),
        },
      });
      while (!r.jobComplete && Date.now() - started < wait) {
        const left = wait - (Date.now() - started);
        r = await this.results(r.jobReference, { maxResults: opts.maxResults, timeoutMs: Math.max(1_000, Math.min(left, 60_000)) });
      }
      return r;
    },

    /** jobs.getQueryResults: a page of a finished job, or waits for one. */
    results(ref, { maxResults, startIndex, pageToken, timeoutMs: t } = {}) {
      return call("GET", `/projects/${p(ref.projectId ?? project)}/queries/${p(ref.jobId)}`, {
        timeout: t,
        query: { location: ref.location, maxResults, startIndex, pageToken, timeoutMs: t, "formatOptions.useInt64Timestamp": true },
      });
    },

    getJob: (ref) => call("GET", `/projects/${p(ref.projectId ?? project)}/jobs/${p(ref.jobId)}`, { query: { location: ref.location } }),
    cancelJob: (ref) => call("POST", `/projects/${p(ref.projectId ?? project)}/jobs/${p(ref.jobId)}/cancel`, { query: { location: ref.location } }),
    listJobs: (query) => call("GET", `/projects/${p(project)}/jobs`, { query: { projection: "full", ...query } }),
  };
}

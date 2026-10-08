// The bigquery_* tools. Each takes (args, env) and returns text for the
// model. Everything network goes through client.js.
//
// BigQuery's model, which the tool set follows:
//   project  → owns datasets and runs (and pays for) jobs
//   dataset  → a namespace of tables with one location (US, EU, a region)
//   table    → a table, view, materialized view, external table or snapshot;
//              date-sharded tables (events_20260101, events_20260102, …) are
//              one logical table queried as events_* with _TABLE_SUFFIX
//   job      → every query is a job with an id; a long one can be read later
// Reading metadata and previewing a table's rows is free. A query costs what
// it scans, so bigquery_query and bigquery_execute dry-run first and refuse
// what is bigger than the cap, and the real run carries the same cap.

import {
  createClient,
  clip,
  clampInt,
  boolArg,
  bytes,
  cost,
  when,
  parseTableRef,
  parseDatasetRef,
  queryParameters,
  decodeRows,
  renderRows,
  renderSchema,
  countFields,
  explainError,
  HARD_MAX_ROWS,
} from "./client.js";

const SHARD = /^(.*?)(\d{8})$/;
const FORMATS = new Set(["table", "csv", "json"]);

function formatArg(v) {
  const f = String(v ?? "table").toLowerCase();
  if (!FORMATS.has(f)) throw new Error("`format` is table, csv or json");
  return f;
}

/** Runs body(client) and turns a BigQuery failure into an answer, not a throw. */
async function withClient(env, body, sql) {
  const c = await createClient(env?.config, env);
  try {
    return await body(c);
  } catch (e) {
    if (e?.bq || e?.status) return explainError(e, sql);
    throw e;
  }
}

const tableId = (t) => `${t.projectId}.${t.datasetId}.${t.tableId}`;
const jobId = (ref) => `${ref.projectId}:${ref.location ?? "?"}.${ref.jobId}`;

/** `project:LOCATION.job_id`, `LOCATION.job_id` or a bare id. */
function parseJobRef(s, c, location) {
  let v = String(s ?? "").trim();
  if (!v) throw new Error("give `job_id`, as bigquery_query printed it (project:LOCATION.job_id)");
  let projectId = c.settings.project, loc = location || c.settings.location || undefined;
  const colon = v.lastIndexOf(":");
  if (colon > 0) { projectId = v.slice(0, colon); v = v.slice(colon + 1); }
  const dot = v.indexOf(".");
  if (dot > 0) { loc = v.slice(0, dot); v = v.slice(dot + 1); }
  return { projectId, location: loc, jobId: v };
}

function partitionText(t) {
  const parts = [];
  if (t.timePartitioning) parts.push(`partitioned by ${t.timePartitioning.type}(${t.timePartitioning.field ?? "_PARTITIONTIME"})`);
  if (t.rangePartitioning) parts.push(`partitioned by RANGE(${t.rangePartitioning.field})`);
  if (t.clustering?.fields?.length) parts.push(`clustered by ${t.clustering.fields.join(", ")}`);
  return parts.join(", ");
}

/** Groups date-sharded tables (name + YYYYMMDD) when there are at least two of a prefix. */
export function groupShards(tables) {
  const groups = new Map();
  for (const t of tables) {
    const m = SHARD.exec(t.tableReference.tableId);
    if (!m) continue;
    const g = groups.get(m[1]) ?? [];
    g.push(t);
    groups.set(m[1], g);
  }
  const out = [];
  const seen = new Set();
  for (const t of tables) {
    const m = SHARD.exec(t.tableReference.tableId);
    const g = m && groups.get(m[1]);
    if (g && g.length >= 2) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const ids = g.map((x) => x.tableReference.tableId).sort();
      out.push({ shard: true, name: `${m[1]}*`, count: g.length, first: ids[0].slice(m[1].length), last: ids.at(-1).slice(m[1].length), members: g, type: g[0].type });
    } else out.push({ shard: false, name: t.tableReference.tableId, table: t, type: t.type });
  }
  return out;
}

// ---------------------------------------------------------------- status ----

export async function status(_args, env) {
  const c = await createClient(env?.config, env);
  const s = c.settings;
  const lines = [
    `account: ${c.cred.who} (${c.cred.source})`,
    `project: ${s.project} (runs and pays for queries)`,
    `default dataset: ${s.dataset || "(none: name tables as dataset.table)"}`,
    `location: ${s.location || "(inferred from the tables a query reads)"}`,
    `query cap: ${s.maxGb} GB scanned per query (${cost(s.maxGb * 1e9)} at on-demand pricing); every query is dry-run first`,
    `mode: ${s.readOnly ? "read-only (bigquery_execute refuses)" : "read and write (bigquery_execute runs DML and DDL the account is allowed)"}`,
    `rows per answer: ${s.maxRows} by default, up to ${HARD_MAX_ROWS}`,
  ];
  try {
    const ds = await c.listDatasets();
    lines.push(`datasets in ${s.project}: ${ds.length}`);
    for (const d of ds.slice(0, 40)) lines.push(`  ${d.datasetReference.datasetId}  ${d.location ?? ""}`);
    if (ds.length > 40) lines.push(`  … ${ds.length - 40} more (bigquery_datasets)`);
    lines.push("credential: works");
  } catch (e) {
    lines.push(`credential check failed: ${e?.bq || e?.status ? explainError(e) : e?.message ?? e}`);
  }
  lines.push("What the account may read or write is its IAM roles; this package's settings only narrow it.");
  return lines.join("\n");
}

// -------------------------------------------------------------- datasets ----

export async function datasets(args, env) {
  return withClient(env, async (c) => {
    if (args?.dataset) {
      const ref = parseDatasetRef(args.dataset, { project: args.project || c.settings.project });
      const d = await c.getDataset(ref);
      const lines = [
        `dataset ${ref.projectId}.${ref.datasetId}`,
        `location: ${d.location}`,
        ...(d.description ? [`description: ${d.description}`] : []),
        `created: ${when(d.creationTime)}, modified: ${when(d.lastModifiedTime)}`,
        ...(d.defaultTableExpirationMs ? [`default table expiration: ${Math.round(d.defaultTableExpirationMs / 86_400_000)} days`] : []),
        ...(d.defaultPartitionExpirationMs ? [`default partition expiration: ${Math.round(d.defaultPartitionExpirationMs / 86_400_000)} days`] : []),
        ...(d.labels && Object.keys(d.labels).length ? [`labels: ${Object.entries(d.labels).map(([k, v]) => `${k}=${v}`).join(", ")}`] : []),
      ];
      const roles = new Map();
      for (const a of d.access ?? []) {
        const who = a.userByEmail ?? a.groupByEmail ?? a.specialGroup ?? a.domain ?? a.iamMember ?? (a.view ? `view ${a.view.datasetId}.${a.view.tableId}` : a.dataset ? `dataset ${a.dataset.dataset?.datasetId}` : a.routine ? `routine ${a.routine.routineId}` : "?");
        const r = a.role ?? "AUTHORIZED";
        roles.set(r, [...(roles.get(r) ?? []), who]);
      }
      if (roles.size) lines.push("access (dataset ACL; project IAM roles apply too):", ...[...roles].map(([r, w]) => `  ${r}: ${w.join(", ")}`));
      try {
        const t = await c.listTables(ref);
        const g = groupShards(t);
        lines.push(`tables: ${t.length}${g.length !== t.length ? ` (${g.length} after grouping date shards)` : ""}; bigquery_tables lists them`);
      } catch { /* listing is optional here */ }
      return lines.join("\n");
    }
    const project = args?.project || c.settings.project;
    let ds = await c.listDatasets(project);
    const q = String(args?.search ?? "").trim().toLowerCase();
    if (q) ds = ds.filter((d) => d.datasetReference.datasetId.toLowerCase().includes(q));
    if (!ds.length) return q ? `no dataset in ${project} matches "${q}"` : `no datasets this account can see in ${project}`;
    return [
      `${ds.length} dataset(s) in ${project}:`,
      ...ds.map((d) => `${d.datasetReference.datasetId}  ${d.location ?? ""}${d.labels ? `  ${Object.entries(d.labels).map(([k, v]) => `${k}=${v}`).join(",")}` : ""}`),
    ].join("\n");
  });
}

// ---------------------------------------------------------------- tables ----

export async function tables(args, env) {
  return withClient(env, async (c) => {
    const ref = parseDatasetRef(args?.dataset, { project: args?.project || c.settings.project, dataset: c.settings.dataset });
    let list = await c.listTables(ref);
    const q = String(args?.search ?? "").trim().toLowerCase();
    if (q) list = list.filter((t) => t.tableReference.tableId.toLowerCase().includes(q));
    if (!list.length) return q ? `no table in ${ref.projectId}.${ref.datasetId} matches "${q}"` : `${ref.projectId}.${ref.datasetId} has no tables`;

    let sizes = null;
    if (boolArg(args?.sizes)) {
      const sql = `SELECT table_id, row_count, size_bytes, last_modified_time FROM \`${ref.projectId}.${ref.datasetId}.__TABLES__\``;
      const r = await c.query(sql, { maxResults: 100_000, maxBytes: 1e9 });
      sizes = new Map(decodeRows(r.schema, r.rows).map((x) => [x.table_id, x]));
    }
    const sizeOf = (ids) => {
      if (!sizes) return "";
      let rows = 0, b = 0, known = 0;
      for (const id of ids) { const s = sizes.get(id); if (s) { known++; rows += Number(s.row_count); b += Number(s.size_bytes); } }
      return known ? `  ${rows.toLocaleString("en-US")} rows, ${bytes(b)}` : "";
    };

    const expand = boolArg(args?.expand_shards);
    const items = expand ? list.map((t) => ({ shard: false, name: t.tableReference.tableId, table: t, type: t.type })) : groupShards(list);
    const limit = clampInt(args?.limit, 300, 1, 5000);
    const lines = [`${list.length} table(s) in ${ref.projectId}.${ref.datasetId}${items.length !== list.length ? `, ${items.length} after grouping date shards` : ""}:`];
    for (const it of items.slice(0, limit)) {
      if (it.shard) {
        lines.push(`${it.name}  ${it.type} ×${it.count} date shards ${it.first}…${it.last}${sizeOf(it.members.map((m) => m.tableReference.tableId))}  (query as \`${ref.datasetId}.${it.name}\` with WHERE _TABLE_SUFFIX BETWEEN …)`);
      } else {
        const p = partitionText(it.table);
        lines.push(`${it.name}  ${it.type}${p ? `  ${p}` : ""}${sizeOf([it.name])}`);
      }
    }
    if (items.length > limit) lines.push(`… ${items.length - limit} more; narrow with search or raise limit`);
    if (!sizes) lines.push("(sizes=true adds row counts and sizes)");
    return clip(lines.join("\n"), c.settings.maxChars, "narrow with search");
  });
}

// ----------------------------------------------------------------- table ----

export async function table(args, env) {
  return withClient(env, async (c) => {
    let ref = parseTableRef(args?.table, { project: args?.project || c.settings.project, dataset: args?.dataset || c.settings.dataset });
    const notes = [];
    if (/\*$/.test(ref.tableId)) {
      const prefix = ref.tableId.slice(0, -1);
      const shards = (await c.listTables(ref)).map((t) => t.tableReference.tableId).filter((id) => id.startsWith(prefix) && /^\d{8}$/.test(id.slice(prefix.length))).sort();
      if (!shards.length) return `no date-sharded tables start with ${prefix} in ${ref.projectId}.${ref.datasetId}`;
      notes.push(`${shards.length} shards ${shards[0].slice(prefix.length)}…${shards.at(-1).slice(prefix.length)}; showing the latest, ${shards.at(-1)}. Query them as \`${ref.datasetId}.${ref.tableId}\` and filter on _TABLE_SUFFIX.`);
      ref = { ...ref, tableId: shards.at(-1) };
    }
    const t = await c.getTable(ref);
    const lines = [`${t.type ?? "TABLE"} ${tableId(ref)}`, ...notes];
    if (t.description) lines.push(`description: ${t.description}`);
    lines.push(`location: ${t.location}, created: ${when(t.creationTime)}, modified: ${when(t.lastModifiedTime)}${t.expirationTime ? `, expires: ${when(t.expirationTime)}` : ""}`);
    if (t.numRows !== undefined || t.numBytes !== undefined)
      lines.push(`rows: ${Number(t.numRows ?? 0).toLocaleString("en-US")}, size: ${bytes(t.numBytes ?? 0)}${Number(t.numLongTermBytes) ? ` (${bytes(t.numLongTermBytes)} long-term)` : ""}`);
    const p = partitionText(t);
    if (p) lines.push(`${p}${t.requirePartitionFilter || t.timePartitioning?.requirePartitionFilter ? " (queries must filter on the partition column)" : ""}`);
    if (t.labels && Object.keys(t.labels).length) lines.push(`labels: ${Object.entries(t.labels).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (t.view?.query) lines.push("view SQL:", clip(t.view.query, 4000, "the view's SQL is longer"));
    if (t.materializedView?.query) lines.push("materialized view SQL:", clip(t.materializedView.query, 4000, "the SQL is longer"));
    if (t.externalDataConfiguration) lines.push(`external: ${t.externalDataConfiguration.sourceFormat} ${(t.externalDataConfiguration.sourceUris ?? []).slice(0, 5).join(", ")}`);
    const fields = t.schema?.fields ?? [];
    lines.push(`schema (${fields.length} columns, ${countFields(fields)} fields with nested):`, ...renderSchema(fields));

    const n = clampInt(args?.preview_rows, 0, 0, 100);
    if (n > 0) {
      if (t.type && t.type !== "TABLE") {
        lines.push(`(no preview: a ${t.type} has no stored rows to read for free; SELECT … LIMIT ${n} with bigquery_query instead)`);
      } else {
        const cols = Array.isArray(args?.columns) ? args.columns.map(String) : String(args?.columns ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const top = cols.map((x) => x.split(".")[0]);
        const unknown = top.filter((x) => !fields.some((f) => f.name === x));
        if (unknown.length) throw new Error(`no column ${unknown.join(", ")} in ${tableId(ref)}`);
        const d = await c.tableData(ref, { maxResults: n, selectedFields: cols.length ? cols.join(",") : undefined });
        // tabledata.list answers the selected columns in the table's own order.
        const shown = cols.length ? fields.filter((f) => top.includes(f.name)) : fields;
        const rows = decodeRows({ fields: shown }, d.rows);
        lines.push(`preview (first ${rows.length} stored rows, free; not ordered):`, renderRows(rows, shown.map((f) => f.name), formatArg(args?.format)));
      }
    }
    return clip(lines.join("\n"), c.settings.maxChars, "pass columns to preview fewer, or fewer preview_rows");
  });
}

// ----------------------------------------------------------------- query ----

function referenced(stats) {
  const t = stats?.referencedTables ?? [];
  return t.length ? t.map((x) => `${x.projectId}.${x.datasetId}.${x.tableId}`).join(", ") : "";
}

function capOf(c, args) {
  const per = Number(args?.max_gb);
  const gb = Number.isFinite(per) && per > 0 ? Math.min(per, c.settings.maxGb) : c.settings.maxGb;
  return { gb, bytes: Math.floor(gb * 1e9) };
}

/** Dry run, statement check, cap check, then the run. `write` is bigquery_execute. */
async function run(args, env, write) {
  const sql = String(args?.sql ?? "").trim();
  if (!sql) throw new Error("give `sql`: one GoogleSQL statement (or, with bigquery_execute, a script)");
  return withClient(env, async (c) => {
    if (write && c.settings.readOnly)
      return "refused: this package is read-only (`readOnly` setting), so bigquery_execute runs nothing. SELECTs go through bigquery_query. Nothing was run.";
    const format = formatArg(args?.format);
    const opts = {
      params: queryParameters(args?.params),
      dataset: args?.dataset || c.settings.dataset ? (() => { const d = parseDatasetRef(args?.dataset, { project: c.settings.project, dataset: c.settings.dataset }); return { projectId: d.projectId, datasetId: d.datasetId }; })() : undefined,
      location: args?.location ? String(args.location) : undefined,
      useCache: args?.use_cache === undefined ? true : boolArg(args.use_cache, true),
    };
    const dry = await c.dryRun(sql, opts);
    const qs = dry.statistics?.query ?? {};
    const type = qs.statementType ?? "?";
    const scan = Number(dry.statistics?.totalBytesProcessed ?? qs.totalBytesProcessed ?? 0);
    const cap = capOf(c, args);
    const head = `${type} · would scan ${bytes(scan)} (${cost(scan)} on-demand)${referenced(qs) ? ` · reads ${referenced(qs)}` : ""}`;

    if (!write && type !== "SELECT")
      return `refused: this is a ${type} statement and bigquery_query runs SELECT only.${c.settings.readOnly ? " This package is read-only, so it cannot be run here." : " Run it with bigquery_execute, after saying what it changes."}\n${head}\nNothing was run.`;
    if (write && type === "SELECT")
      return `this is a plain SELECT: run it with bigquery_query instead.\n${head}\nNothing was run.`;
    if (scan > cap.bytes)
      return `refused: it would scan ${bytes(scan)}, over the ${cap.gb} GB cap${cap.gb < c.settings.maxGb ? " you passed as max_gb" : " (`maxGbBilled` setting)"}.\n${head}\nScan less: select only the columns needed (SELECT * reads every column), filter on the partition column or on _TABLE_SUFFIX for sharded tables, or query a smaller table. Only the person can raise \`maxGbBilled\`. Nothing was run.`;
    if (boolArg(args?.dry_run)) {
      const schema = qs.schema?.fields;
      return [`dry run, nothing was run: ${head}`, ...(schema?.length ? ["result columns:", ...renderSchema(schema)] : [])].join("\n");
    }

    const maxRows = clampInt(args?.max_rows, c.settings.maxRows, 0, HARD_MAX_ROWS);
    const timeoutMs = args?.timeout_s ? clampInt(Number(args.timeout_s) * 1000, c.settings.timeoutMs, 5_000, 600_000) : c.settings.timeoutMs;
    const r = await c.query(sql, { ...opts, maxBytes: cap.bytes, maxResults: maxRows, timeoutMs });
    const ref = r.jobReference ?? {};
    if (!r.jobComplete)
      return `still running after ${Math.round(timeoutMs / 1000)}s as job ${jobId(ref)}. It keeps running (and billing) in BigQuery: call bigquery_job with job_id="${jobId(ref)}" and wait_s to wait and read it, or cancel=true to stop it.`;

    const facts = [type];
    let job = null;
    if (write) {
      try { job = await c.getJob(ref); } catch { /* the stats below are enough */ }
      const js = job?.statistics?.query ?? {};
      const dml = r.numDmlAffectedRows ?? js.numDmlAffectedRows;
      if (dml !== undefined) facts.push(`${Number(dml).toLocaleString("en-US")} row(s) affected`);
      const st = r.dmlStats ?? js.dmlStats;
      if (st) facts.push(["inserted", "updated", "deleted"].map((k) => (st[`${k}RowCount`] ? `${st[`${k}RowCount`]} ${k}` : "")).filter(Boolean).join(", ") || "no rows changed");
      if (js.ddlOperationPerformed) facts.push(`${js.ddlOperationPerformed}${js.ddlTargetTable ? ` ${tableId(js.ddlTargetTable)}` : ""}${js.ddlTargetRoutine ? ` ${js.ddlTargetRoutine.routineId}` : ""}`);
      if (job?.statistics?.numChildJobs) facts.push(`script of ${job.statistics.numChildJobs} statement(s)`);
    }
    const total = Number(r.totalRows ?? 0);
    const rows = decodeRows(r.schema, r.rows);
    // DDL and DML answer an empty schema-less result; only a SELECT or a script ending in one has rows to show.
    const hasRows = r.schema?.fields?.length > 0 && (!write || total > 0);
    if (hasRows) facts.push(`${total.toLocaleString("en-US")} row(s)${rows.length < total ? ` (showing ${rows.length})` : ""}`);
    const billed = Number(r.totalBytesBilled ?? job?.statistics?.query?.totalBytesBilled ?? 0);
    facts.push(r.cacheHit ? "cache hit, nothing billed" : `scanned ${bytes(r.totalBytesProcessed ?? scan)}, billed ${bytes(billed)} (${cost(billed)})`);
    facts.push(`job ${jobId(ref)}`);
    const out = [facts.join(" · ")];
    if (hasRows && rows.length) out.push(renderRows(rows, r.schema.fields.map((f) => f.name), format));
    else if (hasRows && !total) out.push("(no rows)");
    if (rows.length < total) out.push(`more: bigquery_job job_id="${jobId(ref)}" start_row=${rows.length}`);
    return clip(out.join("\n"), c.settings.maxChars, "aggregate, select fewer columns, or pass a smaller max_rows");
  }, sql);
}

export const query = (args, env) => run(args, env, false);
export const execute = (args, env) => run(args, env, true);

// ------------------------------------------------------------------- job ----

export async function job(args, env) {
  return withClient(env, async (c) => {
    if (!args?.job_id) {
      const r = await c.listJobs({ maxResults: clampInt(args?.limit, 20, 1, 200), stateFilter: args?.state ? String(args.state).toLowerCase() : undefined });
      const jobs = r.jobs ?? [];
      if (!jobs.length) return "no recent jobs by this account";
      return [`${jobs.length} recent job(s) by this account, newest first:`, ...jobs.map((j) => {
        const s = j.statistics ?? {};
        const sql = String(j.configuration?.query?.query ?? j.configuration?.jobType ?? "").replace(/\s+/g, " ").slice(0, 120);
        return `${jobId(j.jobReference)}  ${j.state}${j.errorResult ? ` (${j.errorResult.reason})` : ""}  ${when(s.creationTime)}  ${s.query?.statementType ?? j.configuration?.jobType ?? ""}  ${s.query?.totalBytesBilled ? `billed ${bytes(s.query.totalBytesBilled)}` : ""}  ${sql}`;
      })].join("\n");
    }
    const ref = parseJobRef(args.job_id, c, args?.location);
    if (boolArg(args?.cancel)) {
      const r = await c.cancelJob(ref);
      return `cancel requested for ${jobId(r.job?.jobReference ?? ref)}; state now ${r.job?.status?.state ?? "?"}. BigQuery bills for what it scanned before stopping.`;
    }
    const wait = clampInt(args?.wait_s, 0, 0, 600) * 1000;
    let j = await c.getJob(ref);
    const realRef = j.jobReference ?? ref;
    if (j.status?.state !== "DONE" && wait > 0) {
      const started = Date.now();
      while (Date.now() - started < wait) {
        const r = await c.results(realRef, { maxResults: 0, timeoutMs: Math.min(60_000, wait - (Date.now() - started)) });
        if (r.jobComplete) break;
      }
      j = await c.getJob(realRef);
    }
    const s = j.statistics ?? {};
    const qs = s.query ?? {};
    const lines = [
      `job ${jobId(realRef)}: ${j.status?.state}${j.status?.errorResult ? ` FAILED (${j.status.errorResult.reason}): ${j.status.errorResult.message}` : ""}`,
      `by ${j.user_email ?? "?"} · created ${when(s.creationTime)} · started ${when(s.startTime)} · ended ${when(s.endTime)}`,
    ];
    if (qs.statementType) lines.push(`${qs.statementType} · processed ${bytes(qs.totalBytesProcessed ?? 0)} · billed ${bytes(qs.totalBytesBilled ?? 0)} (${cost(qs.totalBytesBilled ?? 0)})${qs.cacheHit ? " · cache hit" : ""}${qs.numDmlAffectedRows ? ` · ${qs.numDmlAffectedRows} row(s) affected` : ""}`);
    if (j.configuration?.query?.query) lines.push("sql:", clip(j.configuration.query.query, 3000, "the SQL is longer"));
    if (j.status?.state !== "DONE") {
      lines.push(`still ${j.status?.state}; call again with wait_s to wait, or cancel=true to stop it.`);
      return lines.join("\n");
    }
    if (j.status?.errorResult || boolArg(args?.results, true) === false || !j.configuration?.query) return lines.join("\n");
    const maxRows = clampInt(args?.max_rows, c.settings.maxRows, 0, HARD_MAX_ROWS);
    const start = clampInt(args?.start_row, 0, 0, Number.MAX_SAFE_INTEGER);
    const r = await c.results(realRef, { maxResults: maxRows, startIndex: start });
    const rows = decodeRows(r.schema, r.rows);
    const total = Number(r.totalRows ?? 0);
    if (r.schema) {
      lines.push(`rows ${rows.length ? `${start}–${start + rows.length - 1}` : "none"} of ${total.toLocaleString("en-US")}:`);
      if (rows.length) lines.push(renderRows(rows, r.schema.fields.map((f) => f.name), formatArg(args?.format)));
      if (start + rows.length < total) lines.push(`more: start_row=${start + rows.length}`);
    }
    return clip(lines.join("\n"), c.settings.maxChars, "pass a smaller max_rows");
  });
}

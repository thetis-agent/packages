// The sql_* tools. Each takes (args, env) and returns text for the model.
//
// A connection profile names one database server: a host and port reached
// directly, or a Cloud SQL instance reached through the Cloud SQL Auth Proxy,
// which this package starts (in a container, or as a local process) and keeps
// running between calls. Every call opens its own connection and closes it.
//
// Reads and writes are separate tools. sql_query runs one statement inside a
// READ ONLY transaction that is always rolled back, so even a function with
// side effects cannot change anything; sql_execute runs statements that change
// data or schema, in one transaction where the engine allows it, and refuses
// when the profile or the package is read-only. The database user's own
// privileges are the real boundary; these keep the agent from trying.

import { settings, profile, connectionNames, describeProfile, clampInt, boolArg, DEFAULTS } from "./config.js";
import { withSession } from "./connect.js";
import { explainDbError } from "./drivers.js";
import { splitStatements, classify, bindParams, parseObjectRef, quoteIdent } from "./sqltext.js";
import { formatArg, renderRows, clip, bytes, ms } from "./format.js";
import { dockerAvailable, binaryAvailable, listProxies, stopProxies, proxyLogs, ensureProxy, orphanContainers, removeContainers, googleCredential } from "./proxy.js";

/** A thrown database error becomes an answer; a thrown setup error stays an error. */
async function guarded(fn, sql) {
  try {
    return await fn();
  } catch (e) {
    if (e && (e.sqlState || e.sqlMessage || e.errno || (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) && e.severity))) return explainDbError(e, sql);
    throw e;
  }
}

function viaLine(ctx) {
  const { p, proxy } = ctx;
  if (!proxy) return `${p.name} (${p.engine}, direct)`;
  return `${p.name} (${ctx.target.engine}, ${p.instance} via the proxy ${proxy.mode}${proxy.started ? ", started now" : ""})`;
}

function rowsOf(args, s) {
  return clampInt(args?.max_rows, s.maxRows, 0, DEFAULTS.hardMaxRows);
}
function timeoutOf(args, p) {
  return args?.timeout_s ? clampInt(Number(args.timeout_s) * 1000, p.timeoutMs, 1_000, 300_000) : p.timeoutMs;
}

// ----------------------------------------------------------------- status --

export async function status(args, env) {
  const s = settings(env?.config);
  const names = connectionNames(s);
  const out = [];
  if (args?.connection) {
    const p = profile(s, args.connection);
    out.push(describeProfile(s, p));
    const t0 = Date.now();
    const r = await guarded(() => withSession(env, p.name, async (db, ctx) => {
      const v = await db.version();
      return `connected in ${ms(Date.now() - t0)}: ${viaLine(ctx)}\nserver ${v.version}\nlogged in as ${v.user}${v.database ? ` · database ${v.database}` : ""}${ctx.proxy ? `\nproxy at ${ctx.proxy.host}:${ctx.proxy.port}` : ""}`;
    }));
    out.push(r);
    return out.join("\n");
  }
  out.push(names.length ? `connections (${names.length}):` : "no connections are set up yet (the `connections` setting).");
  for (const n of names) {
    try { out.push(`  ${describeProfile(s, profile(s, n))}`); } catch (e) { out.push(`  ${n}: ${e.message}`); }
  }
  out.push(`mode: ${s.readOnly ? "read-only (sql_execute refuses everything)" : "read-write where a profile allows it"} · rows per answer ${s.maxRows} · statement timeout ${ms(s.timeoutMs)}`);
  const usesProxy = names.some((n) => { try { return profile(s, n).via !== "direct"; } catch { return false; } });
  const d = await dockerAvailable();
  const b = await binaryAvailable(s.proxyBinary);
  out.push(`Cloud SQL proxy: proxyMode ${s.proxyMode}; docker ${d.ok ? `available (${d.version}), image ${s.proxyImage}, network ${s.proxyNetwork}` : `not available (${d.why})`}; binary ${b.ok ? `${s.proxyBinary} ${b.version}` : `not available (${b.why})`}; idle proxies stop after ${s.proxyIdleMinutes || "never"}${s.proxyIdleMinutes ? " min" : ""}`);
  if (usesProxy) {
    try {
      const firstProxied = names.map((n) => { try { return profile(s, n); } catch { return null; } }).find((p) => p && p.via !== "direct");
      const cred = await googleCredential(env, s, firstProxied);
      out.push(`Google credential for the proxy: ${cred.source}`);
    } catch (e) { out.push(`Google credential for the proxy: ${e.message}`); }
  }
  const px = await listProxies(env);
  if (px.length) {
    out.push("proxies:");
    for (const x of px) out.push(`  ${x.instance} · ${x.mode} · ${x.up ? `up at ${x.host}:${x.port}` : "down"} · last used ${new Date(x.lastUsed).toISOString().replace(/\.\d+Z$/, "Z")}`);
  }
  out.push("Pass `connection` to connect to one and show the server version and the user it logs in as.");
  return out.join("\n");
}

// ------------------------------------------------------------- metadata ---

/** The schema to look in: the argument, else the profile's database (MySQL) or `public` (PostgreSQL). */
function schemaOf(args, ctx) {
  const a = typeof args?.schema === "string" ? args.schema.trim() : "";
  if (a) return a;
  if (ctx.target.engine === "mysql") return ctx.p.database || null;
  return null; // current_schema() on the server
}

export async function schemas(args, env) {
  return guarded(() => withSession(env, args?.connection, async (db, ctx) => {
    const like = typeof args?.search === "string" && args.search.trim() ? `%${args.search.trim()}%` : "%";
    const sql = ctx.target.engine === "mysql"
      ? `SELECT s.SCHEMA_NAME AS name, s.DEFAULT_CHARACTER_SET_NAME AS charset,
           (SELECT COUNT(*) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) AS tables,
           (SELECT COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) AS bytes
         FROM information_schema.SCHEMATA s WHERE s.SCHEMA_NAME LIKE ? ORDER BY s.SCHEMA_NAME`
      : `SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
           (SELECT COUNT(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m','f')) AS tables,
           (SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p','m')) AS bytes
         FROM pg_namespace n WHERE n.nspname LIKE $1::text AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' ORDER BY n.nspname`;
    const r = await db.read(sql, [like], { maxRows: 1000, timeoutMs: ctx.p.timeoutMs });
    let extra = "";
    if (ctx.target.engine === "postgres") {
      const dbs = await db.read("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname", [], { maxRows: 500, timeoutMs: ctx.p.timeoutMs });
      extra = `\ndatabases on this server: ${dbs.rows.map((x) => x.datname).join(", ")} (this connection is in ${ctx.target.database || "postgres"}; another needs its own profile)`;
    }
    const rows = r.rows.map((x) => ({ ...x, bytes: bytes(x.bytes) }));
    const what = ctx.target.engine === "mysql" ? "databases" : "schemas";
    return `${viaLine(ctx)} · ${rows.length} ${what}\n${renderRows(rows, r.columns, "table")}${extra}`;
  }));
}

export async function tables(args, env) {
  return guarded(() => withSession(env, args?.connection, async (db, ctx) => {
    const schema = schemaOf(args, ctx);
    const like = typeof args?.search === "string" && args.search.trim() ? `%${args.search.trim()}%` : "%";
    const limit = clampInt(args?.limit, 500, 1, 5000);
    let sql, values;
    if (ctx.target.engine === "mysql") {
      if (!schema) return "name a `schema` (a MySQL database): this connection has no default database. sql_schemas lists them.";
      sql = `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rows_estimate,
               DATA_LENGTH + INDEX_LENGTH AS bytes, TABLE_COMMENT AS comment
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ? ORDER BY TABLE_NAME`;
      values = [schema, like];
    } else {
      sql = `SELECT c.relname AS name,
               CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END AS type,
               GREATEST(c.reltuples, 0)::bigint AS rows_estimate,
               CASE WHEN c.relkind IN ('r','p','m') THEN pg_total_relation_size(c.oid) END AS bytes,
               obj_description(c.oid, 'pg_class') AS comment
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = COALESCE($1::text, current_schema()) AND c.relkind IN ('r','p','v','m','f') AND c.relname LIKE $2::text AND NOT c.relispartition
             ORDER BY c.relname`;
      values = [schema, like];
    }
    const r = await db.read(sql, values, { maxRows: limit, timeoutMs: ctx.p.timeoutMs });
    const rows = r.rows.map((x) => ({ ...x, bytes: x.bytes === null ? "" : bytes(x.bytes), comment: x.comment ?? "" }));
    const where = schema ?? "the current schema";
    if (!rows.length) return `${viaLine(ctx)} · no tables in ${where}${like !== "%" ? ` matching "${args.search}"` : ""}`;
    return clip(`${viaLine(ctx)} · ${where}: ${rows.length}${r.more ? "+" : ""} table(s) (row counts are the server's estimates)\n${renderRows(rows, r.columns, "table", 120)}${r.more ? `\n… more: pass limit above ${limit} or a search` : ""}`, ctx.s.maxChars);
  }));
}

export async function describe(args, env) {
  const ref = parseObjectRef(args?.table);
  return guarded(() => withSession(env, args?.connection, async (db, ctx) => {
    const e = ctx.target.engine;
    const schema = ref.schema ?? schemaOf(args, ctx);
    const T = { maxRows: 2000, timeoutMs: ctx.p.timeoutMs };
    const out = [];
    if (e === "mysql") {
      if (!schema) return "say which database: `schema.table`, or a `schema`, since this connection has no default database";
      const info = await db.read("SELECT TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rows_estimate, DATA_LENGTH AS data, INDEX_LENGTH AS idx, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment, CREATE_TIME AS created, UPDATE_TIME AS updated FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [schema, ref.name], T);
      if (!info.rows.length) return `no table or view ${schema}.${ref.name}. sql_tables lists what is there.`;
      const t = info.rows[0];
      out.push(`${viaLine(ctx)} · ${schema}.${ref.name}: ${t.type}${t.engine ? ` (${t.engine})` : ""} · ~${t.rows_estimate ?? "?"} rows · data ${bytes(t.data)}, indexes ${bytes(t.idx)}${t.collation ? ` · ${t.collation}` : ""}${t.updated ? ` · updated ${t.updated}` : ""}${t.comment ? `\n${t.comment}` : ""}`);
      const cols = await db.read(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, COLUMN_KEY AS k, EXTRA AS extra, COLUMN_COMMENT AS comment
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [schema, ref.name], T);
      out.push("columns:");
      for (const c of cols.rows) out.push(`  ${c.name} ${c.type}${c.nullable === "NO" ? " NOT NULL" : ""}${c.dflt !== null ? ` DEFAULT ${c.dflt}` : ""}${c.k === "PRI" ? " PK" : ""}${c.extra ? ` ${c.extra}` : ""}${c.comment ? ` — ${c.comment}` : ""}`);
      const idx = await db.read(`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, INDEX_TYPE AS type
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME`, [schema, ref.name], T);
      if (idx.rows.length) { out.push("indexes:"); for (const i of idx.rows) out.push(`  ${i.name}${Number(i.non_unique) ? "" : " UNIQUE"} (${i.cols})${i.type !== "BTREE" ? ` ${i.type}` : ""}`); }
      const fk = await db.read(`SELECT k.CONSTRAINT_NAME AS name, GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS cols, k.REFERENCED_TABLE_SCHEMA AS rs, k.REFERENCED_TABLE_NAME AS rt, GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS rc
        FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL GROUP BY k.CONSTRAINT_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME`, [schema, ref.name], T);
      if (fk.rows.length) { out.push("foreign keys:"); for (const f of fk.rows) out.push(`  ${f.name} (${f.cols}) → ${f.rs === schema ? "" : `${f.rs}.`}${f.rt} (${f.rc})`); }
      if (/VIEW/.test(t.type)) {
        const v = await db.read("SELECT VIEW_DEFINITION AS sql FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [schema, ref.name], T);
        if (v.rows[0]?.sql) out.push(`view SQL:\n${v.rows[0].sql}`);
      }
      if (boolArg(args?.ddl)) {
        try {
          const d = await db.exec(`SHOW CREATE ${/VIEW/.test(t.type) ? "VIEW" : "TABLE"} ${quoteIdent(schema, e)}.${quoteIdent(ref.name, e)}`, [], { timeoutMs: ctx.p.timeoutMs });
          const row = d.rows[0] ?? {};
          out.push(`DDL:\n${row["Create Table"] ?? row["Create View"] ?? JSON.stringify(row)}`);
        } catch (err) { out.push(`DDL: ${explainDbError(err)}`); }
      }
    } else {
      const info = await db.read(`SELECT c.oid::int AS oid, n.nspname AS schema, c.relkind AS kind, GREATEST(c.reltuples,0)::bigint AS rows_estimate,
          pg_table_size(c.oid) AS data, pg_indexes_size(c.oid) AS idx, obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $2::text AND n.nspname = COALESCE($1::text, current_schema()) AND c.relkind IN ('r','p','v','m','f')`, [schema, ref.name], T);
      if (!info.rows.length) return `no table or view ${schema ? `${schema}.` : ""}${ref.name}. sql_tables lists what is there.`;
      const t = info.rows[0];
      const kinds = { r: "table", p: "partitioned table", v: "view", m: "materialized view", f: "foreign table" };
      out.push(`${viaLine(ctx)} · ${t.schema}.${ref.name}: ${kinds[t.kind]} · ~${t.rows_estimate} rows · data ${bytes(t.data)}, indexes ${bytes(t.idx)}${t.comment ? `\n${t.comment}` : ""}`);
      const cols = await db.read(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
          pg_get_expr(d.adbin, d.adrelid) AS dflt, col_description(a.attrelid, a.attnum) AS comment, a.attidentity AS ident, a.attgenerated AS gen
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [t.oid], T);
      const pk = await db.read(`SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1 AND i.indisprimary`, [t.oid], T);
      const pkCols = new Set(pk.rows.map((r) => r.name));
      out.push("columns:");
      for (const c of cols.rows) out.push(`  ${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.dflt !== null ? ` DEFAULT ${c.dflt}` : ""}${pkCols.has(c.name) ? " PK" : ""}${c.ident ? " IDENTITY" : ""}${c.gen ? " GENERATED" : ""}${c.comment ? ` — ${c.comment}` : ""}`);
      const idx = await db.read(`SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i WHERE i.indrelid = $1 ORDER BY i.indisprimary DESC`, [t.oid], T);
      if (idx.rows.length) { out.push("indexes:"); for (const i of idx.rows) out.push(`  ${i.def}`); }
      const cons = await db.read(`SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1 AND contype IN ('f','c','x') ORDER BY contype, conname`, [t.oid], T);
      if (cons.rows.length) { out.push("constraints:"); for (const c of cons.rows) out.push(`  ${c.name}: ${c.def}`); }
      if (t.kind === "v" || t.kind === "m") {
        const v = await db.read("SELECT pg_get_viewdef($1::oid, true) AS sql", [t.oid], T);
        out.push(`view SQL:\n${v.rows[0]?.sql ?? ""}`);
      }
    }
    const n = clampInt(args?.preview_rows, 0, 0, 100);
    if (n > 0) {
      const q = `SELECT * FROM ${schema ? `${quoteIdent(schema, e)}.` : ""}${quoteIdent(ref.name, e)}`;
      const r = await db.read(e === "mysql" ? `${q} LIMIT ${n}` : `${q} LIMIT ${n}`, [], { maxRows: n, timeoutMs: ctx.p.timeoutMs });
      out.push(`first ${r.rows.length} row(s), in no particular order:`);
      out.push(r.rows.length ? renderRows(r.rows, r.columns, formatArg(args?.format), 120) : "(no rows)");
    }
    return clip(out.join("\n"), ctx.s.maxChars);
  }));
}

// ------------------------------------------------------------- statements --

export async function query(args, env) {
  const sql0 = String(args?.sql ?? "").trim();
  if (!sql0) throw new Error("give `sql`: one SELECT (or WITH, SHOW, DESCRIBE, EXPLAIN) statement");
  const format = formatArg(args?.format);
  const s = settings(env?.config);
  const p = profile(s, args?.connection);
  // The engine decides how strings and comments are lexed. When the profile does not say it (a Cloud SQL
  // instance), it is known only once connected; the read-only transaction is the guarantee either way.
  const gate = (engine) => {
    const stmts = splitStatements(sql0, engine);
    if (stmts.length > 1) return { refusal: `refused: this is ${stmts.length} statements and sql_query runs one. Send them one at a time.${stmts.some((x) => !classify(x, engine).read) ? " Statements that change data go through sql_execute." : ""} Nothing was run.` };
    const sql = stmts[0] ?? sql0;
    const k = classify(sql, engine);
    if (!k.read) {
      const why = k.intoFile ? "SELECT … INTO OUTFILE writes a file on the server" : k.writesInWith ? "this WITH holds a statement that changes data" : `${k.keyword || "this"} is not a read`;
      return { refusal: `refused: ${why}, and sql_query only reads (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, VALUES, TABLE).${p.readOnly ? ` The connection "${p.name}" is read-only, so it cannot be run here at all.` : " Run it with sql_execute, after saying what it changes."} Nothing was run.` };
    }
    return { sql, k };
  };
  if (p.engine) { const g = gate(p.engine); if (g.refusal) return g.refusal; }
  const maxRows = rowsOf(args, s);
  const timeoutMs = timeoutOf(args, p);
  return guarded(() => withSession(env, p.name, async (db, ctx) => {
    const g = gate(ctx.target.engine);
    if (g.refusal) return g.refusal;
    const { sql, k } = g;
    const { text, values } = bindParams(sql, ctx.target.engine, args?.params);
    const t0 = Date.now();
    const r = await db.read(text, values, { maxRows, timeoutMs });
    const took = Date.now() - t0;
    const head = `${viaLine(ctx)} · ${r.rows.length}${r.more ? "+" : ""} row(s)${r.more ? ` (stopped at ${maxRows}; pass max_rows, up to ${DEFAULTS.hardMaxRows}, or aggregate)` : ""} · ${ms(took)}${k.analyzes ? " · EXPLAIN ANALYZE ran the statement inside a read-only transaction" : ""}`;
    if (!r.columns.length) return `${head}\n(the statement returned no result set)`;
    return clip(`${head}\n${r.rows.length ? renderRows(r.rows, r.columns, format) : `${r.columns.join(" | ")}\n(no rows)`}`, s.maxChars, "aggregate, select fewer columns, or pass a smaller max_rows");
  }), sql0);
}

export async function execute(args, env) {
  const sql0 = String(args?.sql ?? "").trim();
  if (!sql0) throw new Error("give `sql`: the statement, or a script of statements separated by ;");
  const s = settings(env?.config);
  const p = profile(s, args?.connection);
  if (p.readOnly) return `refused: the connection "${p.name}" is read-only (${s.readOnly ? "the package's `readOnly` setting" : "its profile's readOnly"}), so sql_execute runs nothing on it. Reads go through sql_query. Nothing was run.`;
  const format = formatArg(args?.format);
  const dryRun = boolArg(args?.dry_run);
  const useTx = args?.transaction === undefined ? true : boolArg(args.transaction, true);
  const allowFull = boolArg(args?.allow_full_table);
  const timeoutMs = timeoutOf(args, p);
  const maxRows = rowsOf(args, s);

  return guarded(() => withSession(env, p.name, async (db, ctx) => {
    const engine = ctx.target.engine;
    const stmts = splitStatements(sql0, engine);
    if (!stmts.length) return "nothing to run: the SQL holds only comments.";
    const kinds = stmts.map((x) => classify(x, engine));
    if (args?.params !== undefined && stmts.length > 1) return "refused: `params` binds one statement, and this is a script. Run the parameterised statement on its own. Nothing was run.";
    const full = kinds.map((k, i) => (k.fullTable ? i : -1)).filter((i) => i >= 0);
    if (full.length && !allowFull) {
      return `refused: statement ${full.map((i) => i + 1).join(", ")} is ${kinds[full[0]].keyword} with no WHERE, which changes every row of the table. If that is meant, call again with allow_full_table=true (say so to the person first). Nothing was run.`;
    }
    const implicit = kinds.filter((k) => k.implicitCommit).map((k) => k.keyword);
    if (dryRun && engine === "mysql" && implicit.length) {
      return `cannot dry-run: MySQL commits ${[...new Set(implicit)].join(", ")} on the spot, so a rollback would not undo ${implicit.length > 1 ? "them" : "it"}. Nothing was run. Review the statement and run it without dry_run, or try it on a copy.`;
    }
    const inTx = dryRun || (useTx && stmts.length >= 1 && !(engine === "mysql" && implicit.length));
    const results = [];
    const t0 = Date.now();
    if (inTx) await db.begin();
    let failedAt = -1;
    try {
      for (let i = 0; i < stmts.length; i++) {
        failedAt = i;
        const { text, values } = stmts.length === 1 ? bindParams(stmts[i], engine, args?.params) : { text: stmts[i], values: undefined };
        const r = await db.exec(text, values, { timeoutMs });
        results.push({ i, kind: kinds[i], r });
      }
      failedAt = -1;
      if (inTx) { if (dryRun) await db.rollback(); else await db.commit(); }
    } catch (e) {
      if (inTx) await db.rollback().catch(() => {});
      const done = results.length;
      const where = stmts.length > 1 ? `statement ${failedAt + 1} of ${stmts.length} failed` : "it failed";
      const undo = inTx ? (done ? `; the ${done} statement(s) before it were rolled back, so nothing changed` : "; nothing changed") : done ? `; the ${done} statement(s) before it ran and stayed (no transaction${implicit.length && engine === "mysql" ? ": MySQL commits DDL on the spot" : ""})` : "";
      return `${viaLine(ctx)} · ${where}${undo}.\n${explainDbError(e, stmts[failedAt] ?? sql0)}`;
    }
    const took = Date.now() - t0;
    const lines = [];
    for (const { i, kind, r } of results) {
      const n = stmts.length > 1 ? `${i + 1}. ` : "";
      if (r.columns.length) {
        const shown = r.rows.slice(0, maxRows);
        lines.push(`${n}${kind.keyword}: ${r.rows.length} row(s)${r.rows.length > shown.length ? ` (showing ${shown.length})` : ""}`);
        if (shown.length) lines.push(renderRows(shown, r.columns, format));
      } else {
        const bits = [];
        if (r.affected !== null && r.affected !== undefined) bits.push(`${r.affected} row(s) affected`);
        if (kind.keyword === "UPDATE" && r.changed !== null && r.changed !== undefined && r.changed !== r.affected) bits.push(`${r.changed} changed`);
        if (r.insertId) bits.push(`insert id ${r.insertId}`);
        if (r.warnings) bits.push(`${r.warnings} warning(s)`);
        lines.push(`${n}${r.command || kind.keyword}${bits.length ? `: ${bits.join(", ")}` : ": done"}`);
      }
    }
    const how = dryRun ? "DRY RUN: ran inside a transaction and rolled back, nothing changed" : inTx ? "committed as one transaction" : engine === "mysql" && implicit.length ? "no transaction (MySQL commits DDL on the spot)" : "autocommit, statement by statement";
    return clip(`${viaLine(ctx)} · ${stmts.length} statement(s) · ${how} · ${ms(took)}\n${lines.join("\n")}`, s.maxChars, "return fewer rows");
  }), sql0);
}

// ------------------------------------------------------------------ proxy --

export async function proxy(args, env) {
  const s = settings(env?.config);
  const action = String(args?.action ?? "list").toLowerCase();
  const fmt = (x) => `${x.instance} · ${x.mode}${x.container ? ` ${x.container}` : x.pid ? ` pid ${x.pid}` : ""} · ${x.up ? `up at ${x.host}:${x.port}` : "down"} · flags ${x.flags?.length ? x.flags.join(" ") : "none"} · credential ${x.credential} · started ${new Date(x.createdAt).toISOString().replace(/\.\d+Z$/, "Z")} · last used ${new Date(x.lastUsed).toISOString().replace(/\.\d+Z$/, "Z")}`;
  const pick = async () => {
    if (!args?.connection) return null;
    const p = profile(s, args.connection);
    if (p.via === "direct") throw new Error(`connection "${p.name}" is direct (${p.host}): it has no proxy`);
    return p;
  };
  if (action === "list") {
    const px = await listProxies(env);
    const orphans = await orphanContainers(env);
    const out = px.length ? px.map(fmt) : ["no proxies running"];
    if (orphans.length) out.push(`containers left behind by an earlier run: ${orphans.join(", ")} (action=stop without a connection removes them)`);
    return out.join("\n");
  }
  if (action === "start") {
    const p = await pick();
    if (!p) throw new Error("say which `connection` to start the proxy for");
    const t0 = Date.now();
    const x = await ensureProxy(env, s, p);
    return `${x.started ? `started in ${ms(Date.now() - t0)}` : "already running"}: ${fmt({ ...x, up: true })}`;
  }
  if (action === "stop") {
    const p = await pick();
    const stopped = await stopProxies(env, (st) => !p || st.instance === p.instance);
    let orphans = [];
    if (!p) { orphans = await orphanContainers(env); await removeContainers(orphans); }
    const n = stopped.length + orphans.length;
    return n ? `stopped ${n}: ${[...stopped.map((x) => `${x.instance} (${x.mode})`), ...orphans].join(", ")}` : "nothing to stop";
  }
  if (action === "logs") {
    const px = await listProxies(env);
    const p = await pick();
    const mine = p ? px.filter((x) => x.instance === p.instance) : px;
    if (!mine.length) return p ? `no proxy for ${p.instance} is known; a failed start says its reason in the error it returned` : "no proxies are known";
    const lines = clampInt(args?.lines, 60, 1, 500);
    const out = [];
    for (const x of mine) out.push(`== ${x.instance} (${x.mode}, ${x.up ? "up" : "down"})\n${await proxyLogs(env, x, lines)}`);
    return clip(out.join("\n"), s.maxChars);
  }
  throw new Error("`action` is list, start, stop or logs");
}

// The two engines behind one small interface. A connection is opened per tool
// call and closed after it: nothing is pooled across calls, so no call sees a
// session variable, a transaction or a temporary table another one left.
//
//   open(target)          → session
//   session.read(sql, values, { maxRows, timeoutMs })
//                         → { columns, rows, more }   inside a READ ONLY transaction, rolled back
//   session.exec(sql, values, { timeoutMs }) → { columns, rows, affected, command }
//   session.begin() / commit() / rollback()
//   session.close()
//
// Values come back as JSON-safe things: numbers past 2^53 and DECIMALs as
// strings, dates and timestamps as the server wrote them, binary as hex.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let mysqlMod = null, pgMod = null, cursorMod = null;
function mysql() {
  if (!mysqlMod) {
    try { mysqlMod = require("mysql2/promise"); } catch { throw new Error("the mysql2 driver is not installed in this package: reinstall it (install_package) so npm can fetch its dependencies"); }
  }
  return mysqlMod;
}
function pg() {
  if (!pgMod) {
    try { pgMod = require("pg"); cursorMod = require("pg-cursor"); } catch { throw new Error("the pg driver is not installed in this package: reinstall it (install_package) so npm can fetch its dependencies"); }
  }
  return { pg: pgMod, Cursor: cursorMod };
}

/** A cell as JSON can carry it. */
export function plain(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (Buffer.isBuffer(v)) return v.length <= 64 ? `0x${v.toString("hex")}` : `0x${v.subarray(0, 64).toString("hex")}… (${v.length} bytes)`;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = plain(x);
    return o;
  }
  return v;
}

function friendlyNetError(e, target) {
  const where = target.socketPath ? `socket ${target.socketPath}` : `${target.host}:${target.port}`;
  const code = e?.code ?? "";
  if (code === "ECONNREFUSED") return new Error(`nothing is listening on ${where} (ECONNREFUSED)${target.viaProxy ? ": the Cloud SQL proxy is not up; sql_proxy action=logs shows why" : ""}`);
  if (code === "ETIMEDOUT" || /timeout/i.test(e?.message ?? "")) return new Error(`connecting to ${where} timed out${target.viaProxy ? "; sql_proxy action=logs shows what the proxy saw" : ": check the host is reachable from this space and the firewall or authorized networks admit it"}`);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new Error(`cannot resolve ${target.host} (${code})`);
  if (code === "ECONNRESET" || code === "PROTOCOL_CONNECTION_LOST" || /Connection terminated|server closed the connection/i.test(e?.message ?? "")) {
    return new Error(`the connection to ${where} was closed by the other end${target.viaProxy ? ". Through the Cloud SQL proxy this is usually the proxy refusing: missing roles/cloudsql.client, a wrong instance name, or a private-IP instance reached without privateIp. sql_proxy action=logs shows the proxy's reason" : ""}`);
  }
  return null;
}

// ------------------------------------------------------------------ MySQL --

async function openMysql(target) {
  const { createConnection } = mysql();
  let conn;
  try {
    conn = await createConnection({
      host: target.socketPath ? undefined : target.host,
      port: target.socketPath ? undefined : target.port,
      socketPath: target.socketPath || undefined,
      user: target.user,
      password: target.password ?? undefined,
      database: target.database || undefined,
      connectTimeout: target.connectTimeoutMs,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: false,
      multipleStatements: false,
      charset: "utf8mb4",
      ssl: target.ssl || undefined,
      ...(target.options ?? {}),
    });
  } catch (e) {
    throw friendlyNetError(e, target) ?? e;
  }
  let maria = null;
  const engine = async () => {
    if (maria === null) {
      const [r] = await conn.query("SELECT VERSION() AS v");
      maria = /mariadb/i.test(String(r?.[0]?.v ?? ""));
    }
    return maria;
  };
  const limitTime = async (timeoutMs) => {
    // Server-side, so a timed-out SELECT stops on the server too, not just here.
    try {
      if (await engine()) await conn.query(`SET SESSION max_statement_time = ${Math.max(1, Math.ceil(timeoutMs / 1000))}`);
      else await conn.query(`SET SESSION max_execution_time = ${Math.max(1, Math.trunc(timeoutMs))}`);
    } catch { /* an old server: the client timeout below still holds */ }
  };
  const columnsOf = (fields) => (fields ?? []).map((f) => f.name);
  const session = {
    engine: "mysql",
    raw: conn,
    async read(sql, values, { maxRows, timeoutMs }) {
      await limitTime(timeoutMs);
      await conn.query(`SET SESSION sql_select_limit = ${Math.trunc(maxRows) + 1}`);
      await conn.query("START TRANSACTION READ ONLY");
      try {
        const [rows, fields] = await conn.query({ sql, values, timeout: timeoutMs + 2_000, rowsAsArray: false });
        const list = Array.isArray(rows) ? rows : [];
        // A statement that returns several result sets (SHOW ... can't, but be safe) answers the first.
        const set = Array.isArray(list[0]) && Array.isArray(fields?.[0]) ? list[0] : list;
        const cols = Array.isArray(fields?.[0]) ? columnsOf(fields[0]) : columnsOf(fields);
        return { columns: cols, rows: set.slice(0, maxRows).map(plain), more: set.length > maxRows };
      } finally {
        await conn.query("ROLLBACK").catch(() => {});
        await conn.query("SET SESSION sql_select_limit = DEFAULT").catch(() => {});
      }
    },
    async exec(sql, values, { timeoutMs }) {
      await limitTime(timeoutMs);
      const [res, fields] = await conn.query({ sql, values, timeout: timeoutMs + 2_000 });
      if (Array.isArray(res)) return { columns: columnsOf(fields), rows: res.map(plain), affected: null, command: null };
      return { columns: [], rows: [], affected: res?.affectedRows ?? null, changed: res?.changedRows ?? null, insertId: res?.insertId || null, warnings: res?.warningStatus || 0, info: res?.info || "" };
    },
    async begin() { await conn.query("START TRANSACTION"); },
    async commit() { await conn.query("COMMIT"); },
    async rollback() { await conn.query("ROLLBACK"); },
    async close() { try { await conn.end(); } catch { try { conn.destroy(); } catch { /* gone */ } } },
    async version() { const [r] = await conn.query("SELECT VERSION() AS v, CURRENT_USER() AS u, DATABASE() AS d"); return { version: r[0].v, user: r[0].u, database: r[0].d }; },
  };
  return session;
}

// ------------------------------------------------------------- PostgreSQL --

// Dates, times and timestamps as the server wrote them, not shifted through a JS Date.
const PG_RAW_TYPES = [1082, 1083, 1114, 1184, 1266];

async function openPostgres(target) {
  const { pg: lib, Cursor } = pg();
  const types = {
    getTypeParser(oid, format) {
      if (PG_RAW_TYPES.includes(oid)) return (v) => v;
      return lib.types.getTypeParser(oid, format);
    },
  };
  const client = new lib.Client({
    host: target.socketPath || target.host,
    port: target.port,
    user: target.user,
    password: target.password ?? undefined,
    database: target.database || "postgres",
    connectionTimeoutMillis: target.connectTimeoutMs,
    ssl: target.ssl || undefined,
    application_name: "thetis-sql",
    types,
    ...(target.options ?? {}),
  });
  // A dropped connection emits 'error' on the client; without a listener that would end the process.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (e) {
    throw friendlyNetError(e, target) ?? e;
  }
  const columnsOf = (fields) => (fields ?? []).map((f) => f.name);
  const setTimeout_ = async (timeoutMs) => { await client.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`); };
  let inTx = false;
  const session = {
    engine: "postgres",
    raw: client,
    async read(sql, values, { maxRows, timeoutMs }) {
      await client.query("BEGIN READ ONLY");
      try {
        await setTimeout_(timeoutMs);
        const cursor = client.query(new Cursor(sql, values ?? [], { types }));
        try {
          const rows = await cursor.read(Math.trunc(maxRows) + 1);
          const fields = cursor._result?.fields ?? [];
          return { columns: columnsOf(fields), rows: rows.slice(0, maxRows).map(plain), more: rows.length > maxRows };
        } finally {
          await cursor.close().catch(() => {});
        }
      } finally {
        await client.query("ROLLBACK").catch(() => {});
      }
    },
    async exec(sql, values, { timeoutMs }) {
      if (inTx) await setTimeout_(timeoutMs);
      else await client.query(`SET statement_timeout = ${Math.trunc(timeoutMs)}`);
      const r = await client.query({ text: sql, values: values ?? [] });
      const last = Array.isArray(r) ? r.at(-1) : r;
      const hasRows = (last.fields ?? []).length > 0;
      return { columns: columnsOf(last.fields), rows: hasRows ? last.rows.map(plain) : [], affected: hasRows && last.command === "SELECT" ? null : last.rowCount, command: last.command };
    },
    async begin() { await client.query("BEGIN"); inTx = true; },
    async commit() { await client.query("COMMIT"); inTx = false; },
    async rollback() { await client.query("ROLLBACK"); inTx = false; },
    async close() { try { await client.end(); } catch { /* gone */ } },
    async version() { const r = await client.query("SELECT version() AS v, current_user AS u, current_database() AS d"); return { version: r.rows[0].v, user: r.rows[0].u, database: r.rows[0].d }; },
  };
  return session;
}

/** Opens a session for a resolved target `{ engine, host, port, socketPath, user, password, database, ... }`. */
export async function open(target) {
  if (target.engine === "mysql") return openMysql(target);
  if (target.engine === "postgres") return openPostgres(target);
  throw new Error(`unknown engine ${target.engine}`);
}

/** A database error as one sentence a model can act on. */
export function explainDbError(e, sql) {
  const msg = String(e?.sqlMessage ?? e?.message ?? e);
  const code = e?.code ? ` [${e.code}${e.errno ? ` ${e.errno}` : ""}]` : "";
  const parts = [`the database refused it${code}: ${msg}`];
  // PostgreSQL gives a character position; MySQL says "near '...' at line N".
  const pos = Number(e?.position);
  if (sql && Number.isFinite(pos) && pos > 0) {
    const before = sql.slice(0, pos - 1);
    const line = before.split("\n").length;
    const col = pos - before.lastIndexOf("\n") - 1;
    const text = sql.split("\n")[line - 1] ?? "";
    parts.push(`at line ${line}, column ${col}: ${text.trim().slice(0, 200)}`);
  }
  if (e?.hint) parts.push(`hint: ${e.hint}`);
  if (e?.detail) parts.push(`detail: ${e.detail}`);
  if (e?.code === "25006" || e?.errno === 1792) parts.push("This ran inside a READ ONLY transaction: run statements that change data with sql_execute.");
  if (e?.code === "57014" || e?.errno === 3024 || e?.errno === 1969) parts.push("It hit the statement timeout: narrow it, or pass a larger timeout_s.");
  if (e?.errno === 1045 || e?.code === "28P01" || e?.code === "28000") parts.push("The login was refused: check the user and its password (the `passwords` setting, passwordFile or passwordSecret).");
  if (e?.errno === 1044 || e?.errno === 1142 || e?.errno === 1227 || e?.code === "42501") parts.push("The database user lacks the privilege for this.");
  return parts.join("\n");
}

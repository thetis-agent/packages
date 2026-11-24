// SQL text without a parser: a lexer that knows where strings, quoted
// identifiers, comments and PostgreSQL dollar quotes begin and end, so a `;`,
// a `:name` or a keyword inside one of them is never mistaken for code.
// Everything here works on that split, and nothing here talks to a database.

const WORD = /[A-Za-z0-9_]/;

/** The end (exclusive) of a quoted run starting at i. A doubled quote is an escaped quote. */
function endQuote(sql, i, q, backslash) {
  let k = i + 1;
  while (k < sql.length) {
    const ch = sql[k];
    if (backslash && ch === "\\") { k += 2; continue; }
    if (ch === q) {
      if (sql[k + 1] === q) { k += 2; continue; }
      return k + 1;
    }
    k++;
  }
  return sql.length;
}

/**
 * Splits SQL into segments `{ type, text, start, end }` where type is `code`,
 * `string`, `ident` or `comment`. `engine` is `mysql` or `postgres`: MySQL has
 * `#` comments, backtick identifiers, double-quoted strings and backslash
 * escapes; PostgreSQL has double-quoted identifiers, E'' strings and $tag$ quotes.
 */
export function scan(sql, engine = "mysql") {
  const out = [];
  const my = engine === "mysql";
  const n = sql.length;
  let i = 0, codeStart = 0;
  const push = (type, s, e) => { if (e > s) out.push({ type, text: sql.slice(s, e), start: s, end: e }); };
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    let type = null, j = -1;
    if (c === "-" && d === "-") {
      type = "comment"; j = sql.indexOf("\n", i); j = j < 0 ? n : j + 1;
    } else if (c === "#" && my) {
      type = "comment"; j = sql.indexOf("\n", i); j = j < 0 ? n : j + 1;
    } else if (c === "/" && d === "*") {
      type = "comment"; j = sql.indexOf("*/", i + 2); j = j < 0 ? n : j + 2;
    } else if (c === "'") {
      const eStr = !my && /[eE]/.test(sql[i - 1] ?? "") && !WORD.test(sql[i - 2] ?? "");
      type = "string"; j = endQuote(sql, i, "'", my || eStr);
    } else if (c === '"') {
      type = my ? "string" : "ident"; j = endQuote(sql, i, '"', my);
    } else if (c === "`" && my) {
      type = "ident"; j = endQuote(sql, i, "`", false);
    } else if (c === "$" && !my && !WORD.test(sql[i - 1] ?? "")) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const k = sql.indexOf(m[0], i + m[0].length);
        type = "string"; j = k < 0 ? n : k + m[0].length;
      }
    }
    if (type) { push("code", codeStart, i); push(type, i, j); i = j; codeStart = j; }
    else i++;
  }
  push("code", codeStart, n);
  return out;
}

/** The statements in a script, split on `;` outside strings and comments, empty ones dropped. */
export function splitStatements(sql, engine) {
  const out = [];
  let cur = "";
  for (const seg of scan(sql, engine)) {
    if (seg.type !== "code") { cur += seg.text; continue; }
    const parts = seg.text.split(";");
    for (let k = 0; k < parts.length; k++) {
      cur += parts[k];
      if (k < parts.length - 1) { out.push(cur); cur = ""; }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => codeOnly(s, engine).trim() !== "");
}

/** The statement with strings blanked to '' and comments to a space: safe to search for keywords. */
export function codeOnly(sql, engine) {
  return scan(sql, engine).map((s) => (s.type === "code" ? s.text : s.type === "comment" ? " " : s.type === "ident" ? s.text : "''")).join("");
}

/** The first keyword of a statement, upper case, past comments and opening parentheses. */
export function firstKeyword(sql, engine) {
  const m = /^[\s(]*([A-Za-z]+)/.exec(codeOnly(sql, engine));
  return m ? m[1].toUpperCase() : "";
}

/** The keywords of a statement in order (identifiers and strings left out), upper case. */
export function keywords(sql, engine) {
  return (codeOnly(sql, engine).replace(/`[^`]*`|"[^"]*"/g, " ").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).map((w) => w.toUpperCase());
}

// Statements sql_query will run. Each still runs inside a READ ONLY
// transaction, which is the actual guarantee; this list is the early, clear
// refusal. CALL is not here: a procedure may commit and start a transaction of
// its own, which would end the read-only one.
export const READ_KEYWORDS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "TABLE"]);

// DDL and the rest that MySQL commits implicitly, so a rollback cannot undo them.
const MYSQL_IMPLICIT_COMMIT = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "GRANT", "REVOKE", "LOCK", "UNLOCK", "ANALYZE", "OPTIMIZE", "REPAIR", "INSTALL", "UNINSTALL", "FLUSH", "RESET"]);

/** What kind of statement this is, for the read gate, the dry run and the full-table guard. */
export function classify(sql, engine) {
  const kw = firstKeyword(sql, engine);
  const words = keywords(sql, engine);
  const code = codeOnly(sql, engine);
  const read = READ_KEYWORDS.has(kw);
  const intoFile = engine === "mysql" && /\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(code);
  // EXPLAIN ANALYZE runs the statement it explains.
  const analyzes = kw === "EXPLAIN" && words[1] === "ANALYZE";
  // A data-changing CTE in PostgreSQL: WITH x AS (DELETE ... RETURNING ...) SELECT ...
  const writesInWith = kw === "WITH" && words.some((w) => w === "INSERT" || w === "UPDATE" || w === "DELETE" || w === "MERGE");
  const target = kw === "EXPLAIN" ? words.find((w, i) => i > 0 && !["ANALYZE", "VERBOSE", "FORMAT", "JSON", "TEXT", "TREE", "TRADITIONAL", "COSTS", "BUFFERS", "TIMING", "SUMMARY", "SETTINGS", "WAL", "FALSE", "TRUE", "ON", "OFF"].includes(w)) : kw;
  const fullTable = (kw === "DELETE" || kw === "UPDATE") && !/\bWHERE\b/i.test(code);
  return {
    keyword: kw,
    read: read && !intoFile && !writesInWith,
    intoFile,
    analyzes,
    writesInWith,
    target,
    fullTable,
    implicitCommit: engine === "mysql" && MYSQL_IMPLICIT_COMMIT.has(kw),
  };
}

/**
 * `:name` placeholders to the engine's positional ones: `?` for MySQL, `$n`
 * for PostgreSQL (a repeated name reuses its number). `::type` casts and `:=`
 * are left alone, and so is anything inside a string or comment. Answers the
 * new text and the values in order.
 */
export function bindNamed(sql, engine, params) {
  const values = [];
  const index = new Map();
  const used = new Set();
  let text = "";
  for (const seg of scan(sql, engine)) {
    if (seg.type !== "code") { text += seg.text; continue; }
    text += seg.text.replace(/(^|[^:A-Za-z0-9_])[:@]([A-Za-z_][A-Za-z0-9_]*)/g, (all, pre, name, off, whole) => {
      // `@name` is a MySQL user variable and a PostgreSQL operator, so only `:name` binds.
      if (all.slice(pre.length)[0] !== ":") return all;
      if (whole[off + all.length] === ":" ) return all;
      if (!Object.prototype.hasOwnProperty.call(params, name)) {
        throw new Error(`the SQL uses :${name} but params has no "${name}" (params has ${Object.keys(params).join(", ") || "nothing"})`);
      }
      used.add(name);
      if (engine === "mysql") { values.push(params[name]); return `${pre}?`; }
      if (!index.has(name)) { values.push(params[name]); index.set(name, values.length); }
      return `${pre}$${index.get(name)}`;
    });
  }
  const unused = Object.keys(params).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`params has ${unused.map((k) => `"${k}"`).join(", ")} but the SQL never uses ${unused.length > 1 ? "them" : "it"} as :name`);
  return { text, values };
}

/**
 * Turns the `params` argument into `{ text, values }`. A list binds the
 * engine's own positional placeholders (`?` or `$1`) as written; an object
 * binds `:name` placeholders.
 */
export function bindParams(sql, engine, params) {
  if (params === undefined || params === null) return { text: sql, values: undefined };
  if (typeof params === "string") {
    try { params = JSON.parse(params); } catch { throw new Error("`params` is a list (for ? / $1 placeholders) or an object (for :name placeholders), not text"); }
  }
  const norm = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) ? JSON.stringify(v) : v);
  if (Array.isArray(params)) return { text: sql, values: params.map(norm) };
  if (typeof params === "object") {
    const out = bindNamed(sql, engine, params);
    return { text: out.text, values: out.values.map(norm) };
  }
  throw new Error("`params` is a list (for ? / $1 placeholders) or an object (for :name placeholders)");
}

/** Quotes an identifier for the engine. */
export function quoteIdent(name, engine) {
  const s = String(name);
  return engine === "mysql" ? `\`${s.replace(/`/g, "``")}\`` : `"${s.replace(/"/g, '""')}"`;
}

/** Strips one layer of identifier quotes. */
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === "`" && t.at(-1) === "`") || (t[0] === '"' && t.at(-1) === '"') || (t[0] === "[" && t.at(-1) === "]"))) return t.slice(1, -1);
  return t;
}

/** `schema.table`, `table`, quoted or not, into `{ schema, name }` (schema null when not given). */
export function parseObjectRef(ref) {
  const s = String(ref ?? "").trim();
  if (!s) throw new Error("give a table name, as `table` or `schema.table`");
  const parts = [];
  let cur = "", q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "`" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === ".") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  const clean = parts.map(unquote).filter((p) => p !== "");
  if (clean.length === 1) return { schema: null, name: clean[0] };
  if (clean.length === 2) return { schema: clean[0], name: clean[1] };
  if (clean.length === 3) return { database: clean[0], schema: clean[1], name: clean[2] };
  throw new Error(`cannot read "${s}" as a table name: write it as table or schema.table`);
}

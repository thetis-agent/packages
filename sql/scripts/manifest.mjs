// Generates package.json. Run: node scripts/manifest.mjs  (from the package directory)
// Tool descriptions live here as JS so they can be edited without fighting
// JSON escaping; the output file is what the kernel reads.
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const here = new URL("../package.json", import.meta.url);
const prev = existsSync(here) ? JSON.parse(readFileSync(here, "utf8")) : {};

const S = (description, extra = {}) => ({ type: "string", description, ...extra });
const B = (description) => ({ type: "boolean", description });
const I = (description, extra = {}) => ({ type: "integer", description, ...extra });
const obj = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });

const CONNECTION = S("The connection profile to use, by name (sql_status lists them). Defaults to the `default` setting, or the only profile.");
const FORMAT = S("How rows are written: `table` (default; one line per row, cells joined by |, nested values as JSON), `csv`, or `json` (an array of objects).", { enum: ["table", "csv", "json"] });
const PARAMS = {
  type: ["object", "array"],
  description:
    "Bound values, never pasted into the SQL. An object binds :name placeholders ({\"id\": 7} for `WHERE id = :id`); a list binds the engine's own placeholders in order (? for MySQL, $1 $2 for PostgreSQL). Objects and arrays inside are sent as JSON text.",
};
const ROWS = I("Rows to return, 0-5000. Defaults to the package's maxRows (100). More rows than this are not fetched.");
const TIMEOUT = I("Statement timeout in seconds, 1-300. Defaults to the profile's or the package's (30 s). It is set on the server, so a statement that runs out is stopped there too.");

const tools = [
  {
    name: "sql_status",
    description:
      "Show the SQL connection profiles (engine, host or Cloud SQL instance, user, database, read-only or not, where the password comes from; never the password), whether the Cloud SQL proxy can run here (Docker, the cloud-sql-proxy binary) and with which Google credential, and the proxies running now. With `connection`, connect to that one (starting its proxy if it needs one) and show the server version and the user it logs in as. Call it first, and whenever a connection fails.",
    parameters: obj({ connection: S("Connect to this profile and report the server version and login.") }),
    export: "sqlStatus",
    reads: true,
  },
  {
    name: "sql_schemas",
    description:
      "List the databases (MySQL) or schemas (PostgreSQL) on a connection's server with their table counts and sizes. For PostgreSQL it also names the other databases on the server, each of which needs its own profile.",
    parameters: obj({ connection: CONNECTION, search: S("Only names containing this text.") }),
    export: "sqlSchemas",
    reads: true,
    concurrent: true,
  },
  {
    name: "sql_tables",
    description:
      "List the tables and views in one database (MySQL) or schema (PostgreSQL) with type, estimated row count, size and comment. Defaults to the profile's database (MySQL) or the current schema (PostgreSQL). Row counts are the server's estimates, free to read; count(*) is not.",
    parameters: obj({
      connection: CONNECTION,
      schema: S("The database (MySQL) or schema (PostgreSQL) to list. Defaults to the profile's database or the current schema."),
      search: S("Only tables whose name contains this text."),
      limit: I("Most tables to list, 1-5000. Defaults to 500."),
    }),
    export: "sqlTables",
    reads: true,
    concurrent: true,
  },
  {
    name: "sql_describe",
    description:
      "Describe one table or view: columns with types, nullability, defaults, keys and comments; indexes; foreign keys and constraints; a view's SQL; size and estimated rows. `preview_rows` adds a few rows (in no order), `ddl` (MySQL) the CREATE statement. Read this before writing SQL against a table.",
    parameters: obj({
      connection: CONNECTION,
      table: S("The table: `table` or `schema.table` (MySQL: database.table). Quotes allowed."),
      schema: S("The database or schema, when `table` does not name one."),
      preview_rows: I("Also show this many rows, 0-100."),
      ddl: B("MySQL: also show SHOW CREATE TABLE."),
      format: FORMAT,
    }, ["table"]),
    export: "sqlDescribe",
    reads: true,
    concurrent: true,
  },
  {
    name: "sql_query",
    description:
      "Run one read-only statement (SELECT, WITH … SELECT, SHOW, DESCRIBE, EXPLAIN, VALUES, TABLE) and answer the rows. It runs inside a READ ONLY transaction that is always rolled back, with a server-side statement timeout and a row cap, so it cannot change anything even through a function. Anything else is refused: statements that change data or schema go through sql_execute. Bind values with `params` instead of pasting them into the SQL. Fetching stops at max_rows: aggregate in SQL rather than reading a whole table.",
    parameters: obj({
      sql: S("One read-only statement, in the connection's dialect (MySQL or PostgreSQL)."),
      connection: CONNECTION,
      params: PARAMS,
      max_rows: ROWS,
      timeout_s: TIMEOUT,
      format: FORMAT,
    }, ["sql"]),
    export: "sqlQuery",
    reads: true,
    concurrent: true,
  },
  {
    name: "sql_execute",
    description:
      "Run statements that change data or schema: INSERT, UPDATE, DELETE, MERGE, CREATE, ALTER, DROP, GRANT, CALL, or a script of them separated by ;. By default the whole script is one transaction, committed only if every statement succeeds (MySQL commits DDL on the spot, so a script holding DDL runs without one, and says so). `dry_run=true` runs it inside a transaction and rolls it back, to see the rows affected without keeping them. An UPDATE or DELETE without WHERE is refused unless allow_full_table=true. Refused on a read-only connection. Say what it will change before running it; a committed DELETE or DROP cannot be undone from here.",
    parameters: obj({
      sql: S("The statement, or a script of statements separated by ;."),
      connection: CONNECTION,
      params: { ...PARAMS, description: `${PARAMS.description} Only for a single statement.` },
      dry_run: B("Run inside a transaction and roll back: shows the rows affected, changes nothing. Not possible for MySQL DDL."),
      transaction: B("Run the script as one transaction (default true). false runs each statement in autocommit."),
      allow_full_table: B("Allow UPDATE or DELETE with no WHERE clause."),
      max_rows: ROWS,
      timeout_s: TIMEOUT,
      format: FORMAT,
    }, ["sql"]),
    export: "sqlExecute",
    reads: false,
  },
  {
    name: "sql_proxy",
    description:
      "Manage the Cloud SQL Auth Proxy this package runs for profiles that name a Cloud SQL `instance`. The proxy starts by itself on first use, as a Docker container (gcr.io/cloud-sql-connectors/cloud-sql-proxy) or a local cloud-sql-proxy process, and stops after `proxyIdleMinutes` unused. action=list shows them, start starts one for a `connection` ahead of time, stop stops one (or all, with no connection), logs shows what a proxy printed (use it when a connection through the proxy fails).",
    parameters: obj({
      action: S("list (default), start, stop or logs.", { enum: ["list", "start", "stop", "logs"] }),
      connection: S("The profile whose proxy to start, stop or read. stop with none stops every proxy."),
      lines: I("With logs: how many lines, 1-500. Defaults to 60."),
    }),
    export: "sqlProxy",
    reads: false,
  },
];

const config = {
  connections: {
    type: "object",
    default: {},
    help:
      "Connection profiles, name → profile. A Cloud SQL instance through the proxy: {\"engine\": \"mysql\", \"instance\": \"project:region:instance\", \"user\": \"app\", \"database\": \"app\"}. A direct server: {\"engine\": \"postgres\", \"host\": \"10.0.0.5\", \"port\": 5432, \"user\": \"me\", \"database\": \"db\"}. Optional keys: readOnly, timeoutMs, description, proxy (auto|docker|binary), privateIp, psc, iamAuth, impersonate, credentialFile, passwordFile, passwordSecret (a Secret Manager secret, name or projects/p/secrets/s/versions/v), ssl, socketPath, options (passed to the driver). Passwords go in `passwords`, not here.",
  },
  passwords: {
    type: "object",
    secret: true,
    help: "Database passwords by profile name: {\"dev\": \"…\", \"prod-ro\": \"…\"}. Secret: never shown, sent only to the database driver. Instead, a profile may name a passwordFile or a passwordSecret in Secret Manager.",
  },
  default: { type: "string", help: "The profile a tool uses when the call names none. Unset: the only profile, when there is one." },
  project: { type: "string", help: "Google Cloud project for passwordSecret names given without one." },
  readOnly: { type: "boolean", default: false, help: "When true, sql_execute refuses on every connection, so only reads run. A profile can also be readOnly on its own. The real boundary is the database user's privileges." },
  maxRows: { type: "number", default: 100, help: "Rows a query answers by default (a call can ask for up to 5000). Rows past the cap are not fetched." },
  timeoutMs: { type: "number", default: 30000, help: "Statement timeout in milliseconds (1000-300000), set on the server for every statement. A profile's timeoutMs overrides it." },
  maxChars: { type: "number", default: 20000, help: "Longest answer a tool returns, in characters (2000-200000); longer ones are cut with a note that says how to narrow them." },
  proxyMode: { type: "string", default: "auto", help: "How the Cloud SQL proxy runs: `docker` (a container on a Docker bridge network, reached at its own address, which works from a sandboxed space), `binary` (a local cloud-sql-proxy process on 127.0.0.1), or `auto` (docker when Docker answers, else the binary). A profile's `proxy` key overrides it." },
  proxyImage: { type: "string", default: "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.3", help: "The proxy container image." },
  proxyNetwork: { type: "string", default: "bridge", help: "The Docker network the proxy container joins. This space must be able to reach addresses on it." },
  proxyBinary: { type: "string", default: "cloud-sql-proxy", help: "The cloud-sql-proxy executable for proxyMode binary: a name on the PATH or a full path." },
  proxyIdleMinutes: { type: "number", default: 30, help: "Stop a proxy after this many minutes unused (0: never). It starts again by itself on the next query, in a few seconds." },
  proxyMemory: { type: "string", default: "256m", help: "Memory limit of a proxy container (docker --memory)." },
  googleCredentialsJson: { type: "string", secret: true, help: "A service account key (the whole JSON) the proxy authenticates with. It needs roles/cloudsql.client on the project (and roles/cloudsql.instanceUser for iamAuth). Written to a private file in this space for the proxy to read. Unset: googleCredentialFile, then GOOGLE_APPLICATION_CREDENTIALS, then this space's gcloud login." },
  googleCredentialFile: { type: "string", help: "Instead of googleCredentialsJson: the path of a service account key file in this space." },
};

const pkg = {
  name: prev.name ?? "@bitmuse/sql",
  version: prev.version ?? "0.1.0",
  description:
    "MySQL and PostgreSQL as tools: list databases, schemas and tables, describe a table, run read-only queries inside a rolled-back READ ONLY transaction, and run changes and scripts in one transaction with a dry run, over named connection profiles that reach a server directly or a Google Cloud SQL instance through the Cloud SQL Auth Proxy, which the package runs itself as a Docker container or a local process.",
  keywords: ["sql", "mysql", "mariadb", "postgres", "postgresql", "database", "cloud sql", "cloud-sql-proxy", "google cloud", "gcp", "query", "schema"],
  license: "MIT",
  type: "module",
  main: "index.js",
  scripts: { test: "node test.smoke.mjs", manifest: "node scripts/manifest.mjs" },
  dependencies: { mysql2: "3.24.6", pg: "8.23.1", "pg-cursor": "2.22.1" },
  thetis: {
    type: "tool",
    label: "SQL",
    toolGroup: {
      id: "sql",
      brief: "Query MySQL and PostgreSQL databases, including Google Cloud SQL through the Cloud SQL proxy: schemas, tables, SELECT, changes.",
      tags: ["sql", "mysql", "mariadb", "postgres", "postgresql", "psql", "database", "databases", "cloud sql", "cloudsql", "sql proxy", "cloud-sql-proxy", "stored procedure", "table schema", "select query", "db query"],
    },
    service: { export: "startService" },
    tools,
    config,
  },
};
if (prev.thetis?.publishedAs) pkg.thetis.publishedAs = prev.thetis.publishedAs;
writeFileSync(here, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`wrote package.json: ${tools.length} tools, ${Object.keys(config).length} settings`);

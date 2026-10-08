# @thetis/bigquery

[Google BigQuery](https://cloud.google.com/bigquery)'s REST API (`bigquery/v2`) as Thetis tools: find datasets and tables, read schemas and preview rows for free, run SELECTs with a cost check before every one, run DML, DDL and scripts unless the package is read-only, and follow long jobs.

The tool set follows Google's own BigQuery MCP tools (`list_dataset_ids`, `get_dataset_info`, `list_table_ids`, `get_table_info`, `execute_sql`) and adds what a model needs to not spend money by accident: every query is dry-run first (free; it answers the statement type and the bytes it would scan), a query over the cap is refused with the estimate, and the real run carries the same cap as `maximumBytesBilled`, so BigQuery stops it before billing. It talks to the API with `fetch`; the space needs neither the Cloud SDK nor a client library.

## Setup

| Key | Value |
|---|---|
| `credentialsJson` | Secret. A service account key: the whole JSON file from **IAM → Service accounts → Keys → Add key**. Signed into a short-lived token in the tool process; the key never reaches the model. |
| `credentialFile` | Instead: the path of a key file in the space. With neither, the space's own gcloud login is used (`gcloud auth print-access-token`; `account` picks one of several). |
| `project` | The project that runs and pays for queries. Defaults to the key's project. |
| `dataset` | Optional default dataset for unqualified table names. |
| `location` | Optional job location (`US`, `EU`, a region). Unset: inferred from the tables. |
| `readOnly` | `true` makes `bigquery_execute` refuse everything. Default `false`. |
| `maxGbBilled` | Per-query cap in GB scanned. Default 25 (about $0.14 at $6.25/TiB on-demand). A call's `max_gb` can only lower it. |
| `maxRows`, `timeoutMs`, `maxChars` | Rows per answer (100, up to 1000 per call), wait per query (60 s), longest answer (20000 characters). |
| `apiUrl` | Only for a proxy or emulator. |

Then `bigquery_status`: who it runs as, the project, the cap, and the datasets it can see.

The account's IAM roles are the real boundary. For querying, grant **roles/bigquery.jobUser** on the project; for reading, **roles/bigquery.dataViewer** on the project or per dataset; for writing, **roles/bigquery.dataEditor** on the datasets it may change. `readOnly` and the cap keep the agent from trying; they do not replace the roles.

## Tools

| Tool | Does |
|---|---|
| `bigquery_status` | Account and credential source, project, default dataset, cap, mode, the datasets visible. |
| `bigquery_datasets` | Datasets with location; one with description, expirations, labels, access list and table count. |
| `bigquery_tables` | Tables, views and materialized views with partitioning and clustering. Date shards (`events_20260101`, …) grouped as `events_*` with count and date range; `sizes=true` adds rows and bytes. |
| `bigquery_table` | Schema (nested fields indented, descriptions), rows, size, partitioning, clustering, view SQL. `events_*` shows the latest shard. `preview_rows` reads stored rows for free, optionally only `columns`. |
| `bigquery_query` | One SELECT: dry run, cap check, run; rows as `table`, `csv` or `json`, with row count, bytes scanned and billed, cost and job id. Named `params` (`@name`). `dry_run=true` estimates only. Anything that is not a SELECT is refused. |
| `bigquery_execute` | INSERT, UPDATE, DELETE, MERGE, DDL, CTAS, scripts: rows affected, object created, bytes billed; rows when a script ends in a SELECT. Same dry run and cap. Refused when `readOnly`. |
| `bigquery_job` | A job's state, timings, bytes, SQL and error, and result rows from `start_row`; `wait_s` waits, `cancel` stops. Without `job_id`, this account's recent jobs. |

Values come back typed: INT64 as numbers (as strings past 2^53), TIMESTAMP as ISO 8601 with microseconds, RECORD and REPEATED as objects and lists.

## Test

`node test.smoke.mjs` runs the helpers and every tool against an in-memory BigQuery and token endpoint on a local port, including the JWT signature check, the cap, the read-only refusal and job paging. No Google credentials are needed.

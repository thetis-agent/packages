# @thetis/sql

MySQL (and MariaDB) and PostgreSQL as Thetis tools. They reach a server directly, or reach a **Google Cloud SQL** instance through the [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/mysql/sql-proxy). The package runs the proxy itself, as a Docker container or a local `cloud-sql-proxy` process.

Reads and writes use separate tools. `sql_query` runs one statement inside a `READ ONLY` transaction and always rolls it back, with a server-side statement timeout and a row cap. Because of that, even a function with side effects cannot change anything. `sql_execute` runs changes and scripts in one transaction. It has a dry run and refuses an `UPDATE`/`DELETE` without `WHERE` unless you allow it. It also refuses on a read-only connection.

## Setup

Connections are named **profiles** in the `connections` setting. Passwords go in the secret `passwords` setting, keyed by profile name.

```json
{
  "dev":     { "engine": "mysql", "instance": "my-project:us-central1:dev-primary", "user": "app", "database": "app" },
  "prod-ro": { "engine": "mysql", "instance": "my-project:us-central1:prod-replica", "user": "reader", "database": "app", "readOnly": true },
  "local":   { "engine": "postgres", "host": "10.0.0.5", "port": 5432, "user": "me", "database": "db" }
}
```

`passwords`: `{"dev": "…", "prod-ro": "…", "local": "…"}`.

| Profile key | Meaning |
|---|---|
| `engine` | `mysql` or `postgres`. When a profile has an `instance` and no `engine`, the package reads the engine from `gcloud sql instances describe`. |
| `instance` | The Cloud SQL instance connection name, `project:region:instance`. Setting it makes the profile go through the proxy. |
| `host`, `port`, `socketPath` | A direct connection instead. |
| `user`, `database` | The login and the default database. |
| `readOnly` | `sql_execute` refuses on this profile. |
| `timeoutMs` | The statement timeout for this profile. |
| `description` | Shown by `sql_status`. |
| `proxy` | `auto`, `docker` or `binary`: overrides `proxyMode` for this profile. |
| `privateIp`, `psc` | Connect through the instance's private IP or its PSC endpoint. The proxy has to run where that network is reachable. |
| `iamAuth` | IAM database authentication (`--auto-iam-authn`). There is no password. `user` is the IAM user. |
| `impersonate` | The proxy acts as this service account. |
| `credentialFile` | A Google key for this profile's proxy only. |
| `passwordFile` | Read the password from a file. |
| `passwordSecret` | Read the password from Secret Manager with gcloud: `name`, `name@version` or `projects/p/secrets/s/versions/v`. |
| `ssl`, `options` | Passed to the driver. Direct connections only; the proxy already encrypts the connection. |

| Setting | Default | Meaning |
|---|---|---|
| `connections` | `{}` | The profiles. |
| `passwords` | — | Secret. Passwords by profile name. |
| `default` | — | The profile used when a call names none (otherwise the only profile, when there is just one). |
| `readOnly` | `false` | `sql_execute` refuses on every profile. |
| `maxRows` | `100` | Rows returned by default. A call can ask for up to 5000. Rows past the cap are never fetched. |
| `timeoutMs` | `30000` | The statement timeout. It is set on the server, so a statement that runs too long is stopped on the server too. |
| `maxChars` | `20000` | The longest answer a tool returns. |
| `proxyMode` | `auto` | `docker`, `binary`, or `auto` (Docker when it answers, otherwise the binary). |
| `proxyImage` | `gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.3` | The container image. |
| `proxyNetwork` | `bridge` | The Docker network the container joins. |
| `proxyBinary` | `cloud-sql-proxy` | The executable used for `binary` mode. |
| `proxyIdleMinutes` | `30` | Stop a proxy after this many minutes without use. `0` means never. |
| `proxyMemory` | `256m` | The memory limit of the container. |
| `googleCredentialsJson` | — | Secret. The service account key the proxy uses. |
| `googleCredentialFile` | — | The same key, as a file path in the space. |
| `project` | — | The project used for `passwordSecret` names that don't include one. |

**The Google credential** the proxy uses is chosen in this order: the profile's `credentialFile`, then `googleCredentialsJson`, then `googleCredentialFile`, then `GOOGLE_APPLICATION_CREDENTIALS`, then gcloud's application-default login, then the key of gcloud's active account. That account needs **roles/cloudsql.client** on the project. With `iamAuth` it also needs **roles/cloudsql.instanceUser**, and with `passwordSecret` it needs **roles/secretmanager.secretAccessor** on the secret.

## The proxy

The first call on a profile that has an `instance` starts a proxy for it. Later calls reuse it. When it has been idle for `proxyIdleMinutes`, the package's service stops it, and the next call starts it again (this takes a few seconds). Profiles that use the same instance with the same flags share one proxy.

- **docker**: starts a container named `thetis-sqlproxy-<user>-<hash>` on `proxyNetwork`, read-only and running as your uid, with the key mounted read-only. The package connects to it at the container's own address on that network. Nothing is published on a host port. This is why it works from a sandboxed space whose network has no route to the host's loopback.
- **binary**: starts `cloud-sql-proxy` as a child process on `127.0.0.1` and a free port.

Every proxy starts with `--run-connection-test`. So a missing `roles/cloudsql.client`, a wrong instance name or a disabled API makes the call fail with Google's own reason and a pointer to the fix, instead of a closed socket later. The proxy's state is kept in `<space>/run/sql-proxy/`, so a reload of the package finds the proxies that are already running. `sql_proxy` lists, starts, stops and shows the logs of proxies. Uninstalling the package stops them.

## Tools

| Tool | What it does |
|---|---|
| `sql_status` | Lists the profiles (never a password), shows whether Docker or the binary can run the proxy, which Google credential it uses, and the proxies running now. With `connection`: connects and shows the server version and the login. |
| `sql_schemas` | Lists databases (MySQL) or schemas (PostgreSQL) with table counts and sizes. For PostgreSQL it also lists the other databases on the server. |
| `sql_tables` | Lists tables and views with type, estimated row count, size and comment. |
| `sql_describe` | Shows a table's columns, keys, indexes, foreign keys and constraints, and a view's SQL. Optionally shows `preview_rows` and `ddl`. |
| `sql_query` | Runs one read-only statement. `params` binds `:name` (an object) or `?` / `$1` (a list). |
| `sql_execute` | Runs changes and scripts. By default a script is one transaction; MySQL DDL runs without one and the answer says so. Options: `dry_run`, `allow_full_table`, `transaction=false`. |
| `sql_proxy` | `list`, `start`, `stop`, `logs`. |

Values come back JSON-safe. Integers above 2^53 are returned as strings. Dates and timestamps come back as the server wrote them. Binary data comes back as hex.

What these tools enforce:

- `sql_query` refuses anything that is not a read: a write, `SELECT … INTO OUTFILE`, a `WITH` that holds a `DELETE`, and more than one statement. Anything that gets past that check still runs inside a `READ ONLY` transaction.
- `sql_execute` refuses on read-only profiles and refuses a full-table `UPDATE`/`DELETE`.

The real limit on what can be done is the database user's privileges. Give a read-only profile a read-only user.

## Test

`node test.smoke.mjs` checks the manifest and the SQL lexer (statement splitting, statement classes, named parameters). If Docker is available, it then starts MySQL 8.0 and PostgreSQL 16 containers and runs every tool against them: directly, and through a stand-in proxy (`test/fake-proxy.mjs`, which takes the same flags and prints the same readiness lines) both as a container and as a process. That includes a proxy whose connection test fails with Google's 403, and idle shutdown with restart. Everything it started is removed afterwards. To also check the real proxy image against a real instance, run with `SQL_TEST_REAL_PROXY=1 SQL_TEST_INSTANCE=project:region:instance SQL_TEST_KEY=<key file>`.

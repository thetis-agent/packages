# @thetis/gcloud

The Google Cloud CLI as three tools for the model, modelled on Google's
[gcloud MCP server](https://github.com/googleapis/gcloud-mcp): one gcloud
command per call, parsed by gcloud itself before it runs, and checked against
a denylist that cannot be switched off plus your own allow, deny and read-only
settings. It is a tool group (`gcloud`), so it joins a chat when the chat
mentions gcloud, GCP, Cloud Run, GKE and the like, or when `tool_search` loads it.

| Tool | Changes things | What it's for |
|---|---|---|
| `gcloud_run` | yes | Run one gcloud command: `args` (a list of words after `gcloud`) or `command` (one line). Returns the exit code, stdout and stderr. `dry_run` checks it against the policy without running. |
| `gcloud_help` | no | A command's `--help` (synopsis, flags, examples), or `search` across all help text. |
| `gcloud_status` | no | SDK version, credentialed accounts and the active one, the default project/region/zone, and the policy in force. Call first. |

## How a command is checked

1. The words are quoted one by one and handed to gcloud, never to a shell.
   `|`, `>`, `&&` and `$(...)` reach gcloud as text, so chaining does nothing;
   use gcloud's `--filter`, `--format` and `--limit`.
2. `gcloud meta lint-gcloud-commands` parses the line, as gcloud-mcp does. A
   malformed line (an unknown flag, a missing positional) is refused with
   gcloud's own message and nothing runs. The parse also yields the command
   path without flags or values (`compute instances list`), which is what the
   policy is checked against, so `gcloud compute --project=x instances delete`
   cannot slip past a deny entry for `compute instances delete`.
3. The policy:
   - **Always refused**: gcloud-mcp's default denylist (`compute ssh`,
     `compute start-iap-tunnel`, `compute connect-to-serial-port`, the TPU
     ssh commands, `cloud-shell ssh`, `workstations ssh`, `app instances ssh`,
     `interactive`), and, added here, `init`, `auth login`,
     `auth application-default login`, the `print-access-token` /
     `print-identity-token` commands (their output is a bearer token that
     would sit in the chat), `components`, `feedback`, `survey`.
   - **`deny`** setting, then **`allow`** setting, with gcloud-mcp's
     release-track rules: a GA deny entry (`compute instances delete`) denies
     its alpha and beta variants too; a track entry (`alpha`) denies only that
     track; an allow entry admits exactly the track it names (`beta run`
     admits `beta run …`, not `run …`).
   - **`mode: read-only`** admits only commands whose last word is a reading
     verb (`list`, `describe`, `get-iam-policy`, `read`, `get-value`, …).
4. It runs with prompts disabled (`--quiet` is implied), stdin closed, usage
   reporting and update checks off, and a timeout (120 s by default, up to
   600 s per call with `timeout_s`). Output is clipped to 18,000 characters,
   with a hint to project it down.

gcloud-mcp's `input_files` has no counterpart: this runs in your own space,
so write the file with the file tools and pass `cwd` or a path.

## Setup

gcloud must be on the space's `PATH` (or set `gcloudPath`). Then give it
credentials, in one of these ways:

| Way | How |
|---|---|
| A service account key | Paste the whole JSON key into the `credentialsJson` setting (secret). It is written to a private file under `~/.cache/thetis-gcloud/` for each call and removed afterwards. Simplest; use a least-privilege account. |
| A credentials file | Put a key or a workload-identity-federation config somewhere in the space and set `credentialFile` to its path. |
| Impersonation | Any of the above plus `impersonateServiceAccount`; the base credential needs `roles/iam.serviceAccountTokenCreator` on it. |
| gcloud's own login | Run `gcloud auth login --no-launch-browser` yourself in the terminal (it is refused through the tool, since it waits for a code). |

Then `gcloud_status` shows what it will run as.

| Key | Meaning |
|---|---|
| `project`, `region`, `zone` | Defaults, passed as `CLOUDSDK_*` environment, so a `--project` flag in a command still wins. |
| `account` | Which credentialed account to use when gcloud holds several. |
| `credentialsJson` | Secret. A service account key. |
| `credentialFile` | Path to a credentials file (`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`). |
| `impersonateServiceAccount` | Act as this service account. |
| `billingProject` | Quota project for APIs that need one. |
| `configDir`, `configuration` | gcloud's config directory and a named configuration. |
| `mode` | `full` (default) or `read-only`. |
| `allow`, `deny` | Comma-separated lists or JSON arrays of commands or groups. |
| `gcloudPath` | The executable, when gcloud is not on the PATH. |
| `timeoutMs` | Default per-command timeout, 120000, clamped 5000–600000. |

As a file layer, for an installation-wide default:

```json
{ "packages": { "@thetis/gcloud": { "project": "my-proj", "mode": "read-only", "credentialsJson": "${GCP_SA_KEY}" } } }
```

## Permissions

What the tools can do is what the credential can do. The allow/deny lists and
read-only mode are guard rails for the model, not a security boundary: for
that, give the space a service account with only the roles the work needs.

## Test

`node test.smoke.mjs` checks the splitter and the policy offline, then the
tools against the local gcloud (lint, a refused command, help, status, the
project setting, the key file's removal). No credentials are needed.

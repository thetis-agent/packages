# @bitmuse/grafana

The Grafana HTTP API as 29 tools for the model, against one configured Grafana
Cloud stack or self-hosted instance, sharing one client module.

| Tool | Endpoint(s) | What it's for |
|---|---|---|
| `grafana_health` | `GET /api/health`, `GET /api/org` | Version, DB health, does the token work, which org. Call first when anything fails. |
| `grafana_search` | `GET /api/search` | Find dashboards and folders by title/tag/folder. The discovery tool: start here for a uid. |
| `grafana_dashboard_get` | `GET /api/dashboards/uid/:uid` | Compact summary (panels, queries, variables), the full JSON, or one panel. |
| `grafana_dashboard_save` | `POST /api/dashboards/db` | Create from a full model, or edit in place by uid with `set` paths / `panels_add` / `panels_remove`. |
| `grafana_dashboard_delete` | `DELETE /api/dashboards/uid/:uid` | Delete. |
| `grafana_dashboard_versions` | `GET …/versions[/:v]`, `POST …/restore` | History, one version's model, restore. |
| `grafana_dashboard_permissions` | `GET/POST /api/dashboards/uid/:uid/permissions` | Read or replace the ACL. |
| `grafana_folder_list` | `GET /api/folders[/:uid]` | List (nested with `parent_uid`) or read one. |
| `grafana_folder_save` | `POST /api/folders`, `PUT /api/folders/:uid` | Create, rename, move. |
| `grafana_folder_delete` | `DELETE /api/folders/:uid` | Delete with contents. |
| `grafana_datasource_list` | `GET /api/datasources[/uid/:uid[/health]]` | List, read one, health check. |
| `grafana_datasource_save` | `POST /api/datasources`, `PUT /api/datasources/uid/:uid` | Create, or merge-update. |
| `grafana_datasource_delete` | `DELETE /api/datasources/uid/:uid` | Delete. |
| `grafana_query` | `POST /api/ds/query` | Run PromQL/LogQL/SQL through Grafana and see the frames. Test a panel query before saving it. |
| `grafana_annotation_list/create/update/delete` | `/api/annotations` | Deploy markers, incidents, regions; org-wide or on a panel. |
| `grafana_alert_rule_list/save/delete` | `/api/v1/provisioning/alert-rules` | Grafana-managed alert and recording rules. |
| `grafana_alert_rule_group` | `/api/v1/provisioning/folder/:f/rule-groups/:g` | Evaluation interval, wholesale rule replacement, delete group. |
| `grafana_contact_point_list/save/delete` | `/api/v1/provisioning/contact-points` | Slack, email, PagerDuty, webhook… |
| `grafana_notification_policies` | `/api/v1/provisioning/policies` | The routing tree: read, replace, export, reset. |
| `grafana_mute_timings` | `/api/v1/provisioning/mute-timings` | Scheduled silences. |
| `grafana_templates` | `/api/v1/provisioning/templates` | Notification message templates. |
| `grafana_request` | anything under `/api/` or `/apis/` | The escape hatch: teams, users, service accounts, library panels, playlists, RBAC, app-platform routes. |

## Setup

1. In Grafana: **Administration → Users and access → Service accounts → Add
   service account**. Give it the role the work needs (Viewer to read, Editor
   to change dashboards and alerting, Admin for data sources and permissions).
   **Add service account token**, copy the `glsa_…` value.
2. Configure this package (control panel → Configure, or `configure_package`):

| Key | Required | Meaning |
|---|---|---|
| `url` | yes | `https://<stack>.grafana.net` for Grafana Cloud, `http://localhost:3000` for local. A sub-path (`https://host/grafana`) is fine. |
| `token` | yes (secret) | The service account token. |
| `namespace` | no | For app-platform `/apis/...` calls via `grafana_request`: `default` (the default) on self-hosted, `stacks-<stack id>` on Grafana Cloud. |
| `orgId` | no | Sends `X-Grafana-Org-Id`. Rarely needed: a service account belongs to one org. |
| `timeoutMs` | no | Per-request timeout, default 30000, clamped 5000–120000. |

As a file layer, for an installation-wide default:

```json
{ "packages": { "@bitmuse/grafana": { "url": "https://myorg.grafana.net", "token": "${GRAFANA_TOKEN}" } } }
```

Then `grafana_health` tells you whether it all works.

## Things that trip people up

**Two kinds of Grafana token.** A `glsa_…` *service account token* is for
an instance's HTTP API, which is what this package speaks. A `glc_…` *Cloud
access policy token* is for the Grafana Cloud API (stack management, metrics
push) and is rejected with 401 here.

**`overwrite` is off by default.** `grafana_dashboard_save` on an existing uid
or title without `overwrite: true` gets a 412. This is Grafana's own guard and
the tool keeps it: read, then save with overwrite when you mean to replace.

**Provisioned resources are locked in the UI.** Alerting-provisioning writes
mark the resource as provisioned by "api", after which the Grafana UI refuses
to edit it. The tools send `X-Disable-Provenance: true` by default so people
can still use the UI; pass `disable_provenance: false` if you *want* the
lock. Rule groups cannot mix provisioned and unprovisioned rules.

**The notification policy tree is one object.** `PUT /policies` replaces all
of it. Read it, edit the JSON, write the whole thing back.

**Dashboard permissions replace, not add.** `items` is the full new list.

**File-provisioned dashboards** (`meta.provisioned: true` in the summary)
refuse API saves; the file is the source of truth.

## Design notes

**Legacy `/api` routes, on purpose.** Grafana is moving to Kubernetes-style
`/apis/<group>.grafana.app/v1/namespaces/<ns>/…` routes, but the legacy ones
still work on every supported version and on Grafana Cloud, need no namespace,
and return the shapes people know (`dashboard` + `meta`). The new routes are
reachable through `grafana_request` with `{namespace}` substituted from config.

**Edit-in-place for dashboards and rules.** Sending a whole dashboard model to
change one title is expensive for the model and error-prone. `set` takes
`path → value` (`"panels[2].title"`, `"time.from"`, `null` deletes), and the
tool fetches, edits and saves. The full-model path is still there.

**Merge on update.** `PUT` on a data source, alert rule or contact point wants
the whole object, and a missing field means "blank it". The save tools fetch
the stored object and merge the given fields over it, one level deep for
`jsonData` and `settings`.

**Never the token.** `env.config.token` is read once in `client.js` into a
local used only for the `Authorization` header. Errors are built from
Grafana's status and message. `grafana_request` drops any `Authorization`
header a caller passes.

**Output is for the model.** Lists are one line per item with the uid on it;
JSON is cut at 18 000 characters with a note saying so; a list that hits its
limit says how to get the rest instead of pretending it was everything.

**Arguments may arrive as strings.** The tool host sometimes passes `"1"` for
an integer and `"true"` for a boolean. Grafana's JSON binder rejects a string
where it wants an int64 (`400 bad request data` on `panelId`), so every
integer, boolean and list argument goes through `intArg` / `boolArg` /
`listArg` in `client.js` before it reaches a request. Lists also accept
`"a, b"` and `'["a","b"]'`.

## Verified against

Grafana Cloud 13.3.0 (2026-09-25): every read tool; folder create/rename;
dashboard create, edit-in-place (`set`, `panels_add`), versions, permissions,
delete; annotations create/list/delete; contact point create/merge-update/
delete; alert rule create/merge-update/delete, rule group read, yaml export;
mute timing and template create/read/delete; policy tree replace and reset;
`grafana_request` against `/apis/folder.grafana.app` with the stack namespace.
`grafana_query` returned well-formed empty frames because the stack had no
samples yet; not verified with data.

## Development

`package.json` is generated: edit `manifest.mjs` and run `node manifest.mjs`.
`node test.smoke.mjs` runs the mocked-fetch tests; no Grafana needed.

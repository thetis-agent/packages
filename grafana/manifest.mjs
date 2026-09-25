// Generates package.json. Run: node manifest.mjs  (from this directory)
// The tool descriptions live here as JS so they can be edited without fighting
// JSON escaping; the output file is what the kernel reads.
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const S = (description, extra = {}) => ({ type: "string", description, ...extra });
const B = (description) => ({ type: "boolean", description });
const I = (description, extra = {}) => ({ type: "integer", description, ...extra });
const O = (description) => ({ type: "object", description, additionalProperties: true });
const A = (description, items = { type: "string" }) => ({ type: "array", description, items });
const obj = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });

const UID = S("The resource's uid, as shown by the list/search tools.");
const EXPORT_FORMAT = S("Export format: yaml (default), json or hcl (Terraform).", { enum: ["yaml", "json", "hcl"] });
const DISABLE_PROVENANCE = B(
  "Send X-Disable-Provenance so the resource stays editable in the Grafana UI afterwards. Defaults to true. Set false to mark it as API-provisioned and lock it in the UI."
);

const tools = [
  {
    name: "grafana_health",
    description:
      "Check the configured Grafana instance: version, database health, whether the token works and which org it sees, and the app-platform namespace this package is configured with. Call this first when anything else fails.",
    parameters: obj({}),
    export: "grafanaHealth",
  },
  {
    name: "grafana_search",
    description:
      "Find dashboards and folders by title, tag, folder or starred state. The discovery tool: start here to get a uid, since every other dashboard tool takes uids. Each hit shows kind, title, uid, folder and a UI link.",
    parameters: obj({
      query: S("Text matched against titles. Omit to list everything."),
      type: S("Only dashboards or only folders. Omit for both.", { enum: ["dashboard", "folder"] }),
      tags: A("Only dashboards carrying every one of these tags."),
      folder_uids: A("Only items inside these folders."),
      dashboard_uids: A("Only these dashboard uids (a cheap way to resolve uids to titles)."),
      starred: B("Only dashboards the token's user has starred."),
      limit: I("Results per page, 1-5000. Defaults to 50."),
      page: I("Page number, starting at 1, when there are more results than the limit."),
    }),
    export: "grafanaSearch",
  },
  {
    name: "grafana_dashboard_get",
    description:
      "Read a dashboard by uid. By default returns a compact summary: folder, tags, time range, variables, and every panel with its id, type, title, datasource and query expressions. Pass full=true for the entire JSON model (what grafana_dashboard_save takes), or panel_id for one panel's JSON.",
    parameters: obj(
      {
        uid: S("The dashboard uid, from grafana_search or the /d/<uid>/ part of its URL."),
        full: B("Return the whole dashboard JSON model plus meta instead of the summary."),
        panel_id: I("Return only this panel's JSON (ids are in the summary)."),
      },
      ["uid"]
    ),
    export: "grafanaDashboardGet",
  },
  {
    name: "grafana_dashboard_save",
    description:
      "Create or update a dashboard. Two ways: give `dashboard` (a full JSON model — id null and uid null create a new one) or give `uid` plus small edits (`set` paths, `panels_add`, `panels_remove`) and the stored model is fetched, edited and written back. Set overwrite=true to update an existing dashboard; without it Grafana refuses with 412 when the uid or title already exists. Returns uid, version and URL.",
    parameters: obj({
      dashboard: O("The complete dashboard JSON model to save. Omit when editing by uid."),
      uid: S("Dashboard to edit in place (fetched first), or the uid to give a new dashboard."),
      title: S("Set or change the title."),
      folder_uid: S("Folder to save into. Empty string moves it to the root. When editing, the current folder is kept unless given."),
      set: O('Path → value edits applied to the model before saving, e.g. {"time.from": "now-6h", "panels[0].title": "CPU", "refresh": "30s"}. A null value deletes the key (or splices the array element).'),
      panels_add: { description: "One panel object or an array of them to append to `panels`. Ids are assigned when missing or clashing.", anyOf: [{ type: "object", additionalProperties: true }, { type: "array", items: { type: "object", additionalProperties: true } }] },
      panels_remove: A("Panel ids to remove (rows included).", { type: "integer" }),
      overwrite: B("Overwrite an existing dashboard with the same uid or title. Defaults to false."),
      message: S("A commit message for the dashboard's version history."),
    }),
    export: "grafanaDashboardSave",
  },
  {
    name: "grafana_dashboard_delete",
    description: "Delete a dashboard by uid. Irreversible except through the version history of a re-created dashboard with the same uid, so read it with grafana_dashboard_get full=true first if it matters.",
    parameters: obj({ uid: UID }, ["uid"]),
    export: "grafanaDashboardDelete",
  },
  {
    name: "grafana_dashboard_versions",
    description: "List a dashboard's saved versions (who, when, commit message), read one version's full model, or restore a previous version. Restoring creates a new version; nothing is lost.",
    parameters: obj(
      {
        uid: UID,
        version: I("Read this version's full JSON instead of listing."),
        restore_version: I("Restore the dashboard to this version."),
        limit: I("How many versions to list, 1-1000. Defaults to 20."),
        start: I("Offset into the version list for paging."),
      },
      ["uid"]
    ),
    export: "grafanaDashboardVersions",
  },
  {
    name: "grafana_dashboard_permissions",
    description: "Read a dashboard's explicit permissions, or replace them. With `items` the whole permission list is REPLACED: anything not listed is removed. Permission levels: 1 View, 2 Edit, 4 Admin. Each item names exactly one of role (Viewer/Editor), teamId or userId.",
    parameters: obj(
      {
        uid: UID,
        items: A('The full new permission list, e.g. [{"role":"Viewer","permission":1},{"teamId":3,"permission":2},{"userId":11,"permission":4}].', { type: "object", additionalProperties: true }),
      },
      ["uid"]
    ),
    export: "grafanaDashboardPermissions",
  },
  {
    name: "grafana_folder_list",
    description: "List folders (top level, or the children of parent_uid when nested folders are on), or read one folder by uid with its version and permissions metadata.",
    parameters: obj({
      uid: S("Read this one folder instead of listing."),
      parent_uid: S("List the subfolders of this folder."),
      limit: I("Folders per page, 1-1000. Defaults to 100."),
      page: I("Page number, starting at 1."),
    }),
    export: "grafanaFolderList",
  },
  {
    name: "grafana_folder_save",
    description: "Create a folder, or rename/move one that exists. With a uid that exists the folder is updated (title, parent); with a new or absent uid a folder is created. Nested folders need the nestedFolders feature, which Grafana Cloud has on.",
    parameters: obj(
      {
        title: S("The folder title."),
        uid: S("Uid of the folder to update, or the uid to give a new folder. Omit to let Grafana generate one."),
        parent_uid: S("Parent folder uid for a nested folder. Empty string moves it to the root."),
        overwrite: B("When updating, ignore a version mismatch. Defaults to false."),
      },
      ["title"]
    ),
    export: "grafanaFolderSave",
  },
  {
    name: "grafana_folder_delete",
    description: "Delete a folder AND every dashboard, subfolder and library panel in it. Grafana refuses when the folder holds alert rules unless force_delete_rules is true. Check with grafana_search folder_uids=[uid] first.",
    parameters: obj({ uid: UID, force_delete_rules: B("Also delete the alert rules in the folder. Defaults to false.") }, ["uid"]),
    export: "grafanaFolderDelete",
  },
  {
    name: "grafana_datasource_list",
    description: "List data sources (name, uid, type, url, default), read one by uid, or run its health check. Secrets (secureJsonData) are never returned by Grafana; only which secure keys are set.",
    parameters: obj({
      uid: S("Read this one data source instead of listing."),
      health: B("With uid: run the data source's health check and report the result."),
    }),
    export: "grafanaDatasourceList",
  },
  {
    name: "grafana_datasource_save",
    description: "Create a data source, or update one by uid. On update the given fields are merged over the stored data source (jsonData one level deep) so a partial edit does not blank the rest. Secrets go in secureJsonData and are write-only. Common types: prometheus, loki, tempo, postgres, mysql, cloudwatch, grafana-testdata-datasource.",
    parameters: obj(
      {
        uid: S("Data source to update. Omit to create."),
        datasource: O('The data source fields: { "name", "type", "url", "access": "proxy", "isDefault", "basicAuth", "basicAuthUser", "jsonData": {...}, "secureJsonData": {...} }.'),
      },
      ["datasource"]
    ),
    export: "grafanaDatasourceSave",
  },
  {
    name: "grafana_datasource_delete",
    description: "Delete a data source by uid. Panels and alert rules that reference it will show errors afterwards.",
    parameters: obj({ uid: UID }, ["uid"]),
    export: "grafanaDatasourceDelete",
  },
  {
    name: "grafana_query",
    description:
      "Run a query against a data source through Grafana (POST /api/ds/query) and see the result as data frames: field names, row counts and the last few rows. The way to check that a panel's query returns what you think before saving it, or to read a metric without a dashboard. Give `expr` for a single PromQL/LogQL string, or `queries` for full query models (SQL uses rawSql, format).",
    parameters: obj(
      {
        datasource_uid: S("The data source to query, from grafana_datasource_list."),
        expr: S("A single query expression (PromQL, LogQL, …) run as refId A."),
        queries: A("Full query model objects instead of expr, e.g. [{\"refId\":\"A\",\"rawSql\":\"select 1\",\"format\":\"table\"}]. datasource and refId are filled in when missing.", { type: "object", additionalProperties: true }),
        from: S("Range start: Grafana relative time (now-1h, default) or epoch ms."),
        to: S("Range end: now (default) or epoch ms."),
        max_data_points: I("Points per series, 1-10000. Defaults to 100."),
        raw: B("Return Grafana's raw JSON response instead of the frame summary."),
      },
      ["datasource_uid"]
    ),
    export: "grafanaQuery",
  },
  {
    name: "grafana_annotation_list",
    description: "List annotations: org-wide or on one dashboard/panel, in a time range, filtered by tags. Each line has the id the update/delete tools take.",
    parameters: obj({
      from: S("Range start as epoch ms or ISO date. Defaults to whatever Grafana defaults to (recent)."),
      to: S("Range end as epoch ms or ISO date."),
      dashboard_uid: S("Only annotations on this dashboard."),
      panel_id: I("Only annotations on this panel (with dashboard_uid)."),
      tags: A("Only annotations carrying all of these tags."),
      type: S("alert for alert state changes, annotation for manual ones.", { enum: ["alert", "annotation"] }),
      limit: I("Max results, 1-1000. Defaults to 50."),
    }),
    export: "grafanaAnnotationList",
  },
  {
    name: "grafana_annotation_create",
    description: "Create an annotation: a point or a range in time with text and tags, on one dashboard panel or org-wide (no dashboard_uid) so every dashboard with an annotation query for those tags shows it. Deploy markers, incidents, experiments.",
    parameters: obj(
      {
        text: S("The annotation text. Markdown-ish; links render."),
        tags: A("Tags, which is how org-wide annotations are matched onto dashboards."),
        time: S("Start, epoch ms or ISO. Defaults to now."),
        time_end: S("End, epoch ms or ISO, for a region annotation."),
        dashboard_uid: S("Pin to this dashboard. Omit for org-wide."),
        panel_id: I("Pin to this panel (with dashboard_uid)."),
      },
      ["text"]
    ),
    export: "grafanaAnnotationCreate",
  },
  {
    name: "grafana_annotation_update",
    description: "Change an annotation's text, tags or time. Only the fields given change.",
    parameters: obj(
      {
        id: I("The annotation id from grafana_annotation_list."),
        text: S("New text."),
        tags: A("New tag list (replaces)."),
        time: S("New start, epoch ms or ISO."),
        time_end: S("New end, epoch ms or ISO."),
      },
      ["id"]
    ),
    export: "grafanaAnnotationUpdate",
  },
  {
    name: "grafana_annotation_delete",
    description: "Delete an annotation by id.",
    parameters: obj({ id: I("The annotation id.") }, ["id"]),
    export: "grafanaAnnotationDelete",
  },
  {
    name: "grafana_alert_rule_list",
    description: "List Grafana-managed alert and recording rules grouped by folder/rule group, read one rule's full JSON by uid, or export rules in provisioning-file format. The full JSON of an existing rule is the best template for a new one.",
    parameters: obj({
      uid: S("Read this one rule instead of listing."),
      folder_uid: S("Only rules in this folder."),
      group: S("Only rules in this rule group (with folder_uid)."),
      export: B("Return the provisioning-file export instead (yaml by default)."),
      export_format: EXPORT_FORMAT,
    }),
    export: "grafanaAlertRuleList",
  },
  {
    name: "grafana_alert_rule_save",
    description:
      "Create or update a Grafana-managed alert rule or recording rule. With a uid that exists, `rule` fields (and `set` paths) are merged over the stored rule; otherwise a rule is created and needs title, ruleGroup, folderUID, data[] and condition (alert) or record (recording). Pausing: set {\"isPaused\": true}. All rules in a group share the group's evaluation interval (grafana_alert_rule_group).",
    parameters: obj(
      {
        uid: S("Rule to update, or the uid to give a new rule."),
        rule: O('ProvisionedAlertRule fields: { "title", "ruleGroup", "folderUID", "condition": "C", "data": [ {refId, datasourceUid, relativeTimeRange:{from,to}, model:{...}}, ... ], "for": "5m", "keepFiringFor", "noDataState": "NoData|OK|Alerting", "execErrState": "Error|OK|Alerting", "labels": {}, "annotations": {"summary": ...}, "isPaused", "record": {"metric","from"}, "notification_settings": {"receiver": ...} }.'),
        set: O('Path → value edits applied before saving, e.g. {"for": "10m", "labels.severity": "critical", "data[0].model.expr": "up == 0"}.'),
        disable_provenance: DISABLE_PROVENANCE,
      },
      ["rule"]
    ),
    export: "grafanaAlertRuleSave",
  },
  {
    name: "grafana_alert_rule_delete",
    description: "Delete a Grafana-managed alert rule by uid.",
    parameters: obj({ uid: UID }, ["uid"]),
    export: "grafanaAlertRuleDelete",
  },
  {
    name: "grafana_alert_rule_group",
    description: "Read a rule group (its evaluation interval and rules), change its interval, replace its rule list wholesale, or delete the group with every rule in it. The interval is per group: a rule's `for` must be a multiple of it.",
    parameters: obj(
      {
        folder_uid: S("The folder the group lives in."),
        group: S("The rule group name."),
        interval: I("New evaluation interval in seconds (e.g. 60). Must be a multiple of the instance's min interval, usually 10)."),
        rules: A("Replace the group's rules with this array of ProvisionedAlertRule objects.", { type: "object", additionalProperties: true }),
        delete: B("Delete the whole group and its rules."),
        disable_provenance: DISABLE_PROVENANCE,
      },
      ["folder_uid", "group"]
    ),
    export: "grafanaAlertRuleGroup",
  },
  {
    name: "grafana_contact_point_list",
    description: "List contact points (name, uid, integration type), read one by name with its settings, or export them in provisioning format. Secret settings come back redacted unless decrypt=true on an export (needs admin).",
    parameters: obj({
      name: S("Only the contact point(s) with this name; returns full settings."),
      export: B("Return the provisioning-file export instead."),
      export_format: EXPORT_FORMAT,
      decrypt: B("With export: include decrypted secrets. Admin only."),
    }),
    export: "grafanaContactPointList",
  },
  {
    name: "grafana_contact_point_save",
    description: "Create a contact point integration, or update one by uid (fields merged over the stored one, settings one level deep). Types: email, slack, pagerduty, opsgenie, webhook, teams, discord, telegram, googlechat, victorops, pushover, sns, oncall, … Settings keys follow the type: email {addresses}, slack {url or token+recipient}, webhook {url, httpMethod}, pagerduty {integrationKey}.",
    parameters: obj(
      {
        uid: S("Integration to update. Omit to create."),
        contact_point: O('{ "name": "ops-slack", "type": "slack", "settings": {"url": "https://hooks.slack.com/..."}, "disableResolveMessage": false }'),
        disable_provenance: DISABLE_PROVENANCE,
      },
      ["contact_point"]
    ),
    export: "grafanaContactPointSave",
  },
  {
    name: "grafana_contact_point_delete",
    description: "Delete a contact point integration by uid. Refused while a notification policy still routes to it.",
    parameters: obj({ uid: UID }, ["uid"]),
    export: "grafanaContactPointDelete",
  },
  {
    name: "grafana_notification_policies",
    description: "Read the notification policy tree (which alerts go to which contact point, grouping, timings), replace it wholesale with `tree`, export it, or reset it to the default. There is one tree per org and PUT replaces all of it, so read first, edit the JSON, write back.",
    parameters: obj({
      tree: O('The whole policy tree: { "receiver": "default-email", "group_by": ["grafana_folder","alertname"], "group_wait": "30s", "group_interval": "5m", "repeat_interval": "4h", "routes": [ { "receiver": "ops-slack", "object_matchers": [["severity","=","critical"]], "continue": false, "mute_time_intervals": [] } ] }'),
      reset: B("Reset the tree to Grafana's default and unlock it for UI editing."),
      export: B("Return the provisioning-file export instead."),
      export_format: EXPORT_FORMAT,
      disable_provenance: DISABLE_PROVENANCE,
    }),
    export: "grafanaNotificationPolicies",
  },
  {
    name: "grafana_mute_timings",
    description: "Mute timings: list, get one by name, create/replace (save), delete, or export. A mute timing is a named set of time intervals that notification policies reference by name to silence alerts on a schedule.",
    parameters: obj({
      action: S("What to do. Inferred when omitted: mute_timing → save, name → get, else list.", { enum: ["list", "get", "save", "delete", "export"] }),
      name: S("The mute timing name."),
      mute_timing: O('{ "name": "weekends", "time_intervals": [ { "weekdays": ["saturday","sunday"], "times": [{"start_time":"00:00","end_time":"24:00"}], "location": "UTC" } ] }'),
      export_format: EXPORT_FORMAT,
      disable_provenance: DISABLE_PROVENANCE,
    }),
    export: "grafanaMuteTimings",
  },
  {
    name: "grafana_templates",
    description: "Notification message templates (Go templating): list, read one, create/replace by name with the template text, or delete. Contact points reference a template with {{ template \"name\" . }} in their message settings.",
    parameters: obj({
      action: S("What to do. Inferred when omitted: template → save, name → get, else list.", { enum: ["list", "get", "save", "delete"] }),
      name: S("The template group name."),
      template: S('The template text, e.g. {{ define "my.title" }}[{{ .Status }}] {{ .CommonLabels.alertname }}{{ end }}'),
      disable_provenance: DISABLE_PROVENANCE,
    }),
    export: "grafanaTemplates",
  },
  {
    name: "grafana_request",
    description:
      "Call any Grafana HTTP API endpoint with the configured URL and token, for what the other tools do not cover: teams (/api/teams/search), users, orgs, service accounts, library panels (/api/library-elements), playlists, snapshots, preferences, RBAC, and the app-platform /apis/<group>/v1/namespaces/{namespace}/... routes ({namespace} is substituted from config). Returns the JSON reply.",
    parameters: obj(
      {
        method: S("HTTP method. Defaults to GET.", { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }),
        path: S("The path, starting with /api/ or /apis/, e.g. /api/teams/search or /apis/folder.grafana.app/v1/namespaces/{namespace}/folders."),
        query: O("Query string parameters."),
        body: O("JSON request body for POST/PUT/PATCH."),
        headers: O("Extra request headers (Authorization is never overridable)."),
      },
      ["path"]
    ),
    export: "grafanaRequest",
  },
];

const config = {
  url: {
    type: "string",
    required: true,
    help: "Base URL of the Grafana instance, e.g. https://myorg.grafana.net (Grafana Cloud) or http://localhost:3000. No trailing path beyond a sub-path Grafana is served under.",
  },
  token: {
    type: "string",
    secret: true,
    required: true,
    help: "A service account token (glsa_…) from Administration → Users and access → Service accounts, with the role the tasks need. Every grafana_* tool reads it.",
  },
  namespace: {
    type: "string",
    default: "default",
    help: "Namespace for the app-platform /apis routes used by grafana_request: `default` on self-hosted, `stacks-<stack id>` on Grafana Cloud.",
  },
  orgId: {
    type: "string",
    help: "Send X-Grafana-Org-Id to act in this organisation. Leave unset for the service account's own org (service accounts belong to one org anyway).",
  },
  timeoutMs: {
    type: "number",
    default: 30000,
    help: "Per-request timeout in milliseconds, clamped to 5000-120000.",
  },
};

const dir = new URL(".", import.meta.url).pathname;
const existing = existsSync(`${dir}package.json`) ? JSON.parse(readFileSync(`${dir}package.json`, "utf8")) : {};

const manifest = {
  name: "@bitmuse/grafana",
  version: existing.version ?? "0.1.0",
  description:
    "Grafana's HTTP API as tools: search, read, save and version dashboards, manage folders, data sources, annotations, alert rules, contact points, notification policies, mute timings and templates, run queries, and call any other endpoint, against one configured Grafana Cloud stack or self-hosted instance.",
  keywords: ["grafana", "dashboards", "alerting", "observability", "monitoring", "prometheus", "loki"],
  license: "MIT",
  type: "module",
  main: "index.js",
  scripts: { test: "node test.smoke.mjs" },
  thetis: {
    type: "tool",
    toolGroup: {
      id: "grafana",
      brief: "Read and edit Grafana dashboards, folders, data sources, annotations and alerting over the HTTP API.",
      tags: ["grafana", "dashboard", "dashboards", "alert rule", "alert rules", "contact point", "notification policy", "mute timing", "datasource", "data source", "annotation", "panel", "promql", "loki", "prometheus"],
    },
    tools,
    config,
  },
};

writeFileSync(`${dir}package.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote package.json: ${tools.length} tools, ${Object.keys(config).length} config keys, version ${manifest.version}`);

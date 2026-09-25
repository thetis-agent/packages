import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as g from "./client.js";
import * as tools from "./tools.js";
import * as index from "./index.js";

const TOKEN = "glsa_secret_token_xyz";
const env = { config: { url: "https://myorg.grafana.net/", token: TOKEN, namespace: "stacks-123" } };

// --- manifest ↔ exports ----------------------------------------------------
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
for (const t of pkg.thetis.tools) {
  assert.equal(typeof index[t.export], "function", `export ${t.export} for ${t.name}`);
  assert.ok(t.description.length > 20, `${t.name} has a description`);
  assert.equal(t.parameters.type, "object");
}
assert.equal(pkg.thetis.config.token.secret, true);
assert.equal(pkg.thetis.config.url.required, true);
console.log(`manifest: ${pkg.thetis.tools.length} tools wired: ok`);

// --- createClient guards ------------------------------------------------------
assert.throws(() => g.createClient({}), /no Grafana URL configured/);
assert.throws(() => g.createClient({ url: "https://x.grafana.net" }), /no Grafana token configured/);
assert.throws(() => g.createClient({ url: "ftp://x", token: "t" }), /http\(s\)/);
const c = g.createClient(env.config);
assert.equal(c.baseUrl, "https://myorg.grafana.net");
assert.equal(c.apis("folder.grafana.app"), "/apis/folder.grafana.app/v1/namespaces/stacks-123");
console.log("createClient guards: ok");

// --- setPath ------------------------------------------------------------------
const d = { panels: [{ id: 1, title: "a" }, { id: 2, title: "b" }], time: { from: "now-1h" } };
tools.setPath(d, "panels[1].title", "B");
tools.setPath(d, "time.from", "now-6h");
tools.setPath(d, "refresh", "30s");
tools.setPath(d, "panels[0]", null);
assert.deepEqual(d, { panels: [{ id: 2, title: "B" }], time: { from: "now-6h" }, refresh: "30s" });
console.log("setPath: ok");

// --- mocked fetch harness ------------------------------------------------------
const realFetch = globalThis.fetch;
let calls = [];
function mock(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: init.headers });
    const r = handler({ method: init.method, path: u.pathname, query: u.searchParams, body, headers: init.headers });
    if (r && typeof r.status === "number") return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
    return { status: 200, text: async () => JSON.stringify(r) };
  };
}

// --- search --------------------------------------------------------------------
mock(({ path, query }) => {
  assert.equal(path, "/api/search");
  assert.equal(query.get("type"), "dash-db");
  assert.deepEqual(query.getAll("tag"), ["prod", "api"]);
  return [
    { type: "dash-db", title: "Prod Overview", uid: "abc", url: "/d/abc/prod", folderTitle: "Ops", folderUid: "f1", tags: ["prod"] },
  ];
});
let out = await tools.search({ query: "prod", type: "dashboard", tags: ["prod", "api"] }, env);
assert.match(out, /dashboard "Prod Overview" uid=abc in folder "Ops" \(f1\)/);
assert.match(out, /https:\/\/myorg\.grafana\.net\/d\/abc\/prod/);
assert.match(out, /that is all of them/);
assert.ok(!out.includes(TOKEN));
console.log("search: ok");

// --- dashboard get summary / panel -------------------------------------------------
const dash = {
  id: 7, uid: "abc", title: "Prod Overview", version: 3, tags: ["prod"],
  time: { from: "now-6h", to: "now" }, refresh: "1m",
  templating: { list: [{ name: "env", type: "query", query: "label_values(env)" }] },
  panels: [
    { id: 1, type: "row", title: "Traffic", panels: [{ id: 2, type: "timeseries", title: "RPS", datasource: { uid: "prom" }, targets: [{ refId: "A", expr: "sum(rate(http_requests_total[5m]))" }] }] },
    { id: 3, type: "stat", title: "Errors", targets: [{ refId: "A", expr: "errors" }] },
  ],
};
mock(({ path }) => {
  assert.equal(path, "/api/dashboards/uid/abc");
  return { dashboard: dash, meta: { url: "/d/abc/prod", folderTitle: "Ops", folderUid: "f1", updated: "2026-09-01", updatedBy: "alice" } };
});
out = await tools.dashboardGet({ uid: "abc" }, env);
assert.match(out, /"Prod Overview" uid=abc version=3/);
assert.match(out, /\$env \(query\)/);
assert.match(out, /#2 timeseries "RPS" ds=prom \(in row "Traffic"\)/);
assert.match(out, /A: sum\(rate/);
out = await tools.dashboardGet({ uid: "abc", panel_id: 3 }, env);
assert.deepEqual(JSON.parse(out), dash.panels[1]);
console.log("dashboard_get: ok");

// --- dashboard save by uid with edits -------------------------------------------------
mock(({ method, path, body }) => {
  if (method === "GET") return { dashboard: structuredClone(dash), meta: { folderUid: "f1" } };
  assert.equal(method, "POST");
  assert.equal(path, "/api/dashboards/db");
  assert.equal(body.folderUid, "f1", "keeps the folder when editing");
  assert.equal(body.overwrite, true);
  assert.equal(body.message, "tweak");
  assert.equal(body.dashboard.refresh, "30s");
  assert.equal(body.dashboard.time.from, "now-24h");
  const ids = body.dashboard.panels.map((p) => p.id);
  assert.deepEqual(ids, [1, 4], "row kept, panel 3 removed, new panel got id 4");
  assert.equal(body.dashboard.panels[1].title, "New");
  return { uid: "abc", version: 4, status: "success", url: "/d/abc/prod" };
});
out = await tools.dashboardSave(
  { uid: "abc", overwrite: true, message: "tweak", set: { refresh: "30s", "time.from": "now-24h" }, panels_add: { type: "text", title: "New" }, panels_remove: [3] },
  env
);
assert.match(out, /saved dashboard "Prod Overview" uid=abc version=4/);
assert.equal(calls.length, 2);
console.log("dashboard_save (edit): ok");

// --- dashboard save new, full model, JSON string accepted ------------------------------
mock(({ method, body }) => {
  assert.equal(method, "POST");
  assert.equal(body.dashboard.id, null);
  assert.equal(body.dashboard.title, "Fresh");
  assert.equal(body.folderUid, "");
  return { uid: "new1", version: 1, status: "success", url: "/d/new1/fresh" };
});
out = await tools.dashboardSave({ dashboard: JSON.stringify({ title: "Fresh", panels: [] }), folder_uid: "" }, env);
assert.match(out, /uid=new1 version=1/);
await assert.rejects(tools.dashboardSave({}, env), /give `dashboard`/);
console.log("dashboard_save (create): ok");

// --- 412 hint --------------------------------------------------------------------------
mock(() => ({ status: 412, body: { message: "A dashboard with the same uid already exists", status: "name-exists" } }));
await assert.rejects(tools.dashboardSave({ dashboard: { title: "Dup" } }, env), (e) => {
  assert.match(e.message, /returned 412/);
  assert.match(e.message, /overwrite/);
  assert.ok(!e.message.includes(TOKEN));
  return true;
});
console.log("error 412 hint, token safety: ok");

// --- 404 on /apis names the namespace ----------------------------------------------------
mock(() => ({ status: 404, body: { kind: "Status", message: "folders.folder.grafana.app \"x\" not found", reason: "NotFound", code: 404 } }));
await assert.rejects(tools.request({ path: "/apis/folder.grafana.app/v1/namespaces/{namespace}/folders/x" }, env), /namespace/);
assert.equal(calls[0].path, "/apis/folder.grafana.app/v1/namespaces/stacks-123/folders/x");
console.log("request + namespace substitution + 404 hint: ok");

// --- request refuses absolute url and strips Authorization override ---------------------------
await assert.rejects(tools.request({ path: "https://evil/api" }, env), /relative/);
mock(({ headers }) => {
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["X-Custom"], "1");
  return { ok: true };
});
await tools.request({ path: "/api/org", headers: { authorization: "Bearer other", "X-Custom": "1" } }, env);
console.log("request header safety: ok");

// --- folder save: update path vs create path -------------------------------------------------
mock(({ method, path, body }) => {
  if (method === "GET") return { status: 404, body: { message: "folder not found" } };
  assert.equal(method, "POST");
  assert.equal(path, "/api/folders");
  assert.deepEqual(body, { uid: "nf", title: "New Folder" });
  return { uid: "nf", title: "New Folder", url: "/dashboards/f/nf/" };
});
out = await tools.folderSave({ uid: "nf", title: "New Folder" }, env);
assert.match(out, /created folder "New Folder" uid=nf/);
mock(({ method, path, body }) => {
  if (method === "GET") return { uid: "f1", title: "Ops", version: 2 };
  assert.equal(method, "PUT");
  assert.equal(path, "/api/folders/f1");
  assert.equal(body.version, 2);
  assert.equal(body.title, "Operations");
  return { uid: "f1", title: "Operations", version: 3, url: "/dashboards/f/f1/" };
});
out = await tools.folderSave({ uid: "f1", title: "Operations" }, env);
assert.match(out, /updated folder "Operations" uid=f1 version=3/);
console.log("folder_save: ok");

// --- datasource update merges, strips secure fields ---------------------------------------
mock(({ method, path, body }) => {
  if (method === "GET") return { id: 5, uid: "prom", name: "Prom", type: "prometheus", url: "http://old", jsonData: { httpMethod: "POST", a: 1 }, secureJsonFields: { basicAuthPassword: true }, password: "" };
  assert.equal(method, "PUT");
  assert.equal(path, "/api/datasources/uid/prom");
  assert.equal(body.url, "http://new");
  assert.deepEqual(body.jsonData, { httpMethod: "POST", a: 1, timeInterval: "15s" });
  assert.equal(body.secureJsonFields, undefined);
  assert.equal(body.password, undefined);
  assert.equal(body.id, 5);
  return { datasource: { uid: "prom", name: "Prom", type: "prometheus" }, message: "Datasource updated" };
});
out = await tools.datasourceSave({ uid: "prom", datasource: { url: "http://new", jsonData: { timeInterval: "15s" } } }, env);
assert.match(out, /updated datasource "Prom" uid=prom/);
console.log("datasource_save (merge): ok");

// --- query formats frames ---------------------------------------------------------------------
mock(({ path, body }) => {
  assert.equal(path, "/api/ds/query");
  assert.equal(body.queries[0].datasource.uid, "prom");
  assert.equal(body.queries[0].expr, "up");
  assert.equal(body.from, "now-1h");
  return {
    results: {
      A: {
        frames: [
          { schema: { name: "up", fields: [{ name: "Time", type: "time" }, { name: "Value", type: "number", labels: { job: "api" } }] }, data: { values: [[1700000000000, 1700000060000], [1, 1]] } },
        ],
      },
    },
  };
});
out = await tools.query({ datasource_uid: "prom", expr: "up" }, env);
assert.match(out, /A: 1 frame\(s\)/);
assert.match(out, /2 rows × 2 fields \[Time:time, Value:number\]/);
assert.match(out, /2023-11-14T22:13:20\.000Z  \|  1/);
console.log("query: ok");

// --- alert rule create sets provenance header and defaults --------------------------------------
mock(({ method, path, body, headers }) => {
  assert.equal(method, "POST");
  assert.equal(path, "/api/v1/provisioning/alert-rules");
  assert.equal(headers["X-Disable-Provenance"], "true");
  assert.equal(body.noDataState, "NoData");
  assert.equal(body.for, "5m");
  assert.equal(body.labels.severity, "critical");
  return { uid: "r1", title: "High errors", folderUID: "f1", ruleGroup: "api" };
});
out = await tools.alertRuleSave(
  { rule: { title: "High errors", ruleGroup: "api", folderUID: "f1", condition: "B", data: [{ refId: "A" }] }, set: { "labels.severity": "critical" } },
  env
);
assert.match(out, /created alert rule "High errors" uid=r1 in f1\/api/);
await assert.rejects(tools.alertRuleSave({ rule: { title: "x", ruleGroup: "g", folderUID: "f" } }, env), /condition/);
console.log("alert_rule_save (create): ok");

// --- alert rule update merges over stored, omits header when asked ------------------------------------
mock(({ method, path, body, headers }) => {
  if (method === "GET") return { uid: "r1", title: "High errors", folderUID: "f1", ruleGroup: "api", for: "5m", data: [{ refId: "A" }], condition: "B", provenance: "api" };
  assert.equal(method, "PUT");
  assert.equal(path, "/api/v1/provisioning/alert-rules/r1");
  assert.equal(headers["X-Disable-Provenance"], undefined);
  assert.equal(body.for, "10m");
  assert.equal(body.isPaused, true);
  assert.equal(body.provenance, undefined);
  assert.deepEqual(body.data, [{ refId: "A" }], "untouched fields survive");
  return { uid: "r1", title: "High errors", folderUID: "f1", ruleGroup: "api", isPaused: true };
});
out = await tools.alertRuleSave({ uid: "r1", rule: { isPaused: true }, set: { for: "10m" }, disable_provenance: false }, env);
assert.match(out, /updated alert rule "High errors" uid=r1 in f1\/api \(paused\)/);
console.log("alert_rule_save (update): ok");

// --- alert rule list groups ------------------------------------------------------------------------
mock(() => [
  { uid: "r1", title: "A", folderUID: "f1", ruleGroup: "g1", for: "5m" },
  { uid: "r2", title: "B", folderUID: "f1", ruleGroup: "g1", record: { metric: "x:rate" } },
  { uid: "r3", title: "C", folderUID: "f2", ruleGroup: "g2", isPaused: true },
]);
out = await tools.alertRuleList({}, env);
assert.match(out, /folder\/group f1\/g1:/);
assert.match(out, /recording → x:rate/);
assert.match(out, /uid=r3 alert for=0s PAUSED/);
assert.match(out, /3 rules in 2 group\(s\)/);
out = await tools.alertRuleList({ folder_uid: "f2" }, env);
assert.ok(!out.includes("uid=r1"));
console.log("alert_rule_list: ok");

// --- policies: put tree, reset --------------------------------------------------------------------
mock(({ method, path, body, headers }) => {
  assert.equal(method, "PUT");
  assert.equal(path, "/api/v1/provisioning/policies");
  assert.equal(headers["X-Disable-Provenance"], "true");
  assert.equal(body.receiver, "default");
  return {};
});
out = await tools.notificationPolicies({ tree: { receiver: "default", routes: [{ receiver: "a", routes: [{ receiver: "b" }] }] } }, env);
assert.match(out, /root receiver "default", 2 nested route\(s\)/);
mock(({ method, path }) => {
  assert.equal(method, "DELETE");
  assert.equal(path, "/api/v1/provisioning/policies");
  return {};
});
out = await tools.notificationPolicies({ reset: true }, env);
assert.match(out, /reset/);
console.log("notification_policies: ok");

// --- mute timings action inference: save → exists → PUT --------------------------------------------------
mock(({ method, path }) => {
  if (method === "GET") return { name: "weekends", time_intervals: [] };
  assert.equal(method, "PUT");
  assert.equal(path, "/api/v1/provisioning/mute-timings/weekends");
  return {};
});
out = await tools.muteTimings({ mute_timing: { name: "weekends", time_intervals: [{ weekdays: ["saturday"] }] } }, env);
assert.match(out, /replaced mute timing "weekends"/);
console.log("mute_timings: ok");

// --- templates save encodes name ----------------------------------------------------------------------
mock(({ method, path, body }) => {
  assert.equal(method, "PUT");
  assert.equal(path, "/api/v1/provisioning/templates/my%20tpl");
  assert.equal(body.template, "{{ define \"x\" }}hi{{ end }}");
  return { name: "my tpl" };
});
out = await tools.templates({ name: "my tpl", template: "{{ define \"x\" }}hi{{ end }}" }, env);
assert.match(out, /saved template "my tpl"/);
console.log("templates: ok");

// --- annotations: time coercion, list rendering -----------------------------------------------------------
mock(({ method, path, body }) => {
  assert.equal(method, "POST");
  assert.equal(path, "/api/annotations");
  assert.equal(body.time, Date.parse("2026-09-25T12:00:00Z"));
  assert.deepEqual(body.tags, ["deploy"]);
  return { id: 42, message: "Annotation added" };
});
out = await tools.annotationCreate({ text: "deployed v2", tags: ["deploy"], time: "2026-09-25T12:00:00Z" }, env);
assert.match(out, /created annotation id=42 at 2026-09-25T12:00:00\.000Z \(org-wide\)/);
mock(({ path, query }) => {
  assert.equal(path, "/api/annotations");
  assert.deepEqual(query.getAll("tags"), ["deploy", "prod"]);
  return [{ id: 42, time: 1758801600000, text: "deployed v2", tags: ["deploy"], dashboardUID: "abc", panelId: 2 }];
});
out = await tools.annotationList({ tags: ["deploy", "prod"] }, env);
assert.match(out, /id=42 .* dashboard=abc panel=2 \[deploy\]: deployed v2/);
console.log("annotations: ok");

// --- health: token failure is reported, not thrown ------------------------------------------------------------
mock(({ path }) => {
  if (path === "/api/health") return { version: "12.1.0", commit: "abc", database: "ok" };
  if (path === "/api/frontend/settings") return { namespace: "stacks-999" };
  return { status: 401, body: { message: "invalid API key" } };
});
out = await tools.health({}, env);
assert.match(out, /version: 12\.1\.0/);
assert.match(out, /token check FAILED: .*401/);
assert.match(out, /glsa_/);
assert.match(out, /configured "stacks-123" but the instance reports "stacks-999"/);
assert.ok(!out.includes(TOKEN));
console.log("health: ok");

// --- integer args arrive as strings ------------------------------------------------------------------------
mock(({ body }) => {
  assert.strictEqual(body.panelId, 7, "panel_id string coerced to a number for Grafana's int64 binder");
  return { id: 1 };
});
await tools.annotationCreate({ text: "x", dashboard_uid: "d", panel_id: "7" }, env);
await assert.rejects(tools.annotationCreate({ text: "x", panel_id: "seven" }, env), /panel_id must be an integer/);
mock(({ method, path }) => {
  assert.equal(method, "DELETE");
  assert.equal(path, "/api/annotations/42");
  return { message: "deleted" };
});
await tools.annotationDelete({ id: "42" }, env);
console.log("integer args as strings: ok");

// --- booleans and lists arrive as strings too ------------------------------------------------------------------
mock(({ query }) => {
  assert.deepEqual(query.getAll("tag"), ["a", "b"]);
  assert.equal(query.get("starred"), "true");
  return [];
});
await tools.search({ tags: "a, b", starred: "true" }, env);
mock(({ query }) => {
  assert.deepEqual(query.getAll("tag"), ["x"]);
  return [];
});
await tools.search({ tags: '["x"]' }, env);
mock(({ method, path, body }) => {
  if (method === "GET") return { dashboard: structuredClone(dash), meta: {} };
  assert.deepEqual(body.dashboard.panels.map((p) => p.id), [1], "panels_remove as a string list");
  assert.equal(body.overwrite, true);
  return { uid: "abc", version: 5, url: "/d/abc" };
});
await tools.dashboardSave({ uid: "abc", panels_remove: "3", overwrite: "true" }, env);
mock(({ method, path, headers }) => {
  assert.equal(method, "DELETE");
  assert.equal(path, "/api/v1/provisioning/folder/f/rule-groups/g");
  return {};
});
await tools.alertRuleGroup({ folder_uid: "f", group: "g", delete: "true" }, env);
console.log("boolean/list args as strings: ok");

// --- invalid namespace 403 gets its own hint ----------------------------------------------------------------
mock(() => ({ status: 403, body: { message: "invalid namespace", messageId: "authn.invalid-namespace" } }));
await assert.rejects(tools.request({ path: "/apis/folder.grafana.app/v1/namespaces/{namespace}/folders" }, env), /stacks-<stack id>/);
console.log("invalid namespace hint: ok");

// --- non-JSON body is returned raw (exports) -------------------------------------------------------------
mock(() => ({ status: 200, body: "apiVersion: 1\ngroups: []\n" }));
out = await tools.alertRuleList({ export: true }, env);
assert.equal(out, "apiVersion: 1\ngroups: []\n");
assert.equal(calls[0].query.format, "yaml");
console.log("export raw yaml: ok");

globalThis.fetch = realFetch;
console.log("ALL OK");

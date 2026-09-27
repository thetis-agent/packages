// Smoke test: a tiny in-memory Vikunja standing in for the real one behind
// fetch, and the tools driven through the same (args, env) interface the
// kernel uses. Run: node test.smoke.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as v from "./client.js";
import * as tools from "./tools.js";
import * as index from "./index.js";

const TOKEN = "tk_secret_token_xyz";
const env = { config: { url: "http://vikunja.local:3456/", token: TOKEN } };

// --- manifest ↔ exports --------------------------------------------------------
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
for (const t of pkg.thetis.tools) {
  assert.equal(typeof index[t.export], "function", `export ${t.export} for ${t.name}`);
  assert.ok(t.description.length > 20, `${t.name} has a description`);
  assert.equal(t.parameters.type, "object");
}
assert.equal(pkg.thetis.config.token.secret, true);
assert.equal(pkg.thetis.config.url.required, true);
console.log(`manifest: ${pkg.thetis.tools.length} tools wired: ok`);

// --- createClient guards -------------------------------------------------------
assert.throws(() => v.createClient({}), /no Vikunja URL configured/);
assert.throws(() => v.createClient({ url: "http://x" }), /no Vikunja API token configured/);
assert.throws(() => v.createClient({ url: "ftp://x", token: "t" }), /http\(s\)/);
assert.equal(v.createClient(env.config).apiUrl, "http://vikunja.local:3456/api/v1");
assert.equal(v.createClient({ url: "https://t.example.com/api/v1/", token: "t" }).apiUrl, "https://t.example.com/api/v1");
console.log("createClient guards: ok");

// --- helpers -------------------------------------------------------------------
assert.equal(v.dateArg("", "d"), "0001-01-01T00:00:00Z");
assert.match(v.dateArg("2026-10-01", "d"), /^2026-10-01T00:00:00/);
assert.match(v.dateArg("+3d", "d"), /^\d{4}-/);
assert.throws(() => v.dateArg("whenever", "d"), /ISO 8601/);
assert.equal(v.stripHtml("<p>Hello <b>world</b></p><p>two</p>"), "Hello world\ntwo");
assert.equal(v.toHtml("a\nb\n\nc"), "<p>a<br>b</p><p>c</p>");
assert.equal(v.toHtml("<p>x</p>"), "<p>x</p>");
console.log("helpers: ok");

// --- an in-memory Vikunja --------------------------------------------------------
const db = {
  projects: [
    { id: 1, title: "Website", identifier: "WEB", parent_project_id: 0 },
    { id: 2, title: "Backend", identifier: "API", parent_project_id: 1 },
    { id: 3, title: "Old stuff", is_archived: true, parent_project_id: 0 },
  ],
  views: [
    { id: 10, project_id: 1, title: "List", view_kind: "list", position: 100 },
    { id: 11, project_id: 1, title: "Kanban", view_kind: "kanban", position: 400, bucket_configuration_mode: "manual", done_bucket_id: 103, default_bucket_id: 101 },
    { id: 20, project_id: 2, title: "List", view_kind: "list", position: 100 },
  ],
  buckets: [
    { id: 101, project_view_id: 11, title: "To-Do", position: 1, limit: 0 },
    { id: 102, project_view_id: 11, title: "Doing", position: 2, limit: 2 },
    { id: 103, project_view_id: 11, title: "Done", position: 3, limit: 0 },
  ],
  tasks: [
    { id: 1, project_id: 1, title: "Fix header", done: false, priority: 3, due_date: "2026-10-01T23:59:00Z", labels: [{ id: 5, title: "bug", hex_color: "ff0000" }], assignees: [], description: "<p>The <b>header</b> wraps.</p>", position: 65536 },
    { id: 2, project_id: 1, title: "Write copy", done: false, priority: 0, due_date: "0001-01-01T00:00:00Z", labels: [], assignees: [{ id: 7, username: "alice", name: "Alice" }], description: "", position: 131072 },
    { id: 3, project_id: 1, title: "Ship v1", done: true, priority: 0, due_date: "0001-01-01T00:00:00Z", labels: [], assignees: [], description: "", done_at: "2026-09-01T10:00:00Z", position: 65536 },
    { id: 4, project_id: 2, title: "Rotate keys", done: false, priority: 4, due_date: "0001-01-01T00:00:00Z", labels: [], assignees: [], description: "", position: 65536 },
  ],
  taskBuckets: { 1: { 11: 101 }, 2: { 11: 102 }, 3: { 11: 103 } },
  labels: [{ id: 5, title: "bug", hex_color: "ff0000" }, { id: 6, title: "design" }],
  users: [{ id: 7, username: "alice", name: "Alice" }, { id: 8, username: "bob", name: "Bob" }],
  comments: { 1: [{ id: 900, author: { id: 7, username: "alice" }, comment: "<p>on it</p>", created: "2026-09-20T09:00:00Z" }] },
  nextId: 1000,
};
const calls = [];
const err = (status, code, message) => ({ status, body: { code, message } });

function route(method, path, query, body) {
  let m;
  calls.push(`${method} ${path}${query.toString() ? `?${query}` : ""}`);
  if (path === "/info") return { version: "v1.24.6", frontend_url: "http://vikunja.local:3456/", max_items_per_page: 50, link_sharing_enabled: true };
  if (path === "/user") return db.users[0];
  if (path === "/users") return db.users.filter((u) => !query.get("s") || u.username.includes(query.get("s")) || (u.name || "").toLowerCase().includes(query.get("s").toLowerCase()));

  if (path === "/projects" && method === "GET") {
    let list = db.projects.filter((p) => query.get("is_archived") === "true" || !p.is_archived);
    if (query.get("s")) list = list.filter((p) => p.title.toLowerCase().includes(query.get("s").toLowerCase()));
    return { status: 200, headers: { "x-pagination-total-pages": "1", "x-pagination-result-count": String(list.length) }, body: list };
  }
  if (path === "/projects" && method === "PUT") {
    const p = { id: db.nextId++, parent_project_id: 0, ...body };
    db.projects.push(p);
    for (const [k, i] of [["List", "list"], ["Kanban", "kanban"]]) db.views.push({ id: db.nextId++, project_id: p.id, title: k, view_kind: i, bucket_configuration_mode: i === "kanban" ? "manual" : undefined });
    return p;
  }
  if ((m = /^\/projects\/(\d+)$/.exec(path))) {
    const p = db.projects.find((x) => x.id === Number(m[1]));
    if (!p) return err(404, 3001, "This project does not exist.");
    if (method === "GET") return { ...p, views: db.views.filter((vw) => vw.project_id === p.id) };
    if (method === "POST") return Object.assign(p, body);
    if (method === "DELETE") { db.projects = db.projects.filter((x) => x !== p); return {}; }
  }
  if ((m = /^\/projects\/(\d+)\/projectusers$/.exec(path))) return db.users.filter((u) => !query.get("s") || u.username.includes(query.get("s")) || (u.name || "").toLowerCase().includes(query.get("s").toLowerCase()));
  if ((m = /^\/projects\/(\d+)\/views$/.exec(path))) {
    if (method === "GET") return db.views.filter((vw) => vw.project_id === Number(m[1]));
    if (method === "PUT") { const vw = { id: db.nextId++, project_id: Number(m[1]), ...body }; db.views.push(vw); return vw; }
  }
  if ((m = /^\/projects\/(\d+)\/views\/(\d+)$/.exec(path))) {
    const vw = db.views.find((x) => x.id === Number(m[2]) && x.project_id === Number(m[1]));
    if (!vw) return err(404, 12001, "This project view does not exist.");
    if (method === "GET") return vw;
    if (method === "POST") return Object.assign(vw, body);
    if (method === "DELETE") { db.views = db.views.filter((x) => x !== vw); return {}; }
  }
  if ((m = /^\/projects\/(\d+)\/views\/(\d+)\/buckets$/.exec(path))) {
    const viewId = Number(m[2]);
    if (method === "GET") return db.buckets.filter((b) => b.project_view_id === viewId).map((b) => ({ ...b, count: Object.values(db.taskBuckets).filter((tb) => tb[viewId] === b.id).length }));
    if (method === "PUT") { const b = { id: db.nextId++, limit: 0, position: db.buckets.length + 1, ...body, project_view_id: viewId }; db.buckets.push(b); return b; }
  }
  if ((m = /^\/projects\/(\d+)\/views\/(\d+)\/buckets\/(\d+)$/.exec(path))) {
    const b = db.buckets.find((x) => x.id === Number(m[3]));
    if (!b) return err(400, 10001, "This bucket does not exist.");
    if (method === "POST") return Object.assign(b, body);
    if (method === "DELETE") {
      if (db.buckets.filter((x) => x.project_view_id === b.project_view_id).length === 1) return err(400, 10003, "You cannot remove the last bucket.");
      db.buckets = db.buckets.filter((x) => x !== b);
      return {};
    }
  }
  if ((m = /^\/projects\/(\d+)\/views\/(\d+)\/buckets\/(\d+)\/tasks$/.exec(path)) && method === "POST") {
    const viewId = Number(m[2]);
    const bucket = db.buckets.find((x) => x.id === Number(m[3]) && x.project_view_id === viewId);
    if (!bucket) return err(400, 10005, "This bucket does not belong to that view.");
    assert.equal(body.task_id, body.task_id | 0);
    const inBucket = Object.values(db.taskBuckets).filter((tb) => tb[viewId] === bucket.id).length;
    if (bucket.limit && inBucket >= bucket.limit && db.taskBuckets[body.task_id]?.[viewId] !== bucket.id) return err(400, 10004, "You cannot add the task to this bucket as it already exceeded the limit of tasks it can hold.");
    db.taskBuckets[body.task_id] = { ...(db.taskBuckets[body.task_id] || {}), [viewId]: bucket.id };
    const vw = db.views.find((x) => x.id === viewId);
    const t = db.tasks.find((x) => x.id === body.task_id);
    if (vw.done_bucket_id === bucket.id) t.done = true;
    return { task_id: body.task_id, bucket_id: bucket.id, project_view_id: viewId };
  }
  if ((m = /^\/projects\/(\d+)\/views\/(\d+)\/tasks$/.exec(path))) {
    const viewId = Number(m[2]);
    const vw = db.views.find((x) => x.id === viewId);
    let tasks = db.tasks.filter((t) => t.project_id === Number(m[1]));
    const filter = query.get("filter") || "";
    const bm = /bucket_id = (\d+)/.exec(filter);
    const im = /id = (\d+)/.exec(filter);
    if (im) tasks = tasks.filter((t) => t.id === Number(im[1]));
    if (query.get("s")) tasks = tasks.filter((t) => t.title.toLowerCase().includes(query.get("s").toLowerCase()));
    if (vw.view_kind !== "kanban") return tasks;
    return db.buckets
      .filter((b) => b.project_view_id === viewId && (!bm || b.id === Number(bm[1])))
      .map((b) => {
        const inB = tasks.filter((t) => db.taskBuckets[t.id]?.[viewId] === b.id).map((t) => ({ ...t, bucket_id: b.id }));
        return { ...b, count: inB.length, tasks: inB };
      });
  }
  if ((m = /^\/projects\/(\d+)\/tasks$/.exec(path))) {
    if (method === "GET") return { status: 200, headers: { "x-pagination-total-pages": "1" }, body: db.tasks.filter((t) => t.project_id === Number(m[1])) };
    if (method === "PUT") {
      if (!body.title) return err(400, 4002, "You must provide at least a task title.");
      const t = { id: db.nextId++, project_id: Number(m[1]), done: false, labels: [], assignees: [], description: "", due_date: "0001-01-01T00:00:00Z", position: 0, ...body, identifier: `WEB-${db.nextId}` };
      db.tasks.push(t);
      const kanban = db.views.find((x) => x.project_id === t.project_id && x.view_kind === "kanban");
      if (kanban && kanban.default_bucket_id) db.taskBuckets[t.id] = { [kanban.id]: kanban.default_bucket_id };
      return t;
    }
  }
  if (path === "/tasks" && method === "GET") {
    let list = db.tasks;
    const f = query.get("filter") || "";
    if (/done = false/.test(f)) list = list.filter((t) => !t.done);
    if (/done = true/.test(f)) list = list.filter((t) => t.done);
    if (query.get("s")) list = list.filter((t) => t.title.toLowerCase().includes(query.get("s").toLowerCase()));
    return { status: 200, headers: { "x-pagination-total-pages": "3", "x-pagination-result-count": String(list.length) }, body: list };
  }
  if ((m = /^\/tasks\/(\d+)$/.exec(path))) {
    const t = db.tasks.find((x) => x.id === Number(m[1]));
    if (!t) return err(404, 4001, "The task does not exist.");
    if (method === "GET") return t;
    if (method === "POST") { assert.equal(body.created, undefined, "read-only fields stripped"); return Object.assign(t, body); }
    if (method === "DELETE") { db.tasks = db.tasks.filter((x) => x !== t); return {}; }
  }
  if ((m = /^\/tasks\/(\d+)\/position$/.exec(path))) { const t = db.tasks.find((x) => x.id === Number(m[1])); t.position = body.position; return body; }
  if ((m = /^\/tasks\/(\d+)\/labels$/.exec(path)) && method === "PUT") { const t = db.tasks.find((x) => x.id === Number(m[1])); t.labels.push(db.labels.find((l) => l.id === body.label_id)); return body; }
  if ((m = /^\/tasks\/(\d+)\/labels\/(\d+)$/.exec(path)) && method === "DELETE") { const t = db.tasks.find((x) => x.id === Number(m[1])); t.labels = t.labels.filter((l) => l.id !== Number(m[2])); return {}; }
  if ((m = /^\/tasks\/(\d+)\/assignees$/.exec(path)) && method === "PUT") { const t = db.tasks.find((x) => x.id === Number(m[1])); t.assignees.push(db.users.find((u) => u.id === body.user_id)); return body; }
  if ((m = /^\/tasks\/(\d+)\/assignees\/(\d+)$/.exec(path)) && method === "DELETE") { const t = db.tasks.find((x) => x.id === Number(m[1])); t.assignees = t.assignees.filter((u) => u.id !== Number(m[2])); return {}; }
  if ((m = /^\/tasks\/(\d+)\/comments$/.exec(path))) {
    if (method === "GET") return db.comments[m[1]] || [];
    if (method === "PUT") { const c = { id: db.nextId++, author: db.users[0], comment: body.comment, created: new Date().toISOString() }; (db.comments[m[1]] ||= []).push(c); return c; }
  }
  if ((m = /^\/tasks\/(\d+)\/relations$/.exec(path)) && method === "PUT") { assert.equal(body.relation_kind, "subtask"); return body; }
  if ((m = /^\/tasks\/(\d+)\/relations\/(\w+)\/(\d+)$/.exec(path)) && method === "DELETE") return {};
  if (path === "/labels" && method === "GET") return db.labels.filter((l) => !query.get("s") || l.title.toLowerCase().includes(query.get("s").toLowerCase()));
  if (path === "/labels" && method === "PUT") { const l = { id: db.nextId++, ...body }; db.labels.push(l); return l; }
  if ((m = /^\/labels\/(\d+)$/.exec(path))) return db.labels.find((l) => l.id === Number(m[1])) || err(404, 8001, "This label does not exist.");
  if (path === "/tasks/bulk" && method === "POST") return { updated: body.task_ids.length };
  return err(404, 0, `mock has no route ${method} ${path}`);
}

globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(u.pathname.startsWith("/api/v1/"), u.pathname);
  const body = init.body ? JSON.parse(init.body) : undefined;
  const r = route(init.method, u.pathname.slice("/api/v1".length), u.searchParams, body);
  const enveloped = r && typeof r.status === "number" && r.body !== undefined;
  const status = enveloped ? r.status : 200;
  const payload = enveloped ? r.body : r;
  const headers = new Map(Object.entries((r && r.headers) || {}));
  return { status, text: async () => JSON.stringify(payload), headers: { get: (k) => headers.get(k) ?? null } };
};

// --- health -------------------------------------------------------------------
let out = await tools.health({}, env);
assert.match(out, /"version": "v1.24.6"/);
assert.match(out, /"username": "alice"/);
assert.ok(!out.includes(TOKEN));
console.log("health: ok");

// --- projects -----------------------------------------------------------------
out = await tools.projects({}, env);
assert.match(out, /2 projects/);
assert.match(out, /- 1 "Website" \(WEB\)\n  - 2 "Backend" \(API\)/);
assert.ok(!out.includes("Old stuff"));
out = await tools.projects({ include_archived: true }, env);
assert.match(out, /Old stuff.*archived/);
out = await tools.projects({ id: 1 }, env);
assert.match(out, /"kind": "kanban"/);
assert.match(out, /Kanban board: view 11 "Kanban"/);
console.log("projects: ok");

// --- views ---------------------------------------------------------------------
out = await tools.views({ project: "website" }, env);
assert.match(out, /11 "Kanban" \(kanban\) · buckets: manual · done bucket 103 · default bucket 101/);
await assert.rejects(tools.views({ project: "nope" }, env), /no project matches "nope"/);
console.log("views: ok");

// --- board --------------------------------------------------------------------
out = await tools.board({ project: "Website" }, env);
assert.match(out, /Board "Website" \(project 1\) · view 11 "Kanban"/);
assert.match(out, /## To-Do \(bucket 101\) · 1 task\n- #1 Fix header \[P3 high\] due 2026-10-01 \{bug\} \(has description\)/);
assert.match(out, /## Doing \(bucket 102\) · 1 task · limit 2\n- #2 Write copy @alice/);
assert.match(out, /## Done \(bucket 103\) · 1 task\n- #3 ✓ Ship v1/);
out = await tools.board({ project: 1, hide_done: true }, env);
assert.match(out, /## Done \(bucket 103\) · 1 task\n\(empty\)/);
out = await tools.board({ project: 1, raw: true }, env);
assert.equal(JSON.parse(out).buckets[0].tasks[0].id, 1);
await assert.rejects(tools.board({ project: "Backend" }, env), /has no kanban view/);
await assert.rejects(tools.board({ project: 1, view: "List" }, env), /is a list view, not kanban/);
console.log("board: ok");

// --- task_move: by title, done bucket marks done, WIP limit refusal ---------------
out = await tools.taskMove({ task_id: 1, bucket: "done" }, env);
assert.match(out, /moved task #1 "Fix header" to bucket 103 "Done"/);
assert.match(out, /now marked done/);
assert.equal(db.tasks[0].done, true);
assert.equal(db.taskBuckets[1][11], 103);
// Doing has limit 2 and holds #2; move #3 in (ok), then #1 (refused).
await tools.taskMove({ task_id: 3, bucket: "Doing", project: "Website" }, env);
await assert.rejects(tools.taskMove({ task_id: 1, bucket: "Doing" }, env), /\[code 10004\][\s\S]*WIP `limit`/);
await assert.rejects(tools.taskMove({ task_id: 4, bucket: "Doing", project: 1 }, env), /is in project 2, not 1/);
await assert.rejects(tools.taskMove({ task_id: 1, bucket: "Nowhere" }, env), /no bucket "Nowhere".*Buckets: 101 "To-Do"/);
// position within a bucket
out = await tools.taskMove({ task_id: 1, bucket: "To-Do", position: "top" }, env);
assert.match(out, /position top/);
assert.ok(calls.at(-1).startsWith("POST /tasks/1/position"));
console.log("task_move: ok");

// --- task_create straight into a bucket, with a new label and an assignee ---------
out = await tools.taskCreate(
  { project: "Website", title: "Add footer", due_date: "2026-10-05", priority: 2, bucket: "To-Do", add_labels: ["design", "frontend"], create_labels: true, assign: ["bob"], description: "Two lines\nhere" },
  env
);
assert.match(out, /created task #\d+ WEB-\d+ "Add footer" in project 1 "Website"/);
assert.match(out, /\+label "design", \+label "frontend", \+@bob, in bucket "To-Do" \(view 11\)/);
const created = db.tasks.at(-1);
assert.equal(created.description, "<p>Two lines<br>here</p>");
assert.equal(created.priority, 2);
assert.ok(db.labels.some((l) => l.title === "frontend"));
assert.equal(db.taskBuckets[created.id][11], 101);
await assert.rejects(tools.taskCreate({ project: 1, title: "x", add_labels: ["nolabel"] }, env), /no label "nolabel"/);
await assert.rejects(tools.taskCreate({ project: 1 }, env), /title is required/);
console.log("task_create: ok");

// --- task_update: partial, read-only fields stripped, label removal --------------------
out = await tools.taskUpdate({ id: 2, priority: 4, due_date: "tomorrow", remove_labels: ["bug"], unassign: ["alice"] }, env);
assert.match(out, /changed: due_date, priority, label "bug" was not on the task, -@alice/);
assert.equal(db.tasks[1].priority, 4);
assert.equal(db.tasks[1].assignees.length, 0);
out = await tools.taskUpdate({ id: 2 }, env);
assert.match(out, /nothing to change/);
await assert.rejects(tools.taskUpdate({ id: 2, priority: 9 }, env), /priority is 0/);
out = await tools.taskUpdate({ id: 4, project: "Website" }, env);
assert.match(out, /project → 1 "Website"/);
console.log("task_update: ok");

// --- tasks list -----------------------------------------------------------------
out = await tools.tasks({ done: false }, env);
assert.match(out, /where done = false/);
assert.match(out, /page 1 of 3.*pass page=2/);
out = await tools.tasks({ project: 1, filter: "priority >= 3", done: false }, env);
assert.equal(new URLSearchParams(calls.at(-1).split("?")[1]).get("filter"), "(priority >= 3) && done = false");
console.log("tasks: ok");

// --- task_get -------------------------------------------------------------------
out = await tools.taskGet({ id: 1 }, env);
const got = JSON.parse(out);
assert.equal(got.description, "The header wraps.");
assert.deepEqual(got.kanban, [{ view_id: 11, view: "Kanban", bucket_id: 101, bucket: "To-Do" }]);
assert.equal(got.comments[0].comment, "on it");
assert.equal(got.link, "http://vikunja.local:3456/tasks/1");
await assert.rejects(tools.taskGet({ id: 999 }, env), /returned 404 \[code 4001\]/);
console.log("task_get: ok");

// --- buckets ----------------------------------------------------------------------
out = await tools.bucketSave({ project: 1, title: "Review", limit: 3, position: 2.5 }, env);
assert.match(out, /created bucket \d+ "Review" \(limit 3\)/);
assert.match(out, /columns now: 101 "To-Do" → 102 "Doing" → \d+ "Review" → 103 "Done"/);
out = await tools.bucketSave({ project: 1, bucket: "Doing", title: "In Progress", limit: 0 }, env);
assert.match(out, /updated bucket 102 "In Progress"/);
out = await tools.bucketSave({ project: 1, bucket: "Review", set_done: true }, env);
assert.match(out, /set as the view's done bucket/);
assert.equal(db.views[1].done_bucket_id, db.buckets.find((b) => b.title === "Review").id);
out = await tools.bucketDelete({ project: 1, bucket: "Review" }, env);
assert.match(out, /deleted bucket \d+ "Review"/);
console.log("buckets: ok");

// --- project / view save --------------------------------------------------------------
out = await tools.projectSave({ title: "Mobile", identifier: "MOB" }, env);
assert.match(out, /created project \d+ "Mobile"/);
assert.match(out, /\(kanban\)/);
out = await tools.viewSave({ project: "Mobile", title: "Bugs", kind: "kanban", filter: "labels in 'bug'" }, env);
assert.match(out, /created view \d+ "Bugs" \(kanban\)/);
assert.equal(db.views.at(-1).bucket_configuration_mode, "manual");
console.log("project/view save: ok");

// --- labels, comments, relate, request ----------------------------------------------------
out = await tools.labels({}, env);
assert.match(out, /- 5 "bug" #ff0000/);
out = await tools.labels({ create: "bug" }, env);
assert.match(out, /already exists with id 5/);
out = await tools.comments({ task_id: 1, add: "looks good" }, env);
assert.match(out, /added comment \d+ on task #1/);
out = await tools.comments({ task_id: 1 }, env);
assert.match(out, /\[900\] alice · 2026-09-20 09:00\non it/);
assert.match(out, /looks good/);
out = await tools.relate({ task_id: 2, other_task_id: 1, kind: "sub task" }, env);
assert.match(out, /task #2 is now "subtask" of #1/);
await assert.rejects(tools.relate({ task_id: 2, other_task_id: 1, kind: "friend" }, env), /kind must be one of/);
out = await tools.request({ method: "POST", path: "/api/v1/tasks/bulk", body: { task_ids: [1, 2], fields: ["priority"], values: { priority: 1 } } }, env);
assert.match(out, /"updated": 2/);
assert.equal(calls.at(-1), "POST /tasks/bulk");
console.log("labels/comments/relate/request: ok");

// --- errors never carry the token -------------------------------------------------------
try {
  await tools.taskGet({ id: 999 }, env);
} catch (e) {
  assert.ok(!e.message.includes(TOKEN));
}
console.log(`\nall ok (${calls.length} mock API calls)`);

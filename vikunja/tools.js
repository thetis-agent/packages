// The vikunja_* tools. Each takes (args, env) and returns text or JSON for
// the model. Everything network goes through client.js.
//
// Vikunja's model, which the tool set follows:
//   project  → has views (list / gantt / table / kanban)
//   kanban view → has buckets (columns), each with tasks and an optional WIP limit
//   task     → belongs to one project; sits in one bucket per kanban view
// Moving a card between columns is POST /projects/{p}/views/{v}/buckets/{b}/tasks.
// Creating is PUT, updating is POST, everywhere.

import {
  createClient,
  json,
  clip,
  asObject,
  requireString,
  intArg,
  requireInt,
  numArg,
  boolArg,
  listArg,
  clampInt,
  dateArg,
  isZeroDate,
  briefTask,
  briefProject,
  briefView,
  briefBucket,
  briefComment,
  briefLabel,
  briefUser,
  stripHtml,
  toHtml,
} from "./client.js";

const PRIORITY = { 0: "", 1: "low", 2: "medium", 3: "high", 4: "urgent", 5: "DO NOW" };
const RELATION_KINDS = [
  "subtask", "parenttask", "related", "duplicateof", "duplicates",
  "blocking", "blocked", "precedes", "follows", "copiedfrom", "copiedto",
];

// ---------------------------------------------------------------------------
// Resolution helpers: accept an id or a title wherever the model might have
// either, and say what the candidates are when a title is ambiguous.

function eqi(a, b) {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** A project by id or by title. Returns the full project object. */
async function resolveProject(c, value, name = "project") {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required (a project id or title)`);
  const id = Number(value);
  if (Number.isInteger(id) && String(value).trim() === String(id)) {
    return c.get(`/projects/${id}`);
  }
  const title = String(value).trim();
  const found = await c.get("/projects", { s: title, per_page: 50 });
  const list = Array.isArray(found) ? found : [];
  const exact = list.filter((p) => eqi(p.title, title) || eqi(p.identifier, title));
  if (exact.length === 1) return c.get(`/projects/${exact[0].id}`);
  if (exact.length > 1) {
    throw new Error(`${exact.length} projects are titled "${title}": ${exact.map((p) => `${p.id} (${parentPath(p, list)})`).join(", ")}. Pass the id.`);
  }
  if (list.length === 1) return c.get(`/projects/${list[0].id}`);
  if (list.length === 0) throw new Error(`no project matches "${title}". List them with vikunja_projects.`);
  throw new Error(`"${title}" is ambiguous; matching projects: ${list.slice(0, 10).map((p) => `${p.id} "${p.title}"`).join(", ")}. Pass the id.`);
}

function parentPath(p, all) {
  const parent = all.find((x) => x.id === p.parent_project_id);
  return parent ? `under "${parent.title}"` : "top level";
}

/** The views of a project (the project object carries them; fall back to the route). */
async function viewsOf(c, project) {
  if (Array.isArray(project.views) && project.views.length) return project.views;
  const v = await c.get(`/projects/${project.id}/views`);
  return Array.isArray(v) ? v : [];
}

/**
 * A view by id, by title, or by kind ("kanban"). With nothing given, the
 * project's kanban view when it has exactly one.
 */
async function resolveView(c, project, value, { wantKind = "kanban" } = {}) {
  const views = await viewsOf(c, project);
  if (value !== undefined && value !== null && value !== "") {
    const id = Number(value);
    if (Number.isInteger(id) && String(value).trim() === String(id)) {
      const v = views.find((x) => x.id === id);
      if (v) return v;
      return c.get(`/projects/${project.id}/views/${id}`);
    }
    const s = String(value).trim();
    const byTitle = views.filter((x) => eqi(x.title, s));
    if (byTitle.length === 1) return byTitle[0];
    const byKind = views.filter((x) => eqi(x.view_kind, s));
    if (byKind.length === 1) return byKind[0];
    if (byTitle.length > 1 || byKind.length > 1) {
      throw new Error(`several views match "${s}" in project ${project.id}: ${(byTitle.length ? byTitle : byKind).map((x) => `${x.id} "${x.title}"`).join(", ")}. Pass the id.`);
    }
    throw new Error(`no view "${s}" in project ${project.id} "${project.title}". Views: ${views.map((x) => `${x.id} "${x.title}" (${x.view_kind})`).join(", ") || "none"}.`);
  }
  const kanban = views.filter((x) => x.view_kind === wantKind);
  if (kanban.length === 1) return kanban[0];
  if (kanban.length === 0) {
    throw new Error(`project ${project.id} "${project.title}" has no ${wantKind} view. Views: ${views.map((x) => `${x.id} "${x.title}" (${x.view_kind})`).join(", ") || "none"}. Create one with vikunja_view_save.`);
  }
  throw new Error(`project ${project.id} "${project.title}" has ${kanban.length} ${wantKind} views: ${kanban.map((x) => `${x.id} "${x.title}"`).join(", ")}. Pass view.`);
}

/** Buckets of a view, sorted by position. */
async function bucketsOf(c, projectId, viewId) {
  const b = await c.get(`/projects/${projectId}/views/${viewId}/buckets`);
  return (Array.isArray(b) ? b : []).sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
}

/** A bucket by id or by title within one view. */
async function resolveBucket(c, projectId, viewId, value, name = "bucket") {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required (a bucket id or title)`);
  const buckets = await bucketsOf(c, projectId, viewId);
  const id = Number(value);
  if (Number.isInteger(id) && String(value).trim() === String(id)) {
    const b = buckets.find((x) => x.id === id);
    if (b) return b;
    throw new Error(`no bucket ${id} in view ${viewId}. Buckets: ${buckets.map((x) => `${x.id} "${x.title}"`).join(", ") || "none"}.`);
  }
  const s = String(value).trim();
  let hits = buckets.filter((x) => eqi(x.title, s));
  if (!hits.length) hits = buckets.filter((x) => String(x.title).toLowerCase().includes(s.toLowerCase()));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`several buckets match "${s}": ${hits.map((x) => `${x.id} "${x.title}"`).join(", ")}. Pass the id.`);
  throw new Error(`no bucket "${s}" in view ${viewId}. Buckets: ${buckets.map((x) => `${x.id} "${x.title}"`).join(", ") || "none"}.`);
}

/** A label by id or title. With create=true a missing title is created. */
async function resolveLabel(c, value, { create = false } = {}) {
  const id = Number(value);
  if (Number.isInteger(id) && String(value).trim() === String(id)) {
    return c.get(`/labels/${id}`);
  }
  const title = String(value).trim();
  const found = await c.get("/labels", { s: title, per_page: 50 });
  const list = Array.isArray(found) ? found : [];
  const exact = list.find((l) => eqi(l.title, title));
  if (exact) return exact;
  if (create) return c.put("/labels", { title });
  throw new Error(`no label "${title}". Existing labels matching: ${list.map((l) => `${l.id} "${l.title}"`).join(", ") || "none"}. Pass create_labels=true to create it, or list them with vikunja_labels.`);
}

/** A user by id, username or display name, preferring people with access to the project. */
async function resolveUser(c, projectId, value) {
  const id = Number(value);
  if (Number.isInteger(id) && String(value).trim() === String(id)) return { id };
  const s = String(value).trim().replace(/^@/, "");
  let list = [];
  if (projectId) {
    const r = await c.get(`/projects/${projectId}/projectusers`, { s }).catch(() => []);
    list = Array.isArray(r) ? r : [];
  }
  if (!list.length) {
    const r = await c.get("/users", { s }).catch(() => []);
    list = Array.isArray(r) ? r : [];
  }
  const exact = list.find((u) => eqi(u.username, s) || eqi(u.name, s));
  if (exact) return exact;
  if (list.length === 1) return list[0];
  throw new Error(`no user "${s}"${projectId ? ` with access to project ${projectId}` : ""}. Candidates: ${list.map((u) => `${u.id} ${u.username}${u.name ? ` (${u.name})` : ""}`).join(", ") || "none"}.`);
}

// ---------------------------------------------------------------------------
// Line formatting.

function fmtDate(s) {
  if (isZeroDate(s)) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const hasTime = !(d.getUTCHours() === 23 && d.getUTCMinutes() === 59) && !(d.getUTCHours() === 0 && d.getUTCMinutes() === 0);
  return hasTime ? d.toISOString().slice(0, 16).replace("T", " ") : d.toISOString().slice(0, 10);
}

function taskLine(t) {
  const parts = [`#${t.id}`];
  if (t.identifier && !/^#?-?\d+$/.test(t.identifier)) parts.push(t.identifier);
  parts.push(t.done ? `✓ ${t.title}` : t.title);
  if (t.priority) parts.push(`[P${t.priority} ${PRIORITY[t.priority] ?? ""}]`.replace(/ \]$/, "]"));
  if (!isZeroDate(t.due_date)) parts.push(`due ${fmtDate(t.due_date)}`);
  if (Array.isArray(t.labels) && t.labels.length) parts.push(`{${t.labels.map((l) => l.title).join(", ")}}`);
  if (Array.isArray(t.assignees) && t.assignees.length) parts.push(t.assignees.map((u) => `@${u.username}`).join(" "));
  if (t.percent_done) parts.push(`${Math.round(t.percent_done * 100)}%`);
  if (t.description && stripHtml(t.description)) parts.push("(has description)");
  return `- ${parts.join(" ")}`;
}

function pagingNote(data, page, perPage) {
  const m = data && data._meta;
  if (!m || !m.totalPages) return "";
  if (m.totalPages <= (page || 1)) return `\n(page ${page || 1} of ${m.totalPages}; that is all of them)`;
  return `\n(page ${page || 1} of ${m.totalPages}, ${perPage} per page; pass page=${(page || 1) + 1} for more)`;
}

// ---------------------------------------------------------------------------
// Tools.

export async function health(_args, env) {
  const c = createClient(env.config);
  const info = await c.get("/info");
  let user;
  let userError;
  try {
    user = await c.get("/user");
  } catch (e) {
    userError = e.message;
  }
  const out = {
    url: c.baseUrl,
    version: info.version,
    frontend_url: info.frontend_url || undefined,
    max_items_per_page: info.max_items_per_page,
    features: {
      registration: info.registration_enabled,
      link_sharing: info.link_sharing_enabled,
      webhooks: info.webhooks_enabled,
      demo_mode: info.demo_mode_enabled || undefined,
    },
    token: user ? { ok: true, user: briefUser(user) } : { ok: false, error: userError },
  };
  return json(out);
}

export async function projects(args, env) {
  const c = createClient(env.config);
  const id = intArg(args.id, "id");
  if (id !== undefined) {
    const p = await c.get(`/projects/${id}`);
    const views = await viewsOf(c, p);
    const out = briefProject(p);
    out.views = views.map(briefView);
    out.link = c.link.project(p.id);
    const kanbans = views.filter((v) => v.view_kind === "kanban");
    let text = json(out);
    if (kanbans.length) text += `\n\nKanban board${kanbans.length > 1 ? "s" : ""}: ${kanbans.map((v) => `view ${v.id} "${v.title}"`).join(", ")}. Read one with vikunja_board.`;
    return text;
  }
  const page = clampInt(args.page, 1, 1, 10_000);
  const perPage = clampInt(args.limit, 50, 1, 500);
  const query = { page, per_page: perPage };
  if (args.query) query.s = String(args.query);
  if (boolArg(args.include_archived)) query.is_archived = "true";
  const list = await c.get("/projects", query);
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return `no projects${args.query ? ` match "${args.query}"` : ""}.`;
  // Render as a tree when the whole set is here; parents first.
  const byId = new Map(arr.map((p) => [p.id, p]));
  const roots = arr.filter((p) => !p.parent_project_id || !byId.has(p.parent_project_id));
  const children = (pid) => arr.filter((p) => p.parent_project_id === pid);
  const lines = [];
  const walk = (p, depth) => {
    const flags = [];
    if (p.identifier) flags.push(p.identifier);
    if (p.is_archived) flags.push("archived");
    if (p.is_favorite) flags.push("★");
    lines.push(`${"  ".repeat(depth)}- ${p.id} "${p.title}"${flags.length ? ` (${flags.join(", ")})` : ""}`);
    for (const ch of children(p.id)) walk(ch, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return `${arr.length} project${arr.length === 1 ? "" : "s"}:\n${lines.join("\n")}${pagingNote(list, page, perPage)}\n\nA project's boards: vikunja_projects with id, or straight to vikunja_board with project.`;
}

export async function projectSave(args, env) {
  const c = createClient(env.config);
  const id = intArg(args.id, "id");
  const fields = {};
  if (args.title !== undefined) fields.title = requireString(args.title, "title");
  if (args.description !== undefined) fields.description = toHtml(String(args.description ?? ""));
  if (args.identifier !== undefined) fields.identifier = String(args.identifier ?? "");
  if (args.parent_project_id !== undefined) fields.parent_project_id = intArg(args.parent_project_id, "parent_project_id") ?? 0;
  if (args.color !== undefined) fields.hex_color = String(args.color ?? "").replace(/^#/, "");
  if (args.is_archived !== undefined) fields.is_archived = boolArg(args.is_archived);
  if (args.is_favorite !== undefined) fields.is_favorite = boolArg(args.is_favorite);

  let p;
  if (id === undefined) {
    if (!fields.title) throw new Error("title is required to create a project");
    p = await c.put("/projects", fields);
    // A new project gets default views (List, Gantt, Table, Kanban) from Vikunja.
    const views = await viewsOf(c, p);
    return `created project ${p.id} "${p.title}" ${c.link.project(p.id)}\nviews: ${views.map((v) => `${v.id} "${v.title}" (${v.view_kind})`).join(", ") || "none yet"}`;
  }
  const current = await c.get(`/projects/${id}`);
  const body = { ...current, ...fields };
  delete body.views;
  delete body.owner;
  delete body.subscription;
  delete body.max_permission;
  delete body.background_information;
  delete body.background_blur_hash;
  p = await c.post(`/projects/${id}`, body);
  return `updated project ${p.id} "${p.title}" ${c.link.project(p.id)}\nchanged: ${Object.keys(fields).join(", ") || "nothing"}`;
}

export async function projectDelete(args, env) {
  const c = createClient(env.config);
  const id = requireInt(args.id, "id");
  const p = await c.get(`/projects/${id}`);
  await c.delete(`/projects/${id}`);
  return `deleted project ${id} "${p.title}" and every task in it.`;
}

export async function views(args, env) {
  const c = createClient(env.config);
  const project = await resolveProject(c, args.project);
  const list = await viewsOf(c, project);
  const lines = list
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((v) => {
      const bits = [`${v.id} "${v.title}" (${v.view_kind})`];
      if (v.view_kind === "kanban") {
        bits.push(`buckets: ${v.bucket_configuration_mode}`);
        if (v.done_bucket_id) bits.push(`done bucket ${v.done_bucket_id}`);
        if (v.default_bucket_id) bits.push(`default bucket ${v.default_bucket_id}`);
      }
      const f = v.filter && typeof v.filter === "object" ? v.filter.filter : v.filter;
      if (f) bits.push(`filter: ${f}`);
      return `- ${bits.join(" · ")}`;
    });
  return `project ${project.id} "${project.title}" has ${list.length} view${list.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
}

export async function viewSave(args, env) {
  const c = createClient(env.config);
  const project = await resolveProject(c, args.project);
  const id = intArg(args.id, "id");
  const fields = {};
  if (args.title !== undefined) fields.title = requireString(args.title, "title");
  if (args.kind !== undefined) {
    const k = String(args.kind).toLowerCase();
    if (!["list", "gantt", "table", "kanban"].includes(k)) throw new Error("kind must be list, gantt, table or kanban");
    fields.view_kind = k;
  }
  if (args.bucket_configuration_mode !== undefined) {
    const m = String(args.bucket_configuration_mode).toLowerCase();
    if (!["none", "manual", "filter"].includes(m)) throw new Error("bucket_configuration_mode must be none, manual or filter");
    fields.bucket_configuration_mode = m;
  }
  if (args.filter !== undefined) fields.filter = { filter: String(args.filter ?? "") };
  if (args.position !== undefined) fields.position = numArg(args.position, "position");

  if (id === undefined) {
    if (!fields.title) throw new Error("title is required to create a view");
    if (!fields.view_kind) throw new Error("kind is required to create a view (list, gantt, table or kanban)");
    if (fields.view_kind === "kanban" && !fields.bucket_configuration_mode) fields.bucket_configuration_mode = "manual";
    const v = await c.put(`/projects/${project.id}/views`, fields);
    return `created view ${v.id} "${v.title}" (${v.view_kind}) in project ${project.id} ${c.link.view(project.id, v.id)}`;
  }

  const current = await c.get(`/projects/${project.id}/views/${id}`);
  const body = { ...current, ...fields };
  // Done / default bucket are view properties; resolve by id or title.
  if (args.done_bucket !== undefined) {
    body.done_bucket_id = args.done_bucket === null || args.done_bucket === "" ? 0 : (await resolveBucket(c, project.id, id, args.done_bucket, "done_bucket")).id;
    fields.done_bucket_id = body.done_bucket_id;
  }
  if (args.default_bucket !== undefined) {
    body.default_bucket_id = args.default_bucket === null || args.default_bucket === "" ? 0 : (await resolveBucket(c, project.id, id, args.default_bucket, "default_bucket")).id;
    fields.default_bucket_id = body.default_bucket_id;
  }
  if (typeof body.filter === "string") body.filter = { filter: body.filter };
  const v = await c.post(`/projects/${project.id}/views/${id}`, body);
  return `updated view ${v.id} "${v.title}" (${v.view_kind}) in project ${project.id}\nchanged: ${Object.keys(fields).join(", ") || "nothing"}`;
}

export async function viewDelete(args, env) {
  const c = createClient(env.config);
  const project = await resolveProject(c, args.project);
  const id = requireInt(args.id, "id");
  await c.delete(`/projects/${project.id}/views/${id}`);
  return `deleted view ${id} from project ${project.id} "${project.title}".`;
}

export async function board(args, env) {
  const c = createClient(env.config);
  const project = await resolveProject(c, args.project);
  const view = await resolveView(c, project, args.view);
  if (view.view_kind !== "kanban") {
    throw new Error(`view ${view.id} "${view.title}" is a ${view.view_kind} view, not kanban. Use vikunja_tasks for it, or pick a kanban view: ${(await viewsOf(c, project)).filter((v) => v.view_kind === "kanban").map((v) => `${v.id} "${v.title}"`).join(", ") || "none"}.`);
  }
  const perBucket = clampInt(args.per_bucket, 50, 1, 500);
  const query = { per_page: perBucket };
  if (args.filter) query.filter = String(args.filter);
  if (args.search) query.s = String(args.search);
  const data = await c.get(`/projects/${project.id}/views/${view.id}/tasks`, query);
  let buckets = Array.isArray(data) ? data : [];
  // A kanban view in mode `none` answers with a flat task list.
  if (buckets.length && buckets[0] && !("tasks" in buckets[0]) && "title" in buckets[0] && "done" in buckets[0]) {
    buckets = [{ id: 0, title: "(no buckets)", tasks: buckets }];
  }
  buckets.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const hideDone = boolArg(args.hide_done, false);

  if (boolArg(args.raw)) {
    return json({
      project: { id: project.id, title: project.title },
      view: briefView(view),
      buckets: buckets.map((b) => briefBucket(b, { withDescription: boolArg(args.with_descriptions) })),
    });
  }

  const head = [`Board "${project.title}" (project ${project.id}) · view ${view.id} "${view.title}"`];
  const meta = [];
  if (view.bucket_configuration_mode && view.bucket_configuration_mode !== "manual") meta.push(`buckets: ${view.bucket_configuration_mode}`);
  if (view.done_bucket_id) meta.push(`done bucket ${view.done_bucket_id}`);
  if (view.default_bucket_id) meta.push(`default bucket ${view.default_bucket_id}`);
  if (meta.length) head.push(meta.join(", "));
  head.push(c.link.view(project.id, view.id));

  const sections = buckets.map((b) => {
    let tasks = Array.isArray(b.tasks) ? b.tasks : [];
    if (hideDone) tasks = tasks.filter((t) => !t.done);
    const count = b.count !== undefined ? b.count : tasks.length;
    const title = `## ${b.title} (bucket ${b.id}) · ${count} task${count === 1 ? "" : "s"}${b.limit ? ` · limit ${b.limit}` : ""}`;
    if (!tasks.length) return `${title}\n(empty)`;
    let body = tasks.map(taskLine).join("\n");
    if (boolArg(args.with_descriptions)) {
      body = tasks
        .map((t) => {
          const d = stripHtml(t.description);
          return taskLine(t) + (d ? `\n    ${clip(d, 400).replace(/\n/g, "\n    ")}` : "");
        })
        .join("\n");
    }
    if (count > tasks.length) body += `\n  … ${count - tasks.length} more in this bucket (raise per_bucket or filter)`;
    return `${title}\n${body}`;
  });

  return `${head.join("\n")}\n\n${sections.join("\n\n")}\n\nMove a card: vikunja_task_move { task_id, bucket: "<title or id>", project: ${project.id} }. Details: vikunja_task_get { id }.`;
}

export async function bucketSave(args, env) {
  const c = createClient(env.config);
  const project = await resolveProject(c, args.project);
  const view = await resolveView(c, project, args.view);
  const fields = {};
  if (args.title !== undefined) fields.title = requireString(args.title, "title");
  if (args.limit !== undefined) fields.limit = intArg(args.limit, "limit") ?? 0;
  if (args.position !== undefined) fields.position = numArg(args.position, "position");

  let b;
  if (args.bucket === undefined || args.bucket === null || args.bucket === "") {
    if (!fields.title) throw new Error("title is required to create a bucket");
    b = await c.put(`/projects/${project.id}/views/${view.id}/buckets`, { ...fields, project_view_id: view.id });
  } else {
    const current = await resolveBucket(c, project.id, view.id, args.bucket);
    const body = { ...current, ...fields, project_view_id: view.id };
    delete body.tasks;
    delete body.created_by;
    delete body.count;
    b = await c.post(`/projects/${project.id}/views/${view.id}/buckets/${current.id}`, body);
  }

  const notes = [];
  if (boolArg(args.set_done)) {
    await viewSave({ project: project.id, id: view.id, done_bucket: b.id }, env);
    notes.push("set as the view's done bucket");
  }
  if (boolArg(args.set_default)) {
    await viewSave({ project: project.id, id: view.id, default_bucket: b.id }, env);
    notes.push("set as the view's default bucket");
  }
  const buckets = await bucketsOf(c, project.id, view.id);
  return `${args.bucket ? "updated" : "created"} bucket ${b.id} "${b.title}"${b.limit ? ` (limit ${b.limit})` : ""} in view ${view.id} of project ${project.id}${notes.length ? `; ${notes.join("; ")}` : ""}\ncolumns now: ${buckets.map((x) => `${x.id} "${x.title}"`).join(" → ")}`;
}

export async function bucketDelete(args, env) {
  const c = createClient(env.config);
  const project = await resolveProject(c, args.project);
  const view = await resolveView(c, project, args.view);
  const b = await resolveBucket(c, project.id, view.id, args.bucket);
  await c.delete(`/projects/${project.id}/views/${view.id}/buckets/${b.id}`);
  const buckets = await bucketsOf(c, project.id, view.id);
  return `deleted bucket ${b.id} "${b.title}" from view ${view.id}. Its tasks moved to the default bucket.\ncolumns now: ${buckets.map((x) => `${x.id} "${x.title}"`).join(" → ") || "none"}`;
}

export async function tasks(args, env) {
  const c = createClient(env.config);
  const page = clampInt(args.page, 1, 1, 10_000);
  const perPage = clampInt(args.limit, 50, 1, 500);
  const query = { page, per_page: perPage };
  if (args.search) query.s = String(args.search);
  const filters = [];
  if (args.filter) filters.push(`(${String(args.filter)})`);
  if (args.done !== undefined && args.done !== null && args.done !== "") filters.push(`done = ${boolArg(args.done)}`);
  if (filters.length) query.filter = filters.join(" && ");
  if (args.sort_by) {
    const sorts = listArg(args.sort_by, "sort_by");
    query.sort_by = sorts;
    const orders = listArg(args.order_by, "order_by");
    if (orders) query.order_by = orders;
  }
  if (args.expand) query.expand = listArg(args.expand, "expand");

  let scope = "all projects";
  let path = "/tasks";
  let project;
  if (args.project !== undefined && args.project !== null && args.project !== "") {
    project = await resolveProject(c, args.project);
    path = `/projects/${project.id}/tasks`;
    scope = `project ${project.id} "${project.title}"`;
  }
  const data = await c.get(path, query);
  const list = Array.isArray(data) ? data : [];
  if (boolArg(args.raw)) return json(list.map((t) => briefTask(t)));
  if (!list.length) return `no tasks in ${scope}${query.filter ? ` matching ${query.filter}` : ""}${query.s ? ` for "${query.s}"` : ""}.`;
  const lines = list.map((t) => (project ? taskLine(t) : `${taskLine(t)} (project ${t.project_id})`));
  return `${list.length} task${list.length === 1 ? "" : "s"} in ${scope}${query.filter ? ` where ${query.filter}` : ""}:\n${lines.join("\n")}${pagingNote(data, page, perPage)}`;
}

export async function taskGet(args, env) {
  const c = createClient(env.config);
  const id = requireInt(args.id, "id");
  const withComments = boolArg(args.with_comments, true);
  const t = await c.get(`/tasks/${id}`);
  const out = briefTask(t, { withDescription: true });
  out.link = c.link.task(t.id);
  out.created = t.created;
  out.updated = t.updated;
  if (t.created_by) out.created_by = briefUser(t.created_by);
  if (Array.isArray(t.reminders) && t.reminders.length) {
    out.reminders = t.reminders.map((r) => (r.relative_to ? `${r.relative_period}s relative to ${r.relative_to}` : r.reminder));
  }
  if (Array.isArray(t.attachments) && t.attachments.length) {
    out.attachments = t.attachments.map((a) => ({ id: a.id, name: a.file && a.file.name, size: a.file && a.file.size }));
  }
  // Which bucket in which kanban view.
  try {
    const project = await c.get(`/projects/${t.project_id}`);
    out.project = { id: project.id, title: project.title };
    const kanbans = (await viewsOf(c, project)).filter((v) => v.view_kind === "kanban");
    if (kanbans.length) {
      const placed = [];
      for (const v of kanbans) {
        const buckets = await c.get(`/projects/${project.id}/views/${v.id}/tasks`, { filter: `id = ${t.id}`, per_page: 5 }).catch(() => null);
        if (Array.isArray(buckets)) {
          const hit = buckets.find((b) => Array.isArray(b.tasks) && b.tasks.some((x) => x.id === t.id));
          if (hit) placed.push({ view_id: v.id, view: v.title, bucket_id: hit.id, bucket: hit.title });
        }
      }
      if (placed.length) out.kanban = placed;
    }
  } catch {
    // project unreadable: leave it out
  }
  if (withComments) {
    const comments = await c.get(`/tasks/${id}/comments`).catch(() => []);
    if (Array.isArray(comments) && comments.length) out.comments = comments.map(briefComment);
  }
  return json(out);
}

/** Apply the task field arguments shared by create and update to a body. Returns the changed keys. */
function applyTaskFields(body, args) {
  const changed = [];
  const set = (k, v) => {
    body[k] = v;
    changed.push(k);
  };
  if (args.title !== undefined) set("title", requireString(args.title, "title"));
  if (args.description !== undefined) set("description", toHtml(String(args.description ?? "")));
  if (args.done !== undefined) set("done", boolArg(args.done));
  if (args.due_date !== undefined) set("due_date", dateArg(args.due_date, "due_date"));
  if (args.start_date !== undefined) set("start_date", dateArg(args.start_date, "start_date"));
  if (args.end_date !== undefined) set("end_date", dateArg(args.end_date, "end_date"));
  if (args.priority !== undefined) {
    const p = intArg(args.priority, "priority") ?? 0;
    if (p < 0 || p > 5) throw new Error("priority is 0 (unset) to 5 (DO NOW): 1 low, 2 medium, 3 high, 4 urgent");
    set("priority", p);
  }
  if (args.percent_done !== undefined) {
    let n = numArg(args.percent_done, "percent_done") ?? 0;
    if (n > 1) n = n / 100;
    set("percent_done", Math.min(1, Math.max(0, n)));
  }
  if (args.color !== undefined) set("hex_color", String(args.color ?? "").replace(/^#/, ""));
  if (args.is_favorite !== undefined) set("is_favorite", boolArg(args.is_favorite));
  if (args.repeat_after !== undefined) {
    const v = args.repeat_after;
    let secs;
    if (v === null || v === "" || v === 0) secs = 0;
    else if (typeof v === "number") secs = v;
    else {
      const m = /^(\d+)\s*([smhdw])?$/i.exec(String(v).trim());
      if (!m) throw new Error("repeat_after is seconds, or a number with s/m/h/d/w, e.g. 1d, 2w");
      secs = Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[(m[2] || "s").toLowerCase()]);
    }
    set("repeat_after", secs);
  }
  if (args.repeat_mode !== undefined) {
    const m = String(args.repeat_mode).toLowerCase();
    const mode = { default: 0, "0": 0, month: 1, monthly: 1, "1": 1, from_done: 2, "from done": 2, "2": 2 }[m];
    if (mode === undefined) throw new Error("repeat_mode is default, month or from_done");
    set("repeat_mode", mode);
  }
  if (args.reminders !== undefined) {
    const list = listArg(args.reminders, "reminders") ?? [];
    set(
      "reminders",
      list.map((r) => {
        const rel = /^([+-]?\d+)([smhd])\s+(due|start|end)(?:_date)?$/i.exec(r);
        if (rel) {
          const secs = Number(rel[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[rel[2].toLowerCase()];
          return { relative_period: secs, relative_to: `${rel[3].toLowerCase()}_date` };
        }
        return { reminder: dateArg(r, "reminders[]") };
      })
    );
  }
  return changed;
}

/** Labels and assignees after the task exists. Returns notes for the reply. */
async function applyTaskLinks(c, task, args) {
  const notes = [];
  const create = boolArg(args.create_labels, false);
  const add = listArg(args.add_labels ?? args.labels, "add_labels");
  if (add) {
    const have = new Set((task.labels || []).map((l) => l.id));
    for (const name of add) {
      const label = await resolveLabel(c, name, { create });
      if (have.has(label.id)) continue;
      await c.put(`/tasks/${task.id}/labels`, { label_id: label.id });
      notes.push(`+label "${label.title}"`);
    }
  }
  const remove = listArg(args.remove_labels, "remove_labels");
  if (remove) {
    for (const name of remove) {
      const label = (task.labels || []).find((l) => eqi(l.title, name) || String(l.id) === String(name).trim());
      if (!label) {
        notes.push(`label "${name}" was not on the task`);
        continue;
      }
      await c.delete(`/tasks/${task.id}/labels/${label.id}`);
      notes.push(`-label "${label.title}"`);
    }
  }
  const assign = listArg(args.assign ?? args.assignees, "assign");
  if (assign) {
    const have = new Set((task.assignees || []).map((u) => u.id));
    for (const who of assign) {
      const u = await resolveUser(c, task.project_id, who);
      if (have.has(u.id)) continue;
      await c.put(`/tasks/${task.id}/assignees`, { user_id: u.id });
      notes.push(`+@${u.username ?? u.id}`);
    }
  }
  const unassign = listArg(args.unassign, "unassign");
  if (unassign) {
    for (const who of unassign) {
      const u = (task.assignees || []).find((x) => eqi(x.username, String(who).replace(/^@/, "")) || eqi(x.name, who) || String(x.id) === String(who).trim());
      if (!u) {
        notes.push(`"${who}" was not assigned`);
        continue;
      }
      await c.delete(`/tasks/${task.id}/assignees/${u.id}`);
      notes.push(`-@${u.username}`);
    }
  }
  return notes;
}

export async function taskCreate(args, env) {
  const c = createClient(env.config);
  const project = await resolveProject(c, args.project);
  const body = {};
  applyTaskFields(body, args);
  if (!body.title) throw new Error("title is required");
  let t = await c.put(`/projects/${project.id}/tasks`, body);
  const notes = await applyTaskLinks(c, t, args);

  if (args.bucket !== undefined && args.bucket !== null && args.bucket !== "") {
    const view = await resolveView(c, project, args.view);
    const bucket = await resolveBucket(c, project.id, view.id, args.bucket);
    await c.post(`/projects/${project.id}/views/${view.id}/buckets/${bucket.id}/tasks`, {
      task_id: t.id,
      bucket_id: bucket.id,
      project_view_id: view.id,
    });
    notes.push(`in bucket "${bucket.title}" (view ${view.id})`);
  }
  if (notes.length) t = await c.get(`/tasks/${t.id}`);
  return `created task #${t.id}${t.identifier ? ` ${t.identifier}` : ""} "${t.title}" in project ${project.id} "${project.title}" ${c.link.task(t.id)}${notes.length ? `\n${notes.join(", ")}` : ""}\n${taskLine(t)}`;
}

const TASK_READONLY = [
  "created", "updated", "created_by", "identifier", "index", "done_at", "attachments",
  "comments", "comment_count", "buckets", "bucket_id", "subscription", "reactions",
  "related_tasks", "is_unread", "time_entries_count", "deleted_at", "cover_image_attachment_id",
];

export async function taskUpdate(args, env) {
  const c = createClient(env.config);
  const id = requireInt(args.id, "id");
  const current = await c.get(`/tasks/${id}`);
  const body = { ...current };
  for (const k of TASK_READONLY) delete body[k];
  const changed = applyTaskFields(body, args);
  if (args.project !== undefined && args.project !== null && args.project !== "") {
    const target = await resolveProject(c, args.project);
    if (target.id !== current.project_id) {
      body.project_id = target.id;
      changed.push(`project → ${target.id} "${target.title}"`);
    }
  }
  let t = current;
  if (changed.length) t = await c.post(`/tasks/${id}`, body);
  const notes = await applyTaskLinks(c, t, args);
  if (notes.length) t = await c.get(`/tasks/${id}`);
  if (!changed.length && !notes.length) return `nothing to change on task #${id}; pass a field.`;
  return `updated task #${t.id} "${t.title}" ${c.link.task(t.id)}\nchanged: ${[...changed, ...notes].join(", ")}\n${taskLine(t)}`;
}

export async function taskMove(args, env) {
  const c = createClient(env.config);
  const taskId = requireInt(args.task_id, "task_id");
  const task = await c.get(`/tasks/${taskId}`);
  const project = await resolveProject(c, args.project ?? task.project_id);
  if (project.id !== task.project_id) {
    throw new Error(`task #${taskId} is in project ${task.project_id}, not ${project.id}. To move it across projects use vikunja_task_update with project, then move it to a bucket.`);
  }
  const view = await resolveView(c, project, args.view);
  const bucket = await resolveBucket(c, project.id, view.id, args.bucket);

  await c.post(`/projects/${project.id}/views/${view.id}/buckets/${bucket.id}/tasks`, {
    task_id: taskId,
    bucket_id: bucket.id,
    project_view_id: view.id,
  });
  const notes = [`moved task #${taskId} "${task.title}" to bucket ${bucket.id} "${bucket.title}" in view ${view.id} "${view.title}"`];
  if (view.done_bucket_id === bucket.id) notes.push("that is the done bucket, so the task is now marked done");

  if (args.position !== undefined && args.position !== null && args.position !== "") {
    const pos = await computePosition(c, project.id, view.id, bucket.id, taskId, args.position);
    await c.post(`/tasks/${taskId}/position`, { task_id: taskId, project_view_id: view.id, position: pos });
    notes.push(`position ${typeof args.position === "string" && /^(top|bottom)$/i.test(args.position) ? args.position.toLowerCase() : pos}`);
  }
  return notes.join("; ") + ".";
}

/** A position for a task inside a bucket: "top", "bottom", "after:<task id>", "before:<task id>" or a number. */
async function computePosition(c, projectId, viewId, bucketId, taskId, want) {
  if (typeof want === "number") return want;
  const s = String(want).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const data = await c.get(`/projects/${projectId}/views/${viewId}/tasks`, { filter: `bucket_id = ${bucketId}`, per_page: 500 });
  const bucket = (Array.isArray(data) ? data : []).find((b) => b.id === bucketId) || {};
  const others = (bucket.tasks || []).filter((t) => t.id !== taskId).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const STEP = 65536;
  const between = (before, after) => {
    if (!before && !after) return STEP;
    if (!before) return (after.position ?? STEP) / 2 || STEP / 2;
    if (!after) return (before.position ?? 0) + STEP;
    return ((before.position ?? 0) + (after.position ?? 0)) / 2;
  };
  if (/^top$/i.test(s)) return between(null, others[0]);
  if (/^bottom$/i.test(s)) return between(others[others.length - 1], null);
  const rel = /^(after|before):\s*#?(\d+)$/i.exec(s);
  if (rel) {
    const idx = others.findIndex((t) => t.id === Number(rel[2]));
    if (idx < 0) throw new Error(`task #${rel[2]} is not in bucket ${bucketId}; cannot place relative to it`);
    return rel[1].toLowerCase() === "after" ? between(others[idx], others[idx + 1]) : between(others[idx - 1], others[idx]);
  }
  throw new Error(`position must be "top", "bottom", "after:<task id>", "before:<task id>" or a number; got ${clip(s, 40)}`);
}

export async function taskDelete(args, env) {
  const c = createClient(env.config);
  const id = requireInt(args.id, "id");
  const t = await c.get(`/tasks/${id}`);
  await c.delete(`/tasks/${id}`);
  return `deleted task #${id} "${t.title}" from project ${t.project_id}.`;
}

export async function labels(args, env) {
  const c = createClient(env.config);
  if (args.create !== undefined && args.create !== null && args.create !== "") {
    const title = requireString(args.create, "create");
    const existing = await c.get("/labels", { s: title });
    const dup = (Array.isArray(existing) ? existing : []).find((l) => eqi(l.title, title));
    if (dup) return `label "${dup.title}" already exists with id ${dup.id}.`;
    const body = { title };
    if (args.color) body.hex_color = String(args.color).replace(/^#/, "");
    if (args.description) body.description = String(args.description);
    const l = await c.put("/labels", body);
    return `created label ${l.id} "${l.title}"${l.hex_color ? ` #${l.hex_color}` : ""}.`;
  }
  const query = { per_page: 200 };
  if (args.query) query.s = String(args.query);
  const list = await c.get("/labels", query);
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return `no labels${args.query ? ` match "${args.query}"` : ""}. Create one with create: "<title>".`;
  return `${arr.length} label${arr.length === 1 ? "" : "s"}:\n${arr.map((l) => `- ${l.id} "${l.title}"${l.hex_color ? ` #${l.hex_color}` : ""}${l.description ? ` — ${clip(l.description, 80)}` : ""}`).join("\n")}`;
}

export async function comments(args, env) {
  const c = createClient(env.config);
  const taskId = requireInt(args.task_id, "task_id");
  if (args.add !== undefined && args.add !== null && args.add !== "") {
    const text = requireString(args.add, "add");
    const cm = await c.put(`/tasks/${taskId}/comments`, { comment: toHtml(text) });
    return `added comment ${cm.id} on task #${taskId}.`;
  }
  const commentId = intArg(args.comment_id, "comment_id");
  if (commentId !== undefined && boolArg(args.delete)) {
    await c.delete(`/tasks/${taskId}/comments/${commentId}`);
    return `deleted comment ${commentId} from task #${taskId}.`;
  }
  if (commentId !== undefined && args.edit !== undefined) {
    const cm = await c.post(`/tasks/${taskId}/comments/${commentId}`, { comment: toHtml(requireString(args.edit, "edit")) });
    return `edited comment ${cm.id} on task #${taskId}.`;
  }
  const list = await c.get(`/tasks/${taskId}/comments`);
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return `task #${taskId} has no comments.`;
  return arr
    .map((cm) => {
      const b = briefComment(cm);
      return `[${b.id}] ${b.author ? b.author.username : "?"} · ${fmtDate(b.created)}\n${b.comment}`;
    })
    .join("\n\n");
}

export async function relate(args, env) {
  const c = createClient(env.config);
  const taskId = requireInt(args.task_id, "task_id");
  const otherId = requireInt(args.other_task_id, "other_task_id");
  const kind = String(args.kind ?? "related").toLowerCase().replace(/[\s_-]/g, "");
  if (!RELATION_KINDS.includes(kind)) throw new Error(`kind must be one of ${RELATION_KINDS.join(", ")}`);
  if (boolArg(args.remove)) {
    await c.delete(`/tasks/${taskId}/relations/${kind}/${otherId}`);
    return `removed relation: task #${taskId} ${kind} #${otherId}.`;
  }
  await c.put(`/tasks/${taskId}/relations`, { task_id: taskId, other_task_id: otherId, relation_kind: kind });
  return `task #${taskId} is now "${kind}" of #${otherId} (Vikunja adds the inverse on #${otherId} itself).`;
}

export async function request(args, env) {
  const c = createClient(env.config);
  const method = String(args.method ?? "GET").toUpperCase();
  if (!["GET", "PUT", "POST", "PATCH", "DELETE"].includes(method)) throw new Error("method must be GET, PUT, POST, PATCH or DELETE");
  let path = requireString(args.path, "path");
  path = path.replace(/^\/?api\/v1/, "");
  if (!path.startsWith("/")) path = `/${path}`;
  const query = asObject(args.query, "query");
  const body = asObject(args.body, "body");
  const data = await c.send(method, path, query, method === "GET" || method === "DELETE" ? undefined : body ?? {});
  const meta = data && data._meta;
  let out = json(data);
  if (meta && meta.totalPages) out += `\n(page headers: ${meta.totalPages} total pages, ${meta.resultCount} results on this page)`;
  return out;
}

export { briefTask, briefLabel };

// The grafana_* tools. Each takes (args, env), builds a client from env.config,
// makes one or a few requests, and returns text or JSON for the model.
//
// Conventions:
// - Lists render as one line per item with the uid on it, because the uid is
//   what the next call needs and titles are not unique.
// - Single objects come back as JSON, cut at a bound with a note.
// - A write echoes what Grafana answered (uid, url, version), not the input.
// - Alerting-provisioning writes take `disable_provenance` so the person can
//   still edit the resource in the UI afterwards.

import {
  createClient,
  json,
  clip,
  asObject,
  requireString,
  clampInt,
  toEpochMs,
  provenanceHeaders,
} from "./client.js";

const client = (env) => createClient(env && env.config);

// ---------------------------------------------------------------------------
// Instance

export async function health(args, env) {
  const c = client(env);
  const h = await c.get("/api/health");
  const lines = [
    `Grafana at ${c.baseUrl}`,
    `version: ${h.version ?? "?"}  commit: ${h.commit ?? "?"}  database: ${h.database ?? "?"}`,
  ];
  // /api/health needs no auth. The org call proves the token works.
  try {
    const org = await c.get("/api/org");
    lines.push(`token ok: org ${org.id ?? "?"} "${org.name ?? ""}"`);
  } catch (e) {
    lines.push(`token check FAILED: ${e.message}`);
  }
  lines.push(`app-platform namespace configured: ${c.namespace}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Search, dashboards

export async function search(args, env) {
  const c = client(env);
  const a = args ?? {};
  const limit = clampInt(a.limit, 50, 1, 5000);
  const query = {
    query: a.query || undefined,
    type: a.type === "dashboard" ? "dash-db" : a.type === "folder" ? "dash-folder" : undefined,
    tag: Array.isArray(a.tags) && a.tags.length ? a.tags : undefined,
    folderUIDs: Array.isArray(a.folder_uids) && a.folder_uids.length ? a.folder_uids : undefined,
    dashboardUIDs:
      Array.isArray(a.dashboard_uids) && a.dashboard_uids.length ? a.dashboard_uids : undefined,
    starred: a.starred === true ? true : undefined,
    limit,
    page: a.page ? clampInt(a.page, 1, 1, 1_000_000) : undefined,
  };
  const hits = await c.get("/api/search", query);
  if (!Array.isArray(hits) || hits.length === 0) return "no dashboards or folders match.";
  const lines = hits.map((h) => {
    const kind = h.type === "dash-folder" ? "folder" : "dashboard";
    const where = h.folderTitle ? ` in folder "${h.folderTitle}" (${h.folderUid})` : "";
    const tags = Array.isArray(h.tags) && h.tags.length ? ` tags=[${h.tags.join(", ")}]` : "";
    return `- ${kind} "${h.title}" uid=${h.uid}${where}${tags} ${c.link(h.url ?? "")}`;
  });
  lines.push(
    hits.length >= limit
      ? `\n${hits.length} results (the limit). There may be more: pass page=${(a.page || 1) + 1} or narrow the query.`
      : `\n${hits.length} results; that is all of them.`
  );
  return lines.join("\n");
}

function summarizeDashboard(dash, meta, c) {
  const out = [];
  out.push(`"${dash.title}" uid=${dash.uid} version=${dash.version} id=${dash.id}`);
  if (meta) {
    out.push(
      `folder: ${meta.folderTitle ? `"${meta.folderTitle}" (${meta.folderUid})` : "root"}  ` +
        `url: ${c.link(meta.url ?? "")}  updated: ${meta.updated ?? "?"} by ${meta.updatedBy ?? "?"}` +
        (meta.provisioned ? "  PROVISIONED (file-managed; API writes are refused)" : "")
    );
  }
  if (Array.isArray(dash.tags) && dash.tags.length) out.push(`tags: ${dash.tags.join(", ")}`);
  if (dash.time) out.push(`time: ${dash.time.from} → ${dash.time.to}  refresh: ${dash.refresh || "off"}`);
  const vars = dash.templating && Array.isArray(dash.templating.list) ? dash.templating.list : [];
  if (vars.length) {
    out.push(`variables (${vars.length}):`);
    for (const v of vars) out.push(`  $${v.name} (${v.type})${v.query ? `: ${clip(typeof v.query === "string" ? v.query : JSON.stringify(v.query), 100)}` : ""}`);
  }
  const panels = flattenPanels(dash.panels ?? dash.rows ?? []);
  out.push(`panels (${panels.length}):`);
  for (const p of panels) {
    const ds = p.datasource ? (typeof p.datasource === "string" ? p.datasource : p.datasource.uid) : "";
    out.push(`  #${p.id} ${p.type} "${p.title ?? ""}"${ds ? ` ds=${ds}` : ""}${p._row ? ` (in row "${p._row}")` : ""}`);
    for (const t of p.targets ?? []) {
      const expr = t.expr ?? t.query ?? t.rawSql ?? t.target ?? "";
      if (expr) out.push(`      ${t.refId ?? ""}: ${clip(String(expr).replace(/\s+/g, " "), 160)}`);
    }
  }
  out.push("\nPass full=true for the whole JSON model, or panel_id=N for one panel's JSON.");
  return out.join("\n");
}

function flattenPanels(panels, row) {
  const out = [];
  for (const p of panels) {
    if (!p) continue;
    if (p.type === "row") {
      out.push({ ...p, _row: row });
      if (Array.isArray(p.panels)) out.push(...flattenPanels(p.panels, p.title));
    } else if (Array.isArray(p.panels) && !p.type) {
      // Legacy `rows[]` shape.
      out.push(...flattenPanels(p.panels, p.title));
    } else {
      out.push(row ? { ...p, _row: row } : p);
    }
  }
  return out;
}

function findPanel(dash, id) {
  const want = Number(id);
  return flattenPanels(dash.panels ?? dash.rows ?? []).find((p) => Number(p.id) === want);
}

export async function dashboardGet(args, env) {
  const c = client(env);
  const uid = requireString(args?.uid, "uid");
  const r = await c.get(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
  const dash = r.dashboard ?? {};
  if (args?.panel_id !== undefined && args.panel_id !== null) {
    const p = findPanel(dash, args.panel_id);
    if (!p) throw new Error(`no panel with id ${args.panel_id} on dashboard ${uid}`);
    const { _row, ...clean } = p;
    return json(clean);
  }
  if (args?.full) return json({ dashboard: dash, meta: r.meta });
  return summarizeDashboard(dash, r.meta, c);
}

/** Set `value` at a dot/bracket path such as `panels[2].title` or `time.from`. */
export function setPath(obj, path, value) {
  const parts = [];
  for (const m of String(path).matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    parts.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  }
  if (!parts.length) throw new Error(`empty path`);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const nextIsIndex = typeof parts[i + 1] === "number";
    if (cur[k] === undefined || cur[k] === null) cur[k] = nextIsIndex ? [] : {};
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  if (value === null) {
    if (Array.isArray(cur) && typeof last === "number") cur.splice(last, 1);
    else delete cur[last];
  } else {
    cur[last] = value;
  }
}

export async function dashboardSave(args, env) {
  const c = client(env);
  const a = args ?? {};
  let dashboard = asObject(a.dashboard, "dashboard");
  const set = asObject(a.set, "set");
  const panelsAdd = a.panels_add !== undefined ? asObject(a.panels_add, "panels_add") : undefined;
  const panelsRemove = Array.isArray(a.panels_remove) ? a.panels_remove.map(Number) : [];
  const editing = !!(set || panelsAdd || panelsRemove.length);

  if (!dashboard && !editing) {
    throw new Error(
      "give `dashboard` (the full model to save) or `uid` with `set`/`panels_add`/`panels_remove` (edit the stored one)"
    );
  }
  if (!dashboard) {
    const uid = requireString(a.uid, "uid (needed when editing without a full dashboard)");
    const r = await c.get(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
    dashboard = r.dashboard;
    if (a.folder_uid === undefined && r.meta && r.meta.folderUid) a.folder_uid = r.meta.folderUid;
  } else if (editing) {
    // Edits over a supplied model are fine too.
  }

  if (set) for (const [path, value] of Object.entries(set)) setPath(dashboard, path, value);
  if (panelsAdd) {
    const list = Array.isArray(panelsAdd) ? panelsAdd : [panelsAdd];
    dashboard.panels = Array.isArray(dashboard.panels) ? dashboard.panels : [];
    const used = new Set(flattenPanels(dashboard.panels).map((p) => Number(p.id)));
    let next = 1;
    for (const p of list) {
      if (p.id === undefined || p.id === null || used.has(Number(p.id))) {
        while (used.has(next)) next++;
        p.id = next;
      }
      used.add(Number(p.id));
      dashboard.panels.push(p);
    }
  }
  if (panelsRemove.length) {
    const drop = new Set(panelsRemove);
    const prune = (list) =>
      list
        .filter((p) => !drop.has(Number(p.id)))
        .map((p) => (Array.isArray(p.panels) ? { ...p, panels: prune(p.panels) } : p));
    if (Array.isArray(dashboard.panels)) dashboard.panels = prune(dashboard.panels);
  }

  if (a.uid && !dashboard.uid) dashboard.uid = a.uid;
  if (a.title) dashboard.title = a.title;
  if (dashboard.id === undefined) dashboard.id = null;
  if (!dashboard.title) throw new Error("the dashboard needs a title");

  const body = {
    dashboard,
    overwrite: a.overwrite === true,
    message: a.message || undefined,
  };
  if (a.folder_uid !== undefined && a.folder_uid !== null) body.folderUid = a.folder_uid || "";

  const r = await c.post("/api/dashboards/db", body);
  return [
    `saved dashboard "${dashboard.title}" uid=${r.uid ?? dashboard.uid} version=${r.version ?? "?"} status=${r.status ?? "?"}`,
    `url: ${c.link(r.url ?? "")}`,
    editing ? `edits applied: ${[set && `set ${Object.keys(set).length} path(s)`, panelsAdd && "panels added", panelsRemove.length && `removed panels ${panelsRemove.join(",")}`].filter(Boolean).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function dashboardDelete(args, env) {
  const c = client(env);
  const uid = requireString(args?.uid, "uid");
  const r = await c.delete(`/api/dashboards/uid/${encodeURIComponent(uid)}`);
  return `deleted dashboard uid=${uid}${r.title ? ` "${r.title}"` : ""}. ${r.message ?? ""}`.trim();
}

export async function dashboardVersions(args, env) {
  const c = client(env);
  const uid = requireString(args?.uid, "uid");
  const a = args ?? {};
  if (a.restore_version !== undefined && a.restore_version !== null) {
    const r = await c.post(`/api/dashboards/uid/${encodeURIComponent(uid)}/restore`, {
      version: Number(a.restore_version),
    });
    return `restored dashboard uid=${uid} to version ${a.restore_version}; now version=${r.version ?? "?"} ${c.link(r.url ?? "")}`;
  }
  if (a.version !== undefined && a.version !== null) {
    const r = await c.get(`/api/dashboards/uid/${encodeURIComponent(uid)}/versions/${Number(a.version)}`);
    return json(r);
  }
  const limit = clampInt(a.limit, 20, 1, 1000);
  const r = await c.get(`/api/dashboards/uid/${encodeURIComponent(uid)}/versions`, {
    limit,
    start: a.start ? clampInt(a.start, 0, 0, 1_000_000) : undefined,
  });
  const versions = Array.isArray(r) ? r : Array.isArray(r.versions) ? r.versions : [];
  if (!versions.length) return `no versions recorded for dashboard ${uid}.`;
  const lines = versions.map(
    (v) => `- v${v.version} ${v.created ?? ""} by ${v.createdBy ?? "?"}${v.message ? ` — ${clip(v.message, 120)}` : ""}${v.restoredFrom ? ` (restored from v${v.restoredFrom})` : ""}`
  );
  lines.push(
    versions.length >= limit
      ? `\n${versions.length} shown (the limit); pass start=${(a.start || 0) + limit} for older ones.`
      : `\n${versions.length} versions; that is all of them.`
  );
  return lines.join("\n");
}

export async function dashboardPermissions(args, env) {
  const c = client(env);
  const uid = requireString(args?.uid, "uid");
  const items = args?.items !== undefined ? asObject(args.items, "items") : undefined;
  if (items) {
    if (!Array.isArray(items)) throw new Error("items must be an array of { role|teamId|userId, permission }");
    const r = await c.post(`/api/dashboards/uid/${encodeURIComponent(uid)}/permissions`, { items });
    return `permissions replaced on dashboard ${uid} (${items.length} item(s)). ${r.message ?? ""}`.trim();
  }
  const r = await c.get(`/api/dashboards/uid/${encodeURIComponent(uid)}/permissions`);
  if (!Array.isArray(r) || !r.length) return `no explicit permissions on dashboard ${uid}.`;
  const names = { 1: "View", 2: "Edit", 4: "Admin" };
  return r
    .map((p) => {
      const who = p.role ? `role ${p.role}` : p.teamId ? `team ${p.team ?? p.teamId} (id ${p.teamId})` : p.userId ? `user ${p.userLogin ?? p.userId} (id ${p.userId})` : "?";
      return `- ${who}: ${p.permissionName ?? names[p.permission] ?? p.permission}${p.inherited ? " (inherited)" : ""}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Folders (legacy /api/folders: works on Cloud and OSS, needs no namespace)

export async function folderList(args, env) {
  const c = client(env);
  const a = args ?? {};
  if (a.uid) {
    const f = await c.get(`/api/folders/${encodeURIComponent(a.uid)}`);
    return json(f);
  }
  const limit = clampInt(a.limit, 100, 1, 1000);
  const r = await c.get("/api/folders", {
    parentUid: a.parent_uid || undefined,
    limit,
    page: a.page ? clampInt(a.page, 1, 1, 1_000_000) : undefined,
  });
  if (!Array.isArray(r) || !r.length) return a.parent_uid ? `no subfolders under ${a.parent_uid}.` : "no folders.";
  const lines = r.map((f) => `- "${f.title}" uid=${f.uid}${f.parentUid ? ` parent=${f.parentUid}` : ""}`);
  lines.push(r.length >= limit ? `\n${r.length} shown (the limit); pass page=${(a.page || 1) + 1} for more.` : `\n${r.length} folders; that is all at this level.`);
  return lines.join("\n");
}

export async function folderSave(args, env) {
  const c = client(env);
  const a = args ?? {};
  const title = requireString(a.title, "title");
  if (a.uid) {
    let f;
    try {
      f = await c.get(`/api/folders/${encodeURIComponent(a.uid)}`);
    } catch (e) {
      if (!/returned 404/.test(e.message)) throw e;
    }
    if (f) {
      const r = await c.put(`/api/folders/${encodeURIComponent(a.uid)}`, {
        title,
        version: f.version,
        overwrite: a.overwrite === true,
        parentUid: a.parent_uid !== undefined ? a.parent_uid || "" : undefined,
      });
      return `updated folder "${r.title}" uid=${r.uid} version=${r.version ?? "?"} ${c.link(r.url ?? "")}`;
    }
  }
  const r = await c.post("/api/folders", {
    uid: a.uid || undefined,
    title,
    parentUid: a.parent_uid || undefined,
  });
  return `created folder "${r.title}" uid=${r.uid} ${c.link(r.url ?? "")}`;
}

export async function folderDelete(args, env) {
  const c = client(env);
  const uid = requireString(args?.uid, "uid");
  const r = await c.delete(`/api/folders/${encodeURIComponent(uid)}`, {
    forceDeleteRules: args?.force_delete_rules === true ? true : undefined,
  });
  return `deleted folder uid=${uid}${r.title ? ` "${r.title}"` : ""} and everything in it. ${r.message ?? ""}`.trim();
}

// ---------------------------------------------------------------------------
// Data sources

export async function datasourceList(args, env) {
  const c = client(env);
  const a = args ?? {};
  if (a.uid) {
    if (a.health) {
      const h = await c.get(`/api/datasources/uid/${encodeURIComponent(a.uid)}/health`);
      return `datasource ${a.uid} health: ${h.status ?? "?"} — ${h.message ?? ""}`.trim();
    }
    const ds = await c.get(`/api/datasources/uid/${encodeURIComponent(a.uid)}`);
    return json(redactDatasource(ds));
  }
  const list = await c.get("/api/datasources");
  if (!Array.isArray(list) || !list.length) return "no data sources.";
  return list
    .map(
      (d) =>
        `- "${d.name}" uid=${d.uid} type=${d.type}${d.isDefault ? " (default)" : ""}${d.url ? ` url=${d.url}` : ""}${d.readOnly ? " read-only" : ""}`
    )
    .join("\n");
}

function redactDatasource(ds) {
  // Grafana never returns secureJsonData, only secureJsonFields (which keys
  // are set). Basic-auth password fields are legacy and blanked anyway.
  const { password, basicAuthPassword, ...rest } = ds ?? {};
  return rest;
}

export async function datasourceSave(args, env) {
  const c = client(env);
  const a = args ?? {};
  const body = asObject(a.datasource, "datasource");
  if (!body) throw new Error("datasource is required: { name, type, url, access?, jsonData?, secureJsonData?, isDefault? }");
  if (a.uid) {
    // PUT needs the whole object; merge over the stored one so a partial edit
    // does not blank fields Grafana treats as absent.
    const cur = await c.get(`/api/datasources/uid/${encodeURIComponent(a.uid)}`);
    const merged = { ...cur, ...body, uid: a.uid, id: cur.id };
    delete merged.secureJsonFields;
    delete merged.password;
    delete merged.basicAuthPassword;
    if (body.jsonData) merged.jsonData = { ...(cur.jsonData ?? {}), ...body.jsonData };
    const r = await c.put(`/api/datasources/uid/${encodeURIComponent(a.uid)}`, merged);
    const d = r.datasource ?? r;
    return `updated datasource "${d.name}" uid=${d.uid} type=${d.type}. ${r.message ?? ""}`.trim();
  }
  if (!body.name || !body.type) throw new Error("a new datasource needs name and type");
  if (!body.access) body.access = "proxy";
  const r = await c.post("/api/datasources", body);
  const d = r.datasource ?? r;
  return `created datasource "${d.name}" uid=${d.uid} type=${d.type}. ${r.message ?? ""}`.trim();
}

export async function datasourceDelete(args, env) {
  const c = client(env);
  const uid = requireString(args?.uid, "uid");
  const r = await c.delete(`/api/datasources/uid/${encodeURIComponent(uid)}`);
  return `deleted datasource uid=${uid}. ${r.message ?? ""}`.trim();
}

export async function query(args, env) {
  const c = client(env);
  const a = args ?? {};
  const uid = requireString(a.datasource_uid, "datasource_uid");
  let queries = asObject(a.queries, "queries");
  if (!queries) {
    if (!a.expr) throw new Error("give `expr` (a single query string) or `queries` (an array of query models)");
    queries = [{ refId: "A", expr: a.expr }];
  }
  if (!Array.isArray(queries)) queries = [queries];
  const maxDataPoints = clampInt(a.max_data_points, 100, 1, 10_000);
  queries = queries.map((q, i) => ({
    refId: q.refId ?? String.fromCharCode(65 + i),
    datasource: { uid },
    maxDataPoints,
    intervalMs: q.intervalMs ?? 60_000,
    ...q,
  }));
  const body = { queries, from: String(a.from ?? "now-1h"), to: String(a.to ?? "now") };
  const r = await c.post("/api/ds/query", body);
  return formatQueryResult(r, a.raw === true);
}

function formatQueryResult(r, raw) {
  if (raw || !r.results) return json(r);
  const out = [];
  for (const [ref, res] of Object.entries(r.results)) {
    if (res.error) {
      out.push(`${ref}: ERROR ${res.error}`);
      continue;
    }
    const frames = Array.isArray(res.frames) ? res.frames : [];
    out.push(`${ref}: ${frames.length} frame(s)`);
    for (const f of frames) {
      const fields = f.schema?.fields ?? [];
      const values = f.data?.values ?? [];
      const rows = values[0]?.length ?? 0;
      const labels = fields.map((fl) => fl.labels ? JSON.stringify(fl.labels) : "").find(Boolean);
      out.push(`  frame "${f.schema?.name ?? ""}"${labels ? ` ${labels}` : ""}: ${rows} rows × ${fields.length} fields [${fields.map((fl) => `${fl.name}:${fl.type}`).join(", ")}]`);
      if (rows) {
        const show = Math.min(rows, 5);
        const tail = rows - show;
        for (let i = tail; i < rows; i++) {
          out.push(`    ${fields.map((fl, j) => fmtCell(values[j]?.[i], fl.type)).join("  |  ")}`);
        }
        if (tail > 0) out.push(`    (last ${show} of ${rows} rows shown; pass raw=true for everything)`);
      }
    }
  }
  return out.join("\n");
}

function fmtCell(v, type) {
  if (type === "time" && typeof v === "number") return new Date(v).toISOString();
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toPrecision(6);
  return clip(String(v ?? ""), 60);
}

// ---------------------------------------------------------------------------
// Annotations

export async function annotationList(args, env) {
  const c = client(env);
  const a = args ?? {};
  const limit = clampInt(a.limit, 50, 1, 1000);
  const r = await c.get("/api/annotations", {
    from: toEpochMs(a.from, "from"),
    to: toEpochMs(a.to, "to"),
    limit,
    dashboardUID: a.dashboard_uid || undefined,
    panelId: a.panel_id ?? undefined,
    type: a.type || undefined,
    tags: Array.isArray(a.tags) && a.tags.length ? a.tags : undefined,
  });
  if (!Array.isArray(r) || !r.length) return "no annotations match.";
  return r
    .map((x) => {
      const when = new Date(x.time).toISOString() + (x.timeEnd && x.timeEnd !== x.time ? ` → ${new Date(x.timeEnd).toISOString()}` : "");
      const where = x.dashboardUID ? ` dashboard=${x.dashboardUID}${x.panelId ? ` panel=${x.panelId}` : ""}` : " (org-wide)";
      const tags = Array.isArray(x.tags) && x.tags.length ? ` [${x.tags.join(", ")}]` : "";
      return `- id=${x.id} ${when}${where}${tags}: ${clip(x.text ?? "", 200)}`;
    })
    .concat(r.length >= limit ? [`\n${r.length} shown (the limit); narrow the time range or raise limit.`] : [])
    .join("\n");
}

export async function annotationCreate(args, env) {
  const c = client(env);
  const a = args ?? {};
  const text = requireString(a.text, "text");
  const body = {
    text,
    dashboardUID: a.dashboard_uid || undefined,
    panelId: a.panel_id ?? undefined,
    time: toEpochMs(a.time, "time") ?? Date.now(),
    timeEnd: toEpochMs(a.time_end, "time_end"),
    tags: Array.isArray(a.tags) ? a.tags : undefined,
  };
  const r = await c.post("/api/annotations", body);
  return `created annotation id=${r.id} at ${new Date(body.time).toISOString()}${body.dashboardUID ? ` on dashboard ${body.dashboardUID}` : " (org-wide)"}.`;
}

export async function annotationUpdate(args, env) {
  const c = client(env);
  const a = args ?? {};
  if (a.id === undefined || a.id === null) throw new Error("id is required");
  const body = {};
  if (a.text !== undefined) body.text = a.text;
  if (a.tags !== undefined) body.tags = a.tags;
  if (a.time !== undefined) body.time = toEpochMs(a.time, "time");
  if (a.time_end !== undefined) body.timeEnd = toEpochMs(a.time_end, "time_end");
  if (!Object.keys(body).length) throw new Error("nothing to change: give text, tags, time or time_end");
  const r = await c.patch(`/api/annotations/${encodeURIComponent(a.id)}`, body);
  return `updated annotation id=${a.id} (${Object.keys(body).join(", ")}). ${r.message ?? ""}`.trim();
}

export async function annotationDelete(args, env) {
  const c = client(env);
  if (args?.id === undefined || args.id === null) throw new Error("id is required");
  const r = await c.delete(`/api/annotations/${encodeURIComponent(args.id)}`);
  return `deleted annotation id=${args.id}. ${r.message ?? ""}`.trim();
}

// ---------------------------------------------------------------------------
// Alerting provisioning: rules, rule groups, contact points, policies,
// mute timings, templates.

const PROV = "/api/v1/provisioning";

export async function alertRuleList(args, env) {
  const c = client(env);
  const a = args ?? {};
  if (a.uid) {
    if (a.export) {
      const r = await c.get(`${PROV}/alert-rules/${encodeURIComponent(a.uid)}/export`, { format: a.export_format || "yaml" });
      return typeof r._raw === "string" ? r._raw : json(r);
    }
    return json(await c.get(`${PROV}/alert-rules/${encodeURIComponent(a.uid)}`));
  }
  if (a.export) {
    const r = await c.get(`${PROV}/alert-rules/export`, { format: a.export_format || "yaml", folderUid: a.folder_uid || undefined, group: a.group || undefined });
    return typeof r._raw === "string" ? r._raw : json(r);
  }
  let rules = await c.get(`${PROV}/alert-rules`);
  if (!Array.isArray(rules)) rules = [];
  if (a.folder_uid) rules = rules.filter((r) => r.folderUID === a.folder_uid);
  if (a.group) rules = rules.filter((r) => r.ruleGroup === a.group);
  if (!rules.length) return "no alert rules" + (a.folder_uid || a.group ? " match that folder/group." : ".");
  // Group by folder/group for a readable tree.
  const byGroup = new Map();
  for (const r of rules) {
    const k = `${r.folderUID}/${r.ruleGroup}`;
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(r);
  }
  const out = [];
  for (const [k, list] of byGroup) {
    out.push(`folder/group ${k}:`);
    for (const r of list) {
      const kind = r.record ? `recording → ${r.record.metric}` : `alert for=${r.for ?? "0s"}`;
      out.push(`  - "${r.title}" uid=${r.uid} ${kind}${r.isPaused ? " PAUSED" : ""}${r.provenance ? ` provenance=${r.provenance}` : ""}`);
    }
  }
  out.push(`\n${rules.length} rules in ${byGroup.size} group(s). Pass uid=... for one rule's full JSON.`);
  return out.join("\n");
}

export async function alertRuleSave(args, env) {
  const c = client(env);
  const a = args ?? {};
  const rule = asObject(a.rule, "rule");
  if (!rule) throw new Error("rule is required: the ProvisionedAlertRule JSON (title, ruleGroup, folderUID, condition, data[], for, noDataState, execErrState, labels, annotations)");
  const set = asObject(a.set, "set");
  const headers = provenanceHeaders(a.disable_provenance !== false);
  const uid = a.uid || rule.uid;

  if (uid) {
    let cur;
    try {
      cur = await c.get(`${PROV}/alert-rules/${encodeURIComponent(uid)}`);
    } catch (e) {
      if (!/returned 404/.test(e.message)) throw e;
    }
    if (cur) {
      const merged = { ...cur, ...rule, uid };
      if (set) for (const [p, v] of Object.entries(set)) setPath(merged, p, v);
      delete merged.provenance;
      const r = await c.put(`${PROV}/alert-rules/${encodeURIComponent(uid)}`, merged, undefined, headers);
      return `updated alert rule "${r.title}" uid=${r.uid} in ${r.folderUID}/${r.ruleGroup}${r.isPaused ? " (paused)" : ""}.`;
    }
  }
  if (set) for (const [p, v] of Object.entries(set)) setPath(rule, p, v);
  if (uid) rule.uid = uid;
  for (const k of ["title", "ruleGroup", "folderUID"]) if (!rule[k]) throw new Error(`a new rule needs ${k}`);
  if (!rule.condition && !rule.record) throw new Error("a new rule needs `condition` (alert) or `record` (recording rule)");
  if (!Array.isArray(rule.data) || !rule.data.length) throw new Error("a new rule needs data[] (queries and expressions)");
  rule.noDataState ??= "NoData";
  rule.execErrState ??= "Error";
  rule.for ??= "5m";
  const r = await c.post(`${PROV}/alert-rules`, rule, undefined, headers);
  return `created alert rule "${r.title}" uid=${r.uid} in ${r.folderUID}/${r.ruleGroup}.`;
}

export async function alertRuleDelete(args, env) {
  const c = client(env);
  const uid = requireString(args?.uid, "uid");
  await c.delete(`${PROV}/alert-rules/${encodeURIComponent(uid)}`, undefined, provenanceHeaders(true));
  return `deleted alert rule uid=${uid}.`;
}

export async function alertRuleGroup(args, env) {
  const c = client(env);
  const a = args ?? {};
  const folder = requireString(a.folder_uid, "folder_uid");
  const group = requireString(a.group, "group");
  const path = `${PROV}/folder/${encodeURIComponent(folder)}/rule-groups/${encodeURIComponent(group)}`;
  if (a.delete === true) {
    await c.delete(path, undefined, provenanceHeaders(true));
    return `deleted rule group ${folder}/${group} and every rule in it.`;
  }
  if (a.interval !== undefined || a.rules !== undefined) {
    const cur = await c.get(path);
    const body = { ...cur };
    if (a.interval !== undefined) body.interval = Number(a.interval);
    if (a.rules !== undefined) {
      const rules = asObject(a.rules, "rules");
      if (!Array.isArray(rules)) throw new Error("rules must be an array of rule objects");
      body.rules = rules;
    }
    const r = await c.put(path, body, undefined, provenanceHeaders(a.disable_provenance !== false));
    return `rule group ${folder}/${group}: interval=${r.interval}s, ${Array.isArray(r.rules) ? r.rules.length : "?"} rules.`;
  }
  const r = await c.get(path);
  const lines = [`rule group ${folder}/${group}: interval=${r.interval}s`];
  for (const rule of r.rules ?? []) lines.push(`  - "${rule.title}" uid=${rule.uid}${rule.isPaused ? " PAUSED" : ""}`);
  return lines.join("\n");
}

export async function contactPointList(args, env) {
  const c = client(env);
  const a = args ?? {};
  if (a.export) {
    const r = await c.get(`${PROV}/contact-points/export`, { format: a.export_format || "yaml", name: a.name || undefined, decrypt: a.decrypt === true ? true : undefined });
    return typeof r._raw === "string" ? r._raw : json(r);
  }
  const list = await c.get(`${PROV}/contact-points`, { name: a.name || undefined });
  if (!Array.isArray(list) || !list.length) return "no contact points.";
  if (a.name) return json(list);
  return list
    .map((p) => `- "${p.name}" uid=${p.uid} type=${p.type}${p.disableResolveMessage ? " no-resolve" : ""}${p.provenance ? ` provenance=${p.provenance}` : ""}`)
    .concat([`\n${list.length} integrations (a contact point with several integrations appears once per integration, same name). Pass name=... for full settings.`])
    .join("\n");
}

export async function contactPointSave(args, env) {
  const c = client(env);
  const a = args ?? {};
  const cp = asObject(a.contact_point, "contact_point");
  if (!cp) throw new Error("contact_point is required: { name, type, settings, disableResolveMessage? }");
  const headers = provenanceHeaders(a.disable_provenance !== false);
  const uid = a.uid || cp.uid;
  if (uid) {
    const list = await c.get(`${PROV}/contact-points`);
    const cur = Array.isArray(list) ? list.find((p) => p.uid === uid) : undefined;
    if (cur) {
      const merged = { ...cur, ...cp, uid };
      if (cp.settings) merged.settings = { ...(cur.settings ?? {}), ...cp.settings };
      delete merged.provenance;
      await c.put(`${PROV}/contact-points/${encodeURIComponent(uid)}`, merged, undefined, headers);
      return `updated contact point "${merged.name}" uid=${uid} type=${merged.type}.`;
    }
  }
  if (!cp.name || !cp.type) throw new Error("a new contact point needs name and type");
  if (uid) cp.uid = uid;
  const r = await c.post(`${PROV}/contact-points`, cp, undefined, headers);
  return `created contact point "${r.name}" uid=${r.uid} type=${r.type}.`;
}

export async function contactPointDelete(args, env) {
  const c = client(env);
  const uid = requireString(args?.uid, "uid");
  await c.delete(`${PROV}/contact-points/${encodeURIComponent(uid)}`, undefined, provenanceHeaders(true));
  return `deleted contact point uid=${uid}.`;
}

export async function notificationPolicies(args, env) {
  const c = client(env);
  const a = args ?? {};
  if (a.reset === true) {
    await c.delete(`${PROV}/policies`);
    return "notification policy tree reset to the default and unlocked for UI editing.";
  }
  const tree = asObject(a.tree, "tree");
  if (tree) {
    await c.put(`${PROV}/policies`, tree, undefined, provenanceHeaders(a.disable_provenance !== false));
    return `notification policy tree replaced: root receiver "${tree.receiver}", ${countRoutes(tree)} nested route(s).`;
  }
  if (a.export) {
    const r = await c.get(`${PROV}/policies/export`, { format: a.export_format || "yaml" });
    return typeof r._raw === "string" ? r._raw : json(r);
  }
  return json(await c.get(`${PROV}/policies`));
}

function countRoutes(node) {
  if (!node || !Array.isArray(node.routes)) return 0;
  return node.routes.reduce((n, r) => n + 1 + countRoutes(r), 0);
}

export async function muteTimings(args, env) {
  const c = client(env);
  const a = args ?? {};
  const action = a.action || (a.mute_timing ? "save" : a.name ? "get" : "list");
  switch (action) {
    case "list": {
      const list = await c.get(`${PROV}/mute-timings`);
      if (!Array.isArray(list) || !list.length) return "no mute timings.";
      return list.map((m) => `- "${m.name}" ${Array.isArray(m.time_intervals) ? m.time_intervals.length : 0} interval(s)${m.provenance ? ` provenance=${m.provenance}` : ""}`).join("\n");
    }
    case "get":
      return json(await c.get(`${PROV}/mute-timings/${encodeURIComponent(requireString(a.name, "name"))}`));
    case "export": {
      const r = await c.get(a.name ? `${PROV}/mute-timings/${encodeURIComponent(a.name)}/export` : `${PROV}/mute-timings/export`, { format: a.export_format || "yaml" });
      return typeof r._raw === "string" ? r._raw : json(r);
    }
    case "save": {
      const mt = asObject(a.mute_timing, "mute_timing");
      if (!mt) throw new Error("mute_timing is required: { name, time_intervals: [...] }");
      const name = a.name || mt.name;
      if (!name) throw new Error("a mute timing needs a name");
      mt.name = name;
      const headers = provenanceHeaders(a.disable_provenance !== false);
      let exists = false;
      try {
        await c.get(`${PROV}/mute-timings/${encodeURIComponent(name)}`);
        exists = true;
      } catch (e) {
        if (!/returned 404/.test(e.message)) throw e;
      }
      if (exists) {
        await c.put(`${PROV}/mute-timings/${encodeURIComponent(name)}`, mt, undefined, headers);
        return `replaced mute timing "${name}".`;
      }
      await c.post(`${PROV}/mute-timings`, mt, undefined, headers);
      return `created mute timing "${name}".`;
    }
    case "delete":
      await c.delete(`${PROV}/mute-timings/${encodeURIComponent(requireString(a.name, "name"))}`, undefined, provenanceHeaders(true));
      return `deleted mute timing "${a.name}".`;
    default:
      throw new Error(`unknown action ${action}; use list, get, save, delete or export`);
  }
}

export async function templates(args, env) {
  const c = client(env);
  const a = args ?? {};
  const action = a.action || (a.template !== undefined ? "save" : a.name ? "get" : "list");
  switch (action) {
    case "list": {
      const list = await c.get(`${PROV}/templates`);
      if (!Array.isArray(list) || !list.length) return "no notification templates.";
      return list.map((t) => `- "${t.name}" (${String(t.template ?? "").length} chars)${t.provenance ? ` provenance=${t.provenance}` : ""}`).join("\n");
    }
    case "get": {
      const t = await c.get(`${PROV}/templates/${encodeURIComponent(requireString(a.name, "name"))}`);
      return `template "${t.name}"${t.provenance ? ` provenance=${t.provenance}` : ""}:\n\n${t.template ?? ""}`;
    }
    case "save": {
      const name = requireString(a.name, "name");
      if (typeof a.template !== "string") throw new Error("template is required: the Go template text");
      const r = await c.put(`${PROV}/templates/${encodeURIComponent(name)}`, { template: a.template }, undefined, provenanceHeaders(a.disable_provenance !== false));
      return `saved template "${r.name ?? name}" (${a.template.length} chars).`;
    }
    case "delete":
      await c.delete(`${PROV}/templates/${encodeURIComponent(requireString(a.name, "name"))}`, undefined, provenanceHeaders(true));
      return `deleted template "${a.name}".`;
    default:
      throw new Error(`unknown action ${action}; use list, get, save or delete`);
  }
}

// ---------------------------------------------------------------------------
// The escape hatch: any endpoint.

export async function request(args, env) {
  const c = client(env);
  const a = args ?? {};
  const method = String(a.method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error(`method must be GET, POST, PUT, PATCH or DELETE`);
  let path = requireString(a.path, "path");
  if (/^https?:\/\//i.test(path)) throw new Error("path is relative to the configured Grafana url, for example /api/teams/search");
  path = path.replace(/\{namespace\}/g, encodeURIComponent(c.namespace));
  if (!path.startsWith("/")) path = `/${path}`;
  if (!path.startsWith("/api")) throw new Error("path must start with /api/ (legacy) or /apis/ (app platform)");
  const query = asObject(a.query, "query");
  const body = a.body !== undefined ? asObject(a.body, "body") : undefined;
  const headers = asObject(a.headers, "headers");
  if (headers) for (const k of Object.keys(headers)) if (/^authorization$/i.test(k)) delete headers[k];
  const r = await c.send(method, path, query, body, headers);
  if (typeof r._raw === "string") return r._raw.length > 18_000 ? `${r._raw.slice(0, 18_000)}\n… [cut]` : r._raw;
  return json(r);
}

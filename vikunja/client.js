// Shared Vikunja HTTP API client, formatting and error handling.
//
// Every vikunja_* tool imports this one module. It talks to one Vikunja
// instance over the platform's global fetch (Node ships it; nothing to
// install). All routes live under <url>/api/v1.
//
// Vikunja's REST conventions, which every tool here follows:
//   GET    read
//   PUT    create        (yes, PUT creates; a body with no id)
//   POST   update        (a full object; missing fields are zeroed for some
//                         models, so tools read-merge-write)
//   DELETE delete
// Pagination: `page` and `per_page` query params; the response carries
// `x-pagination-total-pages` and `x-pagination-result-count` headers.

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_CHARS = 18_000;

const MISSING_URL =
  "no Vikunja URL configured. Set the key `url` on this package to the instance's base URL, " +
  "for example http://vikunja.local:3456 or https://tasks.example.com (without /api/v1). The " +
  "person can do it in the control panel (Configure on the package), or you can call " +
  "configure_package with the value they give you.";

const MISSING_TOKEN =
  "no Vikunja API token configured. In Vikunja open Settings → API Tokens, create a token with " +
  "the permissions the tasks need (projects, tasks, labels at least; add project views and " +
  "buckets for kanban), then set the key `token` on this package. The person can do it in the " +
  "control panel (Configure on the package), or you can call configure_package with the value " +
  "they give you. Every vikunja_* tool reads the same key, so it is set once.\n\n" +
  "To see why it is missing, call package_config for this package: it reports whether the key " +
  "was never set, was set to a ${VAR} reference that is not in the environment, or is inherited " +
  "from the package this one was forked from. The change is live on the next call.";

/**
 * Builds a client from this package's own config block (`env.config`).
 * `url` and `token` come from config and nowhere else.
 */
export function createClient(config) {
  const cfg = config && typeof config === "object" ? config : {};

  const rawUrl = typeof cfg.url === "string" ? cfg.url.trim() : "";
  if (!rawUrl) throw new Error(MISSING_URL);
  let base;
  try {
    base = new URL(rawUrl);
  } catch {
    throw new Error(`the configured Vikunja url is not a URL: ${clip(rawUrl, 80)}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`the configured Vikunja url must be http(s), got ${base.protocol}`);
  }
  // Accept a URL that already ends in /api/v1 and one that does not.
  const baseUrl = base.toString().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const apiUrl = `${baseUrl}/api/v1`;

  const token = typeof cfg.token === "string" ? cfg.token.trim() : "";
  if (!token) throw new Error(MISSING_TOKEN);

  const timeoutMs = Math.min(
    120_000,
    Math.max(5_000, Number(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
  );

  async function send(method, path, query, body, extraHeaders) {
    const url = new URL(apiUrl + (path.startsWith("/") ? path : `/${path}`));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers = {
      // The token is used here and only here. It is never interpolated into
      // any string this module returns to a caller or to an error.
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (extraHeaders) Object.assign(headers, extraHeaders);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      throw new Error(`could not reach ${base.host}: ${e && e.message ? e.message : e}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    if (response.status >= 200 && response.status < 300) {
      let data = {};
      if (text.trim()) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { _raw: text };
        }
      }
      const totalPages = Number(response.headers.get("x-pagination-total-pages"));
      const resultCount = Number(response.headers.get("x-pagination-result-count"));
      const maxPermission = response.headers.get("x-max-permission");
      // Attach paging meta without touching array/object shape for callers.
      Object.defineProperty(data, "_meta", {
        enumerable: false,
        value: {
          totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : undefined,
          resultCount: Number.isFinite(resultCount) ? resultCount : undefined,
          maxPermission: maxPermission !== null ? Number(maxPermission) : undefined,
        },
      });
      return data;
    }

    throw new Error(explainError(response.status, text, method, url.pathname));
  }

  return {
    baseUrl,
    apiUrl,
    host: base.host,
    get(path, query, headers) {
      return send("GET", path, query, undefined, headers);
    },
    /** Vikunja creates with PUT. */
    put(path, body, query, headers) {
      return send("PUT", path, query, body ?? {}, headers);
    },
    /** Vikunja updates with POST. */
    post(path, body, query, headers) {
      return send("POST", path, query, body ?? {}, headers);
    },
    patch(path, body, query, headers) {
      return send("PATCH", path, query, body ?? {}, headers);
    },
    delete(path, query, headers) {
      return send("DELETE", path, query, undefined, headers);
    },
    send,
    /** UI links for the person to click. */
    link: {
      project: (id) => `${baseUrl}/projects/${id}`,
      view: (projectId, viewId) => `${baseUrl}/projects/${projectId}/${viewId}`,
      task: (id) => `${baseUrl}/tasks/${id}`,
    },
  };
}

/**
 * Vikunja errors are `{ code, message }` with an application error code
 * (https://vikunja.io/docs/errors). Use the message, add a hint for the
 * statuses and codes that have a usual cause.
 */
export function explainError(status, text, method, path) {
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  const message =
    typeof parsed.message === "string" ? parsed.message : text.trim() || `HTTP ${status}`;
  const code = parsed.code !== undefined ? Number(parsed.code) : undefined;

  let hint;
  if (status === 401) {
    hint =
      "The token was rejected or has expired. Check the `token` configured for this package: " +
      "a Vikunja API token starts with `tk_`. Create one in Settings → API Tokens.";
  } else if (status === 403 && /token.*(route|permission|scope)|not have.*permission.*route/i.test(message)) {
    hint =
      "The API token was created without permission for this route. Edit or recreate it in " +
      "Settings → API Tokens with the matching permission group ticked (e.g. tasks, projects, " +
      "project views, kanban buckets, labels).";
  } else if (status === 403) {
    hint = "The user behind the token has no access to this item, or read-only access to it.";
  } else if (status === 404) {
    hint = "Nothing at that id. Find it with vikunja_projects, vikunja_views or vikunja_tasks first.";
  } else if (status === 412 && code === 3001) {
    hint = "The project was not found. List projects with vikunja_projects.";
  } else if (status === 400 && code === 10004) {
    hint = "The bucket is full: its WIP `limit` is reached. Raise the limit or move something out first.";
  } else if (status === 400 && code === 10003) {
    hint = "You cannot remove the last bucket of a kanban view.";
  } else if (status === 400 && code === 10005) {
    hint = "That bucket belongs to a different view or project than the one named in the path.";
  } else if (status === 400 && code === 10001) {
    hint = "Bucket not found in this view. List buckets with vikunja_board.";
  } else if (status === 400 && code === 5006) {
    hint = "Filter error: " + (parsed.message || "") + ". See https://vikunja.io/docs/filters for the syntax.";
  } else if (status === 400 && code === 4013) {
    hint = "The relation kind is invalid. Allowed: subtask, parenttask, related, duplicateof, duplicates, blocking, blocked, precedes, follows, copiedfrom, copiedto.";
  } else if (status === 400 && code === 4002) {
    hint = "The task title must not be empty.";
  } else if (status === 400) {
    hint = "Vikunja rejected the request body. The message names the field; check its type (dates are RFC 3339 strings, ids are integers).";
  } else if (status >= 500) {
    hint = "Vikunja itself failed. Retry once; if it persists, the instance's logs have the trace.";
  }

  let out = `Vikunja ${method ?? ""} ${path ?? ""} returned ${status}`;
  if (code !== undefined && Number.isFinite(code)) out += ` [code ${code}]`;
  out += `: ${clip(message, 600)}`;
  if (hint) out += `\n${hint}`;
  return out;
}

// ---------------------------------------------------------------------------
// Formatting helpers shared by the tools.

export function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** JSON for the model, cut at a bound with a note that says so. */
export function json(value, max = MAX_OUTPUT_CHARS) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n… [cut at ${max} characters of ${text.length}; ask for a narrower field or a smaller limit]`
  );
}

export function asObject(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (e) {
      throw new Error(`${name} must be a JSON object (or a JSON string of one): ${e.message}`);
    }
  }
  throw new Error(`${name} must be a JSON object`);
}

export function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function intArg(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${clip(String(value), 40)}`);
  return n;
}

export function requireInt(value, name) {
  const n = intArg(value, name);
  if (n === undefined) throw new Error(`${name} is required`);
  return n;
}

export function numArg(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${clip(String(value), 40)}`);
  return n;
}

export function boolArg(value, def = false) {
  if (value === undefined || value === null || value === "") return def;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return def;
}

export function listArg(value, name, { items = "string" } = {}) {
  if (value === undefined || value === null || value === "") return undefined;
  let list = value;
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("[")) {
      try {
        list = JSON.parse(s);
      } catch (e) {
        throw new Error(`${name} looks like JSON but does not parse: ${e.message}`);
      }
    } else {
      list = s.split(",").map((x) => x.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) list = [list];
  if (!list.length) return undefined;
  if (items === "integer") return list.map((x, i) => intArg(x, `${name}[${i}]`));
  if (items === "object") {
    return list.map((x, i) => {
      const o = asObject(x, `${name}[${i}]`);
      if (!o) throw new Error(`${name}[${i}] must be an object`);
      return o;
    });
  }
  return list.map((x) => String(x));
}

export function clampInt(value, def, min, max) {
  const n = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : def;
  return Math.min(max, Math.max(min, n));
}

/**
 * Vikunja's zero time is "0001-01-01T00:00:00Z". Treat it as unset.
 */
export function isZeroDate(s) {
  return !s || typeof s !== "string" || s.startsWith("0001-01-01");
}

/**
 * A date argument: ISO / RFC 3339 pass through normalised; "" or null clears
 * (Vikunja clears a date with the zero time). Also accepts relative
 * shorthands the model tends to send: "today", "tomorrow", "+3d", "+2w".
 */
export function dateArg(value, name) {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "none" || value === "clear") return "0001-01-01T00:00:00Z";
  const s = String(value).trim();
  const now = new Date();
  const endOfDay = (d) => {
    d.setUTCHours(23, 59, 0, 0);
    return d.toISOString();
  };
  if (/^today$/i.test(s)) return endOfDay(new Date(now));
  if (/^tomorrow$/i.test(s)) return endOfDay(new Date(now.getTime() + 86_400_000));
  const rel = /^\+(\d+)([dwhm])$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { d: 86_400_000, w: 7 * 86_400_000, h: 3_600_000, m: 60_000 }[rel[2].toLowerCase()];
    return new Date(now.getTime() + n * unit).toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`${name} must be an ISO 8601 date, "today", "tomorrow", "+3d", or "" to clear; got ${clip(s, 40)}`);
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// Compact views of Vikunja objects, so a board fits in the model's window.

export function briefUser(u) {
  if (!u || typeof u !== "object") return undefined;
  return { id: u.id, username: u.username, name: u.name || undefined };
}

export function briefLabel(l) {
  if (!l || typeof l !== "object") return undefined;
  return { id: l.id, title: l.title, color: l.hex_color || undefined };
}

export function briefTask(t, { withDescription = false } = {}) {
  if (!t || typeof t !== "object") return t;
  const out = {
    id: t.id,
    identifier: t.identifier || undefined,
    title: t.title,
    done: t.done,
    project_id: t.project_id,
  };
  if (t.bucket_id) out.bucket_id = t.bucket_id;
  if (t.priority) out.priority = t.priority;
  if (t.percent_done) out.percent_done = t.percent_done;
  if (!isZeroDate(t.due_date)) out.due_date = t.due_date;
  if (!isZeroDate(t.start_date)) out.start_date = t.start_date;
  if (!isZeroDate(t.end_date)) out.end_date = t.end_date;
  if (!isZeroDate(t.done_at)) out.done_at = t.done_at;
  if (Array.isArray(t.labels) && t.labels.length) out.labels = t.labels.map(briefLabel);
  if (Array.isArray(t.assignees) && t.assignees.length) out.assignees = t.assignees.map(briefUser);
  if (t.repeat_after) out.repeat_after = t.repeat_after;
  if (t.is_favorite) out.is_favorite = true;
  if (t.hex_color) out.color = t.hex_color;
  if (t.comment_count) out.comment_count = t.comment_count;
  if (Array.isArray(t.attachments) && t.attachments.length) out.attachments = t.attachments.length;
  if (t.related_tasks && typeof t.related_tasks === "object") {
    const rel = {};
    for (const [kind, list] of Object.entries(t.related_tasks)) {
      if (Array.isArray(list) && list.length) rel[kind] = list.map((r) => ({ id: r.id, title: r.title, done: r.done }));
    }
    if (Object.keys(rel).length) out.related_tasks = rel;
  }
  if (withDescription && t.description) out.description = stripHtml(t.description);
  else if (t.description && stripHtml(t.description).trim()) out.has_description = true;
  if (t.position !== undefined) out.position = t.position;
  return out;
}

export function briefProject(p) {
  if (!p || typeof p !== "object") return p;
  const out = {
    id: p.id,
    title: p.title,
    identifier: p.identifier || undefined,
  };
  if (p.parent_project_id) out.parent_project_id = p.parent_project_id;
  if (p.is_archived) out.is_archived = true;
  if (p.is_favorite) out.is_favorite = true;
  if (p.description && stripHtml(p.description).trim()) out.description = clip(stripHtml(p.description), 200);
  if (Array.isArray(p.views) && p.views.length) out.views = p.views.map(briefView);
  return out;
}

export function briefView(v) {
  if (!v || typeof v !== "object") return v;
  const out = { id: v.id, title: v.title, kind: v.view_kind, position: v.position };
  if (v.view_kind === "kanban") {
    out.bucket_configuration_mode = v.bucket_configuration_mode;
    if (v.default_bucket_id) out.default_bucket_id = v.default_bucket_id;
    if (v.done_bucket_id) out.done_bucket_id = v.done_bucket_id;
  }
  if (v.filter && typeof v.filter === "object" && v.filter.filter) out.filter = v.filter.filter;
  else if (typeof v.filter === "string" && v.filter) out.filter = v.filter;
  return out;
}

export function briefBucket(b, opts) {
  if (!b || typeof b !== "object") return b;
  const out = { id: b.id, title: b.title, position: b.position };
  if (b.limit) out.limit = b.limit;
  if (b.count !== undefined) out.count = b.count;
  if (Array.isArray(b.tasks)) out.tasks = b.tasks.map((t) => briefTask(t, opts));
  return out;
}

export function briefComment(c) {
  if (!c || typeof c !== "object") return c;
  return { id: c.id, author: briefUser(c.author), created: c.created, comment: stripHtml(c.comment) };
}

/** Vikunja stores descriptions and comments as HTML. Strip to text for the model. */
export function stripHtml(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain text (or markdown-ish) to the minimal HTML Vikunja's editor renders. */
export function toHtml(s) {
  if (typeof s !== "string") return s;
  if (/<[a-z][\s\S]*>/i.test(s)) return s; // already HTML
  const esc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return s
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

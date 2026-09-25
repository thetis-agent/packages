// Shared Grafana HTTP API client, formatting and error handling.
//
// Every grafana_* tool imports this one module. It talks to one Grafana
// instance — Grafana Cloud stack or self-hosted — over the platform's global
// fetch. Node ships fetch built in, so there is nothing to install.
//
// Two API families live behind one base URL:
//   /api/...          the legacy REST API (search, datasources, annotations,
//                     alerting provisioning, teams, service accounts…)
//   /apis/<group>/... the new Kubernetes-style app-platform API
//                     (dashboard.grafana.app, folder.grafana.app), which needs
//                     a namespace: `default` on self-hosted, `stacks-<id>` on
//                     Grafana Cloud.
// This client carries both: `get/post/put/patch/delete` for either path, and
// `namespace()` for the second.

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_CHARS = 18_000;

const MISSING_URL =
  "no Grafana URL configured. Set the key `url` on this package to the instance's base " +
  "URL, for example https://myorg.grafana.net for a Grafana Cloud stack or " +
  "http://localhost:3000 for a local instance. The person can do it in the control panel " +
  "(Configure on the package), or you can call configure_package with the value they give you.";

const MISSING_TOKEN =
  "no Grafana token configured. Create a service account (Administration → Users and " +
  "access → Service accounts) with the role the task needs, add a token, then set the key " +
  "`token` on this package. The person can do it in the control panel (Configure on the " +
  "package), or you can call configure_package with the value they give you. Every " +
  "grafana_* tool reads the same key, so it is set once.\n\n" +
  "To see why it is missing, call package_config for this package: it reports whether the " +
  "key was never set, was set to a ${VAR} reference that is not in the environment, or is " +
  "inherited from the package this one was forked from. The change is live on the next call.";

/**
 * Builds a client from this package's own config block (`env.config`).
 *
 * `url` and `token` come from config and nowhere else — no environment
 * fallback, no default instance. That is the one place to look to know which
 * Grafana a tool is talking to and as whom.
 */
export function createClient(config) {
  const cfg = config && typeof config === "object" ? config : {};

  const rawUrl = typeof cfg.url === "string" ? cfg.url.trim() : "";
  if (!rawUrl) throw new Error(MISSING_URL);
  let base;
  try {
    base = new URL(rawUrl);
  } catch {
    throw new Error(`the configured Grafana url is not a URL: ${clip(rawUrl, 80)}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`the configured Grafana url must be http(s), got ${base.protocol}`);
  }
  // Strip a trailing slash so path joins are predictable. Keep a sub-path
  // (Grafana served under /grafana) intact.
  const baseUrl = base.toString().replace(/\/+$/, "");

  const token = typeof cfg.token === "string" ? cfg.token.trim() : "";
  if (!token) throw new Error(MISSING_TOKEN);

  const namespace =
    typeof cfg.namespace === "string" && cfg.namespace.trim() ? cfg.namespace.trim() : "default";
  const orgId =
    cfg.orgId !== undefined && cfg.orgId !== null && String(cfg.orgId).trim() !== ""
      ? String(cfg.orgId).trim()
      : undefined;
  const timeoutMs = Math.min(
    120_000,
    Math.max(5_000, Number(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
  );

  async function send(method, path, query, body, extraHeaders) {
    const url = new URL(baseUrl + (path.startsWith("/") ? path : `/${path}`));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
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
    if (orgId) headers["X-Grafana-Org-Id"] = orgId;
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
      if (!text.trim()) return {};
      try {
        return JSON.parse(text);
      } catch {
        // Some endpoints (export in YAML, proxy) return non-JSON. Hand it back.
        return { _raw: text };
      }
    }

    throw new Error(explainError(response.status, text, method, url.pathname));
  }

  const client = {
    baseUrl,
    host: base.host,
    namespace,
    get(path, query, headers) {
      return send("GET", path, query, undefined, headers);
    },
    post(path, body, query, headers) {
      return send("POST", path, query, body ?? {}, headers);
    },
    put(path, body, query, headers) {
      return send("PUT", path, query, body ?? {}, headers);
    },
    patch(path, body, query, headers) {
      return send("PATCH", path, query, body ?? {}, headers);
    },
    delete(path, query, headers) {
      return send("DELETE", path, query, undefined, headers);
    },
    send,
    /** Path prefix of an app-platform API group for the configured namespace. */
    apis(group, version = "v1") {
      return `/apis/${group}/${version}/namespaces/${encodeURIComponent(namespace)}`;
    },
    /** A UI link for a dashboard or folder path, for the person to click. */
    link(path) {
      return baseUrl + (path.startsWith("/") ? path : `/${path}`);
    },
  };

  return client;
}

/**
 * Grafana errors are `{ message, messageId?, traceID? }` on legacy routes and
 * a Kubernetes `Status` (`{ message, reason, code }`) on /apis routes. Both
 * carry a human message; use it, and add a hint for the statuses that have a
 * usual cause. Never includes the token: it is not in the response body, and
 * nothing here reads config to add it back in.
 */
export function explainError(status, text, method, path) {
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON; fall through
  }
  const message =
    typeof parsed.message === "string"
      ? parsed.message
      : typeof parsed.error === "string"
        ? parsed.error
        : text.trim();
  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  const messageId = typeof parsed.messageId === "string" ? parsed.messageId : "";

  let hint;
  if (status === 401) {
    hint =
      "The token was rejected. Check the `token` configured for this package: a Grafana " +
      "service account token starts with `glsa_`. A Grafana Cloud *access policy* token " +
      "(`glc_`) is for the Cloud API, not for the instance's HTTP API, and will not work here.";
  } else if (status === 403) {
    hint =
      "The service account lacks the permission this call needs. Give it a higher basic role " +
      "(Viewer < Editor < Admin) or a fixed RBAC role that carries the action named in the message.";
  } else if (status === 404 && path && path.startsWith("/apis/")) {
    hint =
      "Either the uid is wrong, or the namespace is: on Grafana Cloud the namespace is " +
      "`stacks-<stack id>`, on self-hosted it is `default`. Check the `namespace` key on " +
      "this package, or run grafana_health to see what the instance reports.";
  } else if (status === 404) {
    hint = "Nothing at that uid/id. Find it with grafana_search or the matching list tool first.";
  } else if (status === 412) {
    hint =
      "A precondition failed: usually the dashboard exists and `overwrite` is false, or the " +
      "version you sent is behind the stored one. Read it again and resend with overwrite.";
  } else if (status === 409) {
    hint = "Conflict: a resource with that uid or name already exists, or the version is stale.";
  } else if (status === 400 && /provenance/i.test(message)) {
    hint =
      "The resource was provisioned by another source (Terraform, files, or this API without " +
      "disable_provenance). Pass disable_provenance: true to edit it from here and in the UI.";
  } else if (status >= 500) {
    hint = "Grafana itself failed. Retry once; if it persists, the instance's logs have the trace.";
  }

  let out = `Grafana ${method ?? ""} ${path ?? ""} returned ${status}`;
  if (reason) out += ` (${reason})`;
  if (messageId) out += ` [${messageId}]`;
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

/** Coerce a tool argument that may be a JSON string or an object into an object. */
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

export function clampInt(value, def, min, max) {
  const n = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : def;
  return Math.min(max, Math.max(min, n));
}

/** Time strings Grafana accepts (`now-1h`, ISO) or epoch ms pass through. */
export function toEpochMs(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const d = Date.parse(s);
  if (Number.isNaN(d)) throw new Error(`${name} must be epoch milliseconds or an ISO date, got ${clip(s, 40)}`);
  return d;
}

/**
 * Headers for an alerting-provisioning write. `X-Disable-Provenance: true`
 * leaves the resource editable in the Grafana UI afterwards; without it the
 * resource is marked as provisioned by "api" and the UI locks it.
 */
export function provenanceHeaders(disable) {
  return disable ? { "X-Disable-Provenance": "true" } : undefined;
}

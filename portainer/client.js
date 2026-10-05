// Shared Portainer HTTP API client, response shaping and error handling.
//
// Every portainer_* tool imports this one module. It talks to one Portainer
// server over node:http / node:https rather than fetch, because a Portainer
// on :9443 usually has a self-signed certificate and `insecureTls` has to be
// able to say so for this client alone. All routes live under <url>/api.
//
// Portainer's API has three layers, and the tools follow them:
//   /api/...                                  Portainer's own objects: environments
//                                             (endpoints), stacks, users, settings
//   /api/endpoints/{id}/docker/...            the Docker Engine API of one environment,
//                                             forwarded as-is by Portainer
//   /api/endpoints/{id}/kubernetes/...        the Kubernetes API of one environment, same
// The credential is an access token (ptr_…) from My account → Access tokens,
// sent as X-API-Key.
//
// Two habits borrowed from portainer/portainer-mcp: environment-variable
// values are redacted from every answer unless `exposeEnv` is set (stack Env
// pairs, Docker KEY=VAL lists, Kubernetes env[].value; valueFrom references
// stay), and every list can be cut down to named fields before it reaches the
// model, because raw Docker and Kubernetes objects are large.

import http from "node:http";
import https from "node:https";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_CHARS = 20_000;
export const REDACTED = "[REDACTED]";

const MISSING_URL =
  "no Portainer URL configured. Set the key `url` on this package to the server's base URL, for " +
  "example https://portainer.example.com:9443 or http://10.0.0.5:9000 (without /api). The person " +
  "can do it in the control panel (Configure on the package), or you can call configure_package " +
  "with the value they give you.";

const MISSING_TOKEN =
  "no Portainer access token configured. In Portainer open My account → Access tokens → Add " +
  "access token, then set the key `token` on this package to the value it shows once (it starts " +
  "with ptr_). The person can do it in the control panel (Configure on the package), or you can " +
  "call configure_package with the value they give you. Every portainer_* tool reads the same key.\n\n" +
  "To see why it is missing, call package_config for this package: it reports whether the key was " +
  "never set, was set to a ${VAR} reference that is not in the environment, or is inherited from " +
  "the package this one was forked from. The change is live on the next call.";

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
    throw new Error(`the configured Portainer url is not a URL: ${clip(rawUrl, 80)}`);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`the configured Portainer url must be http(s), got ${base.protocol}`);
  }
  // Accept a URL that already ends in /api and one that does not.
  const baseUrl = base.toString().replace(/\/+$/, "").replace(/\/api$/, "");
  const apiUrl = `${baseUrl}/api`;

  const token = typeof cfg.token === "string" ? cfg.token.trim() : "";
  if (!token) throw new Error(MISSING_TOKEN);

  const timeoutMs = Math.min(
    300_000,
    Math.max(5_000, Number(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
  );
  const insecure = boolArg(cfg.insecureTls, false);
  const readOnly = boolArg(cfg.readOnly, false);
  const exposeEnv = boolArg(cfg.exposeEnv, false);
  const maxChars = clampInt(cfg.maxChars, MAX_OUTPUT_CHARS, 2_000, 200_000);

  /**
   * One request. Answers `{ status, headers, body }` with the body as a
   * Buffer; `send` below is the JSON layer most callers want.
   */
  function raw(method, path, { query, body, headers: extra, timeout } = {}) {
    const url = new URL(apiUrl + (path.startsWith("/") ? path : `/${path}`));
    appendQuery(url, query);

    const headers = {
      // The token is used here and only here. It is never interpolated into
      // any string this module returns to a caller or to an error.
      "X-API-Key": token,
      Accept: "application/json",
    };
    let payload;
    if (body !== undefined && body !== null) {
      payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        // A caller-supplied Content-Type replaces the default; any other
        // header is added. Auth headers were refused before getting here.
        if (k.toLowerCase() === "content-type") delete headers["Content-Type"];
        headers[k] = String(v);
      }
    }
    if (payload !== undefined) headers["Content-Length"] = Buffer.byteLength(payload);

    const lib = url.protocol === "https:" ? https : http;
    const limit = timeout ?? timeoutMs;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        { method, headers, rejectUnauthorized: !insecure },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on("error", (e) => reject(new Error(`reading the reply from ${base.host} failed: ${e.message}`)));
        }
      );
      req.setTimeout(limit, () => req.destroy(new Error(`no answer within ${limit} ms`)));
      req.on("error", (e) => reject(new Error(reachError(e, base.host, insecure))));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /** A request whose reply is JSON (or empty); a non-2xx reply throws an explained error. */
  async function send(method, path, opts = {}) {
    const res = await raw(method, path, opts);
    const text = res.body.toString("utf8");
    if (res.status >= 200 && res.status < 300) {
      if (!text.trim()) return {};
      try {
        return JSON.parse(text);
      } catch {
        return { _raw: text };
      }
    }
    throw new Error(explainError(res.status, text, method, new URL(apiUrl + path).pathname));
  }

  return {
    baseUrl,
    apiUrl,
    host: base.host,
    readOnly,
    exposeEnv,
    maxChars,
    raw,
    send,
    get: (path, query, opts) => send("GET", path, { ...opts, query }),
    post: (path, body, query, opts) => send("POST", path, { ...opts, body: body ?? {}, query }),
    put: (path, body, query, opts) => send("PUT", path, { ...opts, body: body ?? {}, query }),
    delete: (path, query, opts) => send("DELETE", path, { ...opts, query }),
    /** The Docker Engine API of one environment. */
    docker: (envId, method, path, opts) => send(method, `/endpoints/${envId}/docker${path}`, opts),
    /** The Kubernetes API of one environment. */
    kube: (envId, method, path, opts) => send(method, `/endpoints/${envId}/kubernetes${path}`, opts),
    /** Refuses a change when the package is configured read-only. */
    assertWritable(what) {
      if (readOnly) {
        throw new Error(
          `${what} refused: this package is configured read-only (readOnly = true). Tell the person; ` +
            "only they can turn writes on, in the package's Configure form. Do not retry the change as a read."
        );
      }
    },
    /**
     * Cuts a value to `fields`, redacting first: redaction keys on the field
     * name, so an alias such as e=Config.Env must not get there before it.
     */
    view(value, fields, note) {
      const safe = exposeEnv ? value : redactEnvs(clone(value));
      return this.out(fields ? project(safe, fields) : safe, note);
    },
    /** Redacts env values and fits the answer to the window. */
    out(value, note) {
      const data = exposeEnv ? value : redactEnvs(clone(value));
      let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      const n = exposeEnv ? 0 : countRedacted(text);
      text = cut(text, maxChars);
      if (n) text += `\n[${n} environment value(s) redacted; the person can set exposeEnv = true on this package to show them]`;
      if (note) text += `\n${note}`;
      return text;
    },
    /** UI links for the person to click. */
    link: {
      environment: (id) => `${baseUrl}/#!/${id}/docker/dashboard`,
      stack: (id, name, envId, type) =>
        type === 3
          ? `${baseUrl}/#!/${envId}/kubernetes/stacks/${encodeURIComponent(name)}`
          : `${baseUrl}/#!/${envId}/docker/stacks/${encodeURIComponent(name)}?id=${id}&type=${type}`,
      container: (envId, id) => `${baseUrl}/#!/${envId}/docker/containers/${id}`,
    },
  };
}

function appendQuery(url, query) {
  if (!query) return;
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item));
    } else if (typeof v === "object") {
      // Docker's `filters` and Portainer's stack `filters` are JSON in a query param.
      url.searchParams.set(k, JSON.stringify(v));
    } else {
      url.searchParams.set(k, String(v));
    }
  }
}

function reachError(e, host, insecure) {
  const msg = e && e.message ? e.message : String(e);
  let out = `could not reach ${host}: ${msg}`;
  if (!insecure && /self[- ]signed|certificate|CERT_|unable to verify/i.test(msg)) {
    out +=
      "\nThe server's TLS certificate is not trusted (Portainer's default on :9443 is self-signed). " +
      "Use the server's trusted URL, or the person can set insecureTls = true on this package.";
  } else if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/.test(msg)) {
    out += "\nCheck the configured url: host, port (9443 for HTTPS, 9000 for HTTP), and that this fence can route to it.";
  }
  return out;
}

/**
 * Portainer errors are `{ message, details }`; Docker's are `{ message }`;
 * Kubernetes answers a `Status` object with `message` and `reason`. Use the
 * message, add a hint for the statuses that have a usual cause.
 */
export function explainError(status, text, method, path) {
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  const message =
    (typeof parsed.message === "string" && parsed.message) ||
    (typeof parsed.err === "string" && parsed.err) ||
    text.trim() ||
    `HTTP ${status}`;
  const details = typeof parsed.details === "string" && parsed.details !== message ? parsed.details : "";
  const where = String(path ?? "");
  const proxied = /\/endpoints\/\d+\/(docker|kubernetes)\//.exec(where);

  let hint;
  if (status === 401) {
    hint =
      "The access token was rejected. Check the `token` configured for this package: a Portainer " +
      "access token starts with ptr_ and is made in My account → Access tokens.";
  } else if (status === 403) {
    hint =
      "The token's user may not do this: in Portainer CE only administrators reach most settings, " +
      "and a standard user needs access to the environment (Environments → Manage access).";
  } else if (status === 404 && proxied) {
    hint =
      proxied[1] === "docker"
        ? "Docker has nothing at that path or id in this environment. List with portainer_containers or portainer_docker_resources first."
        : "Kubernetes has nothing at that path. Check the namespace and the API group/version in the path.";
  } else if (status === 404 && /\/endpoints\/\d+/.test(where)) {
    hint = "No environment with that id, or the token's user cannot see it. List them with portainer_environments.";
  } else if (status === 404) {
    hint = "Nothing at that id. Find it with portainer_environments or portainer_stacks first.";
  } else if (status === 409) {
    hint = "Conflict: a stack or container with that name already exists, or the object is in a state that refuses this.";
  } else if (status === 400 && /malformed Content-Type/i.test(message)) {
    hint = "Docker wants a Content-Type for a body; the proxy sets application/json unless `headers` overrides it.";
  } else if (status === 400 && /cannot unmarshal string/i.test(message)) {
    hint = "The body was encoded twice (a JSON string holding JSON). Send the object itself.";
  } else if (status === 400) {
    hint = "The request was rejected. The message names the field or the reason.";
  } else if (status === 503 && /not a swarm manager|not part of a swarm/i.test(message)) {
    hint = "This environment is not a Swarm manager: services, tasks, nodes, secrets and configs exist only on Swarm.";
  } else if (status === 502 || status === 503) {
    hint = "Portainer could not reach the environment (agent down or the environment unreachable). portainer_environments shows its status.";
  } else if (status >= 500) {
    hint = "The server failed. For a stack deploy the message is usually compose's own error; read it before retrying.";
  }

  let out = `Portainer ${method ?? ""} ${where} returned ${status}: ${clip(message, 1200)}`;
  if (details) out += ` (${clip(details, 400)})`;
  if (hint) out += `\n${hint}`;
  return out;
}

// ---------------------------------------------------------------------------
// Env redaction (after portainer-mcp's redaction.py): field-name driven, so a
// `fields` projection cannot route around it — it runs on the whole object
// before the projection does.

const ENV_KEYS = new Set(["env", "envvars"]);
const KEY_VAL = /^([A-Za-z_][A-Za-z0-9_.-]*)=/;

export function redactEnvs(node) {
  if (Array.isArray(node)) {
    for (const item of node) redactEnvs(item);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (ENV_KEYS.has(key.toLowerCase()) && Array.isArray(value)) redactList(value);
      else redactEnvs(value);
    }
  }
  return node;
}

function redactList(items) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item && typeof item === "object") {
      // {name, value} / {Name, Value}; a K8s valueFrom is a reference, not a secret.
      for (const key of ["value", "Value"]) {
        if (key in item && item[key] !== "" && item[key] !== null) {
          item[key] = REDACTED;
          break;
        }
      }
    } else if (typeof item === "string") {
      const m = KEY_VAL.exec(item);
      if (m) items[i] = `${m[0]}${REDACTED}`;
    }
  }
}

export function countRedacted(text) {
  return text.split(REDACTED).length - 1;
}

function clone(v) {
  return v === undefined || typeof v === "string" ? v : JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// Field projection: the `fields` argument. A small, quote-safe subset of what
// portainer-mcp does with JMESPath, enough to cut a list to what a question
// needs:
//   "Id,Names[0],State"                 paths, the leaf name becomes the key
//   "name=Names[0],image=Image"         alias=path
//   'Labels."com.docker.compose.project"'  a key with dots, double-quoted
//   "metadata.name,status.phase"        Kubernetes; a list wrapped in
//                                       {items: […]} is projected per item

export function parseFields(spec) {
  if (spec === undefined || spec === null || spec === "") return undefined;
  const list = Array.isArray(spec) ? spec.map(String) : splitTop(String(spec));
  const out = [];
  for (const raw of list) {
    const s = raw.trim();
    if (!s) continue;
    const eq = topIndex(s, "=");
    const alias = eq > 0 ? s.slice(0, eq).trim() : undefined;
    const path = parsePath(eq > 0 ? s.slice(eq + 1).trim() : s);
    if (!path.length) throw new Error(`fields: empty path in ${clip(s, 60)}`);
    const last = [...path].reverse().find((p) => typeof p === "string");
    out.push({ key: alias || (path.length === 1 || !last ? String(path[0]) : last), path });
  }
  return out.length ? out : undefined;
}

/** Splits on commas that are outside double quotes. */
function splitTop(s) {
  const parts = [];
  let cur = "";
  let q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (ch === "," && !q) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

function topIndex(s, needle) {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') q = !q;
    else if (s[i] === needle && !q) return i;
  }
  return -1;
}

/** `a.b[0]."c.d"` → ["a", "b", 0, "c.d"]. */
export function parsePath(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ".") {
      i++;
    } else if (ch === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) throw new Error(`fields: unclosed quote in ${clip(s, 60)}`);
      out.push(s.slice(i + 1, end));
      i = end + 1;
    } else if (ch === "[") {
      const end = s.indexOf("]", i);
      if (end < 0) throw new Error(`fields: unclosed [ in ${clip(s, 60)}`);
      const idx = Number(s.slice(i + 1, end));
      if (!Number.isInteger(idx)) throw new Error(`fields: [${s.slice(i + 1, end)}] is not an index in ${clip(s, 60)}`);
      out.push(idx);
      i = end + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== "." && s[j] !== "[") j++;
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

export function getPath(obj, path) {
  let cur = obj;
  for (const seg of path) {
    if (cur === null || cur === undefined) return null;
    if (typeof seg === "number") cur = Array.isArray(cur) ? cur.at(seg) : undefined;
    else cur = cur[seg];
  }
  return cur === undefined ? null : cur;
}

/** Projects a list, a {items: […]} list, or one object. */
export function project(data, fields) {
  if (!fields) return data;
  const pick = (o) => Object.fromEntries(fields.map((f) => [f.key, getPath(o, f.path)]));
  if (Array.isArray(data)) return data.map(pick);
  if (data && typeof data === "object" && Array.isArray(data.items)) {
    const out = { items: data.items.map(pick) };
    if (data.metadata && data.metadata.continue) out.continue = data.metadata.continue;
    return out;
  }
  return data && typeof data === "object" ? pick(data) : data;
}

/** Drops metadata.managedFields from a Kubernetes object or list, in place. */
export function stripManagedFields(node) {
  if (Array.isArray(node)) node.forEach(stripManagedFields);
  else if (node && typeof node === "object") {
    if (node.metadata && typeof node.metadata === "object") delete node.metadata.managedFields;
    if (Array.isArray(node.items)) node.items.forEach(stripManagedFields);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Docker log streams. Without a TTY Docker multiplexes stdout and stderr into
// frames: [stream, 0, 0, 0, size (uint32 BE)] then size bytes. With a TTY the
// body is the raw text.

export function demuxDockerLog(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf ?? ""));
  const looksFramed = buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksFramed) return [{ stream: "stdout", text: buf.toString("utf8") }];
  const out = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const kind = buf[i];
    const size = buf.readUInt32BE(i + 4);
    const text = buf.subarray(i + 8, Math.min(buf.length, i + 8 + size)).toString("utf8");
    out.push({ stream: kind === 2 ? "stderr" : "stdout", text });
    i += 8 + size;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Argument helpers, the same coercions the other HTTP-API packages use.

export function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function cut(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n… [cut at ${max} characters of ${text.length}; pass \`fields\` to keep only what the question needs, or narrow the query]`
  );
}

export function asObject(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`${name} must be a JSON object (or a JSON string of one): ${e.message}`);
    }
    if (parsed && typeof parsed === "object") return parsed;
  }
  throw new Error(`${name} must be a JSON object`);
}

/**
 * A request body: an object or array is sent as JSON; a string is sent as
 * it is, except a JSON string that itself holds JSON, which is the
 * encoded-twice mistake Docker answers with "cannot unmarshal string".
 */
export function bodyArg(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") return value;
  const s = String(value);
  let inner;
  try {
    inner = JSON.parse(s);
  } catch {
    return s;
  }
  if (typeof inner === "string") {
    try {
      const nested = JSON.parse(inner);
      if (nested && typeof nested === "object") {
        throw new Error("body is a JSON string containing JSON (encoded twice); send the object itself");
      }
    } catch (e) {
      if (/encoded twice/.test(e.message)) throw e;
    }
  }
  return s;
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

export function boolArg(value, def = false) {
  if (value === undefined || value === null || value === "") return def;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return def;
}

export function clampInt(value, def, min, max) {
  const n = Number.isFinite(Number(value)) && value !== null && value !== "" ? Math.trunc(Number(value)) : def;
  return Math.min(max, Math.max(min, n));
}

/** "10m", "2h", "1d", an ISO date, or unix seconds → unix seconds. */
export function sinceArg(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const s = String(value).trim();
  if (/^\d{9,11}$/.test(s)) return Number(s);
  const rel = /^(\d+)\s*([smhdw])$/i.exec(s);
  if (rel) {
    const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[rel[2].toLowerCase()];
    return Math.floor(Date.now() / 1000) - Number(rel[1]) * mult;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`${name} must be like "15m", "2h", "1d", an ISO date or unix seconds; got ${clip(s, 40)}`);
  return Math.floor(t / 1000);
}

/**
 * Environment variables as Portainer's [{name, value}] list. Accepts an
 * object map, a list of "KEY=VAL" strings, a list of pairs, or a .env-style
 * string with one KEY=VAL per line.
 */
export function envArg(value, name = "env") {
  if (value === undefined || value === null) return undefined;
  let v = value;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith("{") || s.startsWith("[")) v = asObject(s, name);
    else v = s.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  }
  const pair = (k, val) => {
    const key = String(k).trim();
    if (!key) throw new Error(`${name}: empty variable name`);
    return { name: key, value: val === undefined || val === null ? "" : String(val) };
  };
  if (Array.isArray(v)) {
    return v.map((item, i) => {
      if (typeof item === "string") {
        const eq = item.indexOf("=");
        if (eq < 1) throw new Error(`${name}[${i}] must be KEY=VALUE, got ${clip(item, 40)}`);
        return pair(item.slice(0, eq), item.slice(eq + 1));
      }
      if (item && typeof item === "object") return pair(item.name ?? item.Name, item.value ?? item.Value);
      throw new Error(`${name}[${i}] must be KEY=VALUE or {name, value}`);
    });
  }
  if (typeof v === "object") return Object.entries(v).map(([k, val]) => pair(k, val));
  throw new Error(`${name} must be an object of NAME: value, a list of NAME=value, or {name, value} pairs`);
}

export function listArg(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value.map(String);
  const s = String(value).trim();
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through to commas
    }
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

/** Bytes as a short human figure. */
export function bytes(n) {
  if (!Number.isFinite(n)) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)}${u[i]}`;
}

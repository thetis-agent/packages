// Shared mooR web-host client, encoding and error handling.
//
// Every moo_* tool imports this one module. The Rust/wasm ancestor of this
// group could not: each tool was a standalone wasm component with no workspace
// to hold a common library, so a 1,272-line `moo.rs` was duplicated verbatim
// into fifty crates and kept in step by a shell script with a --check mode for
// drift (`tools/moo-server-info/sync-shared-client.sh`). /opt/thetis's own
// postmortem counted the result: ~250,000 lines of tool source over ~12,000
// distinct lines. A Thetis package has no such boundary — one file, fifty
// importers, and the sync script is simply unnecessary.
//
// The protocol authority is mooR's `crates/web-host`. Three endpoints need no
// auth: GET /health (200 empty when the daemon was heard from in the last 30s,
// else 503), GET /version, and GET /v1/features (which MUST be asked for with
// `Accept: application/json` or it answers with a FlatBuffers blob).
// Everything under /v1/... needs an X-Moor-Auth-Token from /auth/connect.

export const DEFAULT_BASE_URL = "http://10.10.10.1:7892";

// mooR's own protocol ceiling for a captured task deadline.
export const MAX_TIMEOUT_MS = 300_000;

// Output cap. The host truncates anyway; cutting here means the tool can say
// why it was cut instead of the text just stopping mid-word.
export const MAX_OUTPUT_BYTES = 32_000;

const MISSING_CREDENTIALS =
  "no mooR credentials configured. This tool group logs in to the MOO as an ordinary " +
  "player and holds no authority of its own, so it needs a character to be. Set the keys " +
  "`username` and `password` on this package: the person can do it in the control panel " +
  "(Configure on the package), or you can call configure_package with the values they give " +
  "you. Every moo_* tool reads the same two keys, so they are set once.\n\n" +
  "Call package_config for this package to see whether a key was never set, was set to a " +
  "${VAR} that is not in the environment, or is inherited from a fork parent. The change is " +
  "live on the next call; no restart.";

/** Builds a client from this tool group's own config block (`env.config`). */
export function createClient(env) {
  const cfg = env && typeof env.config === "object" && env.config ? env.config : {};

  let baseUrl = String(cfg.base_url ?? cfg.url ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error(
      `'${baseUrl}' is not a valid base_url: it must start with http:// or https://. ` +
        `Set the key \`base_url\` on this package, e.g. "${DEFAULT_BASE_URL}".`,
    );
  }

  const str = (k) => {
    const v = cfg[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const username = str("username");
  const password = str("password");
  // A pre-minted token, for a caller that has one already.
  const authToken = str("auth_token") ?? str("token");

  if (!authToken && !(username && password)) throw new Error(MISSING_CREDENTIALS);
  if (!authToken && (Boolean(username) !== Boolean(password))) {
    throw new Error("`username` and `password` must be configured together.");
  }

  const num = (k, d) => (Number.isFinite(Number(cfg[k])) && Number(cfg[k]) > 0 ? Number(cfg[k]) : d);

  return new Moo({
    baseUrl,
    username,
    password,
    authToken,
    requestTimeoutMs: num("request_timeout_secs", 30) * 1000,
    env,
  });
}

export class Moo {
  constructor(o) {
    Object.assign(this, o);
  }

  // The token is cached in harness state for the session, so a chain of calls
  // mints it once. The wasm original used the host key-value store for this.
  #cacheKey() {
    return `moo-auth:${this.baseUrl}:${this.username ?? "token"}`;
  }

  #cached() {
    const h = this.env?.harness?.["@bitmuse/moo"];
    const t = h && h[this.#cacheKey()];
    return typeof t === "string" && t.trim() ? t : undefined;
  }

  #remember(token) {
    // env.harness is a plain object on the turn's state; writing it here means a
    // later tool call in the same turn reuses the token rather than logging in
    // again. It is best-effort: a fresh login is correct, just slower.
    try {
      if (!this.env || typeof this.env !== "object") return;
      this.env.harness ??= {};
      this.env.harness["@bitmuse/moo"] ??= {};
      this.env.harness["@bitmuse/moo"][this.#cacheKey()] = token;
    } catch {
      /* not fatal */
    }
  }

  async login() {
    if (this.authToken) return this.authToken;
    if (!this.username || !this.password) throw new Error(MISSING_CREDENTIALS);
    const url = `${this.baseUrl}/auth/connect`;
    // The handler takes a form and answers with the token in a header; the body
    // is FlatBuffers and of no use here. See `connect_auth_handler`.
    const body = new URLSearchParams({ player: this.username, password: this.password });
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      throw new Error(unreachable(this.baseUrl, e));
    }
    const token = res.headers.get("x-moor-auth-token");
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `login as ${JSON.stringify(this.username)} was refused (HTTP ${res.status}). The MOO rejected ` +
          `the character or the password, so this is a credentials problem, not a connectivity one: ` +
          `/health on the same server is what proves the server itself is up. Check the keys ` +
          `\`username\` and \`password\` on this package with package_config.`,
      );
    }
    if (!res.ok) {
      throw new Error(`login as ${JSON.stringify(this.username)} failed with HTTP ${res.status}: ${clip(await safeText(res), 300)}`);
    }
    if (!token) throw new Error("login succeeded but X-Moor-Auth-Token was absent");
    this.#remember(token);
    return token;
  }

  /** An authenticated request that retries once through a fresh login on 401. */
  async authenticated(method, path, { contentType, body } = {}) {
    let token = this.#cached() ?? (await this.login());
    let res = await this.#request(method, path, { token, contentType, body });
    if (res.status !== 401) return res;
    this.#remember("");
    token = await this.login();
    return this.#request(method, path, { token, contentType, body });
  }

  async #request(method, path, { token, contentType, body, accept = "application/json" } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = {};
    if (accept) headers.Accept = accept;
    if (contentType) headers["Content-Type"] = contentType;
    if (token) headers["X-Moor-Auth-Token"] = token;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      throw new Error(unreachable(this.baseUrl, e));
    }
    const text = await safeText(res);
    return { status: res.status, ok: res.ok, contentType: res.headers.get("content-type"), text };
  }

  /** GET with an explicit JSON Accept. */
  getJson(path) {
    return this.#request("GET", path, { accept: "application/json" });
  }

  /** GET with no Accept, for /health and /version which negotiate nothing. */
  getPlain(path) {
    return this.#request("GET", path, { accept: null });
  }

  /**
   * POST MOO source to a capturing endpoint and decode the outcome.
   *
   * `timeout_ms` is the task deadline. mooR caps it at 300,000; asking for more
   * is refused here rather than silently clamped, because a caller that asked
   * for ten minutes and got five would draw the wrong conclusion from a timeout.
   */
  async captured(path, source, timeoutMs) {
    const ms = Number(timeoutMs ?? 0);
    if (ms > MAX_TIMEOUT_MS) throw new Error(`timeout_ms exceeds mooR's ${MAX_TIMEOUT_MS} ms protocol ceiling`);
    const full = ms > 0 ? `${path}?timeout_ms=${ms}` : path;
    const res = await this.authenticated("POST", full, {
      contentType: "text/plain; charset=utf-8",
      body: source,
    });
    return decodeCaptured(res, full);
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function unreachable(baseUrl, e) {
  const msg = e?.name === "TimeoutError" ? "the request timed out" : String(e?.message ?? e);
  return (
    `could not reach the mooR web host at ${baseUrl}: ${msg}. The web host answers GET /health ` +
    `with 200 and an empty body when it is up; if that fails too, the server or the route to it ` +
    `is the problem rather than anything about this request.`
  );
}

/** Explain a non-2xx reply from a capturing endpoint, with the body clipped. */
function explainStatus(res, path) {
  const body = clip(res.text ?? "", 800);
  if (res.status === 401 || res.status === 403) {
    return `${path} refused with HTTP ${res.status}: the auth token was rejected. moo_reconnect logs in again. ${body}`;
  }
  if (res.status === 408 || res.status === 504) {
    return `${path} timed out at the host (HTTP ${res.status}). The task may have committed before the deadline: read state back before retrying. ${body}`;
  }
  return `${path} returned HTTP ${res.status}: ${body}`;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode a captured invocation, tolerating both wire shapes.
 *
 * Current hosts return a bare InvocationResponse with an
 * InvocationSuccess/InvocationError outcome. Older deployed hosts wrap a
 * successful captured eval as ReplyResult -> ClientSuccess -> EvalResult.
 * Both are accepted, and a genuine error is never mistaken for either.
 */
export function decodeCaptured(res, path) {
  if (!res.ok) throw new Error(explainStatus(res, path));
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new Error(`${path} did not return JSON: ${clip(res.text, 600)}`);
  }

  const explicit = findKey(body, ["InvocationSuccess", "InvocationError", "VerbCallSuccess", "VerbCallError"]);
  const legacySuccess = (() => {
    const n = findNamed(body, "EvalResult");
    return n ? findNamed(n, "result") : undefined;
  })();
  const legacyError = findKey(body, ["ClientFailure", "TaskError", "SchedulerError"]);

  let success, node;
  if (explicit) {
    success = explicit.key === "InvocationSuccess" || explicit.key === "VerbCallSuccess";
    node = explicit.value;
  } else if (legacySuccess !== undefined) {
    success = true;
    node = legacySuccess;
  } else if (legacyError) {
    success = false;
    node = legacyError.value;
  } else {
    throw new Error(`${path} returned an unrecognised captured-invocation envelope: ${clip(JSON.stringify(body), 1200)}`);
  }

  const outputRaw = findNamed(body, "output");
  const output = Array.isArray(outputRaw) ? outputRaw.map(decodeWireValue) : [];
  const text = JSON.stringify(node).toLowerCase();

  return {
    success,
    value: success ? decodeWireValue(findNamed(node, "result") ?? node) : null,
    error: success ? null : decodeWireValue(node),
    output,
    // A task killed for exceeding ticks or seconds reports itself this way.
    timed_out: text.includes("taskabortedlimit") || text.includes("timeout") || text.includes("time limit"),
    cancelled: text.includes("cancel"),
  };
}

/**
 * Turn mooR's tagged JSON representation of a Var into ordinary JSON.
 * An unknown tag is kept rather than dropped, so a protocol addition is visible
 * to the caller instead of silently becoming null.
 */
export function decodeWireValue(value) {
  const variant = value && typeof value === "object" && !Array.isArray(value) ? value.variant : undefined;
  if (!variant || typeof variant !== "object") {
    if (Array.isArray(value)) return value.map(decodeWireValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeWireValue(v)]));
    }
    return value;
  }
  const [tag, payload] = Object.entries(variant)[0] ?? [];
  if (!tag) return value;
  switch (tag) {
    case "VarNone":
      return null;
    case "VarBool":
      return payload?.value ?? false;
    case "VarInt":
    case "VarFloat":
    case "VarStr":
      return payload?.value ?? null;
    case "VarObj":
      return decodeWireObject(payload) ?? value;
    case "VarList":
      return Array.isArray(payload?.elements) ? payload.elements.map(decodeWireValue) : value;
    case "VarMap": {
      const pairs = payload?.pairs;
      if (!Array.isArray(pairs)) return value;
      const decoded = pairs
        .filter((p) => p && p.key !== undefined && p.value !== undefined)
        .map((p) => [decodeWireValue(p.key), decodeWireValue(p.value)]);
      // A MOO map may be keyed by anything. Only an all-string map can become a
      // JSON object; anything else keeps its keys as data.
      if (decoded.every(([k]) => typeof k === "string")) return Object.fromEntries(decoded);
      return decoded.map(([key, val]) => ({ key, value: val }));
    }
    default:
      return value;
  }
}

function decodeWireObject(payload) {
  const obj = findNamed(payload, "ObjId");
  if (obj && obj.id !== undefined) return `#${obj.id}`;
  return undefined;
}

export function findNamed(v, name) {
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findNamed(x, name);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (v && typeof v === "object") {
    if (name in v) return v[name];
    for (const x of Object.values(v)) {
      const r = findNamed(x, name);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

export function findKey(v, names) {
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findKey(x, names);
      if (r) return r;
    }
    return undefined;
  }
  if (v && typeof v === "object") {
    for (const n of names) if (n in v) return { key: n, value: v[n] };
    for (const x of Object.values(v)) {
      const r = findKey(x, names);
      if (r) return r;
    }
  }
  return undefined;
}

/**
 * Strip mooR's FlatBuffers union wrappers so a caller reads `#36` instead of
 * five levels of nesting, and render an object id the way mooR itself does.
 */
export function compactWire(value) {
  const asObjId = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const entries = Object.entries(v);
    if (entries.length !== 1) return undefined;
    const [key, inner] = entries[0];
    if (key === "ObjId") {
      const f = inner && typeof inner === "object" ? Object.entries(inner) : [];
      if (f.length === 1 && inner.id !== undefined) return `#${inner.id}`;
      return undefined;
    }
    if (key === "UuObjId") {
      // A time-ordered id whose u64 packs an autoincrement, six bits of
      // randomness and a millisecond timestamp. Rendered as
      // #{first_group:06X}-{epoch_ms:010X}, matching UuObjid::to_uuid_string,
      // so the caller can hand the id straight back to another tool. Leaving
      // the raw integer would print something no tool accepts.
      const packed = inner && typeof inner === "object" ? inner.packed_value : undefined;
      if (packed === undefined) return undefined;
      const p = BigInt(packed);
      const autoincrement = (p >> 46n) & 0xffffn;
      const rng = (p >> 40n) & 0x3fn;
      const epochMs = p & 0x00ff_ffff_ffffn;
      const firstGroup = (autoincrement << 6n) | rng;
      const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, "0");
      return `#${hex(firstGroup, 6)}-${hex(epochMs, 10)}`;
    }
    return asObjId(inner);
  };

  const isWrapper = (key) =>
    ["value", "reply", "result", "obj", "variant"].includes(key) || /^[A-Z]/.test(key);

  const id = asObjId(value);
  if (id !== undefined) return id;
  if (Array.isArray(value)) return value.map(compactWire);
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 1 && isWrapper(entries[0][0])) return compactWire(entries[0][1]);
    return Object.fromEntries(entries.map(([k, v]) => [k, compactWire(v)]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Encoding: MOO source is built, never interpolated
// ---------------------------------------------------------------------------

/**
 * Serialize JSON to a MOO literal.
 *
 * This is the injection boundary of the whole group: every tool that puts a
 * caller's value into MOO source goes through here, so a string containing a
 * quote or a newline becomes an escaped MOO string rather than new code.
 */
export function mooLiteral(value) {
  if (value === null || value === undefined) return "0";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot encode a non-finite number as a MOO literal");
    return String(value);
  }
  if (typeof value === "string") {
    return (
      '"' +
      value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t") +
      '"'
    );
  }
  if (Array.isArray(value)) return `{${value.map(mooLiteral).join(", ")}}`;
  if (typeof value === "object") {
    const pairs = Object.entries(value).map(([k, v]) => `${mooLiteral(k)} -> ${mooLiteral(v)}`);
    return `[${pairs.join(", ")}]`;
  }
  throw new Error(`cannot encode ${typeof value} as a MOO literal`);
}

/**
 * A corified reference as a person types it: `$you`, `$sys.utils`. Returns the
 * dotted identifier path without the `$`, or undefined when the text is not
 * one. Each segment has to be a plain MOO identifier, so this doubles as the
 * injection check: `$you; recycle(#1)` is not a corified reference.
 */
export function corifiedPath(value) {
  const v = String(value ?? "").trim();
  if (!v.startsWith("$")) return undefined;
  const body = v.slice(1);
  if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(body)) return body;
  return undefined;
}

/**
 * A MOO *expression* for an object: `#123` stays, `$you` stays, a CURIE becomes
 * toobj("...") or the `$` form.
 */
export function mooObjectExpr(value) {
  const v = String(value ?? "").trim();
  // `$you` is already the expression the VM evaluates to that object.
  const corified = corifiedPath(v);
  if (corified !== undefined) return `$${corified}`;
  const id = v.startsWith("#") ? v.slice(1) : undefined;
  if (id !== undefined && id.length && /^[0-9-]+$/.test(id)) return v;
  // A UUID object id (#XXXXXX-XXXXXXXXXX) is a valid MOO literal as written, and
  // toobj("#XXXXXX-...") parses it too. toobj() does NOT understand CURIEs:
  // toobj("uuid:...") and toobj("oid:12") both silently return #0, which is how a
  // verb meant for a UUID object ends up on the system object. So every CURIE is
  // rewritten to the form the VM actually parses.
  if (id !== undefined && /^[0-9a-fA-F]{6}-[0-9a-fA-F]{10}$/.test(id)) return `toobj(${mooLiteral(v)})`;
  if (v.startsWith("uuid:")) return `toobj(${mooLiteral("#" + v.slice("uuid:".length))})`;
  if (v.startsWith("oid:")) {
    const n = v.slice("oid:".length);
    if (/^-?[0-9]+$/.test(n)) return `#${n}`;
  }
  if (v.startsWith("sysobj:")) {
    // The same identifier rule as `$you`: this text is spliced into source.
    // mooR's own to_curie() writes a trailing dot (`sysobj:system.`), so a
    // reference copied back from a listing is accepted too.
    const p = corifiedPath("$" + v.slice("sysobj:".length).replace(/\.$/, ""));
    if (p !== undefined) return `$${p}`;
  }
  if (v.startsWith("moor:")) return `toobj(${mooLiteral(v)})`;
  throw new Error(
    `object must be a #number, a corified reference such as $you, or a mooR CURIE such as sysobj:system, got ${JSON.stringify(v)}`,
  );
}

/** Percent-encode one URL path segment, keeping the characters a CURIE needs. */
export function pathSegment(value) {
  let out = "";
  for (const byte of new TextEncoder().encode(String(value ?? ""))) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~:]/.test(c)) out += c;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/**
 * Normalize the object notation a person uses to the CURIE notation mooR's HTTP
 * routes require. MOO *expressions* still use `#123`; only REST path and query
 * parameters need `oid:123`.
 */
export function objectPathSegment(value) {
  const v = String(value ?? "").trim();
  // `$you` -> `sysobj:you`, `$a.b` -> `sysobj:a.b`: the web host's parse_curie
  // splits the path on dots and resolves it the way the VM resolves `$a.b`.
  const corified = corifiedPath(v);
  if (corified !== undefined) return pathSegment(`sysobj:${corified}`);
  if (v.startsWith("#")) {
    const id = v.slice(1);
    // A UUID id is checked first: a plain `#-5` and a UUID both contain a dash,
    // and without this a caller could not pass back an id a listing just showed.
    const dash = id.indexOf("-");
    if (dash !== -1) {
      const first = id.slice(0, dash);
      const rest = id.slice(dash + 1);
      const hex = (s) => s.length > 0 && /^[0-9a-fA-F]+$/.test(s);
      if (first.length === 6 && rest.length === 10 && hex(first) && hex(rest)) {
        return pathSegment(`uuid:${id}`);
      }
    }
    if (id.length && /^[0-9-]+$/.test(id)) return pathSegment(`oid:${id}`);
    throw new Error(
      `invalid object reference ${JSON.stringify(v)}: expected #number, a UUID id such as ` +
        `#0011E5-9CB7359F34, a corified reference such as $you, or a mooR CURIE such as oid:36 or sysobj:system`,
    );
  }
  if (v.startsWith("oid:") || v.startsWith("uuid:") || v.startsWith("sysobj:") || v.startsWith('match("')) {
    return pathSegment(v);
  }
  throw new Error(
    "object must be #number, a corified reference such as $you, or a mooR CURIE such as oid:36, uuid:..., or sysobj:system",
  );
}

/** A verb name safe to place in MOO source. */
export function verbName(s) {
  const v = String(s ?? "");
  if (v.length && [...v].every((c) => /[A-Za-z0-9]/.test(c) || "_-?*!".includes(c))) return v;
  throw new Error(`unsafe verb name ${JSON.stringify(v)}`);
}

/** Validate the tool definitions a world declares through #0:external_agent_tools(). */
export function dynamicTools(value) {
  const find = (v) => {
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x))) return v;
      for (const x of v) {
        const r = find(x);
        if (r) return r;
      }
      return undefined;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) {
        const r = find(x);
        if (r) return r;
      }
    }
    return undefined;
  };
  const tools = find(value);
  if (!tools) throw new Error("external_agent_tools did not return a list of maps");
  for (const t of tools) {
    for (const key of ["name", "description", "target_obj", "target_verb", "input_schema"]) {
      if (!(key in t)) throw new Error(`dynamic tool missing ${key}`);
    }
    if (
      typeof t.name !== "string" ||
      typeof t.description !== "string" ||
      typeof t.target_verb !== "string" ||
      typeof t.input_schema !== "object"
    ) {
      throw new Error("dynamic tool has invalid field types");
    }
  }
  return tools;
}

/** Each line of an objdef as a MOO list literal. */
export function objdefLinesLiteral(text) {
  return `{${String(text).split(/\r?\n/).map(mooLiteral).join(", ")}}`;
}

export const OBJDEF_CONSTANTS_BUILDER =
  "constants = []; for o in (objects()) id = object_metadata(o, 'import_export_id); " +
  "if (typeof(id) == TYPE_STR && id != \"\") constants[id:uppercase()] = o; endif endfor";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function clip(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max) + `... [clipped, ${s.length} chars total]`;
}

/**
 * Cap a result, keeping the head, and say how to reach the rest.
 *
 * The recovery note goes last and must survive the cut: a result that stops
 * dead tells the caller its answer is incomplete and gives it nothing to do
 * about that. Cutting on a line boundary matters because objdef and pretty
 * JSON are read by line, and half a line reads as a syntax error.
 */
export function bounded(text, maxBytes = MAX_OUTPUT_BYTES) {
  const s = typeof text === "string" ? text : JSON.stringify(text, null, 2) ?? "";
  if (s.length <= maxBytes) return s;
  let end = Math.min(Math.max(maxBytes - 240, Math.floor(maxBytes / 2)), s.length);
  const nl = s.lastIndexOf("\n", end);
  if (nl > end - Math.floor(end / 10)) end = nl;
  return (
    s.slice(0, end) +
    `\n\n[cut here: ${s.length} characters total, ${end} shown. To see the rest, ask for a ` +
    `narrower slice — a specific verb or property rather than a whole object, a lower limit, ` +
    `or a MOO expression that returns just the field you need.]`
  );
}

/** The uniform shape a captured invocation is reported in. */
export function report(r, extra = {}) {
  const out = { success: r.success, ...extra };
  if (r.value !== null && r.value !== undefined) out.value = r.value;
  if (r.error) out.error = r.error;
  if (r.output?.length) out.output = r.output;
  if (r.timed_out) {
    out.timed_out = true;
    // The single most expensive misconception in this group.
    out.warning =
      "The task exceeded its tick or time limit. A timeout is NOT a rollback: side effects " +
      "committed before the limit are still committed. Do not retry blindly — read back every " +
      "state field this call could have changed, reconcile it, then run a smaller test.";
  }
  if (r.cancelled) out.cancelled = true;
  if (!r.success && !r.error) {
    out.note =
      "The call reported failure with no error value. A runtime traceback goes to the player's " +
      "connection, not to this tool, so inspect state directly or re-run inside a catching " +
      "expression: `return `expr ! ANY => {\"RAISED\", error[1], error[2]}';";
  }
  return bounded(JSON.stringify(out, null, 2));
}

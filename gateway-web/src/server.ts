// The HTTP surface: cookie login, static assets, a JSON API over the kernel's session calls, and one
// Server-Sent Events stream per browser that carries every turn event of the signed-in user.
// Identity is the kernel's: the gateway exchanges a password for a token and a token for a user.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelClient, Message, SessionRecord, UserRole } from "@thetis/kernel";
import type { GatewayStore, SessionUsage } from "./store.js";
import { TurnHub, type RunningTurn } from "./turns.js";

export interface GatewayOptions {
  /** Directory of the static assets. Defaults to the package's `assets/`. */
  assets?: string;
  /** Adds `Secure` to the cookie. Set it when TLS terminates in front of the gateway. Config key `secure`. */
  secure?: boolean;
  log?: (line: string) => void;
}

const COOKIE = "thetis_web";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const BODY_LIMIT = 1024 * 1024;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  title: string;
  preview: string;
  archived: boolean;
  status: "idle" | "running";
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Builds the gateway. Call `.listen()` on the result. */
export function createGateway(kernel: KernelClient, store: GatewayStore, opts: GatewayOptions = {}): Server {
  const log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
  const assets = opts.assets ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../assets");
  const hub = new TurnHub(kernel, log, recordUsage);
  const secure = opts.secure === true;

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : codeToStatus((err as { code?: string }).code);
      if (status >= 500) log(`[gateway-web] ${req.method} ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (res.headersSent) return res.end();
      json(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");

    if (path.startsWith("/assets/")) return serveAsset(res, assets, path.slice("/assets/".length));
    if (path === "/login" && method === "GET") return serveAsset(res, assets, "login.html");
    if (path === "/login" && method === "POST") return login(req, res, url);
    if (path === "/logout" && method === "POST") return logout(req, res);

    const who = await authenticate(req);
    const user = who?.id;
    if (path === "/") {
      if (!user) return redirect(res, "/login");
      return serveAsset(res, assets, "index.html", { "Cache-Control": "no-store" });
    }
    if (!path.startsWith("/api/")) throw new HttpError(404, "not found");
    if (!user) throw new HttpError(401, "sign in first");
    if (method !== "GET") checkSameSite(req);

    const seg = path.split("/").filter(Boolean); // ["api", ...]
    if (seg[1] === "me" && method === "GET") return json(res, 200, { user, role: who!.role });
    if (seg[1] === "events" && method === "GET") return stream(req, res, user);
    if (seg[1] === "sessions") {
      if (seg.length === 2 && method === "GET") return json(res, 200, await listSessions(user));
      if (seg.length === 2 && method === "POST") return json(res, 201, { id: (await kernel.sessions.create(undefined, user)).id });
      const id = seg[2];
      if (!/^s_[a-f0-9]+$/.test(id ?? "")) throw new HttpError(404, "unknown session");
      if (seg.length === 3 && method === "GET") return json(res, 200, await showSession(user, id));
      if (seg[3] === "send" && method === "POST") {
        const body = await readJson(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) throw new HttpError(400, "text is required");
        const run = await hub.start(user, id, text);
        return json(res, 202, { session: id, startedAt: run.startedAt });
      }
      if (seg[3] === "cancel" && method === "POST") {
        await kernel.sessions.inspect(id, user);
        return json(res, 200, { cancelled: await hub.cancel(user, id) });
      }
      if (seg[3] === "archive" && method === "POST") {
        await kernel.sessions.inspect(id, user);
        const body = await readJson(req);
        store.setArchived(user, id, body.archived !== false);
        return json(res, 200, { id, archived: body.archived !== false });
      }
    }
    throw new HttpError(404, "not found");
  }

  async function authenticate(req: IncomingMessage): Promise<{ id: string; role: UserRole } | undefined> {
    const token = cookies(req)[COOKIE];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    return (await kernel.auth.authenticate(token)) ?? undefined;
  }

  async function login(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = await readForm(req);
    const id = String(body.id ?? "").trim();
    const password = String(body.password ?? "");
    const next = safeNext(String(body.next ?? url.searchParams.get("next") ?? "/"));
    const result = /^[a-z][a-z0-9-]{0,31}$/.test(id) && password ? await kernel.auth.login(id, password) : null;
    if (!result) {
      log(`[gateway-web] refused login for ${JSON.stringify(id)} from ${req.socket.remoteAddress}`);
      if (wantsJson(req)) throw new HttpError(401, "the id or password was refused");
      return redirect(res, `/login?error=refused&next=${encodeURIComponent(next)}`);
    }
    res.setHeader("Set-Cookie", cookie(result.token, COOKIE_MAX_AGE, secure));
    if (wantsJson(req)) return json(res, 200, { user: id });
    return redirect(res, next);
  }

  async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = cookies(req)[COOKIE];
    if (token) await kernel.auth.logout(token);
    res.setHeader("Set-Cookie", cookie("", 0, secure));
    if (wantsJson(req)) return json(res, 200, { ok: true });
    return redirect(res, "/login");
  }

  async function listSessions(user: string): Promise<SessionSummary[]> {
    const archived = store.archived(user);
    const refs = (await kernel.sessions.list(user)).filter((s) => !s.parent);
    const records = await Promise.all(refs.map((s) => kernel.sessions.inspect(s.id, user)));
    return records.map((rec) => summarize(user, rec, archived)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function summarize(user: string, rec: SessionRecord, archived: Set<string>): SessionSummary {
    const running = hub.runningOf(user, rec.id);
    const said = rec.conversation.filter((m) => m.role === "user" || (m.role === "assistant" && m.content.trim()));
    const first = rec.conversation.find((m) => m.role === "user")?.content ?? running?.input ?? "";
    const last = said.at(-1)?.content ?? running?.input ?? "";
    return {
      id: rec.id,
      createdAt: rec.createdAt,
      updatedAt: running ? running.startedAt : rec.updatedAt,
      turns: rec.turns,
      title: clip(first, 60),
      preview: clip(last, 120),
      archived: archived.has(rec.id),
      status: running ? "running" : "idle",
    };
  }

  async function showSession(user: string, id: string): Promise<SessionRecord & { status: string; archived: boolean; turn: RunningTurn | null; usage: SessionUsage }> {
    const rec = await kernel.sessions.inspect(id, user);
    return { ...rec, archived: store.archived(user).has(id), turn: hub.runningOf(user, id) ?? null, usage: store.usage(user, id) };
  }

  /**
   * Keeps the usage each reply reported, keyed by the reply's index in the conversation, so a reopened
   * transcript shows it. A `message` event is one assistant message; the turn's replies are the last
   * ones in the saved record. A turn that ended in an error is skipped: a cancel leaves a partial
   * reply without an event, and the mapping would be off by one.
   */
  async function recordUsage(user: string, run: RunningTurn): Promise<void> {
    const events = run.events.map((e) => e.event);
    if (events.some((e) => e.type === "error")) return;
    const usages = events.flatMap((e) => (e.type === "message" && e.message.role === "assistant" ? [e.usage] : []));
    if (!usages.some(Boolean)) return;
    const rec = await kernel.sessions.inspect(run.session, user);
    const indices: number[] = [];
    for (let i = rec.conversation.length - 1; i >= 0 && indices.length < usages.length; i--) if (rec.conversation[i].role === "assistant") indices.unshift(i);
    if (indices.length !== usages.length) return;
    const entries: Record<number, Record<string, number>> = {};
    indices.forEach((index, n) => {
      if (usages[n]) entries[index] = usages[n]!;
    });
    if (Object.keys(entries).length) store.setUsage(user, run.session, entries);
  }

  /** Server-Sent Events. First a `snapshot` of the turns in progress, then every event as `turn`. */
  function stream(req: IncomingMessage, res: ServerResponse, user: string): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("snapshot", { user, running: hub.snapshot(user) });
    const unsubscribe = hub.subscribe(user, (message) => send("turn", message));
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  }

  return server;
}

// ---- helpers ----

/** One line of plain text for a sidebar row: markdown markers dropped, whitespace collapsed. */
function clip(text: string, max: number): string {
  const line = text.replace(/^\s*(?:[#>*-]+|\d+[.)])\s+/gm, "").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function codeToStatus(code: string | undefined): number {
  switch (code) {
    case "not-found":
      return 404;
    case "unauthorized":
      return 403;
    case "busy":
      return 409;
    case "invalid":
      return 400;
    default:
      return 500;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { Location: to });
  res.end();
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  const parts = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function wantsJson(req: IncomingMessage): boolean {
  return (req.headers["content-type"] ?? "").startsWith("application/json") || (req.headers.accept ?? "").includes("application/json");
}

/** A cross-site POST cannot carry the SameSite=Strict cookie, and a browser that says so is refused too. */
function checkSameSite(req: IncomingMessage): void {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "cross-site request refused");
}

function safeNext(next: string): string {
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

async function readForm(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (wantsJson(req)) return readJson(req);
  return Object.fromEntries(new URLSearchParams(await readBody(req)));
}

function serveAsset(res: ServerResponse, root: string, name: string, extra: Record<string, string> = {}): void {
  const file = resolve(root, name);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "not found");
  const type = TYPES[extname(file)];
  if (!type) throw new HttpError(404, "not found");
  if (type.startsWith("text/html")) res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'");
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", ...extra });
  res.end(readFileSync(file));
}

export type { Message };

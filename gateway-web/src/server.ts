// The HTTP surface of one person's gateway: static assets, a JSON API over the kernel's session calls,
// and one Server-Sent Events stream per browser that carries every turn event of that person. The
// gateway runs inside the person's own fence, so it holds that person's authority and nobody else's.
// Sign-in lives in @thetis/gateway-login; this server only resolves the cookie it set, and the kernel
// answers only when the token names this fence's user. What installed packages add to the page (their
// browser files and commands) is composed and checked in ui.ts and mounted here under `ext/` and `api/`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelClient, Message, SessionRecord, StepEnv, UserRole } from "@thetis/contracts";
import { HttpError, json, readJson } from "./http.js";
import { handlePanel } from "./panel.js";
import { serveFile } from "./static.js";
import type { GatewayStore, SessionUsage } from "./store.js";
import { TurnHub, type RunningTurn } from "./turns.js";
import { composeUi, runCommand, serveExt } from "./ui.js";

export interface GatewayOptions {
  /** Directory of the static assets. Defaults to the package's `assets/`. */
  assets?: string;
  log?: (line: string) => void;
  /**
   * The fence environment the service was started with. The marketplace index lives in its `shared`
   * directory, and a package's UI commands run with it. Without it the marketplace section and the
   * commands are absent.
   */
  env?: StepEnv;
  /** The store the installed packages are linked in, for their browser files and `main`. Default `env.store`. */
  store?: string;
  /** How long a package's UI command may take before the gateway answers 504. Default 30 000 ms. */
  commandTimeoutMs?: number;
  /** The person this gateway serves. A cookie naming anyone else is refused. */
  user: string;
  /** The URL prefix the door routes here, for example `/alice`. Everything is served under it. Empty for the root. */
  base?: string;
}

const COOKIE = "thetis_web";

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  title: string;
  /** True when the person named the conversation; false when the title is the first message. */
  named: boolean;
  preview: string;
  archived: boolean;
  status: "idle" | "running";
  /** The model the person chose for this conversation. Absent means the default. */
  model?: string;
  /** The cost the replies reported so far, summed. Absent when nothing was reported. */
  cost?: number;
}

/** Builds the gateway. Call `.listen()` on the result with a unix socket path or a port. */
export function createGateway(kernel: KernelClient, store: GatewayStore, opts: GatewayOptions): Server {
  const log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
  const assets = opts.assets ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../assets");
  const base = (opts.base ?? "").replace(/\/$/, "");
  const storeDir = opts.store ?? opts.env?.store;
  const hub = new TurnHub(kernel, log, recordUsage);

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : codeToStatus((err as { code?: string }).code);
      if (status >= 500) log(`[gateway-web] ${req.method} ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (res.headersSent) return res.end();
      json(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  // An install builds inside a fence and can take minutes; the fence's own timeout bounds it.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    if (base && url.pathname === base) return redirect(res, `${base}/`);
    if (base && !url.pathname.startsWith(`${base}/`)) throw new HttpError(404, "not found");
    const path = url.pathname.slice(base.length);

    if (path.startsWith("/assets/")) return serveFile(res, assets, path.slice("/assets/".length));

    const who = await authenticate(req);
    const user = who?.id;
    if (path === "/") {
      if (!user) return redirect(res, `/login?next=${encodeURIComponent(`${base}/`)}`);
      return serveFile(res, assets, "index.html", { "Cache-Control": "no-store" }, { "{{base}}": base });
    }
    if (!path.startsWith("/api/") && !path.startsWith("/ext/")) throw new HttpError(404, "not found");
    if (!user) throw new HttpError(401, "sign in first");
    if (method !== "GET") checkSameSite(req);

    const seg = path.split("/").filter(Boolean); // ["api", ...] or ["ext", scope, name, ...path]
    // A package's browser files and commands. The kernel never reads `thetis.ui`; the gateway validates it here.
    if (seg[0] === "ext") {
      if (method !== "GET" || seg.length < 4 || !storeDir) throw new HttpError(404, "not found");
      return serveExt(res, storeDir, await kernel.packages.list(), seg[1], seg[2], seg.slice(3));
    }
    if (seg[1] === "ui" && seg.length === 2 && method === "GET") return json(res, 200, storeDir ? composeUi(await kernel.packages.list(), who!.role, storeDir) : { extensions: [], refused: [] });
    if (seg[1] === "ext" && seg.length === 5 && method === "POST") {
      if (!storeDir || !opts.env) throw new HttpError(404, "no extensions here");
      const ctx = { kernel, env: opts.env, store: storeDir, timeoutMs: opts.commandTimeoutMs };
      return json(res, 200, await runCommand(ctx, who!, seg[2], seg[3], seg[4], await readJson(req)));
    }
    if (seg[1] === "me" && method === "GET") return json(res, 200, { user, role: who!.role });
    if (seg[1] === "events" && method === "GET") return stream(req, res, user);
    if (seg[1] === "models" && seg.length === 2 && method === "GET") return json(res, 200, await kernel.models());
    if (await handlePanel({ kernel, env: opts.env }, req, res, who!, seg, method, url)) return;
    if (seg[1] === "sessions") {
      if (seg.length === 2 && method === "GET") return json(res, 200, await listSessions(user));
      if (seg.length === 2 && method === "POST") return json(res, 201, { id: (await kernel.sessions.create()).id });
      const id = seg[2];
      if (!/^s_[a-f0-9]+$/.test(id ?? "")) throw new HttpError(404, "unknown session");
      if (seg.length === 3 && method === "GET") return json(res, 200, await showSession(user, id));
      if (seg[3] === "send" && method === "POST") {
        const body = await readJson(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) throw new HttpError(400, "text is required");
        const run = await hub.start(user, id, text, store.model(user, id));
        return json(res, 202, { session: id, startedAt: run.startedAt, model: run.model ?? null });
      }
      if (seg[3] === "model" && method === "POST") {
        await kernel.sessions.inspect(id);
        const body = await readJson(req);
        const model = typeof body.model === "string" ? body.model.trim() : "";
        if (model.length > 200) throw new HttpError(400, "model id too long");
        store.setModel(user, id, model);
        return json(res, 200, { id, model: model || null });
      }
      if (seg[3] === "title" && method === "POST") {
        await kernel.sessions.inspect(id);
        const body = await readJson(req);
        const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
        store.setTitle(user, id, title);
        return json(res, 200, { id, title: title || null });
      }
      if (seg[3] === "cancel" && method === "POST") {
        await kernel.sessions.inspect(id);
        return json(res, 200, { cancelled: await hub.cancel(user, id) });
      }
      if (seg[3] === "archive" && method === "POST") {
        await kernel.sessions.inspect(id);
        const body = await readJson(req);
        store.setArchived(user, id, body.archived !== false);
        return json(res, 200, { id, archived: body.archived !== false });
      }
    }
    throw new HttpError(404, "not found");
  }

  /** The kernel answers a fence only about its own user; the gateway still checks the name it serves. */
  async function authenticate(req: IncomingMessage): Promise<{ id: string; role: UserRole } | undefined> {
    const token = cookies(req)[COOKIE];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const who = await kernel.auth.authenticate(token);
    return who && who.id === opts.user ? who : undefined;
  }

  async function listSessions(user: string): Promise<SessionSummary[]> {
    const archived = store.archived(user);
    const refs = (await kernel.sessions.list()).filter((s) => !s.parent);
    const records = await Promise.all(refs.map((s) => kernel.sessions.inspect(s.id)));
    return records.map((rec) => summarize(user, rec, archived)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function summarize(user: string, rec: SessionRecord, archived: Set<string>): SessionSummary {
    const running = hub.runningOf(user, rec.id);
    const said = rec.conversation.filter((m) => m.role === "user" || (m.role === "assistant" && m.content.trim()));
    const first = rec.conversation.find((m) => m.role === "user")?.content ?? running?.input ?? "";
    const last = said.at(-1)?.content ?? running?.input ?? "";
    const named = store.title(user, rec.id);
    const cost = totalCost(store.usage(user, rec.id));
    const model = store.model(user, rec.id);
    return {
      id: rec.id,
      createdAt: rec.createdAt,
      updatedAt: running ? running.startedAt : rec.updatedAt,
      turns: rec.turns,
      title: named ?? clip(first, 60),
      named: named !== undefined,
      preview: clip(last, 120),
      archived: archived.has(rec.id),
      status: running ? "running" : "idle",
      ...(model ? { model } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };
  }

  async function showSession(user: string, id: string): Promise<SessionRecord & { status: string; archived: boolean; turn: RunningTurn | null; usage: SessionUsage; model: string | null; title: string | null }> {
    const rec = await kernel.sessions.inspect(id);
    return { ...rec, archived: store.archived(user).has(id), turn: hub.runningOf(user, id) ?? null, usage: store.usage(user, id), model: store.model(user, id) ?? null, title: store.title(user, id) ?? null };
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
    const rec = await kernel.sessions.inspect(run.session);
    const indices: number[] = [];
    for (let i = rec.conversation.length - 1; i >= 0 && indices.length < usages.length; i--) if (rec.conversation[i].role === "assistant") indices.unshift(i);
    if (indices.length !== usages.length) return;
    const entries: Record<number, Record<string, number | string>> = {};
    indices.forEach((index, n) => {
      if (usages[n]) entries[index] = run.model ? { ...usages[n]!, model: run.model } : usages[n]!;
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

/** The `cost` fields of the recorded usage, summed; undefined when none was reported. */
function totalCost(usage: SessionUsage): number | undefined {
  let total: number | undefined;
  for (const u of Object.values(usage)) if (typeof u.cost === "number") total = (total ?? 0) + u.cost;
  return total;
}

/** One line of plain text for a sidebar row: markdown markers dropped, whitespace collapsed. */
function clip(text: string, max: number): string {
  const line = text
    .replace(/^\s*\|?\s*:?-{2,}[\s:|-]*$/gm, "") // a table's delimiter row
    .replace(/^\s*(?:[#>*-]+|\d+[.)])\s+/gm, "")
    .replace(/[`*|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { Location: to });
  res.end();
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** A cross-site POST cannot carry the SameSite=Strict cookie, and a browser that says so is refused too. */
function checkSameSite(req: IncomingMessage): void {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "cross-site request refused");
}

export type { Message };

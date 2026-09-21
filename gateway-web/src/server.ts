// The HTTP surface of one person's gateway: static assets, a JSON API over the kernel's session calls,
// and one Server-Sent Events stream per browser that carries every turn event of that person. The
// gateway runs inside the person's own fence, so it holds that person's authority and nobody else's.
// Sign-in lives in @thetis/gateway-login; this server only resolves the cookie it set, and the kernel
// answers only when the token names this fence's user. What installed packages add to the page (their
// browser files and commands) is composed and checked in ui.ts and mounted here under `ext/` and `api/`.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelClient, Message, ModelChoices, SessionRecord, SessionSummaryRef, StepEnv, UserRole } from "@thetis/contracts";
import { HttpError, json, readJson } from "./http.js";
import { handlePanel } from "./panel.js";
import { serveFile } from "./static.js";
import type { GatewayStore, SessionUsage } from "./store.js";
import { TurnHub, type RunningTurn } from "./turns.js";
import { composeUi, openStream, runCommand, serveExt } from "./ui.js";

export interface GatewayOptions {
  /** Directory of the static assets. Defaults to the package's `assets/`. */
  assets?: string;
  log?: (line: string) => void;
  /** The fence environment the service was started with. A package's UI commands run with it; without it they are absent. */
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
const MODELS_TTL_MS = 60_000;

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
  /** The cost the replies reported so far, summed, the conversation's subagents included. Absent when nothing was reported. */
  cost?: number;
}

/** A subagent of a conversation, as `GET /api/sessions/<id>` lists it under `children`. */
export interface ChildRecord {
  id: string;
  parent: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  status: "idle" | "running";
  /** The label the parent gave, from its `[subagent <id> <label>]` result; null when none. */
  label: string | null;
  /** The child's first user message, or the input of its running turn. */
  task: string;
  conversation: Message[];
  usage: SessionUsage;
  /** The cost the child's replies reported, its own subagents included. Absent when nothing was reported. */
  cost?: number;
  turn: RunningTurn | null;
}

/** The first line of a `spawn_subagent` result, as every reader parses it: the child's id and, when the parent gave one, its label. */
const SUBAGENT_LINE = /^\[subagent (s_[a-f0-9]+)(?: ([^\]]*))?\]/;

/** Builds the gateway. Call `.listen()` on the result with a unix socket path or a port. */
export function createGateway(kernel: KernelClient, store: GatewayStore, opts: GatewayOptions): Server {
  const log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
  const assets = opts.assets ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../assets");
  const base = (opts.base ?? "").replace(/\/$/, "");
  const storeDir = opts.store ?? opts.env?.store;
  const hub = new TurnHub(kernel, log, recordUsage, opts.user);
  // The models list is hundreds of rows and a page asks for it once per load; the fence's providers change
  // rarely, so one answer serves for a minute and carries only what the picker draws.
  let choices: { at: number; value: Promise<ModelChoices> } | undefined;

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
      // A fresh nonce per page: the policy allows the stylesheets this response's own code writes, and nothing else.
      return serveFile(res, assets, "index.html", { "Cache-Control": "no-store" }, { "{{base}}": base, "{{nonce}}": randomBytes(16).toString("base64") });
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
    if (seg[1] === "ext" && seg.length === 6 && seg[5] === "stream" && method === "GET") {
      if (!storeDir || !opts.env) throw new HttpError(404, "no extensions here");
      const ctx = { kernel, env: opts.env, store: storeDir };
      const abort = new AbortController();
      req.on("close", () => abort.abort());
      return pump(res, await openStream(ctx, who!, seg[2], seg[3], seg[4], url.searchParams, abort.signal), abort.signal);
    }
    if (seg[1] === "me" && method === "GET") return json(res, 200, { user, role: who!.role });
    if (seg[1] === "events" && method === "GET") return stream(req, res, user);
    if (seg[1] === "models" && seg.length === 2 && method === "GET") return json(res, 200, await modelChoices());
    if (await handlePanel(kernel, req, res, who!, seg, method, url)) return;
    if (seg[1] === "sessions") {
      if (seg.length === 2 && method === "GET") return json(res, 200, await listSessions(user));
      if (seg.length === 2 && method === "POST") {
        const { id } = await kernel.sessions.create();
        listChanged(user);
        return json(res, 201, { id });
      }
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
        listChanged(user);
        return json(res, 200, { id, model: model || null });
      }
      if (seg[3] === "title" && method === "POST") {
        await kernel.sessions.inspect(id);
        const body = await readJson(req);
        const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
        store.setTitle(user, id, title);
        listChanged(user);
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
        listChanged(user);
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

  async function modelChoices(): Promise<ModelChoices> {
    if (!choices || Date.now() - choices.at > MODELS_TTL_MS) {
      const value = kernel.models().then(
        (c) => ({ model: c.model, models: c.models.map(({ id, name, provider }) => ({ id, ...(name ? { name } : {}), ...(provider ? { provider } : {}) })) }),
        (err: unknown) => {
          choices = undefined; // a refusal is not kept for a minute
          throw err;
        },
      );
      choices = { at: Date.now(), value };
    }
    return choices.value;
  }

  /** The list is built from the kernel's summaries alone: no record is read, however many conversations there are. */
  async function listSessions(user: string): Promise<SessionSummary[]> {
    const archived = store.archived(user);
    const all = await kernel.sessions.list();
    return all
      .filter((s) => !s.parent)
      .map((s) => summarize(user, s, archived, descendants(all, s.id)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** `below` is the conversation's subagents at any depth: what they cost is part of what the conversation cost. */
  function summarize(user: string, s: SessionSummaryRef, archived: Set<string>, below: string[]): SessionSummary {
    const running = hub.runningOf(user, s.id);
    const named = store.title(user, s.id);
    const cost = costOf(user, [s.id, ...below]);
    const model = store.model(user, s.id);
    return {
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: running ? running.startedAt : s.updatedAt,
      turns: s.turns,
      title: named ?? clip(s.first || running?.input || "", 60),
      named: named !== undefined,
      preview: clip(s.last || running?.input || "", 120),
      archived: archived.has(s.id),
      status: running || s.running ? "running" : "idle",
      ...(model ? { model } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };
  }

  async function showSession(user: string, id: string): Promise<Omit<SessionRecord, "turn"> & { status: string; archived: boolean; turn: RunningTurn | null; usage: SessionUsage; model: string | null; title: string | null; children: ChildRecord[] }> {
    const { turn: _marker, ...rec } = await kernel.sessions.inspect(id);
    const all = await kernel.sessions.list();
    const labels = labelsOf(user, rec);
    const children = await Promise.all(all.filter((s) => s.parent === id).map((s) => childRecord(user, s.id, labels.get(s.id) ?? null, descendants(all, s.id))));
    // `turn` is the hub's, never the record's marker: a marker left by an interrupted turn would put the
    // page in a turn nothing will end, while its message is in the conversation already.
    return { ...rec, archived: store.archived(user).has(id), turn: hub.runningOf(user, id) ?? null, usage: store.usage(user, id), model: store.model(user, id) ?? null, title: store.title(user, id) ?? null, children };
  }

  async function childRecord(user: string, id: string, label: string | null, below: string[]): Promise<ChildRecord> {
    const rec = await kernel.sessions.inspect(id);
    const turn = hub.runningOf(user, id) ?? null;
    const cost = costOf(user, [id, ...below]);
    return {
      id: rec.id,
      parent: rec.parent ?? "",
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      turns: rec.turns,
      status: rec.status,
      label,
      task: rec.conversation.find((m) => m.role === "user")?.content ?? turn?.input ?? "",
      conversation: rec.conversation,
      usage: store.usage(user, id),
      ...(cost !== undefined ? { cost } : {}),
      turn,
    };
  }

  /**
   * The labels a conversation's `spawn_subagent` results gave, by child id. A result of the turn in progress is
   * not in the saved conversation yet, so the running turn's `tool.result` events are read too.
   */
  function labelsOf(user: string, rec: SessionRecord): Map<string, string | null> {
    const texts = rec.conversation.filter((m) => m.role === "tool").map((m) => m.content);
    for (const { event } of hub.runningOf(user, rec.id)?.events ?? []) if (event.type === "tool.result") texts.push(event.result);
    const labels = new Map<string, string | null>();
    for (const text of texts) {
      const m = SUBAGENT_LINE.exec(text);
      if (m) labels.set(m[1], m[2]?.trim() || null);
    }
    return labels;
  }

  /** The recorded cost of these sessions, summed; undefined when none of them reported any. */
  function costOf(user: string, ids: string[]): number | undefined {
    let total: number | undefined;
    for (const id of ids) {
      const cost = totalCost(store.usage(user, id));
      if (cost !== undefined) total = (total ?? 0) + cost;
    }
    return total;
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

  /** The open streams per user, told `sessions` when this gateway changed the list, so every tab redraws it. */
  const streams = new Map<string, Set<() => void>>();
  function listChanged(user: string): void {
    for (const fn of streams.get(user) ?? []) fn();
  }

  /**
   * Server-Sent Events. First a `snapshot` of the turns in progress, then every event as `turn`, and
   * `sessions` (no body) whenever a conversation was created, named, archived or given a model here.
   */
  function stream(req: IncomingMessage, res: ServerResponse, user: string): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("snapshot", { user, running: hub.snapshot(user) });
    const unsubscribe = hub.subscribe(user, (message) => send("turn", message));
    const onList = () => send("sessions", {});
    let set = streams.get(user);
    if (!set) streams.set(user, (set = new Set()));
    set.add(onList);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      set!.delete(onList);
    });
  }

  /**
   * One extension's stream, in the shape of `/api/events`: every value the export yields as an `item`,
   * then `end`, or `error` when it throws. There is no timeout and no size cap here, because the package
   * decides how long its stream runs and how much it says; the gateway's part is to stop when the browser
   * lets go, which aborts the signal the export was given and closes its iterator, whichever it watches.
   */
  async function pump(res: ServerResponse, items: AsyncIterable<unknown>, signal: AbortSignal): Promise<void> {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
    const iterator = items[Symbol.asyncIterator]();
    const close = () => {
      clearInterval(keepAlive); // the socket is already gone, and a write to it would throw where nobody catches
      void iterator.return?.().catch(() => {});
    };
    signal.addEventListener("abort", close);
    try {
      for (;;) {
        const next = await iterator.next();
        if (signal.aborted) return;
        if (next.done) break;
        send("item", next.value);
      }
      send("end", {});
    } catch (err) {
      if (!signal.aborted) send("error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      signal.removeEventListener("abort", close);
      clearInterval(keepAlive);
      res.end();
    }
  }

  return server;
}

// ---- helpers ----

/** The sessions under `id` at any depth, in creation order. `refs` is in creation order too, and a child is created after its parent, so one pass finds them. */
function descendants(refs: { id: string; parent?: string }[], id: string): string[] {
  const under = new Set([id]);
  const out: string[] = [];
  for (const s of refs) {
    if (!s.parent || !under.has(s.parent)) continue;
    under.add(s.id);
    out.push(s.id);
  }
  return out;
}

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

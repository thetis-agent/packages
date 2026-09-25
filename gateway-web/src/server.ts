import { MAX_ASSET_BYTES } from "@thetis/runtime/lib/assets";
import { contentText, normalizeTurnInput } from "@thetis/runtime/lib/content";
// The HTTP surface of one person's gateway: static assets, a JSON API over the kernel's session calls,
// and one Server-Sent Events stream per browser that carries every turn event of that person. The
// gateway runs inside the person's own fence, so it holds that person's authority and nobody else's.
// Sign-in lives in @thetis/gateway-login; this server only resolves the cookie it set, and the kernel
// answers only when the token names this fence's user. What installed packages add to the page (their
// browser files and commands) is composed and checked in ui.ts and mounted here under `ext/` and `api/`.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { KernelClient, Message, ModelChoices, SessionRecord, SessionSummaryRef, StepEnv, UserRole } from "@thetis/runtime/contracts";
import { withoutTurnContext } from "@thetis/harness-core";
import { HttpError, json, readBytes, readJson } from "./http.js";
import { handlePanel } from "./panel.js";
import { serveFile } from "./static.js";
import { sniffImage, type GatewayStore, type SessionUsage } from "./store.js";
import { TurnHub, type RunningTurn } from "./turns.js";
import { argsFromQuery, composeUi, openStream, runCommand, runRaw, serveExt } from "./ui.js";

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
/** `remember: false` sets this conversation's model without making it the person's default for new ones (a workflow naming its own conversations). */
const ModelRequestSchema = z.looseObject({ model: z.string().trim().max(200, "model id too long").default(""), remember: z.boolean().default(true) });
const TitleRequestSchema = z.looseObject({ title: z.string().default("").transform((title) => title.replace(/\s+/g, " ").trim().slice(0, 120)) });
const ArchiveRequestSchema = z.looseObject({ archived: z.boolean().default(true) });
/**
 * How large an uploaded avatar may be. It is a 22-pixel tile in the footer and a 34-pixel one in the
 * gutter, so half a megabyte is already far more than the picture can ever show; the number is here to
 * bound what an authenticated person can make the gateway hold in memory and write into their home, not
 * to be generous. The page shrinks anything bigger before it sends, so the limit rarely reaches anyone.
 */
const AVATAR_LIMIT = 512 * 1024;

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
    if (seg[1] === "ext" && seg.length === 6 && seg[5] === "raw" && (method === "GET" || method === "PUT")) {
      if (!storeDir || !opts.env) throw new HttpError(404, "no extensions here");
      const ctx = { kernel, env: opts.env, store: storeDir, timeoutMs: opts.commandTimeoutMs };
      const args = argsFromQuery(url.searchParams);
      const session = url.searchParams.get("session") ?? undefined;
      if (method === "PUT") {
        // The body is read only once the checks have passed, and only up to the command's own `maxBytes`:
        // a refused upload is refused before its bytes are held, as `/api/media` holds nothing over its cap.
        const body = (maxBytes: number) => readBytes(req, maxBytes, "That upload");
        return json(res, 200, await runRaw(ctx, who!, seg[2], seg[3], seg[4], { method: "PUT", args, session, body }));
      }
      const abort = new AbortController();
      const answer = await runRaw(ctx, who!, seg[2], seg[3], seg[4], { method: "GET", args, session, signal: abort.signal });
      return sendRaw(req, res, answer, abort);
    }
    if (seg[1] === "media" && seg.length === 2 && method === "POST") {
      const bytes = await readBytes(req, MAX_ASSET_BYTES, "That attachment");
      const mediaType = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();
      const name = url.searchParams.get("name") ?? undefined;
      return json(res, 201, await kernel.assets.put({ mediaType, name, data: bytes.toString("base64") }));
    }
    if (seg[1] === "media" && seg.length === 3 && method === "GET") {
      const { asset, data } = await kernel.assets.read(seg[2]);
      const inline = /^(image\/(png|jpeg|webp|gif)|audio\/(mpeg|mp3|wav|x-wav|ogg|flac|aac|mp4)|video\/(mp4|webm|ogg))$/.test(asset.mediaType);
      res.writeHead(200, { "Content-Type": asset.mediaType, "Cache-Control": "no-store", "Content-Disposition": inline ? "inline" : "attachment", "Content-Security-Policy": "default-src 'none'; sandbox" });
      res.end(Buffer.from(data, "base64"));
      return;
    }
    if (seg[1] === "me" && seg.length === 2 && method === "GET") return json(res, 200, { user, role: who!.role, avatar: avatarUrl(user) });
    if (seg[1] === "me" && seg[2] === "avatar" && seg.length === 3) {
      if (method === "GET") return sendAvatar(res, user);
      if (method === "PUT") {
        // The page sends the `File` itself as the body: raw bytes, no multipart, and so no parser to get
        // wrong. The declared type travels only so a refusal can quote it back — what the file is, is read
        // off its first bytes, here and again in the store. `checkSameSite` above has already run, so a
        // page on another origin cannot post here with this person's cookie.
        const bytes = await readBytes(req, AVATAR_LIMIT, "That image");
        if (!sniffImage(bytes)) throw new HttpError(415, "That file is not a PNG, JPEG, WebP or GIF image.");
        store.setAvatar(user, bytes, String(req.headers["content-type"] ?? ""));
        return json(res, 200, { avatar: avatarUrl(user) });
      }
      if (method === "DELETE") {
        store.deleteAvatar(user);
        return json(res, 200, { avatar: null });
      }
    }
    // Every route pins its length. A predicate that only looks at one segment matches everything below it
    // too, which is how `GET /api/me/avatar` was very nearly swallowed whole by the handler for `/api/me`.
    if (seg[1] === "events" && seg.length === 2 && method === "GET") return stream(req, res, user);
    if (seg[1] === "models" && seg.length === 2 && method === "GET") return json(res, 200, await modelChoices());
    if (await handlePanel(kernel, req, res, who!, seg, method, url)) return;
    if (seg[1] === "sessions") {
      if (seg.length === 2 && method === "GET") return json(res, 200, await listSessions(user));
      if (seg.length === 2 && method === "POST") {
        const { id } = await kernel.sessions.create();
        // A new conversation starts with the model the person chose last, so a choice sticks across conversations.
        const remembered = store.lastModel(user);
        if (remembered) store.setModel(user, id, remembered);
        listChanged(user);
        return json(res, 201, { id, model: remembered ?? null });
      }
      const id = seg[2];
      if (!/^s_[a-f0-9]+$/.test(id ?? "")) throw new HttpError(404, "unknown session");
      if (seg.length === 3 && method === "GET") return json(res, 200, await showSession(user, id));
      if (seg.length === 3 && method === "DELETE") {
        // Only a conversation nothing was ever said in: the page discards the ones a person opened and
        // walked away from, so a day's clicks on `+` do not pile up as "New conversation" in the history.
        // Anything with a turn, or a turn in flight, is refused — a record with words in it is archived,
        // never removed, and a page whose list is a moment stale must not be able to take one with it.
        // A subagent is refused whatever is in it: it is work inside a conversation, and one is empty and
        // idle for the instant between its creation and its first turn. The page asks for this on its own,
        // as tidying nobody requested, so a 409 here is an answer it is expected to ignore in silence.
        const rec = await kernel.sessions.inspect(id);
        const busy = rec.status === "running" || Boolean(hub.runningOf(user, id));
        if (rec.parent || rec.turns > 0 || rec.conversation.length > 0 || busy) throw new HttpError(409, "only an empty conversation can be discarded");
        await kernel.sessions.delete(id);
        // Everything this gateway kept about it goes with the record, the archive mark included: a mark on
        // an id nothing answers to any more would be read at every start and never be true of anything.
        store.forget(user, id);
        listChanged(user);
        return json(res, 200, { id, deleted: true });
      }
      if (seg[3] === "send" && seg.length === 4 && method === "POST") {
        const body = await readJson(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (body.input === undefined && !text) throw new HttpError(400, "text or input is required");
        const input = body.input === undefined ? text : normalizeTurnInput(body.input);
        const run = await hub.start(user, id, input, store.model(user, id));
        return json(res, 202, { session: id, startedAt: run.startedAt, model: run.model ?? null });
      }
      if (seg[3] === "model" && seg.length === 4 && method === "POST") {
        await kernel.sessions.inspect(id);
        const { model, remember } = await readJson(req, ModelRequestSchema);
        store.setModel(user, id, model);
        if (remember) store.setLastModel(user, model);
        listChanged(user);
        return json(res, 200, { id, model: model || null });
      }
      if (seg[3] === "title" && seg.length === 4 && method === "POST") {
        await kernel.sessions.inspect(id);
        const { title } = await readJson(req, TitleRequestSchema);
        store.setTitle(user, id, title);
        listChanged(user);
        return json(res, 200, { id, title: title || null });
      }
      if (seg[3] === "cancel" && seg.length === 4 && method === "POST") {
        await kernel.sessions.inspect(id);
        return json(res, 200, { cancelled: await hub.cancel(user, id) });
      }
      if (seg[3] === "archive" && seg.length === 4 && method === "POST") {
        await kernel.sessions.inspect(id);
        const { archived } = await readJson(req, ArchiveRequestSchema);
        store.setArchived(user, id, archived);
        listChanged(user);
        return json(res, 200, { id, archived });
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

  /**
   * The URL of the person's own picture, or null. The `v` is when the picture was written: the response
   * says `no-store`, so this is not about caches but about the `<img>` element, which does not fetch a
   * `src` that did not change — without it the person who just replaced their picture would keep seeing
   * the old one until the next reload.
   */
  function avatarUrl(user: string): string | null {
    const held = store.getAvatar(user);
    return held ? `${base}/api/me/avatar?v=${Math.round(held.at)}` : null;
  }

  /**
   * Sends the picture with the type its own bytes said it was, never one the uploader named. Every response
   * from this server already carries `X-Content-Type-Options: nosniff`, so a browser will treat it as that
   * type and nothing else; together with the four types the store accepts — SVG deliberately not among them
   * — there is no way for an uploaded file to become a document running on this person's origin. `no-store`
   * because the URL is the same after a replacement and a stale copy would outlive the picture it shows.
   * A file gone between the store's map and this read is simply a 404: the person removed it mid-request.
   */
  function sendAvatar(res: ServerResponse, user: string): void {
    const held = store.getAvatar(user);
    let bytes: Buffer | undefined;
    try {
      if (held) bytes = readFileSync(held.path);
    } catch {
      bytes = undefined;
    }
    if (!held || !bytes) throw new HttpError(404, "no avatar");
    res.writeHead(200, { "Content-Type": held.mime, "Content-Length": bytes.length, "Cache-Control": "no-store" });
    res.end(bytes);
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

  /**
   * A kernel summary is the record's words, whitespace collapsed and clipped to 200 characters, so the turn
   * context line the harness appends may arrive on one space, or cut short; both are taken off here.
   */
  const withoutTurnContextTail = (text: string): string => text.replace(/\s*\[Turn context:[^\]]*(?:\]|…)?$/, "");

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
      title: named ?? clip(withoutTurnContextTail(s.first) || running?.input || "", 60),
      named: named !== undefined,
      preview: clip(withoutTurnContextTail(s.last) || running?.input || "", 120),
      archived: archived.has(s.id),
      status: running || s.running ? "running" : "idle",
      ...(model ? { model } : {}),
      ...(cost !== undefined ? { cost } : {}),
    };
  }

  async function showSession(user: string, id: string) {
    const all = await kernel.sessions.list();
    const children = await Promise.all(all.filter((s) => s.parent === id).map((s) => childRecord(user, s.id, descendants(all, s.id))));
    // Read the parent last: a turn may finish while the list or a child's record is on its way back.
    const { rec, turn } = await sessionSnapshot(user, id);
    const labels = labelsOf(user, rec);
    for (const child of children) child.label = labels.get(child.id) ?? null;
    // `turn` is the hub's, never the record's marker: a marker left by an interrupted turn would put the
    // page in a turn nothing will end, while its message is in the conversation already.
    return { ...rec, archived: store.archived(user).has(id), turn, usage: store.usage(user, id), model: store.model(user, id) ?? null, title: store.title(user, id) ?? null, children };
  }

  /** Retry when a turn starts or ends during the RPC, so saved history and its live overlay agree. */
  async function sessionSnapshot(user: string, id: string) {
    for (;;) {
      const running = hub.runningOf(user, id);
      const { turn: marker, ...rec } = await kernel.sessions.inspect(id);
      if (running !== hub.runningOf(user, id)) continue;
      // No marker means the final save has landed, even if its closing event has not arrived yet.
      return { rec, turn: marker ? running ?? null : null };
    }
  }

  async function childRecord(user: string, id: string, below: string[]): Promise<ChildRecord> {
    const { rec, turn } = await sessionSnapshot(user, id);
    const cost = costOf(user, [id, ...below]);
    return {
      id: rec.id,
      parent: rec.parent ?? "",
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      turns: rec.turns,
      status: rec.status,
      label: null,
      task: withoutTurnContext(contentText(rec.conversation.find((m) => m.role === "user")?.content) || turn?.input || ""),
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
    const texts = rec.conversation.filter((m) => m.role === "tool").map((m) => contentText(m.content));
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
   * A raw command's GET answer: the export's status and headers, under the gateway's own `no-store` and the
   * policy `/api/media` serves under — the bytes came from a package, and a page that carried script must
   * not run as this origin. A Buffer or string ends the response; a Readable is piped and destroyed when the
   * browser lets go, which also aborts the signal the export was given. Once the headers are out an error
   * can only cut the connection: the JSON refusal belongs to whatever failed before them.
   */
  function sendRaw(req: IncomingMessage, res: ServerResponse, answer: { status: number; headers: Record<string, string>; body: Readable | Buffer | string }, abort: AbortController): void {
    res.writeHead(answer.status, { ...answer.headers, "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; sandbox" });
    const { body } = answer;
    if (!(body instanceof Readable)) return void res.end(body);
    const letGo = () => {
      if (!res.writableFinished) abort.abort(); // a download that finished was not let go of
      if (!body.destroyed) body.destroy();
    };
    req.on("close", letGo);
    res.on("close", letGo);
    body.once("error", (err) => {
      log(`[gateway-web] ${req.method} ${req.url}: the raw body failed: ${err instanceof Error ? err.message : String(err)}`);
      res.destroy();
    });
    body.pipe(res);
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

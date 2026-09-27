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
import { buildIdentity } from "./build.js";
import { FrameTokens, TOKEN } from "./frames.js";
import { handlePanel } from "./panel.js";
import { serveFile } from "./static.js";
import { sniffImage, type GatewayStore, type ResumedMark, type SessionUsage } from "./store.js";
import { TurnHub, type RunningTurn } from "./turns.js";
import { argsFromQuery, composeUi, framePath, mintFrame, openStream, runCommand, runRaw, serveExt, serveFrameFile } from "./ui.js";

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
  /** How long a frame token serves before the page must mint another. Default 12 hours. */
  frameTtlMs?: number;
}

const COOKIE = "thetis_web";
/**
 * The policy a frame's documents run under. `sandbox allow-scripts` gives the document an opaque origin
 * with scripts: it can draw itself and nothing more. It may load its own pictures, styles, scripts, fonts
 * and media from under its own token (`'self'` is the origin of the URL the policy came with, not the
 * document's opaque one), fonts from Google, inline style and script because that is what a self-contained
 * artboard is made of; it may not fetch, embed, submit or set a base, so nothing it holds can be sent
 * anywhere. `frame-ancestors 'self'` keeps it inside this app.
 */
const framePolicy = (own = "'self'"): string =>
  `sandbox allow-scripts; default-src 'none'; script-src ${own} 'unsafe-inline'; style-src ${own} 'unsafe-inline' https://fonts.googleapis.com; font-src ${own} data: https://fonts.gstatic.com; img-src ${own} data: blob:; media-src ${own}; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`;
export const FRAME_POLICY = framePolicy();
const MODELS_TTL_MS = 60_000;
/** `remember: false` sets this conversation's model without making it the person's default for new ones (a workflow naming its own conversations). */
const ModelRequestSchema = z.looseObject({ model: z.string().trim().max(200, "model id too long").default(""), remember: z.boolean().default(true) });
const NewSessionRequestSchema = z.looseObject({ model: z.string().trim().max(200, "model id too long").optional() });
const TitleRequestSchema = z.looseObject({ title: z.string().default("").transform((title) => title.replace(/\s+/g, " ").trim().slice(0, 120)) });
const ArchiveRequestSchema = z.looseObject({ archived: z.boolean().default(true) });
const PrefsRequestSchema = z.looseObject({ developer: z.boolean().optional() });
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
  /** Why the child's last turn did not finish, as the kernel recorded it. */
  interrupted?: SessionRecord["interrupted"];
  /** Where a turn of the child resumed an interrupted one. */
  resumed: ResumedMark[];
  /** When a person stopped the child's last turn, or null. */
  stopped: string | null;
}

/** The first line of a `spawn_subagent` result, as every reader parses it: the child's id and, when the parent gave one, its label. */
const SUBAGENT_LINE = /^\[subagent (s_[a-f0-9]+)(?: ([^\]]*))?\]/;

/** The package whose marks on a message say it was cut off (`partial`) or is a tool result for a call that never ran (`notRun`). */
const HARNESS = "@thetis/harness-core";

/** The harness's mark on a message, read loosely: a record written before the marks existed has none. */
export function markOf(message: Message | undefined, key: "partial" | "notRun"): boolean {
  const marks = (message as { extensions?: Record<string, Record<string, unknown> | undefined> } | undefined)?.extensions?.[HARNESS];
  return marks?.[key] === true;
}

/**
 * Why a conversation has nothing to resume, or undefined when a turn with no input would carry on from
 * where it stopped. It has something when its last turn was interrupted, when a person stopped it here, or
 * when its saved conversation does not end on a finished reply: a user message nobody answered, a tool
 * result the model never read, a reply marked as cut off, or a reply whose tool calls have no results.
 * A conversation that ends on a complete answer has nothing to resume, and a resume there would only make
 * the model talk again unasked.
 */
/**
 * The pending restart in a `restart.status` answer, as waits from `now`. An admin's answer carries the latch's
 * `pending`; a person's is the countdown alone (`armed`, `reason`, `firesAt`, `deadlineAt`), with nobody's name
 * in it. Both are the same restart, and a page must count down for either.
 */
export function restartPending(answer: unknown, now: number): { reason: string; by: string; firesInMs?: number; deadlineInMs?: number } | null {
  type Pending = { reason?: unknown; by?: unknown; firesAt?: unknown; deadlineAt?: unknown };
  const out = (answer && typeof answer === "object" ? answer : {}) as Pending & { pending?: Pending; armed?: unknown };
  const p = out.pending ?? (out.armed === true ? out : undefined);
  if (!p || typeof p !== "object") return null;
  const inMs = (at: unknown) => (typeof at === "number" && Number.isFinite(at) ? Math.max(0, at - now) : undefined);
  const firesInMs = inMs(p.firesAt);
  const deadlineInMs = inMs(p.deadlineAt);
  return { reason: String(p.reason ?? ""), by: String(p.by ?? ""), ...(firesInMs !== undefined ? { firesInMs } : {}), ...(deadlineInMs !== undefined ? { deadlineInMs } : {}) };
}

export function nothingToResume(rec: Pick<SessionRecord, "conversation"> & { interrupted?: unknown }, stopped?: string): string | undefined {
  if (rec.interrupted || stopped) return undefined;
  const last = rec.conversation.at(-1);
  if (!last) return "nothing to resume: this conversation is empty";
  if (last.role === "user" || last.role === "tool") return undefined;
  if (last.role === "assistant" && (markOf(last, "partial") || last.toolCalls?.length)) return undefined;
  return "nothing to resume: the last reply finished";
}

/**
 * The usage of a turn's replies by their index in the saved conversation. Each reply's `message` event is
 * paired with the saved assistant message that says the same thing, walking back from the end, so a cut-off
 * reply (which has no `message` event, marked `partial` or not) is passed over rather than handed the next
 * reply's usage. Undefined when the record does not hold these replies at all: nothing is guessed then.
 */
/**
 * One row of the model picker: the id, the name and provider, and — where the provider's catalogue gives
 * them — the context window in tokens and the price. `pricing` is passed as the catalogue states it
 * (OpenRouter: dollars per token, as strings), only its `prompt` and `completion`; the page formats it.
 */
export function describeModel(m: { id: string; name?: string; provider?: string; contextLength?: unknown; pricing?: unknown }): { id: string } & Record<string, unknown> {
  const out: { id: string } & Record<string, unknown> = { id: m.id };
  if (m.name) out.name = m.name;
  if (m.provider) out.provider = m.provider;
  if (typeof m.contextLength === "number" && Number.isFinite(m.contextLength) && m.contextLength > 0) out.contextLength = m.contextLength;
  const pricing = m.pricing && typeof m.pricing === "object" ? (m.pricing as Record<string, unknown>) : null;
  const price = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined;
  if (pricing) {
    const prompt = price(pricing.prompt), completion = price(pricing.completion);
    if (prompt !== undefined || completion !== undefined) out.pricing = { ...(prompt !== undefined ? { prompt } : {}), ...(completion !== undefined ? { completion } : {}) };
  }
  return out;
}

export function pairUsage(conversation: Message[], replies: { message: Message; usage?: Record<string, number> }[], model?: string): Record<number, Record<string, number | string>> | undefined {
  const same = (a: Message, b: Message) => contentText(a.content) === contentText(b.content) && (a.toolCalls?.length ?? 0) === (b.toolCalls?.length ?? 0);
  const entries: Record<number, Record<string, number | string>> = {};
  let at = conversation.length - 1;
  for (let n = replies.length - 1; n >= 0; n--) {
    while (at >= 0 && (conversation[at].role !== "assistant" || markOf(conversation[at], "partial") || !same(conversation[at], replies[n].message))) at--;
    if (at < 0) return undefined;
    const usage = replies[n].usage;
    if (usage) entries[at] = model ? { ...usage, model } : usage;
    at--;
  }
  return entries;
}

/** Builds the gateway. Call `.listen()` on the result with a unix socket path or a port. */
export function createGateway(kernel: KernelClient, store: GatewayStore, opts: GatewayOptions): Server {
  const log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
  const assets = opts.assets ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../assets");
  const base = (opts.base ?? "").replace(/\/$/, "");
  const storeDir = opts.store ?? opts.env?.store;
  const hub = new TurnHub(kernel, log, turnEnded, opts.user);
  const frames = new FrameTokens(opts.frameTtlMs !== undefined ? { ttlMs: opts.frameTtlMs } : {});
  const build = buildIdentity(assets);
  /** The build id with the installed packages' browser files counted in; the gateway's own part when the list cannot be read. */
  const currentBuild = async () => build(await kernel.packages.list().catch(() => []));
  // A turn that resumes an interrupted one says so on `turn.start`; where it began in the conversation is
  // kept, so a reopened transcript draws the same "Resumed after …" divider the live one did.
  hub.subscribe(opts.user, (message) => {
    const { event } = message;
    if (event.type !== "turn.start") return;
    const resumed = (event as { resumed?: { why?: unknown; for?: unknown } }).resumed;
    if (!resumed || typeof resumed !== "object") return;
    // A clean pause names what it paused for, which is what the divider says it resumed after.
    const why = resumed.why === "yield" && typeof resumed.for === "string" ? resumed.for : String(resumed.why ?? "");
    void noteResumed(opts.user, message.session, event.turn, why).catch((err: Error) => log(`[gateway-web] the resumed divider of ${message.session} was not kept: ${err.message}`));
  });
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
    // The one route whose credential is in the URL: a frame token stands for the cookie, because the
    // sandboxed document that fetches here has no origin to send one from. Nothing else is skipped.
    if (path.startsWith("/f/")) {
      if (method !== "GET" || !storeDir || !opts.env) throw new HttpError(404, "not found");
      const seg = path.split("/").filter(Boolean);
      const record = TOKEN.test(seg[1] ?? "") ? frames.lookup(seg[1]) : undefined;
      if (!record || record.user !== opts.user) throw new HttpError(404, "not found");
      const ctx = { kernel, env: opts.env, store: storeDir };
      const abort = new AbortController();
      const answer = await serveFrameFile(ctx, record, framePath(seg.slice(2)), abort.signal);
      return sendFrame(req, res, answer, abort);
    }

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
    if (seg[1] === "ext" && seg.length === 6 && seg[5] === "frame" && method === "POST") {
      if (!storeDir || !opts.env) throw new HttpError(404, "no extensions here");
      const ctx = { kernel, env: opts.env, store: storeDir };
      const body = await readJson(req);
      const minted = await mintFrame(ctx, who!, seg[2], seg[3], seg[4], body.args);
      const token = frames.mint({ user, role: who!.role, pkg: minted.pkg.name, verb: minted.verb, args: minted.args });
      return json(res, 201, { token, base: `f/${token}/` });
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
    if (seg[1] === "me" && seg.length === 2 && method === "GET") return json(res, 200, { user, role: who!.role, avatar: avatarUrl(user), build: await currentBuild(), prefs: { developer: store.developer(user) } });
    if (seg[1] === "me" && seg[2] === "prefs" && seg.length === 3 && method === "POST") {
      const { developer } = await readJson(req, PrefsRequestSchema);
      if (developer !== undefined) store.setDeveloper(user, developer);
      return json(res, 200, { developer: store.developer(user) });
    }
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
    // The catalogue is shared and cached; what this person chose is theirs and read fresh: `yours.model` is
    // what a new conversation starts with (null: the configured default), `yours.recent` the picker's Recent.
    if (seg[1] === "models" && seg.length === 2 && method === "GET") return json(res, 200, { ...(await modelChoices()), yours: { model: store.lastModel(user) ?? null, recent: store.recentModels(user) } });
    if (seg[1] === "restart" && seg.length === 2 && method === "GET") return json(res, 200, await restartStatus());
    if (await handlePanel(kernel, req, res, who!, seg, method, url)) return;
    if (seg[1] === "sessions") {
      if (seg.length === 2 && method === "GET") return json(res, 200, await listSessions(user));
      if (seg.length === 2 && method === "POST") {
        // `model`, when the body names one, is what the person picked before the conversation existed (the
        // picker of a `+` draft); it is a choice like any other, so it is remembered for the next one too.
        // An empty string picks the configured default and forgets the remembered choice.
        const { model } = await readJson(req, NewSessionRequestSchema);
        const { id } = await kernel.sessions.create();
        if (model !== undefined) store.setLastModel(user, model);
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
      if (seg[3] === "resume" && seg.length === 4 && method === "POST") {
        // A turn with no input over the saved conversation: the one resume every button uses, Retry and
        // Continue alike. Nothing is appended, so the person's message can never be sent twice.
        const rec = await kernel.sessions.inspect(id);
        if (rec.status === "running" || hub.runningOf(user, id)) throw new HttpError(409, "a turn is running in this conversation");
        const refusal = nothingToResume(rec, store.stopped(user, id));
        if (refusal) throw new HttpError(409, refusal);
        const run = await hub.start(user, id, [], store.model(user, id), rec.parent);
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
        (c) => ({ model: c.model, models: c.models.map(describeModel) }),
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
    return { ...rec, archived: store.archived(user).has(id), turn, usage: store.usage(user, id), model: store.model(user, id) ?? null, title: store.title(user, id) ?? null, resumed: store.resumed(user, id), stopped: store.stopped(user, id) ?? null, children };
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
      ...(rec.interrupted ? { interrupted: rec.interrupted } : {}),
      resumed: store.resumed(user, id),
      stopped: store.stopped(user, id) ?? null,
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

  /** Everything a finished turn leaves behind: whether a person stopped it, and the usage of its replies. */
  async function turnEnded(user: string, run: RunningTurn): Promise<void> {
    const error = run.events.map((e) => e.event).find((e) => e.type === "error") as { code?: string; why?: string } | undefined;
    const stopped = error?.code === "cancelled" && (!error.why || error.why === "stop");
    store.setStopped(user, run.session, stopped ? new Date().toISOString() : undefined);
    await recordUsage(user, run);
  }

  /**
   * Keeps the usage each reply reported, keyed by the reply's index in the conversation, so a reopened
   * transcript shows it. A `message` event is one assistant message; the turn's replies are the last
   * ones in the saved record. A turn that failed or was stopped counts too: what it cost was spent. Its
   * cut-off reply has no `message` event, so each event is paired with the saved reply that says the same
   * thing, walking back from the end, and a reply that matches no event (the cut one, marked `partial` or
   * not) is passed over rather than given someone else's usage.
   */
  async function recordUsage(user: string, run: RunningTurn): Promise<void> {
    const replies = run.events.flatMap(({ event: e }) => (e.type === "message" && e.message.role === "assistant" ? [{ message: e.message as Message, usage: e.usage }] : []));
    if (!replies.some((e) => e.usage)) return;
    const rec = await kernel.sessions.inspect(run.session);
    const entries = pairUsage(rec.conversation, replies, run.model);
    if (entries && Object.keys(entries).length) store.setUsage(user, run.session, entries);
  }

  /**
   * Keeps where a resuming turn began: the length of the saved conversation as it starts, less a trailing
   * reply that was cut off, which the resume drops before it asks the model again. The divider is drawn
   * before the message at that index, which is the first thing the resumed turn said.
   */
  async function noteResumed(user: string, session: string, turn: string, why: string): Promise<void> {
    const rec = await kernel.sessions.inspect(session);
    let index = rec.conversation.length;
    const last = rec.conversation.at(-1);
    if (last?.role === "assistant" && (markOf(last, "partial") || !last.toolCalls?.length)) index -= 1;
    store.addResumed(user, session, { index: Math.max(0, index), why, at: new Date().toISOString(), turn });
  }

  /**
   * Whether Thetis is about to restart, for the notice every person sees. The kernel's latch speaks in
   * epoch milliseconds; the answer here is in milliseconds from now, so a page on a machine whose clock is
   * off still counts down the right number of seconds. A kernel that refuses the question (one from before
   * it was readable by everyone) is answered as "nothing known": the notice is a courtesy, not a guard.
   */
  async function restartStatus(): Promise<{ pending: { reason: string; by: string; firesInMs?: number; deadlineInMs?: number } | null; readable: boolean }> {
    let out: unknown;
    try {
      out = await kernel.operator.call("restart.status");
    } catch {
      return { pending: null, readable: false };
    }
    return { pending: restartPending(out, Date.now()), readable: true };
  }

  /** The open streams per user, told `sessions` when this gateway changed the list, so every tab redraws it. */
  const streams = new Map<string, Set<() => void>>();
  function listChanged(user: string): void {
    for (const fn of streams.get(user) ?? []) fn();
  }

  /**
   * Server-Sent Events. First a `snapshot` of the turns in progress and the build id, then every event as `turn`, and
   * `sessions` (no body) whenever a conversation was created, named, archived or given a model here.
   */
  async function stream(req: IncomingMessage, res: ServerResponse, user: string): Promise<void> {
    // Read before anything is sent: from the snapshot on, the stream must not miss an event, so the
    // snapshot and the subscription happen in one go with no wait between them.
    const buildNow = await currentBuild();
    if (res.destroyed || req.socket?.destroyed) return; // the page let go while the build was read: nothing to subscribe
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("snapshot", { user, running: hub.snapshot(user), build: buildNow });
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
    pipeAnswer(req, res, answer.body, abort);
  }

  /**
   * A frame's answer: the export's status and headers under the frame policy, `no-store` because the URL
   * stays the same after the file changed, and no referrer so the token never travels in one. No
   * `Cross-Origin-Resource-Policy`: the document that loads these has an opaque origin, which no site
   * matches, so `same-site` refused the frame's own pictures; the token is what keeps them private. The
   * body goes out as a raw one does.
   */
  function sendFrame(req: IncomingMessage, res: ServerResponse, answer: { status: number; headers: Record<string, string>; body: Readable | Buffer | string }, abort: AbortController): void {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.writeHead(answer.status, { ...answer.headers, "Cache-Control": "private, no-store", "Content-Security-Policy": FRAME_POLICY });
    pipeAnswer(req, res, answer.body, abort);
  }

  /** The body of a raw or frame answer, once the headers are out: a Buffer or string ends it, a Readable is piped and let go of with the browser. */
  function pipeAnswer(req: IncomingMessage, res: ServerResponse, body: Readable | Buffer | string, abort: AbortController): void {
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

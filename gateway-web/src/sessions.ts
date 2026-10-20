// What happens to a conversation beyond the gateway's own marks: the `thetis.sessions` seam, through which
// an installed package hears that a conversation was archived or restored and takes part in forgetting one,
// and the forget itself. A package declares `"sessions": { "archive": "<export>", "forget": "<export>" }`
// in its `thetis` field; the kernel never reads it, so it is checked here, and a bad declaration skips that
// package and says why in the log, as a bad `ui` is refused by name. A hook runs as the person, through the
// fence's `invokeTool` — the way a harness runs a tool — so the agent loads it fresh and hands it the env of
// its own package: `env.storage` is that package's, not this gateway's, which a hook that forgets a stored
// document depends on. It gets that package's effective configuration and the root conversation as its
// session, under the UI commands' timeout. Nothing here holds more authority than the page already has.
//
// Forgetting removes a conversation for good: its subagents, the hooks' parts, the attachments its messages
// referenced, the records, and this gateway's marks. It never pretends to more than that. What stays — a copy
// quoted into another conversation, the journal's line that a conversation existed, text a provider was
// sent — is said, every time, in the preview and in the receipt.
import { z } from "zod";
import { isAssetPart } from "@thetis/runtime/lib/content";
import type { KernelClient, PackageInfo, SessionInfo, SessionSummaryRef, UserRole } from "@thetis/runtime/contracts";
import { HttpError } from "./http.js";
import type { GatewayStore } from "./store.js";
import { COMMAND_TIMEOUT_MS, EXPORT, packageConfig, withTimeout, type CommandContext } from "./ui.js";

/** What is true after every forget, whatever the hooks did. */
export const ALWAYS_KEPT = [
  "Copies quoted into other conversations stay.",
  "The server's audit journal keeps that a conversation existed, never its words.",
  "Text already sent to the model provider is outside Thetis.",
] as const;

/** A conversation with fewer turns than this may be forgotten without typing its title: there is little in it to lose. */
export const TITLE_FREE_TURNS = 3;
/** How long a forget waits for the turns it stopped to end before it gives up and says so. */
export const STOP_WAIT_MS = 15_000;
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type HookKind = "archive" | "forget";
export interface SessionHook {
  package: string;
  export: string;
}
type Who = { id: string; role: UserRole };

const ForgetItemSchema = z.object({ id: z.string().regex(ITEM_ID), label: z.string().min(1).max(300), optional: z.boolean().optional(), default: z.boolean().optional() });
const PreviewAnswerSchema = z.union([z.undefined(), z.null(), z.looseObject({ items: z.array(ForgetItemSchema).max(20).optional(), block: z.string().min(1).max(300).optional() })]);
const ForgetAnswerSchema = z.union([z.undefined(), z.null(), z.looseObject({ removed: z.array(z.string().max(300)).max(50).optional(), kept: z.array(z.string().max(300)).max(50).optional() })]);
export const ForgetRequestSchema = z.looseObject({
  confirm: z.string().max(400).default(""),
  stop: z.boolean().default(false),
  options: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
});
export type ForgetItem = z.infer<typeof ForgetItemSchema>;
export type ForgetRequest = z.infer<typeof ForgetRequestSchema>;

/** One package's part of the preview: what it would remove (the optional ones are the dialog's checkboxes), and why it must not happen now. */
export interface HookPreview {
  package: string;
  items: ForgetItem[];
  block?: string;
}

export interface ForgetPreview {
  id: string;
  title: string;
  turns: number;
  /** The conversation and every subagent under it, root first. */
  subtree: string[];
  running: boolean;
  attachments: number;
  hooks: HookPreview[];
  kept: string[];
}

export interface ForgetReceipt {
  id: string;
  removed: string[];
  kept: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Checks `thetis.sessions` of one package. Undefined when it declares none; an error sentence when the
 * declaration is unusable, in which case the whole package is skipped rather than half of it run. Keys the
 * gateway does not read are left alone, so a later hook kind does not refuse a package an older gateway meets.
 */
export function validateSessions(info: PackageInfo): { sessions: Partial<Record<HookKind, string>> } | { error: string } | undefined {
  const raw = (info.thetis as Record<string, unknown>).sessions;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "sessions must be an object" };
  const out: Partial<Record<HookKind, string>> = {};
  for (const kind of ["archive", "forget"] as const) {
    const name = (raw as Record<string, unknown>)[kind];
    if (name === undefined) continue;
    if (typeof name !== "string" || !EXPORT.test(name)) return { error: `sessions ${kind} must name an export` };
    out[kind] = name;
  }
  return { sessions: out };
}

/** The packages that declare a hook of this kind, in install order. A bad declaration is logged by name and skipped. */
export function sessionHooks(packages: PackageInfo[], kind: HookKind, log: (line: string) => void): SessionHook[] {
  const out: SessionHook[] = [];
  for (const pkg of packages) {
    const checked = validateSessions(pkg);
    if (!checked) continue;
    if ("error" in checked) {
      log(`[gateway-web] ${pkg.name} is skipped for the ${kind} hook: ${checked.error}`);
      continue;
    }
    const name = checked.sessions[kind];
    if (name) out.push({ package: pkg.name, export: name });
  }
  return out;
}

/**
 * Calls one hook as the person and answers what it returned. Not imported here: the gateway's own env binds
 * `storage` to the gateway, so the call goes through `invokeTool`, which runs the export in the agent with
 * the env of the hook's own package. The name says which seam the call came from, for the agent's logs.
 */
async function callHook(ctx: CommandContext, who: Who, hook: SessionHook, session: string, arg: Record<string, unknown>, kind: string): Promise<unknown> {
  const config = await packageConfig(ctx, hook.package);
  const info: SessionInfo = { id: session, user: who.id };
  const name = `${hook.package}#sessions.${kind === "archive" ? "archive" : "forget"}`;
  return withTimeout(() => ctx.env.invokeTool({ package: hook.package, export: hook.export, name }, arg, { session: info, config }), ctx.timeoutMs ?? COMMAND_TIMEOUT_MS, `${hook.package} did not answer the ${kind} hook in time`);
}

/**
 * Tells every package that declares `archive` that a conversation was archived or restored. Called after
 * the mark is written and never awaited by the route: a hook writes a file and returns, and one that fails
 * or is slow is the package's problem, in the log, never the person's archive.
 */
export async function runArchiveHooks(ctx: CommandContext, who: Who, change: { session: string; archived: boolean; archivedAt: string | null }, log: (line: string) => void): Promise<void> {
  const hooks = sessionHooks(await ctx.kernel.packages.list(), "archive", log);
  await Promise.all(
    hooks.map((hook) =>
      callHook(ctx, who, hook, change.session, change, "archive").catch((err) => log(`[gateway-web] ${hook.package} archive hook failed for ${change.session}: ${message(err)}`)),
    ),
  );
}

/** What the forget needs from the gateway around it. `ctx` is absent when the gateway runs no package code (no fence env). */
export interface ForgetContext {
  kernel: KernelClient;
  store: GatewayStore;
  ctx?: CommandContext;
  who: Who;
  /** The title the page shows for a conversation: the person's name for it, or its first words. */
  title: (ref: SessionSummaryRef) => string;
  /** Whether the hub carries a turn of this session right now. */
  hubRunning: (id: string) => boolean;
  listChanged: () => void;
  log: (line: string) => void;
}

/** The conversation and everything under it: the root's summary and the subtree's ids, root first, each child after its parent. */
async function subtreeOf(fc: ForgetContext, id: string): Promise<{ root: SessionSummaryRef; refs: SessionSummaryRef[] }> {
  const all = await fc.kernel.sessions.list();
  const root = all.find((s) => s.id === id);
  if (!root) throw new HttpError(404, "unknown session");
  if (root.parent) throw new HttpError(409, "forget its parent conversation; a subagent goes with it");
  const under = new Set([id]);
  const refs = [root];
  for (const s of all) {
    if (!s.parent || !under.has(s.parent)) continue;
    under.add(s.id);
    refs.push(s);
  }
  return { root, refs };
}

const isRunning = (fc: ForgetContext, ref: SessionSummaryRef) => ref.running || fc.hubRunning(ref.id);

/** Every asset id a record refers to, wherever in it an asset part sits: a message's content, a tool result's, a turn's input. */
export function assetIdsOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) assetIdsOf(item, into);
  else if (value && typeof value === "object") {
    if (isAssetPart(value)) into.add(value.data.id);
    else for (const item of Object.values(value)) assetIdsOf(item, into);
  }
  return into;
}

async function attachmentsOf(fc: ForgetContext, ids: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const id of ids) {
    const rec = await fc.kernel.sessions.inspect(id).catch(() => undefined);
    if (rec) assetIdsOf(rec, found);
  }
  return [...found];
}

/** Every forget hook's preview. A hook that fails here adds a sentence to `kept` and is still called to forget. */
async function previews(fc: ForgetContext, id: string, sessions: string[]): Promise<{ hooks: (HookPreview & { export: string })[]; failed: string[] }> {
  if (!fc.ctx) return { hooks: [], failed: [] };
  const ctx = fc.ctx;
  const out: (HookPreview & { export: string })[] = [];
  const failed: string[] = [];
  for (const hook of sessionHooks(await fc.kernel.packages.list(), "forget", fc.log)) {
    try {
      const raw = await callHook(ctx, fc.who, hook, id, { phase: "preview", session: id, sessions, options: {} }, "forget preview");
      const parsed = PreviewAnswerSchema.safeParse(raw);
      if (!parsed.success) throw new Error("it answered the preview with something that is not { items?, block? }");
      const answer = parsed.data ?? {};
      out.push({ package: hook.package, export: hook.export, items: answer.items ?? [], ...(answer.block ? { block: answer.block } : {}) });
    } catch (err) {
      fc.log(`[gateway-web] ${hook.package} forget preview failed for ${id}: ${message(err)}`);
      failed.push(`${hook.package} could not say what it would remove: ${message(err)}`);
      out.push({ package: hook.package, export: hook.export, items: [] });
    }
  }
  return { hooks: out, failed };
}

/** The title as the page shows it, which is what a person types. An empty one shows as "New conversation". */
const shownTitle = (title: string) => title.trim() || "New conversation";

/** `POST /api/sessions/<id>/forget/preview`: everything the dialog shows, and nothing is changed. */
export async function forgetPreview(fc: ForgetContext, id: string): Promise<ForgetPreview> {
  const { root, refs } = await subtreeOf(fc, id);
  const subtree = refs.map((r) => r.id);
  const { hooks, failed } = await previews(fc, id, subtree);
  return {
    id,
    title: shownTitle(fc.title(root)),
    turns: root.turns,
    subtree,
    running: refs.some((r) => isRunning(fc, r)),
    attachments: (await attachmentsOf(fc, subtree)).length,
    hooks: hooks.filter((h) => h.items.length || h.block).map(({ package: name, items, block }) => ({ package: name, items, ...(block ? { block } : {}) })),
    kept: [...failed, ...ALWAYS_KEPT],
  };
}

/** Cancels every running turn in the subtree and waits until none runs, or refuses when it does not settle in time. */
async function stopAll(fc: ForgetContext, ids: string[]): Promise<void> {
  const wanted = new Set(ids);
  const running = async () => (await fc.kernel.sessions.list()).filter((s) => wanted.has(s.id) && isRunning(fc, s)).map((s) => s.id);
  for (const id of await running()) await fc.kernel.sessions.cancel(id).catch((err) => fc.log(`[gateway-web] stopping ${id} to forget it failed: ${message(err)}`));
  const deadline = Date.now() + STOP_WAIT_MS;
  while ((await running()).length) {
    if (Date.now() > deadline) throw new HttpError(409, "a turn in this conversation did not stop in time; try again");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Whether a kernel call failed because the kernel does not know the method: a server not restarted since it gained it. */
const unknownMethod = (err: unknown) => /unknown (kernel )?method/i.test(message(err));

/**
 * Removes the attachments, one at a time. A kernel without `assets.remove` (the method is new, and the
 * server answers it only after a restart) stops the loop at the first try and says how many stay; any other
 * refusal is counted and said once. Neither fails the forget: the words are already gone by then.
 */
async function removeAssets(fc: ForgetContext, ids: string[]): Promise<{ removed: number; kept: string[] }> {
  const remove = (fc.kernel.assets as { remove?: (id: string) => Promise<{ id: string; removed: boolean }> }).remove;
  let removed = 0;
  let failed = 0;
  let firstError = "";
  for (const [i, id] of ids.entries()) {
    try {
      if (typeof remove !== "function") throw new Error("unknown kernel method: assets.remove");
      if ((await remove.call(fc.kernel.assets, id)).removed) removed += 1;
    } catch (err) {
      if (unknownMethod(err)) {
        const left = ids.length - i;
        return { removed, kept: [`${plural(left, "attachment")} ${left === 1 ? "stays" : "stay"} until the server restarts with attachment removal.`] };
      }
      failed += 1;
      firstError ||= message(err);
      fc.log(`[gateway-web] attachment ${id} was not removed: ${message(err)}`);
    }
  }
  return { removed, kept: failed ? [`${plural(failed, "attachment")} could not be removed: ${firstError}`] : [] };
}

/** The subtree's ids, deepest first: a child is always deleted before its parent, so no record is ever left without one. */
export function deepestFirst(refs: { id: string; parent?: string }[]): string[] {
  const depth = new Map<string, number>();
  for (const r of refs) depth.set(r.id, r.parent && depth.has(r.parent) ? depth.get(r.parent)! + 1 : 0);
  return refs.map((r, i) => ({ id: r.id, d: depth.get(r.id)!, i })).sort((a, b) => b.d - a.d || b.i - a.i).map((r) => r.id);
}

/**
 * `POST /api/sessions/<id>/forget`, in the order the contract fixes: refuse a subagent; refuse a title that
 * does not match (an empty one is enough under three turns); refuse while a hook blocks; stop running turns
 * when asked, refuse otherwise; let every hook remove its part; remove the attachments; delete the records
 * deepest first; drop this gateway's marks. Everything from the hooks on only ever adds to `kept` when it
 * fails: the person asked for the words to go, and a part that could not follow is said, not hidden.
 */
export async function forgetSession(fc: ForgetContext, id: string, body: ForgetRequest): Promise<ForgetReceipt> {
  const { root, refs } = await subtreeOf(fc, id);
  const subtree = refs.map((r) => r.id);
  const typed = body.confirm.trim();
  if (!(root.turns < TITLE_FREE_TURNS && !typed) && typed !== shownTitle(fc.title(root))) throw new HttpError(400, "type the conversation's title exactly as it is shown to forget it");

  const { hooks } = await previews(fc, id, subtree);
  const blocked = hooks.find((h) => h.block);
  if (blocked) throw new HttpError(409, blocked.block!);

  if (refs.some((r) => isRunning(fc, r))) {
    if (!body.stop) throw new HttpError(409, "a turn is running in this conversation; stop it first, or forget with stop");
    await stopAll(fc, subtree);
  }

  const removed: string[] = [];
  const kept: string[] = [];
  for (const hook of hooks) {
    const options: Record<string, boolean> = {};
    for (const item of hook.items) if (item.optional) options[item.id] = item.default ?? false;
    Object.assign(options, body.options?.[hook.package] ?? {});
    try {
      const raw = await callHook(fc.ctx!, fc.who, hook, id, { phase: "forget", session: id, sessions: subtree, options }, "forget");
      const parsed = ForgetAnswerSchema.safeParse(raw);
      if (!parsed.success) throw new Error("it answered with something that is not { removed?, kept? }");
      removed.push(...(parsed.data?.removed ?? []));
      kept.push(...(parsed.data?.kept ?? []));
    } catch (err) {
      fc.log(`[gateway-web] ${hook.package} forget hook failed for ${id}: ${message(err)}`);
      kept.push(`${hook.package} could not remove its part: ${message(err)}`);
    }
  }

  const assets = await removeAssets(fc, await attachmentsOf(fc, subtree));
  kept.push(...assets.kept);

  const gone: string[] = [];
  for (const sid of deepestFirst(refs)) {
    try {
      await fc.kernel.sessions.delete(sid);
      gone.push(sid);
    } catch (err) {
      if ((err as { code?: string }).code === "not-found") gone.push(sid);
      else kept.push(`${sid === id ? "The conversation" : `The subagent conversation ${sid}`} could not be removed: ${message(err)}`);
    }
  }
  for (const sid of gone) fc.store.forget(fc.who.id, sid);
  fc.listChanged();

  const children = gone.filter((sid) => sid !== id).length;
  const own: string[] = [];
  if (gone.includes(id)) own.push(children ? `the conversation and ${plural(children, "subagent conversation")}` : "the conversation");
  if (assets.removed) own.push(plural(assets.removed, "attachment"));
  if (gone.length) own.push("titles, model choice and usage the page kept");
  return { id, removed: [...own, ...removed], kept: [...kept, ...ALWAYS_KEPT] };
}

// What a package contributes to the page, read from `thetis.ui` in its manifest. The kernel never reads
// the field; it reaches here through `PackageInfo.thetis` untouched, so every value is checked before it
// crosses to the browser or names a file. A bad declaration refuses that package by name and the rest
// still composes. A package's browser files are served only from under its own declared directory. A
// declared command runs an export of the package's `main` as the person, with the fence environment the
// gateway already holds and that package's effective configuration, fetched from the kernel on every call
// so a change is live at once; nothing more: no other package's authority.
import { existsSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { KernelClient, PackageInfo, StepEnv, UiCommandDecl, UiCommandEnv, UiCommandResult, UiEntryDecl, UiStream, UserRole } from "@thetis/contracts";
import { HttpError } from "./http.js";
import { serveFile, within } from "./static.js";

export const SLOTS = ["dock", "panel", "places", "sidebar", "chips", "composer", "shelf", "statusbar"] as const;
export type Slot = (typeof SLOTS)[number];
/** Slots where one id belongs to one package. Panel ids are namespaced by package in the browser, so both may stay. */
const SHARED: Slot[] = ["dock", "places", "sidebar", "chips", "composer", "shelf", "statusbar"];
const ID = /^[a-z][a-z0-9_-]{0,31}$/;
const EXPORT = /^[A-Za-z_$][\w$]*$/;
const PACKAGE_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/;
const SESSION_ID = /^s_[a-f0-9]+$/;
const RANK: Record<UserRole, number> = { user: 0, admin: 1, system: 2 };
const RESULT_LIMIT = 262_144;
/** A subscription carries its arguments in the URL, so they are bounded by what a URL may hold. */
const ARGS_LIMIT = 4096;
export const COMMAND_TIMEOUT_MS = 30_000;

/** A validated declaration: every field checked, defaults filled, nothing the manifest did not say. */
export interface UiSpec {
  dir: string;
  entry?: string;
  style?: string;
  slots: Record<Slot, UiEntryDecl[]>;
  commands: UiCommandDecl[];
}

/** One extension as the browser sees it. Command exports and roles stay here; the page gets verbs. */
export interface UiExtension extends Record<Slot, UiEntryDecl[]> {
  package: string;
  version: string;
  base: string;
  entry?: string;
  style?: string;
  commands: string[];
  /** The verbs declared with `stream: true`. The page subscribes to these; they are not in `commands`. */
  streams: string[];
  /** Entries above the person's role, as `<slot>:<id>`, so the page can tell "hidden" from "never declared". */
  hidden: string[];
}

export interface UiRefusal {
  package: string;
  message: string;
}

export interface CommandContext {
  kernel: KernelClient;
  env: StepEnv;
  store: string;
  timeoutMs?: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function clears(have: UserRole, need: UserRole | undefined): boolean {
  return RANK[have] >= RANK[need ?? "user"];
}

function packageDir(store: string, name: string): string {
  return resolve(store, "node_modules", name);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function text(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v || v.length > max) fail(`${what} must be a string of at most ${max} characters`);
  return v;
}

function role(v: unknown, what: string): UserRole | undefined {
  if (v === undefined) return undefined;
  if (v !== "user" && v !== "admin" && v !== "system") fail(`${what} role must be user, admin or system`);
  return v;
}

/** A file named relative to `dir`: it must stay inside, exist, and carry the extension the page will load it as. */
function file(v: unknown, what: string, dir: string, dirAbs: string, ext: string): string | undefined {
  if (v === undefined) return undefined;
  const rel = text(v, what, 200)!;
  const abs = resolve(dirAbs, rel);
  if (!rel.endsWith(ext)) fail(`${what} "${rel}" is not a ${ext} file`);
  if (!within(dirAbs, abs) || !existsSync(abs) || !statSync(abs).isFile()) fail(`${what} "${rel}" is not a file inside "${dir}"`);
  return rel;
}

function entry(raw: unknown, slot: Slot): UiEntryDecl {
  if (!isObject(raw) || typeof raw.id !== "string" || !ID.test(raw.id)) fail(`a ${slot} entry has no valid id`);
  const what = `${slot} entry "${raw.id}"`;
  const order = raw.order === undefined ? 100 : raw.order;
  if (typeof order !== "number" || !Number.isFinite(order)) fail(`${what} order must be a number`);
  if (raw.wide !== undefined && typeof raw.wide !== "boolean") fail(`${what} wide must be true or false`);
  const out: UiEntryDecl = { id: raw.id, order };
  const label = text(raw.label, `${what} label`, 80);
  const icon = text(raw.icon, `${what} icon`, 4096);
  const hint = text(raw.hint, `${what} hint`, 200);
  const note = text(raw.note, `${what} note`, 200);
  const need = role(raw.role, what);
  if (label !== undefined) out.label = label;
  if (icon !== undefined) out.icon = icon;
  if (hint !== undefined) out.hint = hint;
  if (note !== undefined) out.note = note;
  if (raw.wide !== undefined) out.wide = raw.wide;
  if (need !== undefined) out.role = need;
  return out;
}

function command(raw: unknown): UiCommandDecl {
  if (!isObject(raw) || typeof raw.verb !== "string" || !ID.test(raw.verb)) fail("a command has no valid verb");
  const what = `command "${raw.verb}"`;
  if (typeof raw.export !== "string" || !EXPORT.test(raw.export)) fail(`${what} needs an export name`);
  if (raw.stream !== undefined && typeof raw.stream !== "boolean") fail(`${what} stream must be true or false`);
  const out: UiCommandDecl = { verb: raw.verb, export: raw.export };
  const label = text(raw.label, `${what} label`, 80);
  const need = role(raw.role, what);
  if (label !== undefined) out.label = label;
  if (need !== undefined) out.role = need;
  if (raw.stream !== undefined) out.stream = raw.stream;
  return out;
}

function list<T extends { id: string } | { verb: string }>(raw: unknown, what: string, parse: (v: unknown) => T): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`${what} must be an array`);
  const out = raw.map(parse);
  const seen = new Set<string>();
  for (const item of out) {
    const key = "verb" in item ? item.verb : item.id;
    if (seen.has(key)) fail(`${what} "${key}" is declared twice`);
    seen.add(key);
  }
  return out;
}

/** Checks `thetis.ui` of one installed package against its files in the store. */
export function validateUi(info: PackageInfo, store: string): { ui: UiSpec } | { error: string } {
  try {
    const raw = info.thetis.ui;
    if (!isObject(raw)) fail("ui must be an object");
    const root = packageDir(store, info.name);
    const dir = text(raw.dir, "dir", 200) ?? "ui";
    const dirAbs = resolve(root, dir);
    if (dirAbs !== root && !within(root, dirAbs)) fail(`dir "${dir}" leaves the package`);
    const spec: UiSpec = { dir, slots: {} as Record<Slot, UiEntryDecl[]>, commands: list(raw.commands, "commands", command) };
    const entryFile = file(raw.entry, "entry", dir, dirAbs, ".js");
    const styleFile = file(raw.style, "style", dir, dirAbs, ".css");
    if (entryFile !== undefined) spec.entry = entryFile;
    if (styleFile !== undefined) spec.style = styleFile;
    for (const slot of SLOTS) spec.slots[slot] = list(raw[slot], slot, (v) => entry(v, slot));
    return { ui: spec };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Everything the page may draw, in install order. A shared slot id belongs to the first package that
 * declared it; a later claimant is refused by name. Entries and commands above the person's role are
 * left out, as the panel's sections are today. A streaming verb is listed in `streams` and not in
 * `commands`, because the two are different routes and the page must know which one it may use.
 */
export function composeUi(packages: PackageInfo[], role: UserRole, store: string): { extensions: UiExtension[]; refused: UiRefusal[] } {
  const extensions: UiExtension[] = [];
  const refused: UiRefusal[] = [];
  const claimed = new Map<string, string>();
  for (const pkg of packages) {
    if (pkg.thetis.ui === undefined) continue;
    const checked = validateUi(pkg, store);
    if ("error" in checked) {
      refused.push({ package: pkg.name, message: checked.error });
      continue;
    }
    const { ui } = checked;
    const taken = SHARED.flatMap((slot) => ui.slots[slot].map((e) => ({ slot, id: e.id, by: claimed.get(`${slot}:${e.id}`) }))).find((c) => c.by);
    if (taken) {
      refused.push({ package: pkg.name, message: `${taken.slot} entry "${taken.id}" is already claimed by ${taken.by}` });
      continue;
    }
    for (const slot of SHARED) for (const e of ui.slots[slot]) claimed.set(`${slot}:${e.id}`, pkg.name);
    const mine = ui.commands.filter((c) => clears(role, c.role));
    const ext = { package: pkg.name, version: pkg.version, base: `ext/${pkg.name}/`, commands: mine.filter((c) => !c.stream).map((c) => c.verb), streams: mine.filter((c) => c.stream).map((c) => c.verb) } as UiExtension;
    if (ui.entry !== undefined) ext.entry = ui.entry;
    if (ui.style !== undefined) ext.style = ui.style;
    for (const slot of SLOTS) ext[slot] = ui.slots[slot].filter((e) => clears(role, e.role));
    ext.hidden = SLOTS.flatMap((slot) => ui.slots[slot].filter((e) => !clears(role, e.role)).map((e) => `${slot}:${e.id}`));
    extensions.push(ext);
  }
  return { extensions, refused };
}

/** The installed package `<scope>/<name>` when it declares a usable `ui`; a 404 otherwise. */
function extensionOf(packages: PackageInfo[], store: string, scope: string, name: string): { pkg: PackageInfo; ui: UiSpec } {
  let full: string;
  try {
    full = `${decodeURIComponent(scope)}/${decodeURIComponent(name)}`;
  } catch {
    throw new HttpError(404, "no such extension");
  }
  const pkg = PACKAGE_NAME.test(full) ? packages.find((p) => p.name === full && p.thetis.ui !== undefined) : undefined;
  const checked = pkg ? validateUi(pkg, store) : undefined;
  if (!pkg || !checked || "error" in checked) throw new HttpError(404, "no such extension");
  return { pkg, ui: checked.ui };
}

/** `GET ext/<scope>/<name>/<path…>`: one browser file of the package, from under its declared directory. */
export function serveExt(res: ServerResponse, store: string, packages: PackageInfo[], scope: string, name: string, path: string[]): void {
  const { pkg, ui } = extensionOf(packages, store, scope, name);
  let rel: string;
  try {
    rel = path.map((s) => decodeURIComponent(s)).join("/");
  } catch {
    throw new HttpError(404, "not found");
  }
  serveFile(res, resolve(packageDir(store, pkg.name), ui.dir), rel);
}

/** Imports the package's `main` from the store the way the userspace agent does: a changed file is a new module. */
async function loadExport(store: string, pkg: string, name: string): Promise<(...a: unknown[]) => unknown> {
  const dir = packageDir(store, pkg);
  let fn: unknown;
  try {
    const manifest = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8")) as { main?: string };
    const main = resolve(dir, typeof manifest.main === "string" ? manifest.main : "index.js");
    const { mtimeMs } = await stat(main);
    fn = ((await import(`${pathToFileURL(main).href}?v=${mtimeMs}`)) as Record<string, unknown>)[name];
  } catch (err) {
    throw new HttpError(500, `${pkg} could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof fn !== "function") throw new HttpError(500, `${pkg} does not export a function named "${name}"`);
  return fn as (...a: unknown[]) => unknown;
}

function withTimeout<T>(run: () => Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, message)), ms);
  });
  return Promise.race([Promise.resolve().then(run), clock]).finally(() => clearTimeout(timer));
}

/**
 * The checks both command routes run, in order: the package is installed here with a valid `ui` that
 * declares this verb for this seam, the person's role clears it, a named session is one of their own,
 * and `args` is an object. One copy, so a subscription can never skip a check a command makes.
 */
async function resolveCommand(ctx: CommandContext, who: { id: string; role: UserRole }, scope: string, name: string, verb: string, seam: "command" | "stream", session: unknown, args: unknown): Promise<{ pkg: PackageInfo; cmd: UiCommandDecl; args: Record<string, unknown>; env: UiCommandEnv }> {
  const { pkg, ui } = extensionOf(await ctx.kernel.packages.list(), ctx.store, scope, name);
  const cmd = ID.test(verb) ? ui.commands.find((c) => c.verb === verb) : undefined;
  if (!cmd) throw new HttpError(404, `${pkg.name} does not declare the command "${verb}"`);
  if ((cmd.stream ? "stream" : "command") !== seam) throw new HttpError(400, cmd.stream ? `"${verb}" streams; subscribe to it` : `"${verb}" does not stream`);
  if (!clears(who.role, cmd.role)) throw new HttpError(403, `only an ${cmd.role} can send "${verb}"`);
  if (session !== undefined) {
    if (typeof session !== "string" || !SESSION_ID.test(session)) throw new HttpError(404, "unknown session");
    await ctx.kernel.sessions.inspect(session).catch(() => {
      throw new HttpError(404, "unknown session");
    });
  }
  if (args !== undefined && !isObject(args)) throw new HttpError(400, "args must be an object");
  // The package's configuration as its own steps and tools receive it. Once per request, never cached:
  // a key set in the panel must reach the next command.
  let config: Record<string, unknown>;
  try {
    config = await ctx.kernel.config.effective(pkg.name);
  } catch (err) {
    throw new HttpError(500, `${pkg.name} configuration could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const env: UiCommandEnv = { ...ctx.env, user: who.id, role: who.role, config, ...(typeof session === "string" ? { session } : {}) };
  return { pkg, cmd, args: (args as Record<string, unknown> | undefined) ?? {}, env };
}

/** `POST api/ext/<scope>/<name>/<verb>`: the shared checks, then the export, then a bounded answer. */
export async function runCommand(ctx: CommandContext, who: { id: string; role: UserRole }, scope: string, name: string, verb: string, body: Record<string, unknown>): Promise<{ text?: string; data?: unknown }> {
  const { pkg, cmd, args, env } = await resolveCommand(ctx, who, scope, name, verb, "command", body.session, body.args);
  const fn = await loadExport(ctx.store, pkg.name, cmd.export);
  let result: UiCommandResult;
  try {
    result = (await withTimeout(() => fn(args, env) as Promise<UiCommandResult>, ctx.timeoutMs ?? COMMAND_TIMEOUT_MS, `${pkg.name} did not answer "${verb}" in time`)) as UiCommandResult;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  const reply: { text?: string; data?: unknown } = {};
  if (typeof result === "string") reply.text = result;
  else if (isObject(result)) {
    if (typeof result.text === "string") reply.text = result.text;
    if (result.data !== undefined) reply.data = result.data;
  }
  if (Buffer.byteLength(JSON.stringify(reply)) > RESULT_LIMIT) throw new HttpError(502, `${pkg.name} answered "${verb}" with more than 256 KiB`);
  return reply;
}

/**
 * `GET api/ext/<scope>/<name>/<verb>/stream`: the same checks, with the arguments and the session in the
 * query because an `EventSource` sends no body, then the iterable the export answers with. It is handed
 * back unconsumed: neither the command timeout nor the answer cap applies, so what the subscription costs
 * is the package's own business for as long as the browser holds it open.
 */
export async function openStream(ctx: CommandContext, who: { id: string; role: UserRole }, scope: string, name: string, verb: string, query: URLSearchParams, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
  const raw = query.get("args") ?? undefined;
  if (raw !== undefined && raw.length > ARGS_LIMIT) throw new HttpError(400, `args must be at most ${ARGS_LIMIT} characters`);
  let parsed: unknown;
  try {
    parsed = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    throw new HttpError(400, "args must be an object");
  }
  const { pkg, cmd, args, env } = await resolveCommand(ctx, who, scope, name, verb, "stream", query.get("session") ?? undefined, parsed);
  const fn = (await loadExport(ctx.store, pkg.name, cmd.export)) as UiStream;
  let items: AsyncIterable<unknown>;
  try {
    items = fn(args, { ...env, signal });
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  if (!items || typeof (items as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") throw new HttpError(500, `${pkg.name} does not stream from "${verb}"`);
  return items;
}

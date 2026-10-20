// What each turn ran with. `callModel` stamps every turn once, after every call-phase step has shaped the
// request and before the first provider request: the model, the installed package versions, a hash of the
// system text and of the tool set, the skills the loader pinned, the active tool groups and the project. The
// system text and the tool set themselves are kept once per conversation, under their hash, so a stamp is
// one short line and forty turns of the same prompt are one file. Reflections and trials read these to say
// which harness a conversation actually ran with; this package reads none of them back.
//
// Nothing here may fail or delay a turn. The write is fired and not awaited, a failure is logged once, and
// the state of other packages is read by key, defensively, never imported.
import { createHash, randomBytes } from "node:crypto";
import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HarnessState, Message, PackageStepContext, ProviderCall } from "@thetis/runtime/contracts";

/** One line of `harness-core/turns/<s>.jsonl`. */
export interface HarnessStamp {
  /** Which message from the person this turn answers: the count of user messages so far. A resume repeats its turn's number. */
  turn: number;
  /** The kernel's id of the turn, which tells a resume from the turn it continued. */
  turnId: string;
  at: string;
  model: string;
  /** Every installed package, name to on-disk version. Not the version loaded in a running fence: steps never see that. */
  versions: Record<string, string>;
  /** The first 16 hex of the sha256 of `call.system`; `snapshots/<s>/<system>.md` holds the text. */
  system: string;
  /** The first 16 hex of the sha256 of the tool set as `snapshots/<s>/<tools>.json` holds it. */
  tools: string;
  skills: { loader: string | null; pinned: { id: string; contentHash: string | null }[]; universal: string[] } | null;
  groups: string[] | null;
  project: string | null;
}

/** A tool as its snapshot keeps it. */
export interface StampedTool {
  name: string;
  package: string;
  description: string;
  parameters: unknown;
}

export const TURNS_DIR = "harness-core/turns";
export const SNAPSHOTS_DIR = "harness-core/snapshots";
/** Relative to the home. */
export const turnsPath = (session: string): string => `${TURNS_DIR}/${session}.jsonl`;
export const snapshotsPath = (session: string): string => `${SNAPSHOTS_DIR}/${session}`;

const SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const PROJECT_ID = /^p_[0-9a-f]{8}$/;
const SKILLS = "@thetis/skills";
const GROUPS = "@thetis/tool-groups";
const PROJECTS_FILE = "projects/sessions.json";

const logged = new Set<string>();
/** Logs a message the first time it is seen in this process, so a broken disk is one line and not one per turn. */
export function logOnce(message: string): void {
  if (logged.has(message)) return;
  logged.add(message);
  console.warn(message);
}

export const hash16 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The tool set as the snapshot keeps it, sorted by name; compact JSON, so the file's own hash is its name. */
export function toolsSnapshot(tools: ProviderCall["tools"]): string {
  const list: StampedTool[] = tools.map((t) => ({ name: t.name, package: t.package, description: t.description, parameters: t.parameters ?? null }));
  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify(list);
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The skills loader's state, only the fields a stamp keeps, or null when no loader left any. */
function skillsOf(harness: HarnessState): HarnessStamp["skills"] {
  const s = obj(harness?.[SKILLS]);
  if (!s) return null;
  const pinned = Array.isArray(s.pinned)
    ? s.pinned.flatMap((p) => {
        const o = obj(p);
        return o && typeof o.id === "string" ? [{ id: o.id, contentHash: typeof o.contentHash === "string" ? o.contentHash : null }] : [];
      })
    : [];
  return { loader: typeof s.loader === "string" ? s.loader : null, pinned, universal: strings(s.universal) };
}

function groupsOf(harness: HarnessState): string[] | null {
  const active = obj(harness?.[GROUPS])?.active;
  return Array.isArray(active) ? strings(active) : null;
}

/** The project the projects side file assigns this session to, or null. Read, never imported. */
async function projectOf(home: string, session: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(resolve(home, PROJECTS_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const id = obj(JSON.parse(text))?.[session];
    return typeof id === "string" && PROJECT_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

function versionsOf(ctx: PackageStepContext): Record<string, string> {
  const out: Record<string, string> = {};
  let list: readonly { name?: unknown; version?: unknown }[] = [];
  try {
    list = ctx.packages.list();
  } catch {
    return out;
  }
  for (const p of [...list].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    if (typeof p?.name === "string" && typeof p.version === "string") out[p.name] = p.version;
  }
  return out;
}

const turnNumber = (conversation: Message[]): number => Math.max(1, conversation.filter((m) => m.role === "user").length);

/** Writes `text` to `file` unless it is already there, through a temporary file renamed into place. */
async function writeOnce(file: string, text: string): Promise<void> {
  try {
    await access(file);
    return;
  } catch {
    // Missing: written below.
  }
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Stamps one turn: the snapshots first, so a line never names a file that is not there, then the line. The
 * caller fires this and does not wait; `call` is the request as the first round sends it.
 */
export async function stampTurn(ctx: PackageStepContext, call: ProviderCall): Promise<HarnessStamp | undefined> {
  const session = ctx.session.id;
  if (!SESSION_ID.test(session)) throw new Error(`a session id that cannot be a file name: ${JSON.stringify(session)}`);
  const home = ctx.env.cwd;
  const at = new Date().toISOString();
  const system = call.system ?? "";
  const tools = toolsSnapshot(call.tools);
  const stamp: HarnessStamp = {
    turn: turnNumber(ctx.conversation),
    turnId: ctx.turn.id,
    at,
    model: call.model,
    versions: versionsOf(ctx),
    system: hash16(system),
    tools: hash16(tools),
    skills: skillsOf(ctx.harness),
    groups: groupsOf(ctx.harness),
    project: await projectOf(home, session),
  };
  const dir = resolve(home, snapshotsPath(session));
  await mkdir(dir, { recursive: true });
  await writeOnce(resolve(dir, `${stamp.system}.md`), system);
  await writeOnce(resolve(dir, `${stamp.tools}.json`), tools);
  await mkdir(resolve(home, TURNS_DIR), { recursive: true });
  await appendFile(resolve(home, turnsPath(session)), JSON.stringify(stamp) + "\n");
  return stamp;
}

/** Fires the stamp and forgets it: whatever goes wrong is one line in the log, and the turn goes on. */
export function fireStamp(ctx: PackageStepContext, call: ProviderCall): Promise<void> {
  let started: Promise<unknown>;
  try {
    started = stampTurn(ctx, call);
  } catch (err) {
    started = Promise.reject(err);
  }
  return started.then(
    () => {},
    (err) => logOnce(`@thetis/harness-core could not record what a turn ran with: ${err instanceof Error ? err.message : String(err)}`),
  );
}

/** The stamps of one conversation, oldest first; an unreadable line is skipped and a missing file is none. */
export async function harnessStamps(home: string, session: string): Promise<HarnessStamp[]> {
  if (!SESSION_ID.test(session)) return [];
  let text: string;
  try {
    text = await readFile(resolve(home, turnsPath(session)), "utf8");
  } catch {
    return [];
  }
  const out: HarnessStamp[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (obj(parsed)) out.push(parsed as HarnessStamp);
    } catch {
      // A torn last line from a crash mid-append: the rest still reads.
    }
  }
  return out;
}

// ---- guideNotes ----

export const GUIDE_NOTE_MAX = 300;
export const GUIDE_NOTES_MAX = 20;

/** The configured notes that fit: strings, whitespace collapsed, each within 300 characters, the first 20. The rest is logged once. */
export function guideNotesOf(config: Record<string, unknown>): string[] {
  const raw = config.guideNotes;
  if (!Array.isArray(raw) || !raw.length) return [];
  const kept: string[] = [];
  let dropped = 0;
  for (const n of raw) {
    const note = typeof n === "string" ? n.replace(/\s+/g, " ").trim() : "";
    if (!note) {
      if (typeof n !== "string") dropped++;
      continue;
    }
    if ([...note].length > GUIDE_NOTE_MAX || kept.length >= GUIDE_NOTES_MAX) dropped++;
    else kept.push(note);
  }
  if (dropped) logOnce(`@thetis/harness-core guideNotes: ${dropped} ${dropped === 1 ? "note was" : "notes were"} left out of the guide (each at most ${GUIDE_NOTE_MAX} characters, at most ${GUIDE_NOTES_MAX} notes)`);
  return kept;
}

/** The text appended after the guide: nothing at all when there are no notes, so the prompt stays byte-identical. */
export function guideNotesText(config: Record<string, unknown>): string {
  const notes = guideNotesOf(config);
  return notes.length ? `\n\nWorking notes:\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
}

// What a trial is asked to do, checked before anything is written: the request, the two arms and the one
// change, the runs, and the limits. Pure, so every refusal can be tested on its own. A refusal is a
// sentence with code `invalid`.
import { posix } from "node:path";
import { randomBytes } from "node:crypto";
import { assert } from "./error.js";

export const TRIAL_ID = /^t_[0-9a-f]{8}$/;
export const SESSION_ID = /^s_[a-f0-9]+$/;
export const PROJECT_ID = /^p_[0-9a-f]{8}$/;
/** A skill id as `@thetis/skills` defines it: up to three lowercase segments joined by `/`. */
export const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63}){0,2}$/;
const PACKAGE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const CONFIG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export const LIMITS = Object.freeze({
  runs: 5,
  requestChars: 100_000,
  skillChars: 256 * 1024,
  instructionsChars: 32 * 1024,
  noteChars: 300,
  configJson: 64 * 1024,
  modelChars: 200,
  costUsd: 100,
  minutes: 120,
  scratchMbMin: 64,
  scratchMbMax: 64 * 1024,
});

export const newTrialId = () => `t_${randomBytes(4).toString("hex")}`;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * One Change, as it arrives. Answers a clean copy holding only the fields of its kind.
 * - `{kind: "skill", id, path, content}`: `path` relative to the home, under `skills/`.
 * - `{kind: "project-instructions", project, content}`: replaces `projects/<project>.md`.
 * - `{kind: "guide-note", note}`: one line of at most 300 characters.
 * - `{kind: "config", package, key, value}`: set at the person's layer; the trial kernel checks the key.
 * A removal, so that the base arm of a re-trial can undo a change the real home already has: a skill or
 * project-instructions change with `content: null` deletes the file, a config change with `value: null`
 * unsets the key. A guide note is only ever appended; a revert of the notes is a config change of
 * `@thetis/harness-core` `guideNotes`.
 */
export function parseChange(raw) {
  assert(isObject(raw), "a change must be an object with a kind");
  switch (raw.kind) {
    case "skill": {
      const path = skillPath(raw.path);
      if (raw.content === null) {
        assert(raw.id === undefined || raw.id === null || (typeof raw.id === "string" && SKILL_ID.test(raw.id)), `a skill change names a skill id (lowercase, up to three segments): ${String(raw.id)}`);
        return { kind: "skill", ...(typeof raw.id === "string" ? { id: raw.id } : {}), path, content: null };
      }
      assert(typeof raw.id === "string" && SKILL_ID.test(raw.id), `a skill change names a skill id (lowercase, up to three segments): ${String(raw.id)}`);
      assert(typeof raw.content === "string" && raw.content.trim().length > 0, "a skill change carries the skill's content, or null to remove the file");
      assert(raw.content.length <= LIMITS.skillChars, `a skill is at most ${LIMITS.skillChars} characters`);
      return { kind: "skill", id: raw.id, path, content: raw.content };
    }
    case "project-instructions": {
      assert(typeof raw.project === "string" && PROJECT_ID.test(raw.project), `a project-instructions change names a project id (p_ and 8 hex digits): ${String(raw.project)}`);
      if (raw.content === null) return { kind: "project-instructions", project: raw.project, content: null };
      assert(typeof raw.content === "string", "a project-instructions change carries the instructions as text, or null to remove them");
      assert(raw.content.length <= LIMITS.instructionsChars, `project instructions are at most ${LIMITS.instructionsChars} characters`);
      return { kind: "project-instructions", project: raw.project, content: raw.content };
    }
    case "guide-note": {
      assert(typeof raw.note === "string" && raw.note.trim().length > 0, "a guide-note change carries the note");
      assert(raw.note.length <= LIMITS.noteChars, `a guide note is at most ${LIMITS.noteChars} characters`);
      assert(!/[\r\n]/.test(raw.note), "a guide note is one line");
      return { kind: "guide-note", note: raw.note };
    }
    case "config": {
      assert(typeof raw.package === "string" && PACKAGE.test(raw.package), `a config change names a package (@scope/name): ${String(raw.package)}`);
      assert(typeof raw.key === "string" && CONFIG_KEY.test(raw.key), `a config change names a key (a bare identifier): ${String(raw.key)}`);
      assert(raw.value !== undefined, "a config change carries a value, or null to unset the key");
      if (raw.value === null) return { kind: "config", package: raw.package, key: raw.key, value: null };
      const json = JSON.stringify(raw.value);
      assert(typeof json === "string" && json.length <= LIMITS.configJson, `a config value is JSON of at most ${LIMITS.configJson} characters`);
      return { kind: "config", package: raw.package, key: raw.key, value: JSON.parse(json) };
    }
    default:
      throw Object.assign(new Error(`unknown change kind: ${String(raw.kind)} (skill, project-instructions, guide-note or config)`), { code: "invalid" });
  }
}

/** A skill's path: relative to the home, normalized, under `skills/`, plain segments only. */
export function skillPath(raw) {
  assert(typeof raw === "string" && raw.length <= 512, "a skill change names the path of its file");
  assert(!raw.startsWith("/") && !raw.includes("\\") && posix.normalize(raw) === raw, `a skill path is relative and normalized, with no ..: ${raw}`);
  const segments = raw.split("/");
  assert(segments[0] === "skills" && segments.length >= 2 && segments.length <= 8, `a skill path starts with skills/: ${raw}`);
  for (const s of segments) assert(PATH_SEGMENT.test(s), `a skill path holds plain names only (letters, digits, ., _ and -; no .. and no leading dot): ${raw}`);
  return raw;
}

/**
 * The arms: exactly two, `base` then `change`, each with a Change or null, and at least one of them a
 * Change. Usually the base arm has none; a re-trial of an adopted change gives the base arm the removal.
 */
export function parseArms(raw) {
  const shape = 'arms must be exactly [{id: "base", change: <Change>|null}, {id: "change", change: <Change>|null}]';
  assert(Array.isArray(raw) && raw.length === 2, shape);
  const [base, change] = raw;
  assert(isObject(base) && base.id === "base", `${shape}: the first arm is base`);
  assert(isObject(change) && change.id === "change", `${shape}: the second arm is change`);
  const arms = [base, change].map((a) => ({ id: a.id, change: a.change === null || a.change === undefined ? null : parseChange(a.change) }));
  assert(arms.some((a) => a.change), `${shape}, and at least one arm carries a change`);
  return arms;
}

const number = (v, what, { min, max, int = false }) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  assert(typeof n === "number" && Number.isFinite(n), `${what} must be a number`);
  assert(!int || Number.isInteger(n), `${what} must be a whole number`);
  assert(n >= min && n <= max, `${what} must be from ${min} to ${max}`);
  return n;
};

/**
 * The arguments of `start`, without `user` (the caller pins it). Answers the trial's own fields:
 * `{session, request: {text}, project, model, arms, runs, costUsd, minutes, scratchMb}`.
 */
export function parseStart(args) {
  assert(isObject(args), "start takes an object");
  assert(typeof args.session === "string" && SESSION_ID.test(args.session), `session must be the original conversation's id (s_...): ${String(args.session)}`);
  const request = args.request;
  assert(isObject(request), "request must be {text}");
  assert(request.attachments === undefined || (Array.isArray(request.attachments) && !request.attachments.length), "a trial cannot carry attachments; send the request as text");
  assert(typeof request.text === "string" && request.text.trim().length > 0, "request.text must be the request to run");
  assert(request.text.length <= LIMITS.requestChars, `request.text is at most ${LIMITS.requestChars} characters`);
  const project = args.project ?? null;
  assert(project === null || (typeof project === "string" && PROJECT_ID.test(project)), `project must be a project id (p_ and 8 hex digits) or absent: ${String(project)}`);
  assert(typeof args.model === "string" && args.model.trim().length > 0 && args.model.length <= LIMITS.modelChars && !/[\s\u0000-\u001f]/.test(args.model), "model must name one model, with no spaces");
  const arms = parseArms(args.arms);
  return {
    session: args.session,
    request: { text: request.text },
    project,
    model: args.model,
    arms,
    runs: number(args.runs, "runs", { min: 1, max: LIMITS.runs, int: true }),
    costUsd: number(args.costUsd, "costUsd", { min: 0.01, max: LIMITS.costUsd }),
    minutes: number(args.minutes, "minutes", { min: 1, max: LIMITS.minutes }),
    scratchMb: number(args.scratchMb, "scratchMb", { min: LIMITS.scratchMbMin, max: LIMITS.scratchMbMax, int: true }),
  };
}

/** The runs in the order they run: base-1, change-1, base-2, change-2, ... */
export function interleave(arms, runs) {
  const out = [];
  for (let n = 1; n <= runs; n++) for (const arm of arms) out.push({ arm: arm.id, n });
  return out;
}

/** The trial record as it starts: every run queued. */
export function newTrial({ id, user, spec, now = new Date().toISOString() }) {
  return {
    id,
    user,
    session: spec.session,
    state: "queued",
    model: spec.model,
    project: spec.project,
    request: spec.request,
    arms: spec.arms,
    runs: interleave(spec.arms, spec.runs).map(({ arm, n }) => ({ arm, n, state: "queued", session: null, costUsd: 0, tokens: 0, startedAt: null, finishedAt: null })),
    costUsd: 0,
    capUsd: spec.costUsd,
    minutes: spec.minutes,
    createdAt: now,
  };
}

export const TERMINAL = new Set(["done", "failed", "cancelled"]);
export const RUN_TERMINAL = new Set(["done", "failed", "cancelled", "budget", "timeout"]);

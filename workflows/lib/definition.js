// Definitions: the ids, the shape a saved definition is brought to, and the versions on disk.
//
// `workflows/defs/<wf>/draft.json` is what the editor saves, and always exists once a workflow does.
// `workflows/defs/<wf>/v<N>.json` is published version N and is never written twice. The draft's
// `version` is the number it will publish as, so publishing is: write vN from the draft, then move the
// draft on to N + 1.
import { randomBytes } from "node:crypto";
import { DIR, list, modified, readJson, remove, writeJson } from "./files.js";

export const STEP_TYPES = Object.freeze(["prompt", "tool", "parse", "branch", "loop", "approval", "done", "needs"]);
export const LIMITS = Object.freeze({ name: 120, description: 2000, steps: 200 });

const WF = /^wf_[0-9a-f]{8}$/;
const RUN = /^r_[0-9a-f]{10}$/;
const STEP = /^[a-z][a-z0-9_]{0,31}$/;
const PROJECT = /^p_[0-9a-f]{8}$/;

export const isWorkflowId = (id) => typeof id === "string" && WF.test(id);
export const isRunId = (id) => typeof id === "string" && RUN.test(id);
export const isStepId = (id) => typeof id === "string" && STEP.test(id);
export const isProjectId = (id) => typeof id === "string" && PROJECT.test(id);
export const newWorkflowId = () => `wf_${randomBytes(4).toString("hex")}`;
export const newRunId = () => `r_${randomBytes(5).toString("hex")}`;

export const defsDir = () => `${DIR}/defs`;
export const draftPath = (id) => `${DIR}/defs/${id}/draft.json`;
export const versionPath = (id, n) => `${DIR}/defs/${id}/v${n}.json`;

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

/** A new, empty workflow: one `done` step, so it is valid from the moment it exists. */
export function blank(id, name) {
  return {
    id,
    name: text(name, LIMITS.name).trim() || "Untitled workflow",
    description: "",
    version: 1,
    input: { kind: "lines", label: "Input", placeholder: "One per line" },
    start: "done",
    steps: { done: { type: "done", summary: "Finished." } },
    layout: { done: { x: 0, y: 0 } },
  };
}

/**
 * Brings a definition to the shape the engine and the editor rely on: known top-level fields with the
 * right types, `steps` and `layout` objects. Steps are kept as they were given, bar non-objects, because
 * the validator is what tells a person what is wrong with one; silently dropping a field they typed would
 * hide it. `id` and `version` are the caller's, not the definition's.
 */
export function normalise(definition, { id, version } = {}) {
  const d = isObject(definition) ? definition : {};
  const out = {
    id: id ?? (typeof d.id === "string" ? d.id : ""),
    name: text(d.name, LIMITS.name).trim() || "Untitled workflow",
    description: text(d.description, LIMITS.description),
    version: Number.isInteger(version) ? version : Number.isInteger(d.version) && d.version > 0 ? d.version : 1,
  };
  if (typeof d.project === "string" && d.project) out.project = d.project;
  if (d.costCapUsd !== undefined && d.costCapUsd !== null && d.costCapUsd !== "") out.costCapUsd = Number(d.costCapUsd);
  const input = isObject(d.input) ? d.input : {};
  out.input = {
    kind: input.kind === "text" ? "text" : "lines",
    label: text(input.label, 200),
    placeholder: text(input.placeholder, 200),
  };
  out.start = typeof d.start === "string" ? d.start : "";
  out.steps = {};
  if (isObject(d.steps)) for (const [sid, step] of Object.entries(d.steps)) if (isObject(step)) out.steps[sid] = { ...step };
  out.layout = {};
  if (isObject(d.layout)) {
    for (const [sid, p] of Object.entries(d.layout)) {
      if (isObject(p) && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) out.layout[sid] = { x: Number(p.x), y: Number(p.y) };
    }
  }
  return out;
}

// ---- on disk ----

/** Every workflow id that has a directory. */
export async function listWorkflowIds(home) {
  return (await list(home, defsDir())).filter(isWorkflowId).sort();
}

export async function readDraft(home, id) {
  if (!isWorkflowId(id)) return null;
  const d = await readJson(home, draftPath(id), null);
  return d ? normalise(d, { id }) : null;
}

export async function writeDraft(home, draft) {
  await writeJson(home, draftPath(draft.id), draft);
}

export const draftModified = (home, id) => modified(home, draftPath(id));

/** The published version numbers, ascending. */
export async function listVersions(home, id) {
  if (!isWorkflowId(id)) return [];
  const names = await list(home, `${DIR}/defs/${id}`);
  return names
    .map((n) => /^v([1-9][0-9]*)\.json$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

export async function readVersion(home, id, n) {
  if (!isWorkflowId(id) || !Number.isInteger(n)) return null;
  const d = await readJson(home, versionPath(id, n), null);
  return d ? normalise(d, { id, version: n }) : null;
}

/** The latest published version, or null. */
export async function readPublished(home, id) {
  const versions = await listVersions(home, id);
  return versions.length ? readVersion(home, id, versions.at(-1)) : null;
}

/**
 * Writes the draft as the next version and moves the draft on. The number is the draft's own unless a
 * version at or past it already exists (a hand-edited draft), in which case it is one past the highest.
 */
export async function publishDraft(home, draft) {
  const versions = await listVersions(home, draft.id);
  const highest = versions.at(-1) ?? 0;
  const n = Math.max(draft.version, highest + 1);
  await writeJson(home, versionPath(draft.id, n), { ...draft, version: n });
  const next = { ...draft, version: n + 1 };
  await writeDraft(home, next);
  return { version: n, draft: next };
}

export async function removeWorkflow(home, id) {
  if (!isWorkflowId(id)) return;
  await remove(home, `${DIR}/defs/${id}`);
}

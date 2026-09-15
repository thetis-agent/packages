// Plan mutation logic: minting ids, enforcing the 64-item cap and the single-active rule,
// and rendering the plan back to the model in one consistent format.
const MAX_ITEMS = 64;
const MAX_TEXT_CHARS = 200;
const STAGE_MARK = { pending: "[ ]", active: "[>]", done: "[x]", dropped: "[-]" };
const VALID_STAGES = new Set(["pending", "active", "done", "dropped"]);

// Flatten a string or {text, stage, note} into a normalized item shape, cutting text to
// one line and 200 chars so a stray multi-paragraph note can't blow up the rendering.
function normalizeInput(entry) {
  const raw = typeof entry === "string" ? { text: entry } : (entry ?? {});
  const text = String(raw.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
  const stage = VALID_STAGES.has(raw.stage) ? raw.stage : "pending";
  const note = raw.note ? String(raw.note).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS) : undefined;
  return { text, stage, note };
}

// Mint fresh ids from plan.nextId, which only ever increases, so a finished id never
// reappears on a different line even after items are replaced or dropped.
export function mintItems(plan, rawItems) {
  const minted = [];
  for (const raw of rawItems) {
    const { text, stage, note } = normalizeInput(raw);
    const id = `t-${plan.nextId++}`;
    minted.push({ id, text, stage, note });
  }
  return minted;
}

// Enforce "only one active item": if the incoming items introduce a second active one,
// demote the previously active item to pending and report it in `notes`.
export function enforceSingleActive(items, notes) {
  const activeIdxs = [];
  for (let i = 0; i < items.length; i++) if (items[i].stage === "active") activeIdxs.push(i);
  if (activeIdxs.length <= 1) return;
  // keep the last one marked active (most recent instruction wins), demote the rest
  for (let i = 0; i < activeIdxs.length - 1; i++) {
    items[activeIdxs[i]].stage = "pending";
  }
  notes.push(`only one item can be active; ${items[activeIdxs[activeIdxs.length - 1]].id} stays active, the rest returned to pending`);
}

/**
 * Sets the stage of the listed ids, the way todo_mark and the page's "mark" command both do it: the stage
 * must be one of the four, every id must exist, and the single-active rule runs afterwards with its note.
 * Mutates `plan`; returns the notes. The caller saves.
 */
export function markStage(plan, ids, stage) {
  if (!VALID_STAGES.has(stage)) {
    throw new Error(`stage must be one of pending, active, done, dropped; got "${stage}".`);
  }
  const missing = ids.filter((id) => !plan.items.some((it) => it.id === id));
  if (missing.length) throw new Error(`unknown id(s): ${missing.join(", ")}.`);
  const idSet = new Set(ids);
  for (const it of plan.items) if (idSet.has(it.id)) it.stage = stage;
  const notes = [];
  enforceSingleActive(plan.items, notes);
  return notes;
}

/** The plan as data for the page: the items with a note always present, and the done/total tally. */
export function planData(plan) {
  const items = plan.items.map(({ id, text, stage, note }) => ({ id, text, stage, note: note ?? "" }));
  return { items, done: items.filter((i) => i.stage === "done").length, total: items.length };
}

export function checkCap(existingCount, addingCount) {
  if (existingCount + addingCount > MAX_ITEMS) {
    throw new Error(
      `adding ${addingCount} item(s) would exceed the ${MAX_ITEMS}-item plan cap (currently ${existingCount}). Drop or finish some items first.`
    );
  }
}

export function renderPlan(plan) {
  const lines = plan.items.map((it) => {
    const mark = STAGE_MARK[it.stage] ?? "[ ]";
    const suffix = it.note ? ` — ${it.note}` : "";
    return `${mark} ${it.id} ${it.text}${suffix}`;
  });
  const done = plan.items.filter((i) => i.stage === "done").length;
  const active = plan.items.filter((i) => i.stage === "active").length;
  const pending = plan.items.filter((i) => i.stage === "pending").length;
  const dropped = plan.items.filter((i) => i.stage === "dropped").length;
  const tallyParts = [`${done} done`, `${active} active`, `${pending} pending`];
  if (dropped) tallyParts.push(`${dropped} dropped`);
  return [lines.join("\n"), tallyParts.join(" · ")].filter(Boolean).join("\n\n");
}

export const CAP = MAX_ITEMS;

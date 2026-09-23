// The five todo_* tools: each loads the plan, mutates it, saves it, and renders it back,
// so the model always sees the whole current plan and never has to ask for it separately.
import { loadPlan, savePlan } from "./store.js";
import { mintItems, enforceSingleActive, checkCap, markStage, renderPlan, CAP } from "./plan.js";

function homeAndSession(env) {
  return { home: env.cwd, sessionId: env.session?.id ?? "default" };
}

function withNotes(rendered, notes) {
  return notes.length ? `${notes.join("\n")}\n\n${rendered}` : rendered;
}

export async function todoWrite(args, env) {
  const { home, sessionId } = homeAndSession(env);
  const rawItems = Array.isArray(args.items) ? args.items : [];
  if (rawItems.length > CAP) throw new Error(`items has ${rawItems.length} entries, over the ${CAP}-item plan cap.`);

  const plan = await loadPlan(home, sessionId); // keep nextId, discard old items: ids keep counting up
  plan.items = mintItems(plan, rawItems);

  const notes = [];
  enforceSingleActive(plan.items, notes);
  await savePlan(home, sessionId, plan);
  return withNotes(renderPlan(plan), notes);
}

export async function todoAdd(args, env) {
  const { home, sessionId } = homeAndSession(env);
  const rawItems = Array.isArray(args.items) ? args.items : [];
  const plan = await loadPlan(home, sessionId);
  checkCap(plan.items.length, rawItems.length);

  const minted = mintItems(plan, rawItems);
  plan.items.push(...minted);

  const notes = [];
  enforceSingleActive(plan.items, notes);
  await savePlan(home, sessionId, plan);
  return withNotes(renderPlan(plan), notes);
}

export async function todoMark(args, env) {
  const { home, sessionId } = homeAndSession(env);
  const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
  const plan = await loadPlan(home, sessionId);
  const notes = markStage(plan, ids, String(args.stage ?? ""));
  await savePlan(home, sessionId, plan);
  return withNotes(renderPlan(plan), notes);
}

export async function todoOrder(args, env) {
  const { home, sessionId } = homeAndSession(env);
  const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
  if (new Set(ids).size !== ids.length) throw new Error("duplicate ids are not allowed in a plan order.");
  const plan = await loadPlan(home, sessionId);

  const missing = ids.filter((id) => !plan.items.some((it) => it.id === id));
  if (missing.length) throw new Error(`unknown id(s): ${missing.join(", ")}.`);

  const byId = new Map(plan.items.map((it) => [it.id, it]));
  const ordered = ids.map((id) => byId.get(id));
  const rest = plan.items.filter((it) => !ids.includes(it.id));
  plan.items = [...ordered, ...rest];

  await savePlan(home, sessionId, plan);
  return renderPlan(plan);
}

export async function todoRead(_args, env) {
  const { home, sessionId } = homeAndSession(env);
  const plan = await loadPlan(home, sessionId);
  return renderPlan(plan);
}

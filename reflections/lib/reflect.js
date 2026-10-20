// One reflection, start to end: read the conversation and its subagents from the kernel, export the
// evidence under `reflections/<s>/context/`, send the one request, parse, guard, and write the lesson and
// the reflection. The service calls it for one record at a time; it throws a sentence when something
// failed, and it never writes a lesson once `stillWanted()` says the record was cancelled or forgotten.
import { descendantsOf, exportConversation, labelsOf } from "./export.js";
import { remove, writeText } from "./files.js";
import { writeLesson } from "./lessons.js";
import { guard, missionText, evidenceText, parseAnswer, reflectionRequest, shortenRequest } from "./prompt.js";
import { contextDir, projectName, projectOf, readRecord, reflectionPath } from "./records.js";

/** How long the one request may take. A strong model reading 150k tokens and thinking is minutes, not seconds. */
export const CALL_TIMEOUT_MS = 15 * 60_000;

/** The request, sent: its text, its cost when the provider reported one, and its token counts. */
export async function callModel(kernel, request, signal, timeoutMs = CALL_TIMEOUT_MS) {
  const own = new AbortController();
  const bound = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
  const timer = setTimeout(() => own.abort(), timeoutMs);
  timer.unref?.();
  let text = "";
  let failure;
  let cost;
  const tokens = {};
  try {
    const work = kernel.providers.call(
      request,
      (e) => {
        if (e?.type === "text") text += e.delta ?? "";
        else if (e?.type === "error") failure ??= e.message ?? "the provider failed";
        else if (e?.type === "usage" && e.usage) {
          if (typeof e.usage.cost === "number") cost = (cost ?? 0) + e.usage.cost;
          if (typeof e.usage.prompt_tokens === "number") tokens.input = (tokens.input ?? 0) + e.usage.prompt_tokens;
          if (typeof e.usage.completion_tokens === "number") tokens.output = (tokens.output ?? 0) + e.usage.completion_tokens;
        }
      },
      bound,
    );
    work.catch(() => {});
    // Raced as well as signalled: a provider that ignores the signal must not hold the queue.
    await Promise.race([work, new Promise((_, fail) => bound.addEventListener("abort", () => fail(new Error("aborted")), { once: true }))]);
  } catch (e) {
    failure ??= signal?.aborted ? "cancelled" : own.signal.aborted ? `no answer within ${Math.round(timeoutMs / 60000)} minutes` : e?.message ?? String(e);
  } finally {
    clearTimeout(timer);
  }
  return { text, failure, cost, tokens };
}

/** The reflection as the place shows it and `<s>.md` keeps it. */
export function reflectionMarkdown({ record, rows, outcome, answer, events, partial, refusedLesson }) {
  const head = [`# Reflection on ${JSON.stringify(record.title || record.session)}`, ""];
  const facts = [record.session, record.model && `by ${record.model}`, typeof record.costUsd === "number" && `$${record.costUsd.toFixed(2)}`, `${events} events`].filter(Boolean).join(" · ");
  head.push(facts, "");
  if (partial) head.push(`Partial: ${partial}.`, "");
  const body = ["## What was tried", ""];
  if (rows.length) for (const r of rows) body.push(`${r.n}. **${r.verdict}** · ${r.approach}`, `   Observed: ${r.observed}`);
  else body.push("No rows.");
  body.push("", "## Lesson", "");
  if (outcome.lesson) {
    const l = outcome.lesson;
    body.push(`**${l.lesson}.** Use when ${l.cue}.`, "", `Evidence: ${l.evidence}`, "", `Confidence: ${l.confidence}`);
    if (outcome.shortened) body.push("", "The model's first sentence was too long; a second, short request said it in fewer words.");
    if (l.facts.length) body.push("", "Workspace facts (re-verify before relying on them):", "", ...l.facts.map((f) => `- ${f}`));
  } else {
    body.push(`No lesson: ${outcome.refused}.`);
    // A lesson the guard refused is still shown as it came: the person paid for it, and may write it by hand.
    const l = refusedLesson;
    if (l?.lesson) body.push("", "The refused lesson, as the model wrote it:", "", `> ${l.lesson}`, `> Use when: ${l.cue || "—"}`, `> Evidence: ${l.evidence || "—"}`);
  }
  if (answer !== undefined) body.push("", "## The model's answer, as it came", "", "```", answer.trim(), "```");
  return `${[...head, ...body].join("\n")}\n`;
}

/**
 * Reflects on one conversation. Answers the fields the service writes on the record: `{ model, costUsd?,
 * tokens, events, rows, lesson?, reason?, partial? }`, or `{ discarded: true }` when the record stopped
 * being wanted while the model was writing.
 *
 * @param env       `{ home, kernel }`.
 * @param settings  what `settingsOf` answers.
 * @param record    the record being reflected (state `running`).
 * @param opts      `{ signal, stillWanted: () => Promise<boolean>, onModel(model) }`.
 */
export async function reflect({ home, kernel }, settings, record, { signal, stillWanted = async () => true, onModel = () => {} } = {}) {
  const s = record.session;
  const all = await kernel.sessions.list();
  if (!all.some((x) => x.id === s)) throw new Error("the conversation is gone");
  const root = { ...(await kernel.sessions.inspect(s)), id: s };
  const children = [];
  const labels = labelsOf(root);
  for (const c of descendantsOf(all, s)) {
    try {
      const rec = { ...(await kernel.sessions.inspect(c.id)), id: c.id };
      for (const [k, v] of labelsOf(rec)) labels.set(k, v);
      children.push({ id: c.id, parent: c.parent, label: labels.get(c.id), record: rec });
    } catch {
      // A subagent deleted between the list and now has nothing to read.
    }
  }

  // A forget that lands while this runs removes the record; whatever evidence this wrote goes with it, so a
  // forgotten conversation's words never come back from a reflection that was still on its way.
  const discard = async (spent = {}) => {
    if (!(await readRecord(home, s))) await remove(home, `reflections/${s}`);
    return { discarded: true, ...spent };
  };

  const exported = exportConversation(root, children, { title: record.title, observationChars: settings.observationChars, inputChars: settings.inputChars });
  const mission = missionText(exported.partial);
  await remove(home, `reflections/${s}`);
  const dir = contextDir(s);
  await writeText(home, `${dir}/MISSION.md`, mission);
  for (const [path, text] of Object.entries(exported.files)) await writeText(home, `${dir}/${path}`, text);
  if (!(await stillWanted())) return discard();

  const model = settings.model || (await kernel.models())?.model;
  if (!model) throw new Error("no model to reflect with: the server has no default model and none is set");
  await onModel(model);
  const request = reflectionRequest({ model, maxTokens: settings.maxTokens, mission, evidence: evidenceText(exported.files) });
  const call = await callModel(kernel, request, signal);
  const spent = { model, ...(call.cost !== undefined ? { costUsd: call.cost } : {}), tokens: call.tokens, events: exported.events, ...(exported.partial ? { partial: exported.partial } : {}) };
  if (call.failure) throw Object.assign(new Error(call.failure), { spent });
  if (!call.text.trim()) throw Object.assign(new Error("the model answered with nothing"), { spent });

  const parsed = parseAnswer(call.text);
  const shown = { ...record, ...spent };
  if (!parsed.found) {
    // Kept as it came, so a person can see what the model did instead of what was asked.
    if (!(await stillWanted())) return discard(spent);
    await writeText(home, reflectionPath(s), reflectionMarkdown({ record: shown, rows: [], outcome: { refused: "the answer had none of the blocks asked for" }, answer: call.text, events: exported.events, partial: exported.partial }));
    throw Object.assign(new Error("the model's answer had none of the blocks asked for; it is kept in the reflection"), { spent });
  }
  let outcome = guard(parsed, exported.visible);
  if (outcome.tooLong) {
    // One cheap request to say it shorter; on any failure the first refusal stands and is shown with its text.
    const short = await callModel(kernel, shortenRequest({ model, lesson: outcome.tooLong, cue: parsed.lesson.cue }), signal);
    if (short.cost !== undefined) spent.costUsd = (spent.costUsd ?? 0) + short.cost;
    const sentence = short.text.trim().replace(/^["“']|["”']$/g, "");
    if (!short.failure && sentence) {
      const again = guard({ ...parsed, lesson: { ...parsed.lesson, lesson: sentence } }, exported.visible);
      if (again.lesson) outcome = { ...again, shortened: true };
    }
  }
  if (!(await stillWanted())) return discard(spent);

  let lesson;
  if (outcome.lesson) {
    const project = await projectOf(home, s);
    lesson = await writeLesson(home, {
      lesson: outcome.lesson,
      rows: parsed.rows,
      conversation: { id: s, title: record.title, project, projectName: project ? await projectName(home, project) : null, model },
    });
  }
  const shownNow = { ...record, ...spent };
  await writeText(home, reflectionPath(s), reflectionMarkdown({ record: shownNow, rows: parsed.rows, outcome, events: exported.events, partial: exported.partial, refusedLesson: outcome.lesson ? undefined : parsed.lesson }));
  return { ...spent, rows: parsed.rows.length, ...(lesson ? { lesson } : { reason: `no lesson: ${outcome.refused}` }) };
}

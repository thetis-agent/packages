// One reflection, start to end: read the conversation and its subagents from the kernel, export the
// evidence under `reflections/<s>/context/` (the trajectory, what the harness was, what the library already
// holds), send the one request, parse, guard, and write the findings, the proposal and the reflection. The
// service calls it for one record at a time; it throws a sentence when something failed, and it writes
// nothing to the library once `stillWanted()` says the record was cancelled or forgotten.
import { descendantsOf, exportConversation, labelsOf } from "./export.js";
import { remove, writeText } from "./files.js";
import { harnessFiles, installedPackages, readStamps, versionMap } from "./harness.js";
import { indexMarkdown, readFindings, readLibrary, recordFindings, recordProposal, skillMap, skillsOf, updateLibrary } from "./library.js";
import { evidenceText, guard, missionText, parseAnswer, reflectionRequest } from "./prompt.js";
import { contextDir, listProjects, projectOf, readRecord, reflectionPath } from "./records.js";

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

/** A line diff of two texts, `-`/`+`/` ` prefixed, by longest common subsequence. */
export function lineDiff(before, after) {
  const a = String(before ?? "").replace(/\n$/, "").split("\n");
  const b = String(after ?? "").replace(/\n$/, "").split("\n");
  if (a.length * b.length > 4_000_000) return [...a.map((l) => `- ${l}`), ...b.map((l) => `+ ${l}`)].join("\n");
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out.join("\n");
}

const kindTarget = (p) => (p.kind === "guide-note" || !p.target || p.target === "-" ? p.kind : `${p.kind} ${p.target}`);

/** The reflection as the place shows it and `<s>.md` keeps it. */
export function reflectionMarkdown({ record, rows, outcome = {}, answer, events, partial, stamped }) {
  const head = [`# Reflection on ${JSON.stringify(record.title || record.session)}`, ""];
  const facts = [record.session, record.model && `by ${record.model}`, typeof record.costUsd === "number" && `$${record.costUsd.toFixed(2)}`, `${events} events`].filter(Boolean).join(" · ");
  head.push(facts, "");
  if (partial) head.push(`Partial: ${partial}.`, "");
  if (stamped === false) head.push("This conversation ran before turns were recorded, so what the harness was is today's guess.", "");
  const body = ["## What was tried", ""];
  if (rows.length) for (const r of rows) body.push(`${r.n}. **${r.verdict}** · ${r.approach} (${r.component})`, `   Observed: ${r.observed}`);
  else body.push("No rows.");

  const kept = outcome.findings ?? [];
  const refusedFindings = outcome.refusedFindings ?? [];
  if (kept.length || refusedFindings.length) {
    body.push("", "## Findings", "");
    for (const f of kept) body.push(`- ${f.id ? `${f.id} · ` : ""}**${f.package} ${f.component}**${f.version ? ` (${f.version})` : ""}: ${f.what} Evidence: ${f.evidence}.${f.sameAs ? ` Same as ${f.sameAs}.` : ""}`);
    for (const { finding, why } of refusedFindings) body.push(`- Refused (${why}): ${finding.package || "?"} ${finding.component || ""}: ${finding.what || "—"}`);
  }

  body.push("", "## Proposal", "");
  const p = outcome.proposal;
  if (p && p.reinforces) {
    body.push(`Reinforces ${p.reinforces}: this conversation is counted as more evidence for it.${outcome.rejected ? " It reinforces a rejected proposal, which stays rejected." : ""}`, "", `Evidence: ${p.evidence}`);
  } else if (p) {
    body.push(`${outcome.proposalId ? `${outcome.proposalId} · ` : ""}${kindTarget(p)}`, "", `**${p.lesson}** Use when ${p.cue}.`, "", `Evidence: ${p.evidence}`, "", `Confidence: ${p.confidence}`, "", `Trial request: ${p.trial}`, "");
    if (typeof outcome.before === "string" && (p.kind === "skill" || p.kind === "project-instructions")) body.push("The change, against what is there now:", "", "```diff", lineDiff(outcome.before, p.change), "```");
    else body.push("The change:", "", "```", String(p.change ?? "").trimEnd(), "```");
  } else {
    body.push(`No proposal: ${outcome.refused ?? "none was made"}.`);
    // A proposal the guard refused is still shown as it came: the person paid for it, and may write it by hand.
    if (outcome.block) body.push("", "The refused proposal, as the model wrote it:", "", "```", outcome.block, "```");
  }
  if (answer !== undefined) body.push("", "## The model's answer, as it came", "", "```", answer.trim(), "```");
  return `${[...head, ...body].join("\n")}\n`;
}

/** Drops the entries an earlier reflection of `s` proposed and nothing happened to since: a reflection run again replaces them. */
function dropUntouchedFrom(home, s, keepId) {
  return updateLibrary(home, (lib) => {
    lib.entries = lib.entries.filter((e) => e.id === keepId || !(e.state === "proposed" && !e.trials?.length && (e.from ?? []).length && e.from.every((f) => f.session === s)));
  });
}

/**
 * Reflects on one conversation. Answers the fields the service writes on the record: `{ model, costUsd?,
 * tokens, events, rows, proposal, findings, reason?, partial? }`, or `{ discarded: true }` when the record
 * stopped being wanted while the model was writing.
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

  // What the harness was, from the stamps, and what the library already holds.
  const packages = await installedPackages({ home, kernel });
  const today = versionMap(packages);
  const conversations = [{ id: s, stamps: await readStamps(home, s), dir: `harness-core/snapshots/${s}` }];
  for (const c of children) conversations.push({ id: c.id, label: c.label, stamps: await readStamps(home, c.id), dir: `harness-core/snapshots/${c.id}` });
  const harness = await harnessFiles(home, conversations, today);
  const library = await readLibrary(home);
  const findingsStore = await readFindings(home);
  const extra = { "library/INDEX.md": indexMarkdown(library, findingsStore) };
  for (const [path, text] of Object.entries(harness.files)) extra[`harness/${path}`] = text;
  const reserve = Math.min(Math.floor(settings.inputChars / 2), Object.values(extra).reduce((n, t) => n + t.length + 40, 0));

  const exported = exportConversation(root, children, { title: record.title, observationChars: settings.observationChars, inputChars: settings.inputChars, reserve });
  const files = { ...exported.files, ...extra };
  const mission = missionText(exported.partial);
  await remove(home, `reflections/${s}`);
  const dir = contextDir(s);
  await writeText(home, `${dir}/MISSION.md`, mission);
  for (const [path, text] of Object.entries(files)) await writeText(home, `${dir}/${path}`, text);
  if (!(await stillWanted())) return discard();

  const model = settings.model || (await kernel.models())?.model;
  if (!model) throw new Error("no model to reflect with: the server has no default model and none is set");
  await onModel(model);
  const request = reflectionRequest({ model, maxTokens: settings.maxTokens, mission, evidence: evidenceText(files) });
  const call = await callModel(kernel, request, signal);
  const spent = { model, ...(call.cost !== undefined ? { costUsd: call.cost } : {}), tokens: call.tokens, events: exported.events, ...(exported.partial ? { partial: exported.partial } : {}) };
  if (call.failure) throw Object.assign(new Error(call.failure), { spent });
  if (!call.text.trim()) throw Object.assign(new Error("the model answered with nothing"), { spent });

  const parsed = parseAnswer(call.text);
  const shown = { ...record, ...spent };
  if (!parsed.found) {
    // Kept as it came, so a person can see what the model did instead of what was asked.
    if (!(await stillWanted())) return discard(spent);
    await writeText(home, reflectionPath(s), reflectionMarkdown({ record: shown, rows: [], outcome: { refused: "the answer had none of the blocks asked for" }, answer: call.text, events: exported.events, partial: exported.partial, stamped: harness.stamped }));
    throw Object.assign(new Error("the model's answer had none of the blocks asked for; it is kept in the reflection"), { spent });
  }

  // Read the library again: another reflection or the place may have changed it while the model wrote.
  const libNow = await readLibrary(home);
  const findingsNow = await readFindings(home);
  const outcome = guard(parsed, {
    visible: exported.visible,
    versions: harness.versions,
    packages: new Map(packages.map((p) => [p.name, { version: p.version, config: p.thetis?.config ?? {} }])),
    projects: new Set((await listProjects(home)).map((p) => p.id)),
    entries: new Set(libNow.entries.map((e) => e.id)),
    findings: new Set(findingsNow.findings.map((f) => f.id)),
    skills: skillMap(skillsOf(home, packages)),
  });
  if (!(await stillWanted())) return discard(spent);

  const conversation = { session: s, title: record.title ?? null, project: record.project ?? (await projectOf(home, s)) };
  const findingIds = await recordFindings(home, outcome.findings, conversation);
  outcome.findings.forEach((f, i) => (f.id = findingIds[i]));
  await dropUntouchedFrom(home, s, outcome.proposal?.reinforces);
  let proposal = null;
  if (outcome.proposal) {
    const res = await recordProposal({ home, kernel }, { proposal: outcome.proposal, conversation, rows: parsed.rows, packages });
    proposal = res.id;
    outcome.proposalId = res.id;
    if (res.rejected) outcome.rejected = true;
    if (!res.reinforced) outcome.before = (await readLibrary(home)).entries.find((e) => e.id === res.id)?.before ?? null;
  } else outcome.block = parsed.proposalBlock;
  await writeText(home, reflectionPath(s), reflectionMarkdown({ record: { ...record, ...spent }, rows: parsed.rows, outcome, events: exported.events, partial: exported.partial, stamped: harness.stamped }));
  return {
    ...spent,
    rows: parsed.rows.length,
    proposal,
    findings: findingIds,
    ...(outcome.proposal?.reinforces ? { reinforced: true } : {}),
    ...(outcome.rejected ? { note: "reinforces a rejected proposal" } : {}),
    ...(proposal ? {} : { reason: `no proposal: ${outcome.refused}` }),
  };
}

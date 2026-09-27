// Rendering the captured request, its system prompt, and the persisted usage ledger. The request and
// the prompt arrive as a summary; the big texts are fetched by `data.need(part, index)` when a view
// needs them and read back with `data.part(part, index)` (see index.js).
export function contextViews(ext, data) {
  const { el } = ext.dom;
  const expanded = new Set();
  const note = (sentence, tone) => el("p", { class: `ui-context-note${tone ? ` is-${tone}` : ""}` }, sentence);
  const json = (value) => JSON.stringify(value, null, 2);
  const pre = (value, cls = "") => el("pre", { class: `ui-context-json${cls ? ` ${cls}` : ""}` }, value);
  const pane = (...children) => el("div", { class: "ui-context-pane", role: "tabpanel" }, ...children);

  /** A fold whose body is one big text, fetched the first time it is opened. */
  function lazy(key, summary, part, index = null, cls = "") {
    const held = data.part(part, index);
    const open = expanded.has(key);
    if (open && !held) data.need(part, index); // opened before, and the capture changed since
    const inside = !open ? [] : held?.error ? [note(held.error, "error")] : held?.done ? [pre(held.text, cls)] : [note("Loading…")];
    return el("details", {
      class: "ui-context-detail", open,
      onToggle: (event) => {
        if (!event.currentTarget.open) return void expanded.delete(key);
        expanded.add(key);
        if (!data.part(part, index)?.done) data.need(part, index); // its answer redraws the dock with the text
      },
    }, el("summary", {}, ...summary), ...inside);
  }

  function request(call) {
    const body = call.request;
    const tools = Array.isArray(call.tools) ? call.tools : [];
    const meta = ext.ui.kv([
      ["Model", el("span", { class: "mono" }, call.model ?? "—")],
      ["When", Number.isFinite(Date.parse(call.at)) ? new Date(call.at).toLocaleString() : "—"],
      ["Tools offered", String(tools.length)],
      ["Messages in the exchange", String(call.messages ?? "—")],
    ]);
    if (!body) return pane(meta, note("Full request JSON was not captured for this older call."), ext.ui.section("Tools"), ext.ui.tags(tools, "dim", "none"));
    const wire = call.format === "wire";
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const count = Number.isInteger(body.messageCount) ? body.messageCount : messages.length;
    const definitions = Array.isArray(body.tools) ? body.tools : [];
    return pane(
      note(wire ? "Most recent · POST /chat/completions · exact request body · auth headers excluded" : "Most recent provider input · this provider did not report its HTTP request body"),
      meta, ext.ui.section("Request parameters"), pre(json(body.params ?? {})),
      ext.ui.section("Messages", String(count)),
      count > messages.length && note(`The first ${count - messages.length} messages are not listed; the full request has them.`),
      ...messages.map((message) => lazy(`message-${message.index}`, [
        el("span", { class: "mono" }, String(message.index)),
        el("span", { class: "ui-context-role" }, message.role ?? "?"),
        el("span", { class: "ui-context-gist" }, message.gist ?? ""),
        el("span", { class: "ui-context-size mono" }, size(message.bytes)),
        message.cache && el("span", { class: "badge is-warn", title: "Prompt-cache breakpoint" }, "cache_control"),
      ], "message", message.index)),
      ext.ui.section("Tools", String(definitions.length)),
      ext.ui.tags(tools, "dim", "none"),
      ...definitions.map((tool) => lazy(`tool-${tool.index}`, [
        el("span", { class: "ui-context-role" }, tool.name ?? "?"),
        el("span", { class: "ui-context-gist" }, "function definition"),
        el("span", { class: "ui-context-size mono" }, size(tool.bytes)),
        tool.cache && el("span", { class: "badge is-warn" }, "cache_control"),
      ], "tool", tool.index)),
      lazy("raw", [el("span", {}, "Full request JSON"), el("span", { class: "ui-context-size mono" }, size(body.bytes))], "request", null, "ui-context-raw"),
    );
  }

  function prompt(call) {
    const empty = () => el("div", { class: "ui-context-pane is-prompt", role: "tabpanel" }, note("The system prompt was empty on this call."));
    if (call.systemChars === 0) return empty();
    const held = data.part("system");
    if (!held) data.need("system");
    const inside = held?.error ? note(held.error, "error") : held?.done ? (held.text ? el("div", { class: "ui-context-prompt" }, ext.markdown(held.text)) : null) : note("Loading the prompt…");
    return inside ? el("div", { class: "ui-context-pane is-prompt", role: "tabpanel" }, inside) : empty();
  }

  function usage(state) {
    const rows = state.usage;
    const count = Number.isInteger(state.usageCount) ? state.usageCount : rows.length;
    let totals = state.usageTotals;
    if (!totals) {
      totals = {};
      for (const row of rows) for (const [key, value] of Object.entries(row.usage ?? {})) {
        if (Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
      }
    }
    const last = state.lastCall?.usage;
    const expected = state.turns + (state.status === "running" ? 1 : 0);
    return pane(
      ext.ui.kv([
        ["Session cost", money(totals.cost)], ["Prompt tokens", number(totals.prompt_tokens)],
        ["Completion tokens", number(totals.completion_tokens)], ["Cached tokens", number(totals.cache_read_tokens)],
        ["Cache write tokens", number(totals.cache_write_tokens)], ["Reasoning tokens", number(totals.reasoning_tokens)],
        ["Recorded turns", String(count)],
      ]),
      last && note(`Last call: ${number(last.prompt_tokens)} → ${number(last.completion_tokens)} tokens${last.prompt_tokens > 0 && last.cache_read_tokens != null ? ` · ${Math.round(last.cache_read_tokens / last.prompt_tokens * 100)}% cached` : ""} · ${state.lastCall.model}`),
      count < expected && note("Usage is unavailable for some earlier turns. Totals include the recorded usage only."),
      !rows.length ? note(state.status === "running" ? "The turn is running. Usage will appear as the provider reports it." : "No usage has been recorded in this conversation yet.") :
        ext.ui.section("Per turn, newest first", String(count)),
      count > rows.length && note(`The ${rows.length} newest turns are listed; the totals above count all ${count}.`),
      ...rows.slice().reverse().map((row, index) => details(`usage-${row.id}`, [
        el("span", { class: "mono" }, `#${count - index}`),
        el("span", { class: "ui-context-role" }, row.status ?? "complete"),
        el("span", { class: "ui-context-gist" }, `${money(row.usage?.cost)} · ${number(row.usage?.prompt_tokens)} → ${number(row.usage?.completion_tokens)} tok · ${row.calls} call${row.calls === 1 ? "" : "s"}`),
      ], pre(json(row)))),
    );
  }

  function details(key, summary, ...children) {
    return el("details", {
      class: "ui-context-detail", open: expanded.has(key),
      onToggle: (event) => { if (event.currentTarget.open) expanded.add(key); else expanded.delete(key); },
    }, el("summary", {}, ...summary), ...children);
  }

  return { request, prompt, usage, reset: () => expanded.clear() };
}

const number = (value) => Number.isFinite(value) ? value.toLocaleString() : "—";
const money = (value) => Number.isFinite(value) ? `$${value.toFixed(4)}` : "—";
function size(bytes) {
  if (!Number.isFinite(bytes)) return "";
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

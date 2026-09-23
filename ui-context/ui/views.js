// Rendering the captured request, its system prompt, and the persisted usage ledger.
export function contextViews(ext) {
  const { el } = ext.dom;
  const expanded = new Set();
  const note = (sentence) => el("p", { class: "ui-context-note" }, sentence);
  const json = (value) => JSON.stringify(value, null, 2);
  const pre = (value) => el("pre", { class: "ui-context-json" }, value);
  const pane = (...children) => el("div", { class: "ui-context-pane", role: "tabpanel" }, ...children);

  function details(key, summary, ...children) {
    return el("details", {
      class: "ui-context-detail", open: expanded.has(key),
      onToggle: (event) => { if (event.currentTarget.open) expanded.add(key); else expanded.delete(key); },
    }, el("summary", {}, ...summary), ...children);
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
    const shown = wire || !body.system ? messages : [{ role: "system", content: body.system }, ...messages];
    const definitions = Array.isArray(body.tools) ? body.tools : [];
    const fields = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "messages" && key !== "tools" && key !== "system"));
    return pane(
      note(wire ? "Most recent · POST /chat/completions · exact request body · auth headers excluded" : "Most recent provider input · this provider did not report its HTTP request body"),
      meta, ext.ui.section("Request parameters"), pre(json(fields)),
      ext.ui.section("Messages", String(shown.length)),
      ...shown.map((message, index) => {
        const calls = message.tool_calls ?? message.toolCalls ?? [];
        const names = calls.map((c) => c.function?.name ?? c.name ?? "?");
        const reply = message.tool_call_id ?? message.toolCallId;
        const gist = [names.length ? `tool calls: ${names.join(", ")}` : "", reply ? `for ${reply}` : "", contentText(message.content)].filter(Boolean).join(" · ");
        return details(`message-${index}`, [
          el("span", { class: "mono" }, String(index)),
          el("span", { class: "ui-context-role" }, message.role ?? "?"),
          el("span", { class: "ui-context-gist" }, cut(gist)),
          el("span", { class: "ui-context-size mono" }, size(message)),
          hasCache(message) && el("span", { class: "badge is-warn", title: "Prompt-cache breakpoint" }, "cache_control"),
        ], pre(json(message)));
      }),
      ext.ui.section("Tools", String(definitions.length)),
      ext.ui.tags(tools, "dim", "none"),
      ...definitions.map((tool, index) => details(`tool-${index}`, [
        el("span", { class: "ui-context-role" }, tool.function?.name ?? tool.name ?? "?"),
        el("span", { class: "ui-context-gist" }, "function definition"),
        el("span", { class: "ui-context-size mono" }, size(tool)),
        hasCache(tool) && el("span", { class: "badge is-warn" }, "cache_control"),
      ], pre(json(tool)))),
      details("raw", ["Full request JSON"], el("pre", { class: "ui-context-json ui-context-raw" }, json(body))),
    );
  }

  function prompt(call) {
    return el("div", { class: "ui-context-pane is-prompt", role: "tabpanel" },
      call.system ? el("div", { class: "ui-context-prompt" }, ext.markdown(call.system)) : note("The system prompt was empty on this call."));
  }

  function usage(state) {
    const rows = state.usage;
    const totals = {};
    for (const row of rows) for (const [key, value] of Object.entries(row.usage ?? {})) {
      if (Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
    }
    const last = state.lastCall?.usage;
    const expected = state.turns + (state.status === "running" ? 1 : 0);
    return pane(
      ext.ui.kv([
        ["Session cost", money(totals.cost)], ["Prompt tokens", number(totals.prompt_tokens)],
        ["Completion tokens", number(totals.completion_tokens)], ["Cached tokens", number(totals.cache_read_tokens)],
        ["Cache write tokens", number(totals.cache_write_tokens)], ["Reasoning tokens", number(totals.reasoning_tokens)],
        ["Recorded turns", String(rows.length)],
      ]),
      last && note(`Last call: ${number(last.prompt_tokens)} → ${number(last.completion_tokens)} tokens${last.prompt_tokens > 0 && last.cache_read_tokens != null ? ` · ${Math.round(last.cache_read_tokens / last.prompt_tokens * 100)}% cached` : ""} · ${state.lastCall.model}`),
      rows.length < expected && note("Usage is unavailable for some earlier turns. Totals include the recorded usage only."),
      !rows.length ? note(state.status === "running" ? "The turn is running. Usage will appear as the provider reports it." : "No usage has been recorded in this conversation yet.") :
        ext.ui.section("Per turn, newest first", String(rows.length)),
      ...rows.slice().reverse().map((row, index) => details(`usage-${row.id}`, [
        el("span", { class: "mono" }, `#${rows.length - index}`),
        el("span", { class: "ui-context-role" }, row.status ?? "complete"),
        el("span", { class: "ui-context-gist" }, `${money(row.usage?.cost)} · ${number(row.usage?.prompt_tokens)} → ${number(row.usage?.completion_tokens)} tok · ${row.calls} call${row.calls === 1 ? "" : "s"}`),
      ], pre(json(row)))),
    );
  }

  return { request, prompt, usage, reset: () => expanded.clear() };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => typeof b === "string" ? b : b?.text ?? `[${b?.type ?? "block"}]`).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

function hasCache(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(value.cache_control) || Object.values(value).some((child) => child && typeof child === "object" && hasCache(child));
}

const cut = (value) => value.replace(/\s+/g, " ").trim().slice(0, 120);
const number = (value) => Number.isFinite(value) ? value.toLocaleString() : "—";
const money = (value) => Number.isFinite(value) ? `$${value.toFixed(4)}` : "—";
function size(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

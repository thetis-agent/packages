/* The configuration form one package gets. It is drawn the same in the control panel (an admin, at the
 * system layer or one person's) and in the marketplace (a person, at their own layer). The state of every
 * key is the kernel's: the report says whether a value reaches the package, where it came from, and which
 * `${VAR}` did not resolve, and the row says that in one line next to the control that fixes it. Nothing
 * here guesses a state, and a secret's value never arrives: its box is write-only and the row says `set`
 * or `not set`. Save sends one write per key that changed; a JSON box that does not parse is marked in
 * place and nothing is sent.
 *
 * Kept byte-identical in @thetis/ui-admin and @thetis/ui-marketplace. A package's page may import only its
 * own files (docs/15 section 11.6), so the two copies are held together by a test rather than an import.
 * The pure helpers are exported for that test; they touch no DOM. */

/** The control a key gets, from its declared type, or from its value when it is not declared. */
export function kindOf(k) {
  if (k.secret) return "secret";
  const v = k.value;
  const type = k.declared && k.type ? k.type : Array.isArray(v) ? "array" : v !== null && typeof v === "object" ? "object" : typeof v;
  if (type === "number") return "number";
  if (type === "boolean") return "checkbox";
  if (type === "object" || type === "array") return "json";
  return "text";
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a control holds, against what the report said: `{ same: true }` when nothing changed, `{ value }`
 * when it did, `{ error }` when what was typed cannot be sent as the key's type. `raw` is the box's text,
 * or the checkbox's boolean. An empty box where nothing was set is nothing, not a change; an empty box where
 * something was set is refused, because the way to remove a value is Clear.
 */
export function readValue(kind, raw, k) {
  const orig = k.value;
  if (kind === "secret") return raw ? { value: raw } : { same: true };
  if (kind === "checkbox") return raw === (orig === true) ? { same: true } : { value: raw };
  const text = typeof raw === "string" ? raw : "";
  if (kind === "text") return text === (typeof orig === "string" ? orig : "") ? { same: true } : { value: text };
  const trimmed = text.trim();
  if (trimmed === "") return orig === undefined ? { same: true } : { error: "Nothing typed. Clear removes the value." };
  if (kind === "number") {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { error: `${trimmed} is not a number.` };
    return n === orig ? { same: true } : { value: n };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { error: `Not valid JSON: ${err.message}` };
  }
  if (parsed === null) return { error: "null cannot be stored. Clear removes the value." };
  if (k.type === "array" && !Array.isArray(parsed)) return { error: "An array is expected here." };
  if (k.type === "object" && (Array.isArray(parsed) || typeof parsed !== "object")) return { error: "An object is expected here." };
  return same(parsed, orig) ? { same: true } : { value: parsed };
}

/** Where the value came from, in words. `layer` is the layer being edited; `who` names the person when it is not the reader. */
export function sourceText(k, layer, who) {
  if (k.state === "unset" || !k.source) return "not set";
  const from = k.source === "default" ? "default" : k.source === "file" ? "from the file" : k.source === "system" ? "set for everyone" : who ? `set by ${who}` : "set by you";
  return k.inheritedFrom ? `${from} · inherited from ${k.inheritedFrom}` : from;
}

/** The `${VAR}` names that did not resolve, one sentence. */
export const missingText = (k) => (k.missing?.length ? `${k.missing.join(", ")} ${k.missing.length === 1 ? "is" : "are"} not in the environment` : null);

/** The line above the cards, or null when every package is whole. */
export function brokenSentence(reports) {
  const n = reports.filter((r) => r?.broken).length;
  return n ? `${n} ${n === 1 ? "package is" : "packages are"} missing configuration` : null;
}

/** What `config.reload` did, in one sentence. */
export function reloadSentence(result) {
  const changed = Array.isArray(result?.changed) ? result.changed : [];
  const restarted = Array.isArray(result?.restarted) ? result.restarted : [];
  if (!changed.length && !restarted.length) return "Nothing changed.";
  const parts = [];
  if (changed.length) parts.push(`changed: ${changed.join(", ")}`);
  if (restarted.length) parts.push(`restarted: ${restarted.map((r) => `${r.package} for ${r.user}`).join(", ")}`);
  return parts.join("; ") + ".";
}

/** The package's one sentence, red when it is broken. */
export function summaryLine(ext, report) {
  return ext.dom.el("span", { class: `cf-summary${report.broken ? " is-broken" : ""}` }, report.summary || "");
}

/**
 * One package's card: the header (the name, what it inherits from, the summary), a row per key, Save.
 * `set(key, value)` and `unset(key)` write one key at `layer` and answer the report afterwards; the card
 * redraws itself from that answer and hands it to `onReport`, so the owner can recount what is broken.
 * `who` names the person whose layer this is when it is not the reader's own.
 */
export function configCard(ext, report, { layer, who = null, set, unset, onReport }) {
  const { el, clear } = ext.dom;
  const { badge, button, confirm, put } = ext.ui;
  const shell = el("div", { class: "card cf-card", "data-package": report.package });
  let current = report;
  let busy = false;

  function control(kind, k, locked) {
    const common = { "aria-label": k.key, disabled: locked || null };
    if (kind === "secret") return el("input", { ...common, class: "input cf-input", type: "password", placeholder: k.state === "set" ? "new value" : "value", autocomplete: "new-password" });
    if (kind === "checkbox") return el("input", { ...common, class: "cf-check", type: "checkbox", checked: k.value === true || null });
    if (kind === "number") return el("input", { ...common, class: "input cf-input", type: "number", step: "any", value: typeof k.value === "number" ? String(k.value) : null });
    if (kind === "json") return el("textarea", { ...common, class: "input cf-json", rows: 4, spellcheck: "false" }, k.value === undefined ? "" : JSON.stringify(k.value, null, 2));
    return el("input", { ...common, class: "input cf-input", type: "text", value: typeof k.value === "string" ? k.value : null, autocomplete: "off", spellcheck: "false" });
  }

  const rawOf = (kind, box) => (kind === "checkbox" ? box.checked : box.value);

  async function clearKey(anchor, k) {
    const ok = await confirm(anchor, { title: "Clear this key?", lines: [["package", current.package], ["key", k.key]], note: `The value stored at this layer is removed. ${k.key} falls back to the file or its default, or is not set.`, confirmLabel: "Clear", tone: "warn" });
    if (!ok || busy) return;
    busy = true;
    try {
      current = await unset(k.key);
      ext.toast(`${k.key} was cleared for ${current.package}.`, { tone: "good" });
    } catch (err) {
      ext.toast(`${k.key}: ${err.message}`, { tone: "error" });
    } finally {
      busy = false;
    }
    draw();
    onReport?.(current);
  }

  function row(k, controls) {
    const kind = kindOf(k);
    // A key declared for the system is set by an admin at the system layer; a person's own layer never overrides it.
    const locked = k.scope === "system" && layer === "user";
    const box = control(kind, k, locked);
    const error = el("p", { class: "cf-error", hidden: true });
    controls.set(k.key, { read: () => readValue(kind, rawOf(kind, box), k), error });
    const marks = [k.required ? badge("required", "dim") : null, k.scope === "system" ? badge("admins only", "accent") : null, k.declared ? null : badge("not declared", "dim")];
    const state = [];
    if (kind === "secret") state.push(badge(k.state === "set" ? "set" : "not set", k.state === "set" ? "ok" : k.required || k.state === "missing" ? "err" : "dim"));
    if (kind === "secret" && typeof k.value === "string") state.push(el("code", { class: "cf-ref" }, k.value));
    state.push(el("span", { class: "text-faint" }, sourceText(k, layer, who)));
    const missing = missingText(k);
    // Clear only where an unset changes anything: the value this layer holds, for this package itself.
    const clearable = !locked && k.source === layer && !k.inheritedFrom && k.state !== "unset";
    const clearBtn = clearable ? button("Clear", { tone: "warn", onClick: () => void clearKey(clearBtn, k) }) : null;
    return el(
      "div",
      { class: `cf-row${k.state === "missing" ? " is-missing" : ""}`, "data-key": k.key },
      el("div", { class: "cf-key" }, el("code", {}, k.key), ...marks),
      k.help ? el("p", { class: "cf-help" }, k.help) : null,
      el("div", { class: "cf-control" }, box, ...state, clearBtn),
      missing ? el("p", { class: "cf-missing" }, missing) : null,
      locked ? el("p", { class: "text-faint" }, "Set by an admin in the control panel, for everyone.") : null,
      error
    );
  }

  async function save(btn, controls) {
    const changes = [];
    let bad = false;
    for (const [key, c] of controls) {
      const out = c.read();
      c.error.hidden = !out.error;
      c.error.textContent = out.error ?? "";
      if (out.error) bad = true;
      else if (!out.same) changes.push([key, out.value]);
    }
    if (bad) return void ext.toast("Fix the marked keys first. Nothing was sent.", { tone: "error" });
    if (!changes.length) return void ext.toast("Nothing changed.", { tone: "good" });
    if (busy) return;
    busy = true;
    btn.disabled = true;
    let written = 0;
    try {
      for (const [key, value] of changes) {
        current = await set(key, value);
        written += 1;
      }
      ext.toast(`${written} ${written === 1 ? "key" : "keys"} saved for ${current.package}. ${current.summary}`, { tone: current.broken ? "warn" : "good" });
    } catch (err) {
      ext.toast(`${changes[written][0]}: ${err.message}${written ? ` (${written} saved before it)` : ""}`, { tone: "error" });
    } finally {
      busy = false;
    }
    draw();
    onReport?.(current);
  }

  function draw() {
    clear(shell);
    const controls = new Map();
    const rows = current.keys.map((k) => row(k, controls));
    const saveBtn = button("Save", { tone: "primary", onClick: () => void save(saveBtn, controls) });
    const editable = current.keys.some((k) => !(k.scope === "system" && layer === "user"));
    put(
      shell,
      el(
        "div",
        { class: "card-head cf-head" },
        el("code", {}, current.package),
        current.inherits?.length ? el("span", { class: "text-faint" }, `inherits from ${current.inherits.join(", ")}`) : null,
        summaryLine(ext, current)
      ),
      el("div", { class: "card-body" }, rows.length ? rows : el("p", { class: "text-faint" }, "This package declares no configuration and none is stored for it."), rows.length && editable ? el("div", { class: "card-actions" }, saveBtn) : null)
    );
  }

  draw();
  return shell;
}

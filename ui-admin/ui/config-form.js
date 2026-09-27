/* The settings form one extension gets. It is drawn the same in the control panel (an admin, at everyone's
 * layer or one person's) and in the Extensions place (a person, at their own layer). The state of every key is
 * the kernel's: the report says whether a value reaches the extension, where it came from, and which `${VAR}`
 * did not resolve, and the row says that in one line next to the control that fixes it. Nothing here guesses
 * a state. Save sends one write per key that changed; a JSON box that does not parse is marked in place and
 * nothing is sent.
 *
 * What a person reads: the card is headed by the extension's label ("Exa Web Search"), never its id; each key
 * by a name a person says ("API key", "Timeout (milliseconds)"), the raw key only as the name's tooltip; one
 * line for where the value comes from ("Set for everyone", "Your key", "Not set"), said once. A value of one's
 * own is "used instead of everyone's" only when everyone has one too (`below`, what lies under the layer being
 * edited, when the owner knows it); the header never claims a key works, only that it is saved ("Key saved —
 * not checked yet"). A saved secret is shown masked (••••••••) with **Show** where it is revealable (the
 * layer being viewed holds it, and it is not another person's), which asks the owning package's
 * `config-reveal` command for the value and turns into **Hide**; the command reveals a value only when that
 * layer is the one in effect for the person asking, and answers a sentence otherwise. Keys that are rarely
 * touched (no help, or a base URL, a timeout, headers, defaults) sit under an "Advanced" fold, unless every key
 * would. Clear asks in plain words what happens next ("Remove your key? Exa Web Search stops working until you
 * add one again."), and says "you", never the reader's id. An address in a key's help is a link.
 *
 * `configCard(ext, report, opts)`: `layer` ("system" or "user"), `who` (the person whose layer it is when it is
 * not the reader's own), `me` (the reader's id, said "you" in a confirm), `below` (`{ <key>: "everyone" |
 * "default" | "none" }`, what a key falls back to once this layer's value is cleared; a key not in it is not
 * known), `set(key, value)` and `unset(key)` (each answers the report afterwards), `onReport` (called with the
 * new report after a save or a clear, so the owner can redraw its chip and banner at once), `label` (the
 * extension's label; its humanised name when not given), `people` (the names of who has it, for the clear
 * confirm at everyone's layer), `reveal(key)` (answers the value; by default the package's own `config-reveal`
 * command with `{ name, key, layer, user? }`), `advanced()` (the owner's own nodes for the Advanced fold, such as
 * an admin's words on the server's file). At a person's own layer the card ends in what is true of it: "Only
 * you can see and use this key." when the key is theirs; "Your admin set this key for everyone. A key you add
 * here is only yours." when everyone's is the one in effect, which the row says too ("Set for everyone — your
 * admin's key is used", the box "Paste your own key to use instead").
 *
 * Kept byte-identical in @thetis/ui-admin and @thetis/ui-marketplace. A package's page may import only its
 * own files (packages/gateway-web/README.md), so the two copies are held together by a test rather than an
 * import. The pure helpers are exported for that test; they touch no DOM. */

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

// ---- words ---------------------------------------------------------------------------------------------

/** Words spelled as a person spells them inside a key's name. */
const ACRONYMS = Object.freeze({ api: "API", url: "URL", uri: "URI", id: "ID", ssh: "SSH", http: "HTTP", https: "HTTPS", json: "JSON", llm: "LLM", mcp: "MCP", ui: "UI" });
/** Unit suffixes, said in brackets after the rest: `timeoutMs` → "Timeout (milliseconds)". */
const UNITS = Object.freeze({ ms: "milliseconds", millis: "milliseconds", sec: "seconds", secs: "seconds", seconds: "seconds", s: "seconds", min: "minutes", mins: "minutes", minutes: "minutes", kb: "KB", mb: "MB" });
/** A few whole names whose plain reading is not the split one. */
const KNOWN = Object.freeze({ apikey: "API key", apitoken: "API token", baseurl: "Base URL", token: "Token" });

/** A key's name as a person reads it: `apiKey` → "API key", `baseUrl` → "Base URL", `timeoutMs` → "Timeout (milliseconds)". */
export function keyLabel(k) {
  const raw = String(k?.key ?? k ?? "");
  if (KNOWN[raw.toLowerCase()]) return KNOWN[raw.toLowerCase()];
  const words = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s_.-]+/).filter(Boolean).map((w) => w.toLowerCase());
  if (!words.length) return raw;
  const unit = words.length > 1 && UNITS[words.at(-1)] ? UNITS[words.pop()] : null;
  const said = words.map((w, i) => ACRONYMS[w] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
  return unit ? `${said} (${unit})` : said;
}

/** An extension's name when the owner gave no label: the part after the scope, dashes as spaces, words capitalised. */
export function nameOf(pkg) {
  const base = String(pkg ?? "").replace(/^@[^/]+\//, "").replace(/^ui-/, "").replace(/[-_.]+/g, " ").trim();
  return base ? base.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : String(pkg ?? "");
}

/** "a", "a and b", "a, b and c". */
const listOf = (words) => {
  const w = words.filter(Boolean);
  return w.length <= 1 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
};

/** What the value at a person's own layer is called: "Your key", "Yours", "sam's key", "sam's own". */
const ownNoun = (k, who) => (who ? `${who}'s ${k.secret ? "key" : "own"}` : k.secret ? "Your key" : "Yours");

/** The value in effect is everyone's (an admin's, or the server's file), not the layer's own. */
const everyones = (k) => k.state !== "unset" && k.state !== "missing" && (k.source === "system" || k.source === "file");

/**
 * The line a person's own form ends with, said only where it is true: everyone's key in effect, their own, or
 * none yet. `keys` is the report's keys.
 */
export function footText(keys) {
  const secret = keys.some((k) => k.secret);
  if (keys.some((k) => k.secret && everyones(k))) return "Your admin set this key for everyone. A key you add here is only yours.";
  if (keys.some((k) => k.source === "user" && k.state !== "unset")) return `Only you can see and use ${secret ? "this key" : "these settings"}.`;
  return secret ? "A key you add here is only yours." : "Settings you save here are only yours.";
}

/**
 * Where the value came from, in words. `layer` is the layer being edited; `who` names the person whose layer
 * it is when that is not the reader; `below` is what the key falls back to under that layer ("everyone",
 * "default", "none", or undefined when not known). One line, never a second "not set" beside it. On the
 * reader's own layer, everyone's key in effect says whose it is: "Set for everyone — your admin's key is used".
 */
export function sourceText(k, layer, who = null, below = undefined) {
  if (k.state === "unset" || k.state === "missing" || !k.source) return "Not set";
  const own = ownNoun(k, who);
  const from =
    k.source === "default"
      ? "Default"
      : k.secret && layer === "user" && !who && everyones(k)
        ? "Set for everyone — your admin's key is used"
        : k.source === "file"
        ? "Set for everyone in Server settings"
        : k.source === "system"
          ? "Set for everyone"
          : below === "everyone"
            ? `${own} (used instead of everyone's)`
            : below === "default"
              ? `${own} (used instead of the default)`
              : own;
  return k.inheritedFrom ? `${from} · inherited from ${k.inheritedFrom}` : from;
}

/** The `${VAR}` names that did not resolve, one sentence. */
export const missingText = (k) => (k.missing?.length ? `${k.missing.join(", ")} ${k.missing.length === 1 ? "is" : "are"} not in the environment` : null);

/**
 * The card's one line: what is still missing, by the names a person reads; that a secret is saved, which is all
 * that is known of it until the extension uses it (never that it works); or that nothing is missing.
 */
export function summaryText(report) {
  const keys = report?.keys ?? [];
  const missing = keys.filter((k) => k?.state === "missing");
  if (missing.length) return `Needs setup: ${listOf(missing.map(keyLabel))}`;
  if (report?.broken) return report.summary || "Something is missing";
  const secrets = keys.filter((k) => k?.secret && k.state === "set").length;
  if (secrets) return `${secrets === 1 ? "Key" : "Keys"} saved — not checked yet`;
  return keys.length ? "Nothing missing" : "";
}

/** The line above the cards, or null when every extension is whole. */
export function brokenSentence(reports) {
  const n = reports.filter((r) => r?.broken).length;
  return n ? `${n} ${n === 1 ? "extension is" : "extensions are"} missing configuration` : null;
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

/** Rarely touched: no help to go by, or a base URL, a timeout, headers or defaults. A key that must be set never is. */
const ADVANCED_NAME = /url$|timeout|headers?$|defaults?$|retr(y|ies)|concurrency|proxy|(^|[a-z])ms$/i;
export const isAdvanced = (k) => !k.required && k.state !== "missing" && (!k.help || ADVANCED_NAME.test(k.key));

/** A sentence begins with a capital, even when it begins with "you". */
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The Clear confirm, in plain words: `{ title, note }`. At a person's layer what happens depends on what lies
 * under it (`below`): everyone's value again, the default again, or nothing, in which case the extension stops
 * working until a new one is added; when that is not known, both are said. At everyone's, the people who have
 * not set their own lose what needs it, or go back to the default. `label` is the extension's label, `people`
 * who has it, `who` whose layer it is when not the reader's, `me` the reader, said "you".
 */
export function clearWords(k, { layer, who = null, me = null, label = "", people = [], below = undefined } = {}) {
  const secret = !!k.secret;
  const noun = secret ? "key" : keyLabel(k);
  const name = label || "it";
  if (layer === "user") {
    const whose = who ? `${who}'s` : "your";
    if (below === "everyone") return { title: `Remove ${whose} own ${noun}?`, note: `${who ? `${who} uses` : "You will use"} everyone's ${noun} again.` };
    if (below === "default") return { title: `Remove ${whose} ${noun}?`, note: `${who ? `${who} goes` : "You go"} back to the default.` };
    const stops = `${name} stops working${who ? ` for ${who}` : ""} until ${who ? "they add" : "you add"} one again.`;
    if (below === "none") return { title: `Remove ${whose} ${noun}?`, note: k.required ? capital(stops) : `${who ? `${who} has` : "You have"} none after that.` };
    return { title: `Remove ${whose} ${noun}?`, note: `${who ? `${who} uses` : "You will use"} everyone's ${noun} if there is one; otherwise ${k.required ? stops : "there is none."}` };
  }
  const named = people.map((p) => (me && p === me ? "you" : p));
  const names = listOf(named);
  const many = people.length !== 1 || named[0] === "you";
  if (k.required) {
    const lose = names ? `${names.startsWith("you") ? capital(names) : names} ${many ? "lose" : "loses"} ${name}` : `Everyone loses ${name}`;
    const own = named.includes("you") ? (named.length === 1 ? "unless you set your own" : "unless each of you sets your own") : "unless they set their own";
    return { title: `Remove everyone's ${noun}?`, note: k.scope === "system" ? `${lose} until it is set again.` : `${lose} ${own}.` };
  }
  return { title: `Remove everyone's ${noun}?`, note: "People who have not set their own go back to the default." };
}

/** The pieces of a help text with its addresses as links: `[{ text }, { text, href }, …]`. A bare domain gets https://. */
export function linkParts(text) {
  const s = String(text ?? "");
  const re = /\bhttps?:\/\/[^\s)]+|\b(?:[a-z0-9-]+\.)+(?:ai|com|io|net|org|so|dev|app|co)\b(?:\/[^\s)]*)?/gi;
  const out = [];
  let at = 0;
  for (const m of s.matchAll(re)) {
    const raw = m[0].replace(/[.,;:]+$/, "");
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    out.push({ text: raw, href: /^https?:/i.test(raw) ? raw : `https://${raw}` });
    at = m.index + raw.length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** The masked form of a saved secret. */
export const MASK = "••••••••";

/** The package's own `config-reveal`, the way both packages declare it. */
const revealBy = (ext, name, layer, who) => (key) => ext.request("config-reveal", { args: { name, key, layer, ...(who ? { user: who } : {}) } }).then((out) => out?.data?.value);

/**
 * One extension's card: the header (its label, what it inherits from, what is missing), a row per key (the
 * rarely touched ones folded under Advanced), Save. The card redraws itself from each answer and hands it to
 * `onReport`, so the owner redraws its chip and banner straight away.
 */
export function configCard(ext, report, { layer, who = null, me = null, below = null, set, unset, onReport, label = null, people = [], reveal = null, advanced = null }) {
  const { el, clear } = ext.dom;
  const { badge, button, confirm, put } = ext.ui;
  const shell = el("div", { class: "card cf-card", "data-package": report.package });
  const title = label || nameOf(report.package);
  const show = reveal ?? revealBy(ext, report.package, layer, who);
  let current = report;
  let busy = false;
  let advancedOpen = false;
  const shown = new Map(); // key -> the revealed value, while it is shown
  /** What a key falls back to under this layer: "everyone", "default", "none", or undefined when not known. */
  const under = (k) => (below && typeof below === "object" ? below[k.key] : undefined);
  /** A help text with its addresses as links. */
  const helpNodes = (text) => linkParts(text).map((p) => (p.href ? el("a", { href: p.href, target: "_blank", rel: "noopener noreferrer" }, p.text) : p.text));

  function control(kind, k, locked) {
    const common = { "aria-label": keyLabel(k), disabled: locked || null };
    const placeholder = k.state !== "set" ? "Paste it here" : layer === "user" && !who && everyones(k) ? "Paste your own key to use instead" : "Type a new one to replace it";
    if (kind === "secret") return el("input", { ...common, class: "input cf-input", type: "password", placeholder, autocomplete: "new-password" });
    if (kind === "checkbox") return el("input", { ...common, class: "cf-check", type: "checkbox", checked: k.value === true || null });
    if (kind === "number") return el("input", { ...common, class: "input cf-input", type: "number", step: "any", value: typeof k.value === "number" ? String(k.value) : null });
    if (kind === "json") return el("textarea", { ...common, class: "input cf-json", rows: 4, spellcheck: "false" }, k.value === undefined ? "" : JSON.stringify(k.value, null, 2));
    return el("input", { ...common, class: "input cf-input", type: "text", value: typeof k.value === "string" ? k.value : null, autocomplete: "off", spellcheck: "false" });
  }

  const rawOf = (kind, box) => (kind === "checkbox" ? box.checked : box.value);

  async function clearKey(anchor, k) {
    const words = clearWords(k, { layer, who, me, label: title, people, below: under(k) });
    const ok = await confirm(anchor, { title: words.title, lines: [["extension", title], ["setting", keyLabel(k)]], note: words.note, confirmLabel: "Remove", tone: "warn" });
    if (!ok || busy) return;
    busy = true;
    try {
      current = await unset(k.key);
      shown.delete(k.key);
      ext.toast(`${keyLabel(k)} was removed for ${title}.`, { tone: "good" });
    } catch (err) {
      ext.toast(`${keyLabel(k)}: ${err.message}`, { tone: "error" });
    } finally {
      busy = false;
    }
    draw();
    onReport?.(current);
  }

  /** The masked value and Show, or the value and Hide; a refusal is said in a toast and the mask stays. */
  function secretValue(k) {
    const text = el("code", { class: "cf-ref cf-mask" }, shown.has(k.key) ? shown.get(k.key) : MASK);
    const toggle = button(shown.has(k.key) ? "Hide" : "Show", { title: shown.has(k.key) ? "Hide the value again" : "Show the saved value" });
    toggle.classList.add("is-sm");
    toggle.addEventListener("click", async () => {
      if (shown.has(k.key)) {
        shown.delete(k.key);
        text.textContent = MASK;
        toggle.textContent = "Show";
        return;
      }
      toggle.disabled = true;
      try {
        const value = await show(k.key);
        const said = typeof value === "string" ? value : JSON.stringify(value);
        shown.set(k.key, said);
        text.textContent = said;
        toggle.textContent = "Hide";
      } catch (err) {
        ext.toast(err.message, { tone: "warn" });
      } finally {
        toggle.disabled = false;
      }
    });
    return [text, toggle];
  }

  function row(k, controls) {
    const kind = kindOf(k);
    // A key declared for the system is set by an admin at everyone's layer; a person's own layer never overrides it.
    const locked = k.scope === "system" && layer === "user";
    const box = control(kind, k, locked);
    const error = el("p", { class: "cf-error", hidden: true });
    controls.set(k.key, { read: () => readValue(kind, rawOf(kind, box), k), error });
    const bad = k.state === "missing" || (k.required && k.state === "unset");
    const marks = [k.required ? badge("required", "dim") : null, k.scope === "system" && layer !== "user" ? badge("admins only", "accent") : null];
    const state = [];
    // A saved secret: masked, with Show where it can be shown -- the value this layer holds, and not another
    // person's. A `${VAR}` reference is not the secret itself, so it is shown as it is.
    const revealable = k.source === layer && !who;
    if (kind === "secret" && k.state !== "unset" && k.source) state.push(...(typeof k.value === "string" ? [el("code", { class: "cf-ref" }, k.value)] : revealable ? secretValue(k) : [el("code", { class: "cf-ref cf-mask" }, MASK)]));
    state.push(el("span", { class: bad ? "cf-source cf-missing" : "cf-source text-faint" }, sourceText(k, layer, who, under(k))));
    const missing = missingText(k);
    // Clear only where an unset changes anything: the value this layer holds, for this extension itself.
    const clearable = !locked && k.source === layer && !k.inheritedFrom && k.state !== "unset";
    const clearBtn = clearable ? button("Clear", { tone: "warn", onClick: () => void clearKey(clearBtn, k) }) : null;
    return el(
      "div",
      { class: `cf-row${k.state === "missing" ? " is-missing" : ""}`, "data-key": k.key },
      el("div", { class: "cf-key" }, el("b", { class: "cf-name", title: `${k.key}: the setting's name in the extension's files` }, keyLabel(k)), ...marks),
      k.help ? el("p", { class: "cf-help" }, ...helpNodes(k.help)) : null,
      el("div", { class: "cf-control" }, box, ...state, clearBtn),
      missing ? el("p", { class: "cf-missing" }, missing) : null,
      locked ? el("p", { class: "text-faint" }, "Only an admin can set this, for everyone.") : null,
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
    if (bad) return void ext.toast("Fix the marked settings first. Nothing was sent.", { tone: "error" });
    if (!changes.length) return void ext.toast("Nothing changed.", { tone: "good" });
    if (busy) return;
    busy = true;
    btn.disabled = true;
    let written = 0;
    try {
      for (const [key, value] of changes) {
        current = await set(key, value);
        shown.delete(key);
        written += 1;
      }
      const missing = summaryText(current);
      ext.toast(`Saved for ${title}. ${current.broken ? `${missing}.` : "It is used from the next call; nothing checks it before then."}`, { tone: current.broken ? "warn" : "good" });
    } catch (err) {
      ext.toast(`${keyLabel({ key: changes[written][0] })}: ${err.message}${written ? ` (${written} saved before it)` : ""}`, { tone: "error" });
    } finally {
      busy = false;
    }
    draw();
    onReport?.(current);
  }

  function draw() {
    clear(shell);
    const controls = new Map();
    const keys = current.keys ?? [];
    // Every key under the fold would hide the whole form behind one click: then nothing is folded.
    const folded = keys.filter(isAdvanced).length < keys.length ? keys.filter(isAdvanced) : [];
    const main = keys.filter((k) => !folded.includes(k)).map((k) => row(k, controls));
    const extra = folded.map((k) => row(k, controls));
    const saveBtn = button("Save", { tone: "primary", onClick: () => void save(saveBtn, controls) });
    const editable = keys.some((k) => !(k.scope === "system" && layer === "user"));
    // The owner's own advanced words (an admin's: the server's file, `${VAR}`) go in the same fold, never a second one.
    const more = typeof advanced === "function" ? advanced() : null;
    const fold = extra.length || more ? el("details", { class: "cf-advanced", open: advancedOpen || null, onToggle: (e) => { advancedOpen = e.currentTarget.open; } }, el("summary", {}, extra.length ? `Advanced (${extra.length})` : "Advanced"), ...extra, more) : null;
    const summary = summaryText(current);
    put(
      shell,
      el(
        "div",
        { class: "card-head cf-head" },
        el("span", { class: "cf-title", title: current.package }, title),
        current.inherits?.length ? el("span", { class: "text-faint" }, `inherits from ${current.inherits.join(", ")}`) : null,
        summary ? el("span", { class: `cf-summary${current.broken ? " is-broken" : ""}` }, summary) : null
      ),
      el(
        "div",
        { class: "card-body" },
        keys.length ? [...main, fold] : [el("p", { class: "text-faint" }, "This extension has no settings, and none are stored for it."), fold],
        keys.length && editable ? el("div", { class: "card-actions" }, saveBtn) : null,
        // A person's own layer is theirs alone: nobody else runs with it, and only they are shown it.
        layer === "user" && !who && editable ? el("p", { class: "cf-foot text-faint" }, footText(keys)) : null
      )
    );
  }

  draw();
  return shell;
}

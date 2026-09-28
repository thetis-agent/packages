// Renders an operation's result as flat text for a model, as the Rust Thetis's browser tools did:
// one context line (title, url, tab), then the scalars, then the lists, and the page map last.
// Keys go in a fixed order so consecutive calls read as a diff rather than a reshuffle.

const CONTEXT = new Set(["url", "title", "tabs", "activeTab"]);
const LAST = ["snapshot", "snapshotNote", "hint"];

export function render(v) {
  if (v === null || typeof v !== "object") return String(v);
  let out = "";
  if (v.url) {
    out += v.title ? `page: ${v.title} — ${v.url}` : `page: ${v.url}`;
    if ((v.tabs ?? 1) > 1) out += ` [tab ${v.activeTab ?? 0} of ${v.tabs}]`;
    out += "\n";
  }
  const emit = (key, val) => {
    if (CONTEXT.has(key) || val === undefined) return;
    if (Array.isArray(val)) {
      if (val.every((i) => typeof i === "string")) {
        out += `\n${key} (${val.length}):\n`;
        for (const i of val) out += `  ${i}\n`;
      } else out += `\n${key} (${val.length}):\n${JSON.stringify(val, null, 2)}\n`;
    } else if (val && typeof val === "object") {
      out += `\n${key}:\n${JSON.stringify(val, null, 2)}\n`;
    } else if (typeof val === "string" && val.includes("\n")) {
      out += `\n${key}:\n${val}\n`;
    } else out += `${key}: ${val}\n`;
  };
  for (const [k, val] of Object.entries(v)) if (!LAST.includes(k)) emit(k, val);
  for (const k of LAST) if (k in v) emit(k, v[k]);
  return out.trim() ? out.trimEnd() : "the browser reported success with nothing to show.";
}

/** Playwright errors carry a long call log; the first lines hold the cause. */
export function shortError(e) {
  const msg = String(e?.message ?? e).split("\n").filter((l) => !/^\s*(=+|Call log:)/.test(l));
  let text = msg.slice(0, 4).join("\n").replace(/^(locator|page|frame|elementHandle)\.\w+: /, "");
  if (/aria-ref=e\d+/.test(text) && /(Timeout|not found|resolved to 0)/i.test(text)) {
    text += "\nThat ref is from an older snapshot or is gone from the page: take browser_snapshot and use a fresh ref.";
  } else if (/Timeout \d+ms exceeded/.test(text)) {
    text += "\nThe page did not get there in time. Check browser_snapshot for what is on screen, or browser_wait with a longer `timeout`.";
  }
  return text;
}

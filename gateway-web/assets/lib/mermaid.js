/* Mermaid diagrams in assistant messages.
 *
 * A ```mermaid fence renders as a diagram; anything that fails to parse, or
 * fails because the library did not load, falls back to the ordinary fenced
 * code block with its copy button. The reader is therefore never worse off
 * than before this file existed, which is the whole contract here — a diagram
 * is an enhancement over the source, not a replacement that can strand it.
 *
 * On the "no dependencies" house rule: this is a deliberate, operator-approved
 * exception. A diagram layout engine is a pile of graph algorithms that is not
 * worth reimplementing, and getting it wrong shows up as an unreadable diagram.
 * It is vendored and self-served rather than pulled from a CDN, so the UI still
 * reaches nothing but its own origin, which is all `default-src 'self'` allows.
 * The exact version and its hash are recorded in `docs/dependencies.md`.
 *
 * On the "model output is never innerHTML" rule: mermaid's whole output *is* a
 * string of SVG, so there is no DOM-building route available. Three things keep
 * that honest, and none should be removed:
 *   - `securityLevel: "strict"`, which runs mermaid's bundled DOMPurify over
 *     the output and strips script and event handlers;
 *   - `htmlLabels: false`, so label text becomes SVG <text> rather than a
 *     foreignObject carrying arbitrary HTML;
 *   - the parse-then-render split, so malformed input never reaches the DOM.
 * The string is also mermaid's own construction, not the model's text passed
 * through — the model supplies graph source, which mermaid parses.
 */

import { el } from "./dom.js";

/** Bounds, named per house rule; see each use for what it protects. */
export const limits = { loadMs: 20000, cache: 64 };

/* Resolved against this module's own URL, never written as `/vendor/...`.
 * Every URL inside the served app has to be document-relative: the reverse
 * proxy mounts each person's gateway under a prefix it strips away (docs/
 * proxy.md, ADR 0038), so an absolute "/vendor/mermaid.js" would resolve above
 * that prefix and 404. A relative URL works under the prefix and without it. */
const asset = (name) => new URL(`../vendor/${name}`, import.meta.url).href;

let libPromise = null; // the vendored bundle, loaded at most once

/* Loaded with a classic script tag rather than `import`, because the bundle is
 * an IIFE that ends in `globalThis["mermaid"] = ...` and has no export map.
 * Fetched as a module it would parse cleanly and define nothing. A same-origin
 * <script src> is what `default-src 'self'` permits; an inline one is not.
 *
 * Lazy on purpose: the library is ~3.5 MB, and most conversations contain no
 * diagram at all. Nothing is fetched until the first mermaid fence appears.
 *
 * The timeout is not paranoia. If neither `load` nor `error` ever fires — an
 * environment that does not execute scripts, a proxy that stalls the response,
 * a 3.5 MB fetch on a bad connection — the promise never settles and every
 * diagram sits on "drawing diagram…" with its source unreachable behind the
 * placeholder. A rejection is what surfaces the code block, so a load that
 * cannot finish must become one. */
function loadLib() {
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    const script = el("script", { src: asset("mermaid.js"), "data-mermaid": true });

    const timer = setTimeout(
      () => reject(new Error(`mermaid.js did not load within ${limits.loadMs}ms`)),
      limits.loadMs
    );
    // Settling first is harmless — a promise ignores later calls — but the
    // timer must be cleared either way or it holds the page awake.
    const settle = (fn) => (arg) => {
      clearTimeout(timer);
      fn(arg);
    };
    resolve = settle(resolve);
    reject = settle(reject);

    script.addEventListener("load", () => {
      const lib = globalThis.mermaid;
      if (!lib) return reject(new Error("mermaid.js loaded but defined no mermaid"));
      try {
        lib.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          theme: "base",
          themeVariables: themeVariables(),
          fontFamily: cssValue("--font") || "sans-serif",
        });
      } catch (err) {
        return reject(err);
      }
      resolve(lib);
    });
    script.addEventListener("error", () => reject(new Error("mermaid.js did not load")));
    document.head.append(script);
  });
  return libPromise;
}

/** One custom property, resolved through the cascade, or `fallback` when the
 *  stylesheet does not define it. Every colour handed to mermaid needs one:
 *  mermaid throws `Unsupported color format: ""` on an empty string, which
 *  takes out every diagram on the page rather than just its palette. */
function cssValue(name, fallback = "") {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/* The palette comes from theme.css rather than mermaid's stock dark theme, so a
 * diagram belongs to the surface around it. Mermaid wants plain colour strings
 * and cannot resolve a custom property itself; getComputedStyle hands back
 * resolved values, including for the color-mix() washes. */
function themeVariables() {
  const line = cssValue("--hairline-strong", "#32323f");
  const text = cssValue("--text", "#ececf2");
  const base = cssValue("--surface-1", "#101016");
  const mid = cssValue("--surface-2", "#16161f");
  const raised = cssValue("--surface-3", "#1d1d28");
  const edge = cssValue("--accent-edge", "#4d5bd9");
  return {
    darkMode: true,
    background: base,
    primaryColor: raised, primaryTextColor: text, primaryBorderColor: edge,
    secondaryColor: mid, secondaryTextColor: text, secondaryBorderColor: line,
    tertiaryColor: mid, tertiaryTextColor: text, tertiaryBorderColor: line,
    lineColor: line, textColor: text,
    mainBkg: raised, nodeBorder: edge, nodeTextColor: text,
    clusterBkg: base, clusterBorder: line, titleColor: text,
    edgeLabelBackground: base,
    actorBkg: raised, actorBorder: edge, actorTextColor: text,
    signalColor: text, signalTextColor: text,
    labelBoxBkgColor: raised, labelBoxBorderColor: line, labelTextColor: text,
    loopTextColor: text,
    noteBkgColor: mid, noteBorderColor: line, noteTextColor: text,
    errorBkgColor: cssValue("--err-wash", "#3a1f27"), errorTextColor: cssValue("--err", "#f2788f"),
    fontSize: "13px",
  };
}

/* Rendered SVG, keyed by diagram source.
 *
 * This is not a micro-optimisation, it is what makes streaming usable.
 * `renderMarkdown` runs on every delta of an assistant message, so a completed
 * diagram is re-rendered on each of the dozens of frames that follow it. Keyed
 * by source, the second and later renders are a string lookup, which also stops
 * the diagram flickering as the text after it arrives. */
const cache = new Map(); // source -> rendered SVG string
let seq = 0;

/** True for the fence languages that should render as a diagram. */
export function isMermaid(lang) {
  return /^(mermaid|mmd)$/i.test(String(lang || "").trim());
}

/* Builds the node for a mermaid fence.
 *
 * Returns synchronously — `renderMarkdown` is synchronous and is called from
 * the transcript's render path — and fills itself in when the render resolves.
 * `fallback` is a thunk so the code block is only built if it is actually
 * needed. */
export function mermaidBlock(code, fallback) {
  const source = String(code || "").trim();

  const host = el("div", { class: "md-mermaid" });
  const figure = el("div", { class: "md-mermaid-figure" });
  host.append(figure);

  // A cache hit is placed immediately, so a re-render during streaming never
  // shows the "drawing" state or replaces a diagram already on screen.
  const hit = cache.get(source);
  if (hit) {
    place(host, figure, hit, source);
    return host;
  }

  figure.append(el("div", { class: "md-mermaid-wait" }, "drawing diagram…"));
  draw(host, figure, source, fallback);
  return host;
}

/** Swaps in the code block, which is exactly what this fence rendered as before
 *  diagrams existed. Never leaves the reader with nothing. */
function giveUp(host, fallback, err) {
  const block = fallback();
  block.classList.add("md-mermaid-failed");
  block.append(
    el(
      "div",
      { class: "md-mermaid-error", title: String(err?.message || err || "") },
      "This diagram could not be drawn — showing its source."
    )
  );
  host.replaceChildren(block);
}

function draw(host, figure, source, fallback) {
  void (async () => {
    let lib;
    try {
      lib = await loadLib();
    } catch (err) {
      return giveUp(host, fallback, err);
    }
    try {
      // Parse first: a syntax error thrown here never reaches the DOM, and
      // mermaid otherwise plants its own error graphic in the page.
      await lib.parse(source);
      const { svg } = await lib.render(`md-mermaid-${++seq}`, source);
      if (cache.size >= limits.cache) cache.delete(cache.keys().next().value);
      cache.set(source, svg);
      place(host, figure, svg, source);
    } catch (err) {
      giveUp(host, fallback, err);
    }
  })();
}

/* Puts the SVG in place, with the source available behind a copy button.
 *
 * See the header note on innerHTML: the string is mermaid's own output, passed
 * through its bundled DOMPurify by securityLevel "strict". */
function place(host, figure, svg, source) {
  figure.replaceChildren();
  figure.innerHTML = svg;

  const node = figure.querySelector("svg");
  if (node) {
    // Mermaid fixes a width in px and often a max-width in a style attribute;
    // both stop the diagram fitting a narrow column. Scale to the column and
    // keep the aspect ratio from the viewBox. Through the CSSOM, not through a
    // style attribute — see `rehomeStyles` for why that distinction matters.
    node.removeAttribute("width");
    node.removeAttribute("height");
    node.style.maxWidth = "100%";
    node.style.height = "auto";
    node.setAttribute("role", "img");
    rehomeStyles(node);
  }

  const copy = el(
    "button",
    {
      type: "button",
      class: "md-copy",
      title: "Copy this diagram's source",
      onClick: () => {
        navigator.clipboard?.writeText(source).then(
          () => flash(copy, "copied"),
          () => flash(copy, "copy failed")
        );
      },
    },
    "Copy source"
  );

  host.replaceChildren(
    el("div", { class: "md-code-head" }, el("span", { class: "md-code-lang" }, "mermaid"), copy),
    figure
  );
}

/* Re-applies mermaid's own styling through the CSSOM, because the CSP drops it.
 *
 * Legacy served this UI with no CSP at all. `lib/assets` sends `default-src
 * 'self'` with no style-src exception, and that governs *parsed* CSS: every
 * `style="…"` attribute and every `<style>` element inside the SVG string is
 * refused as it is parsed out of `innerHTML`. Measured on this exact bundle
 * against that exact header: the diagram's geometry and text survive, but the
 * `<style>` element's `.sheet` is null and none of its 35 style attributes
 * apply, so without this the whole palette above is inert.
 *
 * The violation *reports* cannot be got rid of here, only the broken styling.
 * Attributed by a `securitypolicyviolation` listener on one flowchart: 64 of
 * the ~100 reports come from inside `lib.render` itself, which measures label
 * sizes by briefly inserting styled nodes into the live document, and only 37
 * from placing its output. Stripping the attributes before insertion would
 * silence the smaller half and buy nothing a reader can see, so the console
 * noise stays a known cost of the vendored bundle under this policy.
 *
 * The CSSOM is not gated the same way — CSP checks the style *content
 * attribute*, not a script assigning to `.style` or a constructed sheet — so
 * moving both across restores the diagram without widening the policy for the
 * whole surface (which would weaken gateway-login's pages too, and is a
 * decision for a person rather than for this file). Every rule mermaid emits is
 * scoped under the diagram's own `#md-mermaid-N` id, so an adopted sheet cannot
 * leak into the surface around it. */
function rehomeStyles(node) {
  for (const styled of node.querySelectorAll("[style]")) {
    const text = styled.getAttribute("style");
    // Anything already applied was set through the CSSOM above, not refused.
    if (text && styled.style.length === 0) styled.style.cssText = text;
  }
  if (!("adoptedStyleSheets" in document)) return;
  for (const sheet of node.querySelectorAll("style")) {
    if (sheet.sheet) continue; // The policy allowed it; nothing to re-home.
    try {
      const adopted = new CSSStyleSheet();
      adopted.replaceSync(sheet.textContent);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, adopted];
    } catch (err) {
      // An unstyled diagram is still a readable diagram, and the copy button
      // still hands over the source. Not worth stranding the reader over.
      console.error("a diagram's styling could not be applied", err);
    }
  }
}

function flash(button, text) {
  const previous = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = previous), 1200);
}

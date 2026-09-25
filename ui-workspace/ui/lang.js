/* Language names → the vendored CodeMirror grammar that draws them.
 *
 * The server's `stat` answers a `language` word (`lib/language.js`: ts, js, jsx, tsx, json, md, html, css,
 * py, sh, toml, yaml, plain); markdown fences carry whatever the author typed (`bash`, `JavaScript`, `yml`).
 * Both go through `canonical()` first, so one table serves the editor and the rendered fences. Each grammar
 * file is imported once and each LanguageSupport built once: Language instances are identity-based (see
 * vendor/README.md), and a second copy for the same name would only cost parse time.
 *
 * Nothing here touches the DOM, so the tables are testable in bare Node. */

const FILES = {
  javascript: "./vendor/lang-javascript.js",
  markdown: "./vendor/lang-markdown.js",
  json: "./vendor/lang-json.js",
  html: "./vendor/lang-html.js",
  css: "./vendor/lang-css.js",
  python: "./vendor/lang-python.js",
  legacy: "./vendor/lang-legacy.js",
};

/** Canonical language → [grammar file key, exported function to call]. `plain` is deliberately absent. */
export const GRAMMARS = Object.freeze({
  ts: ["javascript", "typescript"],
  tsx: ["javascript", "tsx"],
  js: ["javascript", "language"],
  jsx: ["javascript", "jsx"],
  json: ["json", "language"],
  md: ["markdown", "language"],
  html: ["html", "language"],
  css: ["css", "language"],
  py: ["python", "language"],
  sh: ["legacy", "shell"],
  toml: ["legacy", "toml"],
  yaml: ["legacy", "yaml"],
});

/** Spellings people use in fences and file names, folded onto the canonical words above. */
const ALIASES = Object.freeze({
  typescript: "ts",
  mts: "ts",
  cts: "ts",
  javascript: "js",
  mjs: "js",
  cjs: "js",
  node: "js",
  jsonc: "json",
  json5: "json",
  markdown: "md",
  mdx: "md",
  htm: "html",
  xhtml: "html",
  vue: "html",
  svg: "html",
  xml: "html",
  scss: "css",
  less: "css",
  python: "py",
  py3: "py",
  shell: "sh",
  bash: "sh",
  zsh: "sh",
  fish: "sh",
  console: "sh",
  shellsession: "sh",
  yml: "yaml",
  text: "plain",
  txt: "plain",
  plaintext: "plain",
  "": "plain",
});

/** Words for the strip. Anything unknown is shown as typed. */
const LABELS = Object.freeze({
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  md: "Markdown",
  html: "HTML",
  css: "CSS",
  py: "Python",
  sh: "Shell",
  toml: "TOML",
  yaml: "YAML",
  plain: "Plain text",
});

/** `"TypeScript"`, `" bash "`, `"yml"` → `"ts"`, `"sh"`, `"yaml"`; unknown words come back lower-cased. */
export function canonical(name) {
  const word = String(name ?? "")
    .trim()
    .toLowerCase();
  if (word in ALIASES) return ALIASES[word];
  return word;
}

/** `{ file, fn }` for a language that has a grammar, null for `plain` and anything unknown. */
export function grammarFor(name) {
  const entry = GRAMMARS[canonical(name)];
  if (!entry) return null;
  return { file: FILES[entry[0]], fn: entry[1] };
}

export function hasGrammar(name) {
  return grammarFor(name) !== null;
}

export function languageLabel(name) {
  const word = canonical(name);
  return LABELS[word] ?? (word ? word : LABELS.plain);
}

let core = null;
const modules = new Map();
const supports = new Map();

/** The core bundle (`EditorView`, `highlightToDom`, …), imported once. */
export function loadCore() {
  if (!core) core = import("./vendor/codemirror.js");
  return core;
}

function loadModule(file) {
  let promise = modules.get(file);
  if (!promise) {
    promise = import(file);
    modules.set(file, promise);
  }
  return promise;
}

/**
 * The LanguageSupport for `name`, built once and shared, or null when the language has no grammar
 * (`plain`, unknown). Never rejects: a grammar file that fails to load logs once and answers null, so a
 * file still opens as plain text.
 */
export function loadLanguage(name) {
  const grammar = grammarFor(name);
  if (!grammar) return Promise.resolve(null);
  const key = canonical(name);
  let promise = supports.get(key);
  if (!promise) {
    promise = loadModule(grammar.file)
      .then((mod) => {
        const make = mod[grammar.fn];
        if (typeof make !== "function") throw new Error(`${grammar.file} exports no ${grammar.fn}()`);
        return make();
      })
      .catch((err) => {
        console.error(`the ${key} grammar did not load:`, err);
        supports.delete(key);
        return null;
      });
    supports.set(key, promise);
  }
  return promise;
}

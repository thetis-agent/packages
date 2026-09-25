CodeMirror 6, MIT. The licence is beside this file (`LICENSE`, from `@codemirror/state`; `LICENSE-lezer`
is the same MIT text with the `@lezer/*` copyright line, which carries a different year range).

Built 2026-09-25 from these exact versions:

| package | version |
|---|---|
| `@codemirror/state` | 6.7.6 |
| `@codemirror/view` | 6.43.13 |
| `@codemirror/language` | 6.12.4 |
| `@codemirror/commands` | 6.11.1 |
| `@codemirror/search` | 6.7.2 |
| `@lezer/common` | 1.5.3 |
| `@lezer/highlight` | 1.2.4 |
| `@lezer/lr` | 1.4.10 |
| `@codemirror/lang-javascript` | 6.2.5 |
| `@codemirror/lang-markdown` | 6.5.2 |
| `@codemirror/lang-json` | 6.0.2 |
| `@codemirror/lang-html` | 6.4.12 |
| `@codemirror/lang-css` | 6.3.1 |
| `@codemirror/lang-python` | 6.2.1 |
| `@codemirror/legacy-modes` | 6.5.4 |
| `esbuild` (build tool only) | 0.28.2 |

Nothing in the bundles is patched; the only hand-written code is the entry files quoted below.

## Files

The gateway serves `.js`, `.css`, `.svg`, `.json` and `.md` only, as ES modules, so everything here is a
minified ES module with no import map behind it.

| file | minified | gzipped |
|---|---|---|
| `codemirror.js` | 388 KiB | 126 KiB |
| `lang-javascript.js` | 91 KiB | 35 KiB |
| `lang-markdown.js` | 191 KiB | 73 KiB |
| `lang-html.js` | 147 KiB | 57 KiB |
| `lang-css.js` | 28 KiB | 13 KiB |
| `lang-python.js` | 53 KiB | 22 KiB |
| `lang-json.js` | 3 KiB | 2 KiB |
| `lang-legacy.js` | 6 KiB | 3 KiB |

`codemirror.js` is the core: it re-exports everything from `@codemirror/state`, `@codemirror/view`,
`@codemirror/language`, `@lezer/common`, `@lezer/highlight` and `@lezer/lr` (171 names, no collisions
between those six packages), plus `defaultKeymap, history, historyKeymap, indentWithTab, undo, redo` from
`@codemirror/commands` and `searchKeymap, highlightSelectionMatches, openSearchPanel` from
`@codemirror/search`. `style-mod`, `w3c-keyname` and `crelt` are inlined into it; nothing else imports them.

It also exports one helper, `highlightToDom(code, languageSupport)`, which parses `code` with the language's
parser and returns a `DocumentFragment` of `<span class="tok-…">` runs (the `classHighlighter` classes) and
plain text nodes, so rendered markdown fences can be highlighted without an editor. It accepts a
`LanguageSupport` or a bare `Language`.

Each `lang-*.js` exports `language()` returning a `LanguageSupport`. `lang-javascript.js` additionally
exports `typescript()`, `jsx()` and `tsx()`; `lang-markdown.js` builds `markdown()` with `codeLanguages`
left empty (nest fences yourself if you want them); `lang-legacy.js` exports `shell()`, `toml()` and
`yaml()` built with `StreamLanguage.define` from `@codemirror/legacy-modes` and wrapped in a
`LanguageSupport` so every grammar entry point returns the same type.

## One copy of `@codemirror/state`

Facets, StateFields and Language instances are identity-based. If a grammar bundle carried its own copy of
`@codemirror/state` or `@codemirror/language`, its `LanguageSupport` would be built on a different
`Language` class than the editor's and silently do nothing (or throw on `Facet` mismatch). The gateway page
has no import map, so bare specifiers cannot be left external.

The fix is an esbuild alias: each grammar is bundled with `@codemirror/state`, `@codemirror/view`,
`@codemirror/language`, `@lezer/common`, `@lezer/highlight` and `@lezer/lr` aliased to `./codemirror.js`
and that path marked external. esbuild keeps the relative specifier in the output verbatim, so each grammar
bundle starts with `import{…}from"./codemirror.js"` and contains only its own grammar code. That is why
the core re-exports the whole of those six packages and not just the editor surface.

Check after a rebuild: every `lang-*.js` must import only from `"./codemirror.js"`, and none of them may
contain `static define` (the `Facet.define` / `StateField.define` bodies that would signal an inlined copy):

```sh
for f in lang-*.js; do grep -o 'from"[^"]*"' $f | sort -u; grep -c 'static define' $f; done
```

## How it was built

In a scratch directory, with Node 24:

```sh
npm init -y && npm pkg set type=module
npm i --save-exact @codemirror/state@6.7.6 @codemirror/view@6.43.13 @codemirror/language@6.12.4 \
  @codemirror/commands@6.11.1 @codemirror/search@6.7.2 @lezer/common@1.5.3 @lezer/highlight@1.2.4 \
  @lezer/lr@1.4.10 @codemirror/lang-javascript@6.2.5 @codemirror/lang-markdown@6.5.2 \
  @codemirror/lang-json@6.0.2 @codemirror/lang-html@6.4.12 @codemirror/lang-css@6.3.1 \
  @codemirror/lang-python@6.2.1 @codemirror/legacy-modes@6.5.4 esbuild@0.28.2
node build.mjs out                    # writes out/*.js
cp out/*.js <here>/
cp node_modules/@codemirror/state/LICENSE <here>/LICENSE
cp node_modules/@lezer/common/LICENSE    <here>/LICENSE-lezer
for f in <here>/*.js; do node --check $f; done
```

`build.mjs`:

```js
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

const out = process.argv[2] || "out";
mkdirSync(out, { recursive: true });

const shared = ["@codemirror/state", "@codemirror/view", "@codemirror/language",
                "@lezer/common", "@lezer/highlight", "@lezer/lr"];
const common = { bundle: true, format: "esm", minify: true, target: "es2022", legalComments: "none" };

await build({ ...common, entryPoints: ["src/codemirror.js"], outfile: `${out}/codemirror.js` });

for (const g of ["javascript", "markdown", "json", "html", "css", "python", "legacy"]) {
  await build({
    ...common,
    entryPoints: [`src/lang-${g}.js`],
    outfile: `${out}/lang-${g}.js`,
    alias: Object.fromEntries(shared.map((p) => [p, "./codemirror.js"])),
    external: ["./codemirror.js"],
  });
}
```

The equivalent CLI for one grammar is
`npx esbuild src/lang-json.js --bundle --format=esm --minify --target=es2022 --legal-comments=none
--alias:@codemirror/state=./codemirror.js … --alias:@lezer/lr=./codemirror.js --external:./codemirror.js
--outfile=out/lang-json.js`.

`src/codemirror.js`:

```js
export * from "@codemirror/state";
export * from "@codemirror/view";
export * from "@codemirror/language";
export * from "@lezer/common";
export * from "@lezer/highlight";
export * from "@lezer/lr";
export { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
export { searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";

import { highlightTree, classHighlighter } from "@lezer/highlight";

export function highlightToDom(code, languageSupport) {
  const lang = languageSupport && languageSupport.language ? languageSupport.language : languageSupport;
  const frag = document.createDocumentFragment();
  if (!lang || !lang.parser) { frag.appendChild(document.createTextNode(code)); return frag; }
  const tree = lang.parser.parse(code);
  let pos = 0;
  highlightTree(tree, classHighlighter, (from, to, cls) => {
    if (from > pos) frag.appendChild(document.createTextNode(code.slice(pos, from)));
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = code.slice(from, to);
    frag.appendChild(span);
    pos = to;
  });
  if (pos < code.length) frag.appendChild(document.createTextNode(code.slice(pos)));
  return frag;
}
```

`src/lang-javascript.js` (the others are the same shape with one export):

```js
import { javascript } from "@codemirror/lang-javascript";
export function language() { return javascript(); }
export function typescript() { return javascript({ typescript: true }); }
export function jsx() { return javascript({ jsx: true }); }
export function tsx() { return javascript({ jsx: true, typescript: true }); }
```

`src/lang-legacy.js`:

```js
import { StreamLanguage, LanguageSupport } from "@codemirror/language";
import { shell as shellMode } from "@codemirror/legacy-modes/mode/shell";
import { toml as tomlMode } from "@codemirror/legacy-modes/mode/toml";
import { yaml as yamlMode } from "@codemirror/legacy-modes/mode/yaml";
export function shell() { return new LanguageSupport(StreamLanguage.define(shellMode)); }
export function toml() { return new LanguageSupport(StreamLanguage.define(tomlMode)); }
export function yaml() { return new LanguageSupport(StreamLanguage.define(yamlMode)); }
```

## Content security policy

The gateway refuses inline CSS without the page nonce (`style-src 'self' 'nonce-…'`, carried in
`<meta name="csp-nonce">`). CodeMirror writes its theme and layout rules into one `<style>` element at
runtime, so unlike xterm it needs no patch: pass the nonce as an extension and the library stamps it on the
element itself.

```js
import { EditorView } from "./vendor/codemirror.js";
const nonce = document.querySelector('meta[name="csp-nonce"]').content;
new EditorView({ parent, state: EditorState.create({ doc, extensions: [/*…*/, EditorView.cspNonce.of(nonce)] }) });
```

Without it the editor still renders text but every CodeMirror stylesheet is refused, so nothing is laid
out. Verified under an enforcing `script-src 'self'; style-src 'self' 'nonce-abc'` header in headless
Chromium: the injected `<style>` reports `.nonce === "abc"`, `.cm-editor` gets `position: relative`, and
the console is clean. Note that `getAttribute("nonce")` reads back as `""` once the element is connected;
that is the browser hiding nonces, not a missing nonce.

None of the bundles touch `document` or `window` at import time; all eight import cleanly in bare Node.

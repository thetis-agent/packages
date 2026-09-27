/* The README tab: this extension's own README.md, from `package-readme` (read at this package's root, never
 * another's), rendered by the shell's markdown. A package without one says so. A copy keeps the README of what
 * it was copied from, title and all: when the README's title names another extension, a line above it says so,
 * so "@bitmuse/notion" at the top of the shared Notion's page is explained, not taken for the wrong file.
 * Relative images are shown as their alt text: the page has no resolver for a package's files. */

import { failureSentence } from "./failed.js";

/** The extension a README's title names, when it is written for another one than `name`; else null. */
export function writtenFor(text, name) {
  const title = /^\s*#\s+`?(@[a-z0-9-]+\/[a-z0-9._-]+)`?/m.exec(String(text ?? "").split("\n").slice(0, 8).join("\n"))?.[1] ?? null;
  return title && title !== name ? title : null;
}

export function mountReadme(ext, host, ctx) {
  const { el, clear } = ext.dom;
  const { busy, put } = ext.ui;
  let alive = true;
  const wrap = el("div", { class: "card ua-readme" }, el("div", { class: "card-head" }, `README · ${ctx.name}`));
  const body = el("div", { class: "card-body ua-readme-body" });
  wrap.append(body);
  host.append(wrap);
  void (async () => {
    const stop = busy(wrap, "Reading…");
    let text = null;
    try {
      text = (await ext.request("package-readme", { args: { name: ctx.name } }))?.data?.text ?? null;
    } catch (err) {
      if (!alive) return;
      clear(body);
      return void put(body, el("p", { class: "text-faint" }, failureSentence("The README", err, { admin: true })));
    } finally {
      stop();
    }
    if (!alive) return;
    clear(body);
    if (!(typeof text === "string" && text.trim())) return void put(body, el("p", { class: "text-faint" }, "This extension has no README."));
    const other = writtenFor(text, ctx.name);
    const from = ctx.info?.promotedFrom?.name === other ? ", the extension this was shared from" : ctx.info?.forkedFrom?.name === other ? ", the extension this is a copy of" : "";
    put(body, other ? el("p", { class: "panel-hint ua-readme-note" }, `This README came with the files and was written for ${other}${from}; names in it may differ from this one.`) : null, el("div", { class: "md" }, ...ext.markdown(text)));
  })();
  return () => {
    alive = false;
  };
}

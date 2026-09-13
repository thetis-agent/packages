/* A small markdown renderer for assistant text. DOM-built, never innerHTML, so model output cannot inject markup.
 * Covers paragraphs, headings, fenced code with a copy button, inline code, bold, italic, links, flat lists,
 * blockquotes, rules and pipe tables. Anything else renders as plain text. */

import { el } from "./dom.js";

export function renderMarkdown(text) {
  const lines = String(text ?? "").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(el("p", { class: "md-p" }, ...inline(paragraph.join("\n"))));
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(el(list.ordered ? "ol" : "ul", { class: "md-list" }, list.items.map((item) => el("li", {}, ...inline(item)))));
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      flush();
      const body = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i]);
      blocks.push(codeBlock(body.join("\n"), fence[1]));
      continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      flush();
      blocks.push(table.node);
      i += table.consumed;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push(el(`h${Math.min(heading[1].length + 2, 6)}`, { class: "md-h" }, ...inline(heading[2])));
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      blocks.push(el("hr", { class: "md-hr" }));
      continue;
    }
    const quoted = line.match(/^>\s?(.*)$/);
    if (quoted) {
      flush();
      const body = [quoted[1]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) body.push(lines[++i].replace(/^>\s?/, ""));
      blocks.push(el("blockquote", { class: "md-quote" }, ...inline(body.join("\n"))));
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet || numbered)[1]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

function codeBlock(code, lang) {
  const button = el(
    "button",
    {
      type: "button",
      class: "md-copy",
      title: "Copy this block",
      onClick: () => navigator.clipboard?.writeText(code).then(() => flash(button, "copied"), () => flash(button, "copy failed")),
    },
    "Copy"
  );
  return el("div", { class: "md-code" }, el("div", { class: "md-code-head" }, el("span", { class: "md-code-lang" }, lang || "text"), button), el("pre", {}, el("code", {}, code)));
}

function flash(button, text) {
  const previous = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = previous), 1200);
}

const DELIM_CELL = /^:?-+:?$/;

function tableAt(lines, start) {
  const first = lines[start];
  const next = lines[start + 1];
  if (!first || !first.includes("|") || !next || !next.includes("|")) return null;
  const delims = splitCells(next);
  if (!delims.every((c) => DELIM_CELL.test(c.trim()))) return null;
  const header = splitCells(first);
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitCells(lines[i++]));
  const cell = (tag, text) => el(tag, {}, ...inline(text.trim()));
  const node = el(
    "div",
    { class: "md-table-wrap" },
    el(
      "table",
      { class: "md-table" },
      el("thead", {}, el("tr", {}, header.map((t) => cell("th", t)))),
      el("tbody", {}, rows.map((row) => el("tr", {}, fit(row, header.length).map((t) => cell("td", t)))))
    )
  );
  return { node, consumed: i - start - 1 };
}

function splitCells(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells = [];
  let cell = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "|") (cell += "|"), i++;
    else if (text[i] === "|") cells.push(cell), (cell = "");
    else cell += text[i];
  }
  cells.push(cell);
  return cells;
}

function fit(row, width) {
  const cells = row.slice(0, width);
  while (cells.length < width) cells.push("");
  return cells;
}

const INLINE = [
  { re: /`([^`\n]+)`/, node: (m) => el("code", { class: "md-inline-code" }, m[1]) },
  { re: /\*\*([^*\n]+)\*\*/, node: (m) => el("strong", {}, m[1]) },
  { re: /\*([^*\n]+)\*/, node: (m) => el("em", {}, m[1]) },
  { re: /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/, node: (m) => el("a", { href: m[2], target: "_blank", rel: "noopener noreferrer" }, m[1]) },
];

function inline(text) {
  const nodes = [];
  let rest = text;
  while (rest) {
    let best = null;
    for (const spec of INLINE) {
      const match = spec.re.exec(rest);
      if (match && (!best || match.index < best.match.index)) best = { spec, match };
    }
    if (!best) {
      nodes.push(rest);
      break;
    }
    if (best.match.index > 0) nodes.push(rest.slice(0, best.match.index));
    nodes.push(best.spec.node(best.match));
    rest = rest.slice(best.match.index + best.match[0].length);
  }
  return nodes;
}

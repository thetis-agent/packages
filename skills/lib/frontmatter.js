// A hand parser for the YAML subset a SKILL.md frontmatter may use. It reads `key: value` lines, one nested
// block of `key: value` lines under a top-level key (two-space indent), `[a, b]` lists, `- item` lists, and
// quoted strings. Anything else is refused with an error rather than guessed at: a block scalar, an anchor,
// a flow map, a multi-line plain scalar. Values come back as strings or lists of strings; the caller
// coerces. Deliberately not a YAML library: the format is small, and a dependency would be the first.

const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/;

/** Parses frontmatter text (without the `---` fences). Returns `{ data, errors }`. */
export function parseFrontmatter(text) {
  const errors = [];
  const data = {};
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  const fail = (n, message) => errors.push(`frontmatter line ${n + 1}: ${message}`);
  const isBlank = (line) => !line.trim() || line.trim().startsWith("#");
  const indentOf = (line) => line.length - line.trimStart().length;

  // Reads the `- item` lines that follow a bare key, all at one indent deeper than `indent`.
  const readList = (indent) => {
    const items = [];
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        i++;
        continue;
      }
      const ind = indentOf(line);
      if (ind <= indent) break;
      const body = line.trim();
      if (!body.startsWith("- ")) {
        fail(i, `expected a "- item" line in the list`);
        return null;
      }
      const item = scalar(body.slice(2).trim(), i);
      if (item === undefined) return null;
      if (Array.isArray(item)) {
        fail(i, "a list inside a list is not supported");
        return null;
      }
      items.push(item);
      i++;
    }
    return items;
  };

  // One scalar or inline list. Returns a string, an array, or undefined after an error.
  const scalar = (raw, n) => {
    const value = raw.trim();
    if (value === "") return "";
    const first = value[0];
    if (first === '"') return dquote(value, n);
    if (first === "'") return squote(value, n);
    if (first === "[") return inlineList(value, n);
    if (first === ">" || first === "|") {
      fail(n, "block scalars (> and |) are not supported; put the value on one line, quoted if it is long");
      return undefined;
    }
    if (first === "&" || first === "*" || first === "!" || first === "{" || first === "%" || first === "@" || first === "`") {
      fail(n, `values starting with "${first}" are not supported`);
      return undefined;
    }
    // A plain scalar. A comment starts at " #".
    const hash = value.search(/\s#/);
    return (hash >= 0 ? value.slice(0, hash) : value).trim();
  };

  const dquote = (value, n) => {
    if (value.length < 2 || !value.endsWith('"')) {
      fail(n, "a double-quoted value must end on the same line");
      return undefined;
    }
    try {
      return JSON.parse(value);
    } catch {
      fail(n, "the double-quoted value has an escape JSON would not accept");
      return undefined;
    }
  };

  const squote = (value, n) => {
    if (value.length < 2 || !value.endsWith("'")) {
      fail(n, "a single-quoted value must end on the same line");
      return undefined;
    }
    const inner = value.slice(1, -1);
    if (/(^|[^'])'([^']|$)/.test(inner)) {
      fail(n, "a single quote inside a single-quoted value is written as ''");
      return undefined;
    }
    return inner.replace(/''/g, "'");
  };

  const inlineList = (value, n) => {
    if (!value.endsWith("]")) {
      fail(n, "an inline list must close on the same line");
      return undefined;
    }
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    const items = [];
    for (const part of splitCommas(inner)) {
      const item = part.trim();
      if (item.startsWith("[")) {
        fail(n, "a list inside an inline list is not supported");
        return undefined;
      }
      const v = scalar(item, n);
      if (v === undefined) return undefined;
      items.push(v);
    }
    return items;
  };

  // Reads `key: value` lines at `indent`; with `allowNested`, a bare key may open a map one level deeper.
  const readMap = (indent, allowNested, into) => {
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        i++;
        continue;
      }
      const ind = indentOf(line);
      if (ind < indent) return true;
      if (ind > indent) {
        fail(i, "unexpected indentation; a value that spans lines must be quoted on one line");
        return false;
      }
      const m = KEY.exec(line.trim());
      if (!m) {
        fail(i, `expected "key: value", got ${JSON.stringify(line.trim()).slice(0, 60)}`);
        return false;
      }
      const [, key, rawValue] = m;
      if (key in into) fail(i, `the key "${key}" appears twice`);
      i++;
      if (rawValue !== undefined && rawValue.trim() !== "") {
        const v = scalar(rawValue, i - 1);
        if (v === undefined) return false;
        into[key] = v;
        continue;
      }
      // A bare key: a list, a nested map, or an empty value.
      let j = i;
      while (j < lines.length && isBlank(lines[j])) j++;
      const next = lines[j];
      if (next === undefined || indentOf(next) <= indent) {
        into[key] = "";
        continue;
      }
      if (next.trim().startsWith("- ")) {
        const items = readList(indent);
        if (items === null) return false;
        into[key] = items;
        continue;
      }
      if (!allowNested) {
        fail(j, "maps nested more than one level deep are not supported");
        return false;
      }
      const nested = {};
      i = j;
      if (!readMap(indentOf(next), false, nested)) return false;
      into[key] = nested;
    }
    return true;
  };

  readMap(0, true, data);
  return { data, errors };
}

/** Splits on commas that are outside quotes. */
function splitCommas(text) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && k + 1 < text.length) cur += text[++k];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Splits a SKILL.md into its frontmatter text and its body. `frontmatter` is null when the file has none. */
export function splitDocument(text) {
  const src = String(text ?? "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) return { frontmatter: null, body: src };
  const end = src.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: null, body: src };
  const after = src.slice(end + 4);
  if (after !== "" && !after.startsWith("\n") && !/^[ \t]*\n/.test(after)) return { frontmatter: null, body: src };
  const rest = after.replace(/^[ \t]*\n/, "");
  return { frontmatter: src.slice(4, end), body: rest };
}

/** A YAML value for a string that this parser reads back unchanged: plain when safe, JSON-quoted otherwise. */
export function yamlString(value) {
  const s = String(value ?? "");
  if (s !== "" && /^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/.test(s) && !/\s#/.test(s) && !/\s$/.test(s)) return s;
  return JSON.stringify(s);
}

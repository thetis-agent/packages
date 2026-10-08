/* Delimited text in and out: CSV and TSV as spreadsheets write them (RFC 4180 quoting, CRLF or LF line
 * ends, a byte-order mark dropped). When the delimiter is not given it is sniffed from the first lines:
 * the one of comma, tab and semicolon that splits them most consistently. */

const CANDIDATES = [",", "\t", ";"];

function sniff(text) {
  const lines = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length && lines.length < 10; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === "\n" || ch === "\r")) {
      if (cur) lines.push(cur);
      cur = "";
      continue;
    }
    if (!quoted) cur += ch;
  }
  if (cur && lines.length < 10) lines.push(cur);
  let best = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => l.split(d).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    const same = counts.filter((c) => c === counts[0]).length;
    const score = (same / counts.length) * 1000 + counts[0];
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** The rows of a delimited text, each an array of strings. */
export function parseDelimited(text, { delimiter } = {}) {
  let s = String(text ?? "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (!s) return [];
  const d = delimiter || sniff(s);
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let quoted = false;
  let wasQuoted = false;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      i++;
      continue;
    }
    if (ch === d) {
      row.push(field);
      field = "";
      wasQuoted = false;
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      wasQuoted = false;
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || wasQuoted || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Rows of values as delimited text: fields quoted where they hold the delimiter, a quote or a line end;
 * every line ends with CRLF. */
export function toDelimited(rows, delimiter = ",") {
  let out = "";
  for (const row of rows) {
    out +=
      row
        .map((v) => {
          const s = v === null || v === undefined ? "" : String(v);
          return s.includes(delimiter) || s.includes('"') || s.includes("\n") || s.includes("\r") ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(delimiter) + "\r\n";
  }
  return out;
}

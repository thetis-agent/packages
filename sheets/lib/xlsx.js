// A whole workbook as an .xlsx file, the one format Google Sheets, Excel and LibreOffice all open with
// formulas, values and formatting intact: every tab, each cell's formula (in Excel's spelling) with the
// value it computed here, number formats, bold/italic/underline/strike, text and fill colours, alignment,
// wrapping, column widths, row heights and frozen panes. A spreadsheet program recomputes on open, so the
// cached values only matter until it does. Written by hand — a stored zip of a few SpreadsheetML parts —
// so the package keeps its one dependency.
//
// What changes on the way out, and is reported in `notes`: a tab name longer than Excel's 31 characters is
// shortened (and formulas pointing at it follow); a formula that does not parse is written as its text;
// #CYCLE! and #ERROR!, which only this engine has, become #REF! and #VALUE!.
import { deflateRawSync } from "node:zlib";
import { addr, colIndex, colName, quoteTab } from "../ui/core/address.js";
import { compute } from "../ui/core/engine.js";
import { parse, tokenize } from "../ui/core/formula.js";
import { isError } from "../ui/core/values.js";
import { DEFAULTS, usedRange } from "../ui/core/workbook.js";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const EXCEL_TAB_CHARS = 31;

// Functions Excel files spell with the _xlfn. prefix: the ones added after Excel 2007. Without it Excel
// shows #NAME? until the cell is edited; Google Sheets and LibreOffice read both spellings.
const XLFN = new Set(["CONCAT", "DAYS", "IFNA", "IFS", "MAXIFS", "MINIFS", "SWITCH", "TEXTJOIN", "XLOOKUP", "XOR"]);
const ERRORS = { "#CYCLE!": "#REF!", "#ERROR!": "#VALUE!" };
const EXCEL_ERRORS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"]);

// ---- zip (stored entries' bodies deflated, no zip64: a workbook is at most 16 MB of JSON) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) && date.getFullYear() >= 1980 ? date : new Date(1980, 0, 1);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A zip archive of `[name, text | Buffer]` entries, each deflated. */
export function zip(entries, when = new Date()) {
  const { time, date } = dosTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const body = deflateRawSync(raw, { level: 6 });
    const fileName = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, body);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// ---- SpreadsheetML ----

// eslint-disable-next-line no-control-regex
const BAD_XML = /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g;
const esc = (s) => String(s).replace(BAD_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Tab names Excel accepts: at most 31 characters, unique without regard to case. Answers a Map id → name. */
function excelNames(tabs) {
  const out = new Map();
  const taken = new Set();
  for (const t of tabs) {
    let name = t.name;
    if (name.length > EXCEL_TAB_CHARS || taken.has(name.toLowerCase())) {
      const base = name.slice(0, EXCEL_TAB_CHARS).trim();
      name = base;
      for (let n = 2; taken.has(name.toLowerCase()) || !name; n++) name = `${base.slice(0, EXCEL_TAB_CHARS - String(n).length - 1).trim()} ${n}`;
    }
    taken.add(name.toLowerCase());
    out.set(t.id, name);
  }
  return out;
}

/**
 * A formula (with its `=`) as an Excel file holds it: without the `=`, functions in capitals with the
 * _xlfn. prefix where Excel wants one, references in capitals and pointing at the tabs' Excel names, and
 * this engine's own error codes replaced. Null when the formula does not parse.
 */
export function excelFormula(formula, renamed = new Map()) {
  const src = formula.slice(1);
  let toks;
  try {
    parse(src);
    toks = tokenize(src);
  } catch {
    return null;
  }
  let out = "";
  let at = 0;
  for (const t of toks) {
    let next = null;
    if (t.type === "func") next = (XLFN.has(t.name) ? "_xlfn." : "") + t.name;
    else if (t.type === "bool") next = t.value ? "TRUE" : "FALSE";
    else if (t.type === "err") next = ERRORS[t.value] ?? t.value;
    else if (t.type === "ref") {
      const tab = t.tab === null ? "" : `${quoteTab(renamed.get(t.tab.toLowerCase()) ?? t.tab)}!`;
      next = tab + src.slice(t.prefixEnd, t.end).toUpperCase();
    }
    if (next === null) continue;
    out += src.slice(at, t.start) + next;
    at = t.end;
  }
  return out + src.slice(at);
}

/** The cell formats in use, deduplicated, as styles.xml and a function from a cell's style to its xf index. */
function styleBook() {
  const numFmts = new Map(); // pattern → id
  const fonts = ['<font><sz val="10"/><name val="Arial"/><family val="2"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const fontIx = new Map([[fonts[0], 0]]);
  const fillIx = new Map();
  const xfIx = new Map([[xfs[0], 0]]);
  const argb = (hex) => `FF${String(hex).replace("#", "").toUpperCase()}`;
  const intern = (list, ix, xml) => {
    if (!ix.has(xml)) {
      ix.set(xml, list.length);
      list.push(xml);
    }
    return ix.get(xml);
  };

  function xfOf(style, quoted) {
    if (!style && !quoted) return 0;
    const s = style ?? {};
    let numFmtId = 0;
    if (s.fmt === "@") numFmtId = 49;
    else if (s.fmt) {
      if (!numFmts.has(s.fmt)) numFmts.set(s.fmt, 164 + numFmts.size);
      numFmtId = numFmts.get(s.fmt);
    }
    const fontId =
      s.b || s.i || s.u || s.s || s.color
        ? intern(fonts, fontIx, `<font>${s.b ? "<b/>" : ""}${s.i ? "<i/>" : ""}${s.s ? "<strike/>" : ""}${s.u ? "<u/>" : ""}<sz val="10"/>${s.color ? `<color rgb="${argb(s.color)}"/>` : ""}<name val="Arial"/><family val="2"/></font>`)
        : 0;
    const fillId = s.fill ? intern(fills, fillIx, `<fill><patternFill patternType="solid"><fgColor rgb="${argb(s.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const align = s.align || s.wrap ? `<alignment${s.align ? ` horizontal="${s.align}"` : ""}${s.wrap ? ' wrapText="1"' : ""}/>` : "";
    const attrs = `numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ""}${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${align ? ' applyAlignment="1"' : ""}${quoted ? ' quotePrefix="1"' : ""}`;
    return intern(xfs, xfIx, align ? `<xf ${attrs}>${align}</xf>` : `<xf ${attrs}/>`);
  }

  function xml() {
    const fmts = numFmts.size ? `<numFmts count="${numFmts.size}">${[...numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join("")}</numFmts>` : "";
    return (
      XML +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${fmts}` +
      `<fonts count="${fonts.length}">${fonts.join("")}</fonts>` +
      `<fills count="${fills.length}">${fills.join("")}</fills>` +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>"
    );
  }
  return { xfOf, xml };
}

// Excel measures a column in widths of the default font's widest digit (7 px for Arial 10) and a row in points.
const colWidth = (px) => Math.round((px / 7) * 256) / 256;
const rowHeight = (px) => Math.round(px * 0.75 * 100) / 100;

function sheetXml(tab, { engine, strings, styles, renamed, notes }) {
  const used = usedRange(tab);
  const rows = new Map(); // row index → [xml of cells]
  const cellXml = (r, c, xml) => {
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r).push([c, xml]);
  };
  let formulas = 0;
  const keys = new Set([...Object.keys(tab.cells), ...Object.keys(tab.styles ?? {})]);
  for (const at of keys) {
    const m = /^([A-Z]+)([0-9]+)$/.exec(at);
    if (!m) continue;
    const r = Number(m[2]) - 1;
    const c = colIndex(m[1]);
    const raw = tab.cells[at];
    const style = tab.styles?.[at] ?? null;
    const quoted = typeof raw === "string" && raw[0] === "'";
    const s = styles.xfOf(style, quoted);
    const sAttr = s ? ` s="${s}"` : "";
    if (raw === undefined || raw === null || raw === "") {
      if (s) cellXml(r, c, `<c r="${at}"${sAttr}/>`);
      continue;
    }
    if (typeof raw === "number") cellXml(r, c, `<c r="${at}"${sAttr}><v>${raw}</v></c>`);
    else if (typeof raw === "boolean") cellXml(r, c, `<c r="${at}"${sAttr} t="b"><v>${raw ? 1 : 0}</v></c>`);
    else if (raw[0] === "=") {
      const f = excelFormula(raw, renamed);
      if (f === null) {
        notes.unparsed.push(`${tab.name}!${at}`);
        cellXml(r, c, `<c r="${at}"${sAttr} t="s"><v>${strings.of(raw)}</v></c>`);
        continue;
      }
      formulas++;
      const v = engine.value(tab.id, at);
      let cached = "";
      if (typeof v === "number" && Number.isFinite(v)) cached = `><f>${esc(f)}</f><v>${v}</v>`;
      else if (typeof v === "string") cached = ` t="str"><f>${esc(f)}</f><v>${esc(v)}</v>`;
      else if (typeof v === "boolean") cached = ` t="b"><f>${esc(f)}</f><v>${v ? 1 : 0}</v>`;
      else if (isError(v)) {
        const code = ERRORS[v.err] ?? v.err;
        cached = ` t="e"><f>${esc(f)}</f><v>${EXCEL_ERRORS.has(code) ? code : "#VALUE!"}</v>`;
      } else cached = `><f>${esc(f)}</f>`;
      cellXml(r, c, `<c r="${at}"${sAttr}${cached}</c>`);
    } else cellXml(r, c, `<c r="${at}"${sAttr} t="s"><v>${strings.of(quoted ? raw.slice(1) : raw)}</v></c>`);
  }
  for (const key of Object.keys(tab.heights ?? {})) {
    const r = Number(key) - 1;
    if (Number.isInteger(r) && r >= 0 && !rows.has(r)) rows.set(r, []);
  }

  const sheetRows = [...rows.keys()]
    .sort((a, b) => a - b)
    .map((r) => {
      const px = tab.heights?.[String(r + 1)];
      const ht = px ? ` ht="${rowHeight(px)}" customHeight="1"` : "";
      const cells = rows.get(r).sort((a, b) => a[0] - b[0]).map(([, x]) => x).join("");
      return cells ? `<row r="${r + 1}"${ht}>${cells}</row>` : `<row r="${r + 1}"${ht}/>`;
    })
    .join("");

  // Every column of the tab gets its width, the default ones too: Excel's default is narrower than this grid's.
  const lastCol = Math.max(tab.cols ?? DEFAULTS.cols, used ? used.c2 + 1 : 0) - 1;
  const cols = [];
  for (let c = 0; c <= lastCol; c++) {
    const px = tab.widths?.[colName(c)] ?? DEFAULTS.width;
    const prev = cols[cols.length - 1];
    if (prev && prev.px === px) prev.max = c + 1;
    else cols.push({ min: c + 1, max: c + 1, px });
  }
  const colsXml = cols.length ? `<cols>${cols.map((k) => `<col min="${k.min}" max="${k.max}" width="${colWidth(k.px)}" customWidth="1"/>`).join("")}</cols>` : "";

  const fr = tab.freeze?.rows ?? 0;
  const fc = tab.freeze?.cols ?? 0;
  let pane = "";
  if (fr || fc) {
    const active = fr && fc ? "bottomRight" : fr ? "bottomLeft" : "topRight";
    pane = `<pane${fc ? ` xSplit="${fc}"` : ""}${fr ? ` ySplit="${fr}"` : ""} topLeftCell="${addr(fr, fc)}" activePane="${active}" state="frozen"/><selection pane="${active}"/>`;
  }
  const dim = used ? `<dimension ref="A1:${addr(used.r2, used.c2)}"/>` : '<dimension ref="A1"/>';
  const xml =
    XML +
    `<worksheet ${NS}>${dim}<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="${rowHeight(DEFAULTS.height)}" customHeight="1"/>${colsXml}` +
    `<sheetData>${sheetRows}</sheetData></worksheet>`;
  return { xml, formulas };
}

/**
 * The workbook as an .xlsx file: `{ body, tabs, cells, formulas, notes }` — the bytes, counts for the
 * answer, and `notes`, the sentences saying what had to change on the way out (empty when nothing did).
 */
export function workbookXlsx(workbook, { now = new Date() } = {}) {
  const engine = compute(workbook, { now });
  const names = excelNames(workbook.tabs);
  const renamed = new Map();
  for (const t of workbook.tabs) if (names.get(t.id) !== t.name) renamed.set(t.name.toLowerCase(), names.get(t.id));
  const shared = [];
  const sharedIx = new Map();
  const strings = {
    of(text) {
      if (!sharedIx.has(text)) {
        sharedIx.set(text, shared.length);
        shared.push(text);
      }
      return sharedIx.get(text);
    },
  };
  const styles = styleBook();
  const notes = { unparsed: [] };
  let formulas = 0;
  let cells = 0;
  const sheets = workbook.tabs.map((tab, i) => {
    const out = sheetXml(tab, { engine, strings, styles, renamed, notes });
    formulas += out.formulas;
    cells += Object.keys(tab.cells).length;
    return [`xl/worksheets/sheet${i + 1}.xml`, out.xml];
  });

  const sst =
    XML +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((t) => `<si><t${/^\s|\s$|\n/.test(t) ? ' xml:space="preserve"' : ""}>${esc(t)}</t></si>`).join("") +
    "</sst>";
  const book =
    XML +
    `<workbook ${NS}><bookViews><workbookView activeTab="0"/></bookViews><sheets>` +
    workbook.tabs.map((t, i) => `<sheet name="${esc(names.get(t.id))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
  const n = workbook.tabs.length;
  const bookRels =
    XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    workbook.tabs.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    "</Relationships>";
  const rels =
    XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    "</Relationships>";
  const stamp = new Date(workbook.updatedAt ?? now);
  const iso = (Number.isNaN(stamp.getTime()) ? now : stamp).toISOString().replace(/\.\d+Z$/, "Z");
  const core =
    XML +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(workbook.title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
    "</cp:coreProperties>";
  const types =
    XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    workbook.tabs.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    "</Types>";

  const body = zip(
    [
      ["[Content_Types].xml", types],
      ["_rels/.rels", rels],
      ["docProps/core.xml", core],
      ["xl/workbook.xml", book],
      ["xl/_rels/workbook.xml.rels", bookRels],
      ["xl/styles.xml", styles.xml()],
      ["xl/sharedStrings.xml", sst],
      ...sheets,
    ],
    now,
  );

  const said = [];
  const shortened = workbook.tabs.filter((t) => names.get(t.id) !== t.name);
  if (shortened.length) said.push(`Excel allows tab names of at most 31 characters, so ${shortened.map((t) => `${JSON.stringify(t.name)} is ${JSON.stringify(names.get(t.id))}`).join(", ")} in the file, and the formulas pointing at it follow.`);
  if (notes.unparsed.length) {
    const list = notes.unparsed.length > 12 ? `${notes.unparsed.slice(0, 12).join(", ")} and ${notes.unparsed.length - 12} more` : notes.unparsed.join(", ");
    said.push(`${list} hold${notes.unparsed.length === 1 ? "s" : ""} a formula that does not parse, written as text.`);
  }
  return { body, tabs: workbook.tabs.length, cells, formulas, notes: said };
}

// The picture of a package view: the "Compared" columns of one suite as grouped horizontal bars, one group
// per metric and one bar per arm, written beside report.json as `chart.svg`. It is derived from the view
// alone — no clock, no generated ids — so that two runs over the same numbers write the same bytes, which is
// the rule every committed bench artifact lives under. Self-contained, so it renders inside an <img> on
// GitHub and on a marketplace page alike.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SHARED } from "./score.js";
import { assertWritable, columnsOf, fmt, slugOf, type PackageView, type WriteResult } from "./report.js";

export const CHART_WIDTH = 720;
/** This package's own arm. */
const SELF = "#7c9cff";
/** Every other arm. */
const OTHER = "#6e6e82";

const LABEL_W = 176;
const VALUE_W = 138;
const ROW_H = 16;
const BAR_H = 10;
const GROUP_HEAD_H = 20;
const GROUP_GAP = 10;
const TOP = 54;
const BOTTOM = 10;
const PAD_X = 16;
const BAR_X = PAD_X + LABEL_W;
const BAR_MAX_W = CHART_WIDTH - BAR_X - VALUE_W - PAD_X;

const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A number in the picture is rounded the way the table rounds it; the two must agree. */
const px = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * The bars for one view. Each metric is normalised to the largest mean in its column, so a bar is a share of
 * the worst arm and the raw mean is printed at its end with the half-width beside it; the two are not
 * substitutes and both are shown. The floor is hatched, this package is the accent, every peer is grey.
 */
export function renderChart(view: PackageView): string {
  const r = view.report;
  const arms = view.arms;
  const self = arms[1] ?? "";
  const floor = r.inputs.floor;
  const metrics = columnsOf(r.shared, SHARED, arms);
  const groupH = GROUP_HEAD_H + arms.length * ROW_H + GROUP_GAP;
  const height = TOP + Math.max(metrics.length, 1) * groupH + BOTTOM;
  const digest = view.suiteDigest.slice(0, 19);
  const title = `${view.package} on ${view.suite}`;
  const desc = metrics.length
    ? `Grouped bars, one group per compared metric (${metrics.join(", ")}) and one bar per arm (${arms.join(", ")}), each metric scaled to the largest mean in its column. ${self} is this package; ${floor} is the floor.`
    : "No metric differed between the arms, so there is nothing to draw.";

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_WIDTH}" height="${height}" viewBox="0 0 ${CHART_WIDTH} ${height}" role="img" aria-labelledby="t d" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">`);
  out.push(`<title id="t">${esc(title)}</title>`);
  out.push(`<desc id="d">${esc(desc)}</desc>`);
  out.push(
    `<style>.t{fill:#3a3a48}.f{fill:#8b8b9e}@media (prefers-color-scheme:dark){.t{fill:#d2d2dc}.f{fill:#9a9aae}}</style>`,
    `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${OTHER}" fill-opacity="0.22"/><line x1="0" y1="0" x2="0" y2="6" stroke="${OTHER}" stroke-width="2"/></pattern></defs>`,
  );
  out.push(`<text class="t" x="${PAD_X}" y="20" font-size="14" font-weight="600">${esc(title)}</text>`);
  out.push(
    `<text class="f" x="${PAD_X}" y="38" font-size="11">${esc(view.suite)} · ${esc(digest)}… · ${r.inputs.suite.tasks} tasks · each bar is a share of its metric's largest mean · mean ±half-width</text>`,
  );

  // The legend: three swatches, drawn once. The floor and this package are named; peers are the rest.
  const legend: [string, string][] = [
    [floor, `url(#hatch)`],
    [self, SELF],
    ["peers", OTHER],
  ];
  let lx = CHART_WIDTH - PAD_X;
  for (const [name, fill] of legend.reverse()) {
    const w = name.length * 6.6 + 18;
    lx -= w;
    out.push(`<rect x="${px(lx)}" y="11" width="10" height="10" rx="2" fill="${fill}"/>`);
    out.push(`<text class="f" x="${px(lx + 14)}" y="20" font-size="11">${esc(name)}</text>`);
    lx -= 10;
  }

  let y = TOP;
  for (const metric of metrics) {
    const means = arms.map((a) => r.shared[a]?.[metric]?.mean ?? 0);
    const max = Math.max(...means, 0);
    out.push(`<text class="t" x="${PAD_X}" y="${px(y + 12)}" font-size="12" font-weight="600">${esc(metric)}</text>`);
    out.push(`<line x1="${BAR_X}" y1="${px(y + GROUP_HEAD_H - 4)}" x2="${BAR_X + BAR_MAX_W}" y2="${px(y + GROUP_HEAD_H - 4)}" stroke="${OTHER}" stroke-opacity="0.35" stroke-width="1"/>`);
    let ry = y + GROUP_HEAD_H;
    for (const arm of arms) {
      const value = r.shared[arm]?.[metric];
      const w = value && max > 0 ? (value.mean / max) * BAR_MAX_W : 0;
      const fill = arm === floor ? "url(#hatch)" : arm === self ? SELF : OTHER;
      const weight = arm === self ? ' font-weight="600"' : "";
      out.push(`<text class="t" x="${px(BAR_X - 8)}" y="${px(ry + 12)}" font-size="11" text-anchor="end"${weight}>${esc(arm)}</text>`);
      out.push(`<rect x="${BAR_X}" y="${px(ry + (ROW_H - BAR_H) / 2)}" width="${px(w)}" height="${BAR_H}" rx="2" fill="${fill}"/>`);
      if (value) {
        out.push(
          `<text class="t" x="${px(BAR_X + w + 6)}" y="${px(ry + 12)}" font-size="11">${esc(fmt(value.mean))}<tspan class="f" font-size="9"> ±${esc(fmt(value.mde))}</tspan></text>`,
        );
      } else {
        out.push(`<text class="f" x="${px(BAR_X + 6)}" y="${px(ry + 12)}" font-size="11">—</text>`);
      }
      ry += ROW_H;
    }
    y += groupH;
  }
  if (!metrics.length) out.push(`<text class="f" x="${PAD_X}" y="${px(TOP + 12)}" font-size="12">${esc(desc)}</text>`);
  out.push("</svg>");
  return `${out.join("\n")}\n`;
}

/**
 * Written beside the view it draws. The body carries no clock, so identity is the bytes: a chart is
 * rewritten when its numbers or its digest moved, or when `force` says so, and never otherwise.
 */
export function writeChart(packageDir: string, view: PackageView, reportDir = "bench", force = false): WriteResult {
  const path = join(packageDir, reportDir, slugOf(view.suite), "chart.svg");
  assertWritable(path);
  const body = renderChart(view);
  if (!force && existsSync(path) && readFileSync(path, "utf8") === body) return { path, written: false, reason: "unchanged" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return { path, written: true, reason: force ? "forced" : "inputs changed" };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderChart, writeChart, CHART_WIDTH } from "../src/chart.js";
import { buildReport, renderMarkdown, viewFor, type ReportInputs } from "../src/report.js";
import type { ArmScore } from "../src/score.js";
import { bootstrap, paired, seedOf } from "../src/metrics/stats.js";

const inputs: ReportInputs = {
  probe: "A",
  suite: { id: "tools@1", version: "1.0.0", sha256: "sha256:aaa", tasks: 4, controls: 1 },
  arms: [
    { id: "none", packages: [] },
    { id: "self", packages: ["@a/x@1.0.0"] },
    { id: "peer", packages: ["@b/y@2.0.0"] },
  ],
  floor: "none",
  scorer: "@thetis/bench@0.1.0",
  seed: seedOf(["tools@1"]),
  model: null,
  sandbox: "none",
};

const armScore = (arm: string, bytes: number, tools: number): ArmScore => ({
  arm,
  tasks: 4,
  absolute: {
    bytes_tools: bootstrap([bytes, bytes + 10, bytes - 10, bytes], seedOf([arm, "b"])),
    tools_n: bootstrap([tools, tools, tools, tools], seedOf([arm, "t"])),
    // The same on every arm: not a comparison, so not a column and not a group of bars.
    steps_n: bootstrap([3, 3, 3, 3], seedOf([arm, "s"])),
  },
  delta: arm === "none" ? {} : { bytes_tools: paired([bytes, bytes, bytes, bytes], [0, 0, 0, 0], seedOf([arm, "d"])) },
  perArm: {},
  conformance: { adapterLies: [], adapterModest: [], offeredUnverified: [], errors: [] },
});

const report = () => buildReport([armScore("none", 0, 0), armScore("self", 500, 6), armScore("peer", 900, 10)], inputs, { none: 1, self: 1.2, peer: 1.4 });
const view = () => viewFor(report(), "@a/x", "self", "tools", ["peer"]);

test("the chart is the same bytes for the same view, whatever the clock says", () => {
  const one = renderChart(view());
  const two = renderChart({ ...view(), generatedAt: "later", report: { ...view().report, generatedAt: "later" } });
  assert.equal(one, two);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(one), "no timestamp in the picture");
});

test("every arm and every compared metric is named in the picture, and a constant column is not", () => {
  const svg = renderChart(view());
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="720"/);
  assert.equal(CHART_WIDTH, 720);
  for (const arm of ["none", "self", "peer"]) assert.ok(svg.includes(`>${arm}</text>`), `arm ${arm} is labelled`);
  for (const metric of ["bytes_tools", "tools_n"]) assert.ok(svg.includes(`>${metric}</text>`), `metric ${metric} is a group`);
  assert.ok(!svg.includes(">steps_n<"), "a column of one repeated value is not drawn");
  assert.match(svg, /<title id="t">@a\/x on tools@1<\/title>/);
  assert.match(svg, /<desc id="d">/);
  assert.match(svg, /fill="#7c9cff"/, "this package's arm is the accent");
  assert.match(svg, /url\(#hatch\)/, "the floor is hatched");
  assert.ok(!/href=|<script|<image/.test(svg), "self-contained: nothing external, nothing that runs");
});

test("the chart is written once beside the view, left alone after, and forced on demand", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-chart-"));
  try {
    const first = writeChart(dir, view());
    assert.equal(first.written, true);
    assert.equal(first.path, join(dir, "bench", "tools-v1", "chart.svg"));
    assert.equal(readFileSync(first.path, "utf8"), renderChart(view()));
    assert.equal(writeChart(dir, view()).written, false);
    assert.equal(writeChart(dir, view(), "bench", true).reason, "forced");
    const moved = viewFor(buildReport([armScore("none", 0, 0), armScore("self", 700, 6), armScore("peer", 900, 10)], inputs, {}), "@a/x", "self", "tools", ["peer"]);
    assert.equal(writeChart(dir, moved).written, true, "new numbers are a new picture");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the page refers to the chart by a plain relative path beside the view", () => {
  const md = renderMarkdown([view()]);
  assert.match(md, /!\[tools@1 comparison\]\(bench\/tools-v1\/chart\.svg\)/);
  assert.match(renderMarkdown([view()], "reports"), /\(reports\/tools-v1\/chart\.svg\)/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PackageInfo, ToolEnv } from "@thetis/contracts";
import { listPackages } from "../src/index.js";

const installed = [
  { name: "@thetis/harness-core", version: "0.1.0", type: "loader", description: "The default harness.", thetis: { type: "loader", steps: [{ id: "system-prompt", phase: "prompt", export: "systemPrompt" }, { id: "corpus", phase: "bench", export: "corpus" }] } },
  { name: "@thetis/tools-files", version: "0.2.0", type: "tool", description: "File tools.", thetis: { type: "tool", tools: [{ name: "read_path" }, { name: "edit_path" }], bench: { suites: ["tool-recall@1"] } } },
  { name: "@alice/tools-files", version: "0.2.0-fork.1", type: "tool", description: "", thetis: { type: "tool", tools: [{ name: "read_path" }], service: { export: "serve" } }, forkedFrom: { name: "@thetis/tools-files", version: "0.2.0" } },
] as unknown as PackageInfo[];

const envWith = (packages: PackageInfo[]) => ({ kernel: { packages: { list: async () => packages } } }) as unknown as ToolEnv;

test("list_packages writes one line per package with its steps, tools, bench suites, service and fork, and leaves the bench phase out", async () => {
  const out = await listPackages({}, envWith(installed));
  assert.equal(
    out,
    [
      "3 packages installed in your userspace:",
      "- @thetis/harness-core@0.1.0 (loader): The default harness. steps[prompt:systemPrompt]",
      "- @thetis/tools-files@0.2.0 (tool): File tools. tools[read_path, edit_path] bench[tool-recall@1]",
      "- @alice/tools-files@0.2.0-fork.1 (tool) tools[read_path] service fork of @thetis/tools-files@0.2.0",
    ].join("\n"),
  );
});

test("type narrows the list, and an empty list says so", async () => {
  assert.match(String(await listPackages({ type: "loader" }, envWith(installed))), /^1 loader package installed[^]*harness-core[^]*$/);
  assert.doesNotMatch(String(await listPackages({ type: "loader" }, envWith(installed))), /tools-files/);
  assert.equal(await listPackages({ type: "provider" }, envWith(installed)), "no provider packages are installed in your userspace");
  assert.equal(await listPackages({}, envWith([])), "no packages are installed in your userspace");
});

test("a copy the open fence read at an older version says so: the version on the line is the one on disk", async () => {
  const stale = [{ ...installed[1], version: "0.2.2", loadedVersion: "0.2.1" }] as unknown as PackageInfo[];
  assert.match(
    String(await listPackages({}, envWith(stale))),
    /- @thetis\/tools-files@0\.2\.2 \(tool\).*\(loaded 0\.2\.1, 0\.2\.2 on disk: a workspace reload applies it\)$/,
  );
  const current = [{ ...installed[1], loadedVersion: "0.2.0" }] as unknown as PackageInfo[];
  assert.doesNotMatch(String(await listPackages({}, envWith(current))), /loaded/, "what the fence read is what is on disk");
});

// A stand-in for lib/inner.js that speaks its protocol without namespaces or a kernel: what it does is
// scripted by argv[3], per run (`base-1`, ...) or by `default`.
//   leak: true          the sentinel it reports exists outside (it creates it)
//   costs: [n, ...]     progress lines, cumulative cost, one every 20 ms
//   hang: true          after the costs, wait for a cancel
//   ignoreCancel: true  and ignore it too (the outer has to kill it)
//   end: "done"|...     the state it ends with (default done)
//   files: {path: text} files it hands over
//   failIsolation: "…"  fail before isolating
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const all = JSON.parse(process.argv[3] ?? "{}");
const script = all[`${spec.arm}-${spec.n}`] ?? all.default ?? {};
const out = (msg) => process.stdout.write("@@trial " + JSON.stringify(msg) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

writeFileSync(resolve(spec.ns, "..", `${spec.arm}-${spec.n}.seen.json`), JSON.stringify(spec));
if (script.failIsolation) {
  out({ type: "fail", error: script.failIsolation, isolation: true });
  process.exit(1);
}
const sentinel = resolve(spec.ns, ".thetis-trial-sentinel-0123456789ab");
if (script.leak) writeFileSync(sentinel, "leaked\n");
let cancel = null;
let go;
const ready = new Promise((r) => (go = r));
createInterface({ input: process.stdin }).on("line", (text) => {
  const msg = JSON.parse(text);
  if (msg.go) go(true);
  if (msg.cancel) cancel = msg.cancel;
});
console.log("a stray line on stdout");
out({ type: "isolated", overlays: [spec.home], masked: [], docker: [{ path: "/run/docker.sock", blocked: true }], sentinels: [sentinel] });
await ready;
out({ type: "session", id: `s_${spec.arm === "base" ? "0a" : "0b"}${spec.n}` });
let cost = 0;
for (const c of script.costs ?? []) {
  cost = c;
  out({ type: "progress", costUsd: c, tokens: Math.round(c * 1000) });
  await sleep(20);
  if (cancel && !script.ignoreCancel) break;
}
if (script.hang) while (!cancel || script.ignoreCancel) await sleep(20);
for (const [path, content] of Object.entries(script.files ?? {})) out({ type: "file", path, content });
out({ type: "end", state: cancel ?? script.end ?? "done", costUsd: cost, tokens: Math.round(cost * 1000) });
process.exit(0);

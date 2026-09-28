// Smoke test: every tool against a local page, plus the pure helpers. Needs a Chrome on the host.
// Run: node test.smoke.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, stat, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as m from "./index.js";
import { hostMatches, isPrivateAddress, settings, closeAll, safeName } from "./lib/core.js";
import { normaliseUrl, toFunction, trimSnapshot } from "./lib/ops.js";

let failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n").join("\n     ")}`); }
};

const PAGE = `<!doctype html><html><head><title>Smoke</title></head><body>
<h1>Smoke page</h1>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Hello ' + document.getElementById('name').value + ' ' + document.getElementById('color').value + (document.getElementById('agree').checked ? ' agreed' : '');">
  <label>Name <input id="name" name="name"></label>
  <label>Colour <select id="color"><option value="red">Red</option><option value="blue">Blue</option></select></label>
  <label><input type="checkbox" id="agree"> Agree</label>
  <button type="submit">Send</button>
</form>
<p id="out"></p>
<button id="late" onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Arrived late'; document.body.append(p); }, 400)">Later</button>
<button id="ask" onclick="document.getElementById('out').textContent = confirm('Sure?') ? 'confirmed' : 'declined'">Ask</button>
<a href="/two" target="_blank">Open two</a>
<input type="file" id="up" multiple onchange="document.getElementById('upout').textContent = [...this.files].map(f => f.name + ':' + f.size).join(',')">
<button id="chooser" onclick="document.getElementById('hidden-up').click()">Choose file</button>
<input type="file" id="hidden-up" style="display:none" onchange="document.getElementById('upout').textContent = 'chose ' + this.files[0].name">
<p id="upout"></p>
<a href="/file.csv" download="report.csv">Get CSV</a>
<a href="/big.bin" download>Get big</a>
<div id="src" draggable="true" style="width:80px;height:40px;background:#ccc" ondragstart="event.dataTransfer.setData('text', 'moved')">Drag me</div>
<div id="dst" style="width:120px;height:60px;background:#eef" ondragover="event.preventDefault()" ondrop="event.preventDefault(); this.textContent = 'dropped ' + event.dataTransfer.getData('text')">Drop here</div>
<input type="range" id="slider" min="0" max="100" value="0" style="width:200px" oninput="document.getElementById('sval').textContent = 'value ' + this.value">
<p id="sval"></p>
<script>console.error('smoke error'); localStorage.setItem('k', 'v'); fetch('/missing');</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE); }
  if (req.url === "/file.csv") { res.writeHead(200, { "content-type": "text/csv" }); return res.end("a,b\n1,2\n"); }
  if (req.url === "/big.bin") { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=\"../../etc/big.bin\"" }); return res.end(Buffer.alloc(2 * 1024 * 1024)); }
  if (req.url === "/two") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<title>Two</title><h1>Second page</h1>"); }
  res.writeHead(404); res.end("nope");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const home = await mkdtemp(join(tmpdir(), "browser-smoke-"));
const env = (config = {}, session = { id: "smoke-1" }) => ({ config, session, cwd: home });
const E = env();
const ref = (snap, pattern) => {
  const line = snap.split("\n").find((l) => pattern.test(l));
  assert.ok(line, `no line matching ${pattern} in:\n${snap.slice(0, 1500)}`);
  return /\[ref=(e\d+)\]/.exec(line)[1];
};

await t("helpers: hosts, private addresses, urls, functions, trimming", () => {
  assert.ok(hostMatches("a.example.com", ["example.com"]));
  assert.ok(hostMatches("example.com", ["example.com"]));
  assert.ok(!hostMatches("example.com", ["*.example.com"]));
  assert.ok(!hostMatches("badexample.com", ["example.com"]));
  assert.ok(isPrivateAddress("10.1.2.3") && isPrivateAddress("192.168.0.1") && isPrivateAddress("::1") && isPrivateAddress("::ffff:127.0.0.1"));
  assert.ok(!isPrivateAddress("93.184.216.34") && !isPrivateAddress("172.32.0.1"));
  assert.equal(normaliseUrl("example.com"), "https://example.com");
  assert.equal(normaliseUrl("localhost:3000/x"), "http://localhost:3000/x");
  assert.equal(normaliseUrl("http://a.b"), "http://a.b");
  assert.equal(normaliseUrl("about:blank"), "about:blank");
  assert.equal(typeof toFunction("() => 1"), "function");
  assert.equal(toFunction("document.title"), "document.title");
  assert.ok(trimSnapshot("a\n".repeat(5000), 1000).snapshotNote);
  const s = settings({ timeoutMs: 5, allowHosts: "a.com, b.com" });
  assert.equal(s.timeoutMs, 1000);
  assert.deepEqual(s.allowHosts, ["a.com", "b.com"]);
});

let snap = "";
await t("status before anything runs", async () => {
  const out = await m.browserStatus({}, E);
  assert.match(out, /playwright-core: 1\.61/);
});

await t("navigate returns the page map with refs", async () => {
  snap = await m.browserNavigate({ url: base }, E);
  assert.match(snap, /^page: Smoke — http:\/\/127\.0\.0\.1/);
  assert.match(snap, /heading "Smoke page"/);
  assert.match(snap, /\[ref=e\d+\]/);
});

await t("fill_form by ref and selector, then click submit", async () => {
  const name = ref(snap, /textbox "Name"/);
  await m.browserType({ action: "fill_form", fields: [
    { target: name, value: "Ada" },
    { target: "#color", value: "blue", type: "select" },
    { target: "#agree", value: "true", type: "checkbox" },
  ] }, E);
  const out = await m.browserClick({ target: ref(snap, /button "Send"/) }, E);
  assert.match(out, /Hello Ada blue agreed/);
});

await t("fill with submit, press_key", async () => {
  const out = await m.browserType({ target: "#name", text: "Grace", submit: true }, E);
  assert.match(out, /Hello Grace/);
  await m.browserType({ action: "press_key", target: "#name", key: "End" }, E);
});

await t("snapshot filter", async () => {
  const out = await m.browserSnapshot({ text: "later" }, E);
  assert.match(out, /matches: 1/);
  assert.match(out, /button "Later"/);
  assert.match(await m.browserSnapshot({ text: "zzzz-nothing" }, E), /no matching nodes/);
});

await t("wait for text that arrives late", async () => {
  await m.browserClick({ target: "#late" }, E);
  const out = await m.browserWait({ text: "Arrived late", timeout: 5000 }, E);
  assert.match(out, /Arrived late/);
});

await t("evaluate expression, function, and with a target", async () => {
  assert.match(await m.browserEvaluate({ function: "document.title" }, E), /result: "Smoke"/);
  assert.match(await m.browserEvaluate({ function: "() => [1,2,3].length" }, E), /result: 3/);
  assert.match(await m.browserEvaluate({ function: "el => el.tagName", target: "h1" }, E), /"H1"/);
});

await t("dialogs: dismissed by default, accepted when armed", async () => {
  assert.match(await m.browserClick({ target: "#ask" }, E), /declined/);
  await m.browserState({ kind: "dialog", action: "accept" }, E);
  assert.match(await m.browserClick({ target: "#ask" }, E), /confirmed/);
  assert.match(await m.browserState({ kind: "dialog" }, E), /\[confirm\] Sure\? → accept/);
});

await t("console and network history", async () => {
  assert.match(await m.browserConsole({ level: "error" }, E), /\[error\] smoke error/);
  const net = await m.browserNetwork({ failedOnly: true }, E);
  assert.match(net, /GET 404 .*\/missing/);
});

await t("storage and cookies", async () => {
  assert.match(await m.browserState({ kind: "localStorage", action: "get", name: "k" }, E), /value: v/);
  await m.browserState({ kind: "cookies", action: "set", name: "c1", value: "x" }, E);
  assert.match(await m.browserState({ kind: "cookies" }, E), /"name": "c1"/);
  await m.browserState({ kind: "cookies", action: "delete", name: "c1" }, E);
  assert.doesNotMatch(await m.browserState({ kind: "cookies" }, E), /"c1"/);
  assert.match(await m.browserState({ kind: "viewport", width: 400, height: 600 }, E), /400×600/);
});

await t("screenshot and pdf land under home", async () => {
  const out = await m.browserScreenshot({ fullPage: true }, E);
  const p = /path: (\S+)/.exec(out)[1];
  assert.match(p, /^browser\/.*\.jpg$/);
  assert.ok((await stat(join(home, p))).size > 1000);
  const pdf = await m.browserScreenshot({ action: "pdf", filename: "page" }, E);
  assert.match(pdf, /path: browser\/page\.pdf/);
  const png = await m.browserScreenshot({ target: "h1", filename: "h.png" }, E);
  assert.match(png, /mime: image\/png/);
});

await t("a link that opens a tab, then tabs select and close", async () => {
  const s2 = await m.browserSnapshot({}, E);
  const out = await m.browserClick({ target: ref(s2, /link "Open two"/) }, E);
  assert.match(out, /opened a new tab/);
  const list = await m.browserTabs({}, E);
  assert.match(list, /1: Two/);
  assert.match(await m.browserTabs({ action: "select", index: 1 }, E), /Second page/);
  assert.match(await m.browserTabs({ action: "close" }, E), /0 \*: Smoke/);
});

await t("back and reload", async () => {
  await m.browserNavigate({ url: `${base}/two` }, E);
  assert.match(await m.browserNavigate({ action: "back" }, E), /page: Smoke/);
  assert.match(await m.browserNavigate({ action: "reload" }, E), /heading "Smoke page"/);
});

await t("a stale ref fails with a hint", async () => {
  await assert.rejects(m.browserClick({ target: "e9999" }, env({ timeoutMs: 1500 })), /fresh ref|older snapshot/);
});

await t("chats are isolated; a helper chat shares its parent's", async () => {
  const other = env({}, { id: "smoke-2" });
  assert.doesNotMatch(await m.browserStatus({}, other), /this chat: \d+ tab/);
  const child = env({}, { id: "smoke-child", parent: "smoke-1" });
  assert.match(await m.browserStatus({}, child), /shared with the parent/);
  assert.match(await m.browserSnapshot({}, child), /page: Smoke/);
  const alone = env({ shareWithSubagents: false }, { id: "smoke-child", parent: "smoke-1" });
  assert.match(await m.browserSnapshot({}, alone), /page: about:blank|browser reported success/);
  await m.browserClose({}, alone);
});

await t("concurrent calls in one chat run in order", async () => {
  const outs = await Promise.all([
    m.browserEvaluate({ function: "async () => { await new Promise(r => setTimeout(r, 300)); window.__seq = (window.__seq||'') + 'a'; return window.__seq; }" }, E),
    m.browserEvaluate({ function: "() => { window.__seq = (window.__seq||'') + 'b'; return window.__seq; }" }, E),
  ]);
  assert.match(outs[0], /"a"/);
  assert.match(outs[1], /"ab"/);
});

await t("policy: denyHosts, allowHosts, private networks", async () => {
  const deny = env({ denyHosts: "127.0.0.1" }, { id: "smoke-deny" });
  await assert.rejects(m.browserNavigate({ url: base }, deny), /127\.0\.0\.1 is in denyHosts/);
  const allow = env({ allowHosts: "example.org" }, { id: "smoke-allow" });
  await assert.rejects(m.browserNavigate({ url: base }, allow), /not in allowHosts/);
  const priv = env({ blockPrivateNetworks: true }, { id: "smoke-priv" });
  await assert.rejects(m.browserNavigate({ url: base }, priv), /private address/);
  for (const id of ["smoke-deny", "smoke-allow", "smoke-priv"]) await m.browserClose({}, env({}, { id }));
});

await t("a public page, when the network is there", async () => {
  const out = await m.browserNavigate({ url: "example.com" }, env({}, { id: "smoke-net" })).catch((e) => `skipped: ${e.message}`);
  if (out.startsWith("skipped")) { console.log(`     ${out.split("\n")[0]}`); return; }
  assert.match(out, /Example Domain/);
});

await t("upload into a file input, several files, and through a chooser button", async () => {
  await m.browserNavigate({ url: base }, E);
  await writeFile(join(home, "a.txt"), "hello");
  await writeFile(join(home, "b.txt"), "hi");
  const out = await m.browserUpload({ target: "#up", files: ["a.txt", "b.txt"] }, E);
  assert.match(out, /a\.txt:5,b\.txt:2/);
  const s2 = await m.browserSnapshot({}, E);
  const via = await m.browserUpload({ target: ref(s2, /button "Choose file"/), files: ["a.txt"] }, E);
  assert.match(via, /chose a\.txt/);
});

await t("upload refuses what is outside home, missing, or a directory", async () => {
  await assert.rejects(m.browserUpload({ target: "#up", files: ["/etc/hostname"] }, E), /outside home/);
  await assert.rejects(m.browserUpload({ target: "#up", files: ["../x.txt"] }, E), /no such file|outside home/);
  await assert.rejects(m.browserUpload({ target: "#up", files: ["nope.txt"] }, E), /no such file/);
  await assert.rejects(m.browserUpload({ target: "#up", files: ["."] }, E), /not a file/);
  await assert.rejects(m.browserUpload({ target: "h1", files: ["a.txt"] }, env({ timeoutMs: 1500 })), /file chooser/);
  const ok = await m.browserUpload({ target: "#up", files: ["/etc/hostname"] }, env({ uploadRoots: "/etc" }));
  assert.match(ok, /hostname:/);
});

await t("drag element to element, and a slider by coordinates", async () => {
  const out = await m.browserDrag({ target: "#src", to: "#dst" }, E);
  assert.match(out, /dropped moved/);
  const box = JSON.parse(/result: ([\s\S]*)$/.exec(await m.browserEvaluate({ function: "() => { const r = document.getElementById('slider').getBoundingClientRect(); return JSON.stringify({x: r.x, y: r.y + r.height / 2, w: r.width}); }" }, E))[1].trim().replace(/^"|"$/g, "").replace(/\\"/g, '"'));
  const slid = await m.browserDrag({ fromX: box.x + 2, fromY: box.y, toX: box.x + box.w * 0.75, toY: box.y }, E);
  assert.match(slid, /value (6\d|7\d)/);
  await assert.rejects(m.browserDrag({ target: "#src" }, E), /needs a `to`/);
});

await t("downloads save under home with a safe name, big ones refused", async () => {
  assert.match(await m.browserDownloads({}, E), /none yet/);
  const s2 = await m.browserSnapshot({}, E);
  await m.browserClick({ target: ref(s2, /link "Get CSV"/) }, E);
  const list = await m.browserDownloads({ wait: true, timeout: 5000 }, E);
  assert.match(list, /1\. saved: report\.csv → browser\/downloads\/report\.csv \(8 bytes\)/);
  assert.equal(await readFile(join(home, "browser/downloads/report.csv"), "utf8"), "a,b\n1,2\n");
  await m.browserClick({ target: ref(s2, /link "Get CSV"/) }, E);
  assert.match(await m.browserDownloads({ wait: true, timeout: 5000 }, E), /report \(1\)\.csv/);
  await m.browserClick({ target: ref(s2, /link "Get big"/) }, env({ downloadMaxMb: 1 }));
  assert.match(await m.browserDownloads({ wait: true, timeout: 5000 }, E), /3\. refused: [^/\n]*big\.bin \(2\.0 MB is over downloadMaxMb \(1\)\)/);
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName(".bashrc"), "bashrc");
  assert.equal(safeName("a:b*c?.txt"), "a_b_c_.txt");
});

await t("screenshot comes back as an image asset, scaled, when an asset store is there", async () => {
  await m.browserState({ kind: "viewport", width: 1280, height: 800 }, E);
  const puts = [];
  const withAssets = { ...E, kernel: { assets: { put: async (u) => { puts.push(u); return { id: "a_1", size: 1, mediaType: u.mediaType, name: u.name }; } } } };
  const out = await m.browserScreenshot({ fullPage: true, type: "png" }, withAssets);
  assert.equal(out.type, "tool-result");
  assert.equal(out.content[0].type, "text");
  assert.match(out.content[0].data.text, /path: browser\/.*\.png/);
  assert.match(out.content[0].data.text, /image: attached/);
  assert.deepEqual(out.content[1], { type: "asset", data: { id: "a_1", mediaType: "image/jpeg", name: puts[0].name } });
  const bytes = Buffer.from(puts[0].data, "base64");
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8);
  assert.ok(bytes.length < 3.5 * 1024 * 1024);
  const narrow = await m.browserScreenshot({}, { ...withAssets, config: { imageMaxWidth: 400 } });
  assert.match(narrow.content[0].data.text, /shown 400×250 from 1280×800/);
  assert.equal(typeof await m.browserScreenshot({ show: false }, withAssets), "string");
  assert.equal(typeof await m.browserScreenshot({}, { ...withAssets, config: { screenshotToModel: false } }), "string");
  assert.equal(typeof await m.browserScreenshot({}, E), "string");
  const pdf = await m.browserScreenshot({ action: "pdf" }, withAssets);
  assert.equal(typeof pdf, "string");
});

await t("close", async () => {
  assert.match(await m.browserClose({}, E), /closed this chat's browser/);
  assert.match(await m.browserClose({}, E), /nothing to close/);
});

await closeAll();
server.close();
await rm(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

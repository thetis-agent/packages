// A stand-in for the gateway, to try the map tab's frame in a real browser: serves the editor frame under
// /f/ with the gateway's sandbox CSP, and a page at / that mounts it the way ext.frame.mount does and
// answers its messages with the real doc and save commands. `node test/harness/serve.mjs <home> [port]`.
import { createServer } from "node:http";
import { uiDoc, uiSave, uiEditor, uiList } from "../../lib/commands.js";
import { completeDoc, diffDocs } from "../../ui/core/doc.js";

const home = process.argv[2];
const port = Number(process.argv[3] ?? 5307);
const env = { cwd: home, user: "test" };
const CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'";

const page = (map) => `<!doctype html><meta charset=utf-8><title>harness</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
<iframe id=f sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script type=module>
import { completeDoc, diffDocs } from "/core/doc.js";
const nonce = "n" + Math.random().toString(16).slice(2);
const f = document.getElementById("f");
f.src = "/f/?v=1#" + nonce;
let seq = 0; const bases = {}; window.log = [];
const post = (m) => f.contentWindow.postMessage({ ...m, nonce }, "*");
async function load(message) {
  const r = await (await fetch("/doc?map=${map}")).json();
  seq += 1; bases[seq] = completeDoc(r.doc);
  post({ type: "load", seq, doc: r.doc, rev: r.rev, state: r.state, label: r.label, linked: r.linked, message });
  return r;
}
window.reloadNow = load;
addEventListener("message", async (e) => {
  if (e.source !== f.contentWindow || e.data?.nonce !== nonce) return;
  const m = e.data; window.log.push(m.type);
  if (m.type === "ready") await load();
  if (m.type === "reload") await load("Reloaded");
  if (m.type === "save") {
    const base = bases[m.seq]; const mine = completeDoc(m.doc);
    const out = await (await fetch("/save?map=${map}", { method: "PUT", body: JSON.stringify(diffDocs(base, mine)) })).json();
    bases[m.seq] = mine; window.lastSave = out;
    post({ type: "saved", ok: true, rev: out.rev }); post({ type: "state", state: out.state, label: out.label, rev: out.rev });
  }
  if (m.type === "view") window.lastView = m;
});
</script>`;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const map = url.searchParams.get("map") ?? (await uiList({}, env)).data.maps[0]?.id;
  try {
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page(map)); }
    if (url.pathname === "/core/doc.js") {
      const { readFile } = await import("node:fs/promises");
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(await readFile(new URL("../../ui/core/doc.js", import.meta.url)));
    }
    if (url.pathname.startsWith("/f/")) {
      const out = await uiEditor({ map }, env, { path: url.pathname.slice(3) });
      res.writeHead(out.status ?? 200, { ...out.headers, "content-security-policy": CSP });
      return res.end(out.body);
    }
    if (url.pathname === "/doc") { const out = await uiDoc({ map }, env, { method: "GET" }); res.writeHead(200, out.headers); return res.end(out.body); }
    if (url.pathname === "/save") {
      const chunks = []; for await (const c of req) chunks.push(c);
      const out = await uiSave({ map, base: 0 }, env, { method: "PUT", body: Buffer.concat(chunks) });
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(out));
    }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500); res.end(String(e.stack)); }
}).listen(port, "127.0.0.1", () => console.log(`harness on http://127.0.0.1:${port}/`));

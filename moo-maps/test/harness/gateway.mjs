// The real @thetis/gateway-web server, over a stand-in kernel that knows one user and this package, on a
// scratch home: to use the Maps sidebar and the Map tab in a browser exactly as Thetis serves them.
// `node test/harness/gateway.mjs <scratch home> [port]`, then open http://127.0.0.1:<port>/ (the cookie is set
// by visiting /dev-login).
import { mkdirSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "../..");
const home = resolve(process.argv[2]);
const port = Number(process.argv[3] ?? 5308);
const store = resolve(home, "../store");
mkdirSync(resolve(store, "node_modules/@bitmuse"), { recursive: true });
const link = resolve(store, "node_modules/@bitmuse/moo-maps");
if (!existsSync(link)) symlinkSync(pkgRoot, link);
const gw = resolve(process.env.GATEWAY ?? resolve(home, "../../store/node_modules/@thetis/gateway-web"));
const { createGateway } = await import(resolve(gw, "dist/src/server.js"));

const manifest = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8"));
const TOKEN = "a".repeat(64);
const pkgEntry = { name: manifest.name, version: manifest.version, type: "tool", root: link, thetis: manifest.thetis, scope: "me" };
const kernel = {
  auth: { authenticate: async (t) => (t === TOKEN ? { id: "review", role: "admin" } : undefined) },
  packages: { list: async () => [pkgEntry], catalog: async () => [] },
  config: { effective: async () => ({}) },
  sessions: { list: async () => [], get: async () => null, watch: async () => () => {}, inspect: async () => ({}) },
  models: { list: async () => [] },
  operator: { call: async () => ({}) },
  subscribe: () => () => {},
  on: () => () => {},
};
const fakeStore = new Proxy({}, { get: (_t, k) => (k === "getAvatar" ? () => null : () => undefined) });
const env = { cwd: home, root: home, store, user: "review" };
const gateway = createGateway(new Proxy(kernel, { get: (t, k) => t[k] ?? (() => undefined) }), fakeStore, { user: "review", env, store, log: (l) => console.error(l) });
const server = gateway.listen ? gateway : gateway.server;
// The cookie: a tiny route in front of the gateway.
const { createServer } = await import("node:http");
const inner = typeof gateway.handler === "function" ? gateway.handler : null;
console.log("gateway keys:", Object.keys(gateway));
gateway.listen(port + 1, "127.0.0.1");
createServer((req, res) => {
  if (req.url === "/dev-login") {
    res.writeHead(302, { "set-cookie": `thetis_web=${TOKEN}; Path=/; HttpOnly`, location: "/" });
    return res.end();
  }
  import("node:http").then(({ request }) => {
    const p = request({ host: "127.0.0.1", port: port + 1, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(p);
  });
}).listen(port, "127.0.0.1", () => console.log(`gateway harness on http://127.0.0.1:${port}/ (visit /dev-login)`));
void server; void inner;

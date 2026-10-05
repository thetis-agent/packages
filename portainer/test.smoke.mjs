// Smoke test: a small in-memory Portainer behind a real local HTTP server,
// and the tools driven through the same (args, env) interface the kernel
// uses. Run: node test.smoke.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import * as p from "./client.js";
import * as index from "./index.js";

const TOKEN = "ptr_secret_token_xyz";

// --- manifest ↔ exports --------------------------------------------------------
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
assert.equal(pkg.name, "@thetis/portainer");
for (const t of pkg.thetis.tools) {
  assert.equal(typeof index[t.export], "function", `export ${t.export} for ${t.name}`);
  assert.ok(t.description.length > 40, `${t.name} has a description`);
  assert.equal(t.parameters.type, "object");
  assert.equal(typeof t.reads, "boolean", `${t.name} declares reads`);
  assert.ok(t.name.startsWith("portainer_"));
}
assert.equal(pkg.thetis.config.token.secret, true);
assert.equal(pkg.thetis.config.url.required, true);
console.log(`manifest: ${pkg.thetis.tools.length} tools wired: ok`);

// --- createClient guards -------------------------------------------------------
assert.throws(() => p.createClient({}), /no Portainer URL configured/);
assert.throws(() => p.createClient({ url: "http://x" }), /no Portainer access token configured/);
assert.throws(() => p.createClient({ url: "ftp://x", token: "t" }), /http\(s\)/);
assert.equal(p.createClient({ url: "https://pt.example.com:9443/api/", token: "t" }).apiUrl, "https://pt.example.com:9443/api");
console.log("createClient guards: ok");

// --- helpers -------------------------------------------------------------------
assert.deepEqual(p.parsePath('Labels."com.docker.compose.project"'), ["Labels", "com.docker.compose.project"]);
assert.deepEqual(p.parsePath("Names[0]"), ["Names", 0]);
const f = p.parseFields('id=Id,Names[0],Labels."a.b",metadata.name');
assert.deepEqual(f.map((x) => x.key), ["id", "Names", "a.b", "name"]);
assert.deepEqual(p.project([{ Id: "1", Names: ["/x"], Labels: { "a.b": "y" } }], f), [{ id: "1", Names: "/x", "a.b": "y", name: null }]);
assert.deepEqual(p.project({ items: [{ metadata: { name: "pod" } }], metadata: {} }, p.parseFields("metadata.name")), { items: [{ name: "pod" }] });
const red = p.redactEnvs({ Env: [{ name: "A", value: "1" }], Config: { Env: ["B=2", "noeq"] }, spec: { env: [{ name: "C", valueFrom: { secretKeyRef: {} } }] } });
assert.equal(red.Env[0].value, p.REDACTED);
assert.deepEqual(red.Config.Env, [`B=${p.REDACTED}`, "noeq"]);
assert.ok(red.spec.env[0].valueFrom && !("value" in red.spec.env[0]));
const framed = Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 4]), Buffer.from("out\n"), Buffer.from([2, 0, 0, 0, 0, 0, 0, 4]), Buffer.from("err\n")]);
assert.deepEqual(p.demuxDockerLog(framed), [{ stream: "stdout", text: "out\n" }, { stream: "stderr", text: "err\n" }]);
assert.deepEqual(p.demuxDockerLog(Buffer.from("plain tty text\n")), [{ stream: "stdout", text: "plain tty text\n" }]);
assert.deepEqual(p.envArg({ A: 1, B: "x" }), [{ name: "A", value: "1" }, { name: "B", value: "x" }]);
assert.deepEqual(p.envArg("A=1\n# c\nB=two=2"), [{ name: "A", value: "1" }, { name: "B", value: "two=2" }]);
assert.deepEqual(p.envArg(["A=1"]), [{ name: "A", value: "1" }]);
assert.ok(Math.abs(p.sinceArg("10m", "s") - (Date.now() / 1000 - 600)) < 5);
assert.equal(p.sinceArg("1791213779", "s"), 1791213779);
assert.throws(() => p.sinceArg("whenever", "s"), /since|like/);
assert.throws(() => p.bodyArg(JSON.stringify(JSON.stringify({ a: 1 }))), /encoded twice/);
assert.deepEqual(p.bodyArg({ a: 1 }), { a: 1 });
assert.equal(p.bodyArg("raw"), "raw");
console.log("helpers: ok");

// --- an in-memory Portainer ------------------------------------------------------
const db = {
  endpoints: [
    { Id: 1, Name: "local", Type: 1, Status: 1, URL: "unix:///var/run/docker.sock", GroupId: 1, Snapshots: [{ DockerVersion: "29.1", Swarm: false, RunningContainerCount: 2, ContainerCount: 3, StackCount: 1, ImageCount: 4, VolumeCount: 2, TotalCPU: 4, TotalMemory: 8 * 2 ** 30, Time: 1791213779 }] },
    { Id: 2, Name: "edge-pi", Type: 4, Status: 1, Heartbeat: false, LastCheckInDate: 1791200000, GroupId: 1, Snapshots: [] },
    { Id: 3, Name: "k3s", Type: 6, Status: 1, GroupId: 1, Kubernetes: { Snapshots: [{ KubernetesVersion: "v1.31", NodeCount: 1, TotalCPU: 4, TotalMemory: 2 ** 33 }] } },
  ],
  stacks: [
    { Id: 7, Name: "web", Type: 2, Status: 1, EndpointId: 1, EntryPoint: "docker-compose.yml", Env: [{ name: "DB_PASS", value: "hunter2" }], CreationDate: 1791200000, CreatedBy: "admin" },
    { Id: 8, Name: "gitapp", Type: 2, Status: 1, EndpointId: 1, Env: [], GitConfig: { URL: "https://git.example.com/app", ReferenceName: "refs/heads/main", ConfigFilePath: "compose.yml", ConfigHash: "aaaaaaaaaaaaaaaa" } },
  ],
  files: { 7: "services:\n  web:\n    image: nginx\n" },
  containers: [
    { Id: "c1".padEnd(64, "0"), Names: ["/web-web-1"], State: "running", Status: "Up 2 hours", Image: "nginx", Labels: { "com.docker.compose.project": "web" }, Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp", IP: "0.0.0.0" }] },
    { Id: "c2".padEnd(64, "0"), Names: ["/lonely"], State: "exited", Status: "Exited (1) 3 minutes ago", Image: "alpine", Labels: {}, Ports: [] },
  ],
  nextStack: 100,
};
const calls = [];
let deployPolls = 0;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  const body = text ? JSON.parse(text) : undefined;
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/^\/api/, "");
  const q = url.searchParams;
  calls.push({ method: req.method, path, query: Object.fromEntries(q), body, headers: req.headers });
  if (path === "/system/status") return json(res, 200, { Version: "2.45.1" });
  if (req.headers["x-api-key"] !== TOKEN) return json(res, 401, { message: "Invalid JWT token", details: "Unauthorized" });
  let m;
  if (path === "/system/version") return json(res, 200, { ServerVersion: "2.45.1", ServerEdition: "CE", Runtime: { Env: ["SECRET=leak"] } });
  if (path === "/users/me") return json(res, 200, { Id: 1, Username: "admin", Role: 1 });
  if (path === "/endpoints") {
    let list = db.endpoints;
    const s = q.get("search");
    if (s) list = list.filter((e) => e.Name.includes(s));
    const types = q.getAll("types").map(Number);
    if (types.length) list = list.filter((e) => types.includes(e.Type));
    return json(res, 200, list);
  }
  if ((m = /^\/endpoints\/(\d+)$/.exec(path))) {
    const e = db.endpoints.find((x) => x.Id === Number(m[1]));
    return e ? json(res, 200, e) : json(res, 404, { message: "Unable to find an environment with the specified identifier inside the database" });
  }
  if (path === "/stacks" && req.method === "GET") {
    const filt = q.get("filters") ? JSON.parse(q.get("filters")) : {};
    return json(res, 200, db.stacks.filter((s) => filt.EndpointID === undefined || s.EndpointId === filt.EndpointID));
  }
  if ((m = /^\/stacks\/create\/(standalone|swarm|kubernetes)\/(string|repository)$/.exec(path))) {
    const name = body.Name ?? body.StackName;
    if (db.stacks.some((s) => s.Name === name)) return json(res, 409, { message: `A stack with the normalized name '${name}' already exists` });
    const s = { Id: db.nextStack++, Name: name, Type: m[1] === "kubernetes" ? 3 : m[1] === "swarm" ? 1 : 2, Status: 3, EndpointId: Number(q.get("endpointId")), Env: body.Env ?? [], Namespace: body.Namespace };
    if (name === "broken") s._fail = "compose up operation failed: pull access denied";
    db.stacks.push(s);
    db.files[s.Id] = body.StackFileContent;
    deployPolls = 0;
    return json(res, 200, s);
  }
  if ((m = /^\/stacks\/(\d+)$/.exec(path))) {
    const s = db.stacks.find((x) => x.Id === Number(m[1]));
    if (!s) return json(res, 404, { message: "Unable to find a stack with the specified identifier inside the database" });
    if (req.method === "GET") {
      // Deploying for two polls, then settled.
      if (s.Status === 3 && ++deployPolls >= 2) {
        s.Status = s._fail ? 4 : 1;
        s.DeploymentStatus = [{ Status: 3, Time: 1 }, s._fail ? { Status: 4, Time: 2, Message: s._fail } : { Status: 1, Time: 2 }];
      }
      return json(res, 200, s);
    }
    if (req.method === "PUT") {
      s.Env = body.Env;
      db.files[s.Id] = body.StackFileContent;
      return json(res, 200, s);
    }
    if (req.method === "DELETE") {
      db.stacks = db.stacks.filter((x) => x !== s);
      return json(res, 204);
    }
  }
  if ((m = /^\/stacks\/(\d+)\/file$/.exec(path))) return json(res, 200, { StackFileContent: db.files[m[1]] });
  if ((m = /^\/stacks\/(\d+)\/git\/redeploy$/.exec(path))) {
    const s = db.stacks.find((x) => x.Id === Number(m[1]));
    s.GitConfig = { ...s.GitConfig, ConfigHash: "bbbbbbbbbbbbbbbb" };
    return json(res, 200, s);
  }
  if ((m = /^\/stacks\/(\d+)\/(start|stop)$/.exec(path))) {
    const s = db.stacks.find((x) => x.Id === Number(m[1]));
    s.Status = m[2] === "start" ? 1 : 2;
    return json(res, 200, s);
  }
  if ((m = /^\/endpoints\/(\d+)\/docker(\/.*)$/.exec(path))) {
    const d = m[2];
    if (d === "/containers/json") {
      const filt = q.get("filters") ? JSON.parse(q.get("filters")) : {};
      let list = db.containers;
      if (filt.label) list = list.filter((c) => filt.label.every((l) => { const [k, v] = l.split("="); return c.Labels[k] === v; }));
      if (filt.name) list = list.filter((c) => c.Names[0].includes(filt.name[0]));
      return json(res, 200, list);
    }
    if ((m = /^\/containers\/([^/]+)\/json$/.exec(d))) {
      const c = db.containers.find((x) => x.Names[0] === `/${m[1]}` || x.Id.startsWith(m[1]));
      if (!c) return json(res, 404, { message: `No such container: ${m[1]}` });
      return json(res, 200, { Id: c.Id, Name: c.Names[0], Config: { Image: c.Image, Env: ["PASSWORD=pw", "PATH=/bin"], Labels: c.Labels, Cmd: ["nginx"] }, State: { Status: c.State, Running: c.State === "running", ExitCode: c.State === "running" ? 0 : 1, StartedAt: "2026-10-05T10:00:00Z", FinishedAt: "2026-10-05T11:00:00Z" }, Created: "2026-10-05T09:00:00Z", HostConfig: { RestartPolicy: { Name: "unless-stopped" } }, Mounts: [{ Type: "volume", Name: "data", Destination: "/data", RW: true }], NetworkSettings: { Ports: {}, Networks: { bridge: { IPAddress: "172.17.0.2" } } } });
    }
    if ((m = /^\/containers\/([^/]+)\/logs$/.exec(d))) {
      res.writeHead(200, { "content-type": "application/vnd.docker.multiplexed-stream" });
      return res.end(Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 12]), Buffer.from("hello world\n"), Buffer.from([2, 0, 0, 0, 0, 0, 0, 10]), Buffer.from("bad thing\n")]));
    }
    if ((m = /^\/containers\/([^/]+)\/(start|stop|restart)$/.exec(d))) {
      const c = db.containers.find((x) => x.Id === m[1]);
      c.State = m[2] === "stop" ? "exited" : "running";
      return json(res, 204);
    }
    if (/\/stats$/.test(d)) return json(res, 200, { pids_stats: { current: 3 }, memory_stats: { usage: 100, limit: 1000, stats: {} } });
    if (d === "/info") return json(res, 200, { Name: "host", ServerVersion: "29.1", NCPU: 4, MemTotal: 2 ** 33, ContainersRunning: 1, ContainersPaused: 0, ContainersStopped: 1, Swarm: { LocalNodeState: "inactive" } });
    return json(res, 404, { message: "page not found" });
  }
  if ((m = /^\/endpoints\/(\d+)\/kubernetes(\/.*)$/.exec(path))) {
    if (req.method === "PATCH") return json(res, 200, { kind: "Deployment", metadata: { name: "api", managedFields: [{ big: 1 }] }, spec: body.spec });
    return json(res, 200, { kind: "PodList", metadata: {}, items: [{ metadata: { name: "api-1", namespace: "web", managedFields: [{ x: 1 }] }, status: { phase: "Running" }, spec: { containers: [{ env: [{ name: "K", value: "v" }] }] } }] });
  }
  json(res, 404, { message: `no route ${req.method} ${path}` });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}`;
const env = { config: { url: URL_, token: TOKEN, environment: "local" } };
const last = (pred) => [...calls].reverse().find(pred);
const noToken = (s) => assert.ok(!String(s).includes(TOKEN), "the token never reaches an answer");

try {
  // health
  let out = await index.portainerHealth({}, env);
  noToken(out);
  assert.match(out, /"version": "2.45.1"/);
  assert.match(out, /"username": "admin"/);
  assert.match(out, /edge-pi.*no heartbeat/);
  out = await index.portainerHealth({}, { config: { url: URL_, token: "ptr_wrong" } });
  assert.match(out, /"ok": false/);
  assert.match(out, /access token was rejected/);
  console.log("health: ok");

  // environments
  out = await index.portainerEnvironments({}, env);
  assert.match(out, /3 environments/);
  assert.match(out, /1 "local" · docker \(direct\) · up · containers 2 running \/ 3 total/);
  assert.match(out, /3 "k3s" · kubernetes \(agent\)/);
  out = await index.portainerEnvironments({ platform: "kubernetes" }, env);
  assert.match(out, /1 environment:/);
  out = await index.portainerEnvironments({ fields: "Id,Name" }, env);
  assert.deepEqual(JSON.parse(out)[0], { Id: 1, Name: "local" });
  console.log("environments: ok");

  // stacks
  out = await index.portainerStacks({}, env);
  assert.match(out, /7 "web" · compose · active · env 1/);
  assert.match(out, /git https:\/\/git.example.com\/app@main/);
  out = await index.portainerStacks({ stack: "web", file: true }, env);
  assert.ok(!out.includes("hunter2"), "stack env values redacted");
  assert.match(out, /environment value\(s\) redacted/);
  assert.match(out, /web-web-1 running/);
  assert.match(out, /image: nginx/);
  out = await index.portainerStacks({ stack: "web", fields: "pass=Env[0].value" }, env);
  assert.ok(!out.includes("hunter2"), "an alias cannot route around redaction");
  await assert.rejects(index.portainerStacks({ stack: "nope" }, env), /no stack "nope"/);
  console.log("stacks: ok");

  // deploy: waits through "deploying", reports the containers or the failure
  out = await index.portainerStackDeploy({ name: "app", compose: "services: {}", env: { A: "1" } }, env);
  let call = last((c) => c.path === "/stacks/create/standalone/string");
  assert.equal(call.query.endpointId, "1");
  assert.deepEqual(call.body.Env, [{ name: "A", value: "1" }]);
  assert.match(out, /created stack 100 "app"/);
  assert.match(out, /stack status: active/);
  out = await index.portainerStackDeploy({ name: "broken", compose: "services: {}" }, env);
  assert.match(out, /stack status: failed\ndeploy failed: compose up operation failed: pull access denied/);
  await assert.rejects(index.portainerStackDeploy({ name: "app", compose: "x" }, env), /409[\s\S]*already exists/);
  await assert.rejects(index.portainerStackDeploy({ name: "x" }, env), /compose.*repository_url/);
  out = await index.portainerStackDeploy({ name: "kapp", compose: "apiVersion: v1", environment: "k3s", namespace: "web" }, env);
  call = last((c) => c.path === "/stacks/create/kubernetes/string");
  assert.equal(call.body.StackName, "kapp");
  assert.equal(call.body.Namespace, "web");
  console.log("stack deploy: ok");

  // update: env merge keeps the file; git redeploy sends a bare body
  out = await index.portainerStackUpdate({ stack: "web", set_env: { NEW: "x" }, unset_env: [] }, env);
  call = last((c) => c.method === "PUT" && c.path === "/stacks/7");
  assert.equal(call.body.StackFileContent, "services:\n  web:\n    image: nginx\n");
  assert.deepEqual(call.body.Env, [{ name: "DB_PASS", value: "hunter2" }, { name: "NEW", value: "x" }]);
  assert.match(out, /updated stack 7 "web" \(env\)/);
  out = await index.portainerStackUpdate({ stack: 8 }, env);
  call = last((c) => c.path === "/stacks/8/git/redeploy");
  assert.deepEqual(call.body, {});
  assert.equal(call.query.endpointId, "1");
  assert.match(out, /commit aaaaaaaaaaaa → bbbbbbbbbbbb/);
  await assert.rejects(index.portainerStackUpdate({ stack: 8, compose: "x" }, env), /deployed from git/);
  console.log("stack update: ok");

  out = await index.portainerStackControl({ stack: "web", action: "stop" }, env);
  assert.match(out, /stopped stack 7 "web"\nstack status: inactive/);
  out = await index.portainerStackDelete({ stack: "app", remove_volumes: true }, env);
  call = last((c) => c.method === "DELETE");
  assert.equal(call.query.removeVolumes, "true");
  assert.match(out, /deleted stack 100/);
  console.log("stack control and delete: ok");

  // containers
  out = await index.portainerContainers({}, env);
  assert.match(out, /2 containers in environment 1 "local" \(1 running\)/);
  assert.match(out, /c10000000000 web-web-1 running \(Up 2 hours\) nginx \[stack web\] 8080→80\/tcp/);
  out = await index.portainerContainers({ stack: "web" }, env);
  assert.deepEqual(JSON.parse(last((c) => c.path.endsWith("/containers/json")).query.filters).label, ["com.docker.compose.project=web"]);
  out = await index.portainerContainers({ container: "lonely", stats: true }, env);
  assert.match(out, /"exit_code": 1/);
  assert.ok(!out.includes("PASSWORD=pw"));
  assert.match(out, /PASSWORD=\[REDACTED\]/);
  assert.match(out, /data → \/data/);
  out = await index.portainerContainerAction({ container: "lonely", action: "start" }, env);
  assert.match(out, /start c20000000000 "lonely": was exited, now running/);
  await assert.rejects(index.portainerContainerAction({ container: "lonely", action: "explode" }, env), /action must be one of/);
  console.log("containers: ok");

  // logs: demuxed, stderr marked, grep
  out = await index.portainerContainerLogs({ container: "web-web-1", tail: 50 }, env);
  assert.match(out, /2 lines \(tail 50\):\nhello world\n\[err\] bad thing/);
  call = last((c) => c.path.endsWith("/logs"));
  assert.equal(call.query.tail, "50");
  assert.equal(call.query.follow, undefined);
  out = await index.portainerContainerLogs({ container: "web-web-1", grep: "bad" }, env);
  assert.match(out, /1 line .*\n\[err\] bad thing/);
  console.log("logs: ok");

  // resources
  out = await index.portainerDockerResources({ kind: "info" }, env);
  assert.match(out, /"cpus": 4/);
  out = await index.portainerDockerResources({ kind: "services" }, env);
  assert.match(out, /not a Swarm/);
  console.log("docker resources: ok");

  // proxies
  out = await index.portainerDocker({ path: "/containers/web-web-1/stats", fields: "pids=pids_stats.current" }, env);
  assert.deepEqual(JSON.parse(out), { pids: 3 });
  assert.equal(last((c) => c.path.endsWith("/stats")).query.stream, "false");
  await assert.rejects(index.portainerDocker({ path: "/containers/x/logs", query: { follow: true } }, env), /never end/);
  await assert.rejects(index.portainerDocker({ path: "/x?y=1" }, env), /query/);
  await assert.rejects(index.portainerDocker({ path: "/x", headers: { Authorization: "x" } }, env), /not allowed/);
  await assert.rejects(index.portainerKubernetes({ path: "/api/v1/pods" }, env), /not Kubernetes/);
  out = await index.portainerKubernetes({ environment: 3, path: "/api/v1/pods", fields: "metadata.name,phase=status.phase,e=spec.containers[0].env" }, env);
  assert.deepEqual(JSON.parse(out.split("\n[")[0]).items[0], { name: "api-1", phase: "Running", e: [{ name: "K", value: p.REDACTED }] });
  out = await index.portainerKubernetes({ environment: "k3s", method: "PATCH", path: "/apis/apps/v1/namespaces/web/deployments/api", body: { spec: { replicas: 0 } } }, env);
  call = last((c) => c.method === "PATCH");
  assert.equal(call.headers["content-type"], "application/merge-patch+json");
  assert.ok(!out.includes("managedFields"));
  out = await index.portainerRequest({ path: "/api/system/version" }, env);
  assert.ok(!out.includes("leak"));
  console.log("proxies and request: ok");

  // read-only
  const ro = { config: { ...env.config, readOnly: true } };
  await assert.rejects(index.portainerStackDelete({ stack: "web" }, ro), /read-only/);
  await assert.rejects(index.portainerContainerAction({ container: "lonely", action: "stop" }, ro), /read-only/);
  await assert.rejects(index.portainerDocker({ method: "POST", path: "/containers/x/stop" }, ro), /read-only/);
  await assert.rejects(index.portainerRequest({ method: "DELETE", path: "/stacks/7" }, ro), /read-only/);
  assert.match(await index.portainerStacks({}, ro), /stacks?:/);
  console.log("read-only: ok");

  // exposeEnv
  out = await index.portainerStacks({ stack: "web", fields: "Env" }, { config: { ...env.config, exposeEnv: true } });
  assert.match(out, /hunter2/);
  console.log("exposeEnv: ok");

  for (const c of calls) assert.ok(!JSON.stringify(c.query).includes(TOKEN));
  console.log("all ok");
} finally {
  server.close();
}

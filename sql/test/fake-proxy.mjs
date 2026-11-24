#!/usr/bin/env node
// A stand-in for cloud-sql-proxy in the tests: takes the same flags, prints
// the same readiness lines, and forwards every connection on --address:--port
// to the TCP address in FAKE_UPSTREAM (or the instance name's region field
// when it is host_port, e.g. `p:127.0.0.1_3306:i`). An instance whose name
// ends in `-denied` fails the connection test the way a missing
// roles/cloudsql.client does.
import net from "node:net";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("cloud-sql-proxy version 0.0.0+fake"); process.exit(0); }
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const address = flag("--address", "127.0.0.1");
const port = Number(flag("--port", "5432"));
const instance = argv.filter((a, i) => !a.startsWith("-") && !(argv[i - 1] ?? "").match(/^--(address|port|credentials-file|structured-logs)$/)).at(-1) ?? "";
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19).replace(/-/g, "/");
const say = (m) => console.log(`${ts()} ${m}`);

const upstream = process.env.FAKE_UPSTREAM || instance.split(":")[1]?.replace("_", ":") || "";
const [uh, up] = upstream.split(":");
const srv = net.createServer((c) => {
  const u = net.connect({ host: uh, port: Number(up) });
  c.pipe(u); u.pipe(c);
  c.on("error", () => u.destroy()); u.on("error", () => c.destroy());
});
srv.listen(port, address, () => {
  say(`Authorizing with the credentials file at "${flag("--credentials-file", "?")}"`);
  say(`[${instance}] Listening on ${address}:${port}`);
  say("The proxy has started successfully and is ready for new connections!");
  if (argv.includes("--run-connection-test")) {
    say("Connection test started");
    if (/-denied$/.test(instance)) {
      say("Connection test failed");
      say(`The proxy has encountered a terminal error: fetch ephemeral cert failed: googleapi: Error 403: boss::NOT_AUTHORIZED: Not authorized to access resource. Possibly missing permission cloudsql.instances.connect on resource instances/${instance.split(":")[2]}., forbidden`);
      process.exit(1);
    }
    say("Connection test passed");
  }
});
process.on("SIGTERM", () => { say("SIGTERM signal received. Shutting down..."); process.exit(0); });

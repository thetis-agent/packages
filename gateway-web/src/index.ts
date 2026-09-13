// Web gateway: boots the kernel in-process and serves the browser UI, the JSON API, and the event stream.
// `serve` runs the server; `passwd` sets a user's password. Authentication is this package's concern.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, loadConfig, UserStore } from "@thetis/kernel";
import { GatewayStore } from "./store.js";
import { createGateway } from "./server.js";

export { createGateway, type GatewayOptions, type SessionSummary } from "./server.js";
export { GatewayStore } from "./store.js";
export { TurnHub, type TurnMessage, type RunningTurn } from "./turns.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PACKAGE = "@thetis/gateway-web";

const HELP = `thetis-web - web gateway for Thetis

usage: thetis-web <command> [options]

  serve [--host <addr>] [--port <n>]     start the server (default 127.0.0.1:8777)
  passwd <user> [--password <text>]      set a user's password; without --password, reads one line from stdin

Configuration: config.packages["${PACKAGE}"] = { "host", "port" } in thetis.config.json. Flags override it.
Set THETIS_WEB_SECURE=1 to mark the login cookie Secure behind TLS.
env: THETIS_HOME (data dir), OPENROUTER_API_KEY. A .env in the cwd and in the repository root is loaded.
`;

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

export async function run(argv: string[]): Promise<void> {
  loadDotEnv(resolve(process.cwd(), ".env"));
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parse(argv);
  const cmd = args._[0];
  if (!cmd || cmd === "help" || args.help) return void process.stdout.write(HELP);
  const home = resolve(PROJECT_ROOT, String(process.env.THETIS_HOME ?? resolve(process.env.HOME ?? ".", ".thetis")));
  const config = loadConfig(home, PROJECT_ROOT);
  const store = new GatewayStore(resolve(home, "gateway-web"));

  if (cmd === "passwd") {
    const user = args._[1];
    if (!user) throw new Error("passwd needs a user id");
    if (!new UserStore(home).get(user)) throw new Error(`unknown user ${user}; create it with: thetis users add ${user}`);
    const password = typeof args.password === "string" ? args.password : (await readLine()).trim();
    await store.setPassword(user, password);
    store.revokeUser(user);
    process.stdout.write(`password set for ${user}\n`);
    return;
  }

  if (cmd === "serve") {
    const own = (config.packages[PACKAGE] ?? {}) as { host?: string; port?: number };
    const host = typeof args.host === "string" ? args.host : (own.host ?? "127.0.0.1");
    const port = typeof args.port === "string" ? Number(args.port) : (own.port ?? 8777);
    const kernel = createKernel(config);
    const server = createGateway(kernel, store);
    await new Promise<void>((done, fail) => server.once("error", fail).listen(port, host, done));
    process.stdout.write(`thetis-web listening on http://${host}:${port}\n`);
    const stop = async () => {
      server.close();
      await kernel.shutdown();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }

  throw new Error(`unknown command: ${cmd}\n${HELP}`);
}

function readLine(): Promise<string> {
  return new Promise((done) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => done(data.split("\n")[0] ?? ""));
  });
}

function parse(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) (out[key] = next), i++;
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

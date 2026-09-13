// The guest side of the fence. One instance per userspace, booted by the kernel's fence.
// It loads package modules from the userspace store and runs steps, tools, enumerators
// and providers on the kernel's behalf. Protocol: newline-delimited JSON on stdin/stdout.
import { exec as cpExec } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type {
  EnumeratorContext, ExecOptions, KernelClient, PackageInfo, PackageQuery, PackageStepContext,
  Provider, ProviderCall, ProviderEvent, SessionInfo, StepContext, StepEnv, StepResult, ToolEnv,
} from "@thetis/kernel";

const ROOT = process.env.THETIS_USERSPACE ?? process.cwd();
const HOME = process.env.THETIS_HOME_DIR ?? ROOT;
const STORE = process.env.THETIS_STORE ?? resolve(ROOT, "store");
const MAX_OUTPUT = 30_000;

const writeOut = process.stdout.write.bind(process.stdout);
for (const k of ["log", "info", "debug"] as const) console[k] = (...a: unknown[]) => console.error(...a);
const send = (m: unknown) => void writeOut(JSON.stringify(m) + "\n");

// ---- kernel RPC (fence -> kernel) ----
const rpcPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let rpcSeq = 0;
function rpc<T = unknown>(method: string, args?: unknown): Promise<T> {
  return new Promise<T>((res, rej) => {
    const id = `k${++rpcSeq}`;
    rpcPending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
    send({ rpc: id, method, args });
  });
}

const kernel: KernelClient = {
  packages: {
    install: (source) => rpc("packages.install", { source }),
    uninstall: (name) => rpc("packages.uninstall", { name }),
    list: () => rpc("packages.list"),
  },
  sessions: {
    create: (parent) => rpc("sessions.create", { parent }),
    ask: (session, input) => rpc("sessions.ask", { session, input }),
    list: () => rpc("sessions.list"),
  },
};

// ---- environment handed to package code ----
function exec(cmd: string, opts: ExecOptions = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    const cwd = opts.cwd ? resolve(HOME, opts.cwd) : HOME;
    const env = { ...process.env, ...(opts.env ?? {}) };
    cpExec(cmd, { cwd, env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, shell: "/bin/bash" }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      res({ code, stdout: cap(String(stdout)), stderr: cap(String(stderr) + (err && !stderr ? `\n${err.message}` : "")) });
    });
  });
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n...[truncated ${s.length - MAX_OUTPUT} chars]` : s;
}

const env: StepEnv = {
  cwd: HOME,
  root: ROOT,
  store: STORE,
  exec,
  readFile: (p) => readFile(resolve(HOME, p), "utf8"),
  writeFile: async (p, content) => {
    const file = resolve(HOME, p);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  },
  kernel,
};

function packageQuery(list: PackageInfo[]): PackageQuery {
  return {
    has: (name) => list.some((p) => p.name === name),
    get: (name) => list.find((p) => p.name === name),
    list: (type) => (type ? list.filter((p) => p.type === type) : list),
  };
}

// ---- module loading from the userspace store ----
async function loadExport(pkg: string, name: string): Promise<(...a: unknown[]) => unknown> {
  const dir = resolve(STORE, "node_modules", pkg);
  const manifest = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8")) as { main?: string };
  const main = resolve(dir, manifest.main ?? "index.js");
  const { mtimeMs } = await stat(main);
  const mod = (await import(`${pathToFileURL(main).href}?v=${mtimeMs}`)) as Record<string, unknown>;
  const fn = mod[name];
  if (typeof fn !== "function") throw new Error(`${pkg} does not export a function named "${name}"`);
  return fn as (...a: unknown[]) => unknown;
}

const providers = new Map<string, Promise<Provider>>();
function provider(pkg: string, exp: string, config: unknown): Promise<Provider> {
  const key = `${pkg}#${exp}:${JSON.stringify(config)}`;
  let p = providers.get(key);
  if (!p) {
    p = loadExport(pkg, exp).then((factory) => factory(config) as Provider);
    providers.set(key, p);
  }
  return p;
}

// ---- operations the kernel dispatches ----
type Emit = (event: unknown) => void;
type Payload = Record<string, any>;

const ops: Record<string, (p: Payload, emit: Emit) => Promise<unknown>> = {
  ping: async () => "pong",
  exec: (p) => exec(String(p.cmd), { cwd: p.cwd, timeoutMs: p.timeoutMs }),
  step: async (p) => {
    const fn = await loadExport(p.package, p.export);
    const wire = p.ctx as StepContext;
    const ctx: PackageStepContext = { ...wire, packages: packageQuery(wire.packages), env };
    const result = (await fn(ctx)) as StepResult | undefined;
    if (!result) return null;
    return { conversation: result.conversation, call: result.call, harness: result.harness };
  },
  tool: async (p) => {
    const fn = await loadExport(p.package, p.export);
    const toolEnv: ToolEnv = { ...env, session: p.session as SessionInfo, config: p.config ?? {} };
    return fn(p.args ?? {}, toolEnv);
  },
  enumerate: async (p) => {
    const fn = await loadExport(p.package, p.export);
    const ctx: EnumeratorContext = { session: p.ctx.session, packages: packageQuery(p.ctx.packages), phases: p.ctx.phases };
    return fn(ctx);
  },
  "provider.models": async (p) => (await provider(p.package, p.export, p.config)).models(),
  "provider.call": async (p, emit) => {
    const prov = await provider(p.package, p.export, p.config);
    for await (const e of prov.call(p.call as ProviderCall)) emit(e as ProviderEvent);
    return null;
  },
};

async function dispatch(msg: Payload): Promise<void> {
  const { id, op, payload } = msg as { id: string; op: string; payload: Payload };
  const handler = ops[op];
  try {
    if (!handler) throw new Error(`unknown op: ${op}`);
    const result = await handler(payload ?? {}, (event) => send({ id, event }));
    send({ id, result: result === undefined ? null : result });
  } catch (err) {
    send({ id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg: Payload;
  try {
    msg = JSON.parse(line);
  } catch {
    return console.error(`agent: bad line ${line.slice(0, 80)}`);
  }
  if (typeof msg.rpcResult === "string") {
    const p = rpcPending.get(msg.rpcResult);
    rpcPending.delete(msg.rpcResult);
    if (!p) return;
    if (msg.error) p.reject(new Error(String(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  void dispatch(msg);
});
process.stdin.on("end", () => process.exit(0));

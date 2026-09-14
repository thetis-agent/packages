// The guest side of the fence. One instance per userspace, booted by the kernel's fence.
// It loads package modules from the userspace store and runs steps, tools, enumerators
// and providers on the kernel's behalf. Protocol: newline-delimited JSON on stdin/stdout.
import { exec as cpExec } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  EnumeratorContext, ExecOptions, KernelClient, PackageInfo, PackageQuery, PackageStepContext,
  Provider, ProviderCall, ProviderEvent, ServiceEnv, ServiceHandle, SessionInfo, StepContext, StepEnv, StepResult, ToolEnv, TurnEvent,
} from "@thetis/contracts";
import { encodeFrame, PendingCalls, readFrames, type Frame } from "@thetis/lib/rpc-frames";

const ROOT = process.env.THETIS_USERSPACE ?? process.cwd();
const HOME = process.env.THETIS_HOME_DIR ?? ROOT;
const STORE = process.env.THETIS_STORE ?? resolve(ROOT, "store");
const SHARED = process.env.THETIS_SHARED ?? resolve(ROOT, "shared");
const MAX_OUTPUT = 30_000;

const writeOut = process.stdout.write.bind(process.stdout);
for (const k of ["log", "info", "debug"] as const) console[k] = (...a: unknown[]) => console.error(...a);
const send = (m: unknown) => void writeOut(encodeFrame(m));

// ---- kernel RPC (fence -> kernel) ----
// `{ rpcEvent }` lines stream to `onEvent` before the `{ rpcResult }` line settles the call.
const rpcPending = new PendingCalls("k");
function rpc<T = unknown>(method: string, args?: unknown, onEvent?: (e: unknown) => void): Promise<T> {
  const { id, result } = rpcPending.open({ onEvent });
  send({ rpc: id, method, args });
  return result as Promise<T>;
}

const kernel: KernelClient = {
  packages: {
    install: (source) => rpc("packages.install", { source }),
    uninstall: (name) => rpc("packages.uninstall", { name }),
    list: () => rpc("packages.list"),
  },
  operator: {
    call: (method, args, onEvent) => rpc(`operator.${method}`, args ?? {}, onEvent),
  },
  sessions: {
    create: (parent) => rpc("sessions.create", { parent }),
    ask: (session, input) => rpc("sessions.ask", { session, input }),
    send: (session, input, onEvent, opts) => rpc("sessions.send", { session, input, model: opts?.model }, (e) => onEvent(e as TurnEvent)),
    cancel: (session) => rpc("sessions.cancel", { session }),
    list: () => rpc("sessions.list"),
    inspect: (session) => rpc("sessions.inspect", { session }),
  },
  models: () => rpc("models"),
  auth: {
    login: (id, password) => rpc("auth.login", { id, password }),
    authenticate: (token) => rpc("auth.authenticate", { token }),
    logout: (token) => rpc("auth.logout", { token }),
  },
};

// ---- environment handed to package code ----
function exec(cmd: string, opts: ExecOptions = {}, signal?: AbortSignal) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    const cwd = opts.cwd ? resolve(HOME, opts.cwd) : HOME;
    const env = { ...process.env, ...(opts.env ?? {}) };
    cpExec(cmd, { cwd, env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, shell: "/bin/bash", signal }, (err, stdout, stderr) => {
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
  shared: SHARED,
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
// Each request carries an AbortSignal. The kernel sends `{ cancel: <id> }` to abort it; `exec` kills its
// process and `provider.call` stops reading the stream, which closes the provider's iterator.
type Emit = (event: unknown) => void;

/** What each operation carries. The kernel is the only sender; the shapes are the contracts' own types. */
interface ExportRef {
  package: string;
  export: string;
}
interface Payloads {
  ping: Record<string, never>;
  exec: { cmd: string; cwd?: string; timeoutMs?: number };
  step: ExportRef & { ctx: StepContext };
  tool: ExportRef & { args?: Record<string, unknown>; session: SessionInfo; config?: Record<string, unknown> };
  enumerate: ExportRef & { ctx: { session: SessionInfo; packages: PackageInfo[]; phases: string[] } };
  "service.start": ExportRef & { config?: Record<string, unknown> };
  "service.stop": { package: string };
  "provider.models": ExportRef & { config: unknown };
  "provider.call": ExportRef & { config: unknown; call: ProviderCall };
}
type Op = keyof Payloads;
type Handler<K extends Op> = (p: Payloads[K], emit: Emit, signal: AbortSignal) => Promise<unknown>;

const ops: { [K in Op]: Handler<K> } = {
  ping: async () => "pong",
  exec: (p, _emit, signal) => exec(p.cmd, { cwd: p.cwd, timeoutMs: p.timeoutMs }, signal),
  step: async (p) => {
    const fn = await loadExport(p.package, p.export);
    const ctx: PackageStepContext = { ...p.ctx, packages: packageQuery(p.ctx.packages), env };
    const result = (await fn(ctx)) as StepResult | undefined;
    if (!result) return null;
    return { conversation: result.conversation, call: result.call, harness: result.harness };
  },
  tool: async (p) => {
    const fn = await loadExport(p.package, p.export);
    const toolEnv: ToolEnv = { ...env, session: p.session, config: p.config ?? {} };
    return fn(p.args ?? {}, toolEnv);
  },
  enumerate: async (p) => {
    const fn = await loadExport(p.package, p.export);
    const ctx: EnumeratorContext = { session: p.ctx.session, packages: packageQuery(p.ctx.packages), phases: p.ctx.phases };
    return fn(ctx);
  },
  "service.start": async (p) => {
    if (services.has(p.package)) return "running";
    const fn = await loadExport(p.package, p.export);
    const serviceEnv: ServiceEnv = { ...env, config: p.config ?? {}, log: (line) => console.error(`[${p.package}] ${line}`) };
    services.set(p.package, (await fn(serviceEnv)) as ServiceHandle | void);
    return "started";
  },
  "service.stop": async (p) => {
    const handle = services.get(p.package);
    services.delete(p.package);
    await handle?.stop?.();
    return "stopped";
  },
  "provider.models": async (p) => (await provider(p.package, p.export, p.config)).models(),
  "provider.call": async (p, emit, signal) => {
    const prov = await provider(p.package, p.export, p.config);
    for await (const e of prov.call(p.call)) {
      if (signal.aborted) break;
      emit(e as ProviderEvent);
    }
    return null;
  },
};

function isOp(op: string): op is Op {
  return Object.hasOwn(ops, op);
}

const inflight = new Map<string, AbortController>();
/** Running services by package name. They live as long as this process, which is as long as the fence. */
const services = new Map<string, ServiceHandle | void>();

async function dispatch(msg: Frame): Promise<void> {
  const { id, op, payload } = msg as { id: string; op: string; payload?: unknown };
  const control = new AbortController();
  inflight.set(id, control);
  try {
    if (!isOp(op)) throw new Error(`unknown op: ${op}`);
    // The frame was read once at the boundary; the kernel built it from the contracts' types, so the
    // payload is trusted to be the shape the operation declares.
    const handler = ops[op] as Handler<Op>;
    const result = await handler((payload ?? {}) as Payloads[Op], (event) => send({ id, event }), control.signal);
    send({ id, result: result === undefined ? null : result });
  } catch (err) {
    // The stack goes back whole: package code failed, and its author needs the trace.
    send({ id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  } finally {
    inflight.delete(id);
  }
}

readFrames(process.stdin, (msg) => {
  if (typeof msg.cancel === "string") return void inflight.get(msg.cancel)?.abort();
  if (typeof msg.rpcEvent === "string") return void rpcPending.receive({ id: msg.rpcEvent, event: msg.event });
  if (typeof msg.rpcResult === "string") return void rpcPending.receive({ ...msg, id: msg.rpcResult });
  void dispatch(msg);
}, (line) => console.error(`agent: bad line ${line.slice(0, 80)}`));
process.stdin.on("end", () => process.exit(0));

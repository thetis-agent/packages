// What package code sees inside the fence: the environment, the kernel client, and the shapes of a step, a tool,
// a service, a provider, and an enumerator. The userspace agent builds these; package authors implement them.
import type { ModelChoices, ModelDescriptor, ProviderCall, ProviderEvent } from "./messages.js";
import type { PackageInfo } from "./packages.js";
import type { AuthUser, SessionInfo, SessionRecord, SessionSummaryRef } from "./identity.js";
import type { StepContext, StepResult, TurnEvent, TurnOptions } from "./pipeline.js";

export interface PackageQuery {
  has(name: string): boolean;
  get(name: string): PackageInfo | undefined;
  list(type?: string): PackageInfo[];
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** Filesystem, processes and the kernel, all scoped to the fence. */
export interface StepEnv {
  cwd: string;
  root: string;
  store: string;
  /** The shared directory: written by the system userspace, read by every fence. */
  shared: string;
  exec(cmd: string, opts?: ExecOptions): Promise<{ code: number; stdout: string; stderr: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  kernel: KernelClient;
}

/**
 * The kernel as seen from inside a fence. Identity is the fence: every call acts as the userspace's
 * own user. `operator.call` runs a control method (the table the command line uses) and is allowed
 * when that user is an admin. `auth.login` is for the system userspace; `auth.authenticate` answers a
 * fence only about its own user.
 */
export interface KernelClient {
  packages: {
    install(source: string): Promise<PackageInfo>;
    uninstall(name: string): Promise<void>;
    list(): Promise<PackageInfo[]>;
  };
  operator: {
    call<T = unknown>(method: string, args?: Record<string, unknown>, onEvent?: (event: unknown) => void): Promise<T>;
  };
  sessions: {
    create(parent?: string): Promise<SessionSummaryRef>;
    ask(session: string, input: string): Promise<string>;
    send(session: string, input: string, onEvent: (event: TurnEvent) => void, opts?: TurnOptions): Promise<void>;
    cancel(session: string): Promise<boolean>;
    list(): Promise<SessionSummaryRef[]>;
    inspect(session: string): Promise<SessionRecord & { status: "idle" | "running" }>;
  };
  /** The models the fence's own providers serve, and the default. */
  models(): Promise<ModelChoices>;
  auth: {
    login(id: string, password: string): Promise<{ token: string; user: AuthUser } | null>;
    authenticate(token: string): Promise<AuthUser | null>;
    logout(token: string): Promise<void>;
  };
}

export interface PackageStepContext extends Omit<StepContext, "packages"> {
  packages: PackageQuery;
  env: StepEnv;
}

export type Step = (ctx: PackageStepContext) => Promise<StepResult | void>;

export interface ToolEnv extends StepEnv {
  session: SessionInfo;
  config: Record<string, unknown>;
}

export type Tool = (args: Record<string, unknown>, env: ToolEnv) => Promise<string | object>;

export interface ServiceEnv extends StepEnv {
  config: Record<string, unknown>;
  log(line: string): void;
}

export interface ServiceHandle {
  stop?(): Promise<void> | void;
}

/** The export a `service` declaration names. Runs inside the agent process of its userspace. */
export type Service = (env: ServiceEnv) => Promise<ServiceHandle | void>;

export interface Provider {
  models(): Promise<ModelDescriptor[]>;
  call(call: ProviderCall): AsyncIterable<ProviderEvent>;
}

export interface EnumeratorContext {
  session: SessionInfo;
  packages: PackageQuery;
  phases: string[];
}

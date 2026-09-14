// Kernel vocabulary. The kernel knows users, userspaces, sessions, pipelines,
// the three variables, and packages. Nothing else.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  package: string;
  export: string;
}

/** The parameterized provider request. Built by steps, executed by the built-in call step. */
export interface ProviderCall {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  params: Record<string, unknown>;
  /** Provider hints, keyed by concern (for example `cache`). Never sent to the API; a provider reads the keys it understands. */
  hints?: Record<string, unknown>;
}

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "error"; message: string };

export interface ModelDescriptor {
  id: string;
  name?: string;
  provider?: string;
}

export type HarnessState = Record<string, unknown>;

/** A reference to a step the enumerator scheduled: a package export, or the kernel built-in. */
export interface StepRef {
  package: string;
  export: string;
  id?: string;
  phase?: string;
}

export const KERNEL_PACKAGE = "@thetis/kernel";
export const PROVIDER_CALL_STEP = "provider-call";

export interface StepDecl {
  id: string;
  phase: string;
  export: string;
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: JsonSchema;
  export: string;
}

export interface ThetisField {
  type: string;
  steps?: StepDecl[];
  tools?: ToolDecl[];
  export?: string;
  /** A long-running process the userspace agent starts when the fence opens and stops on uninstall. */
  service?: { export: string };
  publish?: { port: number; to: string }[];
}

export interface Manifest {
  name: string;
  version: string;
  /** One sentence on what the package does. Shown wherever the package is listed. */
  description?: string;
  main?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  thetis: ThetisField;
}

export interface PackageInfo {
  name: string;
  version: string;
  type: string;
  description: string;
  root: string;
  thetis: ThetisField;
  /** True when every person gets this package: it is in `systemPackages["*"]`, promoted, or marked for everyone. */
  everyone?: boolean;
}

export interface SessionInfo {
  id: string;
  user: string;
  parent?: string;
}

export interface TurnInfo {
  id: string;
  input: Message[];
}

/** What every step sees. Serialized into the fence; mutations come back as a StepResult. */
export interface StepContext {
  session: SessionInfo;
  turn: TurnInfo;
  conversation: Message[];
  call: ProviderCall;
  harness: HarnessState;
  packages: PackageInfo[];
  config: Record<string, unknown>;
}

export type StepResult = Partial<Pick<StepContext, "conversation" | "call" | "harness">>;

/** What a caller may set for one turn. */
export interface TurnOptions {
  model?: string;
}

/** The models a userspace can call, and the configured default. */
export interface ModelChoices {
  model: string;
  models: ModelDescriptor[];
}

export type TurnEvent =
  | { type: "turn.start"; turn: string; session: string }
  | { type: "step.start"; step: StepRef }
  | { type: "step.end"; step: StepRef; ms: number }
  | { type: "text"; delta: string }
  | { type: "tool.call"; call: ToolCall }
  | { type: "tool.result"; id: string; name: string; result: string }
  | { type: "message"; message: Message; usage?: Record<string, number> }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "error"; message: string; code?: string }
  | { type: "turn.end"; turn: string; session: string };

export type UserRole = "system" | "admin" | "user";
export type UserStatus = "active" | "suspended";

export interface UserRecord {
  id: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  user: string;
  parent?: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  conversation: Message[];
  harness: HarnessState;
}

export interface Userspace {
  id: string;
  root: string;
  home: string;
  store: string;
  sessions: string;
  /** Sockets a service of this userspace listens on. The door reaches them from the host. */
  run: string;
}

export interface PackageRecord {
  name: string;
  version: string;
  type: string;
  owner: string;
  source: { kind: "system" | "local" | "git"; ref: string };
  userspaces: string[];
  /** A shipped system package an admin made the default: every new person's userspace is seeded with it. */
  everyone?: boolean;
}

export const SYSTEM_USER = "_system";
export const SYSTEM_SCOPE = "@thetis";

// ---- What package code sees inside the fence (built by the userspace agent) ----

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

export interface SessionSummaryRef {
  id: string;
  user: string;
  parent?: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
}

export interface AuthUser {
  id: string;
  role: UserRole;
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

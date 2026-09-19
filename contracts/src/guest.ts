// What package code sees inside the fence: the environment, the kernel client, and the shapes of a step, a tool,
// a service, a provider, and an enumerator. The userspace agent builds these; package authors implement them.
import type { ModelChoices, ModelDescriptor, ProviderCall, ProviderEvent } from "./messages.js";
import type { DeletedPackage, PackageInfo } from "./packages.js";
import type { AuthUser, SessionInfo, SessionRecord, SessionSummaryRef, UserRole } from "./identity.js";
import type { StepContext, StepResult, TurnEvent, TurnOptions, WatchedTurnEvent } from "./pipeline.js";
import type { ConfigReport } from "./config.js";
import type { Store } from "./storage.js";

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
  /**
   * Documents this package keeps, in the service-plane store, under a namespace the kernel prefixes with
   * the fence's user and this package's name: a package reaches only what it wrote, and a delete of the
   * package or of the user clears it. `namespace` names a sub-namespace, default `default`.
   */
  storage(namespace?: string): Store;
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
    /** Uninstalls a package of the fence's own scope and deletes its files under the home. Restores what it replaced. */
    delete(name: string): Promise<DeletedPackage>;
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
    /**
     * Every turn event of every session of this person, from the moment of the call: turns started by
     * anyone, subagents included. Resolves when the fence closes. A caller that wants the events for as
     * long as it lives calls once and never awaits it.
     */
    watch(onEvent: (m: WatchedTurnEvent) => void): Promise<void>;
  };
  /** The models the fence's own providers serve, and the default. */
  models(): Promise<ModelChoices>;
  /**
   * This person's own configuration layer for a package installed in this fence. `show` reports every key's
   * state with secrets redacted; `set` and `unset` change the person's layer, secrets included, and the kernel
   * refuses a key the package declared `scope: "system"`. `effective` is what that package's code receives,
   * secrets included: the fence is one person's authority, so a package in it may load another's config the
   * way the web gateway runs another package's UI commands.
   */
  config: {
    show(name: string): Promise<ConfigReport>;
    set(name: string, key: string, value: unknown): Promise<ConfigReport>;
    unset(name: string, key: string): Promise<ConfigReport>;
    effective(name: string): Promise<Record<string, unknown>>;
  };
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
  /** Aborted when the turn is stopped while the tool runs. A tool that started something stops it here. */
  signal?: AbortSignal;
}

export type Tool = (args: Record<string, unknown>, env: ToolEnv) => Promise<string | object>;

/** What a UI command handler receives: the fence environment, who asked, and which conversation is on screen. */
export interface UiCommandEnv extends StepEnv {
  user: string;
  role: UserRole;
  /** The session the page named, already checked to be the person's own. */
  session?: string;
  /** The configuration of the package that declared the command, as its steps and tools receive it. */
  config: Record<string, unknown>;
}
export type UiCommandResult = { text?: string; data?: unknown } | string | void;
/** The export a `ui.commands[]` entry names. The web gateway calls it when the package's own page asks. */
export type UiCommand = (args: Record<string, unknown>, env: UiCommandEnv) => Promise<UiCommandResult>;

/** What a streaming handler receives on top of a command's: the life of the subscription. */
export interface UiStreamEnv extends UiCommandEnv {
  /** Aborted when the browser closes the subscription. A handler that waits should stop when it fires. */
  signal: AbortSignal;
}
/** The export a `ui.commands[]` entry with `stream: true` names. Each value it yields is one event on the page. */
export type UiStream = (args: Record<string, unknown>, env: UiStreamEnv) => AsyncIterable<unknown>;

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

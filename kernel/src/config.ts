import { resolve } from "node:path";
import type { StepRef } from "@thetis/contracts";
import { readJson, writeJson } from "@thetis/lib/json";

export interface FenceConfig {
  sandbox: "auto" | "bwrap" | "none";
  network: "auto" | "egress" | "none" | "host";
  limits: { memoryMb: number; pids: number; cpuPercent: number };
  /** Host paths every fence may read besides the OS. */
  readOnly: string[];
  /** Host paths masked inside every fence. */
  hidden: string[];
  /**
   * Whether every fence is given the host's Docker socket. `auto` binds one when the kernel can use it,
   * `on` binds it whether or not the probe passes, `off` never does. Socket access is host root: see
   * `packages/sandbox/src/docker.ts` and [12-security.md](../../../docs/12-security.md) section 3.
   */
  docker: "auto" | "on" | "off";
  /** The host Docker socket to bind, when it is not in one of the usual places. */
  dockerSocket?: string;
}

export interface KernelConfig {
  /** Service-plane data directory: users, registry, userspaces. */
  home: string;
  /** Where the shipped @thetis/* packages live. */
  systemPackagesDir: string;
  /** Where promoted packages live: user packages made the default for everyone. Derived: `<home>/packages`. */
  promotedPackagesDir: string;
  /** Writable by the system userspace, read-only in every other fence. Derived: `<home>/shared`. */
  sharedDir: string;
  /** Path of the userspace agent entry the fence boots. */
  agentPath: string;
  model: string;
  phases: string[];
  callPhase: string;
  enumerator?: StepRef;
  /** System packages installed into userspaces: "*" applies to every userspace, a user id to that one. */
  systemPackages: Record<string, string[]>;
  /** The file layer of per-package configuration. `${VAR}` references stay as written; the config service resolves them at read time. */
  packages: Record<string, Record<string, unknown>>;
  /** The storage driver: a package of type `storage`, loaded by the host, never installed into a fence. */
  storage: { driver: string };
  /** The `.env` file whose variables `${VAR}` references resolve against. Derived: `<projectRoot>/.env`. */
  envFile: string;
  fence: FenceConfig;
  /** The door: the one host port, which routes to the login target and to each person's gateway socket. */
  door: { host: string; port: number };
  /** The restart Thetis may ask for: whether this installation allows one at all, and the two clocks that make it safe. */
  control: { allowRestart: boolean; minUptimeSecs: number; quietWaitMs: number };
  requestTimeoutMs: number;
}

/** The approved extensions, indexed at their latest. An install takes a copy and pins the commit it took. */
export const MARKETPLACE_URL = "https://github.com/thetis-agent/packages.git";

const DEFAULT_PACKAGES: Record<string, Record<string, unknown>> = {
  "@thetis/provider-openrouter": { apiKey: "${OPENROUTER_API_KEY}", baseUrl: "https://openrouter.ai/api/v1" },
  "@thetis/marketplace": { registries: [{ name: "thetis", url: MARKETPLACE_URL }] },
  "@thetis/skills-hybrid": { embeddings: { apiKey: "${OPENROUTER_API_KEY}" } },
};

/** The file layer as it is on disk now: the defaults under what `thetis.config.json` says. `config.reload` reads it again. */
export function packagesLayer(home: string): Record<string, Record<string, unknown>> {
  return { ...DEFAULT_PACKAGES, ...(readJson<Partial<KernelConfig>>(configPath(home), {}).packages ?? {}) };
}

export function defaultConfig(home: string, projectRoot: string): KernelConfig {
  return {
    home,
    systemPackagesDir: resolve(projectRoot, "packages"),
    promotedPackagesDir: resolve(home, "packages"),
    sharedDir: resolve(home, "shared"),
    agentPath: resolve(projectRoot, "packages/userspace-agent/dist/src/agent.js"),
    model: "anthropic/claude-sonnet-5",
    phases: ["history", "prompt", "tools", "call", "after"],
    callPhase: "call",
    systemPackages: {
      "*": ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache", "@thetis/tools-files", "@thetis/tools-plan", "@thetis/terminal", "@thetis/gateway-web", "@thetis/ui-tools", "@thetis/ui-context", "@thetis/projects", "@thetis/ui-admin", "@thetis/ui-marketplace", "@thetis/skills", "@thetis/skills-thetis", "@thetis/skills-hybrid", "@thetis/ui-skills"],
      _system: ["@thetis/provider-openrouter", "@thetis/gateway-login", "@thetis/marketplace"],
    },
    packages: structuredClone(DEFAULT_PACKAGES),
    storage: { driver: "@thetis/store-toml" },
    envFile: resolve(projectRoot, ".env"),
    fence: {
      sandbox: "auto",
      network: "auto",
      limits: { memoryMb: 1024, pids: 512, cpuPercent: 200 },
      readOnly: [resolve(projectRoot, "packages"), resolve(projectRoot, "node_modules"), resolve(home, "packages")],
      hidden: [home],
      docker: "auto",
    },
    door: { host: "127.0.0.1", port: 8777 },
    control: { allowRestart: true, minUptimeSecs: 60, quietWaitMs: 120_000 },
    requestTimeoutMs: 600_000,
  };
}

export function configPath(home: string): string {
  return resolve(home, "thetis.config.json");
}

/**
 * Loads config from disk over the defaults, interpolating ${ENV_VAR} references from the environment.
 * `packages` is the exception: it keeps its references, because the config service resolves them on
 * every read, so a variable that arrives later is seen without a restart.
 */
export function loadConfig(home: string, projectRoot: string, env: NodeJS.ProcessEnv = process.env): KernelConfig {
  const defaults = defaultConfig(home, projectRoot);
  const stored = readJson<Partial<KernelConfig>>(configPath(home), {});
  const { packages, ...rest } = stored;
  const merged: KernelConfig = {
    ...defaults,
    ...rest,
    home,
    envFile: defaults.envFile,
    storage: { ...defaults.storage, ...(stored.storage ?? {}) },
    fence: {
      ...defaults.fence,
      ...(stored.fence ?? {}),
      limits: { ...defaults.fence.limits, ...(stored.fence?.limits ?? {}) },
    },
    door: { ...defaults.door, ...(stored.door ?? {}) },
    control: { ...defaults.control, ...(stored.control ?? {}) },
  };
  return { ...interpolate(merged, env), packages: { ...defaults.packages, ...(packages ?? {}) } };
}

/** Writes the config without derived paths, so the file stays valid when the checkout moves. */
export function saveConfig(config: KernelConfig): void {
  const { home, systemPackagesDir, promotedPackagesDir, sharedDir, agentPath, envFile, fence, ...portable } = config;
  writeJson(configPath(home), {
    ...portable,
    fence: { sandbox: fence.sandbox, network: fence.network, limits: fence.limits, docker: fence.docker, ...(fence.dockerSocket ? { dockerSocket: fence.dockerSocket } : {}) },
  });
}

function interpolate<T>(value: T, env: NodeJS.ProcessEnv): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => env[name] ?? "") as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, env);
    return out as T;
  }
  return value;
}

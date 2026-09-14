import { resolve } from "node:path";
import { readJson, writeJson } from "./util.js";
import type { StepRef } from "./types.js";

export interface KernelConfig {
  /** Service-plane data directory: users, registry, userspaces. */
  home: string;
  /** Where the shipped @thetis/* packages live. */
  systemPackagesDir: string;
  /** Where promoted packages live: user packages made the default for everyone. Derived: `<home>/packages`. */
  promotedPackagesDir: string;
  /** Path of the userspace agent entry the fence boots. */
  agentPath: string;
  model: string;
  phases: string[];
  callPhase: string;
  enumerator?: StepRef;
  /** System packages installed into userspaces: "*" applies to every userspace, a user id to that one. */
  systemPackages: Record<string, string[]>;
  /** Per-package configuration handed to that package's steps, tools and providers. */
  packages: Record<string, Record<string, unknown>>;
  fence: { sandbox: "auto" | "bwrap" | "none"; readOnly: string[]; hidden: string[] };
  maxToolRounds: number;
  requestTimeoutMs: number;
}

export function defaultConfig(home: string, projectRoot: string): KernelConfig {
  return {
    home,
    systemPackagesDir: resolve(projectRoot, "packages"),
    promotedPackagesDir: resolve(home, "packages"),
    agentPath: resolve(projectRoot, "packages/userspace-agent/dist/src/agent.js"),
    model: "anthropic/claude-sonnet-5",
    phases: ["history", "prompt", "tools", "call", "after"],
    callPhase: "call",
    systemPackages: {
      "*": ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache"],
      _system: ["@thetis/provider-openrouter"],
    },
    packages: {
      "@thetis/provider-openrouter": { apiKey: "${OPENROUTER_API_KEY}", baseUrl: "https://openrouter.ai/api/v1" },
    },
    fence: { sandbox: "auto", readOnly: [resolve(projectRoot, "packages"), resolve(projectRoot, "node_modules"), resolve(home, "packages")], hidden: [home] },
    maxToolRounds: 40,
    requestTimeoutMs: 600_000,
  };
}

export function configPath(home: string): string {
  return resolve(home, "thetis.config.json");
}

/** Loads config from disk over the defaults, interpolating ${ENV_VAR} references from the environment. */
export function loadConfig(home: string, projectRoot: string, env: NodeJS.ProcessEnv = process.env): KernelConfig {
  const defaults = defaultConfig(home, projectRoot);
  const stored = readJson<Partial<KernelConfig>>(configPath(home), {});
  const merged = { ...defaults, ...stored, home, fence: { ...defaults.fence, ...(stored.fence ?? {}) } };
  return interpolate(merged, env) as KernelConfig;
}

/** Writes the config without derived paths, so the file stays valid when the checkout moves. */
export function saveConfig(config: KernelConfig): void {
  const { home, systemPackagesDir, promotedPackagesDir, agentPath, fence, ...portable } = config;
  writeJson(configPath(home), { ...portable, fence: { sandbox: fence.sandbox } });
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

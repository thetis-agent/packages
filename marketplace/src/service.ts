// The service: refresh on start and on a timer. The registries come from this package's configuration.

import type { Service } from "@thetis/contracts";
import type { Registry } from "./index-file.js";
import { refresh } from "./mirror.js";

const DEFAULT_MINUTES = 30;

export function registriesOf(config: Record<string, unknown>): Registry[] {
  const raw = Array.isArray(config.registries) ? config.registries : [];
  return raw
    .filter((r): r is { name?: unknown; url?: unknown } => !!r && typeof r === "object")
    .filter((r) => typeof r.url === "string" && r.url.trim())
    .map((r) => ({ name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : String(r.url).split("/").pop()!.replace(/\.git$/, ""), url: String(r.url).trim() }));
}

export const startService: Service = async (env) => {
  const registries = registriesOf(env.config);
  const minutes = typeof env.config.refreshMinutes === "number" && env.config.refreshMinutes > 0 ? env.config.refreshMinutes : DEFAULT_MINUTES;
  const tick = async () => {
    try {
      const index = await refresh(env, registries);
      const failed = index.registries.filter((r) => r.error);
      env.log(`indexed ${index.packages.length} packages from ${registries.length} registries${failed.length ? `; failed: ${failed.map((r) => `${r.name} (${r.error})`).join(", ")}` : ""}`);
    } catch (err) {
      env.log(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await tick();
  const timer = setInterval(() => void tick(), minutes * 60_000);
  return { stop: () => clearInterval(timer) };
};

// The three configuration keys, read into the shapes the rest of the package uses. A malformed target is
// refused by name rather than skipped: a target that quietly is not there is a publish that goes nowhere,
// and going nowhere silently is the thing this package was written to stop.
import { resolve } from "node:path";
import { refuse } from "./refuse.js";
import { slugOfUrl } from "@thetis/runtime/lib/git-url";

export const DEFAULT_WORK_DIR = "publish";

// A real command a person can run, which is why this one keeps its shape: there is nothing else to say
// when the answer to "where may I publish?" is "nowhere, and somebody has to decide that first".
const EXAMPLE = `thetis config set @thetis/package-publish targets --json '[{"name":"thetis","url":"git@github.com:thetis-agent/packages.git"}]'`;

export function targetsOf(config) {
  const raw = config?.targets;
  if (raw !== undefined && !Array.isArray(raw)) refuse("config", `targets in @thetis/package-publish is not a list. Each target is { name, url, branch? }. Set it with: ${EXAMPLE}`);
  return (raw ?? []).map((t, i) => {
    if (!t || typeof t !== "object" || Array.isArray(t)) refuse("config", `targets[${i}] in @thetis/package-publish is not an object. Each target is { name, url, branch? }.`);
    const url = typeof t.url === "string" ? t.url.trim() : "";
    if (!url) refuse("config", `targets[${i}] in @thetis/package-publish has no url, so there is no registry to publish to. Each target is { name, url, branch? }.`);
    const name = typeof t.name === "string" && t.name.trim() ? t.name.trim() : slugOfUrl(url);
    const branch = typeof t.branch === "string" && t.branch.trim() ? t.branch.trim() : null;
    return { name, url, branch };
  });
}

/** The target named, or the only one when there is one. Both refusals name what is configured. */
export function pickTarget(config, to) {
  const targets = targetsOf(config);
  const names = targets.map((t) => t.name).join(", ");
  if (!targets.length) refuse("no-targets", `No publish target is configured for @thetis/package-publish, so there is nowhere to publish. Somebody has to add one first: ${EXAMPLE}`);
  const asked = to === undefined || to === null ? "" : String(to).trim();
  if (!asked) {
    if (targets.length === 1) return targets[0];
    refuse("ambiguous-target", `More than one publish target is configured (${names}). Say which of them to publish to.`);
  }
  const found = targets.find((t) => t.name === asked);
  if (!found) refuse("unknown-target", `There is no publish target called ${asked}. The configured targets are ${names}.`);
  return found;
}

/** Where the clones live. Relative to the person's home, which is where a fence can write. */
export function workDirOf(env, config) {
  const raw = typeof config?.workDir === "string" && config.workDir.trim() ? config.workDir.trim() : DEFAULT_WORK_DIR;
  return resolve(env.cwd, raw);
}

export function verifyOf(config) {
  return typeof config?.verify === "string" && config.verify.trim() ? config.verify.trim() : null;
}

/** A target's name as a directory and a storage key: one segment, nothing that could climb out of either. */
export const safeName = (name) => String(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 64) || "registry";

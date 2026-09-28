// The tool exports: each takes the model's arguments and the ToolEnv, runs one operation in this
// chat's browser context, and returns text. A thrown error reaches the model as `error: …`.

import { settings, sessionKey, withSession, peekSessions, browserInfo, closeSession, closeAll, findExecutable, playwrightVersion } from "./core.js";
import { ops } from "./ops.js";
import { render, shortError } from "./render.js";

function run(op) {
  return async (args, env) => {
    const cfg = settings(env?.config);
    const key = sessionKey(env, cfg);
    try {
      const out = await withSession(key, cfg, (s) => ops[op](s, args ?? {}, cfg, env));
      return render(out);
    } catch (e) {
      throw new Error(shortError(e));
    }
  };
}

export const browserNavigate = run("navigate");
export const browserSnapshot = run("snapshot");
export const browserClick = run("click");
export const browserHover = run("hover");
export const browserType = run("type");
export const browserWait = run("wait");
export const browserEvaluate = run("evaluate");
export const browserScreenshot = run("screenshot");
export const browserConsole = run("console");
export const browserNetwork = run("network");
export const browserTabs = run("tabs");
export const browserState = run("state");

export async function browserClose(args, env) {
  const cfg = settings(env?.config);
  const key = sessionKey(env, cfg);
  const closed = await closeSession(key);
  return closed
    ? "closed this chat's browser: its tabs, cookies and storage are gone. The next browser_navigate starts clean."
    : "this chat had no browser open; nothing to close.";
}

export async function browserStatus(args, env) {
  const cfg = settings(env?.config);
  const info = browserInfo();
  const key = sessionKey(env, cfg);
  const sessions = peekSessions();
  const mine = sessions.get(key);
  const lines = [
    `browser: ${info.running ? `running, Chrome ${info.version}` : "not running (it starts on the first browser_navigate and stops when idle; that is normal)"}`,
    `executable: ${info.executable ?? findExecutable(cfg) ?? "none found; Playwright's own download would be tried"}`,
    `playwright-core: ${playwrightVersion() ?? "not installed"}`,
    `headless: ${cfg.headless}`,
    `this chat: ${mine ? `${mine.pages.length} tab(s), active ${mine.active}${mine.pages[mine.active] ? `: ${mine.pages[mine.active].url()}` : ""}` : "no browser open"}${key !== (env?.session?.id ?? key) ? " (shared with the parent chat)" : ""}`,
    `open contexts in this space: ${sessions.size}`,
    `timeout: ${cfg.timeoutMs} ms, idle close: ${cfg.idleMinutes} min, viewport: ${cfg.viewportWidth}×${cfg.viewportHeight}`,
    `policy: ${[
      cfg.allowHosts.length ? `allowHosts ${cfg.allowHosts.join(", ")}` : "",
      cfg.denyHosts.length ? `denyHosts ${cfg.denyHosts.join(", ")}` : "",
      cfg.blockPrivateNetworks ? "private networks blocked" : "",
    ].filter(Boolean).join("; ") || "any host"}`,
  ];
  return lines.join("\n");
}

/** A service only so the browser is closed when the space stops or the package is updated. */
export async function startService(env) {
  return { stop: async () => { const n = await closeAll(); env?.log?.(`closed the browser (${n} context(s))`); } };
}

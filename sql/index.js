// @thetis/sql: MySQL and PostgreSQL as tools, direct or through the Cloud SQL
// Auth Proxy. Every tool function under the name package.json's "export"
// field uses, plus the service that stops idle proxies.
import { reapIdle, stopProxies } from "./lib/proxy.js";

export {
  status as sqlStatus,
  schemas as sqlSchemas,
  tables as sqlTables,
  describe as sqlDescribe,
  query as sqlQuery,
  execute as sqlExecute,
  proxy as sqlProxy,
} from "./lib/tools.js";
export * as sqltext from "./lib/sqltext.js";

/**
 * Stops proxies idle longer than `proxyIdleMinutes`, once a minute. When the
 * space stops or this package is updated, the proxies are left running: the
 * next call finds them through their state files, and a stop would only make
 * the first query after an update pay for a fresh start. Uninstalling the
 * package stops them, since nothing would ever reap them after.
 */
export async function startService(env) {
  const tick = async () => {
    try {
      const gone = await reapIdle(env);
      for (const g of gone) env?.log?.(`stopped the idle Cloud SQL proxy for ${g.instance} (${g.mode})`);
    } catch (e) { env?.log?.(`idle check failed: ${e?.message ?? e}`); }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  tick();
  return {
    stop: async () => {
      clearInterval(timer);
      // The kernel does not say why a service stops. A package that is no longer installed is an
      // uninstall; anything else (a reload, an update, the space closing) leaves the proxies up.
      let installed = true;
      try {
        const list = await env?.kernel?.packages?.list?.();
        if (Array.isArray(list)) installed = list.some((p) => /^@[a-z0-9-]+\/sql$/.test(p.name));
      } catch { /* cannot tell: leave them */ }
      if (!installed) {
        const n = await stopProxies(env).catch(() => []);
        env?.log?.(`stopped ${n.length} proxy(ies): the package was uninstalled`);
      }
    },
  };
}

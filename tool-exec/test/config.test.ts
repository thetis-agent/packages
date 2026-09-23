import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConfigReport, PackageInfo, ToolEnv } from "@thetis/runtime/contracts";
import { configurePackage, packageConfig } from "../src/index.js";

const SECRET = "sk-live-do-not-echo";

interface Call {
  method: string;
  args: unknown[];
}

/** A fake kernel that records config calls and answers `report`, and lists `packages` as installed. */
function envWith(report: ConfigReport, packages: Partial<PackageInfo>[] = []): { env: ToolEnv; calls: Call[] } {
  const calls: Call[] = [];
  const record = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return report;
  };
  const kernel = {
    config: { show: record("show"), set: record("set"), unset: record("unset"), effective: async () => ({}) },
    packages: { list: async () => packages as PackageInfo[] },
  };
  return { env: { kernel } as unknown as ToolEnv, calls };
}

const report: ConfigReport = {
  package: "@alice/notion",
  user: "alice",
  inherits: ["@thetis/notion"],
  summary: "database is required and not set",
  broken: true,
  keys: [
    { key: "token", state: "set", redacted: true, source: "user", secret: true, declared: true, type: "string", required: true, help: "The integration token." },
    { key: "baseUrl", state: "set", value: "https://api.notion.com", source: "default", inheritedFrom: "@thetis/notion", secret: false, declared: true, type: "string" },
    { key: "database", state: "missing", secret: false, declared: true, type: "string", required: true, help: "The database id." },
    { key: "proxy", state: "missing", value: "${PROXY_URL}", source: "user", missing: ["PROXY_URL"], secret: false, declared: false },
    { key: "retries", state: "unset", secret: false, declared: true, type: "number" },
  ],
};

test("package_config lays out the summary, the chain, one line per key and the help; a secret is dots", async () => {
  const { env, calls } = envWith(report);
  const text = String(await packageConfig({ name: "@alice/notion" }, env));
  assert.deepEqual(calls, [{ method: "show", args: ["@alice/notion"] }]);
  assert.equal(
    text,
    [
      "@alice/notion: database is required and not set",
      "inherits @thetis/notion",
      "token: set [user] = •••",
      "  The integration token.",
      'baseUrl: set [default, inherited from @thetis/notion] = "https://api.notion.com"',
      "database: missing",
      "  The database id.",
      'proxy: missing [user] = "${PROXY_URL}" (PROXY_URL not in the environment) (undeclared)',
      "retries: unset",
    ].join("\n"),
  );
});

test("configure_package sets the key and replies with its state and the summary, never the value", async () => {
  const { env, calls } = envWith({ ...report, summary: "every key is set", broken: false });
  const text = String(await configurePackage({ name: "@alice/notion", key: "token", value: SECRET }, env));
  assert.deepEqual(calls, [{ method: "set", args: ["@alice/notion", "token", SECRET] }]);
  assert.equal(text, "set token on @alice/notion: now set [user]. @alice/notion: every key is set.");
  assert.ok(!text.includes(SECRET));
});

test("json: true parses the value; a bad document is refused before the kernel sees it", async () => {
  const { env, calls } = envWith(report);
  await configurePackage({ name: "@alice/notion", key: "retries", value: "3", json: true }, env);
  assert.deepEqual(calls[0], { method: "set", args: ["@alice/notion", "retries", 3] });
  await configurePackage({ name: "@alice/notion", key: "opts", value: '{"a":[1,true]}', json: true }, env);
  assert.deepEqual(calls[1], { method: "set", args: ["@alice/notion", "opts", { a: [1, true] }] });
  await assert.rejects(configurePackage({ name: "@alice/notion", key: "opts", value: "{nope", json: true }, env), /not valid JSON/);
  await assert.rejects(configurePackage({ name: "@alice/notion", key: "opts" }, env), /value is required/);
  assert.equal(calls.length, 2);
});

test("unset removes the key from the person's layer and says what the key falls back to", async () => {
  const { env, calls } = envWith(report);
  const text = String(await configurePackage({ name: "@alice/notion", key: "baseUrl", unset: true, value: "ignored" }, env));
  assert.deepEqual(calls, [{ method: "unset", args: ["@alice/notion", "baseUrl"] }]);
  assert.equal(text, "unset baseUrl on @alice/notion: now set [default, inherited from @thetis/notion]. @alice/notion: database is required and not set.");
  const gone = String(await configurePackage({ name: "@alice/notion", key: "extra", unset: true }, env));
  assert.equal(gone, "unset extra on @alice/notion: now unset. @alice/notion: database is required and not set.");
});

test("a package with a service is told the service was restarted", async () => {
  const withService = { name: "@alice/notion", thetis: { type: "tool", service: { export: "start" } } };
  const { env } = envWith(report, [withService]);
  const text = String(await configurePackage({ name: "@alice/notion", key: "token", value: SECRET }, env));
  assert.ok(text.endsWith(" The service was restarted."), text);
  assert.ok(!text.includes(SECRET));
  const { env: plain } = envWith(report, [{ name: "@alice/notion", thetis: { type: "tool" } }]);
  assert.ok(!String(await configurePackage({ name: "@alice/notion", key: "token", value: SECRET }, plain)).includes("restarted"));
});

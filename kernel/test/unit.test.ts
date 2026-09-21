import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Fences, Manifest, Message, Mount, PackageInfo, SessionRecord, StoreDriver, TurnEvent, UserRecord, Userspace, WatchedTurnEvent } from "@thetis/contracts";
import { LayeredConfig } from "@thetis/lib/config";
import { Journal } from "@thetis/lib/journal";
import { MountStore } from "@thetis/lib/mounts";
import { SessionStore } from "@thetis/lib/session-store";
import { RestartLatch, type ArmResult, type FireReport, type RestartState } from "@thetis/lib/restart";
import { memoryStore, StoreMirror } from "@thetis/lib/store";
import { UserspaceLayout } from "@thetis/lib/userspace-layout";
import { UserStore } from "../src/users.js";
import { AuthService } from "../src/auth.js";
import { ProviderRegistry } from "../src/providers.js";
import { ServiceSupervisor } from "../src/services.js";
import { ConfigService, type ConfigChange } from "../src/settings.js";
import { PackageManager } from "../src/packages/manager.js";
import { PackageRegistry } from "../src/packages/registry.js";
import { validateManifest } from "../src/packages/manifest.js";
import { Enumerator, BUILTIN_CALL } from "../src/pipeline/enumerator.js";
import { defaultConfig, saveConfig, loadConfig, packagesLayer, MARKETPLACE_URL } from "../src/config.js";
import { createControlHandler, redact } from "../src/control.js";
import { createRpcHandler, type RpcServices } from "../src/rpc.js";
import { SessionApi, SESSION_ID } from "../src/sessions/api.js";
import type { PipelineRunner } from "../src/pipeline/runner.js";
import type { KernelServices } from "../src/kernel.js";

const tmp = () => mkdtempSync(join(tmpdir(), "thetis-unit-"));
const mirror = <T extends object>(driver: StoreDriver, ns: string) => StoreMirror.open<T>(driver.open(ns, { private: ns.startsWith("auth/") }));
/** What a dispatch site sees of the configuration when the test is not about it. */
const noSettings = { effective: async () => ({}) };
const code = (want: string) => (e: { code?: string }) => e.code === want;

test("user store: create, moderate, authorize", async () => {
  const driver = memoryStore();
  const docs = await mirror<UserRecord>(driver, "users");
  const users = new UserStore(docs);
  assert.ok(users.get("_system"));
  users.create("alice");
  assert.throws(() => users.create("Alice"), /invalid user id/);
  assert.throws(() => users.create("alice"), /already exists/);
  users.setStatus("alice", "suspended");
  assert.throws(() => users.authorize("alice"), /suspended/);
  users.setStatus("alice", "active");
  assert.equal(users.setRole("alice", "admin").role, "admin");
  assert.throws(() => users.remove("_system"), /system user/);
  await docs.flush();
  assert.equal(new UserStore(await mirror<UserRecord>(driver, "users")).get("alice")?.role, "admin", "persists in the store");
  users.remove("alice");
  assert.equal(users.get("alice"), undefined);
});

test("manifest validation rejects unscoped names, a missing thetis field, and a bad config declaration", () => {
  assert.throws(() => validateManifest({ name: "foo", version: "1", thetis: { type: "tool" } }), /scoped/);
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1" } as never), /thetis/);
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1", thetis: { type: "loader", steps: [{ id: "x" } as never] } }), /phase/);
  assert.ok(validateManifest({ name: "@a/foo", version: "1", thetis: { type: "loader", steps: [{ id: "x", phase: "prompt", export: "x" }] } }));
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1", thetis: { type: "tool", config: { key: { type: "nope" } } } as never }), /@a\/foo: thetis\.config\.key: type must be one of/);
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1", thetis: { type: "tool", config: { key: { type: "number", default: "x" } } } as never }), /default/);
  assert.ok(validateManifest({ name: "@a/foo", version: "1", thetis: { type: "tool", config: { key: { type: "string", secret: true, required: true } } } }));
});

const pkgs: PackageInfo[] = [
  { name: "@a/mem", version: "1", type: "memory", description: "", root: "/x", thetis: { type: "memory", steps: [{ id: "load", phase: "prompt", export: "load" }, { id: "save", phase: "after", export: "save" }] } },
  { name: "@a/hist", version: "1", type: "loader", description: "", root: "/y", thetis: { type: "loader", steps: [{ id: "trim", phase: "history", export: "trim" }] } },
];

test("default enumerator orders steps by phase and places the built-in call last in its phase", () => {
  const e = new Enumerator(defaultConfig("/tmp/h", "/tmp/p"), undefined as never);
  const plan = e.defaultPlan(pkgs).map((s) => `${s.phase}:${s.export}`);
  assert.deepEqual(plan, ["history:trim", "prompt:load", "call:provider-call", "after:save"]);
});

test("enumerator output is validated against declared package steps", () => {
  const e = new Enumerator(defaultConfig("/tmp/h", "/tmp/p"), undefined as never);
  assert.throws(() => e.validate([{ package: "@a/mem", export: "nope" }], pkgs), /undeclared/);
  assert.throws(() => e.validate({} as never, pkgs), /array/);
  const ok = e.validate([{ package: "@a/hist", export: "trim" }, BUILTIN_CALL], pkgs);
  assert.equal(ok.length, 2);
  assert.equal(ok[1].package, "@thetis/kernel");
});

test("auth: passwords, tokens, expiry, and revocation", async () => {
  const driver = memoryStore();
  const users = new UserStore(await mirror(driver, "users"));
  users.create("alice");
  const credentials = await mirror<{ salt: string; hash: string }>(driver, "auth/credentials");
  const tokens = await mirror<{ user: string; createdAt: string }>(driver, "auth/tokens");
  const auth = new AuthService(credentials, tokens, users, 200);
  await assert.rejects(auth.setPassword("nobody", "x"), /unknown user/);
  await assert.rejects(auth.setPassword("_system", "x"), /cannot sign in/);
  await assert.rejects(auth.setPassword("alice", ""), /empty/);
  assert.equal(await auth.login("alice", "secret"), undefined, "no password yet");
  await auth.setPassword("alice", "secret");
  assert.equal(await auth.login("alice", "wrong"), undefined);
  assert.equal(await auth.login("nobody", "secret"), undefined);
  const login = await auth.login("alice", "secret");
  assert.ok(login && /^[a-f0-9]{64}$/.test(login.token));
  assert.equal(auth.authenticate(login!.token)?.id, "alice");
  await tokens.flush();
  const reopened = new AuthService(await mirror(driver, "auth/credentials"), await mirror(driver, "auth/tokens"), users);
  assert.equal(reopened.authenticate(login!.token)?.id, "alice", "tokens persist");
  users.setStatus("alice", "suspended");
  assert.equal(auth.authenticate(login!.token), undefined, "a suspended user's token is refused");
  assert.equal(await auth.login("alice", "secret"), undefined);
  users.setStatus("alice", "active");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(auth.authenticate(login!.token), undefined, "expired");
  const again = (await auth.login("alice", "secret"))!;
  await auth.setPassword("alice", "other");
  assert.equal(auth.authenticate(again.token), undefined, "a new password revokes tokens");
  const last = (await auth.login("alice", "other"))!;
  auth.logout(last.token);
  assert.equal(auth.authenticate(last.token), undefined);
});

test("config: the promoted packages directory is derived and secrets are redacted for display", () => {
  const home = tmp();
  try {
    const cfg = defaultConfig(home, "/proj");
    assert.equal(cfg.promotedPackagesDir, join(home, "packages"));
    assert.equal(cfg.envFile, join("/proj", ".env"));
    assert.equal(cfg.storage.driver, "@thetis/store-toml");
    assert.ok(cfg.fence.readOnly.includes(join(home, "packages")));
    cfg.packages["@thetis/provider-openrouter"] = { apiKey: "sk-live", baseUrl: "https://x", headers: { Authorization: "Bearer t" } };
    saveConfig(cfg);
    const raw = JSON.parse(readFileSync(join(home, "thetis.config.json"), "utf8"));
    assert.equal(raw.promotedPackagesDir, undefined);
    assert.equal(raw.envFile, undefined, "derived, so it is not written");
    assert.equal(loadConfig(home, "/other").promotedPackagesDir, join(home, "packages"));
    const shown = redact(cfg);
    assert.equal(shown.packages["@thetis/provider-openrouter"].apiKey, "•••");
    assert.equal(shown.packages["@thetis/provider-openrouter"].baseUrl, "https://x");
    assert.equal(shown.model, cfg.model);
    assert.deepEqual(shown.phases, cfg.phases);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config: packages keep their ${VAR} references while the rest is interpolated, and packagesLayer reads the file again", () => {
  const home = tmp();
  try {
    const cfg = defaultConfig(home, "/proj");
    cfg.model = "${MODEL}";
    cfg.packages["@thetis/exa"] = { apiKey: "${EXA_KEY}" };
    saveConfig(cfg);
    const loaded = loadConfig(home, "/proj", { MODEL: "m1", EXA_KEY: "sk" });
    assert.equal(loaded.model, "m1");
    assert.equal(loaded.packages["@thetis/exa"].apiKey, "${EXA_KEY}", "the config service resolves these at read time");
    assert.equal(loaded.packages["@thetis/provider-openrouter"].apiKey, "${OPENROUTER_API_KEY}");
    assert.deepEqual(packagesLayer(home)["@thetis/exa"], { apiKey: "${EXA_KEY}" });
    assert.deepEqual(packagesLayer(home)["@thetis/marketplace"], { registries: [{ name: "thetis", url: MARKETPLACE_URL }] }, "the defaults sit under the file");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config: the approved extensions are a registry a fresh install already has", () => {
  const cfg = defaultConfig("/tmp/h", "/tmp/p");
  assert.ok(cfg.systemPackages._system?.includes("@thetis/marketplace"), "the service runs in the system userspace");
  const registries = (cfg.packages["@thetis/marketplace"] as { registries: { name: string; url: string }[] }).registries;
  assert.deepEqual(registries, [{ name: "thetis", url: MARKETPLACE_URL }]);
  assert.match(MARKETPLACE_URL, /^https:\/\/github\.com\/thetis-agent\/packages\.git$/);
});

test("config: a registry url survives being saved and read back, so an operator can replace it", () => {
  const home = tmp();
  try {
    const cfg = defaultConfig(home, "/proj");
    cfg.packages["@thetis/marketplace"] = { registries: [{ name: "mine", url: "https://git.example.com/pkgs.git" }] };
    saveConfig(cfg);
    const back = loadConfig(home, "/proj");
    assert.deepEqual(back.packages["@thetis/marketplace"], { registries: [{ name: "mine", url: "https://git.example.com/pkgs.git" }] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/** A supervisor over one service package, with every fence operation and journal row recorded. */
async function supervisor(home: string) {
  const order: string[] = [];
  const configs: unknown[] = [];
  const pkg = { name: "@x/svc", version: "1", type: "service", description: "", root: "/x", thetis: { type: "service", service: { export: "startService" } } } as PackageInfo;
  const packages = { installed: () => [pkg], seedSystem: () => order.push("seed") } as unknown as PackageManager;
  const handle = { request: async (op: string) => (order.push(`${op}:${pkg.name}`), "started"), close: async () => {} };
  const fences = {
    close: async (id?: string) => void order.push(`close:${String(id)}`),
    handle: async (us: Userspace) => (order.push(`open:${us.id}`), handle),
    request: async (_us: Userspace, op: string, payload: { config?: unknown }) => (order.push(`${op}:${pkg.name}`), configs.push(payload.config), "started"),
  } as unknown as Fences;
  const userspaces = new UserspaceLayout(home);
  userspaces.ensure("alice");
  const journal = new Journal(home);
  const settings = { effective: async (_us: Userspace, name: string) => ({ for: name }) };
  const sup = new ServiceSupervisor(settings, new UserStore(await mirror(memoryStore(), "users")), userspaces, packages, fences, () => {}, journal);
  return { sup, order, configs, journal, pkg };
}

test("services.reload closes the fence first, then opens a new one and starts the services on it", async () => {
  const home = tmp();
  try {
    const { sup, order } = await supervisor(home);
    await sup.boot();
    order.length = 0;
    await sup.reload("alice");
    assert.deepEqual(order, ["close:alice", "open:alice", "service.start:@x/svc"], "the old process is gone before the new one starts");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("services.restart stops and starts one service in its fence, with the configuration as it is now, and never closes the fence", async () => {
  const home = tmp();
  try {
    const { sup, order, configs, journal } = await supervisor(home);
    await sup.restart("alice", "@x/svc");
    assert.deepEqual(order, [], "nothing runs before the supervisor is armed");
    await sup.boot();
    order.length = 0;
    await sup.restart("alice", "@x/other");
    await sup.restart("nobody", "@x/svc");
    assert.deepEqual(order, [], "only an installed service of an existing userspace restarts");
    await sup.restart("alice", "@x/svc");
    assert.deepEqual(order, ["service.stop:@x/svc", "service.start:@x/svc"]);
    assert.deepEqual(configs.at(-1), { for: "@x/svc" }, "the service starts with what the settings say now");
    assert.deepEqual(journal.tail(2, { target: "alice" }).map((r) => r.kind), ["service.start", "service.stop"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * The restart methods, against a real latch on an injected clock. The clock never moves on its own, the
 * handler records instead of exiting, and something is always in flight, so no latch here can ever come due:
 * a test that let one fire would end the test process, which is the one failure this feature cannot have.
 */
test("restart.request: an admin arms the latch, nobody else does, and every answer is a row", async () => {
  const home = tmp();
  try {
    const users = new UserStore(await mirror(memoryStore(), "users"));
    users.create("alice", "admin");
    users.create("bob");
    let clock = Date.now();
    const fired: FireReport[] = [];
    const latch = new RestartLatch({
      // The kernel's own `control` block is what the host hands the latch, so the test uses it as the daemon does.
      config: defaultConfig(home, "/proj").control,
      inFlight: () => ["bob/s_1"],
      policy: () => "always",
      env: { INVOCATION_ID: "test" },
      now: () => clock,
    });
    latch.onFire((r) => void fired.push(r));
    const k = { users, journal: new Journal(home), restart: latch, restartPolicy: () => "always" } as unknown as KernelServices;
    const control = createControlHandler(k);
    const request = (actor: string | undefined, reason?: string) => control("restart.request", { actor, reason }) as Promise<ArmResult>;
    const rows = (kind: string) => k.journal.tail(50, { kind });

    await assert.rejects(request("alice"), /needs a reason/, "a restart with no stated reason cannot be asked for");
    // Refused for being young: the refusal is the latch's own sentence, and the row says which guard spoke.
    const young = await request("alice", "trying it out");
    assert.equal(young.state, "refused");
    assert.equal(young.why, "young");
    assert.match(young.message, /Nothing was armed and nothing is going to happen/);
    assert.equal(latch.status().pending, undefined);
    assert.deepEqual(rows("restart.refused")[0].data, { reason: "trying it out", why: "young" });
    assert.equal(rows("restart.refused")[0].actor, "alice");

    clock += 61_000;
    // A user and the system userspace are both refused here, not by `rpc.ts`, which admits any non-user.
    await assert.rejects(request("bob", "new code"), code("unauthorized"));
    await assert.rejects(request("_system", "new code"), code("unauthorized"));
    assert.equal(latch.status().pending, undefined, "a refused caller arms nothing");
    assert.equal(rows("restart.armed").length, 0, "and leaves no row saying it did");

    const armed = await request("alice", "new kernel code");
    assert.equal(armed.state, "armed");
    assert.equal(armed.pending?.reason, "new kernel code");
    assert.match(armed.message, /A restart is armed: new kernel code \(asked by alice\)/);
    const row = rows("restart.armed")[0];
    assert.equal(row.actor, "alice");
    assert.equal(row.target, "daemon");
    assert.deepEqual(row.data, { reason: "new kernel code" });

    // Asking again is two requests meeting, not a fault: it arms nothing further and says so.
    const again = await request("alice", "new kernel code");
    assert.equal(again.state, "again");
    assert.equal(rows("restart.again").length, 1);
    assert.equal(latch.status().pending?.at, armed.pending?.at, "still the first one");

    const shown = (await control("restart.status", {})) as RestartState & { policy: string | null };
    assert.equal(shown.pending?.by, "alice");
    assert.equal(shown.policy, "always", "and what the deployed unit says, which decides whether it would come back");

    assert.deepEqual(await control("restart.cancel", { actor: "alice" }), { cancelled: true, was: armed.pending });
    assert.equal(latch.status().pending, undefined);
    assert.deepEqual(rows("restart.cancel")[0].data, { reason: "new kernel code", by: "alice" });
    assert.deepEqual(await control("restart.cancel", {}), { cancelled: false, was: null }, "cancelling nothing is not an event");
    assert.equal(rows("restart.cancel").length, 1);
    assert.deepEqual(fired, [], "no latch fires in this process");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("providers.forget drops one userspace's cached model list, so a reloaded provider is asked again", async () => {
  let asked = 0;
  const pkg = { name: "@x/prov", version: "1", type: "provider", description: "", root: "/x", thetis: { type: "provider" } } as PackageInfo;
  const packages = { installed: () => [pkg] } as unknown as PackageManager;
  const userspaces = { exists: () => true, pathFor: (id: string) => ({ id }) } as unknown as UserspaceLayout;
  const fences = { request: async () => (asked++, [{ id: "m1" }]) } as unknown as Fences;
  const providers = new ProviderRegistry(noSettings, packages, userspaces, fences);
  const alice = { id: "alice" } as Userspace;
  assert.deepEqual(await providers.listModels(alice), [{ id: "m1", provider: "@x/prov" }]);
  await providers.listModels(alice);
  assert.equal(asked, 1, "the list is memoized in this process for five minutes");
  providers.forget("bob");
  await providers.listModels(alice);
  assert.equal(asked, 1, "another workspace's reload leaves it alone");
  providers.forget("alice");
  await providers.listModels(alice);
  assert.equal(asked, 2, "after a reload the provider is asked what it serves now");
});

test("mounts.set: validates the list, writes the store, journals the change, and reopens the fence", async () => {
  const home = tmp();
  try {
    const driver = memoryStore();
    const users = new UserStore(await mirror(driver, "users"));
    users.create("alice");
    const closed: string[] = [];
    const ensured: string[] = [];
    const docs = await mirror<{ mounts: Mount[] }>(driver, "mounts");
    const k = {
      users,
      journal: new Journal(home),
      mounts: new MountStore(docs),
      fences: { close: async (id: string) => void closed.push(id) },
      // `mounts.set` reaches the fence through `services.reload`, which is the pair below; the supervisor's
      // own reload is tested for being that pair, so the double here keeps this test about mounts.
      services: { ensure: async (id: string) => void ensured.push(id), reload: async (id: string) => { await k.fences.close(id); await k.services.ensure(id); } },
    } as unknown as KernelServices;
    const control = createControlHandler(k);
    const set = (user: string, mounts: unknown) => control("mounts.set", { user, mounts });
    await assert.rejects(set("nobody", []), code("not-found"));
    await assert.rejects(set("_system", []), /takes no mounts/);
    await assert.rejects(set("alice", "nope"), /list of at most 32/);
    await assert.rejects(set("alice", Array.from({ length: 33 }, () => ({ path: "/x", mode: "ro" }))), /at most 32/);
    for (const path of ["relative", "/a/../b", "/a/", "/a//b", "/", ""]) {
      await assert.rejects(set("alice", [{ path, mode: "rw" }]), (e: { code: string; message: string }) => e.code === "invalid" && /invalid mount path/.test(e.message), path);
    }
    await assert.rejects(set("alice", [{ path: "/srv/x", mode: "rwx" }]), /invalid mount mode/);
    await assert.rejects(set("alice", [null]), /invalid mount path/);
    assert.deepEqual(closed, [], "nothing changed until the list is valid");
    const mounts: Mount[] = [{ path: "/srv/x", mode: "ro" }, { path: home, mode: "rw" }];
    // The answer and the list say what the host holds now: the temporary home is there, /srv/x is not.
    const state = [{ path: "/srv/x", mode: "ro", present: false, kind: "none" }, { path: home, mode: "rw", present: true, kind: "dir" }];
    assert.deepEqual(await set("alice", mounts), state);
    await docs.flush();
    assert.deepEqual(new MountStore(await mirror(driver, "mounts")).get("alice"), mounts, "persisted");
    assert.deepEqual(closed, ["alice"], "the fence is closed so it reopens with the binds");
    assert.deepEqual(ensured, ["alice"], "the supervisor reopens it and restarts the services");
    const row = k.journal.tail(1, { kind: "mounts" })[0];
    assert.equal(row.target, "alice");
    assert.equal(row.actor, "operator");
    assert.deepEqual(row.data, { mounts });
    assert.deepEqual(await control("mounts.list", { user: "alice" }), { alice: state });
    assert.deepEqual(await control("mounts.list", {}), { alice: state });
    await set("alice", []);
    assert.deepEqual(await control("mounts.list", {}), {}, "an empty list removes the entry");
    // browse: the operator sees the host filesystem, and learns what a path is when it is not a directory.
    mkdirSync(join(home, "repos"));
    mkdirSync(join(home, ".hidden"));
    writeFileSync(join(home, "note.txt"), "");
    const listing = (await control("mounts.browse", { path: home })) as { entries: { name: string; path: string }[]; readable: boolean; parent: string | null };
    assert.equal(listing.readable, true);
    assert.deepEqual(listing.entries, [{ name: "repos", path: join(home, "repos") }], "directories only, and no hidden names");
    assert.equal(listing.parent, dirname(home));
    assert.equal((await control("mounts.browse", { path: "/srv/x" }) as { kind: string }).kind, "none");
    assert.equal((await control("mounts.browse", { path: join(home, "note.txt") }) as { kind: string }).kind, "file");
    await assert.rejects(control("mounts.browse", { path: "relative" }), /absolute and normalized/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * A config service over a memory store: one shipped provider with declarations, installed for the system
 * and for bob, and alice's fork of it, which declares a service. The manifests are a table; the package
 * manager is the one method the service asks of it.
 */
async function configFixture(home: string) {
  const driver = memoryStore();
  const registry = new PackageRegistry(await mirror(driver, "registry"));
  const manifests: Record<string, Manifest> = {
    "@thetis/prov": { name: "@thetis/prov", version: "1", thetis: { type: "provider", config: { apiKey: { type: "string", secret: true, required: true }, baseUrl: { type: "string", default: "https://x" }, secure: { type: "boolean", scope: "system" } } } },
    "@alice/prov2": { name: "@alice/prov2", version: "1", thetis: { type: "provider", forkedFrom: { name: "@thetis/prov", version: "1" }, service: { export: "start" } } },
  };
  const packages = { manifestOf: (_us: Userspace, name: string) => manifests[name] } as unknown as PackageManager;
  const prov = { name: "@thetis/prov", version: "1", type: "provider", owner: "_system", source: { kind: "system" as const, ref: "/x" } };
  registry.record(prov, "_system");
  registry.record(prov, "bob");
  registry.record({ name: "@alice/prov2", version: "1", type: "provider", owner: "alice", source: { kind: "local", ref: "p" }, forkedFrom: { name: "@thetis/prov", version: "1" } }, "alice");
  const journal = new Journal(home);
  const userspaces = new UserspaceLayout(home);
  const env = { snapshot: () => ({ PROV_KEY: "from-env" }) };
  let settings!: ConfigService;
  const layers = new LayeredConfig(driver, () => settings.filePackages);
  settings = new ConfigService({ "@thetis/prov": { apiKey: "${PROV_KEY}" } }, layers, env, packages, registry, userspaces, journal);
  const changes: ConfigChange[] = [];
  settings.onChange(async (c) => void changes.push(c));
  return { driver, registry, settings, journal, userspaces, changes };
}

test("config service: who may set what, where a secret lands, what the journal keeps, and who is told", async () => {
  const home = tmp();
  try {
    const { driver, settings, journal, userspaces, changes } = await configFixture(home);
    const prov = "@thetis/prov";
    await assert.rejects(settings.set({ name: prov, user: "bob" }, "secure", true, "bob", true), code("unauthorized"), "a fence never sets a system-scoped key");
    await assert.rejects(settings.set({ name: prov, user: "bob" }, "secure", true, "operator"), code("unauthorized"), "nor does anyone at a person's layer");
    await assert.rejects(settings.set({ name: prov }, "secure", true, "operator", true), code("unauthorized"));
    await assert.rejects(settings.set({ name: prov }, "baseUrl", null, "operator"), code("invalid"));
    await assert.rejects(settings.set({ name: prov }, "baseUrl", 5, "operator"), /declared string/);
    await assert.rejects(settings.set({ name: "@nobody/none" }, "k", "v", "operator"), code("not-found"));
    assert.equal(changes.length, 0, "a refused set tells nobody");

    const shown = await settings.set({ name: prov, user: "bob" }, "apiKey", "sk-bob", "bob", true);
    const key = shown.keys.find((k) => k.key === "apiKey")!;
    assert.equal(key.state, "set");
    assert.equal(key.source, "user");
    assert.equal(key.value, undefined, "the report never carries a secret");
    assert.equal(key.redacted, true);
    assert.deepEqual(await driver.open("secrets/users/bob").get(prov), { apiKey: "sk-bob" }, "a secret lands in the private namespace");
    assert.equal(await driver.open("config/users/bob").get(prov), undefined);
    const row = journal.tail(1, { kind: "config.set" })[0];
    assert.equal(row.actor, "bob");
    assert.equal(row.target, "bob");
    assert.deepEqual(row.data, { package: prov, key: "apiKey", layer: "user", secret: true }, "the row names the key and never the value");
    assert.deepEqual(changes.at(-1)?.affected, [{ user: "bob", package: prov }], "a person's layer reaches that person");

    assert.deepEqual(await settings.effective(userspaces.pathFor("bob"), prov), { apiKey: "sk-bob", baseUrl: "https://x" });
    assert.deepEqual(await settings.effective(userspaces.pathFor("_system"), prov), { apiKey: "from-env", baseUrl: "https://x" }, "the file layer's reference resolves at read time");

    await settings.set({ name: prov }, "baseUrl", "https://y", "operator");
    assert.deepEqual(journal.tail(1, { kind: "config.set" })[0].data, { package: prov, key: "baseUrl", layer: "system", secret: false });
    const affected = changes.at(-1)!.affected.map((a) => `${a.user}:${a.package}`).sort();
    assert.deepEqual(affected, ["_system:@thetis/prov", "alice:@alice/prov2", "bob:@thetis/prov"], "a system change reaches every holder and every fork");

    const fork = await settings.show({ name: "@alice/prov2", user: "alice" });
    assert.deepEqual(fork.inherits, [prov]);
    const inherited = fork.keys.find((k) => k.key === "baseUrl")!;
    assert.equal(inherited.value, "https://y");
    assert.equal(inherited.inheritedFrom, prov);
    const inheritedSecret = fork.keys.find((k) => k.key === "apiKey")!;
    assert.equal(inheritedSecret.source, "file");
    assert.equal(inheritedSecret.inheritedFrom, prov);
    assert.equal(inheritedSecret.value, "${PROV_KEY}", "a pure reference is shown as the reference, never resolved");
    assert.equal(fork.broken, false, "the origin's file layer serves the fork");
    assert.equal(fork.summary, "every key is set");
    const listed = await settings.list("bob");
    assert.deepEqual(listed.map((r) => [r.package, r.user, r.broken]), [[prov, "bob", false]]);
    assert.deepEqual((await settings.list()).map((r) => r.package).sort(), ["@alice/prov2", prov]);

    const unset = await settings.unset({ name: prov, user: "bob" }, "apiKey", "operator");
    assert.equal(unset.keys.find((k) => k.key === "apiKey")?.state, "set", "the file layer's reference is what is left");
    assert.deepEqual(journal.tail(1, { kind: "config.unset" })[0].data, { package: prov, key: "apiKey", layer: "user", secret: true });

    const before = changes.length;
    const reloaded = await settings.reload({ [prov]: { apiKey: "${PROV_KEY}", baseUrl: "https://z" } });
    assert.deepEqual(reloaded.changed, [prov]);
    assert.deepEqual(reloaded.restarted, [{ user: "alice", package: "@alice/prov2" }], "the fork declares a service; the origin does not");
    assert.equal(changes.length, before + 1, "and the listeners heard it");
    assert.deepEqual(await settings.reload({ [prov]: { apiKey: "${PROV_KEY}", baseUrl: "https://z" } }), { changed: [], restarted: [] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rpc: a fence's store stays under its own namespace, a document is capped, and configuration acts as the fence's user", async () => {
  const home = tmp();
  try {
    const { driver, settings, journal, userspaces } = await configFixture(home);
    const users = new UserStore(await mirror(driver, "users"));
    users.create("bob");
    const prov = { name: "@thetis/prov", version: "1", type: "provider", description: "", root: "/x", thetis: { type: "provider" } } as PackageInfo;
    const packages = { installed: () => [prov] } as unknown as PackageManager;
    const k = { users, packages, store: driver, settings } as unknown as RpcServices;
    const bob = createRpcHandler(userspaces.pathFor("bob"), k);
    await assert.rejects(bob("store.get", { package: "@a/pkg", namespace: "../x", key: "k" }), code("invalid"));
    await assert.rejects(bob("store.get", { package: "", key: "k" }), code("invalid"));
    await assert.rejects(bob("store.set", { package: "@a/pkg", key: "k", doc: { big: "x".repeat(257 * 1024) } }), /limit is 262144/);
    await assert.rejects(bob("store.set", { package: "@a/pkg", key: "k", doc: [1] }), /JSON object/);
    assert.equal(await bob("store.get", { package: "@a/pkg", key: "k" }), null);
    await bob("store.set", { package: "@a/pkg", key: "k", doc: { v: 1 } });
    await bob("store.set", { package: "@a/pkg", namespace: "cache", key: "k", doc: { v: 2 } });
    assert.deepEqual(await bob("store.get", { package: "@a/pkg", key: "k" }), { v: 1 });
    assert.deepEqual(await driver.open("userspaces/bob/@a/pkg/default").get("k"), { v: 1 }, "the kernel built the prefix");
    assert.deepEqual(await driver.open("userspaces/bob/@a/pkg/cache").get("k"), { v: 2 });
    assert.deepEqual(await bob("store.list", { package: "@a/pkg" }), ["k"]);
    await bob("store.delete", { package: "@a/pkg", key: "k" });
    assert.deepEqual(await bob("store.list", { package: "@a/pkg" }), []);
    await bob("store.clear", { package: "@a/pkg", namespace: "cache" });
    assert.equal(await bob("store.get", { package: "@a/pkg", namespace: "cache", key: "k" }), null);

    await assert.rejects(bob("config.show", { name: "@alice/prov2" }), code("not-found"), "not installed in this fence");
    await assert.rejects(bob("config.set", { name: "@thetis/prov", key: "secure", value: true }), code("unauthorized"));
    const report = (await bob("config.set", { name: "@thetis/prov", key: "baseUrl", value: "https://b" })) as { keys: { key: string; source?: string }[] };
    assert.equal(report.keys.find((k) => k.key === "baseUrl")?.source, "user");
    const row = journal.tail(1, { kind: "config.set" })[0];
    assert.equal(row.actor, "bob", "the fence's user is the actor");
    assert.equal(row.target, "bob");
    assert.deepEqual(await bob("config.effective", { name: "@thetis/prov" }), { apiKey: "from-env", baseUrl: "https://b" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("packages: a storage driver is refused an install, and manifestOf reads the link or the shipped directory", async () => {
  const home = tmp();
  try {
    const driver = memoryStore();
    const registry = new PackageRegistry(await mirror(driver, "registry"));
    const config = defaultConfig(home, "/proj");
    config.systemPackagesDir = join(home, "system");
    mkdirSync(join(config.systemPackagesDir, "shipped"), { recursive: true });
    writeFileSync(join(config.systemPackagesDir, "shipped", "package.json"), JSON.stringify({ name: "@thetis/shipped", version: "1", thetis: { type: "tool" } }));
    const manager = new PackageManager(config, registry, {} as Fences);
    const us = new UserspaceLayout(home).ensure("alice");
    const dir = join(us.home, "packages", "drv");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@alice/drv", version: "1", thetis: { type: "storage", export: "createStore" } }));
    const alice = { id: "alice", role: "user", status: "active", createdAt: "" } as const;
    await assert.rejects(manager.install(us, alice, "packages/drv"), (e: { code: string; message: string }) => e.code === "invalid" && /runs on the host/.test(e.message));
    assert.equal(registry.get("@alice/drv"), undefined);
    assert.equal(manager.manifestOf(us, "@thetis/shipped")?.name, "@thetis/shipped", "the shipped directory, though nothing links it yet");
    assert.equal(manager.manifestOf(us, "@thetis/none"), undefined);
    manager.installSystem(us, "@thetis/shipped");
    assert.equal(manager.manifestOf(us, "@thetis/shipped")?.name, "@thetis/shipped");
    assert.equal(registry.get("@thetis/shipped")?.forkedFrom, undefined);
    assert.ok(!("forkedFrom" in registry.get("@thetis/shipped")!), "a record holds no undefined: the store would refuse it");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sessions.watch: every turn of the user reaches the watcher with its session, parent and input, whoever started it; the signal removes it", async () => {
  const home = tmp();
  try {
    const driver = memoryStore();
    const users = new UserStore(await mirror(driver, "users"));
    users.create("bob");
    users.create("eve");
    const packages = { installed: () => [{}], seedSystem: () => {} } as unknown as PackageManager;
    const runner = {
      runTurn: async (_us: Userspace, session: SessionRecord, input: Message[], emit: (e: TurnEvent) => void) => {
        emit({ type: "turn.start", turn: "t1", session: session.id });
        emit({ type: "message", message: { role: "assistant", content: `re: ${input[0].content}` } });
        emit({ type: "turn.end", turn: "t1", session: session.id });
        return session;
      },
    } as unknown as PipelineRunner;
    const api = new SessionApi(users, new UserspaceLayout(home), packages, new SessionStore(SESSION_ID), runner);
    const root = api.create("bob");
    const child = api.create("bob", { parent: root.id });
    assert.deepEqual(api.list("bob").map((s) => [s.id, s.first, s.running]), [[root.id, "", false], [child.id, "", false]], "a list answers from the index, with what each session first said and whether it is running");
    const seen: WatchedTurnEvent[] = [];
    const control = new AbortController();
    const done = api.watch("bob", (m) => seen.push(m), control.signal);
    assert.throws(() => api.watch("nobody", () => {}), code("unauthorized"), "a watch is authorized like every other call");
    assert.equal(await api.ask("bob", child.id, "do it"), "re: do it");
    assert.deepEqual(
      seen.map((m) => [m.session, m.parent, m.input, m.event.type]),
      [
        [child.id, root.id, "do it", "turn.start"],
        [child.id, root.id, undefined, "message"],
        [child.id, root.id, undefined, "turn.end"],
      ],
      "a subagent's turn is stamped with its parent, and the input rides on turn.start only",
    );
    await api.ask("bob", root.id, [{ role: "user", content: "as messages" }]);
    assert.equal(seen.length, 6);
    assert.equal(seen[3].parent, undefined, "a root session has no parent");
    assert.equal(seen[3].input, undefined, "input is reported only when the turn was sent as text");
    const eve = api.create("eve");
    await api.ask("eve", eve.id, "hers");
    assert.equal(seen.length, 6, "another user's turns are not bob's to see");
    control.abort();
    await done;
    await api.ask("bob", root.id, "again");
    assert.equal(seen.length, 6, "the aborted signal removed the watcher");
    // Over the RPC handler: the fence's own user, the event as the emit, and the handler's signal ends it.
    const k = { users, sessions: api } as unknown as RpcServices;
    const rpc = createRpcHandler(new UserspaceLayout(home).pathFor("bob"), k);
    const life = new AbortController();
    const over: WatchedTurnEvent[] = [];
    const settled = rpc("sessions.watch", {}, (m) => over.push(m as WatchedTurnEvent), life.signal);
    await api.ask("bob", root.id, "through rpc");
    assert.equal(over.length, 3);
    assert.equal(over[0].session, root.id);
    life.abort();
    assert.equal(await settled, undefined, "the watch settles when the fence is gone");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

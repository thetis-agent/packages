// The Registries section's commands: which git registries `@thetis/marketplace` mirrors, and how this
// installation authenticates to each. Every verb here is `role: "admin"` in the manifest, so the gateway
// answers 403 to anybody else before this code runs, and every one goes through `env.kernel.operator.call`,
// which the kernel allows only from an admin's fence -- the same two gates `@thetis/ui-admin` stands behind.
//
// Authentication is derived, never recorded. A registry "uses SSH" exactly when `@thetis/host-grants` holds
// a repository key for its url (`sameRepository`); there is no `auth` field in the marketplace
// configuration, because a setting that records an intention says "SSH" while the key it names is gone.
// So the list is the merge of two facts the kernel holds -- the `registries` key and the repository keys --
// plus the index's word on the last refresh, and every write changes one of those facts and nothing else.
//
// A registry is named by its `name` in every verb after `registry-add`: the url is read back from the
// configuration here, so the browser can never point a key operation at a repository that is not a
// configured registry. URL parsing is `@thetis/runtime/lib/git-url`'s and nobody else's; the page receives
// what it needs already worked out (the deploy-key link, whether a url can carry a key at all).
import { readIndex } from "@thetis/marketplace";
import { parseHosted, repoRoute, sameRepository, slugOfUrl } from "@thetis/runtime/lib/git-url";

export const MARKETPLACE = "@thetis/marketplace";
const KEY = "registries";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const URL_LIMIT = 512;
const MATERIAL_LIMIT = 16 * 1024;
const REGISTRY_LIMIT = 32;

function fail(message) {
  throw new Error(message);
}

const call = (env, method, args = {}) => env.kernel.operator.call(method, args);

/** A registry name as the index and its README directories can carry it. */
function nameOf(value) {
  if (typeof value !== "string" || !NAME.test(value.trim())) fail("a registry name is letters, digits, dots, dashes and underscores, up to 64 characters");
  return value.trim();
}

/** A git url: one line, no spaces, not absurdly long. What it means is git-url's to say. */
function urlOf(value) {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url) fail("a registry needs a url");
  if (url.length > URL_LIMIT || /\s/.test(url)) fail("a registry url is one git url, without spaces");
  return url;
}

/** Checked for shape only; the refusals name the rule, never the text, so a key never lands in a toast or a log. */
function privateKeyOf(value) {
  if (typeof value !== "string" || !value.trim()) fail("the private key is missing");
  if (value.length > MATERIAL_LIMIT) fail("the private key is longer than 16 KB, which no key is");
  if (!value.includes("PRIVATE KEY")) fail("that does not look like a private key: no PRIVATE KEY line");
  return value;
}

/** A url a repository key can be held for: a hosted one. A local path or `file://` needs no key and cannot take one. */
function keyable(url) {
  if (!repoRoute(url)) fail(`${url} is not a hosted git url, so no key can be held for it: an SSH key needs host and path, like git@github.com:owner/repo.git`);
  return url;
}

/**
 * Where the key's public half is registered, when the host is one whose page this knows: GitHub's deploy
 * keys page for that repository. Null elsewhere; the page then says where in words.
 */
export function deployKeysUrl(url) {
  const hosted = parseHosted(url);
  return hosted?.host === "github.com" ? `https://github.com/${hosted.path}/settings/keys` : null;
}

/**
 * The configured list, as the kernel reports the system layer: the `registries` key's value, which is the
 * manifest default until an admin writes one. Entries are kept as written, extra fields included, so a
 * write that changes one registry never drops something another tool put on another.
 */
async function configured(env) {
  const report = await call(env, "config.show", { name: MARKETPLACE });
  const row = (report?.keys ?? []).find((k) => k.key === KEY);
  const raw = Array.isArray(row?.value) ? row.value : [];
  const list = raw.filter((r) => r && typeof r === "object" && typeof r.url === "string" && r.url.trim()).map((r) => ({ ...r, name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : slugOfUrl(r.url), url: r.url.trim() }));
  return { list, source: row?.source ?? "default" };
}

/** The repository keys, or an empty list and the reason when host-grants cannot answer: the registries still show. */
async function repoKeys(env) {
  try {
    const keys = await call(env, "host.grants.repoList", {});
    return { keys: Array.isArray(keys) ? keys : [], keysError: null };
  } catch (err) {
    return { keys: [], keysError: err?.message || String(err) };
  }
}

/** The index's registry states by name, or an empty map without an index. A broken index is not this page's failure. */
async function refreshStates(env) {
  try {
    const index = await readIndex(env);
    return { states: new Map((index?.registries ?? []).map((r) => [r.name, r])), updatedAt: index?.updatedAt ?? null };
  } catch {
    return { states: new Map(), updatedAt: null };
  }
}

/** The public part of a key state, as the page draws it. */
const keyView = (k) => (k ? { repo: k.repo, alias: k.alias ?? null, present: k.present !== false, publicKey: k.publicKey ?? null, fingerprint: k.fingerprint ?? null, hosts: Array.isArray(k.hosts) ? k.hosts.length : 0 } : null);

/** One registry row: what is configured, the key that authenticates it if any, and the last refresh. */
function rowOf(r, keys, states) {
  const key = keys.find((k) => sameRepository(k.repo, r.url)) ?? null;
  const state = states.get(r.name);
  return {
    name: r.name,
    url: r.url,
    auth: key ? "ssh" : "none",
    key: keyView(key),
    keyable: !!repoRoute(r.url),
    deployKeysUrl: deployKeysUrl(r.url),
    error: typeof state?.error === "string" && state.error ? state.error : null,
    commit: typeof state?.commit === "string" ? state.commit : null,
  };
}

/** The whole section's state in one answer. */
async function view(env) {
  const [{ list, source }, { keys, keysError }, { states, updatedAt }] = await Promise.all([configured(env), repoKeys(env), refreshStates(env)]);
  const registries = list.map((r) => rowOf(r, keys, states));
  // A key whose repository no registry names any more: shown, so it can be revoked, rather than held unseen.
  const orphans = keys.filter((k) => !list.some((r) => sameRepository(k.repo, r.url))).map((k) => ({ ...keyView(k), deployKeysUrl: deployKeysUrl(k.repo) }));
  return { registries, orphans, source, updatedAt, keysError };
}

/** The configured registry called `name`, or a refusal naming it. */
async function registryNamed(env, name) {
  const { list } = await configured(env);
  const r = list.find((x) => x.name === name);
  if (!r) fail(`no registry is called ${name}`);
  return { list, registry: r };
}

/** Writes the list whole, the way the admin panel writes any key: config.set at the system layer. */
async function writeList(env, list) {
  if (list.length > REGISTRY_LIMIT) fail(`at most ${REGISTRY_LIMIT} registries`);
  await call(env, "config.set", { name: MARKETPLACE, key: KEY, value: list });
}

/** Makes or takes the key for `url`: `generate` has host-grants make one, `import` hands over the pasted private key. */
async function keyFor(env, url, auth, privateKey) {
  if (auth === "generate") return call(env, "host.grants.repoKeygen", { repo: url });
  if (auth === "import") return call(env, "host.grants.repoImport", { repo: url, privateKey });
  fail("auth is none, generate or import");
}

const authOf = (value) => (value === undefined || value === null || value === "" ? "none" : ["none", "generate", "import"].includes(value) ? value : fail("auth is none, generate or import"));

/** `registries`: every configured registry with its derived authentication and last refresh, and the keys no registry names. */
export async function registries(_args, env) {
  return { data: await view(env) };
}

/**
 * `registry-add`: `{ name?, url, auth?: "none" | "generate" | "import", privateKey? }`. The key is made
 * first, so a refused key writes nothing; then the list is written with the new registry at the end. The
 * marketplace service restarts on the configuration change and refreshes, now with the key in the system
 * fence's agent.
 */
export async function registryAdd(args, env) {
  const url = urlOf(args.url);
  const auth = authOf(args.auth);
  const name = args.name === undefined || args.name === null || String(args.name).trim() === "" ? nameOf(slugOfUrl(url)) : nameOf(args.name);
  const privateKey = auth === "import" ? privateKeyOf(args.privateKey) : undefined;
  if (auth !== "none") keyable(url);
  const { list } = await configured(env);
  if (list.some((r) => r.name === name)) fail(`a registry is already called ${name}`);
  const same = list.find((r) => sameRepository(r.url, url));
  if (same) fail(`${same.name} is already that repository`);
  const key = auth === "none" ? null : await keyFor(env, url, auth, privateKey);
  await writeList(env, [...list, { name, url }]);
  return { data: { name, url, key: keyView(key), deployKeysUrl: deployKeysUrl(url), ...(await view(env)) } };
}

/**
 * `registry-edit`: `{ name, newName?, url? }`. Renames a registry or points it elsewhere. A registry holding a
 * key cannot move to another repository: the key is that repository's, so it is revoked first, on purpose.
 */
export async function registryEdit(args, env) {
  const name = nameOf(args.name);
  const { list, registry } = await registryNamed(env, name);
  const nextName = args.newName === undefined || args.newName === null || String(args.newName).trim() === "" ? name : nameOf(args.newName);
  const nextUrl = args.url === undefined || args.url === null || String(args.url).trim() === "" ? registry.url : urlOf(args.url);
  if (nextName !== name && list.some((r) => r.name === nextName)) fail(`a registry is already called ${nextName}`);
  const moved = !sameRepository(registry.url, nextUrl);
  if (moved) {
    const other = list.find((r) => r.name !== name && sameRepository(r.url, nextUrl));
    if (other) fail(`${other.name} is already that repository`);
    const { keys } = await repoKeys(env);
    if (keys.some((k) => sameRepository(k.repo, registry.url))) fail(`${name} holds a key for ${registry.url}; revoke it before pointing the registry at another repository`);
  }
  if (nextName === name && nextUrl === registry.url) fail("nothing changed");
  await writeList(env, list.map((r) => (r.name === name ? { ...r, name: nextName, url: nextUrl } : r)));
  return { data: await view(env) };
}

/**
 * `registry-remove`: `{ name, keepKey? }`. Takes the registry out of the list, then revokes its repository
 * key unless another registry still names that repository. `keepKey` keeps the key file on the host and
 * only takes it out of the system fence's agent, which is host-grants' own meaning of the flag.
 */
export async function registryRemove(args, env) {
  const name = nameOf(args.name);
  const { list, registry } = await registryNamed(env, name);
  const rest = list.filter((r) => r.name !== name);
  await writeList(env, rest);
  const { keys } = await repoKeys(env);
  const key = keys.find((k) => sameRepository(k.repo, registry.url));
  const shared = rest.some((r) => sameRepository(r.url, registry.url));
  const revoked = key && !shared ? (await call(env, "host.grants.repoRevoke", { repo: key.repo, keepKey: !!args.keepKey }), key.repo) : null;
  return { data: { removed: name, revoked, keptKey: !!(revoked && args.keepKey), ...(await view(env)) } };
}

/** `registry-key`: `{ name, auth: "generate" | "import", privateKey? }`. Gives an existing registry a key. */
export async function registryKey(args, env) {
  const name = nameOf(args.name);
  const auth = authOf(args.auth);
  if (auth === "none") fail("auth is generate or import; registry-key-revoke takes a key away");
  const privateKey = auth === "import" ? privateKeyOf(args.privateKey) : undefined;
  const { registry } = await registryNamed(env, name);
  keyable(registry.url);
  const key = await keyFor(env, registry.url, auth, privateKey);
  return { data: { name, key: keyView(key), deployKeysUrl: deployKeysUrl(registry.url), ...(await view(env)) } };
}

/**
 * `registry-key-revoke`: `{ name, keepKey? }` for a registry's key, or `{ repo, keepKey? }` for a key no
 * registry names. A `repo` must be one host-grants already holds, so this can revoke only what is shown.
 */
export async function registryKeyRevoke(args, env) {
  const { keys } = await repoKeys(env);
  let url;
  if (args.name !== undefined && args.name !== null && args.name !== "") url = (await registryNamed(env, nameOf(args.name))).registry.url;
  else if (typeof args.repo === "string" && args.repo.trim()) url = args.repo.trim();
  else fail("name the registry, or the repo of a key");
  const key = keys.find((k) => sameRepository(k.repo, url));
  if (!key) fail(`no repository key is held for ${url}`);
  await call(env, "host.grants.repoRevoke", { repo: key.repo, keepKey: !!args.keepKey });
  return { data: { revoked: key.repo, keptKey: !!args.keepKey, ...(await view(env)) } };
}

/** `registry-test`: `{ name }`. `git ls-remote` with that registry's key, on the host: ok and HEAD, or git's own words. */
export async function registryTest(args, env) {
  const { registry } = await registryNamed(env, nameOf(args.name));
  keyable(registry.url);
  const out = await call(env, "host.grants.repoTest", { repo: registry.url });
  return { data: { name: registry.name, ok: !!out?.ok, head: out?.head ?? null, error: out?.error ?? null } };
}

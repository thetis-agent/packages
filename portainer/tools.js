// The portainer_* tools. Each takes (args, env) and returns text for the
// model. Everything network goes through client.js.
//
// Portainer's model, which the tool set follows:
//   environment (an "endpoint" in the API) → a Docker host, a Swarm, or a
//              Kubernetes cluster that Portainer reaches directly, through an
//              agent, or through an edge agent
//   stack      → a compose file (Docker standalone or Swarm) or a manifest
//              (Kubernetes) that Portainer deployed into one environment, from
//              text or from a git repository
//   containers, images, volumes, networks… → the environment's own Docker,
//              reached through /endpoints/{id}/docker/…
// Ids are assigned in creation order, so environments and stacks are named by
// id or by name wherever one is taken, and a name that matches several is
// answered with the candidates.

import {
  createClient,
  clip,
  cut,
  asObject,
  bodyArg,
  requireString,
  intArg,
  boolArg,
  clampInt,
  sinceArg,
  envArg,
  listArg,
  parseFields,
  stripManagedFields,
  demuxDockerLog,
  explainError,
  bytes,
} from "./client.js";

// How Portainer reaches the environment; the platform is platformOf().
const ENV_TYPES = {
  1: "direct",
  2: "agent",
  3: "azure aci",
  4: "edge agent",
  5: "local",
  6: "agent",
  7: "edge agent",
};
const STACK_TYPES = { 1: "swarm", 2: "compose", 3: "kubernetes" };
// 3 and 4 arrived in 2.45, when deploys became asynchronous.
const STACK_STATUS = { 1: "active", 2: "inactive", 3: "deploying", 4: "failed" };
const ROLES = { 1: "administrator", 2: "standard user" };
const BLOCKED_HEADERS = new Set(["x-api-key", "authorization", "cookie", "host", "content-length"]);

// ---------------------------------------------------------------------------
// Resolution helpers.

function eqi(a, b) {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

function isId(value) {
  const n = Number(value);
  return Number.isInteger(n) && String(value).trim() === String(n) ? n : undefined;
}

function platformOf(e) {
  if (!e) return "unknown";
  if ([5, 6, 7].includes(e.Type)) return "kubernetes";
  if (e.Type === 3) return "azure";
  const snap = e.Snapshots && e.Snapshots[0];
  if (e.ContainerEngine === "podman" || (snap && snap.IsPodman)) return "podman";
  if (snap && snap.Swarm) return "swarm";
  return "docker";
}

function isEdge(e) {
  return e && (e.Type === 4 || e.Type === 7);
}

/** Up, down, or the edge heartbeat: Status means nothing for an edge agent. */
function healthOf(e) {
  if (isEdge(e)) {
    const last = e.LastCheckInDate ? new Date(e.LastCheckInDate * 1000).toISOString().slice(0, 16).replace("T", " ") : "never";
    return e.Heartbeat ? `heartbeat ok (last check-in ${last})` : `no heartbeat (last check-in ${last})`;
  }
  return e.Status === 1 ? "up" : e.Status === 2 ? "down" : `status ${e.Status}`;
}

/**
 * An environment by id or name; with none given, the package's configured
 * default, else the only environment there is.
 */
async function resolveEnv(c, value, config) {
  let v = value;
  if (v === undefined || v === null || v === "") v = config && config.environment;
  if (v !== undefined && v !== null && v !== "") {
    const id = isId(v);
    if (id !== undefined) return c.get(`/endpoints/${id}`);
    const name = String(v).trim();
    const list = await c.get("/endpoints", { search: name, excludeSnapshots: true });
    const arr = Array.isArray(list) ? list : [];
    const exact = arr.filter((e) => eqi(e.Name, name));
    const hits = exact.length ? exact : arr;
    if (hits.length === 1) return c.get(`/endpoints/${hits[0].Id}`);
    if (!hits.length) throw new Error(`no environment "${name}". List them with portainer_environments.`);
    throw new Error(`"${name}" matches ${hits.length} environments: ${hits.slice(0, 10).map((e) => `${e.Id} "${e.Name}"`).join(", ")}. Pass the id.`);
  }
  const all = await c.get("/endpoints", { excludeSnapshots: true, limit: 50 });
  const arr = Array.isArray(all) ? all : [];
  if (arr.length === 1) return c.get(`/endpoints/${arr[0].Id}`);
  if (!arr.length) throw new Error("this Portainer has no environments the token's user can see. Add one in Portainer → Environments.");
  throw new Error(
    `environment is required: there are ${arr.length}: ${arr.slice(0, 15).map((e) => `${e.Id} "${e.Name}"`).join(", ")}. ` +
      "Pass one by id or name (the person can also set a default with the package's `environment` key)."
  );
}

function requireDockerish(e, what) {
  const p = platformOf(e);
  if (p === "kubernetes") throw new Error(`${what} works on Docker environments; ${e.Id} "${e.Name}" is Kubernetes. Use portainer_kubernetes.`);
  if (p === "azure") throw new Error(`${what} works on Docker environments; ${e.Id} "${e.Name}" is Azure ACI. Use portainer_request.`);
}

/** A stack by id or name, optionally within one environment. */
async function resolveStack(c, value, envValue, config) {
  if (value === undefined || value === null || value === "") throw new Error("stack is required (a stack id or name)");
  const id = isId(value);
  if (id !== undefined) return c.get(`/stacks/${id}`);
  const name = String(value).trim();
  let envId;
  if ((envValue !== undefined && envValue !== null && envValue !== "") || (config && config.environment)) {
    envId = (await resolveEnv(c, envValue, config)).Id;
  }
  const list = await c.get("/stacks", envId !== undefined ? { filters: { EndpointID: envId } } : undefined);
  const arr = Array.isArray(list) ? list : [];
  const hits = arr.filter((s) => eqi(s.Name, name));
  if (hits.length === 1) return c.get(`/stacks/${hits[0].Id}`);
  if (hits.length > 1) {
    throw new Error(`${hits.length} stacks are named "${name}": ${hits.map((s) => `${s.Id} (environment ${s.EndpointId})`).join(", ")}. Pass the id or the environment.`);
  }
  const near = arr.filter((s) => String(s.Name).toLowerCase().includes(name.toLowerCase()));
  throw new Error(
    `no stack "${name}"${envId !== undefined ? ` in environment ${envId}` : ""}.` +
      (near.length ? ` Similar: ${near.slice(0, 10).map((s) => `${s.Id} "${s.Name}"`).join(", ")}.` : " List them with portainer_stacks.")
  );
}

function containerRef(value) {
  const s = requireString(value === undefined || value === null ? "" : String(value), "container");
  return encodeURIComponent(s.replace(/^\//, ""));
}

// ---------------------------------------------------------------------------
// Formatting.

function fmtTime(v) {
  if (v === undefined || v === null || v === "" || v === 0) return "";
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1980) return "";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function containerName(ct) {
  const n = Array.isArray(ct.Names) && ct.Names.length ? ct.Names[0] : ct.Name;
  return String(n ?? "").replace(/^\//, "");
}

function stackOfLabels(labels) {
  if (!labels) return "";
  return labels["com.docker.compose.project"] || labels["com.docker.stack.namespace"] || "";
}

function portsOf(ct) {
  const seen = new Set();
  for (const p of ct.Ports || []) {
    if (p.PublicPort) seen.add(`${p.IP && p.IP !== "0.0.0.0" && p.IP !== "::" ? `${p.IP}:` : ""}${p.PublicPort}→${p.PrivatePort}/${p.Type}`);
  }
  return [...seen].join(" ");
}

function containerLine(ct) {
  const bits = [ct.Id.slice(0, 12), containerName(ct), ct.State];
  if (ct.Status) bits.push(`(${ct.Status})`);
  bits.push(ct.Image && ct.Image.startsWith("sha256:") ? ct.Image.slice(0, 19) : ct.Image);
  const stack = stackOfLabels(ct.Labels);
  if (stack) bits.push(`[stack ${stack}]`);
  const ports = portsOf(ct);
  if (ports) bits.push(ports);
  return `- ${bits.join(" ")}`;
}

function envSummary(e, { detail = false } = {}) {
  const out = {
    id: e.Id,
    name: e.Name,
    platform: platformOf(e),
    connection: ENV_TYPES[e.Type] ?? `type ${e.Type}`,
    status: healthOf(e),
    url: e.URL || undefined,
    public_url: e.PublicURL || undefined,
    group_id: e.GroupId,
    tag_ids: Array.isArray(e.TagIds) && e.TagIds.length ? e.TagIds : undefined,
  };
  const snap = e.Snapshots && e.Snapshots[0];
  if (snap) {
    out.docker = {
      version: snap.DockerVersion,
      swarm: snap.Swarm || undefined,
      containers: `${snap.RunningContainerCount} running / ${snap.ContainerCount} total` + (snap.UnhealthyContainerCount ? `, ${snap.UnhealthyContainerCount} unhealthy` : ""),
      stopped: snap.StoppedContainerCount || undefined,
      stacks: snap.StackCount,
      images: snap.ImageCount,
      volumes: snap.VolumeCount,
      services: snap.ServiceCount || undefined,
      nodes: snap.NodeCount,
      cpus: snap.TotalCPU,
      memory: bytes(snap.TotalMemory),
      snapshot_at: fmtTime(snap.Time),
    };
  }
  const ksnap = e.Kubernetes && Array.isArray(e.Kubernetes.Snapshots) && e.Kubernetes.Snapshots[0];
  if (ksnap) {
    out.kubernetes = {
      version: ksnap.KubernetesVersion,
      nodes: ksnap.NodeCount,
      cpus: ksnap.TotalCPU,
      memory: bytes(ksnap.TotalMemory),
      snapshot_at: fmtTime(ksnap.Time),
    };
  }
  if (detail) {
    if (isEdge(e)) out.edge = { id: e.EdgeID || undefined, checkin_interval: e.EdgeCheckinInterval, last_check_in: fmtTime(e.LastCheckInDate) };
    if (e.Agent && e.Agent.Version) out.agent_version = e.Agent.Version;
    if (e.TLSConfig && e.TLSConfig.TLS) out.tls = { skip_verify: e.TLSConfig.TLSSkipVerify || undefined };
    out.link = undefined;
  }
  return out;
}

function envLine(e) {
  const s = envSummary(e);
  const bits = [`${s.id} "${s.name}"`, `${s.platform} (${s.connection})`, s.status];
  if (s.docker) bits.push(`containers ${s.docker.containers}`, `stacks ${s.docker.stacks}`);
  if (s.kubernetes) bits.push(`k8s ${s.kubernetes.version}`, `nodes ${s.kubernetes.nodes}`);
  if (s.url) bits.push(s.url);
  return `- ${bits.join(" · ")}`;
}

function stackSummary(s) {
  const out = {
    id: s.Id,
    name: s.Name,
    type: STACK_TYPES[s.Type] ?? `type ${s.Type}`,
    status: STACK_STATUS[s.Status] ?? `status ${s.Status}`,
    environment_id: s.EndpointId,
    namespace: s.Namespace || undefined,
    swarm_id: s.SwarmId || undefined,
    entry_point: s.EntryPoint || undefined,
    additional_files: Array.isArray(s.AdditionalFiles) && s.AdditionalFiles.length ? s.AdditionalFiles : undefined,
    env: Array.isArray(s.Env) && s.Env.length ? s.Env : undefined,
    created: fmtTime(s.CreationDate) || undefined,
    created_by: s.CreatedBy || undefined,
    updated: fmtTime(s.UpdateDate) || undefined,
    updated_by: s.UpdatedBy || undefined,
  };
  const g = s.GitConfig;
  if (g && g.URL) {
    out.git = {
      url: g.URL,
      ref: g.ReferenceName || undefined,
      path: g.ConfigFilePath || undefined,
      commit: g.ConfigHash ? g.ConfigHash.slice(0, 12) : undefined,
      source_id: s.SourceID || g.SourceID || undefined,
    };
    if (s.AutoUpdate && (s.AutoUpdate.Interval || s.AutoUpdate.Webhook)) {
      out.git.auto_update = { interval: s.AutoUpdate.Interval || undefined, webhook: s.AutoUpdate.Webhook ? "set" : undefined };
    }
  }
  if (s.Status === 4 && failureOf(s)) out.failure = clip(failureOf(s), 2000);
  if (s.CurrentDeploymentInfo && s.CurrentDeploymentInfo.ConfigHash) {
    out.deployed_commit = s.CurrentDeploymentInfo.ConfigHash.slice(0, 12);
  }
  return out;
}

function stackLine(s) {
  const bits = [`${s.Id} "${s.Name}"`, STACK_TYPES[s.Type] ?? `type ${s.Type}`, STACK_STATUS[s.Status] ?? `status ${s.Status}`, `env ${s.EndpointId}`];
  if (s.GitConfig && s.GitConfig.URL) bits.push(`git ${s.GitConfig.URL}${s.GitConfig.ReferenceName ? `@${s.GitConfig.ReferenceName.replace(/^refs\/heads\//, "")}` : ""}`);
  if (s.Namespace) bits.push(`ns ${s.Namespace}`);
  return `- ${bits.join(" · ")}`;
}

/** `raw`/`fields` answer the JSON; otherwise the caller's text. */
function shaped(c, args, data, text) {
  const fields = parseFields(args.fields);
  if (fields || boolArg(args.raw)) return c.view(data, fields);
  return text();
}

// ---------------------------------------------------------------------------
// Tools.

export async function health(_args, env) {
  const c = createClient(env.config);
  const out = { url: c.baseUrl };
  try {
    const v = await c.get("/system/version");
    out.version = v.ServerVersion;
    out.edition = v.ServerEdition;
    out.support = v.VersionSupport || undefined;
    if (v.UpdateAvailable) out.update_available = v.LatestVersion;
    if (v.Dependencies) out.bundled = { docker: v.Dependencies.DockerVersion, compose: v.Dependencies.ComposeVersion, helm: v.Dependencies.HelmVersion, kubectl: v.Dependencies.KubectlVersion };
  } catch (e) {
    // /system/status needs no token: it tells a bad URL from a bad token.
    try {
      const s = await c.get("/system/status");
      out.version = s.Version;
      out.token = { ok: false, error: e.message };
    } catch {
      out.reachable = false;
      out.error = e.message;
    }
    return c.out(out);
  }
  try {
    const me = await c.get("/users/me");
    out.token = { ok: true, user: { id: me.Id, username: me.Username, role: ROLES[me.Role] ?? me.Role } };
  } catch (e) {
    out.token = { ok: false, error: e.message };
  }
  try {
    const envs = await c.get("/endpoints", { excludeSnapshots: true, limit: 100 });
    if (Array.isArray(envs)) out.environments = envs.map((e) => `${e.Id} "${e.Name}" (${platformOf(e)}, ${healthOf(e)})`);
  } catch (e) {
    out.environments = `could not list: ${e.message}`;
  }
  out.package = {
    read_only: c.readOnly,
    env_values: c.exposeEnv ? "shown" : "redacted",
    default_environment: env.config && env.config.environment ? String(env.config.environment) : undefined,
  };
  return c.out(out);
}

export async function environments(args, env) {
  const c = createClient(env.config);
  if (args.environment !== undefined && args.environment !== null && args.environment !== "") {
    const e = await resolveEnv(c, args.environment, {});
    return shaped(c, args, e, () => {
      const s = envSummary(e, { detail: true });
      s.link = c.link.environment(e.Id);
      return c.out(s, `Next: portainer_stacks or portainer_containers with environment ${e.Id}.`);
    });
  }
  const limit = clampInt(args.limit, 50, 1, 500);
  const start = clampInt(args.start, 0, 0, 1_000_000);
  const query = { limit, start };
  if (args.search) query.search = String(args.search);
  const plat = args.platform ? String(args.platform).toLowerCase() : "";
  if (plat === "docker") query.types = [1, 2, 4];
  else if (plat === "kubernetes") query.types = [5, 6, 7];
  else if (plat === "edge") query.types = [4, 7];
  const list = await c.get("/endpoints", query);
  const arr = Array.isArray(list) ? list : [];
  return shaped(c, args, arr, () => {
    if (!arr.length) return `no environments${args.search ? ` match "${args.search}"` : ""}.`;
    const more = arr.length === limit ? `\n(${limit} shown from ${start}; pass start=${start + limit} for more)` : "";
    return `${arr.length} environment${arr.length === 1 ? "" : "s"}:\n${arr.map(envLine).join("\n")}${more}`;
  });
}

export async function stacks(args, env) {
  const c = createClient(env.config);
  if (args.stack !== undefined && args.stack !== null && args.stack !== "") {
    const s = await resolveStack(c, args.stack, args.environment, env.config);
    const out = stackSummary(s);
    out.link = c.link.stack(s.Id, s.Name, s.EndpointId, s.Type);
    if (s.Type !== 3) {
      try {
        const label = s.Type === 1 ? `com.docker.stack.namespace=${s.Name}` : `com.docker.compose.project=${s.Name}`;
        const cts = await c.docker(s.EndpointId, "GET", "/containers/json", { query: { all: 1, filters: { label: [label] } } });
        out.containers = (Array.isArray(cts) ? cts : []).map((ct) => containerLine(ct).slice(2));
      } catch (e) {
        out.containers = `could not list: ${clip(e.message, 200)}`;
      }
    }
    if (boolArg(args.file)) {
      const f = await c.get(`/stacks/${s.Id}/file`);
      out.file = f.StackFileContent;
    }
    const fields = parseFields(args.fields);
    if (fields || boolArg(args.raw)) return c.view(boolArg(args.file) ? { ...s, StackFileContent: out.file } : s, fields);
    return c.out(out, boolArg(args.file) ? undefined : "The compose file or manifest: pass file=true.");
  }
  let envId;
  if ((args.environment !== undefined && args.environment !== null && args.environment !== "") || (env.config && env.config.environment)) {
    envId = (await resolveEnv(c, args.environment, env.config)).Id;
  }
  const list = await c.get("/stacks", envId !== undefined ? { filters: { EndpointID: envId } } : undefined);
  let arr = Array.isArray(list) ? list : [];
  if (args.search) arr = arr.filter((s) => String(s.Name).toLowerCase().includes(String(args.search).toLowerCase()));
  return shaped(c, args, arr, () => {
    if (!arr.length) {
      return `no stacks${envId !== undefined ? ` in environment ${envId}` : ""}${args.search ? ` match "${args.search}"` : ""}. ` +
        "Compose projects started outside Portainer are not stacks it manages; portainer_containers shows their containers with [stack name].";
    }
    return `${arr.length} stack${arr.length === 1 ? "" : "s"}:\n${arr.map(stackLine).join("\n")}\n\nOne stack with its containers: portainer_stacks with stack.`;
  });
}

export async function stackDeploy(args, env) {
  const c = createClient(env.config);
  c.assertWritable("deploying a stack");
  const name = requireString(args.name, "name");
  const e = await resolveEnv(c, args.environment, env.config);
  const platform = platformOf(e);
  const compose = typeof args.compose === "string" && args.compose.trim() ? args.compose : undefined;
  const repo = typeof args.repository_url === "string" && args.repository_url.trim() ? args.repository_url.trim() : undefined;
  const sourceId = intArg(args.source_id, "source_id");
  if (!compose && !repo && sourceId === undefined) throw new Error("give the stack's content as `compose`, or a git repository as `repository_url` (or `source_id`)");
  if (compose && (repo || sourceId !== undefined)) throw new Error("give either `compose` or a repository, not both");
  const envList = envArg(args.env) ?? [];

  const git = () => {
    const body = { RepositoryReferenceName: args.reference ? String(args.reference) : undefined };
    if (sourceId !== undefined) body.SourceID = sourceId;
    else body.RepositoryURL = repo;
    if (args.repository_username || args.repository_password) {
      body.RepositoryAuthentication = true;
      body.RepositoryUsername = args.repository_username ? String(args.repository_username) : undefined;
      body.RepositoryPassword = args.repository_password ? String(args.repository_password) : undefined;
    }
    const files = listArg(args.additional_files);
    if (files) body.AdditionalFiles = files;
    return body;
  };

  let created;
  if (platform === "kubernetes") {
    const namespace = args.namespace ? String(args.namespace) : "default";
    if (compose) {
      created = await c.post("/stacks/create/kubernetes/string", { StackName: name, StackFileContent: compose, Namespace: namespace, ComposeFormat: false }, { endpointId: e.Id });
    } else {
      created = await c.post(
        "/stacks/create/kubernetes/repository",
        { StackName: name, Namespace: namespace, ManifestFile: args.compose_path ? String(args.compose_path) : "deployment.yaml", ComposeFormat: false, ...git() },
        { endpointId: e.Id }
      );
    }
  } else if (platform === "docker" || platform === "swarm" || platform === "podman") {
    let kind = "standalone";
    const extra = {};
    if (platform === "swarm") {
      const swarm = await c.docker(e.Id, "GET", "/swarm");
      kind = "swarm";
      extra.SwarmID = swarm.ID;
    }
    if (compose) {
      created = await c.post(`/stacks/create/${kind}/string`, { Name: name, StackFileContent: compose, Env: envList, ...extra }, { endpointId: e.Id });
    } else {
      created = await c.post(
        `/stacks/create/${kind}/repository`,
        { Name: name, Env: envList, ComposeFile: args.compose_path ? String(args.compose_path) : "docker-compose.yml", ...git(), ...extra },
        { endpointId: e.Id }
      );
    }
  } else {
    throw new Error(`environment ${e.Id} "${e.Name}" is ${platform}; stacks deploy to Docker, Swarm or Kubernetes environments.`);
  }

  const s = created && created.Id ? created : await resolveStack(c, name, e.Id, {});
  return `created stack ${s.Id} "${s.Name}" (${STACK_TYPES[s.Type] ?? s.Type}) in environment ${e.Id} "${e.Name}" ${c.link.stack(s.Id, s.Name, e.Id, s.Type)}\n` +
    (await deployedState(c, s, e.Id, args));
}

/**
 * Since 2.45 a deploy answers at once with status "deploying" and compose
 * runs behind it. Wait for it to settle, so the answer is the outcome.
 */
async function settled(c, s, waitMs) {
  let cur = s;
  const until = Date.now() + waitMs;
  while (cur && cur.Status === 3 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    cur = await c.get(`/stacks/${s.Id}`);
  }
  return cur;
}

function failureOf(s) {
  const hist = Array.isArray(s.DeploymentStatus) ? s.DeploymentStatus : [];
  const err = [...hist].reverse().find((d) => d.Status === 4);
  return err && err.Message ? err.Message : "";
}

/** What a deploy or update left running: a success reply alone proves nothing. */
async function deployedState(c, s, envId, args = {}) {
  const waitMs = clampInt(args.wait_seconds, 90, 0, 600) * 1000;
  s = await settled(c, s, waitMs);
  let head = `stack status: ${STACK_STATUS[s.Status] ?? s.Status}`;
  if (s.Status === 3) head += ` (still deploying after ${waitMs / 1000}s; check again with portainer_stacks)`;
  if (s.Status === 4) head += `\ndeploy failed: ${clip(failureOf(s) || "Portainer recorded no message", 2000)}`;
  if (s.Type === 3) return `${head}\nVerify: portainer_kubernetes GET /api/v1/namespaces/${s.Namespace || "default"}/pods with fields "metadata.name,status.phase".`;
  try {
    const label = s.Type === 1 ? `com.docker.stack.namespace=${s.Name}` : `com.docker.compose.project=${s.Name}`;
    const cts = await c.docker(envId, "GET", "/containers/json", { query: { all: 1, filters: { label: [label] } } });
    const arr = Array.isArray(cts) ? cts : [];
    if (!arr.length) return `${head}\nno containers carry the stack's label.`;
    const bad = arr.filter((ct) => ct.State !== "running");
    return `${head}\ncontainers now:\n${arr.map(containerLine).join("\n")}` +
      (bad.length ? `\n${bad.length} not running: read their logs with portainer_container_logs.` : "");
  } catch (e) {
    return `${head}\ncould not list the stack's containers: ${clip(e.message, 200)}`;
  }
}

export async function stackUpdate(args, env) {
  const c = createClient(env.config);
  c.assertWritable("updating a stack");
  const s = await resolveStack(c, args.stack, args.environment, env.config);
  const envId = s.EndpointId;
  const compose = typeof args.compose === "string" && args.compose.trim() ? args.compose : undefined;

  // Env: replace with `env`, or merge `set_env` / `unset_env` into what is there.
  let envList;
  const replace = envArg(args.env);
  const set = envArg(args.set_env, "set_env");
  const unset = listArg(args.unset_env);
  if (replace) envList = replace;
  if (set || unset) {
    const cur = new Map((envList ?? s.Env ?? []).map((p) => [p.name, p.value]));
    for (const p of set ?? []) cur.set(p.name, p.value);
    for (const k of unset ?? []) cur.delete(k);
    envList = [...cur].map(([name, value]) => ({ name, value }));
  }
  const prune = args.prune === undefined ? undefined : boolArg(args.prune);
  const pull = args.pull === undefined ? undefined : boolArg(args.pull);

  if (s.GitConfig && s.GitConfig.URL) {
    if (compose) throw new Error(`stack ${s.Id} "${s.Name}" is deployed from git (${s.GitConfig.URL}); change the file in the repository, then call this with no compose to redeploy.`);
    // A bare body is a valid redeploy: omitted fields keep the stored ref,
    // env and credentials. Portainer refuses a missing body, hence {}.
    const body = {};
    if (args.reference) body.RepositoryReferenceName = String(args.reference);
    if (envList) body.Env = envList;
    if (prune !== undefined) body.Prune = prune;
    if (pull !== undefined) body.RepullImageAndRedeploy = pull;
    if (s.Type === 3) body.StackName = s.Name;
    const after = await c.put(`/stacks/${s.Id}/git/redeploy`, body, { endpointId: envId });
    const hash = after && after.GitConfig && after.GitConfig.ConfigHash ? after.GitConfig.ConfigHash.slice(0, 12) : "?";
    const was = s.GitConfig.ConfigHash ? s.GitConfig.ConfigHash.slice(0, 12) : "?";
    return `redeployed stack ${s.Id} "${s.Name}" from git ${s.GitConfig.URL}${body.RepositoryReferenceName ? ` at ${body.RepositoryReferenceName}` : ""}: commit ${was} → ${hash}${was === hash ? " (unchanged: the ref had no new commits)" : ""}\n` +
      (await deployedState(c, after && after.Id ? after : s, envId, args));
  }

  let content = compose;
  if (!content) content = (await c.get(`/stacks/${s.Id}/file`)).StackFileContent;
  const body = { StackFileContent: content, Env: envList ?? s.Env ?? [] };
  if (prune !== undefined) body.Prune = prune;
  if (pull !== undefined) body.RepullImageAndRedeploy = pull;
  const after = await c.put(`/stacks/${s.Id}`, body, { endpointId: envId });
  const changed = [compose ? "file" : null, envList ? "env" : null, pull ? "images re-pulled" : null, prune ? "pruned" : null].filter(Boolean);
  return `updated stack ${s.Id} "${s.Name}" (${changed.join(", ") || "redeployed as is"})\n` + (await deployedState(c, after && after.Id ? after : s, envId, args));
}

export async function stackControl(args, env) {
  const c = createClient(env.config);
  const action = String(args.action ?? "").toLowerCase();
  if (action !== "start" && action !== "stop") throw new Error("action must be start or stop");
  c.assertWritable(`${action === "start" ? "starting" : "stopping"} a stack`);
  const s = await resolveStack(c, args.stack, args.environment, env.config);
  await c.post(`/stacks/${s.Id}/${action}`, undefined, { endpointId: s.EndpointId });
  const after = await c.get(`/stacks/${s.Id}`);
  return `${action === "start" ? "started" : "stopped"} stack ${s.Id} "${s.Name}"\n` + (await deployedState(c, after, s.EndpointId, args));
}

export async function stackDelete(args, env) {
  const c = createClient(env.config);
  c.assertWritable("deleting a stack");
  const s = await resolveStack(c, args.stack, args.environment, env.config);
  const removeVolumes = boolArg(args.remove_volumes);
  await c.delete(`/stacks/${s.Id}`, { endpointId: s.EndpointId, removeVolumes: removeVolumes ? "true" : undefined });
  return `deleted stack ${s.Id} "${s.Name}" from environment ${s.EndpointId}: its containers and networks are removed; ` +
    (removeVolumes ? "its volumes too." : "its named volumes are kept (remove_volumes=true removes them; list them with portainer_docker_resources kind=volumes).");
}

export async function containers(args, env) {
  const c = createClient(env.config);
  const e = await resolveEnv(c, args.environment, env.config);
  requireDockerish(e, "portainer_containers");

  if (args.container !== undefined && args.container !== null && args.container !== "") {
    const ref = containerRef(args.container);
    const ct = await c.docker(e.Id, "GET", `/containers/${ref}/json`);
    const fields = parseFields(args.fields);
    if (fields || boolArg(args.raw)) return c.view(ct, fields);
    const st = ct.State || {};
    const out = {
      id: ct.Id.slice(0, 12),
      name: String(ct.Name).replace(/^\//, ""),
      image: ct.Config && ct.Config.Image,
      state: {
        status: st.Status,
        started: fmtTime(st.StartedAt) || undefined,
        finished: st.Running ? undefined : fmtTime(st.FinishedAt) || undefined,
        exit_code: st.Running ? undefined : st.ExitCode,
        error: st.Error || undefined,
        oom_killed: st.OOMKilled || undefined,
        health: st.Health ? `${st.Health.Status}${st.Health.FailingStreak ? ` (failing ${st.Health.FailingStreak})` : ""}` : undefined,
        last_health_output: st.Health && Array.isArray(st.Health.Log) && st.Health.Log.length ? clip(String(st.Health.Log.at(-1).Output).trim(), 300) : undefined,
        restarts: ct.RestartCount || undefined,
      },
      created: fmtTime(ct.Created),
      stack: stackOfLabels(ct.Config && ct.Config.Labels) || undefined,
      service: (ct.Config && ct.Config.Labels && (ct.Config.Labels["com.docker.compose.service"] || ct.Config.Labels["com.docker.swarm.service.name"])) || undefined,
      restart_policy: ct.HostConfig && ct.HostConfig.RestartPolicy ? ct.HostConfig.RestartPolicy.Name : undefined,
      command: [...((ct.Config && ct.Config.Entrypoint) || []), ...((ct.Config && ct.Config.Cmd) || [])].join(" ") || undefined,
      ports: ct.NetworkSettings && ct.NetworkSettings.Ports
        ? Object.entries(ct.NetworkSettings.Ports).flatMap(([p, binds]) => (binds || []).map((b) => `${b.HostIp && b.HostIp !== "0.0.0.0" && b.HostIp !== "::" ? `${b.HostIp}:` : ""}${b.HostPort}→${p}`))
        : undefined,
      mounts: (ct.Mounts || []).map((m) => `${m.Type === "volume" ? m.Name : m.Source} → ${m.Destination}${m.RW === false ? " (ro)" : ""}`),
      networks: ct.NetworkSettings && ct.NetworkSettings.Networks
        ? Object.fromEntries(Object.entries(ct.NetworkSettings.Networks).map(([n, v]) => [n, v.IPAddress || ""]))
        : undefined,
      env: ct.Config && ct.Config.Env,
      memory_limit: ct.HostConfig && ct.HostConfig.Memory ? bytes(ct.HostConfig.Memory) : undefined,
      link: c.link.container(e.Id, ct.Id),
    };
    if (boolArg(args.stats) && st.Running) out.stats = await statsOf(c, e.Id, ref);
    if (boolArg(args.top) && st.Running) {
      const top = await c.docker(e.Id, "GET", `/containers/${ref}/top`);
      out.processes = [(top.Titles || []).join("  "), ...(top.Processes || []).slice(0, 40).map((p) => p.join("  "))];
    }
    return c.out(out);
  }

  const filters = {};
  if (args.name) filters.name = [String(args.name)];
  if (args.state) filters.status = [String(args.state)];
  if (args.image) filters.ancestor = [String(args.image)];
  const labels = listArg(args.label) ?? [];
  if (args.stack) labels.push(`com.docker.compose.project=${args.stack}`);
  if (labels.length) filters.label = labels;
  const all = args.all === undefined ? true : boolArg(args.all, true);
  let list = await c.docker(e.Id, "GET", "/containers/json", { query: { all: all ? 1 : 0, filters: Object.keys(filters).length ? filters : undefined } });
  list = Array.isArray(list) ? list : [];
  if (args.stack && !list.length) {
    // A Swarm stack labels its containers with the stack namespace instead.
    const swarm = await c.docker(e.Id, "GET", "/containers/json", { query: { all: all ? 1 : 0, filters: { ...filters, label: [...labels.filter((l) => !l.startsWith("com.docker.compose.project=")), `com.docker.stack.namespace=${args.stack}`] } } });
    if (Array.isArray(swarm)) list = swarm;
  }
  const limit = clampInt(args.limit, 200, 1, 2000);
  return shaped(c, args, list.slice(0, limit), () => {
    if (!list.length) return `no containers in environment ${e.Id} "${e.Name}" match.`;
    const running = list.filter((ct) => ct.State === "running").length;
    return `${list.length} container${list.length === 1 ? "" : "s"} in environment ${e.Id} "${e.Name}" (${running} running):\n` +
      list.slice(0, limit).map(containerLine).join("\n") +
      (list.length > limit ? `\n(${limit} of ${list.length} shown; narrow with name, state, stack or raise limit)` : "");
  });
}

async function statsOf(c, envId, ref) {
  const s = await c.docker(envId, "GET", `/containers/${ref}/stats`, { query: { stream: "false" } });
  const out = {};
  const cpu = s.cpu_stats || {};
  const pre = s.precpu_stats || {};
  const cpuDelta = (cpu.cpu_usage?.total_usage ?? 0) - (pre.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cpu.system_cpu_usage ?? 0) - (pre.system_cpu_usage ?? 0);
  const cpus = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1;
  if (sysDelta > 0 && cpuDelta >= 0) out.cpu = `${((cpuDelta / sysDelta) * cpus * 100).toFixed(1)}% (of ${cpus} cpus)`;
  else out.cpu = "n/a in a one-shot sample (call again for a delta)";
  const mem = s.memory_stats || {};
  if (mem.usage) {
    const cache = mem.stats?.inactive_file ?? mem.stats?.cache ?? 0;
    out.memory = `${bytes(mem.usage - cache)} / ${bytes(mem.limit)}`;
  }
  if (s.networks) {
    let rx = 0;
    let tx = 0;
    for (const n of Object.values(s.networks)) {
      rx += n.rx_bytes || 0;
      tx += n.tx_bytes || 0;
    }
    out.network = `rx ${bytes(rx)} tx ${bytes(tx)}`;
  }
  const io = s.blkio_stats?.io_service_bytes_recursive;
  if (Array.isArray(io) && io.length) {
    const sum = (op) => io.filter((x) => String(x.op).toLowerCase() === op).reduce((a, x) => a + (x.value || 0), 0);
    out.block_io = `read ${bytes(sum("read"))} write ${bytes(sum("write"))}`;
  }
  if (s.pids_stats?.current) out.pids = s.pids_stats.current;
  return out;
}

const CONTAINER_ACTIONS = ["start", "stop", "restart", "kill", "pause", "unpause", "remove"];

export async function containerAction(args, env) {
  const c = createClient(env.config);
  const action = String(args.action ?? "").toLowerCase();
  if (!CONTAINER_ACTIONS.includes(action)) throw new Error(`action must be one of ${CONTAINER_ACTIONS.join(", ")}`);
  c.assertWritable(`${action} on a container`);
  const e = await resolveEnv(c, args.environment, env.config);
  requireDockerish(e, "portainer_container_action");
  const ref = containerRef(args.container);
  const before = await c.docker(e.Id, "GET", `/containers/${ref}/json`);
  const name = String(before.Name).replace(/^\//, "");
  const id = before.Id;
  const wait = intArg(args.timeout, "timeout");

  if (action === "remove") {
    await c.docker(e.Id, "DELETE", `/containers/${id}`, { query: { force: boolArg(args.force) ? "true" : undefined, v: boolArg(args.volumes) ? "true" : undefined } });
    const stack = stackOfLabels(before.Config && before.Config.Labels);
    return `removed container ${id.slice(0, 12)} "${name}"${boolArg(args.volumes) ? " and its anonymous volumes" : ""}.` +
      (stack ? ` It belonged to stack "${stack}"; a redeploy of the stack recreates it.` : "");
  }
  const query = {};
  if ((action === "stop" || action === "restart") && wait !== undefined) query.t = wait;
  if (action === "kill" && args.signal) query.signal = String(args.signal);
  // Stop and restart can take the container's whole stop timeout.
  const timeout = ((wait ?? 10) + 30) * 1000;
  await c.docker(e.Id, "POST", `/containers/${id}/${action}`, { query, timeout });
  const after = await c.docker(e.Id, "GET", `/containers/${id}/json`);
  const st = after.State || {};
  let line = `${action} ${id.slice(0, 12)} "${name}": was ${before.State?.Status}, now ${st.Status}`;
  if (!st.Running && st.ExitCode) line += ` (exit ${st.ExitCode})`;
  if (st.Health) line += `, health ${st.Health.Status}`;
  if ((action === "start" || action === "restart") && !st.Running) line += "\nIt is not running: read why with portainer_container_logs.";
  return line;
}

export async function containerLogs(args, env) {
  const c = createClient(env.config);
  const e = await resolveEnv(c, args.environment, env.config);
  requireDockerish(e, "portainer_container_logs");
  const ref = containerRef(args.container);
  const tail = clampInt(args.tail, 100, 1, 10_000);
  const stream = String(args.stream ?? "both").toLowerCase();
  const query = {
    stdout: stream === "stderr" ? 0 : 1,
    stderr: stream === "stdout" ? 0 : 1,
    tail,
    since: sinceArg(args.since, "since"),
    until: sinceArg(args.until, "until"),
    timestamps: boolArg(args.timestamps) ? 1 : 0,
  };
  // follow is never set: a followed log never ends.
  const path = `/endpoints/${e.Id}/docker/containers/${ref}/logs`;
  const res = await c.raw("GET", path, { query, headers: { Accept: "*/*" } });
  if (res.status < 200 || res.status >= 300) throw new Error(explainError(res.status, res.body.toString("utf8"), "GET", `/api${path}`));
  const frames = demuxDockerLog(res.body);
  let lines = [];
  const mark = stream === "both" && frames.some((f) => f.stream === "stderr");
  for (const f of frames) {
    for (const l of f.text.split("\n")) {
      if (l === "") continue;
      lines.push(mark && f.stream === "stderr" ? `[err] ${l}` : l);
    }
  }
  if (args.grep) {
    let re;
    try {
      re = new RegExp(String(args.grep), "i");
    } catch {
      re = { test: (s) => s.toLowerCase().includes(String(args.grep).toLowerCase()) };
    }
    lines = lines.filter((l) => re.test(l));
  }
  if (!lines.length) return `no log lines${args.grep ? ` match "${args.grep}"` : ""} in the last ${tail}${args.since ? ` since ${args.since}` : ""}.`;
  let text = lines.join("\n");
  // The end of a log is what matters: cut from the front.
  if (text.length > c.maxChars) text = `… [first ${text.length - c.maxChars} characters cut; pass a smaller tail, since, or grep]\n` + text.slice(text.length - c.maxChars);
  return `${lines.length} line${lines.length === 1 ? "" : "s"} (tail ${tail}${args.grep ? `, grep "${args.grep}"` : ""}):\n${text}`;
}

const RESOURCE_KINDS = ["images", "volumes", "networks", "info", "df", "services", "tasks", "nodes", "secrets", "configs"];

export async function dockerResources(args, env) {
  const c = createClient(env.config);
  const kind = String(args.kind ?? "").toLowerCase();
  if (!RESOURCE_KINDS.includes(kind)) throw new Error(`kind must be one of ${RESOURCE_KINDS.join(", ")}`);
  const e = await resolveEnv(c, args.environment, env.config);
  requireDockerish(e, "portainer_docker_resources");
  const search = args.search ? String(args.search).toLowerCase() : "";
  const match = (...vals) => !search || vals.some((v) => String(v ?? "").toLowerCase().includes(search));
  const limit = clampInt(args.limit, 200, 1, 5000);
  const listOut = (arr, line, noun) =>
    shaped(c, args, arr.slice(0, limit), () =>
      arr.length
        ? `${arr.length} ${noun}${arr.length === 1 ? "" : "s"} in environment ${e.Id} "${e.Name}":\n${arr.slice(0, limit).map(line).join("\n")}` +
          (arr.length > limit ? `\n(${limit} of ${arr.length} shown)` : "")
        : `no ${noun}s${search ? ` match "${args.search}"` : ""}.`
    );

  if (["services", "tasks", "nodes", "secrets", "configs"].includes(kind) && platformOf(e) !== "swarm") {
    return `environment ${e.Id} "${e.Name}" is not a Swarm (by its last snapshot), so it has no ${kind}. Containers: portainer_containers.`;
  }
  if (kind === "info") {
    const i = await c.docker(e.Id, "GET", "/info");
    return shaped(c, args, i, () =>
      c.out({
        name: i.Name,
        docker: i.ServerVersion,
        os: `${i.OperatingSystem} (${i.KernelVersion}, ${i.Architecture})`,
        cpus: i.NCPU,
        memory: bytes(i.MemTotal),
        containers: `${i.ContainersRunning} running, ${i.ContainersPaused} paused, ${i.ContainersStopped} stopped`,
        images: i.Images,
        storage_driver: i.Driver,
        root_dir: i.DockerRootDir,
        swarm: i.Swarm && i.Swarm.LocalNodeState !== "inactive" ? { state: i.Swarm.LocalNodeState, manager: i.Swarm.ControlAvailable, nodes: i.Swarm.Nodes } : undefined,
        warnings: Array.isArray(i.Warnings) && i.Warnings.length ? i.Warnings : undefined,
      })
    );
  }
  if (kind === "df") {
    const d = await c.docker(e.Id, "GET", "/system/df", { timeout: 120_000 });
    return shaped(c, args, d, () => {
      const imgs = d.Images || [];
      const vols = d.Volumes || [];
      const cts = d.Containers || [];
      const cache = d.BuildCache || [];
      const sum = (a, f) => a.reduce((x, y) => x + (f(y) || 0), 0);
      const unusedImgs = imgs.filter((i) => !i.Containers);
      const unusedVols = vols.filter((v) => v.UsageData && v.UsageData.RefCount === 0);
      const top = [...vols].sort((a, b) => (b.UsageData?.Size ?? 0) - (a.UsageData?.Size ?? 0)).slice(0, 10);
      return c.out({
        images: `${imgs.length}, ${bytes(sum(imgs, (i) => i.Size))}; ${unusedImgs.length} unused (${bytes(sum(unusedImgs, (i) => i.Size))} reclaimable)`,
        containers: `${cts.length}, writable layers ${bytes(sum(cts, (x) => x.SizeRw))}`,
        volumes: `${vols.length}, ${bytes(sum(vols, (v) => v.UsageData?.Size))}; ${unusedVols.length} unused (${bytes(sum(unusedVols, (v) => v.UsageData?.Size))})`,
        build_cache: `${cache.length} entries, ${bytes(sum(cache, (b) => b.Size))}`,
        largest_volumes: top.map((v) => `${v.Name} ${bytes(v.UsageData?.Size)} (${v.UsageData?.RefCount ?? "?"} using)`),
      });
    });
  }
  if (kind === "images") {
    let arr = await c.docker(e.Id, "GET", "/images/json", { query: args.dangling ? { filters: { dangling: ["true"] } } : undefined });
    arr = (Array.isArray(arr) ? arr : []).filter((i) => match(i.Id, ...(i.RepoTags || [])));
    arr.sort((a, b) => (b.Created ?? 0) - (a.Created ?? 0));
    return listOut(arr, (i) => {
      const tags = (i.RepoTags || []).filter((t) => t !== "<none>:<none>");
      return `- ${i.Id.replace(/^sha256:/, "").slice(0, 12)} ${tags.length ? tags.join(", ") : "<none> (dangling)"} ${bytes(i.Size)} created ${fmtTime(i.Created)}${i.Containers > 0 ? ` · ${i.Containers} containers` : ""}`;
    }, "image");
  }
  if (kind === "volumes") {
    const r = await c.docker(e.Id, "GET", "/volumes", { query: args.dangling ? { filters: { dangling: ["true"] } } : undefined });
    const arr = (Array.isArray(r.Volumes) ? r.Volumes : []).filter((v) => match(v.Name, stackOfLabels(v.Labels)));
    return listOut(arr, (v) => `- ${v.Name} ${v.Driver}${stackOfLabels(v.Labels) ? ` [stack ${stackOfLabels(v.Labels)}]` : ""} created ${fmtTime(v.CreatedAt)}`, "volume");
  }
  if (kind === "networks") {
    let arr = await c.docker(e.Id, "GET", "/networks");
    arr = (Array.isArray(arr) ? arr : []).filter((n) => match(n.Name, n.Id));
    return listOut(arr, (n) => {
      const sub = (n.IPAM?.Config || []).map((x) => x.Subnet).filter(Boolean).join(", ");
      return `- ${n.Id.slice(0, 12)} ${n.Name} ${n.Driver} ${n.Scope}${sub ? ` ${sub}` : ""}${n.Internal ? " internal" : ""}${stackOfLabels(n.Labels) ? ` [stack ${stackOfLabels(n.Labels)}]` : ""}`;
    }, "network");
  }
  if (kind === "services") {
    let arr = await c.docker(e.Id, "GET", "/services", { query: { status: "true" } });
    arr = (Array.isArray(arr) ? arr : []).filter((s) => match(s.Spec?.Name, s.ID));
    return listOut(arr, (s) => {
      const mode = s.Spec?.Mode?.Replicated ? `replicated ${s.ServiceStatus ? `${s.ServiceStatus.RunningTasks}/${s.ServiceStatus.DesiredTasks}` : s.Spec.Mode.Replicated.Replicas}` : "global";
      return `- ${s.ID.slice(0, 12)} ${s.Spec?.Name} ${mode} ${String(s.Spec?.TaskTemplate?.ContainerSpec?.Image ?? "").replace(/@sha256:.*/, "")}${s.Spec?.Labels?.["com.docker.stack.namespace"] ? ` [stack ${s.Spec.Labels["com.docker.stack.namespace"]}]` : ""}`;
    }, "service");
  }
  if (kind === "tasks") {
    const filters = args.search ? { service: [String(args.search)] } : undefined;
    let arr = await c.docker(e.Id, "GET", "/tasks", { query: { filters } });
    arr = Array.isArray(arr) ? arr : [];
    arr.sort((a, b) => String(b.UpdatedAt).localeCompare(String(a.UpdatedAt)));
    return listOut(arr, (t) => `- ${t.ID.slice(0, 12)} service ${t.ServiceID?.slice(0, 12)} slot ${t.Slot ?? "-"} node ${t.NodeID?.slice(0, 12)} desired ${t.DesiredState} now ${t.Status?.State}${t.Status?.Err ? ` error: ${clip(t.Status.Err, 160)}` : ""} ${fmtTime(t.UpdatedAt)}`, "task");
  }
  if (kind === "nodes") {
    let arr = await c.docker(e.Id, "GET", "/nodes");
    arr = (Array.isArray(arr) ? arr : []).filter((n) => match(n.Description?.Hostname, n.ID));
    return listOut(arr, (n) => `- ${n.ID.slice(0, 12)} ${n.Description?.Hostname} ${n.Spec?.Role}${n.ManagerStatus?.Leader ? " (leader)" : ""} ${n.Status?.State} ${n.Spec?.Availability} docker ${n.Description?.Engine?.EngineVersion}`, "node");
  }
  // secrets / configs: names and dates; Docker never returns secret data.
  let arr = await c.docker(e.Id, "GET", `/${kind}`);
  arr = (Array.isArray(arr) ? arr : []).filter((s) => match(s.Spec?.Name, s.ID));
  return listOut(arr, (s) => `- ${s.ID.slice(0, 12)} ${s.Spec?.Name} updated ${fmtTime(s.UpdatedAt)}`, kind.slice(0, -1));
}

// ---------------------------------------------------------------------------
// The raw proxies and the generic call.

function validPath(path) {
  const p = requireString(path, "path");
  if (!p.startsWith("/")) throw new Error("path must start with /");
  if (/[?#]/.test(p)) throw new Error("path must not contain ? or #: put query parameters in `query`");
  if (p.split("/").includes("..")) throw new Error("path must not contain .. segments");
  return p;
}

function headersArg(value) {
  const h = asObject(value, "headers");
  if (!h) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (BLOCKED_HEADERS.has(k.toLowerCase())) throw new Error(`header ${k} is not allowed`);
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

function queryArg(value) {
  const q = asObject(value, "query");
  if (!q) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null) continue;
    out[k] = Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))) : typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return out;
}

async function proxied(c, args, fullPath, { kube = false } = {}) {
  const method = String(args.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error(`method ${method} is not supported`);
  if (method !== "GET" && method !== "HEAD") c.assertWritable(`${method} ${clip(fullPath, 120)}`);
  const headers = headersArg(args.headers) ?? {};
  const body = bodyArg(args.body);
  if (kube && method === "PATCH" && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    // Kubernetes refuses a PATCH without a patch type; a merge patch is what people mean.
    headers["Content-Type"] = "application/merge-patch+json";
  }
  const res = await c.raw(method, fullPath, { query: args._query ?? queryArg(args.query), body, headers, timeout: args.timeout_ms ? clampInt(args.timeout_ms, 30_000, 1_000, 300_000) : undefined });
  const text = res.body.toString("utf8");
  if (res.status < 200 || res.status >= 300) throw new Error(explainError(res.status, text, method, `/api${fullPath}`));
  if (!text.trim()) {
    return `${method} ${fullPath}: ${res.status}, empty reply.` +
      (method === "GET" || method === "HEAD" ? "" : " A change often answers nothing; read the object back to confirm it.");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Logs and other text. A Docker log body without a TTY is framed.
    const frames = demuxDockerLog(res.body);
    const plain = frames.map((f) => f.text).join("");
    return cut(plain.length > c.maxChars ? `… [front cut]\n${plain.slice(plain.length - c.maxChars)}` : plain, c.maxChars + 40);
  }
  if (kube && !boolArg(args.keep_managed_fields)) stripManagedFields(data);
  return c.view(data, parseFields(args.fields));
}

export async function docker(args, env) {
  const c = createClient(env.config);
  const e = await resolveEnv(c, args.environment, env.config);
  requireDockerish(e, "portainer_docker");
  const path = validPath(args.path);
  // Three Docker routes stream until the client hangs up. Make them end.
  const query = queryArg(args.query) ?? {};
  const on = (k) => ["true", "1"].includes(String(query[k] ?? "").toLowerCase());
  if (/\/(logs|attach)$/.test(path) && on("follow")) throw new Error("follow would never end; leave it off and use tail / since");
  if (/\/stats$/.test(path) && query.stream === undefined) query.stream = "false";
  if (/\/stats$/.test(path) && on("stream")) throw new Error("stream=true would never end; use stream=false for one sample");
  if (/^\/events$/.test(path) && query.until === undefined) query.until = String(Math.floor(Date.now() / 1000));
  return proxied(c, { ...args, _query: query }, `/endpoints/${e.Id}/docker${path}`);
}

export async function kubernetes(args, env) {
  const c = createClient(env.config);
  const e = await resolveEnv(c, args.environment, env.config);
  if (platformOf(e) !== "kubernetes") throw new Error(`environment ${e.Id} "${e.Name}" is ${platformOf(e)}, not Kubernetes. Use portainer_docker or portainer_containers.`);
  const path = validPath(args.path);
  const query = queryArg(args.query) ?? {};
  if (["follow", "watch"].some((k) => ["true", "1"].includes(String(query[k] ?? "").toLowerCase()))) {
    throw new Error("follow / watch would never end; leave them off (use tailLines for logs)");
  }
  return proxied(c, { ...args, _query: query }, `/endpoints/${e.Id}/kubernetes${path}`, { kube: true });
}

export async function request(args, env) {
  const c = createClient(env.config);
  let path = validPath(args.path);
  path = path.replace(/^\/api(?=\/)/, "");
  return proxied(c, args, path);
}

// Generates package.json. Run: node manifest.mjs  (from this directory)
// Tool descriptions live here as JS so they can be edited without fighting
// JSON escaping; the output file is what the kernel reads.
import { writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";

const S = (description, extra = {}) => ({ type: "string", description, ...extra });
const B = (description) => ({ type: "boolean", description });
const I = (description, extra = {}) => ({ type: "integer", description, ...extra });
const O = (description) => ({ type: "object", description, additionalProperties: true });
const A = (description, items = { type: "string" }) => ({ type: "array", description, items });
const obj = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
/** An argument that may be an id or a name. */
const IDN = (description) => ({ type: ["string", "integer"], description });

const ENVIRONMENT = IDN(
  "The environment (Portainer's \"endpoint\"): its id or name. Omit when the package has a default `environment` set or there is only one."
);
const STACK = IDN("The stack: its id or name. A name is looked up in `environment` when given, else across every environment.");
const CONTAINER = S("The container: its name (with or without the leading /), its full id, or a unique id prefix.");
const FIELDS = {
  type: ["string", "array"],
  items: { type: "string" },
  description:
    "Keep only these fields of each item (or of the one object), as JSON: comma-separated paths, `alias=path` to rename. " +
    "Dots nest, [n] indexes, a key that has dots in it is double-quoted. Examples: `Id,name=Names[0],State,Image`; " +
    "`Labels.\"com.docker.compose.project\"`; for Kubernetes lists (projected per item) `metadata.name,ns=metadata.namespace,status.phase`. " +
    "Environment values are redacted before the projection. An all-null column means the path is wrong, not that the data is absent: fetch one object without fields to read the real keys.",
};
const RAW = B("Answer the JSON object(s) instead of the text summary (environment values still redacted).");

const tools = [
  {
    name: "portainer_health",
    description:
      "Check the configured Portainer server: version and edition, whether the access token works and as which user and role, the environments that user can see with their status, and this package's read-only and redaction settings. Call this first, and whenever anything else fails.",
    parameters: obj({}),
    export: "portainerHealth",
    reads: true,
  },
  {
    name: "portainer_environments",
    description:
      "List environments (Docker hosts, Swarms, Kubernetes clusters; the API calls them endpoints) with id, platform, connection type, status and the last snapshot's container and stack counts; or with `environment` read one in detail. The discovery tool: the other tools take an environment id or name from here. Status: for direct and agent environments up/down; for edge agents Status means nothing, the heartbeat (last check-in) is the health signal and is what is shown.",
    parameters: obj({
      environment: IDN("Read this one environment in detail instead of listing."),
      search: S("Text matched against names, URLs, groups and tags."),
      platform: S("Only this kind.", { enum: ["docker", "kubernetes", "edge"] }),
      limit: I("Environments per page, 1-500. Defaults to 50."),
      start: I("Offset for paging, from 0."),
      raw: RAW,
      fields: FIELDS,
    }),
    export: "portainerEnvironments",
    reads: true,
    concurrent: true,
  },
  {
    name: "portainer_stacks",
    description:
      "List the stacks Portainer manages (compose, swarm, kubernetes), across environments or in one; or with `stack` read one: type, status, environment, env (values redacted), git source and deployed commit, who changed it when, and its containers with their states. `file=true` adds the compose file or manifest. Compose projects started outside Portainer are not stacks here; portainer_containers shows their containers tagged [stack name].",
    parameters: obj({
      stack: STACK,
      environment: IDN("Only stacks in this environment (id or name)."),
      search: S("Text matched against stack names."),
      file: B("With stack: include the stack file content (compose YAML or Kubernetes manifest)."),
      raw: RAW,
      fields: FIELDS,
    }),
    export: "portainerStacks",
    reads: true,
    concurrent: true,
  },
  {
    name: "portainer_stack_deploy",
    description:
      "Deploy a new stack into an environment, from compose/manifest text (`compose`) or from a git repository (`repository_url` + `reference` + `compose_path`, or an existing GitOps `source_id`). The kind follows the environment: Docker standalone → compose, Swarm → swarm stack, Kubernetes → manifest in `namespace`. Waits for the deploy to finish (Portainer deploys in the background), then answers the outcome, Portainer's error when it failed, and the containers it left running: a deploy that returns without error has not proved anything, so read those states, and logs for anything not running.",
    parameters: obj(
      {
        environment: ENVIRONMENT,
        name: S("The stack name: lowercase letters, digits, - and _; it becomes the compose project name."),
        compose: S("The stack file content: a docker-compose YAML, or for Kubernetes a manifest."),
        env: {
          type: ["object", "array", "string"],
          description: "Environment variables for the stack, used for ${VAR} substitution in the compose file: an object {NAME: value}, a list of NAME=value, or one NAME=value per line.",
        },
        repository_url: S("Git repository URL to deploy from instead of compose, e.g. https://github.com/org/repo."),
        reference: S("Git ref, e.g. refs/heads/main or refs/tags/v1.2. Defaults to the repository's default branch."),
        compose_path: S("Path of the compose file (or manifest) inside the repository. Defaults to docker-compose.yml (deployment.yaml for Kubernetes)."),
        additional_files: A("More compose files in the repository, layered over compose_path."),
        source_id: I("An existing Portainer GitOps source id, instead of repository_url and credentials."),
        repository_username: S("Username for a private repository."),
        repository_password: S("Password or token for a private repository. Stored by Portainer, never shown."),
        namespace: S("Kubernetes only: the namespace to deploy into. Defaults to default."),
        wait_seconds: I("How long to wait for the deploy to finish before answering, 0-600. Defaults to 90."),
      },
      ["name"]
    ),
    export: "portainerStackDeploy",
    reads: false,
  },
  {
    name: "portainer_stack_update",
    description:
      "Change and redeploy a stack. A text stack: new `compose` content (omit to keep the current file), env replaced with `env` or merged with `set_env` / `unset_env`, `pull` to re-pull images (how to pick up a new :latest), `prune` to remove services no longer in the file. A git stack: pulls the configured ref (or `reference`) and redeploys, keeping stored env and credentials unless given; reports the commit before and after. Answers the containers' states afterwards.",
    parameters: obj(
      {
        stack: STACK,
        environment: IDN("The stack's environment, when a name is ambiguous."),
        compose: S("Text stacks: the whole new stack file content. Omit to redeploy the current file."),
        env: { type: ["object", "array", "string"], description: "Replace the stack's environment variables entirely: {NAME: value}, NAME=value list, or lines." },
        set_env: { type: ["object", "array", "string"], description: "Set or change these variables, keeping the others." },
        unset_env: A("Remove these variables by name."),
        pull: B("Re-pull every image before redeploying."),
        prune: B("Remove services that are no longer in the file."),
        reference: S("Git stacks: redeploy this ref instead of the configured one, e.g. refs/tags/v1.3."),
        wait_seconds: I("How long to wait for the deploy to finish before answering, 0-600. Defaults to 90."),
      },
      ["stack"]
    ),
    export: "portainerStackUpdate",
    reads: false,
  },
  {
    name: "portainer_stack_control",
    description: "Start or stop a stack: stop removes its containers but keeps the stack, its file and its volumes; start deploys it again. Answers the state afterwards.",
    parameters: obj(
      {
        stack: STACK,
        action: S("What to do.", { enum: ["start", "stop"] }),
        environment: IDN("The stack's environment, when a name is ambiguous."),
        wait_seconds: I("How long to wait for the deploy to finish before answering, 0-600. Defaults to 90."),
      },
      ["stack", "action"]
    ),
    export: "portainerStackControl",
    reads: false,
  },
  {
    name: "portainer_stack_delete",
    description:
      "Delete a stack: its containers, networks and Portainer's record of it. Named volumes are kept unless remove_volumes=true, which destroys their data. Irreversible; prefer portainer_stack_control stop when the intent is to pause it.",
    parameters: obj(
      {
        stack: STACK,
        environment: IDN("The stack's environment, when a name is ambiguous."),
        remove_volumes: B("Also remove the stack's volumes and the data in them."),
      },
      ["stack"]
    ),
    export: "portainerStackDelete",
    reads: false,
  },
  {
    name: "portainer_containers",
    description:
      "List an environment's containers, one line each: short id, name, state and status, image, stack, published ports; filter by name, state, stack, image or label. Or with `container` read one: state with exit code, health and last health-check output, restarts, command, ports, mounts, networks, env (values redacted); add `stats` for CPU, memory, network and block I/O, `top` for its processes.",
    parameters: obj({
      environment: ENVIRONMENT,
      container: CONTAINER,
      name: S("Only containers whose name contains this."),
      state: S("Only containers in this state.", { enum: ["created", "running", "paused", "restarting", "removing", "exited", "dead"] }),
      stack: S("Only containers of this stack / compose project."),
      image: S("Only containers created from this image (name, name:tag or id)."),
      label: A("Only containers with these labels: key or key=value."),
      all: B("Include stopped containers. Defaults to true."),
      stats: B("With container: a one-shot resource sample."),
      top: B("With container: the processes running in it."),
      limit: I("Lines at most, default 200."),
      raw: RAW,
      fields: FIELDS,
    }),
    export: "portainerContainers",
    reads: true,
    concurrent: true,
  },
  {
    name: "portainer_container_action",
    description:
      "Start, stop, restart, kill, pause, unpause or remove one container, and answer its state afterwards. A container that belongs to a stack is better restarted or redeployed through the stack tools, which keep the stack's file and env the source of truth; remove on a stack's container only lasts until the stack is redeployed.",
    parameters: obj(
      {
        environment: ENVIRONMENT,
        container: CONTAINER,
        action: S("What to do.", { enum: ["start", "stop", "restart", "kill", "pause", "unpause", "remove"] }),
        timeout: I("stop / restart: seconds to wait before killing. Defaults to the container's own stop timeout."),
        signal: S("kill: the signal, e.g. SIGTERM or SIGHUP. Defaults to SIGKILL."),
        force: B("remove: remove a running container (kills it first)."),
        volumes: B("remove: also remove its anonymous volumes."),
      },
      ["container", "action"]
    ),
    export: "portainerContainerAction",
    reads: false,
  },
  {
    name: "portainer_container_logs",
    description:
      "Read a container's logs, the last `tail` lines (default 100), optionally since a time, filtered by a regex `grep`, stdout and stderr together with stderr lines marked [err]. Never follows. The first thing to read when a container is exited, restarting or unhealthy.",
    parameters: obj(
      {
        environment: ENVIRONMENT,
        container: CONTAINER,
        tail: I("Lines from the end, 1-10000. Defaults to 100."),
        since: S("Only lines after this: \"15m\", \"2h\", \"1d\", an ISO date or unix seconds."),
        until: S("Only lines before this, same forms."),
        grep: S("Keep only lines matching this regular expression (case-insensitive)."),
        stream: S("Which output. Defaults to both.", { enum: ["both", "stdout", "stderr"] }),
        timestamps: B("Prefix each line with Docker's timestamp."),
      },
      ["container"]
    ),
    export: "portainerContainerLogs",
    reads: true,
    concurrent: true,
  },
  {
    name: "portainer_docker_resources",
    description:
      "An environment's other Docker objects, one line each: images (tags, size, age; dangling=true for untagged), volumes (driver, stack; dangling=true for unused), networks (driver, scope, subnet), Swarm services (replicas running/desired), tasks (with errors), nodes, secrets and configs (names only), `info` (engine, OS, CPUs, memory, warnings) or `df` (disk use and what is reclaimable, largest volumes).",
    parameters: obj(
      {
        environment: ENVIRONMENT,
        kind: S("What to list.", { enum: ["images", "volumes", "networks", "info", "df", "services", "tasks", "nodes", "secrets", "configs"] }),
        search: S("Text matched against names and ids (for tasks: a service name or id)."),
        dangling: B("images: only untagged; volumes: only unused by any container."),
        limit: I("Lines at most, default 200."),
        raw: RAW,
        fields: FIELDS,
      },
      ["kind"]
    ),
    export: "portainerDockerResources",
    reads: true,
    concurrent: true,
  },
  {
    name: "portainer_docker",
    description:
      "Call the Docker Engine API of one environment through Portainer, for what the other tools do not cover: pull an image (POST /images/create?fromImage=…), create a network or volume, exec, prune (POST /images/prune, /volumes/prune), inspect anything (GET /images/{id}/json, /networks/{id}). `path` is the Docker API path, e.g. /containers/json. Send `body` as the JSON object itself. /stats is made one-shot and /events bounded; follow is refused. Use `fields` on large lists.",
    parameters: obj(
      {
        environment: ENVIRONMENT,
        method: S("HTTP method. Defaults to GET.", { enum: ["GET", "HEAD", "POST", "PUT", "DELETE"] }),
        path: S("Docker Engine API path with a leading slash, e.g. /images/json or /containers/abc/json. No query string here."),
        query: O("Query parameters. Docker's `filters` may be given as an object, e.g. {\"filters\": {\"dangling\": [\"true\"]}}."),
        body: { type: ["object", "array", "string"], description: "JSON request body for POST/PUT, as the object itself (sent as application/json)." },
        headers: O("Extra request headers, e.g. X-Registry-Auth. Authorization headers are refused."),
        timeout_ms: I("This call's timeout, e.g. 300000 for a large image pull."),
        fields: FIELDS,
      },
      ["path"]
    ),
    export: "portainerDocker",
    reads: false,
  },
  {
    name: "portainer_kubernetes",
    description:
      "Call the Kubernetes API of one environment through Portainer: list and read anything (GET /api/v1/namespaces/{ns}/pods, /apis/apps/v1/deployments), pod logs (GET /api/v1/namespaces/{ns}/pods/{pod}/log with query tailLines, container, previous=true after a crash), and change things (PATCH defaults to a merge patch: scale with {\"spec\":{\"replicas\":0}} on /apis/apps/v1/namespaces/{ns}/deployments/{name}). metadata.managedFields is dropped from answers unless keep_managed_fields. Use `fields`, e.g. metadata.name,ns=metadata.namespace,phase=status.phase,node=spec.nodeName for pods.",
    parameters: obj(
      {
        environment: ENVIRONMENT,
        method: S("HTTP method. Defaults to GET.", { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }),
        path: S("Kubernetes API path with a leading slash, e.g. /api/v1/pods or /apis/apps/v1/namespaces/web/deployments/api."),
        query: O("Query parameters: labelSelector, fieldSelector, limit, tailLines, container, previous…"),
        body: { type: ["object", "array", "string"], description: "Request body as the object itself; YAML is not accepted, send JSON." },
        headers: O("Extra headers, e.g. {\"Content-Type\": \"application/json-patch+json\"} for a JSON patch, or application/strategic-merge-patch+json."),
        keep_managed_fields: B("Keep metadata.managedFields (dropped by default; it is often half an object)."),
        fields: FIELDS,
      },
      ["path"]
    ),
    export: "portainerKubernetes",
    reads: false,
  },
  {
    name: "portainer_request",
    description:
      "Call any Portainer API endpoint with the configured URL and token, for what the other tools do not cover: users and teams, registries, environment groups and tags, settings, app templates (/templates), GitOps sources, Helm releases (/endpoints/{id}/kubernetes/helm), stack git settings (POST /stacks/{id}/git), webhooks, backups, edge stacks and jobs. Paths are under /api. Returns the JSON reply, environment values redacted.",
    parameters: obj(
      {
        method: S("HTTP method. Defaults to GET.", { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }),
        path: S("The path under /api, e.g. /registries or /endpoints/3/kubernetes/helm."),
        query: O("Query string parameters. An object value is sent as JSON, as Portainer's `filters` wants."),
        body: { type: ["object", "array", "string"], description: "JSON request body for POST/PUT/PATCH, as the object itself." },
        fields: FIELDS,
      },
      ["path"]
    ),
    export: "portainerRequest",
    reads: false,
  },
];

const config = {
  url: {
    type: "string",
    required: true,
    help: "Base URL of the Portainer server, e.g. https://portainer.example.com:9443 or http://10.0.0.5:9000 (with or without /api).",
  },
  token: {
    type: "string",
    secret: true,
    required: true,
    help: "A Portainer access token (ptr_…) from My account → Access tokens → Add access token. It acts as that user, with that user's role and environment access. Every portainer_* tool reads it.",
  },
  environment: {
    type: "string",
    help: "Default environment (id or name) for the tools that act on one, so it need not be named in every call. Unset: the only environment when there is one, else each call names it.",
  },
  readOnly: {
    type: "boolean",
    default: false,
    help: "When true, every tool that would change something refuses (deploys, updates, container actions, and any non-GET call through the proxies). Reads work as usual.",
  },
  exposeEnv: {
    type: "boolean",
    default: false,
    help: "When false (the default), environment-variable values in stacks, containers and Kubernetes objects are shown as [REDACTED]; names stay visible. Set true to show the values to the agent.",
  },
  insecureTls: {
    type: "boolean",
    default: false,
    help: "Accept an untrusted TLS certificate, such as the self-signed one Portainer serves on :9443 by default. Only for a server you know.",
  },
  timeoutMs: {
    type: "number",
    default: 30000,
    help: "Per-request timeout in milliseconds, clamped to 5000-300000. Stop and restart wait longer on their own.",
  },
  maxChars: {
    type: "number",
    default: 20000,
    help: "Longest answer a tool returns, in characters (2000-200000); longer ones are cut with a note that says how to narrow them.",
  },
};

const dir = new URL(".", import.meta.url).pathname;
const existing = existsSync(`${dir}package.json`) ? JSON.parse(readFileSync(`${dir}package.json`, "utf8")) : {};

const manifest = {
  name: "@thetis/portainer",
  version: existing.version ?? "0.1.0",
  description:
    "Portainer's HTTP API as tools: environments, stacks (deploy from text or git, update, redeploy, start, stop, delete), containers (inspect, stats, logs, start, stop, restart, remove), images, volumes, networks and Swarm services, and the Docker and Kubernetes APIs of any environment through Portainer's proxy, with env values redacted and a read-only switch.",
  keywords: ["portainer", "docker", "containers", "compose", "stacks", "swarm", "kubernetes", "devops", "homelab"],
  license: "MIT",
  type: "module",
  main: "index.js",
  scripts: { test: "node test.smoke.mjs" },
  thetis: {
    type: "tool",
    toolGroup: {
      id: "portainer",
      brief: "Run Docker and Kubernetes through a Portainer server: stacks, containers, logs, images and volumes.",
      tags: [
        "portainer",
        "docker",
        "container",
        "containers",
        "docker compose",
        "compose",
        "stack",
        "stacks",
        "swarm",
        "kubernetes",
        "k8s",
        "image",
        "volume",
        "container logs",
        "deploy",
        "redeploy",
        "restart container",
      ],
    },
    tools,
    config,
  },
};

writeFileSync(`${dir}package.json`, JSON.stringify(manifest, null, 2) + "\n");
// The agent imports main with ?v=<its mtime>, so an edit to tools.js or
// client.js alone is invisible until index.js changes too. Touch it.
if (existsSync(`${dir}index.js`)) utimesSync(`${dir}index.js`, new Date(), new Date());
console.log(`wrote package.json: ${tools.length} tools, ${Object.keys(config).length} config keys, version ${manifest.version}`);

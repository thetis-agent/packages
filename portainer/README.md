# @thetis/portainer

[Portainer](https://www.portainer.io)'s HTTP API (`/api`) as Thetis tools: find environments, deploy and redeploy stacks, read container state and logs, start, stop and restart things, see what is taking up the disk, and reach the Docker or Kubernetes API of any environment through Portainer's proxy.

The tool shape takes its lessons from Portainer's own MCP server, [portainer/portainer-mcp](https://github.com/portainer/portainer-mcp), and its `portainer-mcp-hygiene` skill: env values redacted by default, a projection argument on everything that returns a list, a read-only switch, the Docker and Kubernetes proxies as first-class tools, and the habits that keep a model from misreading Portainer (edge health is the heartbeat, not `Status`; a deploy that returned has not proved anything). Where that server generates 400 tools from the OpenAPI spec, this package has fourteen written for the questions people ask, plus `portainer_request` for the rest.

## Setup

| Key | Value |
|---|---|
| `url` | Base URL of the server, e.g. `https://portainer.example.com:9443` or `http://10.0.0.5:9000` (with or without `/api`). |
| `token` | An access token from **My account → Access tokens → Add access token** (starts with `ptr_`). Secret. It acts as that user, with that user's role and environment access. |
| `environment` | Optional default environment, by id or name, so calls need not name one. |
| `readOnly` | `true` makes every tool that changes something refuse. Default `false`. |
| `exposeEnv` | `true` shows environment-variable values; by default they read `[REDACTED]`. |
| `insecureTls` | `true` accepts an untrusted certificate, such as Portainer's self-signed one on :9443. |
| `timeoutMs`, `maxChars` | Per-request timeout (default 30000) and the longest answer (default 20000 characters). |

Then `portainer_health`: the version, whether the token works and as whom, and the environments it sees.

## Tools

| Tool | Does |
|---|---|
| `portainer_health` | Version, edition, token user and role, environments with status, this package's switches. |
| `portainer_environments` | Environments with platform, connection, status (heartbeat for edge agents) and snapshot counts; one in detail. |
| `portainer_stacks` | Stacks across environments or in one; one with env, git source and deployed commit, failure message, its containers, and `file=true` for the compose file. |
| `portainer_stack_deploy` | New stack from compose text or a git repository; Docker, Swarm or Kubernetes by the environment. Waits for the deploy and answers the outcome. |
| `portainer_stack_update` | New file, env replaced or merged, re-pull images, prune; a git stack pulls and redeploys and reports the commit before and after. |
| `portainer_stack_control` | Start or stop a stack. |
| `portainer_stack_delete` | Delete a stack; volumes kept unless asked. |
| `portainer_containers` | Container lines with state, image, stack and ports, filtered; one with exit code, health output, mounts, networks, `stats`, `top`. |
| `portainer_container_action` | start, stop, restart, kill, pause, unpause, remove; answers the state afterwards. |
| `portainer_container_logs` | The last lines, `since`, `grep`, stderr marked. Never follows. |
| `portainer_docker_resources` | images, volumes, networks, `info`, `df`, and on Swarm services, tasks, nodes, secrets, configs. |
| `portainer_docker` | Any Docker Engine API call in one environment. `/stats` is made one-shot, `/events` bounded, `follow` refused. |
| `portainer_kubernetes` | Any Kubernetes API call in one environment. PATCH defaults to a merge patch; `managedFields` dropped. |
| `portainer_request` | Any other Portainer endpoint: users, teams, registries, templates, GitOps sources, Helm, settings. |

Environments and stacks are named by **id or name** wherever one is taken; an ambiguous name is answered with the candidates.

## Conventions the tools follow

- **`fields`** cuts a list (or one object) to named paths before it reaches the model: `id=Id,name=Names[0],State`, `Labels."com.docker.compose.project"`, and for Kubernetes lists `metadata.name,phase=status.phase`, projected per item. It is a small quote-safe path language rather than JMESPath: no filters, no functions, nothing to escape twice inside a tool call.
- **Env values are redacted** (`Env` / `EnvVars` lists: stack `{name, value}` pairs, Docker `KEY=VAL` strings, Kubernetes `env[].value`; `valueFrom` references stay). Redaction runs on the whole object before `fields`, so an alias cannot route around it. The answer says how many were redacted. Logs are not redacted: a program that prints its secrets prints them.
- **Deploys are asynchronous since Portainer 2.45**: a stack comes back `deploying` and compose runs behind it. The stack tools poll until it is `active` or `failed` (up to `wait_seconds`, default 90), answer Portainer's own error message on a failure, and list the stack's containers, because a returned call is not a running app.
- A **git stack** redeploys with a bare body, which keeps its stored ref, env and credentials; its file cannot be replaced from here, only in the repository.
- **Read-only** refuses every write by name and tells the model not to retry it as a read.
- The token goes in the `X-API-Key` header and nowhere else: no answer or error contains it, and the proxies refuse `X-API-Key`, `Authorization`, `Cookie` and `Host` headers.

## Development

```
node manifest.mjs   # regenerate package.json from the tool table
node test.smoke.mjs # an in-memory Portainer behind a local HTTP server, every tool
```

To try it against a real server without touching one, run a throwaway Portainer CE on the local Docker (`portainer/portainer-ce:lts`, port 9000 bound to 127.0.0.1), initialise the admin with the `X-Setup-Token` it prints in its log (2.45+), mint an access token with `POST /api/users/1/tokens`, and add the local socket with `POST /api/endpoints` (`EndpointCreationType=1`). It sees the host's real containers, so deploy a test stack of your own and leave the rest alone.

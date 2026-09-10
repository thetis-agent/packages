# Exa API tools

`tools-exa` gives Thetis seven tools. It uses direct HTTPS requests to
`https://api.exa.ai`. It has no SDK dependency.

| Tool | Exa API | Use |
| --- | --- | --- |
| `exa_search` | `POST /search` | Search with domain, date, category, and content options. |
| `exa_contents` | `POST /contents` | Get page text, highlights, summaries, and page status. |
| `exa_answer` | `POST /answer` | Get an answer with source citations. |
| `exa_agent_start` | `POST /agent/runs` | Start a paid research run. |
| `exa_agent_get` | `GET /agent/runs/{id}` | Read a run and its results. |
| `exa_agent_cancel` | `POST /agent/runs/{id}/cancel` | Cancel a run. |
| `exa_agent_stop` | `POST /agent/runs/{id}/stop` | Stop a max-effort run and keep its results. |

Search supports `auto`, `fast`, `instant`, `deep-lite`, `deep`, and
`deep-reasoning`. The default is `auto`, five results, and short highlights.
Use search for code, news, people, or company discovery. Contents accepts at most
100 HTTP or HTTPS URLs. It defaults to 4,000 text characters per page. Answer
uses the `exa` model and returns one complete JSON response with citations.

Agent start defaults to `low` effort. It returns the run ID without waiting for
the research to finish. Use get to check progress. Closing a local request does
not cancel the remote run. Use cancel for that operation. Stop requires `max`
effort. The package sends the required beta header for max effort and stop.
It saves each new run ID with its authenticated owner. A caller can read, cancel,
stop, or continue only their saved runs. This rule survives a process restart.

The JSON schemas list the supported arguments. Unknown top-level arguments are
ignored. Raw API errors are discarded. Results keep source URLs, citations,
structured output, and partial page failures. Results are JSON text in the normal
tool content channel. Primitive metadata is in `CallAnswer.data`. The core uses
its normal spill path for large text results.

## Deployment

Use a runtime with `contract/tool-service` 1.0 and the `ctx.callService` loader
helper. Use the core version that forwards the call cancellation signal.

1. Select `tools-exa` and `contract/tool-service` in the API target and each
   caller's environment. Keep the existing runtime library selections, including
   `lib/service`, `lib/provider`, and their dependencies.
2. Create a deployment target with `package: "tools-exa"`, `entry: "service.ts"`,
   and `spawn: "exa"`. The package registers its process and egress requirement.
3. Set the deployment secret named `exa-key` through the kernel secret store.
   The kernel delivers it as `EXA_API_KEY` only to the registered process.
4. Grant the target to each caller. For a target named `exa`, add
   `{"id":"exa","mount":"/services/exa"}` to the caller's recipe `services`.
5. Set the caller's `profile.provided["service/tool-service.exa"].endpoint` to
   `/services/exa/current.sock`. This is the stage connection map. Requirement
   facts belong in the inner `profile.profile.provided` map, as described below.
6. Set the API target's cost rule and settings. Apply the ordinary deployment
   prepare and activation process.

The API target's `profile` can contain:

```json
{
  "provided": {
    "secret/exa-key": { "version": "1.0.0", "scope": "deployment" },
    "cap/network.egress": { "version": "1.0.0", "scope": "deployment" }
  },
  "rule": { "name": "exa-daily", "cost": 1, "requests": 100, "windowMs": 86400000 },
  "settings": { "agentMaxCostDollars": 1 }
}
```

Contract selections supply the contract facts. Each caller's inner
`profile.profile.provided` also needs the secret and egress facts for package
matching. These are capability declarations; they contain no secret value and
do not grant network access to the stage. The service is a provision of the
selected package. Do not repeat that provision in the requirement fact map.

The ordinary environment contains the tool stage. The registered process
contains the API client. Both belong to this package. Exa hosts the API.
The local process exists to meet Thetis's secret and cost rules.

## Limits and costs

| Setting | Default | Maximum |
| --- | --- | --- |
| `deadlineMs` | 30,000 | 120,000 |
| `requestBytes` | 32,768 | 65,536 |
| `responseBytes` | 262,144 | 524,288 |
| `concurrency` | 4 | 16 |
| `agentMaxCostDollars` | $1 | $100 |
| `runLimit` | 1,024 | 4,096 |

The caller's deadline can reduce the configured deadline. There are no automatic
retries. The runtime also limits service connections and frames.

The process reserves the reviewed maximum before API access. It stores the
reservation, checks the caller's trusted cost ceiling, and reports the complete
reserved cost before returning. Timeouts and vendor errors retain that charge
when work might have started. `reservedCost` is conservative local accounting.
`estimatedCost`, when returned by Exa, is an estimate, not an invoice.

Search, content, and answer prices are deployment settings. Their defaults match
the pricing page checked on 2026-09-10. Fixed agent efforts use the published
prices: $0.012, $0.025, $0.10, $0.50, and $1.00. Auto and max use an explicit Exa
budget. Their requested budget cannot exceed `agentMaxCostDollars`. Exa Connect
providers, account-wide run listing, Websets, and Monitors are outside this
package's tool set. The package does not send data-source grants.

State contains `budget.json` and `exa-runs.json`. Keep both when restarting or
updating the process. The run ledger has no automatic deletion. At its limit,
new runs are refused; saved runs remain accessible. Increase `runLimit` within
its bound or archive retired records during a stopped maintenance operation.
Removing a record removes tool access to that remote run.

## Verification

Run the runtime's `scripts/check.ts` and `scripts/test.ts` with this repository
as its peer checkout. Tests EXA-001–009 cover API mappings, filters, errors,
limits, secret redaction, ownership, restart, and the registered process.
The offline suite uses a fake HTTP edge and fake keys.

`live.ts` is an opt-in acceptance entry. It reads a key from inherited fd 3 and
the key byte count from its first argument. Run it inside an authorized test
namespace with private egress, the installed source layout, writable bounded
`/tmp`, and delegated `/cgroup`. It runs the API client and cost admission code with real HTTP
requests to Search, Contents, and Answer. Its per-person cost ceiling is $0.05. It
prints only tool metadata and checks results and state for secret leakage.
The registered process and kernel service grants are tested offline.
Never put a key in command arguments, source files, or committed settings.

Protocol references checked on 2026-09-10:

- [Exa OpenAPI specification](https://exa.ai/docs/exa-spec.json)
- [Search API guide](https://exa.ai/docs/reference/search-api-guide-for-coding-agents)
- [Contents API guide](https://exa.ai/docs/reference/contents-api-guide-for-coding-agents)
- [Agent API overview](https://exa.ai/docs/reference/agent-api/overview)
- [Exa pricing](https://exa.ai/docs/reference/pricing)

Live acceptance on 2026-09-10 passed for Search, Contents, and Answer.
Exa reported an estimated total cost of $0.013. Local reservations also totaled
$0.013. Agent operations were tested offline; no paid agent run was started.

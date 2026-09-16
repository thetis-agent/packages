---
name: bench
description: The Thetis benchmarks. What they measure (the harness, not the model), the three suites assembly-cost@1, tool-recall@1, and skill-recall@1, how a package opts in through thetis.bench with suites, corpus, peerGroup, importer, and adapter, the two seams (the corpus file in, the claim in harness out), how claims are checked against canaries, how to run with thetis bench run and verify, the report and BENCH.md, and what the numbers do not say. Use when you ask "how do I benchmark my package", "what is a bench step", "why is my arm marked as lying", "how do I run a suite", or "what does recall_reach mean".
metadata:
  title: Benchmarks
  tags: [bench, benchmark, suite, arm, corpus, canary, claim, importer, adapter, peer, report, recall, bytes, floor]
  related: [thetis/packages, thetis/skills, thetis/pipeline]
  version: 1
---
# Benchmarks

The benchmarks measure the harness, not the model. They answer one question: when a package changes what Thetis puts in front of the model, is the result better, and at what cost? A package opts in through its manifest. A suite runs against every package that opted in, plus a floor with none of them. Each package then carries a `BENCH.md`.

## What is measured

The bench measures from a provider of its own, `@thetis/provider-bench`. It records the assembled `ProviderCall` and answers from a script. It never reaches the network. Two kernel facts make this work with no kernel change:

- A step runs only when its phase is in `config.phases`. The bench adds a phase named `bench`. No production configuration lists it, so a bench step cannot run on an ordinary turn.
- A provider that advertises the model `*` gets every call. The bench puts its addressing in `call.model` as `bench/<run>/<arm>/<task>/<attempt>`. The query text reaches the harness unchanged.

Do not measure from a step. `ctx.call.messages` is empty for the whole pipeline, and the cache hints come after a `bench` step.

## Claims are checked

Every record in a corpus carries a canary token in its body. A mechanism can reformat a body and must keep the token. The bench finds what reached the prompt by looking for canaries. A package also reports what it believes it surfaced. That report is never scored. It is compared:

| Number | Meaning |
|---|---|
| `adapterLies` | Claimed as in the prompt with no canary. This fails the run. |
| `adapterModest` | Reached the prompt and was not claimed. Not a failure. |
| `offeredUnverified` | Claimed reachable with nothing to show for it. Excluded from every score. |

Reach is proved in three ways. A body in the prompt is proved by its canary. A catalogue entry is proved when the prompt names the id. A search tool is proved when the tool returns the record.

## Suites

| Suite | Needs | Measures |
|---|---|---|
| `assembly-cost@1` | nothing | Bytes by segment (`system`, `tools`, `messages`), how much of the prefix survives a turn, how many steps run. Any package can opt in. |
| `tool-recall@1` | authored gold | What share of the offered tools a task needed, and what the rest cost. |
| `skill-recall@1` | the capability corpus | Which capabilities a request made reachable, how far away they were, and what the rest cost. |

A suite lives in `packages/bench/suites/<name>/`: `suite.json`, `tasks.jsonl`, an optional `script.json`, and for `skill-recall@1` a `corpus.json`.

## Opt in

```json
"thetis": {
  "type": "loader",
  "steps": [
    { "id": "pin", "phase": "prompt", "export": "pin" },
    { "id": "bench-import", "phase": "bench", "export": "importCorpus" },
    { "id": "bench-report", "phase": "bench", "export": "benchReport" }
  ],
  "bench": {
    "suites": ["skill-recall@1"],
    "corpus": "caps@1",
    "peerGroup": "skills",
    "importer": "importCorpus",
    "adapter": "benchReport"
  }
}
```

| Field | Use |
|---|---|
| `suites` | Required. Each named `id@version`. |
| `corpus` | The corpus the package imports. Required by a suite that has one. |
| `peerGroup` | Which packages this one is compared against. Default: the first suite id. |
| `importer` | The export that reads the corpus. Must also be a step with phase `bench`. |
| `adapter` | The export that reports what was surfaced. Must also be a step with phase `bench`. |
| `arms` | Names of internal configurations, when a package has more than one. |
| `report` | Where the generated view goes inside the package. Default `bench`. |

A tool package needs only `suites` and `peerGroup`. Example: `"bench": { "suites": ["assembly-cost@1", "tool-recall@1"], "peerGroup": "tools" }`. The kernel does not read `thetis.bench`. `thetis bench verify <dir>` validates it.

## The two seams

Corpus in. The bench writes `bench/corpus.json` under the home before the first turn. The importer reads it with `env.readFile` and builds any representation under `env.cwd`. It runs on every bench turn. Make it idempotent.

Ids out. The adapter writes a claim to `harness["@thetis/bench"].claims[<package>]`:

```js
export async function benchReport(ctx) {
  const bench = ctx.harness["@thetis/bench"] ?? {};
  const claims = { ...(bench.claims ?? {}), "@alice/skills": { direct: ["cap.a"], offered: ["cap.b"], reach: "catalogue" } };
  return { harness: { ...ctx.harness, "@thetis/bench": { ...bench, claims } } };
}
```

`direct` is in the prompt now. `offered` is one tool call away. `reach` is `direct`, `catalogue` (a named entry), or `search` (a ranked query). `ranked` is an order. Only a mechanism that ranks has one. Spread what is already in `harness`. The kernel replaces `harness` and does not merge it.

## Run

```sh
npm run bench -- run assembly-cost@1
npm run bench -- run skill-recall@1 --write
node bin/thetis.js bench run tool-recall@1 --write --sandbox none
node bin/thetis.js bench verify packages/tools-files
```

| Option | Effect |
|---|---|
| `--write` | Write the suite report and each package's view. Without it nothing is written. |
| `--force` | Write even when the digest is unchanged. |
| `--out <dir>` | Also write the suite report to this directory. |
| `--sandbox` | `auto`, `bwrap`, or `none`. Recorded in the report. |
| `--package <dir>` | Add a package that is not under `packages/`. |
| `--model <id>` | Put a real model in the loop. Costs money. |
| `--max-cost <usd>` | Stop starting calls once this much is spent. Default 1. |
| `--tasks <n>` | Take only the first n tasks. |

A run boots its own kernel in a temporary `$THETIS_HOME` and deletes it afterwards. It never touches the data directory or a running daemon. The exit code is 1 when an arm claimed what the prompt does not show. The bench runs on the host, not in a fence. You cannot run it with `shell` inside your userspace. Ask an operator.

## The report

There is one report per suite at `<root>/bench/<suite>/report.json`. Each participating package carries `bench/<suite>/report.json` and a `BENCH.md`. The package copy carries the suite digest. A copy whose digest does not match is stale. A peer's row appears only when its report used the same corpus digest and suite digest.

## What the numbers say and do not say

- Units are bytes, not tokens, kept apart by segment. `non_ascii_ratio` is a tripwire.
- `recall_reach`, `undershoot`, and `overshoot_bytes` are always printed together. A package wins any one of them alone by degenerating.
- `ndcg`, `hit_at_1`, and `mrr` are printed only under the arm that produced them. A mechanism with no order has no ranking.
- Every comparison is paired by task against the floor. Intervals come from a seeded bootstrap with 2,000 resamples.
- Absolute milliseconds are not committed.
- The gold is imported, not derived. It says which capability a person thought a question needs. Nothing scores whether a task was answered. No suite runs against a model by default.

Read the **Notes** section of a report before you quote a figure.

## Sources

- docs/21-benchmarks.md
- docs/08-cli.md
- packages/bench/README.md
- packages/bench-probe/README.md

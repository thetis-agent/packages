# @thetis/bench

The benchmark harness. It measures what a package makes available to the model for a query, what that costs in bytes and round trips, and how the package compares with its peers. It runs on the host, not in a fence: a run boots its own kernel in a temporary `$THETIS_HOME`, drives every arm over a suite, scores what the harness assembled, and deletes the home afterwards. It never touches the data directory or a running daemon. The package has no `thetis` field and is not installable.

## What it provides

The command `bench`, reachable as `npm run bench --` from the runtime root or as `thetis bench`:

```
bench run <suite-id|suite-dir> [--write] [--force] [--out <dir>] [--sandbox auto|bwrap|none] [--package <dir>]
                               [--model <id> --max-cost <usd> --tasks <n>]
bench verify [<package-dir>]
```

`run` measures a floor arm with no participating package, one arm per package that opted into the suite, one more arm per name in a package's `thetis.bench.arms` under that arm's `armConfig` (set at the arm's own user layer, so two configurations of one package never share a setting), and, when every participant is a shipped `@thetis/*` package, an `all` arm with all of them. A suite's `base` packages go to every arm, the floor included. Its exit code is 0 when every arm conformed and 1 when one did not. `verify` checks a package's `thetis.bench` declaration without running anything.

Three suites under `suites/`:

| Suite | Needs | Measures |
|---|---|---|
| `assembly-cost@1` | nothing | What a package costs the prompt: bytes by segment (`system`, `tools`, `messages`), how much of the prefix survives a turn, how many steps ran. Any package with a step or a tool can opt in. |
| `tool-recall@1` | the tool-groups corpus, `suites/tool-recall-v1/corpus.jsonl`, authored (`GOLD.md`) | Which tool groups a request put in the call, and what the rest cost. The corpus reaches every arm as installed packages through `suites/tool-recall-v1/suite.json`'s `base` fixture; a routing package is scored on the canaries in the tool segment: `route_recall`, `route_precision`, `route_f1`, `routed_nothing`, `surface_tools`. |
| `skill-recall@1` | the capability corpus, imported from SkillRet (`suites/skill-recall-v1/GOLD.md` and `NOTICE.md`) | Which capabilities a request made reachable, how far away they were, and what the rest cost. |

The fixtures under `fixtures/` are the bench's own provider, `@thetis/provider-bench`, which records the `ProviderCall` it was given and answers from a script, four reference arms for `skill-recall@1`: `skills-flat`, `skills-l1`, `skills-rank`, and `skills-liar`, which exists to be caught, and `tool-corpus`, which installs the `tool-recall@1` corpus into every arm as one package per group. Every run also installs `@thetis/bench-probe` and adds the phase `bench` to the pipeline, which is how a package's bench steps get to run.

Claims are checked, not believed: every corpus record carries a canary token, and reach is proved by finding it in the assembled prompt. `adapterLies` fails the run. Units are bytes, not tokens, kept apart by segment, because the repository has no tokeniser.

The library (`dist/src/index.js`) exports the arena, the runner, the scorer, the report writer, `validateBench`, `run`, `verify` and `main`.

## Configuration

There is no `config.packages["@thetis/bench"]`: the bench is not installed by the kernel, and a run builds its own configuration. That configuration sets `@thetis/harness-core`'s `turnContext` to `false`: a dated line on the query would move `bytes_messages` with the weekday, and a retriever under measurement must see the task's query exactly as the corpus wrote it. With `--model`, the provider forwards each call to OpenRouter and reads `OPENROUTER_API_KEY` from the environment of the process that runs the bench. `--max-cost` (default 1 dollar) governs whether another call is started, not what one costs, so the last call may carry the total a little past the line.

A package opts in through its own manifest:

```json
"bench": { "suites": ["assembly-cost@1", "tool-recall@1"], "peerGroup": "tools" }
```

A suite that hands out a corpus also needs `corpus`, `importer` and `adapter`; the importer and adapter must also be declared in `thetis.steps` with phase `bench`. `report` names the directory the package's view goes to (default `bench`). `arms` names further configurations of the package and `armConfig` gives each its settings: `"arms": ["dense"], "armConfig": { "dense": { "denseMode": "fallback" } }`.

## Use

```sh
npm run bench -- run assembly-cost@1
npm run bench -- run skill-recall@1 --write
node bin/thetis.js bench run tool-recall@1 --write --sandbox none
node bin/thetis.js bench verify packages/tools-files
```

| Option | Effect |
|---|---|
| `--write` | Write `<root>/bench/<suite>/report.json` and each participating package's `bench/<suite>/report.json`, `bench/<suite>/chart.svg` and `BENCH.md`. Without it nothing is written. |
| `--force` | Write even when the digest is unchanged. |
| `--out <dir>` | Also write the suite report to this directory. |
| `--sandbox` | `auto`, `bwrap` or `none`. Recorded in the report; arms of one report must share it. |
| `--package <dir>` | Add a package that is not under `packages/`. |
| `--model <id>` | Put a real model in the loop. Costs money. |
| `--max-cost <usd>` | Stop starting calls once this much has been spent. Default 1. |
| `--tasks <n>` | Take only the first n tasks. For use with `--model`. |

Continuous integration regenerates every report and fails on any difference, then runs again and fails if anything was written at all: a mechanism that answers differently on identical input cannot be compared with anything.

## Files

| File | Content |
|---|---|
| `bin/bench.js` | The command. |
| `src/cli.ts` | `run`, `verify`, `main`, the option parsing, the notes a report carries. |
| `src/arena.ts` | Boots the throwaway kernel and stages the arms. |
| `src/runner.ts`, `src/capture.ts` | Drives the tasks and captures what the provider saw. |
| `src/score.ts`, `src/metrics/` | Recall, ranking, and the paired bootstrap. |
| `src/report.ts`, `src/peers.ts` | The report, its digest, the package views, the peer rule. |
| `src/chart.ts` | `chart.svg`: the compared columns of one view as bars, derived from the view alone so a rerun writes the same bytes. `BENCH.md` shows it with a relative image path, and a README can do the same. |
| `src/suite.ts`, `src/corpus.ts`, `src/manifest.ts` | Suites, corpora, `validateBench`. |
| `suites/`, `fixtures/`, `scripts/import-skillret.mjs`, `scripts/author-tool-groups.mjs` | The three suites, the provider and reference arms, the skills corpus importer, the tool-groups corpus author. |

## Tests

`npm test` from the runtime root. The files are `test/metrics.test.ts`, `test/report.test.ts`, `test/chart.test.ts`, `test/safety.test.ts`, `test/arena.e2e.test.ts`, `test/skills.e2e.test.ts`, `test/provider.test.js`, `test/upstream.test.js` and `test/tool-corpus.test.js`.

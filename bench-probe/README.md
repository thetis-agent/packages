# @thetis/bench-probe

The step that collects what each package claims it surfaced on a bench turn. It is a `loader` package that `@thetis/bench` installs into every arm of a run, beside `@thetis/harness-core`; its one step is declared in the phase `bench`, which no production configuration lists, so it cannot run outside a bench. It is plain ECMAScript with no build step and no dependencies.

## What it provides

One step, declared in `thetis.steps`:

| Step id | Phase | Export | What it does |
|---|---|---|---|
| `collect` | `bench` | `collect` | Normalises the claims packages left in `harness["@thetis/bench"].claims` and appends one observation for this turn to `harness["@thetis/bench"].turns`. Everything else already in `harness` is spread forward, because the kernel replaces `harness` and does not merge it. |

A claim is what a package's adapter says it surfaced: `{ direct, offered, reach, ranked?, arm?, scores?, budgetBytes?, droppedForBudget? }`. `normalise` keeps the fields the bench can use and drops anything malformed, because a bad claim is a finding rather than a crash; a `reach` that is not `direct`, `catalogue` or `search` is not recorded. The claim is never scored: the bench compares it with the canaries in the assembled prompt, and a package that lies is caught there.

An observation is what the fence can see of the call in the `bench` phase: `{ turn, model, systemBytes, tools, packages, conversation }`. It is a second opinion, not the measurement: `call.messages` is still empty at that point and the cache hints have not been added yet, so byte accounting belongs to the bench's provider. What is useful is the step order and the tool list, which prove that the `bench` phase ran and in what company; `@thetis/bench` checks that this package's step appears in each observation's step list.

No tools, no service, no UI, no bench suites of its own.

## Configuration

`config.packages["@thetis/bench-probe"]` has no keys. The package reads no environment variables. It is in no `systemPackages` list; only the bench installs it, into the temporary home of a run.

## Use

Nothing calls this package by hand. A bench run installs it into every arm:

```sh
npm run bench -- run assembly-cost@1
```

What the host reads back after a turn through `sessions.inspect`:

```json
"@thetis/bench": {
  "claims": { "@alice/skills": { "package": "@alice/skills", "direct": ["cap.a"], "offered": ["cap.b"], "reach": "catalogue" } },
  "turns": [{ "turn": "t_1", "model": "bench/r1/arm/t-1/0", "systemBytes": 5, "tools": ["exec"], "packages": ["@thetis/harness-core@0.1.0"], "conversation": 1 }]
}
```

An adapter that wants its claim collected writes it from its own `bench` step, spreading what is already there:

```js
export async function benchReport(ctx) {
  const bench = ctx.harness["@thetis/bench"] ?? {};
  const claims = { ...(bench.claims ?? {}), "@alice/skills": { direct: ["cap.a"], offered: ["cap.b"], reach: "catalogue" } };
  return { harness: { ...ctx.harness, "@thetis/bench": { ...bench, claims } } };
}
```

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: one step in the phase `bench`. |
| `index.js` | `collect` and the key `KEY`, which is `@thetis/bench`. |
| `lib/claims.js` | `normalise`, `normaliseAll`. |
| `lib/observe.js` | `observe`. |

## Tests

`npm test` from the runtime root runs `test/probe.test.js` with `node --test`: a well formed claim, a malformed one, junk inside a claim, the observation, and that `collect` keeps other packages' harness keys.

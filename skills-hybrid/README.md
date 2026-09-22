# @thetis/skills-hybrid

The multilayer loader, and the default for everyone: one brief per top-level skill is always in the system prompt, the bodies of universal skills are in full, and a few skills retrieved for the conversation are shown as cards. The retrieval runs once, on the first user message, by dense and lexical ranking fused, and is pinned by id and content hash so the prompt prefix does not move on later turns. A tool, `skill_search`, ranks the same way for anything the first message did not cover; `skill_fetch` from `@thetis/skills` reads a body. The prompt grows by one line per skill and a few cards however large the packs get; the price is a round trip before any body is in hand, and an embeddings call when the cache has no vector for a skill. It is a `loader` with one `prompt` step, one tool and the two `bench` steps, plain ECMAScript with no build step and no dependencies beyond `@thetis/skills`, which must be installed beside it.

## What it provides

| Step | Phase | Export | Effect |
|---|---|---|---|
| `pin` | `prompt` | `pin` | Appends `# Skills` with one brief per top-level skill in id order, `# Skills always in force` with the universal bodies, and `# Skills retrieved for this conversation` with the cards (or bodies) of the pinned set. Ranks on the first turn, reuses the pin on every later one. Writes the state under `harness["@thetis/skills"]`. |
| `bench-import` | `bench` | `importCorpus` | The shared importer from `@thetis/skills`, then the corpus's vectors from `bench/vectors/<corpus sha256>.json` into the cache under the home. |
| `bench-report` | `bench` | `benchReport` | The claim: `direct` the universal ids (and the pinned ids when `pinBodies`), `offered` every other corpus id, `reach: "search"`, `ranked` the top 10, `scores`. |

| Tool | Arguments | Returns |
|---|---|---|
| `skill_search` | `query` (required), `k` (default 5, at most 20) | One line per hit: the brief, then `[how, score]` where `how` is `dense`, `lexical` or `parent-of-match`. Nothing is pinned. A universal skill is not a result. A skill the project switched off is not there. |

The state under `harness["@thetis/skills"]`:

```js
{ loader: "@thetis/skills-hybrid", universal: ["concise"], pinned: [{ id: "packages", contentHash: "…", score: 0.011475, how: "dense" }], loaded: [], catalogue: [...top-level ids], dropped: [], excluded: [...], ranked: [{ id, score, how }, ...up to 10], mode: "dense", pinBodies: false, notes: [] }
```

`notes` names each skill left out for a lint error, what a project switched off, another skills loader when one is installed, why the ranking was lexical when it was, and a pinned skill that changed or vanished.

Bench suites: `skill-recall@1` and `assembly-cost@1`, peer group `skills`, corpus `caps@1`.

## Benchmarks

![skill-recall@1 comparison](bench/skill-recall-v1/chart.svg)

![assembly-cost@1 comparison](bench/assembly-cost-v1/chart.svg)

On `skill-recall@1` every needed skill is reachable (recall_reach 1, undershoot 0, overshoot 0) at one fetch round, as with `@thetis/skills-l1`, and the ranking it adds is reported under its own arm: nDCG 0.850, hit@1 0.863, mrr 0.913 over the 80 scored tasks (0.829, 0.850 and 0.890 before `denseThreshold`: the floor cut noise, not hits). The price is about 2 KB of cards over the catalogue loader (bytes_system 49,099 against 47,638) and a second tool schema (595 bytes against 443), which buys a pin the model does not have to search for; against `@thetis/skills-all` it carries half the system bytes (95,296) and reaches 1 instead of 0.035 with no overshoot instead of 9.5 unneeded bodies, in exchange for one round trip per body. On `assembly-cost@1` it is the dearest of the three by a few hundred bytes per turn (1,059 system over a 1,027 floor, 595 tool) and the same 18 steps.

## How it works

The query is the first user message, cut to 2000 characters. The dense list is the cosine between the query's vector and each skill's vector, where the text embedded is the name, the description and the tags, never the body. The lexical list is BM25 from `@thetis/skills`. Each list is 50 deep. They are fused by weighted reciprocal rank fusion (K 60) with `fusionWeight` as the dense share; a child whose parent is in the pool is absorbed into the parent; the parent of a lone child is promoted at 0.99 of its score; the first `pinLimit` are pinned, universal skills excluded. The legacy measurement behind the default weight: on 9.5k documents, dense beat BM25 by 0.078 nDCG and fusion at 0.7 beat dense by 0.023.

A dense hit below `denseThreshold` is not a hit: a greeting is closest to some card, and without a floor that card would be pinned. The default comes from `skill-recall@1` (287 cards, 90 tasks, `openai/text-embedding-3-small`): the gold cards' cosine against their query has median 0.475 and a 5th percentile of 0.28, and the controls' best card has median 0.28. At 0.3, 94% of the gold cards pass and 7 of the 10 controls get no dense hit at all; at 0.35 it is 87% and 9 of 10. When the floor cuts every dense hit the pin is lexical and a note says so. Another embedding model moves the whole scale, so the key is per installation.

The pin is kept in the harness by id and content hash. On later turns the step renders the same ids without ranking again. A skill whose content hash changed (its name, description or tags) is rendered from its new text in the same place, with a note; one that vanished is dropped, with a note. A body edit does not move the hash.

Vectors come from `POST <baseUrl>/embeddings` with `{ model, input, dimensions }`, 64 texts per request, 20 seconds per request, and are cached at `skills-hybrid/vectors.json` under the home, keyed `model|dimensions|contentHash`, rounded to 6 decimals. A turn embeds only what the cache lacks and writes the file with every key no live skill has removed. The query's vector is never cached. Without a key, or when a request fails, the ranking is lexical for that turn and one note says why; the step never throws and the key appears in no note, no error and no file.

In the bench there is no key. `bench/vectors/<corpus sha256>.json` holds the vectors of every corpus record and of every task query of `skill-recall@1`, produced once by `scripts/embed-corpus.mjs`:

```sh
set -a; . ./.env; set +a; node packages/skills-hybrid/scripts/embed-corpus.mjs
```

The script imports the corpus through the same `importCorpus` the bench uses, so the content hashes agree. The importer copies the skill vectors into the cache; the step looks a query up in the file before it would call the network. A run is deterministic and free; a corpus, model or dimension the file does not match falls back to lexical.

## Configuration

`config.packages["@thetis/skills-hybrid"]`:

| Key | Default | Effect |
|---|---|---|
| `fusionWeight` | `0.7` | The dense share in the fusion. 0 is lexical only, 1 is dense only. |
| `denseThreshold` | `0.3` | The cosine a skill must reach against the query before the dense list counts it. Below it a skill is pinned only when the words match. `0` keeps every dense hit. `skill_search` ignores it: a search asks for the closest thing whatever its distance. |
| `pinLimit` | `6` | How many skills are pinned for the conversation. 0 pins nothing. |
| `pinBodies` | `false` | Pin bodies instead of cards. Costs bytes, saves a round trip. |
| `embeddings.baseUrl` | `https://openrouter.ai/api/v1` | An OpenAI-compatible endpoint. |
| `embeddings.apiKey` | `${OPENROUTER_API_KEY}` | The key, resolved by the config service from the daemon's environment and `.env`. This package's manifest declares the default (`thetis.config.embeddings.default`); a file-layer `embeddings: { baseUrl }` keeps it, since object defaults merge one level deep. Empty means lexical. |
| `embeddings.model` | `openai/text-embedding-3-small` | The embedding model. |
| `embeddings.dimensions` | `1536` | The vector size. |

The package reads no environment variables itself. It writes `skills-hybrid/vectors.json` in the home.

## Limits

- Only top-level skills are in the catalogue; a nested skill is reached through its parent's card, `skill_search` or `skill_fetch`.
- The pin is decided by the first message alone. A conversation that turns to another subject relies on `skill_search`, and the tool description says so.
- One cache file per home, rewritten whole. A pack of thousands of skills embeds once per skill and then costs nothing until a description changes.
- The bench file is 5 MB of numbers. A new corpus needs the script run again.
- `denseThreshold` is a number for one embedding model. A change of model wants a new measurement, and the bench vectors file with it.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: the three steps, the tool, the bench declaration. |
| `index.js` | `pin`, `skillSearch`, `importCorpus`, `seedVectors`, `benchReport`, `queryOf`. |
| `lib/embed.js` | This loader's cache path and index text over the shared embeddings library in `@thetis/skills` (the request, the cache format, the cosine). |
| `lib/rank.js` | The dense list, the fusion with the parent rules, the `how` labels. |
| `lib/retrieve.js` | One ranking of skills against a query, with the fallback. |
| `lib/vectors.js` | The bench vector file by corpus digest, through the shared reader, bound to this package's directory. |
| `scripts/embed-corpus.mjs` | Writes the bench vector file. Needs `OPENROUTER_API_KEY`. |
| `bench/vectors/<sha256>.json` | The vectors of `caps@1` and the queries of `skill-recall@1`. |
| `test/hybrid.test.js` | Fusion determinism, the pin across turns and after a pack update, the fallback, the cache, batching, the bench file, the claim, `skill_search`. |

## Tests

`npm test` from the runtime root, or `node --test "test/*.test.js"` in this directory.

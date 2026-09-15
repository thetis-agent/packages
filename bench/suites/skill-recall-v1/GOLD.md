# Where this corpus and gold came from

Both are imported from **SkillRet** (`ThakiCloud/SKILLRET`, revision `a050ad233a504a43135bafe8cdf45574052b5729`,
Apache-2.0, https://huggingface.co/datasets/ThakiCloud/SKILLRET), a public collection of real agent skills
scraped from public repositories together with generated queries and checked relevance judgements.

It is imported rather than written here for one reason. Gold that decides which retrieval package wins must
not be authored by anyone with a stake in the answer, and the people who assembled SkillRet have never heard
of Thetis. Nothing in this repository can move a judgement in its own favour.

## How the sample was taken

`packages/bench/scripts/import-skillret.mjs`, deterministic from the seed `thetis/bench/caps/v1`, so the
sample is a fact about the inputs rather than a choice made on the day. Rerunning it reproduces this corpus
byte for byte.

- **Queries first, corpus second.** 120 queries are drawn from a seeded shuffle; the corpus is every skill
  they need plus 90 distractors. Sampling the corpus first and keeping whatever queries happened to fit threw
  away almost everything: at a 4% sample of 6,006 skills, a query needing two of them survives about one time
  in six hundred.
- **Distractors are the point.** Without records nothing asks for, an arm that injects the entire corpus is
  also the arm with perfect precision, and there is nothing left to measure.
- **Distractors are stratified** by the dataset's own top-level category, so the noise a retriever must see
  past looks like the corpus rather than one corner of it.
- **Records are dropped, never trimmed:** no body, a description over 1,024 bytes, or a body over 32 KiB. A
  trimmed description would change the very text a retriever matches on, and one 180 KiB body would dominate
  every byte figure in the suite.

## Splits

| Split | Tasks | Where |
|---|---|---|
| `tune` | 30 | here, visible while a package is being written |
| `holdout` | 50 + 10 controls | here, scored |
| `holdback` | 40 | `$THETIS_HOME/bench/holdback/`, outside this tree and outside every fence |

The held-back split is the only real defence against fitting a package's descriptions to the questions. It
is not a convention: it lives outside the packages directory, which every fence mounts read-only, so package
code — including package code Thetis writes for itself — cannot read it.

The ten control tasks are authored, and are the one part of this suite that is. They are questions no
capability in the corpus should help with, and they exist because an arm that bloats the prompt can only be
caught where the right answer is to attach nothing.

## Canaries

Every record carries an opaque token inside its body, derived from the record id and the corpus seed. A
mechanism may reformat a body however it likes and must keep the token. That is how the bench verifies what
actually reached the model without knowing anything about how the mechanism stores it — and it is why a
package cannot be scored on its own account of what it did.

## What this gold cannot do yet

It says which capability a question needs, as a person judged it. It does not say which capability *this
harness* needs to answer that question, which is a different claim and can only be established by ablation:
withhold a capability, run the task against a real model, and see whether the pass rate falls. That is the
end-to-end probe's job, and until it has run these judgements stand in for it.

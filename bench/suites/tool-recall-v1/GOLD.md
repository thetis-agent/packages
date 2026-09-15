# Where this gold came from

Each task names the tools a competent answer needs, as `<package>/<tool>`. The names are checked against
the shipped manifests, so moving or renaming a tool breaks the suite loudly instead of silently matching
nothing.

This gold is **authored**, not imported, and the reason is that no public dataset knows about Thetis's own
tools. That is a weaker footing than the capability corpus, which is imported precisely so that no package
author can shape it. Two things keep it honest for now:

- There is no tool-retrieval package in Thetis, so there is nothing for the gold to favour. It is authored
  against tools that already exist rather than against a mechanism competing to be chosen.
- Every figure it produces is a fraction of what is attached anyway. `tool_recall` is 1 for every arm by
  construction; the report says so rather than presenting it as a result.

When a package appears that decides what to attach per query, this gold must be re-derived by ablation —
a tool is needed by a task when withholding it measurably lowers the pass rate — and that needs the
end-to-end probe. Until then, read the waste figures and ignore recall.

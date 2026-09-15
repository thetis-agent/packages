// A claim is what a package says it surfaced. It is never scored: the bench verifies reach by looking for
// canary tokens in the assembled prompt. The claim exists so the bench can tell a package that lies about
// its own behaviour from one that does not, and so a ranking mechanism can report an order that leaves no
// trace in the prompt.

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** Drop anything malformed rather than fail the turn: a bad claim is a finding, not a crash. */
export function normalise(name, raw) {
  if (!raw || typeof raw !== "object") return null;
  const claim = { package: name, direct: list(raw.direct), offered: list(raw.offered) };
  if (typeof raw.arm === "string") claim.arm = raw.arm;
  if (["direct", "catalogue", "search"].includes(raw.reach)) claim.reach = raw.reach;
  if (Array.isArray(raw.ranked)) claim.ranked = list(raw.ranked);
  if (raw.scores && typeof raw.scores === "object") claim.scores = raw.scores;
  if (Number.isFinite(raw.budgetBytes)) claim.budgetBytes = raw.budgetBytes;
  if (Array.isArray(raw.droppedForBudget)) claim.droppedForBudget = list(raw.droppedForBudget);
  return claim;
}

export function normaliseAll(claims) {
  const out = {};
  for (const [name, raw] of Object.entries(claims ?? {})) {
    const claim = normalise(name, raw);
    if (claim) out[name] = claim;
  }
  return out;
}

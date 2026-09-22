// Every refusal this package makes goes through here, because the sentence is the whole answer. It is read
// in a transcript with nothing around it, printed by `thetis publish` on a terminal, and shown in a browser
// toast that carries no other context, so each one has to name the package, the target, and the thing to do
// next, by itself. `code` is the machine-readable half: a page that wants to colour a version refusal
// differently from a registry it could not reach should branch on that and never on the prose.
export class Refusal extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "Refusal";
    this.code = code;
    // The same finding the sentence states, in fields, for a page that wants to draw it rather than
    // print it. The sentence never depends on this being read: it stands alone whether or not it is.
    if (details !== undefined) this.details = details;
  }
}

export function refuse(code, message, details) {
  throw new Refusal(code, message, details);
}

/**
 * The last few lines of a command's output, on one line. A refusal has to survive being read in a toast,
 * and a hundred lines of a failed build do not; the tail is where the reason usually is.
 */
export function tail(text, limit = 300) {
  const lines = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join("; ");
  return lines.length > limit ? `...${lines.slice(-limit)}` : lines;
}

/** A list of paths for a sentence: at most `n`, then a count for the rest. */
export function few(items, n = 6) {
  const list = [...items];
  return list.length <= n ? list.join(", ") : `${list.slice(0, n).join(", ")} and ${list.length - n} more`;
}

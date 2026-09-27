/* The words for a turn that did not finish. One plain sentence per reason, for the row that stays in the
 * transcript; one short phrase, for a subagent's badge and the sidebar; and the divider a resumed turn
 * draws. The raw message is never the sentence: it goes under the row's Details fold.
 *
 * The reason comes from two fields. `kind` is what failed (the provider's classification, carried on the
 * turn's `error` event and in the record's `interrupted.error`); `why` is how the turn stopped (a restart,
 * an update of the person's space, a crash, a pause for an update). A record or an event written before
 * those fields existed has neither, so the kind is also read, as a last resort, off the raw message. */

/** What failed, in the words the row leads with. */
const KIND_LEAD = {
  connection: "The connection to the model kept dropping",
  "rate-limit": "The model's provider is limiting requests right now",
  overloaded: "The model is overloaded right now",
  timeout: "The model did not answer in time",
  credits: "The provider account has run out of credits",
  context: "The conversation is too long for this model",
  "output-limit": "The reply reached the model's output limit",
  filter: "The provider's content filter stopped the reply",
  auth: "The provider refused the key Thetis uses",
};

/** What to do about it, when there is something the person can do before retrying. */
const KIND_HINT = {
  credits: " Add credits to the provider account, then retry.",
  "output-limit": " Ask for less at once, then retry.",
  context: " Start a new conversation, or retry after the conversation is compacted.",
  auth: " An admin must check the provider settings.",
};

const KIND_SHORT = {
  connection: "the connection kept dropping",
  "rate-limit": "rate limited",
  overloaded: "the model was overloaded",
  timeout: "the model did not answer in time",
  credits: "out of credits",
  context: "the conversation got too long",
  "output-limit": "hit the output limit",
  filter: "stopped by the content filter",
  auth: "the provider refused the key",
};

/** How the turn stopped, when it was not the model's call that failed. */
const WHY_LEAD = {
  restart: "Thetis restarted during this reply",
  reload: "Your space was updated during this reply",
  crash: "Thetis stopped unexpectedly during this reply",
  yield: "This reply paused for an update",
};

const WHY_SHORT = {
  restart: "Thetis restarted",
  reload: "its space was updated",
  crash: "Thetis stopped unexpectedly",
  yield: "paused for an update",
};

/** A kind read off the raw message, for an error that carries none. Undefined when nothing matches. */
export function guessKind(message) {
  const text = String(message || "");
  if (/connection closed|stream failed|fetch failed|ECONNRESET|socket hang up|terminated/i.test(text)) return "connection";
  if (/\b402\b|credits?\b/i.test(text)) return "credits";
  if (/output limit|max_tokens/i.test(text)) return "output-limit";
  if (/content filter/i.test(text)) return "filter";
  if (/\b429\b|rate.?limit/i.test(text)) return "rate-limit";
  if (/overloaded|\b529\b/i.test(text)) return "overloaded";
  if (/context length|too many tokens|prompt is too long/i.test(text)) return "context";
  if (/no response from .* within|timed? ?out/i.test(text)) return "timeout";
  if (/\b401\b|\b403\b|api ?key/i.test(text)) return "auth";
  return undefined;
}

/**
 * The reason in one object: `{ kind, why, message }`, from a turn's `error` event or a record's
 * `interrupted`. `why` "provider" and "failed" are the ordinary failure, so they say nothing a kind does not.
 */
export function reasonOf(source) {
  if (!source) return { kind: undefined, why: undefined, message: "" };
  const error = source.error && typeof source.error === "object" ? source.error : source;
  const message = String(error.message || "");
  const why = typeof source.why === "string" && WHY_LEAD[source.why] ? source.why : undefined;
  const kind = typeof error.kind === "string" && error.kind !== "other" ? error.kind : why ? undefined : guessKind(message);
  return { kind, why, message };
}

/** The row's sentence. `tries` is how many times the call was made, when retries ran out. */
export function failureSentence(source, { tries } = {}) {
  const { kind, why } = reasonOf(source);
  if (why) return `${WHY_LEAD[why]}. Everything before it is kept.`;
  const lead = KIND_LEAD[kind];
  if (!lead) return "The reply failed, so it stopped here. Everything before it is kept.";
  const counted = tries > 1 ? ` (${tries} tries)` : "";
  return `${lead}${counted}, so the reply stopped here. Everything before it is kept.${KIND_HINT[kind] ?? ""}`;
}

/** The one-line reason for a badge: a few words, never the raw provider string when a kind is known. */
export function failureShort(source) {
  const { kind, why, message } = reasonOf(source);
  if (why) return WHY_SHORT[why];
  if (KIND_SHORT[kind]) return KIND_SHORT[kind];
  const line = message.replace(/^error:\s*/i, "").replace(/^provider error:\s*/i, "").split("\n")[0].trim();
  if (!line) return "failed";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** The divider a resumed turn draws, from the `why` of the turn it carries on. */
export function resumedSentence(why) {
  switch (why) {
    case "restart":
      return "Resumed after Thetis restarted";
    case "reload":
    case "yield":
      return "Resumed after an update";
    case "crash":
      return "Resumed after Thetis stopped unexpectedly";
    case "provider":
    case "failed":
      return "Retried";
    default:
      return "Resumed";
  }
}

/** What the model is doing while a round is retried, as the retry row leads with it. */
export function retryLead(kind) {
  switch (kind) {
    case "rate-limit":
      return "The model's provider asked Thetis to slow down.";
    case "overloaded":
      return "The model is overloaded.";
    case "timeout":
      return "The model did not answer in time.";
    case "connection":
      return "The connection to the model dropped.";
    default:
      return "The call to the model failed.";
  }
}

/** A character count as the tool card shows it: `812 chars`, `31k chars`, `1.2M chars`. */
export function fmtChars(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M chars`;
  if (n >= 1000) return `${Math.round(n / 1000)}k chars`;
  return `${n} chars`;
}

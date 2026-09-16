/* The operator's tool, and the three commands its own page sends. One tool, `restart_daemon`, which asks the
 * kernel to arm the restart latch and returns the latch's own sentence — nothing more.
 *
 * This is a package of its own, and that is the authority model. A tool declaration carries no `role` field,
 * unlike a `ui.commands` entry, so a tool every model can see and only an admin may use would be a setting
 * that records an intention: the model would offer five tools and collect refusals. Here authority is what is
 * installed. `thetis packages install @thetis/tool-operator --user <id>` gives it to one admin; it never goes
 * into `systemPackages["*"]`, and it is deliberately not part of `@thetis/tool-exec`, which everyone has and
 * which is benched. The kernel refuses a non-admin whatever is installed, so the packaging is the signal and
 * the kernel is the guard.
 *
 * Every sentence about a restart is written in `@thetis/lib/restart` and passed through here verbatim. That is
 * not laziness: the refusals say what happened, why, and what to do instead, and each ends by making clear
 * that nothing happened — the sentence that stops a model inventing a second attempt. They live in the library
 * precisely so that forking this package cannot change what the kernel says about itself. So nothing here
 * paraphrases, wraps or prefixes them. The only text this file adds is on `armed`, where the model is told to
 * say it now, in the reply that is the person's one warning; and the one plain sentence for an account that is
 * not an admin, which must never reach the transcript as a stack trace.
 *
 * Arguments are checked here before the kernel is asked, as every other tool package does: a call with no
 * reason is a malformed call, and a restart nobody can account for is not sent on. */

const call = (env, method, args = {}) => env.kernel.operator.call(method, args);

/** What the model is told to do with an armed restart. The reply is the only warning anyone gets. */
const TELL_THEM =
  "Tell the person now, in this reply: what is restarting, what it is for, and that it can still be called " +
  "off. This reply reaches them before anything happens, and it is the only warning they get.";

/**
 * A call from an account that is not an admin. The kernel throws `unauthorized` with a sentence of its own,
 * which is true but terse; this says the same thing with the remedy in it, and never shows an error row.
 */
const NOT_ADMIN =
  "Restarting Thetis is an operator action, and this account is not an admin, so nothing happened and " +
  "nothing was armed. An admin can do it from the control panel, or with `thetis restart` on the host.";

/** A call with no reason. Refused here, before the kernel is asked, and it reads like every other refusal. */
const NO_REASON =
  "Refused, and nothing was restarted: a restart needs a reason, and this call gave none. The reason is shown " +
  "to everyone waiting and recorded, so it has to name what changed and why reloading a workspace cannot pick " +
  "it up. Nothing was armed and nothing is going to happen.";

/** The same rule at the page's seam, in the words the kernel would have used. */
const NO_REASON_UI = "A restart needs a reason: it is shown to everyone waiting and recorded.";

/**
 * A kernel that answered without a sentence — an older one, or one that changed shape. Nothing here can say
 * what happened, so it says that rather than inventing an outcome in either direction.
 */
const NO_SENTENCE =
  "The kernel answered the restart request without a sentence of its own, so nothing here can tell you what " +
  "it did. Do not assume either way, and do not ask again: `thetis restart status` on the host says whether " +
  "anything is armed.";

/**
 * Asks the kernel to arm the restart latch. Nothing restarts in this call and nothing restarts in this turn:
 * the latch waits for every turn everywhere to end, counts down where it can be seen, and only then exits, so
 * this turn finishes and its reply reaches the person first. That ordering is the whole design, and the
 * answer's job is to make the model say so.
 */
export async function restartDaemon(args, env) {
  const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
  if (!reason) throw new Error(NO_REASON);
  let armed;
  try {
    armed = await call(env, "restart.request", { reason });
  } catch (err) {
    // The kernel asserts the admin role for this method alone; `rpc.ts` admits any non-user, which admits the
    // system userspace. A refusal is an answer, not a failure, so it comes back as a sentence.
    if (err?.code === "unauthorized") return NOT_ADMIN;
    throw err;
  }
  const said = typeof armed?.message === "string" && armed.message.trim() ? armed.message : null;
  // `again` and every `refused` are the library's words and nothing else: a cheerful preamble on a refusal is
  // how a model talks itself into a second attempt. And an `armed` with no sentence is not announced as armed,
  // because a restart announced on no evidence is worse than one nobody mentioned.
  if (!said) return NO_SENTENCE;
  return armed.state === "armed" ? `${said}\n\n${TELL_THEM}` : said;
}

/** Whether a restart is armed, and whether one would be accepted at all. The chip's poll. */
export async function uiStatus(_args, env) {
  return { data: await call(env, "restart.status") };
}

/**
 * Calls off an armed restart. Nothing armed is not a failure and not an event: it is said plainly, because a
 * Cancel button that errors when there is nothing to cancel teaches nobody anything.
 */
export async function uiCancel(_args, env) {
  const out = await call(env, "restart.cancel");
  const was = out?.was ?? null;
  return {
    data: { cancelled: !!was, was },
    text: was ? `Called off the restart ${was.by} asked for: ${was.reason}` : "Nothing was armed, so nothing was called off and nothing changed.",
  };
}

/**
 * Arms a restart from the page, so an admin never has to go through the model to get one. The reason is
 * required here as it is for the tool, and the kernel's sentence is the answer, refusals included.
 */
export async function uiRestart(args, env) {
  const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
  if (!reason) throw new Error(NO_REASON_UI);
  const armed = await call(env, "restart.request", { reason });
  return { data: armed, text: typeof armed?.message === "string" ? armed.message : NO_SENTENCE };
}

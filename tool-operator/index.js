/* The operator's tool. One tool, `restart_daemon`, which asks the kernel to arm the restart latch and returns
 * the latch's own sentence — nothing more. The countdown people see, and the Cancel an admin has, are
 * gateway-web's and the control panel's: this package draws nothing.
 *
 * This is a package of its own, and that is the authority model. A tool declaration carries no `role` field,
 * unlike a `ui.commands` entry, so a tool every model can see and only an admin may use would be a setting
 * that records an intention: the model would offer five tools and collect refusals. Here authority is what is
 * installed. `thetis packages install @thetis/tool-operator --user <id>` gives it to one admin; it never goes
 * into `systemPackages["*"]`, and it is deliberately not part of `@thetis/tool-exec`, which everyone has and
 * which is benched. The kernel refuses a non-admin whatever is installed, so the packaging is the signal and
 * the kernel is the guard.
 *
 * Every sentence about a restart is written in `@thetis/runtime/lib/restart` and passed through here verbatim. That is
 * not laziness: the refusals say what happened, why, and what to do instead, and each ends by making clear
 * that nothing happened — the sentence that stops a model inventing a second attempt. They live in the library
 * precisely so that forking this package cannot change what the kernel says about itself. So nothing here
 * paraphrases, wraps or prefixes them. The only text this file adds is on `armed`, where the model is told what
 * to say and that nobody needs to type "continue"; the refusal while an update is installing; and the one
 * plain sentence for an account that is not an admin, which must never reach the transcript as a stack trace.
 *
 * Arguments are checked here before the kernel is asked, as every other tool package does: a call with no
 * reason is a malformed call, and a restart nobody can account for is not sent on. */

const call = (env, method, args = {}) => env.kernel.operator.call(method, args);

/**
 * What the model is told to do with an armed restart. The latch's sentence has just said that running replies
 * pause at their next safe point; this reply is one of them, so whatever it says after this call is written
 * only after the restart. The reason goes first, and nobody should be asked to type "continue".
 */
const TELL_THEM =
  "This reply is one of them. Tell the person in this same message, before anything else, what is restarting " +
  "and why. Do not call this again, and do not ask the person to continue.";

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
  "to everyone waiting and recorded, so it has to name what changed and why only a restart picks it up. " +
  "Nothing was armed and nothing is going to happen.";

/**
 * An update is installing (`@thetis/host-update` holds its lock): the update restarts Thetis itself when it
 * is done, and a restart now would load a half-installed checkout. The first sentence is the one every
 * restart path gives while the lock is held.
 */
const UPDATING =
  "An update is installing; Thetis restarts by itself when it is done. Nothing was armed by this call, so " +
  "do not ask again.";

/**
 * A kernel that answered without a sentence — an older one, or one that changed shape. Nothing here can say
 * what happened, so it says that rather than inventing an outcome in either direction.
 */
const NO_SENTENCE =
  "The kernel answered the restart request without a sentence of its own, so nothing here can tell you what " +
  "it did. Do not assume either way, and do not ask again: `thetis restart status` on the host says whether " +
  "anything is armed.";

/**
 * Asks the kernel to arm the restart latch. Nothing restarts in this call: the latch asks every running turn
 * to pause at its next safe point, waits for them (two minutes at most), counts down where everyone can see
 * it, and only then exits. Paused turns continue by themselves when Thetis is back. Refused here, before the
 * kernel is asked, while an update is installing: that update restarts Thetis itself when it is done.
 */
export async function restartDaemon(args, env) {
  const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
  if (!reason) throw new Error(NO_REASON);
  if (await updateInstalling(env)) return UPDATING;
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

/**
 * Whether `@thetis/host-update` has an update job running. Its record says `running` only while the job holds
 * the lock. Any failure to ask -- no such host package, an older kernel -- is read as "no": the kernel's own
 * guards still apply to the restart itself.
 */
async function updateInstalling(env) {
  try {
    const answer = await call(env, "host.update.progress");
    // host-update 0.2 answers the record itself; 0.1 wrapped it as `{ last }`.
    const record = answer && typeof answer === "object" && "last" in answer ? answer.last : answer;
    return record?.state === "running";
  } catch {
    return false;
  }
}

/* The three words the control panel says about whether new code is in service, and the one place that
 * turns the server's word into them. The server works the word out (`fleet.js` beside `index.js`): a copy
 * is `current`, `update` when the workspace has not applied the copy on disk, and the daemon alone is
 * `restart` when it runs older code than the disk. The page never guesses from mtimes or versions: it draws
 * what it is handed, so "older code" and "reload to X" never reach anyone. */

export const WORDS = Object.freeze({ current: "Up to date", update: "Update ready", restart: "Restart needed" });
const TONES = Object.freeze({ current: "ok", update: "warn", restart: "warn" });

/** The word for a server state; anything unknown is said as Up to date, because a guess must not alarm. */
export const stateWord = (state) => WORDS[state] ?? WORDS.current;
export const stateTone = (state) => TONES[state] ?? TONES.current;

/** Whether a state asks somebody to do something: the only states a tree mark or a count is for. */
export const actionable = (state) => state === "update" || state === "restart";

/** The badge for a state, through the shell's own badge. */
export function stateBadge(ext, state) {
  return ext.ui.badge(stateWord(state), stateTone(state));
}

/** "3 people haven't applied it yet", or null when nobody waits. */
export function waitingSentence(n) {
  if (!n) return null;
  return `${n} ${n === 1 ? "person hasn't" : "people haven't"} applied it yet`;
}

/** A package name as a person reads it: the part after the scope for the official ones, the whole name otherwise. */
export function shortName(name) {
  const s = String(name ?? "");
  return s.startsWith("@thetis/") ? s.slice("@thetis/".length) : s;
}

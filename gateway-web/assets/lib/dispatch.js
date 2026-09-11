/* Which renderer draws one transcript row.
 *
 * views/transcript.js consults the renderers packages contributed for an event
 * kind before its own built-in table, in registration order, and only a *truthy*
 * node short-circuits: `null`, `undefined` and a thrown error all fall through —
 * to the next contributor, and past the last of them to the built-in row. That
 * is the whole point of the seam: a contributor may decline a particular frame,
 * and a contributor that is broken must punch a hole in neither the reading
 * order of the conversation nor anybody else's rows (contract/surface; the same
 * isolation rule lib/surface.js's `deliver` applies to watchers).
 *
 * Several packages draw one kind because several have a use for it: skills-l1
 * draws the `tool-call` rows for its own `load_skill`, tools-ask draws the ones
 * for its own `ask_user`, and each declines every call that is not its own. One
 * renderer per kind would have made those two packages mutually exclusive.
 *
 * The decision lives here, apart from the drawing, because it is the part with
 * branches worth testing and the part that needs no DOM to make: it is handed
 * both renderers rather than looking either up, and it says which of the two
 * should draw rather than drawing. The caller does the placing and the
 * reporting. There is no DOM harness in this repo — dispatch.test.ts is what
 * covers the three fallthrough paths, and it can only do that because nothing
 * in this file touches `document`. Keep it that way: an import of ./dom.js
 * here would take the test with it.
 */

/**
 * @param {unknown} contributed  the renderers packages registered for this kind, in registration
 *   order — a list, because two packages may both draw a kind and either may decline a frame
 * @param {unknown} builtin      views/transcript.js's own renderer for this kind, if any
 * @param {unknown} frame        the `{type:'event', session, kind, ...}` frame being drawn
 * @param {unknown} context      the helper bag handed to a contributed renderer
 * @returns {{row: "contributed", node: unknown, failures: unknown[]}
 *          | {row: "builtin", builtin: unknown, failures: unknown[]}}
 */
export function chooseTranscriptRow(contributed, builtin, frame, context) {
  const failures = [];
  for (const render of Array.isArray(contributed) ? contributed : contributed ? [contributed] : []) {
    // Truthiness rather than `typeof === "function"`, so a contributor that registered something
    // uncallable still lands in the catch below and is reported — the alternative is a silent
    // fallthrough that looks exactly like a renderer politely declining the frame.
    if (!render) continue;
    try {
      const node = render(frame, context);
      if (node) return { row: "contributed", node, failures };
    } catch (error) {
      // One broken contributor must not stop the next one being asked, for the same reason it must
      // not stop the built-in row: the isolation is per contributor, not per kind. `error` is
      // whatever was thrown and may itself be falsy (`throw null` is legal), so the list's length
      // rather than any value in it is what the caller tests.
      failures.push(error);
    }
  }
  return { row: "builtin", builtin, failures };
}

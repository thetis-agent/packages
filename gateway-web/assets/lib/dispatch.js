/* Which renderer draws one transcript row.
 *
 * views/transcript.js consults the renderer a package contributed for an event
 * kind before its own built-in table, and only a *truthy* node short-circuits:
 * `null`, `undefined` and a thrown error all fall through to the built-in row.
 * That is the whole point of the seam — a contributor may decline a particular
 * frame, and a contributor that is broken must not punch a hole in the reading
 * order of the conversation (contract/surface; the same isolation rule
 * lib/surface.js's `deliver` applies to watchers).
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
 * @param {unknown} contributed  the renderer a package registered for this kind, if any
 * @param {unknown} builtin      views/transcript.js's own renderer for this kind, if any
 * @param {unknown} frame        the `{type:'event', session, kind, ...}` frame being drawn
 * @param {unknown} context      the helper bag handed to a contributed renderer
 * @returns {{row: "contributed", node: unknown}
 *          | {row: "builtin", builtin: unknown, failed?: true, error?: unknown}}
 */
export function chooseTranscriptRow(contributed, builtin, frame, context) {
  // Truthiness rather than `typeof === "function"`, so a contributor that
  // registered something uncallable still lands in the catch below and is
  // reported by name — the alternative is a silent fallthrough that looks
  // exactly like a renderer politely declining the frame.
  if (contributed) {
    try {
      const node = contributed(frame, context);
      if (node) return { row: "contributed", node };
    } catch (error) {
      // `error` is whatever was thrown, which may itself be falsy (`throw null`
      // is legal), so the flag rather than the value is what the caller tests.
      return { row: "builtin", builtin, failed: true, error };
    }
  }
  return { row: "builtin", builtin };
}

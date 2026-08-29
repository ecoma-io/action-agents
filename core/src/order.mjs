/**
 * The one collation every deterministic ordering in the workspace means:
 * UTF-8 byte order. Two runs, two implementations and two languages cannot
 * be allowed to disagree about which record sorts first, so the comparator
 * compares UTF-8 encodings byte by byte — never locale collation, never
 * code-point order, which both diverge from byte order the moment a string
 * carries characters outside ASCII.
 *
 * `review` ordered findings, inventories and tool output with this; `harmonise`
 * held a deliberate copy while it was the comparator's only other consumer —
 * promoting a shared sort into `core/` on anticipation is exactly the drift
 * the boundary law exists to stop. This promotion is the doctrine's other
 * half: a second action genuinely needs the same bytes-first order, so the
 * few lines moved here once, and both actions read one definition.
 */

/**
 * Compares two strings by their UTF-8 encodings, byte by byte.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when `a` sorts first
 */
export function utf8Compare(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

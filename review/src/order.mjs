/**
 * The one collation every deterministic ordering in `review` means: UTF-8
 * byte order. The spec says "sorted" and means this, so that two
 * implementations, two runs and two languages cannot disagree about which
 * finding comes first or which file lands past a budget break.
 */

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when `a` sorts first
 */
export function utf8Compare(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Sorts strings into byte order, in place and returned, so call sites read
 * as what they are.
 *
 * @template {string} T
 * @param {T[]} values
 * @returns {T[]}
 */
export function sortByUtf8(values) {
  return values.sort(utf8Compare);
}

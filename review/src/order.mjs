/**
 * `review`'s ordering surface. `utf8Compare` lives in `core/src/order.mjs`
 * now that `harmonise` needs the same collation — the promotion the boundary
 * law's remediation names — and this module re-exports it, so every `review`
 * call site keeps the one import path it already reads. `sortByUtf8` is
 * `review`'s own convenience and stays here: only this action calls it.
 */

import { utf8Compare } from "#core/order.mjs";

export { utf8Compare };

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

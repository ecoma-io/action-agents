/**
 * Flattening model-produced text onto one line — the shape five call sites
 * across the actions share (chat's excerpt, triage's comment body, review's
 * answer/tool/verify excerpts, harmonise's log summary), factored into one
 * home so the collapse rule cannot drift.
 *
 * The default collapses whitespace runs to single spaces; callers that cap
 * the length pass `maxChars` (a cap is never silent — it is a refusal of a
 * line too long for its surface). `stripControlChars` additionally maps
 * control characters to spaces before the collapse; it is the harmonise log
 * summary's rule, where a control character is log-forgery material.
 */

/**
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxChars] when set, the flattened line is sliced to this many characters
 * @param {boolean} [options.stripControlChars] when true, control characters become spaces before collapse
 * @returns {string}
 */
export function oneLine(text, { maxChars, stripControlChars = false } = {}) {
  let flat = text;
  if (stripControlChars) {
    let out = "";
    for (const char of flat) {
      const code = char.codePointAt(0) ?? 0;
      out += code <= 0x1f || code === 0x7f ? " " : char;
    }
    flat = out;
  }
  const collapsed = flat.replace(/\s+/g, " ").trim();
  return maxChars === undefined ? collapsed : collapsed.slice(0, maxChars);
}

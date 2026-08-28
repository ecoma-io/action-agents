/**
 * `harmonise` fingerprinting — deterministic content and policy hashes.
 *
 * A fingerprint is a sha-256 hex digest over a canonical byte sequence. Two
 * purposes:
 *
 * - `contentFingerprint` hashes a document's UTF-8 bytes, so two runs reading
 *   the same text produce the same digest and a changed byte moves it. This is
 *   the identity a sync-state record pins a source or translation to.
 * - `policyFingerprint` hashes the translation policy that produced a given
 *   translation: the glossary, the all-pairs instruction, the per-language
 *   instruction prose, and the transformation pipeline's version. A
 *   translation whose source text is unchanged but whose policy moved is stale
 *   and must be re-run; the fingerprint is how that is known without diffing
 *   prose by hand.
 *
 * Canonicalization (for `policyFingerprint`):
 *   - `null` and `undefined` are both `"null"` — an absent field and an
 *     explicit null hash the same, so a caller may omit any input.
 *   - Objects: keys are sorted ascending by UTF-16 code unit, recursively, so
 *     insertion order never moves the hash.
 *   - Arrays: order is preserved exactly as given — declaration order is
 *     meaningful for the glossary, so reordering it is a policy change.
 *   - Primitives (string, number, boolean): `JSON.stringify`, so `"1"` and
 *     `1` remain distinct.
 *
 * These are pure functions over their arguments; they read no files and never
 * touch a model. They are the foundation incremental harmonise hashes against,
 * not anything the run loop calls yet.
 */

import { createHash } from "node:crypto";

/**
 * Bumped when the deterministic transformation pipeline's semantics change, so
 * a translation produced under an older pipeline is detected as stale even when
 * its source and policy are unchanged. Stored on every sync-state record and
 * folded into `policyFingerprint` so a bump invalidates every prior
 * translation in one move.
 */
export const TRANSFORMATION_VERSION = 1;

/**
 * The inputs whose combination is the translation policy for one destination.
 *
 * @typedef {object} PolicyInputs
 * @property {readonly string[]} [glossary] terms protected verbatim in every
 *   translation, in config declaration order. Order is part of the policy.
 * @property {string} [instruction] the all-pairs instruction document text.
 * @property {Record<string, string>} [languageInstructions] language tag →
 *   that language's instruction prose. Key order is normalized away; the text
 *   is part of the policy.
 * @property {number} transformationVersion the pipeline version that produced
 *   the translation. Folded in so a `TRANSFORMATION_VERSION` bump invalidates
 *   every prior translation.
 */

/**
 * @param {string} text
 * @returns {string} sha-256 hex digest over the UTF-8 bytes of `text`.
 */
export function contentFingerprint(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Hash of the canonical JSON of the policy inputs. Every input must move the
 * hash: changing the glossary, the instruction, any language's instruction
 * prose, or the transformation version produces a different digest, because
 * each is a distinct byte sequence in the canonical form.
 *
 * @param {PolicyInputs} inputs
 * @returns {string} sha-256 hex digest over the canonical JSON.
 */
export function policyFingerprint({
  glossary,
  instruction,
  languageInstructions,
  transformationVersion,
}) {
  const canonical = canonicalize({
    glossary,
    instruction,
    languageInstructions,
    transformationVersion,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Canonical JSON serialization: keys sorted recursively, arrays in given
 * order, compact (no whitespace). Stable across key-insertion order and across
 * engines, so two runs hashing the same inputs byte-for-byte agree.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(record).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

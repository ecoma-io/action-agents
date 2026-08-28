/**
 * `harmonise` stale classification — the deterministic decision of whether a
 * pair must see the model again.
 *
 * A pair is (source document, translation). Its recorded side is the
 * destination's sync-state record from the previous run; its current side is
 * what this run hashed from the repository's real bytes. Comparing the two is
 * what lets an unchanged pair be classified with no model call at all.
 *
 * ## DOCTRINE
 *
 * `unchanged` is the only verdict that may later skip the model call, and it
 * may be produced only by the deterministic comparisons in
 * {@link classifyPair} — never by model output, never by heuristics over file
 * sizes, dates, or any other proxy for content. Every other verdict sends the
 * pair to the model. The function fails closed: anything that is not
 * *provably* unchanged is not unchanged, and input that cannot support the
 * proof is `unknown` — a refusal to guess, not a claim about the content.
 *
 * The comparisons, in precedence order (first match wins):
 *
 * 1. No recorded state at all (`null`/`undefined`) → `new-pair`.
 * 2. Recorded state or current fingerprints unusable — malformed, missing or
 *    ill-typed fields, or a record carrying a foreign schema version →
 *    `unknown`.
 * 3. `sourceFingerprint` differs → `content-stale`. The source's bytes are
 *    the pair's content identity, so content drift wins over any policy
 *    difference.
 * 4. Content identical, but `policyFingerprint` or `transformationVersion`
 *    differs → `policy-stale`. Same text, new policy: the translation must be
 *    re-run under it.
 * 5. All three equal → `unchanged`.
 *
 * The translation's own fingerprint is deliberately not consulted. When the
 * source and the policy are unchanged, `unchanged` means "do nothing" — and
 * doing nothing is exactly what preserves a human's hand edit of the
 * translation, where re-running would overwrite it.
 *
 * Pure functions: no files, no model, no clock. Total: any input receives
 * exactly one verdict and nothing throws.
 *
 * @module harmonise/src/stale
 */

import { STATE_SCHEMA_VERSION } from "./state.mjs";

/**
 * The fingerprint slice of a pair that staleness is decided over — the three
 * sync-state fields a previous run recorded and this run recomputes from the
 * repository's real bytes.
 *
 * @typedef {Pick<
 *   import("./state.mjs").SyncStateRecord,
 *   "sourceFingerprint" | "policyFingerprint" | "transformationVersion"
 * >} PairFingerprints
 */

/**
 * A pair's recorded side: a full {@link import("./state.mjs").SyncStateRecord}
 * as `parseState` produces it, a bare {@link PairFingerprints}, or nothing at
 * all when the pair has never been translated.
 *
 * @typedef {PairFingerprints & { schemaVersion?: number | undefined } | null | undefined} RecordedPairState
 */

/**
 * Exactly one verdict for any pair, always. `unchanged` is the only one that
 * may skip the model call — see the module doctrine.
 *
 * - `unchanged` — the recorded fingerprints and version all equal the current
 *   ones.
 * - `content-stale` — the source content fingerprint differs.
 * - `policy-stale` — content identical, but the policy fingerprint or the
 *   transformation version differs.
 * - `new-pair` — nothing was ever recorded for the pair.
 * - `unknown` — recorded state exists but is unusable (malformed, missing
 *   fields, wrong types, foreign schema version), or the current fingerprints
 *   are unusable. A refusal to guess: the pair goes to the model.
 *
 * @typedef {"unchanged" | "content-stale" | "policy-stale" | "new-pair" | "unknown"} StaleVerdict
 */

/**
 * A fingerprint field is usable when it is a non-empty string — what every
 * digest actually is. `parseState` enforces only `typeof string`; this is the
 * stricter "usable for a provable comparison" bar, and a value under it is
 * `unknown`, never `unchanged`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isFingerprint(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * A version field is usable when it is a finite number. `NaN` and the
 * infinities are `typeof number` but compare equal to nothing and prove
 * nothing.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isVersion(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A recorded state is usable when it is a plain object carrying the three
 * comparison fields at their declared types — and, when it carries a schema
 * version at all, that version is the one this code understands. A record
 * from a different schema may assign different meaning to the same fields, so
 * it is refused rather than interpreted: `unknown`, never `unchanged`.
 *
 * @param {RecordedPairState} recorded
 * @returns {recorded is PairFingerprints & { schemaVersion?: number | undefined }}
 */
function isRecordedUsable(recorded) {
  return (
    recorded !== null &&
    typeof recorded === "object" &&
    !Array.isArray(recorded) &&
    isFingerprint(recorded.sourceFingerprint) &&
    isFingerprint(recorded.policyFingerprint) &&
    isVersion(recorded.transformationVersion) &&
    (recorded.schemaVersion === undefined || recorded.schemaVersion === STATE_SCHEMA_VERSION)
  );
}

/**
 * The current fingerprints come from this run's own hashing, so an unusable
 * current side is a caller bug — but the function is total and fails closed:
 * an unusable side is `unknown`, which sends the pair to the model rather
 * than letting a broken comparison read as `unchanged`.
 *
 * @param {PairFingerprints | null | undefined} current
 * @returns {current is PairFingerprints}
 */
function isCurrentUsable(current) {
  return (
    current !== null &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    isFingerprint(current.sourceFingerprint) &&
    isFingerprint(current.policyFingerprint) &&
    isVersion(current.transformationVersion)
  );
}

/**
 * Classifies one pair against its recorded sync state — the decision a later
 * stage consults to skip the model for an unchanged pair. Pure and total:
 * exactly one verdict for any input, nothing thrown, nothing mutated.
 *
 * @param {RecordedPairState} recorded the pair's sync-state record from the
 *   previous run, or `null`/`undefined` when nothing was recorded for it.
 * @param {PairFingerprints | null | undefined} current what this run hashed
 *   from the repository's real bytes.
 * @returns {StaleVerdict} exactly one verdict; see {@link StaleVerdict}.
 */
export function classifyPair(recorded, current) {
  if (recorded === null || recorded === undefined) {
    return "new-pair";
  }
  if (!isRecordedUsable(recorded) || !isCurrentUsable(current)) {
    return "unknown";
  }
  if (recorded.sourceFingerprint !== current.sourceFingerprint) {
    return "content-stale";
  }
  if (
    recorded.policyFingerprint !== current.policyFingerprint ||
    recorded.transformationVersion !== current.transformationVersion
  ) {
    return "policy-stale";
  }
  return "unchanged";
}

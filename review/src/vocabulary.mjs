/**
 * The review vocabulary — the arms a policy may name for strictness and
 * strategy, and the closed vocabularies the review contract shares. Single
 * home: phases, gates, lanes, applicability and config all read these values
 * from here instead of re-spelling them, so a rename or an added arm cannot
 * drift between mirrors.
 */

/** The strictness values a policy may name. */
export const STRICTNESS = /** @type {const} */ (["low", "medium", "high"]);

/** The strategy values a policy may name. */
export const STRATEGY = /** @type {const} */ (["standard", "adversarial"]);

/** The verifier's verdicts — the closed set a verification answer may carry. */
export const VERDICTS = /** @type {const} */ (["confirmed", "refuted", "uncertain"]);

/**
 * The publication states an artifact may record — a candidate never
 * publishes, and an `uncertain` verdict is no verdict: it publishes as
 * `unresolved`.
 */
export const PUBLISHED_LIFECYCLE_STATES = /** @type {const} */ ([
  "confirmed",
  "refuted",
  "unresolved",
]);

/**
 * The claim domains a finding may carry — the identity key's epistemic
 * arm: model-emitted, verification-bound, code-validated for membership.
 * Extending it is a contract change (ADR 004), not an edit.
 */
export const FINDING_KINDS = /** @type {const} */ ([
  "correctness",
  "security",
  "performance",
  "api-misuse",
  "resource-safety",
  "style",
  "test-gap",
  "documentation",
]);

/** The cross-run lifecycle reconciliation computes — code-owned, never model-written. */
export const RECONCILIATIONS = /** @type {const} */ ([
  "new",
  "persisting",
  "moved",
  "resolved",
  "unresolved",
]);

/**
 * @typedef {typeof FINDING_KINDS[number]} FindingKind
 */

/**
 * @param {unknown} value
 * @returns {value is FindingKind}
 */
export function isFindingKind(value) {
  return typeof value === "string" && FINDING_KINDS.includes(/** @type {FindingKind} */ (value));
}

/**
 * @typedef {typeof RECONCILIATIONS[number]} Reconciliation
 */

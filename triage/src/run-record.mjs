/**
 * The triage run record — the durable, byte-deterministic account of what
 * one run was asked, decided, and ended as. Triage has been log-only: its
 * decisions evaporated with the runner log, while review's artifact proved
 * what a durable record is worth. Issue #275 is this module's record; this
 * first slice carries the verification block the verification design froze
 * (issue #274) — the record ships those fields before the verification work
 * fills them, so the schema never bumps twice.
 *
 * Everything here is fail-closed: a shape this module did not specify is
 * refused, never coerced. Record fields that carry untrusted text are
 * sanitised and capped at their build sites; the validator's job is shape,
 * not repair.
 */

/** The triage run record's schema version. Additive changes bump it; filling `verification` (issue #274) does not. */
export const triageRecordSchemaVersion = 1;

/** The verdict vocabulary a verification answer may carry — frozen by issue #274. */
export const VERIFICATION_VERDICTS = /** @type {const} */ (["confirmed", "refuted", "uncertain"]);

/**
 * One verification answer: the code-minted op the verdict names, the closed
 * verdict, and the digest of the verdict's reason text — the reason itself
 * stays out of the record, its bytes checkable by whoever holds it.
 *
 * @typedef {object} VerificationAnswer
 * @property {string} opId a code-minted operation id: `add:<label>`, `remove:<label>` or `comment`
 * @property {"confirmed" | "refuted" | "uncertain"} verdict
 * @property {string} reasonDigest sha256 (lowercase hex) of the verdict's reason text
 */

/**
 * The verification block every triage record carries from this schema on.
 * Until the opt-in verification pass exists (issue #274), nothing requests
 * verification: the block is present, typed and validated, and empty —
 * filling it later is a fill, not a schema change.
 *
 * @typedef {object} VerificationBlock
 * @property {boolean} requested whether this run asked for verification
 * @property {VerificationAnswer[]} answers one per verified op, in plan order
 * @property {string[]} downgraded op ids the verification downgraded to refusals
 */

/**
 * The verification block a run records while verification does not exist
 * yet: nothing requested, nothing answered, nothing downgraded.
 *
 * @returns {VerificationBlock}
 */
export function buildVerificationBlock() {
  return { requested: false, answers: [], downgraded: [] };
}

/**
 * Whether a string is a code-minted operation id as issue #274 froze the
 * vocabulary: `add:<label>`, `remove:<label>` or the bare `comment`. The
 * label part is any non-empty text after the prefix; its sheet-membership
 * is the decision's business, not the shape's.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isOpId(value) {
  if (typeof value !== "string") return false;
  if (value === "comment") return true;
  return /^add:.+/u.test(value) || /^remove:.+/u.test(value);
}

/**
 * Whether a string is a digest as this module spells them — 64 lowercase
 * hex characters, the sha256 posture review's artifact records already use.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isReasonDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

/**
 * Fail-closed validation of a record's verification block: exactly the
 * three keys, the frozen vocabularies, no repair. A malformed block is a
 * code bug — the builder's output is what flows here — and refusing it
 * beats inventing evidence.
 *
 * @param {unknown} value
 * @returns {VerificationBlock}
 */
export function validateVerificationBlock(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("the verification block is not an object");
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(record).sort();
  const expected = ["answers", "downgraded", "requested"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(
      "the verification block carries keys other than requested/answers/downgraded",
    );
  }
  if (typeof record["requested"] !== "boolean") {
    throw new TypeError("the verification block's 'requested' is not a boolean");
  }
  if (!Array.isArray(record["answers"]) || !Array.isArray(record["downgraded"])) {
    throw new TypeError("the verification block's 'answers' and 'downgraded' must be arrays");
  }
  for (const answer of record["answers"]) {
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
      throw new TypeError("a verification answer is not an object");
    }
    const entry = /** @type {Record<string, unknown>} */ (answer);
    const answerKeys = Object.keys(entry).sort();
    const answerExpected = ["opId", "reasonDigest", "verdict"];
    if (
      answerKeys.length !== answerExpected.length ||
      answerKeys.some((key, index) => key !== answerExpected[index])
    ) {
      throw new TypeError(
        "a verification answer carries keys other than opId/verdict/reasonDigest",
      );
    }
    if (!isOpId(entry["opId"])) {
      throw new TypeError("a verification answer's opId is outside the code-minted vocabulary");
    }
    if (
      entry["verdict"] !== "confirmed" &&
      entry["verdict"] !== "refuted" &&
      entry["verdict"] !== "uncertain"
    ) {
      throw new TypeError("a verification answer's verdict is outside the closed vocabulary");
    }
    if (!isReasonDigest(entry["reasonDigest"])) {
      throw new TypeError("a verification answer's reasonDigest is not a well-formed digest");
    }
  }
  for (const opId of record["downgraded"]) {
    if (!isOpId(opId)) {
      throw new TypeError("a downgraded op id is outside the code-minted vocabulary");
    }
  }
  return /** @type {VerificationBlock} */ (value);
}

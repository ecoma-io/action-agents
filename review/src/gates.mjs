/**
 * The declared run gates — the named, frozen set a review must pass before
 * its concluding verdict may be "Complete". Before this module the
 * conditions lived inline along the concluding path — the parse contract,
 * the bound, the coverage arm, the publication invariants — and nothing
 * could answer "which gate refused" without reading that path. The set is
 * data now, and `evaluateGates` answers the question from facts alone.
 *
 * Result vs. gate: a run that produced findings and recorded evidence has a
 * result whether or not the gates pass. The gates decide only whether the
 * run may publish the "Complete" posture. A failed gate does not destroy
 * the result — the run still renders and writes what it found — and the
 * refusal names the gate that refused. No refusal class changes here: the
 * conclusion gate's refusal is still the run's thrown error, the bound and
 * coverage gates' refusal is still the "Partial" posture with the same
 * sentences — each now attributed.
 *
 * Every gate is a predicate over facts the loop and the concluding passes
 * already hold. No gate reads model text; a missing or malformed fact is a
 * typed refusal (`GateFactsError`), never a pass.
 */

import { canConcludeReview, normaliseReadPath } from "./coverage.mjs";

/** @typedef {import("./answer.mjs").Finding} Finding */
/** @typedef {import("./config.mjs").Strictness} Strictness */
/** @typedef {import("./coverage.mjs").CoverageReport} CoverageReport */
/** @typedef {import("./loop.mjs").Bound} Bound */
/** @typedef {import("./provenance.mjs").QuarantinedFinding} QuarantinedFinding */

/**
 * @typedef {"conclusion" | "bound" | "coverage" | "provenance" | "verification"} GateName
 */

/**
 * The declared gates, in the order the run applies them: the contract first
 * (no later pass runs without it), then the bound whose record names the
 * partial reason, then the coverage condition, then the two publication
 * invariants. The order is the stable total order of the results — and the
 * first failure's reason is the sentence a partial review leads with,
 * exactly as the concluding path has always ordered its refusals.
 *
 * @type {readonly GateName[]}
 */
export const GATES = /** @type {readonly GateName[]} */ (
  Object.freeze(["conclusion", "bound", "coverage", "provenance", "verification"])
);

/**
 * The typed refusal: the fact bundle did not match the declared shape. A
 * missing fact is one of these, never a pass — the same posture the phase
 * machine's `PhaseError` takes toward its own context.
 */
export class GateFactsError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "GateFactsError";
  }
}

/**
 * @typedef {object} ConclusionFacts the conclude contract's outcome
 * @property {boolean} held whether the final answer satisfied the output contract, after at most the one re-ask
 * @property {string} [defect] the contract defect — required when `held` is false
 */

/**
 * @typedef {object} BoundFacts the loop's tool-bound accounting, closed
 * @property {Bound | undefined} bound the bound the loop recorded, when one fired
 * @property {number} readingTurns turns spent reading
 * @property {number} maxTurns the reading-turn cap the loop enforced
 * @property {number} toolCalls tool calls made
 * @property {number} maxToolCalls the tool-call cap the loop enforced
 * @property {number} evidenceBytes evidence bytes captured
 * @property {number} maxEvidenceBytes the evidence cap the loop enforced
 */

/**
 * @typedef {object} CoverageFacts the #69 condition's inputs
 * @property {CoverageReport} report the loop's read-coverage report over the expected set
 * @property {Strictness} strictness the review policy — the `high` arm refuses on any gap
 */

/**
 * @typedef {object} ProvenanceFacts the publication set against the ledger
 * @property {Finding[]} published findings cleared for publication, each anchored
 * @property {QuarantinedFinding[]} quarantined findings quarantine removed from the publication set
 */

/**
 * @typedef {object} VerificationFacts the verify pass's recorded outcome
 * @property {number} planned findings the plan scheduled for verification
 * @property {number} recorded verdicts recorded — one per planned finding
 */

/**
 * @typedef {object} RunFacts the run's facts, one slice per declared gate
 * @property {ConclusionFacts} conclusion
 * @property {BoundFacts} bound
 * @property {CoverageFacts} coverage
 * @property {ProvenanceFacts} provenance
 * @property {VerificationFacts} verification
 */

/**
 * @typedef {object} GateResult
 * @property {GateName} gate
 * @property {boolean} passed
 * @property {string} [reason] why the gate refused — present only on a failure
 */

/**
 * @typedef {object} GateReport
 * @property {GateResult[]} results every declared gate, in the declared order
 * @property {GateResult[]} failed the refusals, in the declared order — the first names the posture's reason
 * @property {boolean} mayPublish true only when every gate passed; "the run may publish" is the gates' verdict, never the result's existence
 */

/** @typedef {{ passed: true } | { passed: false, reason: string }} GateVerdict */

/** The sentence each recorded bound produces — the run's own wording, unchanged. */
const BOUND_REASONS = Object.freeze({
  "max-turns": "the reading-turn budget was reached before the reviewer stopped asking questions.",
  "tool-calls": "the tool-call ceiling was reached before the reviewer stopped reading.",
  evidence: "the evidence budget was reached before the reviewer finished reading.",
});

/** The strictness arms, as the policy spells them. */
const STRICTNESS_ARMS = /** @type {const} */ (["low", "medium", "high"]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isStringList(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * @param {string} gate
 * @param {unknown} slice
 * @returns {Record<string, unknown>}
 */
function assertedObject(gate, slice) {
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) {
    throw new GateFactsError(`${gate} facts: expected an object`);
  }
  return /** @type {Record<string, unknown>} */ (slice);
}

/**
 * A publication finding must at least carry its identity — severity, file,
 * line, message. Without it the slice is malformed, not merely unanchored.
 *
 * @param {unknown} entry
 * @returns {Record<string, unknown>}
 */
function assertedFinding(entry) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new GateFactsError("provenance facts: a finding must be an object");
  }
  const finding = /** @type {Record<string, unknown>} */ (entry);
  const severity = finding["severity"];
  if (
    (severity !== "concern" && severity !== "nit") ||
    typeof finding["file"] !== "string" ||
    !isCount(finding["line"]) ||
    typeof finding["message"] !== "string"
  ) {
    throw new GateFactsError(
      "provenance facts: a finding must carry severity, file, line and message",
    );
  }
  return finding;
}

/**
 * The anchor a published finding must carry — the same resolution
 * `attachProvenance` performs: a well-formed captured read whose path is
 * the finding's own file and whose span covers the finding's line. A
 * reference to some other file, or a span that misses the line, is not an
 * anchor.
 *
 * @param {{ file: string, line: number }} finding
 * @param {unknown} provenance
 * @returns {boolean}
 */
function isAnchor(finding, provenance) {
  if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) {
    return false;
  }
  const record = /** @type {Record<string, unknown>} */ (provenance);
  if (
    typeof record["path"] !== "string" ||
    !isCount(record["startLine"]) ||
    !isCount(record["endLine"])
  ) {
    return false;
  }
  const startLine = /** @type {number} */ (record["startLine"]);
  const endLine = /** @type {number} */ (record["endLine"]);
  return (
    record["path"] === normaliseReadPath(finding.file) &&
    finding.line >= startLine &&
    finding.line <= endLine
  );
}

/**
 * @param {unknown} slice
 * @returns {GateVerdict}
 */
function evaluateConclusion(slice) {
  const facts = assertedObject("conclusion", slice);
  if (typeof facts["held"] !== "boolean") {
    throw new GateFactsError("conclusion facts: 'held' must be a boolean");
  }
  if (!facts["held"] && typeof facts["defect"] !== "string") {
    throw new GateFactsError("conclusion facts: a refused conclusion must carry the defect string");
  }
  if (facts["held"]) return { passed: true };
  return { passed: false, reason: /** @type {string} */ (facts["defect"]) };
}

/**
 * @param {unknown} slice
 * @returns {GateVerdict}
 */
function evaluateBound(slice) {
  const facts = assertedObject("bound", slice);
  for (const field of [
    "readingTurns",
    "maxTurns",
    "toolCalls",
    "maxToolCalls",
    "evidenceBytes",
    "maxEvidenceBytes",
  ]) {
    if (!isCount(facts[field])) {
      throw new GateFactsError(`bound facts: '${field}' must be a non-negative integer`);
    }
  }
  for (const cap of ["maxTurns", "maxToolCalls", "maxEvidenceBytes"]) {
    if (facts[cap] === 0) {
      throw new GateFactsError(
        `bound facts: '${cap}' must be positive — a zero cap bounds nothing`,
      );
    }
  }
  const recorded = facts["bound"];
  if (
    recorded !== undefined &&
    (typeof recorded !== "string" || !Object.hasOwn(BOUND_REASONS, recorded))
  ) {
    throw new GateFactsError(
      "bound facts: 'bound' must be undefined or one of 'max-turns', 'tool-calls', 'evidence'",
    );
  }
  const bound = /** @type {Bound | undefined} */ (recorded);
  // The accounting closes when the recorded bound is exactly the first cap
  // the loop's precedence names — evidence, then tool-calls, then turns.
  const evidenceReached =
    /** @type {number} */ (facts["evidenceBytes"]) >=
    /** @type {number} */ (facts["maxEvidenceBytes"]);
  const callsReached =
    /** @type {number} */ (facts["toolCalls"]) >= /** @type {number} */ (facts["maxToolCalls"]);
  const turnsReached =
    /** @type {number} */ (facts["readingTurns"]) >= /** @type {number} */ (facts["maxTurns"]);
  const closesAt = evidenceReached
    ? "evidence"
    : callsReached
      ? "tool-calls"
      : turnsReached
        ? "max-turns"
        : undefined;
  if (bound !== closesAt) {
    return {
      passed: false,
      reason:
        bound === undefined
          ? `the loop's bound accounting does not close: the ${/** @type {string} */ (closesAt)} cap stands reached but no bound was recorded`
          : closesAt === undefined
            ? `the loop's bound accounting does not close: '${bound}' was recorded but no cap stands reached`
            : `the loop's bound accounting does not close: '${bound}' was recorded but the accounting closes at '${closesAt}'`,
    };
  }
  if (bound === undefined) return { passed: true };
  return { passed: false, reason: BOUND_REASONS[bound] };
}

/**
 * The coverage gap becomes the sentence a partial review leads with — the
 * run's own wording, unchanged.
 *
 * @param {CoverageReport} report
 * @returns {string}
 */
function coverageGapReason(report) {
  const files = report.total === 1 ? "file was" : "files were";
  return (
    `${String(report.uncovered.length)} of ${String(report.total)} changed ${files} never ` +
    `read: ${report.uncovered.join(", ")}.`
  );
}

/**
 * @param {unknown} slice
 * @returns {GateVerdict}
 */
function evaluateCoverage(slice) {
  const facts = assertedObject("coverage", slice);
  const report = facts["report"];
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    throw new GateFactsError("coverage facts: 'report' must be a coverage report object");
  }
  const record = /** @type {Record<string, unknown>} */ (report);
  if (
    !isStringList(record["covered"]) ||
    !isStringList(record["uncovered"]) ||
    !isCount(record["total"])
  ) {
    throw new GateFactsError(
      "coverage facts: the report must hold 'covered' and 'uncovered' string lists and a 'total' count",
    );
  }
  const strictness = facts["strictness"];
  if (
    typeof strictness !== "string" ||
    !STRICTNESS_ARMS.includes(/** @type {Strictness} */ (strictness))
  ) {
    throw new GateFactsError("coverage facts: 'strictness' must be one of 'low', 'medium', 'high'");
  }
  const coverage = /** @type {CoverageReport} */ (report);
  if (canConcludeReview(coverage, /** @type {Strictness} */ (strictness))) return { passed: true };
  return { passed: false, reason: coverageGapReason(coverage) };
}

/**
 * @param {unknown} slice
 * @returns {GateVerdict}
 */
function evaluateProvenance(slice) {
  const facts = assertedObject("provenance", slice);
  if (!Array.isArray(facts["published"]) || !Array.isArray(facts["quarantined"])) {
    throw new GateFactsError("provenance facts: 'published' and 'quarantined' must be arrays");
  }
  for (const entry of /** @type {unknown[]} */ (facts["quarantined"])) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new GateFactsError("provenance facts: a quarantined entry must be an object");
    }
    const quarantined = /** @type {Record<string, unknown>} */ (entry);
    assertedFinding(quarantined["finding"]);
    if (typeof quarantined["reason"] !== "string") {
      throw new GateFactsError("provenance facts: a quarantined entry must carry a reason string");
    }
  }
  /** @type {Finding[]} */
  const unanchored = [];
  for (const entry of /** @type {unknown[]} */ (facts["published"])) {
    const finding = assertedFinding(entry);
    if (!isAnchor(/** @type {{ file: string, line: number }} */ (finding), finding["provenance"])) {
      unanchored.push(/** @type {Finding} */ (finding));
    }
  }
  // Quarantined findings are #84 working as declared — removed before
  // publication, logged by identity. The gate refuses only when one would
  // still publish: an unanchored finding remaining in the publication set.
  if (unanchored.length === 0) return { passed: true };
  const named = unanchored
    .map((finding) => `${finding.file}:${String(finding.line)} ${finding.message}`)
    .join("; ");
  return {
    passed: false,
    reason: `an unanchored finding remains in the publication set: ${named}`,
  };
}

/**
 * @param {unknown} slice
 * @returns {GateVerdict}
 */
function evaluateVerification(slice) {
  const facts = assertedObject("verification", slice);
  if (!isCount(facts["planned"]) || !isCount(facts["recorded"])) {
    throw new GateFactsError(
      "verification facts: 'planned' and 'recorded' must be non-negative integers",
    );
  }
  const planned = /** @type {number} */ (facts["planned"]);
  const recorded = /** @type {number} */ (facts["recorded"]);
  if (planned === recorded) return { passed: true };
  return {
    passed: false,
    reason: `the verification pass recorded ${String(recorded)} verdict(s) against ${String(planned)} planned finding(s) — the pass's outcome is not fully recorded`,
  };
}

/** @type {{ [K in GateName]: (slice: unknown) => GateVerdict }} */
const GATE_EVALUATORS = Object.freeze({
  conclusion: evaluateConclusion,
  bound: evaluateBound,
  coverage: evaluateCoverage,
  provenance: evaluateProvenance,
  verification: evaluateVerification,
});

/**
 * One gate over its own slice — the early edge, for a refusal that must
 * fire before later passes have produced the rest of the bundle. Same
 * predicates, same typed refusals as `evaluateGates`.
 *
 * @param {GateName} name
 * @param {unknown} facts the gate's own fact slice
 * @returns {GateResult}
 */
export function evaluateGate(name, facts) {
  const evaluator = GATE_EVALUATORS[name];
  if (evaluator === undefined) {
    throw new GateFactsError(
      `unknown gate '${String(name)}' — the declared set is ${GATES.join(", ")}`,
    );
  }
  const verdict = evaluator(facts);
  return verdict.passed
    ? { gate: name, passed: true }
    : { gate: name, passed: false, reason: verdict.reason };
}

/**
 * The declared gates over the run's facts: one result per gate in the
 * declared order, the failures in that same order, and the overall verdict.
 * Fail-closed: a bundle that is not the declared shape, an unknown key, or a
 * missing slice is a `GateFactsError` — a missing fact is never a pass.
 *
 * @param {unknown} runFacts the run's facts, one slice per declared gate
 * @returns {GateReport}
 */
export function evaluateGates(runFacts) {
  const facts = assertedObject("run", runFacts);
  for (const key of Object.keys(facts)) {
    if (!GATES.includes(/** @type {GateName} */ (key))) {
      throw new GateFactsError(
        `run facts: unknown gate '${key}' — the declared set is ${GATES.join(", ")}`,
      );
    }
  }
  /** @type {GateResult[]} */
  const results = [];
  for (const name of GATES) {
    const slice = facts[name];
    if (slice === undefined) {
      throw new GateFactsError(
        `run facts: the '${name}' slice is missing — a missing fact is never a pass`,
      );
    }
    results.push(evaluateGate(name, slice));
  }
  const failed = results.filter((result) => !result.passed);
  return { results, failed, mayPublish: failed.length === 0 };
}

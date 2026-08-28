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
import { validatedLedger } from "./provenance.mjs";
import { LIFECYCLE_OF_VERDICT, PUBLISHED_LIFECYCLE_STATES } from "./verify.mjs";

/** @typedef {import("./answer.mjs").Finding} Finding */
/** @typedef {import("./config.mjs").Strictness} Strictness */
/** @typedef {import("./config.mjs").Strategy} Strategy */
/** @typedef {import("./verify.mjs").PublishedLifecycle} PublishedLifecycle */
/** @typedef {import("./coverage.mjs").CoverageReport} CoverageReport */
/** @typedef {import("./loop.mjs").Bound} Bound */
/** @typedef {import("./provenance.mjs").QuarantinedFinding} QuarantinedFinding */
/** @typedef {import("./provenance.mjs").LedgerRead} LedgerRead */

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
 * @typedef {object} ProvenanceFacts the final publication set against the ledger
 * @property {Finding[]} published the set the comment publishes — post nit-drop, post verification, refuted and unresolved included
 * @property {QuarantinedFinding[]} quarantined findings quarantine removed from the publication set
 * @property {LedgerRead[]} ledger the run's recorded reads, in recording order
 */

/**
 * One planned finding's recorded outcome — what the verification pass itself
 * attached to the finding, never a value the model's text carries. The id is
 * the plan's identity, attached by code; the lifecycle is the state
 * {@link LIFECYCLE_OF_VERDICT} assigned; the verdict is the parsed verdict
 * that moved it, absent when the pass resolved the finding without one.
 *
 * @typedef {object} VerificationOutcome
 * @property {string} id the plan-local identity
 * @property {PublishedLifecycle} lifecycle the terminal state the pass assigned
 * @property {string} [verdict] the parsed verdict, when one was recorded
 * @property {string} [reason] the pass's own reason for the state
 */

/**
 * A plannable finding the plan could not evidence — the pass never verifies
 * blind, and the finding publishes `unresolved` carrying this reason.
 *
 * @typedef {object} VerificationSkipRecord
 * @property {string} file
 * @property {number} line
 * @property {string} reason
 */

/**
 * @typedef {object} VerificationFacts the verify pass's recorded outcome
 * @property {string[]} planned the plan's identities, in plan order
 * @property {VerificationOutcome[]} outcomes one record per planned finding
 * @property {VerificationSkipRecord[]} skipped plannable findings the plan could not evidence
 * @property {Strategy} strategy the review's strategy — `adversarial` widens both the plan and the acceptance policy
 * @property {Strictness} strictness the review's strictness — the `high` arm refuses an unresolved finding
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

/** The strategy arms, as the policy spells them. */
const STRATEGY_ARMS = /** @type {const} */ (["standard", "adversarial"]);

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
 * Why a published finding's provenance does not anchor it to the ledger,
 * or nothing when it does. The attached reference must be well formed, name
 * the finding's own file at the normalised spelling, cover the finding's
 * line, and match a recorded read exactly — path and span together. The
 * reference rides on the finding, so it is a claim; only the ledger's own
 * entries are evidence, and a claim no recorded read backs anchors nothing.
 *
 * @param {Record<string, unknown>} finding an `assertedFinding` entry
 * @param {LedgerRead[]} ledger the validated ledger
 * @returns {string | undefined} the refusal clause, the finding named first
 */
function unanchoredBecause(finding, ledger) {
  const name = `${finding["file"]}:${String(finding["line"])} ${finding["message"]}`;
  const provenance = finding["provenance"];
  if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) {
    return `${name} — no provenance reference a recorded read can back`;
  }
  const record = /** @type {Record<string, unknown>} */ (provenance);
  if (
    typeof record["path"] !== "string" ||
    !isCount(record["startLine"]) ||
    !isCount(record["endLine"])
  ) {
    return `${name} — the provenance reference is malformed`;
  }
  const path = normaliseReadPath(record["path"]);
  const startLine = /** @type {number} */ (record["startLine"]);
  const endLine = /** @type {number} */ (record["endLine"]);
  if (path !== normaliseReadPath(String(finding["file"]))) {
    return `${name} — provenance names ${path}, not the anchored file`;
  }
  const line = /** @type {number} */ (finding["line"]);
  if (line < startLine || line > endLine) {
    return `${name} — provenance span ${String(startLine)}-${String(endLine)} misses the anchor line`;
  }
  const backed = ledger.some(
    (read) => read.path === path && read.startLine === startLine && read.endLine === endLine,
  );
  if (!backed) {
    return `${name} — provenance does not match any recorded read`;
  }
  return undefined;
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
  if (
    !Array.isArray(facts["published"]) ||
    !Array.isArray(facts["quarantined"]) ||
    !Array.isArray(facts["ledger"])
  ) {
    throw new GateFactsError(
      "provenance facts: 'published', 'quarantined' and 'ledger' must be arrays",
    );
  }
  /** @type {LedgerRead[]} */
  let ledger;
  try {
    ledger = validatedLedger(facts["ledger"]);
  } catch (error) {
    throw new GateFactsError(
      `provenance facts: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  /** @type {string[]} */
  const unanchored = [];
  for (const entry of /** @type {unknown[]} */ (facts["published"])) {
    const clause = unanchoredBecause(assertedFinding(entry), ledger);
    if (clause !== undefined) unanchored.push(clause);
  }
  // Quarantined findings are #84 working as declared — removed before
  // publication, logged by identity; the gate holds them to shape and
  // reason only. The published list is the set the comment actually
  // carries — post nit-drop, post verification — and every finding on it
  // is anchored to the ledger anew: a claim its recorded reads do not
  // back refuses the gate, the finding named.
  if (unanchored.length === 0) return { passed: true };
  return {
    passed: false,
    reason: `an unanchored finding remains in the publication set: ${unanchored.join("; ")}`,
  };
}

/**
 * The mode the verification gate judges under, derived from the review's
 * policy — never configured directly: the adversarial strategy is the most
 * demanding posture whatever the strictness; a `high` strictness on the
 * standard strategy is `strict`; everything else is `normal`.
 *
 * @param {Strategy} strategy
 * @param {Strictness} strictness
 * @returns {"normal" | "strict" | "adversarial"}
 */
function verificationMode(strategy, strictness) {
  if (strategy === "adversarial") return "adversarial";
  return strictness === "high" ? "strict" : "normal";
}

/**
 * The sentence one unresolved planned finding produces — its id and, when
 * the pass recorded one, its own reason.
 *
 * @param {string} id
 * @param {string | undefined} reason
 * @returns {string}
 */
function unresolvedPlannedClause(id, reason) {
  return reason === undefined ? `finding ${id}` : `finding ${id} (${reason})`;
}

/**
 * Judges verification completeness over the recorded results, not counting.
 * The facts are the plan's identities, the outcome record each planned
 * finding carries, the skips the plan could not evidence, and the policy the
 * run ran under. Three checks, in the order they bite:
 *
 * 1. Verdict coverage — every planned finding must carry an outcome record
 *    with a verdict behind it. A planned finding with no record at all, or
 *    whose record is `unresolved` carrying no verdict — the shape the pass
 *    itself writes when it never recorded a verdict for the finding — is
 *    its own named failure at every mode: the pass's accounting does not
 *    close, and no count equality stands in for the missing record.
 * 2. Unresolved accounting — the pass's `unresolved` outcomes and the
 *    plan's unevidenced skips are enumerated in plan order, so a refusal
 *    names exactly which findings verification could not settle.
 * 3. Mode policy — under `normal` the unresolved findings publish with the
 *    accounting visible in the report; under `strict` and `adversarial` any
 *    unresolved finding refuses the Complete posture.
 *
 * The empty plan passes trivially: nothing was scheduled, so nothing is
 * missing. A record the pass could never have produced — a lifecycle
 * outside the published vocabulary, a verdict that contradicts
 * {@link LIFECYCLE_OF_VERDICT}, a resolved state with no verdict behind it,
 * an outcome for an id the plan never scheduled, a duplicate — is a
 * `GateFactsError`: the gate reads only code-recorded state, and a shape
 * the code cannot have written is never coerced into a judgment.
 *
 * @param {unknown} slice
 * @returns {GateVerdict}
 */
function evaluateVerification(slice) {
  const facts = assertedObject("verification", slice);
  if (
    !isStringList(facts["planned"]) ||
    !Array.isArray(facts["outcomes"]) ||
    !Array.isArray(facts["skipped"])
  ) {
    throw new GateFactsError(
      "verification facts: 'planned' must be a string list and 'outcomes' and 'skipped' must be arrays",
    );
  }
  const strategy = facts["strategy"];
  if (typeof strategy !== "string" || !STRATEGY_ARMS.includes(/** @type {Strategy} */ (strategy))) {
    throw new GateFactsError(
      "verification facts: 'strategy' must be one of 'standard', 'adversarial'",
    );
  }
  const strictness = facts["strictness"];
  if (
    typeof strictness !== "string" ||
    !STRICTNESS_ARMS.includes(/** @type {Strictness} */ (strictness))
  ) {
    throw new GateFactsError(
      "verification facts: 'strictness' must be one of 'low', 'medium', 'high'",
    );
  }
  const planned = /** @type {string[]} */ (facts["planned"]);
  const plannedSet = new Set(planned);
  if (plannedSet.size !== planned.length) {
    throw new GateFactsError(
      "verification facts: 'planned' carries a duplicate id — the plan names each finding once",
    );
  }
  /** @type {Map<string, Record<string, unknown>>} */
  const outcomeById = new Map();
  for (const entry of /** @type {unknown[]} */ (facts["outcomes"])) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new GateFactsError("verification facts: an outcome must be an object");
    }
    const record = /** @type {Record<string, unknown>} */ (entry);
    const id = record["id"];
    if (typeof id !== "string" || !plannedSet.has(id)) {
      throw new GateFactsError(
        `verification facts: an outcome names '${String(id)}', which the plan never scheduled — the accounting may only name planned findings`,
      );
    }
    if (outcomeById.has(id)) {
      throw new GateFactsError(`verification facts: finding '${id}' carries two outcome records`);
    }
    const lifecycle = record["lifecycle"];
    if (
      typeof lifecycle !== "string" ||
      !PUBLISHED_LIFECYCLE_STATES.includes(/** @type {PublishedLifecycle} */ (lifecycle))
    ) {
      throw new GateFactsError(
        "verification facts: an outcome's 'lifecycle' must be one of 'confirmed', 'refuted', 'unresolved'",
      );
    }
    const verdict = record["verdict"];
    if (
      verdict !== undefined &&
      (typeof verdict !== "string" ||
        LIFECYCLE_OF_VERDICT[/** @type {import("./verify.mjs").Verdict} */ (verdict)] !== lifecycle)
    ) {
      throw new GateFactsError(
        "verification facts: an outcome's 'verdict' must be the verdict its lifecycle maps to — 'confirmed', 'refuted' or 'uncertain'",
      );
    }
    if (lifecycle !== "unresolved" && verdict === undefined) {
      throw new GateFactsError(
        "verification facts: an outcome whose lifecycle is 'confirmed' or 'refuted' must carry the verdict that resolved it",
      );
    }
    const reason = record["reason"];
    if (reason !== undefined && typeof reason !== "string") {
      throw new GateFactsError(
        "verification facts: an outcome's 'reason' must be a string when present",
      );
    }
    outcomeById.set(id, record);
  }
  for (const entry of /** @type {unknown[]} */ (facts["skipped"])) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new GateFactsError("verification facts: a skip record must be an object");
    }
    const record = /** @type {Record<string, unknown>} */ (entry);
    if (
      typeof record["file"] !== "string" ||
      typeof record["line"] !== "number" ||
      !Number.isInteger(record["line"]) ||
      record["line"] < 1 ||
      typeof record["reason"] !== "string"
    ) {
      throw new GateFactsError(
        "verification facts: a skip record must carry a file, a positive line and its reason",
      );
    }
  }
  // Verdict coverage first. The `verdict` key is code-written, so its
  // absence on an `unresolved` record is the pass's own "never recorded
  // one" — the accounting does not close, at every mode, whatever the
  // policy, exactly as for a record missing outright.
  /** @type {string[]} */
  const unrecorded = [];
  for (const id of planned) {
    const record = outcomeById.get(id);
    if (
      record === undefined ||
      (record["lifecycle"] === "unresolved" && record["verdict"] === undefined)
    ) {
      unrecorded.push(id);
    }
  }
  if (unrecorded.length > 0) {
    return {
      passed: false,
      reason: `the verification pass left planned finding(s) ${unrecorded.join(", ")} with no recorded outcome — the pass's accounting does not close`,
    };
  }
  // The unresolved accounting: the pass's own unresolved outcomes, then the
  // skips, in plan order — the enumeration a refusal names.
  /** @type {string[]} */
  const unresolved = [];
  for (const id of planned) {
    const record = outcomeById.get(id);
    if (record !== undefined && record["lifecycle"] === "unresolved") {
      unresolved.push(
        unresolvedPlannedClause(id, /** @type {string | undefined} */ (record["reason"])),
      );
    }
  }
  for (const record of /** @type {VerificationSkipRecord[]} */ (facts["skipped"])) {
    unresolved.push(`${record.file}:${String(record.line)} (${record.reason})`);
  }
  if (unresolved.length === 0) return { passed: true };
  const mode = verificationMode(
    /** @type {Strategy} */ (strategy),
    /** @type {Strictness} */ (strictness),
  );
  if (mode === "normal") return { passed: true };
  return {
    passed: false,
    reason: `the ${mode} policy refuses an unresolved finding: ${unresolved.join("; ")}`,
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

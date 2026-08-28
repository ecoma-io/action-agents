/**
 * `harmonise` incremental report — the run's own accounting, built from facts
 * the loop already holds.
 *
 * A run that skips forty pairs and translates three currently leaves only
 * ad-hoc log lines behind. This module turns the same facts into one
 * structured, deterministic account — pairs total and by outcome, skips and
 * refusals grouped by declared reason, per-pair identities with their change
 * shape, degradation events, the publication result, and the model-call
 * count — and renders that account as a short markdown summary.
 *
 * ## DOCTRINE
 *
 * The report is code's own accounting of what deterministic checks decided.
 * Nothing in it is model-authored: every fact enters through
 * {@link buildReport}, which validates it against a declared shape before
 * accepting it. A fact outside the declared vocabulary, a missing mandatory
 * field, or a count that contradicts the per-pair list is refused with a
 * typed error — never coerced, never filled in. A report that papered over a
 * gap would be a lie with stable formatting.
 *
 * Rendering ({@link renderReport}) is a pure projection of a validated
 * report: stable section order, pairs in identity order, and no
 * model-composed text anywhere. Strings the loop carried through (pair
 * identities, degradation details, whole-file reasons) are collapsed to one
 * line, so untrusted content cannot inject structure into the markdown. A
 * report past the declared maximum length is refused, not truncated — a
 * silently cut summary is a wrong summary.
 *
 * The report object is a deeply frozen plain object with a stable key order,
 * so a later task can serialize it as an artifact verbatim. This module is
 * pure — no files, no model, no clock — and unwired: nothing imports it yet,
 * and a later task owns the integration.
 *
 * @module harmonise/src/report
 */

/**
 * Why a pair produced no translation and no refusal. One today: the stale
 * classifier's in-step verdict, the pair that matches its recorded
 * publication and needs no model call. A reason outside this set is refused,
 * not coerced; a new loop decision means a new entry here first.
 *
 * @typedef {"in-step"} SkipReason
 */

/**
 * Why a deterministic check refused a pair before any model call. The four
 * classes follow the loop's refusal sites one for one:
 * `planner` — the source's plan or frontmatter mask was refused before
 * preparation; `frontmatter-guard` — the frontmatter protection plan was
 * refused; `protection` — the source could not be protected (a malformed
 * skip directive, a glossary term carrying control characters); `over-cap`
 * — the existing translation is past the byte cap and must be split first.
 *
 * @typedef {"planner" | "frontmatter-guard" | "protection" | "over-cap"} RefusalReason
 */

/**
 * What a pair did. `translated` — reached the model and its answer was
 * accepted (a proposal or an unchanged noop). `skipped` — a deterministic
 * verdict held the model back. `refused` — a deterministic check refused the
 * pair before any model call. `failed` — the pair failed after its retries.
 *
 * @typedef {"translated" | "skipped" | "refused" | "failed"} PairOutcome
 */

/**
 * A degradation the run carried through instead of failing on. Advisory in
 * both cases: `corrupt-state` — the sync-state file was missing, unreadable
 * or of a foreign schema, so the run recomputed from real bytes;
 * `corrupt-tm` — the translation-memory file left an empty store, so no
 * prior translations were offered. Neither blocks a run; both are reported.
 *
 * @typedef {"corrupt-state" | "corrupt-tm"} DegradationKind
 */

/**
 * A pair's change shape, mirroring {@link import("./plan.mjs").PairBlockShape}:
 * `whole-file` scopes the change to the whole document (optionally naming
 * why); `planned` scopes it to four block counts. The two variants carry no
 * fields of the other, by validation — a shape mixing them is refused.
 *
 * @typedef {{planning: "whole-file", reason?: string} | {planning: "planned", changed: number, unchanged: number, added: number, removed: number}} ChangeShape
 */

/**
 * One pair's facts, exactly as the loop holds them. `identity` is a single
 * non-empty string the loop composes (a language and a source path); it is
 * unique across the list. `reason` names a declared skip or refusal reason,
 * mandatory for those outcomes and forbidden on `translated` or `failed`.
 * `changeShape` is optional on every outcome — its own structure is
 * validated separately.
 *
 * @typedef {object} PairFact
 * @property {string} identity
 * @property {PairOutcome} outcome
 * @property {SkipReason | RefusalReason} [reason]
 * @property {ChangeShape} [changeShape]
 */

/**
 * One degradation event the run carried through. `detail` is a non-empty
 * string the loop composes; it is collapsed to one line at render time.
 *
 * @typedef {object} DegradationFact
 * @property {DegradationKind} kind
 * @property {string} detail
 */

/**
 * The publication a run produced, or `null` when nothing was proposed.
 *
 * @typedef {{branch: string, commit: string} | null} PublicationFact
 */

/**
 * The facts the loop holds at the end of a run — the only source a report is
 * built from. Every field is mandatory: `pairsTotal` and the four counts name
 * numbers the run reached; `skipped` and `refused` are per-reason maps
 * (declared reasons only, values non-negative); `pairs` is the per-pair list;
 * `degradations` is the carried events (possibly empty); `publication` is
 * either the produced branch and commit or `null`; `modelCalls` is the run's
 * model-call count. Every count is cross-checked against the pair list and
 * refused on contradiction.
 *
 * @typedef {object} RunFacts
 * @property {number} pairsTotal
 * @property {number} translated
 * @property {number} failed
 * @property {Partial<Record<SkipReason, number>>} skipped
 * @property {Partial<Record<RefusalReason, number>>} refused
 * @property {PairFact[]} pairs
 * @property {DegradationFact[]} degradations
 * @property {PublicationFact} publication
 * @property {number} modelCalls
 */

/**
 * One pair in a report, after validation. The same fields as
 * {@link PairFact}, but `reason` is narrowed to the pair's outcome: a skip
 * reason on `skipped`, a refusal reason on `refused`, absent otherwise.
 *
 * @typedef {object} ReportedPair
 * @property {string} identity
 * @property {PairOutcome} outcome
 * @property {SkipReason | RefusalReason} [reason]
 * @property {Readonly<ChangeShape>} [changeShape]
 */

/**
 * The structured report. Plain, deeply frozen, stable key order. `skipped`
 * and `refused` carry only the reasons that occurred (sparse, in vocabulary
 * order); `pairs` is ordered by identity; `degradations` is ordered by kind
 * then detail. Serializes verbatim as an artifact.
 *
 * @typedef {object} RunReport
 * @property {1} schemaVersion
 * @property {number} pairsTotal
 * @property {number} translated
 * @property {Readonly<Partial<Record<SkipReason, number>>>} skipped
 * @property {Readonly<Partial<Record<RefusalReason, number>>>} refused
 * @property {number} failed
 * @property {Readonly<ReportedPair[]>} pairs
 * @property {Readonly<DegradationFact[]>} degradations
 * @property {Readonly<{branch: string, commit: string}> | null} publication
 * @property {number} modelCalls
 */

/** The declared skip reasons, in vocabulary order. Exported frozen. */
export const SKIP_REASONS = Object.freeze(["in-step"]);

/** The declared refusal reasons, in vocabulary order. Exported frozen. */
export const REFUSED_REASONS = Object.freeze([
  "planner",
  "frontmatter-guard",
  "protection",
  "over-cap",
]);

/** The declared pair outcomes, in vocabulary order. Exported frozen. */
export const PAIR_OUTCOMES = Object.freeze(["translated", "skipped", "refused", "failed"]);

/** The declared degradation kinds, in vocabulary order. Exported frozen. */
export const DEGRADATION_KINDS = Object.freeze(["corrupt-state", "corrupt-tm"]);

/**
 * The most characters a rendered report may occupy. A run whose report
 * exceeds this is refused at render time — a summary is read, not scrolled,
 * and a truncation would hide exactly the pairs that went wrong.
 */
export const MAX_REPORT_MARKDOWN_LENGTH = 4096;

/** The set of top-level keys a {@link RunFacts} object may carry. */
const RUN_FACTS_KEYS = new Set([
  "pairsTotal",
  "translated",
  "failed",
  "skipped",
  "refused",
  "pairs",
  "degradations",
  "publication",
  "modelCalls",
]);

/** The set of keys a {@link PairFact} object may carry. */
const PAIR_FACT_KEYS = new Set(["identity", "outcome", "reason", "changeShape"]);

/** The keys a {@link PairFact} object must carry — `reason` and `changeShape` are optional. */
const PAIR_FACT_REQUIRED_KEYS = new Set(["identity", "outcome"]);

/** The set of keys a publication object may carry. */
const PUBLICATION_KEYS = new Set(["branch", "commit"]);

/** The set of keys a {@link DegradationFact} object may carry. */
const DEGRADATION_KEYS = new Set(["kind", "detail"]);

/** The set of keys a {@link ChangeShape} object may carry. */
const CHANGE_SHAPE_KEYS = new Set([
  "planning",
  "reason",
  "changed",
  "unchanged",
  "added",
  "removed",
]);

/**
 * A fact that does not match the declared run shape. `code` names the class
 * of violation (`unknown_key`, `missing_field`, `invalid_type`,
 * `invalid_value`, `count_mismatch`); the message names the field path and
 * the refused value. Never thrown as a guess, never coerced past.
 */
export class ReportValidationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "ReportValidationError";
    this.code = code;
  }
}

/**
 * A report whose rendered markdown exceeds the declared maximum. The report
 * is refused whole, not truncated.
 */
export class ReportLengthError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "ReportLengthError";
  }
}

/**
 * Builds the deterministic report object from the facts the loop holds.
 *
 * Every field is validated against the declared shape; every count is
 * cross-checked against the per-pair list and refused on contradiction. The
 * returned object is a deeply frozen plain object with a stable key order.
 *
 * @param {unknown} runFacts
 * @returns {RunReport}
 * @throws {ReportValidationError} any fact outside the declared shape, or any
 *   count that contradicts the per-pair list
 */
export function buildReport(runFacts) {
  if (!isPlainObject(runFacts)) {
    throw new ReportValidationError(
      "invalid_type",
      `runFacts: expected a plain object, got ${describe(runFacts)} — refused, not guessed`,
    );
  }
  rejectUnknownKeys(runFacts, RUN_FACTS_KEYS, "runFacts");
  requireKeys(runFacts, RUN_FACTS_KEYS, "runFacts");

  const pairsTotal = requireCount(runFacts, "pairsTotal");
  const translated = requireCount(runFacts, "translated");
  const failed = requireCount(runFacts, "failed");
  const modelCalls = requireCount(runFacts, "modelCalls");
  const skippedMap = readReasonMap(runFacts.skipped, SKIP_REASONS, "skipped");
  const refusedMap = readReasonMap(runFacts.refused, REFUSED_REASONS, "refused");

  if (!Array.isArray(runFacts.pairs)) {
    throw new ReportValidationError(
      "invalid_type",
      `runFacts.pairs: expected an array, got ${describe(runFacts.pairs)} — refused, not guessed`,
    );
  }
  const seen = new Set();
  const pairs = /** @type {ReportedPair[]} */ (
    runFacts.pairs.map((entry, index) => validatePair(entry, index, seen))
  );
  pairs.sort((a, b) => compare(a.identity, b.identity));

  if (!Array.isArray(runFacts.degradations)) {
    throw new ReportValidationError(
      "invalid_type",
      `runFacts.degradations: expected an array, got ${describe(runFacts.degradations)} — refused, not guessed`,
    );
  }
  const degradations = runFacts.degradations
    .map((entry, index) => validateDegradation(entry, index))
    .sort((a, b) => (a.kind === b.kind ? compare(a.detail, b.detail) : compare(a.kind, b.kind)));

  const publication = readPublication(runFacts.publication);

  // Cross-checks: counts that contradict the per-pair list are refused whole.
  if (pairs.length !== pairsTotal) {
    throw new ReportValidationError(
      "count_mismatch",
      `pairsTotal declares ${String(pairsTotal)}, the pair list holds ${String(pairs.length)} — refused, not reconciled`,
    );
  }
  assertScalarTally(pairs, "translated", translated);
  assertScalarTally(pairs, "failed", failed);
  assertReasonTallies(pairs, "skipped", SKIP_REASONS, skippedMap);
  assertReasonTallies(pairs, "refused", REFUSED_REASONS, refusedMap);

  /** @type {RunReport} */
  const report = {
    schemaVersion: 1,
    pairsTotal,
    translated,
    skipped: sparseReasonMap(skippedMap, SKIP_REASONS),
    refused: sparseReasonMap(refusedMap, REFUSED_REASONS),
    failed,
    pairs,
    degradations,
    publication,
    modelCalls,
  };
  return deepFreeze(report);
}

/**
 * Renders a validated report as a short, deterministic markdown summary.
 *
 * Stable section order; pairs in identity order; no model-composed text.
 * Strings carried through from the loop are collapsed to one line so
 * untrusted content cannot inject structure. A report past the declared
 * maximum length is refused, not truncated.
 *
 * @param {unknown} report
 * @returns {string}
 * @throws {ReportValidationError} a value that is not the object
 *   {@link buildReport} returns
 * @throws {ReportLengthError} the rendered report exceeds the declared cap
 */
export function renderReport(report) {
  if (!isPlainObject(report)) {
    throw new ReportValidationError(
      "invalid_type",
      `report: expected the object buildReport returns, got ${describe(report)} — refused, not guessed`,
    );
  }
  const { pairsTotal, translated, failed, modelCalls } = readReportFields(report);
  const skipped = readReasonMap(report.skipped, SKIP_REASONS, "report.skipped");
  const refused = readReasonMap(report.refused, REFUSED_REASONS, "report.refused");
  if (!Array.isArray(report.pairs)) {
    throw new ReportValidationError(
      "invalid_type",
      `report.pairs: expected an array, got ${describe(report.pairs)} — refused, not guessed`,
    );
  }
  const pairs = report.pairs.map((entry, index) => renderPair(entry, index));
  if (!Array.isArray(report.degradations)) {
    throw new ReportValidationError(
      "invalid_type",
      `report.degradations: expected an array, got ${describe(report.degradations)} — refused, not guessed`,
    );
  }
  const degradations = report.degradations.map((entry, index) => renderDegradation(entry, index));
  const publication = readPublication(report.publication);

  const skippedTotal = sumValues(skipped);
  const refusedTotal = sumValues(refused);

  const lines = [
    "### Harmonise run report",
    "",
    `Pairs: ${String(pairsTotal)} total — ${String(translated)} translated, ${String(skippedTotal)} skipped, ${String(refusedTotal)} refused, ${String(failed)} failed.`,
    `Model calls: ${String(modelCalls)}.`,
  ];
  pushReasonSection(lines, "Skipped", SKIP_REASONS, skipped);
  pushReasonSection(lines, "Refused", REFUSED_REASONS, refused);
  if (pairs.length > 0) {
    lines.push("", "#### Pairs", "", ...pairs);
  }
  if (degradations.length > 0) {
    lines.push("", "#### Degradations", "", ...degradations);
  }
  if (publication !== null) {
    lines.push(
      "",
      "#### Publication",
      "",
      `- branch \`${oneLine(publication.branch)}\`, commit \`${oneLine(publication.commit)}\``,
    );
  }
  const text = `${lines.join("\n")}\n`;
  if (text.length > MAX_REPORT_MARKDOWN_LENGTH) {
    throw new ReportLengthError(
      `the rendered report is ${String(text.length)} characters, past the ${String(MAX_REPORT_MARKDOWN_LENGTH)}-character cap — refused, not truncated`,
    );
  }
  return text;
}

/**
 * Validates one pair fact and returns its frozen report form.
 *
 * @param {unknown} value
 * @param {number} index
 * @param {Set<string>} seen identities already accepted
 * @returns {ReportedPair}
 * @throws {ReportValidationError}
 */
function validatePair(value, index, seen) {
  const where = `pairs[${String(index)}]`;
  if (!isPlainObject(value)) {
    throw new ReportValidationError(
      "invalid_type",
      `${where}: expected a plain object, got ${describe(value)} — refused, not guessed`,
    );
  }
  rejectUnknownKeys(value, PAIR_FACT_KEYS, where);
  requireKeys(value, PAIR_FACT_REQUIRED_KEYS, where);

  const identity = value.identity;
  if (!isNonEmptyString(identity)) {
    throw new ReportValidationError(
      "invalid_value",
      `${where}.identity: expected a non-empty string, got ${describe(identity)} — refused, not guessed`,
    );
  }
  if (seen.has(identity)) {
    throw new ReportValidationError(
      "invalid_value",
      `${where}.identity: '${oneLine(identity)}' is declared twice — a report's pair ordering requires unique identities`,
    );
  }
  seen.add(identity);

  const outcome = value.outcome;
  if (!PAIR_OUTCOMES.includes(/** @type {string} */ (outcome))) {
    throw new ReportValidationError(
      "invalid_value",
      `${where}.outcome: ${describe(outcome)} is not a declared outcome (one of ${listVocabulary(PAIR_OUTCOMES)}) — refused, not coerced`,
    );
  }

  const reason = value.reason;
  if (outcome === "translated" || outcome === "failed") {
    if (reason !== undefined) {
      throw new ReportValidationError(
        "invalid_value",
        `${where}.reason: an outcome '${outcome}' carries no reason — refused, not kept`,
      );
    }
  } else {
    if (reason === undefined) {
      throw new ReportValidationError(
        "missing_field",
        `${where}.reason: an outcome '${outcome}' names its reason — refused, not filled in`,
      );
    }
    const declared = outcome === "skipped" ? SKIP_REASONS : REFUSED_REASONS;
    if (!declared.includes(/** @type {string} */ (reason))) {
      throw new ReportValidationError(
        "invalid_value",
        `${where}.reason: '${oneLine(String(reason))}' is not a declared ${outcome} reason (one of ${listVocabulary(declared)}) — refused, not coerced`,
      );
    }
  }

  const changeShape =
    value.changeShape === undefined
      ? undefined
      : validateChangeShape(value.changeShape, `${where}.changeShape`);

  /** @type {ReportedPair} */
  const pair = {
    identity,
    outcome: /** @type {PairOutcome} */ (outcome),
    ...(reason !== undefined ? { reason: /** @type {SkipReason | RefusalReason} */ (reason) } : {}),
    ...(changeShape !== undefined ? { changeShape } : {}),
  };
  return deepFreeze(pair);
}

/**
 * Validates a change shape and returns its frozen, normalized form.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {ChangeShape}
 * @throws {ReportValidationError}
 */
function validateChangeShape(value, where) {
  if (!isPlainObject(value)) {
    throw new ReportValidationError(
      "invalid_type",
      `${where}: expected a plain object, got ${describe(value)} — refused, not guessed`,
    );
  }
  rejectUnknownKeys(value, CHANGE_SHAPE_KEYS, where);
  const planning = value.planning;
  if (planning !== "whole-file" && planning !== "planned") {
    throw new ReportValidationError(
      "invalid_value",
      `${where}.planning: ${describe(planning)} is not 'whole-file' or 'planned' — refused, not coerced`,
    );
  }
  if (planning === "whole-file") {
    if ("changed" in value || "unchanged" in value || "added" in value || "removed" in value) {
      throw new ReportValidationError(
        "invalid_value",
        `${where}: a whole-file shape carries no block counts — refused, not mixed`,
      );
    }
    const reason = value.reason;
    if (reason !== undefined && !isNonEmptyString(reason)) {
      throw new ReportValidationError(
        "invalid_value",
        `${where}.reason: expected a non-empty string, got ${describe(reason)} — refused, not guessed`,
      );
    }
    /** @type {ChangeShape} */
    const shape = { planning: "whole-file", ...(reason !== undefined ? { reason } : {}) };
    return deepFreeze(shape);
  }
  if ("reason" in value) {
    throw new ReportValidationError(
      "invalid_value",
      `${where}: a planned shape names no whole-file reason — refused, not mixed`,
    );
  }
  const counts = { changed: 0, unchanged: 0, added: 0, removed: 0 };
  for (const key of ["changed", "unchanged", "added", "removed"]) {
    if (!(key in value)) {
      throw new ReportValidationError(
        "missing_field",
        `${where}: a planned shape declares '${key}' — refused, not filled in`,
      );
    }
    const n = value[key];
    if (!Number.isInteger(n) || /** @type {number} */ (n) < 0) {
      throw new ReportValidationError(
        "invalid_value",
        `${where}.${key}: expected a non-negative integer, got ${describe(n)} — refused, not guessed`,
      );
    }
    counts[/** @type {"changed" | "unchanged" | "added" | "removed"} */ (key)] =
      /** @type {number} */ (n);
  }
  /** @type {ChangeShape} */
  const shape = { planning: "planned", ...counts };
  return deepFreeze(shape);
}

/**
 * Validates one degradation fact and returns its frozen form.
 *
 * @param {unknown} value
 * @param {number} index
 * @returns {DegradationFact}
 * @throws {ReportValidationError}
 */
function validateDegradation(value, index) {
  const where = `degradations[${String(index)}]`;
  if (!isPlainObject(value)) {
    throw new ReportValidationError(
      "invalid_type",
      `${where}: expected a plain object, got ${describe(value)} — refused, not guessed`,
    );
  }
  rejectUnknownKeys(value, DEGRADATION_KEYS, where);
  requireKeys(value, DEGRADATION_KEYS, where);
  const kind = value.kind;
  if (!DEGRADATION_KINDS.includes(/** @type {string} */ (kind))) {
    throw new ReportValidationError(
      "invalid_value",
      `${where}.kind: ${describe(kind)} is not a declared degradation kind (one of ${listVocabulary(DEGRADATION_KINDS)}) — refused, not coerced`,
    );
  }
  const detail = value.detail;
  if (!isNonEmptyString(detail)) {
    throw new ReportValidationError(
      "invalid_value",
      `${where}.detail: expected a non-empty string, got ${describe(detail)} — refused, not guessed`,
    );
  }
  return deepFreeze({ kind: /** @type {DegradationKind} */ (kind), detail });
}

/**
 * Reads the publication field: `null` or `{branch, commit}` with non-empty
 * strings. Anything else is refused.
 *
 * @param {unknown} value
 * @returns {PublicationFact}
 * @throws {ReportValidationError}
 */
function readPublication(value) {
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw new ReportValidationError(
      "invalid_type",
      `publication: expected null or a {branch, commit} object, got ${describe(value)} — refused, not guessed`,
    );
  }
  rejectUnknownKeys(value, PUBLICATION_KEYS, "publication");
  requireKeys(value, PUBLICATION_KEYS, "publication");
  const branch = value.branch;
  const commit = value.commit;
  if (!isNonEmptyString(branch)) {
    throw new ReportValidationError(
      "invalid_value",
      `publication.branch: expected a non-empty string, got ${describe(branch)} — refused, not guessed`,
    );
  }
  if (!isNonEmptyString(commit)) {
    throw new ReportValidationError(
      "invalid_value",
      `publication.commit: expected a non-empty string, got ${describe(commit)} — refused, not guessed`,
    );
  }
  return deepFreeze({ branch, commit });
}

/**
 * Reads a per-reason map of declared reasons to non-negative counts.
 * Returns the entries that name a declared reason with any value (zero
 * included, so a count the loop reached explicitly is kept).
 *
 * @param {unknown} value
 * @param {ReadonlyArray<string>} declared
 * @param {string} where
 * @returns {Map<string, number>}
 * @throws {ReportValidationError}
 */
function readReasonMap(value, declared, where) {
  if (!isPlainObject(value)) {
    throw new ReportValidationError(
      "invalid_type",
      `${where}: expected a plain object, got ${describe(value)} — refused, not guessed`,
    );
  }
  const map = new Map();
  for (const [reason, count] of Object.entries(value)) {
    if (!declared.includes(reason)) {
      throw new ReportValidationError(
        "unknown_key",
        `${where}: '${oneLine(reason)}' is not a declared reason (one of ${listVocabulary(declared)}) — refused, not coerced`,
      );
    }
    if (!Number.isInteger(count) || /** @type {number} */ (count) < 0) {
      throw new ReportValidationError(
        "invalid_value",
        `${where}.${reason}: expected a non-negative integer, got ${describe(count)} — refused, not guessed`,
      );
    }
    map.set(reason, /** @type {number} */ (count));
  }
  return map;
}

/**
 * Reads the scalar report fields render relies on.
 *
 * @param {Record<string, unknown>} report
 * @returns {{pairsTotal: number, translated: number, failed: number, modelCalls: number}}
 * @throws {ReportValidationError}
 */
function readReportFields(report) {
  /** @param {string} key */
  const scalar = (key) => {
    const value = report[key];
    if (!Number.isInteger(value) || /** @type {number} */ (value) < 0) {
      throw new ReportValidationError(
        "invalid_value",
        `report.${key}: expected a non-negative integer, got ${describe(value)} — refused, not guessed`,
      );
    }
    return /** @type {number} */ (value);
  };
  return {
    pairsTotal: scalar("pairsTotal"),
    translated: scalar("translated"),
    failed: scalar("failed"),
    modelCalls: scalar("modelCalls"),
  };
}

/**
 * Refuses any key on `value` that is not in `declared`.
 *
 * @param {Record<string, unknown>} value
 * @param {ReadonlySet<string>} declared
 * @param {string} where
 * @throws {ReportValidationError}
 */
function rejectUnknownKeys(value, declared, where) {
  for (const key of Object.keys(value)) {
    if (!declared.has(key)) {
      throw new ReportValidationError(
        "unknown_key",
        `${where}: '${oneLine(key)}' is not a declared field — refused, not kept`,
      );
    }
  }
}

/**
 * Refuses if any key in `declared` is absent from `value`.
 *
 * @param {Record<string, unknown>} value
 * @param {ReadonlySet<string>} declared
 * @param {string} where
 * @throws {ReportValidationError}
 */
function requireKeys(value, declared, where) {
  for (const key of declared) {
    if (!(key in value)) {
      throw new ReportValidationError(
        "missing_field",
        `${where}: missing mandatory field '${key}' — refused, not filled in`,
      );
    }
  }
}

/**
 * Reads and validates a non-negative integer count.
 *
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {number}
 * @throws {ReportValidationError}
 */
function requireCount(value, key) {
  const n = value[key];
  if (!Number.isInteger(n)) {
    throw new ReportValidationError(
      "invalid_type",
      `${key}: expected a non-negative integer, got ${describe(n)} — refused, not guessed`,
    );
  }
  if (/** @type {number} */ (n) < 0) {
    throw new ReportValidationError(
      "invalid_value",
      `${key}: ${String(n)} is negative — a count is never negative, refused`,
    );
  }
  return /** @type {number} */ (n);
}

/**
 * Refuses if the declared scalar count does not equal the tally of pairs with
 * that outcome.
 *
 * @param {ReportedPair[]} pairs
 * @param {PairOutcome} outcome
 * @param {number} declared
 * @throws {ReportValidationError}
 */
function assertScalarTally(pairs, outcome, declared) {
  const actual = pairs.filter((pair) => pair.outcome === outcome).length;
  if (actual !== declared) {
    throw new ReportValidationError(
      "count_mismatch",
      `${outcome} declares ${String(declared)}, the pair list holds ${String(actual)} — refused, not reconciled`,
    );
  }
}

/**
 * Refuses if the declared per-reason counts do not exactly match the
 * per-pair tallies. A non-zero tally the facts omit is a gap (refused); a
 * declared value the list contradicts is a lie (refused); a zero declared
 * against a zero tally is accepted.
 *
 * @param {ReportedPair[]} pairs
 * @param {PairOutcome} outcome
 * @param {ReadonlyArray<string>} declared
 * @param {Map<string, number>} declaredMap
 * @throws {ReportValidationError}
 */
function assertReasonTallies(pairs, outcome, declared, declaredMap) {
  const tallies = new Map();
  for (const pair of pairs) {
    if (pair.outcome !== outcome) continue;
    const reason = /** @type {string} */ (pair.reason);
    tallies.set(reason, (tallies.get(reason) ?? 0) + 1);
  }
  for (const reason of declared) {
    const declaredCount = declaredMap.get(reason);
    const actual = tallies.get(reason) ?? 0;
    if (declaredCount === undefined) {
      if (actual !== 0) {
        throw new ReportValidationError(
          "count_mismatch",
          `${outcome}.${reason}: the facts name no count, the pair list holds ${String(actual)} — refused, not filled in`,
        );
      }
    } else if (declaredCount !== actual) {
      throw new ReportValidationError(
        "count_mismatch",
        `${outcome}.${reason}: the facts declare ${String(declaredCount)}, the pair list holds ${String(actual)} — refused, not reconciled`,
      );
    }
  }
}

/**
 * Builds a sparse, vocabulary-ordered reason map for the report: only reasons
 * that occurred carry a count.
 *
 * @param {Map<string, number>} map
 * @param {ReadonlyArray<string>} declared
 * @returns {Readonly<Partial<Record<string, number>>>}
 */
function sparseReasonMap(map, declared) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const reason of declared) {
    const count = map.get(reason);
    if (count !== undefined && count > 0) {
      out[reason] = count;
    }
  }
  return deepFreeze(out);
}

/**
 * Appends a section listing per-reason counts, only when the section has any.
 *
 * @param {string[]} lines
 * @param {string} title
 * @param {ReadonlyArray<string>} declared
 * @param {Map<string, number>} counts
 */
function pushReasonSection(lines, title, declared, counts) {
  if (sumValues(counts) === 0) return;
  lines.push("", `#### ${title}`, "");
  for (const reason of declared) {
    const count = counts.get(reason);
    if (count !== undefined && count > 0) {
      lines.push(`- \`${oneLine(reason)}\`: ${String(count)}`);
    }
  }
}

/**
 * Renders one pair as a single markdown line.
 *
 * @param {unknown} value
 * @param {number} index
 * @returns {string}
 * @throws {ReportValidationError}
 */
function renderPair(value, index) {
  const where = `report.pairs[${String(index)}]`;
  if (!isPlainObject(value)) {
    throw new ReportValidationError(
      "invalid_type",
      `${where}: expected a plain object, got ${describe(value)} — refused, not guessed`,
    );
  }
  rejectUnknownKeys(value, PAIR_FACT_KEYS, where);
  requireKeys(value, PAIR_FACT_REQUIRED_KEYS, where);
  const identity = value.identity;
  const outcome = value.outcome;
  if (!isNonEmptyString(identity)) {
    throw new ReportValidationError(
      "invalid_value",
      `${where}.identity: expected a non-empty string — refused, not guessed`,
    );
  }
  if (!PAIR_OUTCOMES.includes(/** @type {string} */ (outcome))) {
    throw new ReportValidationError(
      "invalid_value",
      `${where}.outcome: ${describe(outcome)} is not a declared outcome — refused, not coerced`,
    );
  }
  const reason = value.reason;
  if (outcome === "skipped" || outcome === "refused") {
    if (!isNonEmptyString(reason)) {
      throw new ReportValidationError(
        "missing_field",
        `${where}.reason: an outcome '${outcome}' names its reason — refused, not filled in`,
      );
    }
    return `- \`${oneLine(identity)}\` — ${outcome} (\`${oneLine(reason)}\`)`;
  }
  const shape = value.changeShape;
  if (shape === undefined) {
    return `- \`${oneLine(identity)}\` — ${outcome}`;
  }
  return `- \`${oneLine(identity)}\` — ${outcome}${renderChangeShape(shape, where)}`;
}

/**
 * Renders the change-shape suffix for a pair line.
 *
 * @param {unknown} value
 * @param {string} where
 * @returns {string}
 * @throws {ReportValidationError}
 */
function renderChangeShape(value, where) {
  if (!isPlainObject(value)) {
    throw new ReportValidationError(
      "invalid_type",
      `${where}: expected a plain object — refused, not guessed`,
    );
  }
  rejectUnknownKeys(value, CHANGE_SHAPE_KEYS, where);
  const planning = value.planning;
  if (planning === "whole-file") {
    const reason = value.reason;
    return reason === undefined
      ? ", blocks whole-file"
      : `, blocks whole-file (${oneLine(String(reason))})`;
  }
  if (planning === "planned") {
    const changed = value.changed;
    const unchanged = value.unchanged;
    const added = value.added;
    const removed = value.removed;
    for (const [label, n] of [
      ["changed", changed],
      ["unchanged", unchanged],
      ["added", added],
      ["removed", removed],
    ]) {
      if (!Number.isInteger(n) || /** @type {number} */ (n) < 0) {
        throw new ReportValidationError(
          "invalid_value",
          `${where}.${label}: expected a non-negative integer — refused, not guessed`,
        );
      }
    }
    return `, blocks planned: changed ${String(changed)}, unchanged ${String(unchanged)}, added ${String(added)}, removed ${String(removed)}`;
  }
  throw new ReportValidationError(
    "invalid_value",
    `${where}.planning: ${describe(planning)} is not 'whole-file' or 'planned' — refused, not coerced`,
  );
}

/**
 * Renders one degradation as a single markdown line.
 *
 * @param {unknown} value
 * @param {number} index
 * @returns {string}
 * @throws {ReportValidationError}
 */
function renderDegradation(value, index) {
  const where = `report.degradations[${String(index)}]`;
  if (!isPlainObject(value)) {
    throw new ReportValidationError(
      "invalid_type",
      `${where}: expected a plain object — refused, not guessed`,
    );
  }
  rejectUnknownKeys(value, DEGRADATION_KEYS, where);
  requireKeys(value, DEGRADATION_KEYS, where);
  const kind = value.kind;
  const detail = value.detail;
  if (!DEGRADATION_KINDS.includes(/** @type {string} */ (kind))) {
    throw new ReportValidationError(
      "invalid_value",
      `${where}.kind: ${describe(kind)} is not a declared degradation kind — refused, not coerced`,
    );
  }
  if (!isNonEmptyString(detail)) {
    throw new ReportValidationError(
      "invalid_value",
      `${where}.detail: expected a non-empty string — refused, not guessed`,
    );
  }
  return `- \`${oneLine(String(kind))}\`: ${oneLine(detail)}`;
}

/**
 * Sums the values of a per-reason counts map.
 *
 * @param {Map<string, number>} counts
 * @returns {number}
 */
function sumValues(counts) {
  let total = 0;
  for (const count of counts.values()) {
    total += count;
  }
  return total;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Collapses any run of whitespace to a single space, so a string the loop
 * carried through cannot inject newlines into the markdown.
 *
 * @param {string} value
 * @returns {string}
 */
function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Renders a value for an error message, quoting strings.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  return typeof value === "string" ? `'${value}'` : String(value);
}

/**
 * Joins a vocabulary for an error message.
 *
 * @param {ReadonlyArray<string>} declared
 * @returns {string}
 */
function listVocabulary(declared) {
  return declared.map((reason) => `'${reason}'`).join(", ");
}

/**
 * Three-way string comparison for stable ordering.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Freezes a value and every plain object or array nested under it, so a
 * report cannot be changed after it is built.
 *
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
function deepFreeze(value) {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

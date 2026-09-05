/**
 * The harmonise run record — the durable, byte-deterministic account of what
 * one run judged, translated and ended as. Harmonise has been log-only: its
 * report evaporated with the runner log, while triage's and review's records
 * proved what a durable account is worth. Issue #297 is this module's record:
 * the builder composes it at the run's terminal points, the validator refuses
 * any shape this module did not specify, and the serialiser's bytes are
 * stable given the run's inputs.
 *
 * Everything here is fail-closed: a shape this module did not specify is
 * refused, never coerced. The counts are the run's own pair accounting —
 * what was proposed, what was found already in step, what skipped and what
 * failed — and nothing model-composed enters the record.
 *
 * The terminal `reason` is the one field whose provenance is not purely
 * code-owned — the publication path interpolates the repository's default
 * branch name — so it passes the sanitiser at this build site under a
 * declared cap, the way triage's record treats its own reason field.
 */

import { oneLine } from "#core/one-line.mjs";
import { warning } from "#core/runtime.mjs";
import { sanitiseCommentText } from "#core/sanitise.mjs";

/**
 * The harmonise run record's schema version. Any shape change bumps it.
 * Version 3 made `pairs` and `headSha` nullable (#344): a red run may die
 * before it finalises its accounting or pins a base commit, and its record
 * carries the honest null rather than a shape v2 could not express.
 */
export const harmoniseRecordSchemaVersion = 3;

/** The terminal reason's cap — measured as UTF-16 length, the metric the validator's bound and the core sanitiser's cap share (#347); the same width as the triage record's reason keeps. */
export const REASON_CHARS = 300;

/**
 * The vocabulary a record's `outcome` may carry: the run contract's terminal
 * states harmonise reaches (`docs/run-contract.md`), whole and in its own
 * order. A word outside it is a word the contract has not defined, and the
 * validator refuses it — a record is read against the contract, so a private
 * vocabulary here would read as a contract violation there.
 *
 * @typedef {"published" | "partial" | "refused" | "failed" | "skip"} HarmoniseOutcome
 */

/** The terminal states harmonise records, as the validator holds them. */
export const HARMONISE_OUTCOMES = /** @type {readonly HarmoniseOutcome[]} */ ([
  "published",
  "partial",
  "refused",
  "failed",
  "skip",
]);

/**
 * The pair accounting the record carries. The unit is the pair-target — one
 * source document against one language — the unit every path a pair can take
 * is judged in, so a source with three languages is three pairs here. The
 * record names `selected`, the size of the schedule the run walked, and the
 * four counts under it — what was proposed, what was found already in step,
 * what skipped and what failed — partition it: they total `selected` exactly,
 * and the validator refuses a record where they do not.
 *
 * @typedef {object} RecordPairs
 * @property {number} selected the selected schedule's size in pair-targets, recorded so the partition's both sides are in the record
 * @property {number} proposed pairs whose translation was published
 * @property {number} unchanged pairs proven in step, no model call made
 * @property {number} skipped pairs the preparation refused before the model
 * @property {number} failed pairs that errored after every retry
 */

/**
 * The pull request the run wrote, when it wrote one. `null` on a dry run, a
 * run with nothing to propose, and any run that ended before the upsert —
 * the honest absence, not a guessed number.
 *
 * @typedef {object} RecordPullRequest
 * @property {number} number the pull request's number
 * @property {boolean} created whether the run opened it (true) or updated an existing one (false)
 */

/**
 * The record one run leaves behind, built from the facts the run holds when
 * it reaches a terminal point. Every field is a fact the code already
 * computed — and nothing reads the clock, so the same run facts build the
 * same bytes. Model text stays out of the record entirely: the pull request
 * body is the durable form of that path.
 *
 * The builder validates before returning: a record that cannot validate is a
 * code bug, and it fails here rather than at the write.
 *
 * @param {object} input
 * @param {string} input.repository "owner/repo", as the runner named it
 * @param {string} input.eventName the `GITHUB_EVENT_NAME`
 * @param {string} input.sourceLanguage the BCP 47 tag this run kept in step
 * @param {boolean} input.dryRun
 * @param {HarmoniseOutcome} input.outcome the terminal state, in the run contract's vocabulary
 * @param {string} input.reason the terminal path's own sentence — sanitised and capped at this build site
 * @param {RecordPairs | null} input.pairs the run's pair accounting, or null when the run died before it was finalised
 * @param {RecordPullRequest | null} input.pullRequest the pull request the run wrote, or null
 * @param {string | null} input.headSha the base sha every read pinned to (40 hex chars), or null before one was resolved
 * @returns {HarmoniseRecord}
 */
export function buildHarmoniseRecord({
  repository,
  eventName,
  sourceLanguage,
  dryRun,
  outcome,
  reason,
  pairs,
  pullRequest,
  headSha,
}) {
  const record = {
    schemaVersion: harmoniseRecordSchemaVersion,
    repository,
    eventName,
    sourceLanguage,
    dryRun,
    outcome,
    reason: cappedLine(reason, REASON_CHARS),
    pairs:
      pairs === null
        ? null
        : {
            selected: pairs.selected,
            proposed: pairs.proposed,
            unchanged: pairs.unchanged,
            skipped: pairs.skipped,
            failed: pairs.failed,
          },
    pullRequest: pullRequest === null ? null : { ...pullRequest },
    headSha,
  };
  return deepFreeze(validateHarmoniseRecord(record));
}

/** The keys a harmonise record serialises with. Every key is mandatory. */
const RECORD_KEYS = new Set([
  "schemaVersion",
  "repository",
  "eventName",
  "sourceLanguage",
  "dryRun",
  "outcome",
  "reason",
  "pairs",
  "pullRequest",
  "headSha",
]);
const PAIRS_KEYS = new Set(["selected", "proposed", "unchanged", "skipped", "failed"]);
const PULL_REQUEST_KEYS = new Set(["number", "created"]);

/** A commit sha is exactly 40 hex characters; anything else is not a pin. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Fail-closed validation of a harmonise record: exactly the keys this module
 * spells, the run contract's outcome vocabulary, the reason within its
 * declared cap, the pairs accounting that partitions the selected schedule
 * (or the honest `null` of a run that died before finalising it), and a
 * well-formed head sha (or the honest `null` of a run that died before
 * pinning one). A malformed record is a code bug — the builder's output is
 * what flows here — and refusing it beats inventing evidence.
 *
 * @param {unknown} value
 * @returns {HarmoniseRecord}
 */
export function validateHarmoniseRecord(value) {
  const record = asRecord(value, "the harmonise record");
  assertExactKeys(record, "the harmonise record", RECORD_KEYS);
  if (record["schemaVersion"] !== harmoniseRecordSchemaVersion) {
    throw new TypeError(
      `the harmonise record's schemaVersion is not ${String(harmoniseRecordSchemaVersion)}`,
    );
  }
  asNonEmptyString(record["repository"], "the harmonise record's 'repository'");
  asNonEmptyString(record["eventName"], "the harmonise record's 'eventName'");
  asNonEmptyString(record["sourceLanguage"], "the harmonise record's 'sourceLanguage'");
  if (typeof record["dryRun"] !== "boolean") {
    throw new TypeError("the harmonise record's 'dryRun' is not a boolean");
  }
  asOutcome(record["outcome"]);
  asBoundedString(record["reason"], "the harmonise record's 'reason'", REASON_CHARS);
  if (record["pairs"] !== null) asPairs(record["pairs"]);
  asPullRequest(record["pullRequest"]);
  if (
    record["headSha"] !== null &&
    (typeof record["headSha"] !== "string" ||
      !SHA_PATTERN.test(/** @type {string} */ (record["headSha"])))
  ) {
    throw new TypeError("the harmonise record's 'headSha' is not a 40-hex commit sha");
  }
  return /** @type {HarmoniseRecord} */ (value);
}

/**
 * @param {unknown} value
 * @returns {void}
 */
function asPairs(value) {
  const pairs = asRecord(value, "the harmonise record's 'pairs'");
  assertExactKeys(pairs, "the harmonise record's 'pairs'", PAIRS_KEYS);
  for (const key of ["selected", "proposed", "unchanged", "skipped", "failed"]) {
    const n = pairs[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw new TypeError(`the harmonise record's 'pairs.${key}' is not a non-negative integer`);
    }
  }
  const total =
    /** @type {number} */ (pairs["proposed"]) +
    /** @type {number} */ (pairs["unchanged"]) +
    /** @type {number} */ (pairs["skipped"]) +
    /** @type {number} */ (pairs["failed"]);
  if (total !== pairs["selected"]) {
    throw new TypeError(
      `the harmonise record's 'pairs' does not partition the selected schedule: ` +
        `proposed + unchanged + skipped + failed is ${String(total)}, ` +
        `'selected' is ${String(pairs["selected"])}`,
    );
  }
}

/**
 * The pull request the run wrote, or the honest `null`. A `created` value
 * that is not a boolean is refused — the field answers one question, and a
 * partial answer is a defect.
 *
 * @param {unknown} value
 * @returns {void}
 */
function asPullRequest(value) {
  if (value === null) return;
  const pullRequest = asRecord(value, "the harmonise record's 'pullRequest'");
  assertExactKeys(pullRequest, "the harmonise record's 'pullRequest'", PULL_REQUEST_KEYS);
  if (
    typeof pullRequest["number"] !== "number" ||
    !Number.isInteger(pullRequest["number"]) ||
    pullRequest["number"] <= 0
  ) {
    throw new TypeError("the harmonise record's 'pullRequest.number' is not a positive integer");
  }
  if (typeof pullRequest["created"] !== "boolean") {
    throw new TypeError("the harmonise record's 'pullRequest.created' is not a boolean");
  }
}

/**
 * One sanitiser pass at a build site: flattened to one line, structural
 * tokens removed, mentions broken, capped visibly. The notes are logged the
 * way the comment builders log theirs — the record's bytes stay clean, and
 * the run log carries what the sanitiser bit off.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function cappedLine(text, maxChars) {
  const result = sanitiseCommentText(oneLine(text), { maxChars });
  for (const note of result.notes) {
    warning(`sanitiser: ${note}`);
  }
  return result.text;
}

/**
 * @param {unknown} value
 * @returns {void}
 */
function asOutcome(value) {
  for (const candidate of HARMONISE_OUTCOMES) {
    if (candidate === value) return;
  }
  throw new TypeError(
    "the harmonise record's 'outcome' is outside the run contract's terminal states",
  );
}

/**
 * The name a run record is written under. One file per run, named after the
 * base commit the run pinned to — a record's identity is the instant it
 * judged, and the name carries that. A red run that died before pinning a
 * base writes `no-base` in its place: still one deterministic name, still
 * inside the upload glob `harmonise-record-*.json`, and never a collision
 * with a pinned run's 40-hex name.
 *
 * @param {HarmoniseRecord} record
 * @returns {string}
 */
export function harmoniseRecordFilename(record) {
  return `harmonise-record-${record.headSha ?? "no-base"}.json`;
}

/**
 * Serialises a harmonise record to a stable JSON string: keys sorted, no
 * whitespace, no trailing newline — the determinism posture triage's and
 * review's serialisers keep, so the bytes are identical however the object
 * was assembled. The record is validated first: a shape this module did not
 * build is refused, not mis-serialised.
 *
 * @param {HarmoniseRecord} record
 * @returns {string}
 */
export function serialiseHarmoniseRecord(record) {
  validateHarmoniseRecord(record);
  return stableStringify(record);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === undefined) {
    throw new TypeError("refuse to serialise an undefined value");
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("refuse to serialise a non-data value");
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    const elements = /** @type {unknown[]} */ (value);
    return `[${elements.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(object).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const element of /** @type {unknown[]} */ (value)) {
      deepFreeze(element);
    }
    Object.freeze(value);
  } else if (value !== null && typeof value === "object") {
    for (const nested of Object.values(/** @type {Record<string, unknown>} */ (value))) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function asRecord(v, label) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError(`${label} is not an object`);
  }
  return /** @type {Record<string, unknown>} */ (v);
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {string}
 */
function asNonEmptyString(v, label) {
  if (typeof v !== "string" || v.length === 0) {
    throw new TypeError(`${label} is not a non-empty string`);
  }
  return v;
}

/**
 * @param {unknown} v
 * @param {string} label
 * @param {number} max
 * @returns {string}
 */
function asBoundedString(v, label, max) {
  if (typeof v !== "string") {
    throw new TypeError(`${label} is not a string`);
  }
  if (v.length > max) {
    throw new TypeError(`${label} exceeds its ${String(max)}-character cap`);
  }
  return v;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} label
 * @param {ReadonlySet<string>} allowed
 * @returns {void}
 */
function assertExactKeys(obj, label, allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} carries an unknown key '${key}'`);
    }
  }
  for (const key of allowed) {
    if (!(key in obj)) {
      throw new TypeError(`${label} is missing '${key}'`);
    }
  }
}

/**
 * The record one harmonise run leaves behind — the exact key set this module
 * builds, validates and serialises, in the documented field order:
 * `schemaVersion`, `repository`, `eventName`, `sourceLanguage`, `dryRun`,
 * `outcome`, `reason`, `pairs`, `pullRequest`, `headSha`.
 *
 * @typedef {object} HarmoniseRecord
 * @property {typeof harmoniseRecordSchemaVersion} schemaVersion
 * @property {string} repository "owner/repo", as the runner named it
 * @property {string} eventName the `GITHUB_EVENT_NAME`
 * @property {string} sourceLanguage the BCP 47 tag this run kept in step
 * @property {boolean} dryRun
 * @property {HarmoniseOutcome} outcome a terminal state, as the run contract spells it
 * @property {string} reason the terminal path's own sentence, one line, sanitised and capped
 * @property {RecordPairs | null} pairs the run's pair accounting; null when the run died before it was finalised
 * @property {RecordPullRequest | null} pullRequest null when the run wrote none
 * @property {string | null} headSha the base sha every read pinned to; null before the run resolved one
 */

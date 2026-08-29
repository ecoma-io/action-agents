/**
 * `harmonise` drift detection — did a published destination file change
 * outside harmonise?
 *
 * ## DOCTRINE (advisory only)
 *
 * Drift detection is deterministic over fingerprints: the digest recorded at
 * last publication (a sync-state record's `translationFingerprint`) against
 * a digest computed now, from the bytes actually on disk
 * (`contentFingerprint`). Nothing else moves the verdict — not file dates,
 * not branch state, not an opinion about the text.
 *
 * Model output has no path into these comparisons. Neither side of the
 * equality is ever model text: one side is a sha-256 hex digest written by
 * the run that published the file, the other is computed here from raw
 * bytes. A model cannot phrase its way to `canonical`.
 *
 * A verdict is advisory input to a later policy task, never an instruction.
 * This module never decides to overwrite or preserve anything; it names one
 * of four facts about the target and stops:
 *
 * - `canonical` — the target on disk is exactly what harmonise published:
 *   the computed digest equals the recorded one. Exact equality is the only
 *   way to reach this verdict.
 * - `target-drift` — it is not: the target was modified outside harmonise,
 *   by a maintainer or another tool. The verdict carries no judgment about
 *   why; detecting is all this module does.
 * - `unrecorded` — no recorded state for the pair: nothing was published
 *   through the state model, so there is nothing to compare against. An
 *   absent record is a provable fact, decided without inspecting the
 *   current input.
 * - `unknown` — the recorded state or the current input is malformed, or
 *   missing a required fingerprint field. Refusing to guess is the
 *   fail-closed rule: anything not provably `canonical` is not `canonical`.
 *
 * The recorded `policyFingerprint` and `sourceFingerprint` are deliberately
 * not consulted: a policy or source change means the translation is stale —
 * a different question, owned by a different module. This module answers
 * one question only: are the published bytes still the bytes on disk?
 *
 * Both inputs are untrusted data. The record is validated against the fields
 * this comparison consumes — `schemaVersion` must equal
 * `{@link STATE_SCHEMA_VERSION}` and `translationFingerprint` must be a
 * sha-256 hex digest, the exact shape `contentFingerprint` emits — and the
 * current target must be a string. A record wearing a foreign schema version
 * is refused rather than interpreted, exactly as `parseState` refuses it.
 *
 * This module is pure: it imports the state schema and the fingerprint
 * function read-only, reads no files, and wires into nothing. A later change
 * decides where detection runs and what a verdict is allowed to cause.
 *
 * @module harmonise/src/drift
 */

import { utf8Compare } from "#core/order.mjs";
import { contentFingerprint } from "./fingerprint.mjs";
import { STATE_SCHEMA_VERSION } from "./state.mjs";

/**
 * The four drift verdicts. Exactly one is returned for every call.
 *
 * @typedef {"canonical" | "target-drift" | "unrecorded" | "unknown"} DriftVerdict
 */

/**
 * A sha-256 hex digest as `contentFingerprint` writes it: 64 lowercase hex
 * characters. Anything else — empty, truncated, uppercase — is not a
 * fingerprint this module can compare, and a malformed digest must read as
 * `unknown` rather than as a mismatch it cannot prove.
 *
 * @type {RegExp}
 */
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Detects runtime-canonical drift for one destination pair: whether the
 * target file's current bytes are still the bytes harmonise published.
 *
 * Verdict precedence, each step only reached when the previous one passed:
 *
 * 1. `recorded` is `null` or `undefined` → `unrecorded`. Absence of a
 *    record is provable regardless of the current input, so it is decided
 *    first and the current input is not inspected.
 * 2. the record is not a plain object, carries a `schemaVersion` that is
 *    not a number or not `STATE_SCHEMA_VERSION`, or carries a
 *    `translationFingerprint` that is not a sha-256 hex digest → `unknown`.
 * 3. `currentTarget` is not a string → `unknown`. (The empty string is
 *    valid content: an emptied file is a real drift, not a refusal.)
 * 4. otherwise, `contentFingerprint(currentTarget)` equals the recorded
 *    `translationFingerprint` → `canonical`, else `target-drift`.
 *
 * @param {unknown} recorded
 *   the pair's sync-state record from `parseState(...).records`, or absent
 *   (`null`/`undefined`) when nothing was ever published for the pair;
 *   lookup is the caller's job. Untrusted: validated here, never assumed.
 * @param {unknown} currentTarget
 *   the target file's current UTF-8 text as read from the repository
 * @returns {DriftVerdict} exactly one verdict; never throws
 */
export function detectDrift(recorded, currentTarget) {
  if (recorded === null || recorded === undefined) {
    return "unrecorded";
  }

  if (typeof recorded !== "object" || Array.isArray(recorded)) {
    return "unknown";
  }
  const rec = /** @type {Record<string, unknown>} */ (recorded);
  const recordedDigest = rec["translationFingerprint"];

  if (typeof rec["schemaVersion"] !== "number") {
    return "unknown";
  }
  if (rec["schemaVersion"] !== STATE_SCHEMA_VERSION) {
    return "unknown";
  }
  if (typeof recordedDigest !== "string" || !FINGERPRINT_PATTERN.test(recordedDigest)) {
    return "unknown";
  }

  if (typeof currentTarget !== "string") {
    return "unknown";
  }

  return contentFingerprint(currentTarget) === recordedDigest ? "canonical" : "target-drift";
}

/**
 * One pair's verdict, as `applyDrift` consumes it. `pair` is the caller's
 * stable identifier for the destination — typically the record's
 * `destinationPath`.
 *
 * @typedef {object} DriftVerdictItem
 * @property {string} pair non-empty identity of the destination pair
 * @property {DriftVerdict} verdict the verdict `detectDrift` returned
 */

/**
 * The deterministic summary `applyDrift` renders: a count and a pair list
 * per verdict. Every key is present even when empty, and the pair lists are
 * sorted byte-wise over UTF-8 — the same order `state.mjs` sorts records by,
 * so the summary renders identically regardless of detection order.
 *
 * @typedef {object} DriftSummary
 * @property {{ canonical: number, "target-drift": number, unrecorded: number, unknown: number }} counts
 * @property {{ canonical: string[], "target-drift": string[], unrecorded: string[], unknown: string[] }} pairs
 */

/**
 * @type {readonly DriftVerdict[]}
 */
const VERDICTS = Object.freeze(["canonical", "target-drift", "unrecorded", "unknown"]);

/**
 * Byte-wise comparator over the UTF-8 encoding of two strings, matching the
 * record order `state.mjs` renders. It delegates to the one definition in
 * `core/src/order.mjs`: `review` needed the same collation, and with a second
 * action calling for it the comparator is promoted into `core/` — the
 * remediation the boundary law names — where this was a deliberate local copy.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byUtf8Bytes(a, b) {
  return utf8Compare(a, b);
}

/**
 * Folds per-pair verdicts into a small deterministic summary for a later
 * reporting task: counts per verdict and the pair lists behind them.
 *
 * The input is untrusted: an item that is not a plain object, a missing or
 * non-string or empty `pair`, a pair named twice, or a verdict outside the
 * four declared values throws `TypeError`. Verdicts only ever come from
 * `detectDrift`, so anything else arriving here is a caller bug — and a
 * summary that invents a bucket for it would quietly report nonsense. The
 * input array is never mutated.
 *
 * @param {unknown} verdicts an array of per-pair verdicts; valid items are shaped like {@link DriftVerdictItem}, and every item is validated
 * @returns {DriftSummary}
 */
export function applyDrift(verdicts) {
  if (!Array.isArray(verdicts)) {
    throw new TypeError("applyDrift expects an array of verdict items");
  }
  const items = /** @type {readonly unknown[]} */ (verdicts);
  /** @type {DriftSummary["counts"]} */
  const counts = { canonical: 0, "target-drift": 0, unrecorded: 0, unknown: 0 };
  /** @type {DriftSummary["pairs"]} */
  const pairs = { canonical: [], "target-drift": [], unrecorded: [], unknown: [] };

  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TypeError("each verdict item must be an object");
    }
    const rec = /** @type {Record<string, unknown>} */ (item);
    const pair = rec["pair"];
    const verdict = rec["verdict"];
    if (typeof pair !== "string" || pair === "") {
      throw new TypeError("each verdict item needs a non-empty string 'pair'");
    }
    if (typeof verdict !== "string" || !VERDICTS.includes(/** @type {DriftVerdict} */ (verdict))) {
      throw new TypeError(`unknown verdict for pair '${pair}'`);
    }
    if (seen.has(pair)) {
      throw new TypeError(`duplicate pair '${pair}'`);
    }
    seen.add(pair);

    const known = /** @type {DriftVerdict} */ (verdict);
    counts[known] += 1;
    pairs[known].push(pair);
  }

  for (const verdict of VERDICTS) {
    pairs[verdict].sort(byUtf8Bytes);
  }

  return { counts, pairs };
}

/**
 * The cross-revision finding fingerprint — the identity a finding keeps
 * between runs of a pull request (ADR 004). Deliberately distinct from
 * `answer.mjs`'s `findingIdentity`, which collapses duplicates inside one
 * answer and is line- and wording-sensitive by design; the two authorities
 * share no name and no purpose. This module's identity is:
 *
 * - position-independent — the anchor line may move, the claim keeps its
 *   identity;
 * - wording-independent — the message is never an input;
 * - grade-independent — a concern re-graded to a nit is the same finding;
 * - span- and kind-keyed — a rewritten span, a reclassified claim or a new
 *   file mints a new identity;
 * - content-addressed — sha256 over a versioned tuple, spelled by
 *   `contentDigest`, so the fingerprint stored in an artifact is
 *   recomputable by whoever holds the reviewed bytes.
 *
 * The tuple never carries an occurrence rank: churn among claims that share
 * a span must not shift one finding's identity onto another. Claims that
 * share the full key inside one run collapse at the canonical layer
 * (`canonical.mjs`), never here.
 */

import { contentDigest } from "./digest.mjs";

/** The most characters one subject keeps; the cut is marked, not silent. */
export const FINGERPRINT_SUBJECT_CHARS = 200;

/** The marker a cut subject carries — the verifier's excerpt spelling. */
const SUBJECT_CUT = "…[truncated]";

/** The tuple version — bumping it mints fresh identities for every finding. */
const FINGERPRINT_VERSION = "v1";

/**
 * Normalises a repository-relative path the way the fingerprint spells it:
 * backslashes become slashes and `./` segments disappear. `..` segments are
 * kept — a path that escapes is a validation failure elsewhere, never a
 * normalisation this module performs silently.
 *
 * @param {string} file
 * @returns {string}
 */
export function normalisePath(file) {
  return file.replaceAll("\\", "/").replaceAll(/(^|\/)\.\//g, "$1");
}

/**
 * Normalises the code span a finding anchors: line endings fold to `\n`,
 * whitespace runs collapse to one space, the edges trim, and a span longer
 * than `FINGERPRINT_SUBJECT_CHARS` keeps its head with a marked cut — the
 * same marking posture the verifier's excerpt takes.
 *
 * @param {string} subject
 * @returns {string}
 */
export function normaliseSubject(subject) {
  const collapsed = subject.replaceAll(/\r\n?/g, "\n").replaceAll(/\s+/g, " ").trim();
  return collapsed.length > FINGERPRINT_SUBJECT_CHARS
    ? collapsed.slice(0, FINGERPRINT_SUBJECT_CHARS) + SUBJECT_CUT
    : collapsed;
}

/**
 * The finding's cross-revision fingerprint: the versioned digest over the
 * normalised path, the claim kind and the normalised code span. The caller
 * passes the span exactly as the reviewed bytes carry it — normalisation is
 * this function's job, never the caller's guess.
 *
 * @param {{
 *   file: string,
 *   kind: import("./vocabulary.mjs").FindingKind,
 *   subject: string,
 * }} finding
 * @returns {string} 64 lowercase hex characters
 */
export function findingFingerprint({ file, kind, subject }) {
  return contentDigest(
    [FINGERPRINT_VERSION, normalisePath(file), kind, normaliseSubject(subject)].join("\u0000"),
  );
}

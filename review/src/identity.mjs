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
 *   file mints a new identity; the span is hashed in FULL — the versioned
 *   tuple never truncates, so two claims cannot share an identity for
 *   sharing a prefix, and any cap is a display choice, never an input here;
 * - content-addressed — sha256 over a versioned tuple, spelled by
 *   `contentDigest`, so the fingerprint stored in an artifact is
 *   recomputable by whoever holds the reviewed bytes.
 *
 * The tuple never carries an occurrence rank: churn among claims that share
 * a span must not shift one finding's identity onto another. Claims that
 * share the full key inside one run collapse at the canonical layer
 * (`canonical.mjs`), never here.
 *
 * The retired v1 spelling — the digest over a 200-character, marked cut of
 * the span — survives only as `findingFingerprintV1`, so a stored record
 * verifies its fingerprints under the scheme the record's own version
 * spells (the one documented churn at the migration); nothing fresh mints
 * it. Bumping the tuple version mints fresh identities for every finding
 * exactly once.
 */

import { contentDigest } from "./digest.mjs";

/** The characters a v1 subject kept; the cut was marked, not silent. */
const FINGERPRINT_SUBJECT_CHARS_V1 = 200;

/** The marker a cut v1 subject carries — the verifier's excerpt spelling. */
const SUBJECT_CUT = "…[truncated]";

/** The retired tuple version — stored v1 records verify under it, nothing mints it. */
const FINGERPRINT_VERSION_V1 = "v1";

/** The tuple version — the full span is the identity; bumping it mints fresh identities for every finding. */
const FINGERPRINT_VERSION = "v2";

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
 * whitespace runs collapse to one space, the edges trim. That is the whole
 * job — the FULL normalised span feeds the identity, with no cap: a span is
 * never truncated for hashing, so two claims cannot collide for sharing a
 * prefix.
 *
 * @param {string} subject
 * @returns {string}
 */
export function normaliseSubject(subject) {
  return subject.replaceAll(/\r\n?/g, "\n").replaceAll(/\s+/g, " ").trim();
}

/**
 * The finding's cross-revision fingerprint: the versioned digest over the
 * normalised path, the claim kind and the FULL normalised code span — the
 * finding's whole extent, no cut. The caller passes the span exactly as the
 * reviewed bytes carry it — normalisation is this function's job, never the
 * caller's guess.
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

/**
 * The RETIRED v1 spelling — the digest over a 200-character, marked cut of
 * the span. Kept solely so a stored record's fingerprint verifies under the
 * scheme the record's own version spells; nothing fresh mints it, and the
 * canonical constructor is the only caller.
 *
 * @param {{
 *   file: string,
 *   kind: import("./vocabulary.mjs").FindingKind,
 *   subject: string,
 * }} finding
 * @returns {string} 64 lowercase hex characters
 */
export function findingFingerprintV1({ file, kind, subject }) {
  const collapsed = subject.replaceAll(/\r\n?/g, "\n").replaceAll(/\s+/g, " ").trim();
  const kept =
    collapsed.length > FINGERPRINT_SUBJECT_CHARS_V1
      ? collapsed.slice(0, FINGERPRINT_SUBJECT_CHARS_V1) + SUBJECT_CUT
      : collapsed;
  return contentDigest([FINGERPRINT_VERSION_V1, normalisePath(file), kind, kept].join("\u0000"));
}

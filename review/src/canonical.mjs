/**
 * The canonical review result — the one source of truth a review projects
 * from (ADR 004). The comment, the SARIF upload and the merge gate are
 * projections; none of them records state this shape does not carry, and
 * none of them is authoritative. The constructor is the only way in: it
 * validates the closed vocabularies, recomputes every fingerprint from the
 * tuple it is given, collapses claims that share the full identity key, and
 * deep-freezes what it returns. The tuple's provenance — the subject
 * captured from the reviewed snapshot, never written by the model — is
 * enforced by the integration boundary that reads the snapshot; this
 * constructor never touches the filesystem. A stored fingerprint is
 * verified against the recomputed tuple, nothing more.
 */

import { SEVERITIES } from "./answer.mjs";
import { isDigest } from "./digest.mjs";
import { findingFingerprint, normalisePath, normaliseSubject } from "./identity.mjs";
import { FINDING_KINDS, PUBLISHED_LIFECYCLE_STATES, VERDICTS } from "./vocabulary.mjs";
import { LIFECYCLE_OF_VERDICT } from "./verify.mjs";

/** The terminal states a run record may end in — the run contract's vocabulary. */
export const RUN_STATES = /** @type {const} */ ([
  "published",
  "partial",
  "refused",
  "abandoned",
  "skip",
  "failed",
]);

/** The verdict a run carries. `unknown` and `fail` never pass — a hollow or incomplete review is no pass, not a degraded pass. */
export const RUN_VERDICTS = /** @type {const} */ (["pass", "fail", "unknown"]);

/** The upsert outcomes a publication fact may carry — the real comment write's result. */
export const PUBLICATION_OUTCOMES = /** @type {const} */ (["created", "updated", "abandoned"]);

/** The canonical result's schema version. */
export const CANONICAL_VERSION = 1;

/** A canonical result that does not check out — vocabulary, shape or fingerprint. */
export class CanonicalResultError extends Error {}

/**
 * @typedef {object} CanonicalFinding
 * @property {import("./vocabulary.mjs").FindingKind} kind the claim's domain — the identity key's epistemic arm: verification-bound, code-validated, an identity input
 * @property {string} fingerprint the cross-revision identity, recomputed and checked by the constructor
 * @property {string} file the repository-relative path, normalised — an identity input
 * @property {number} line the 1-based anchor line in the reviewed snapshot — never an identity input
 * @property {"concern" | "nit"} severity the finding's grade — never an identity input
 * @property {string} message the claim as answered — a rendering input, never an identity input
 * @property {string} subject the normalised code span the claim anchors — given, never captured here; its provenance (read from the reviewed snapshot by the integration boundary, never model-written) is enforced upstream of this module
 * @property {import("./verify.mjs").PublishedLifecycle} lifecycle the publication state
 * @property {import("./verify.mjs").Verdict} [verdict] the verifier's raw verdict, when verified
 * @property {string} [reason] the capped verdict reason, when verified
 * @property {{ digest: string, excerpt: string }} [evidence] the bound verdict's retained evidence window
 * @property {import("./vocabulary.mjs").Reconciliation} [reconciliation] set by reconcile.mjs over artifacts — never by a run
 */

/**
 * One claim dropped because a finding earlier in publication order already
 * carries its identity key. Recorded, never silent; rendered nowhere.
 *
 * @typedef {object} CollapsedClaim
 * @property {string} fingerprint the identity the kept finding carries
 * @property {string} message the dropped claim's message — the audit trail of what did not survive
 */

/**
 * @typedef {object} CanonicalResult
 * @property {typeof CANONICAL_VERSION} version
 * @property {string} head the reviewed commit's sha — the subject pinned beside the record
 * @property {{ state: typeof RUN_STATES[number], verdict: typeof RUN_VERDICTS[number], publication?: typeof PUBLICATION_OUTCOMES[number] }} run the run's terminal facts — `publication` carries the real comment write's outcome when the run knows it, and is absent on records that predate the fact (and on every canonical a run builds before its write lands)
 * @property {readonly CanonicalFinding[]} findings publication order preserved
 * @property {readonly CollapsedClaim[]} collapsed claims that shared a kept finding's identity key, in publication order
 * @property {import("./coverage.mjs").CoverageReport} [coverage] the read-coverage report, when the run carried one
 */

/**
 * @param {unknown} value
 * @param {readonly string[]} vocabulary
 * @param {string} label
 * @returns {string}
 */
function inVocabulary(value, vocabulary, label) {
  if (typeof value !== "string" || !vocabulary.includes(value)) {
    throw new CanonicalResultError(
      `${label} must be one of ${vocabulary.join(", ")} — got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CanonicalResultError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Builds the one canonical result from a run's verified publication set.
 * Pure aside from nothing: the same input always yields the same frozen
 * result, so replaying an artifact's facts rebuilds it byte for byte.
 *
 * @param {{
 *   head: string,
 *   run: { state: string, verdict: string, publication?: string },
 *   findings: Array<{
 *     kind: string,
 *     file: string,
 *     line: number,
 *     severity: string,
 *     message: string,
 *     subject: string,
 *     lifecycle: string,
 *     fingerprint?: string,
 *     verdict?: string,
 *     reason?: string,
 *     evidence?: { digest: string, excerpt: string },
 *   }>,
 *   coverage?: import("./coverage.mjs").CoverageReport,
 * }} input
 * @returns {CanonicalResult}
 */
export function createCanonicalResult({ head, run, findings, coverage }) {
  if (typeof head !== "string" || !/^[0-9a-f]{7,40}$/.test(head)) {
    throw new CanonicalResultError(`head must be a git sha — got ${JSON.stringify(head)}`);
  }
  if (run === null || typeof run !== "object") {
    throw new CanonicalResultError("run must carry the run's terminal facts");
  }
  const state = inVocabulary(run.state, RUN_STATES, "run.state");
  const verdict = inVocabulary(run.verdict, RUN_VERDICTS, "run.verdict");
  // Additive since the fact's introduction (the version stays 1): a record
  // without one is the v1 shape, and its absence is the default.
  const publication =
    run.publication === undefined
      ? undefined
      : /** @type {typeof PUBLICATION_OUTCOMES[number]} */ (
          inVocabulary(run.publication, PUBLICATION_OUTCOMES, "run.publication")
        );

  /** @type {Map<string, CanonicalFinding>} */
  const kept = new Map();
  /** @type {CanonicalFinding[]} */
  const canonicalFindings = [];
  /** @type {CollapsedClaim[]} */
  const collapsed = [];

  findings.forEach((finding, index) => {
    const label = `findings[${index}]`;
    const kind = /** @type {import("./vocabulary.mjs").FindingKind} */ (
      inVocabulary(finding.kind, FINDING_KINDS, `${label}.kind`)
    );
    const severity = /** @type {import("./answer.mjs").Finding["severity"]} */ (
      inVocabulary(finding.severity, SEVERITIES, `${label}.severity`)
    );
    const lifecycle = /** @type {import("./verify.mjs").PublishedLifecycle} */ (
      inVocabulary(finding.lifecycle, PUBLISHED_LIFECYCLE_STATES, `${label}.lifecycle`)
    );
    const file = normalisePath(requireString(finding.file, `${label}.file`));
    const subject = normaliseSubject(requireString(finding.subject, `${label}.subject`));
    const message = requireString(finding.message, `${label}.message`);
    if (!Number.isInteger(finding.line) || finding.line < 1) {
      throw new CanonicalResultError(`${label}.line must be a 1-based integer`);
    }
    if (finding.verdict !== undefined) {
      const verdict = /** @type {import("./verify.mjs").Verdict} */ (
        inVocabulary(finding.verdict, VERDICTS, `${label}.verdict`)
      );
      const publishesAs = LIFECYCLE_OF_VERDICT[verdict];
      if (publishesAs !== lifecycle) {
        throw new CanonicalResultError(
          `${label}: verdict ${verdict} publishes as ${publishesAs}, not ${lifecycle}`,
        );
      }
    }
    if (finding.evidence !== undefined && !isDigest(finding.evidence.digest)) {
      throw new CanonicalResultError(`${label}.evidence.digest must be a content digest`);
    }
    const fingerprint = findingFingerprint({ file, kind, subject });
    if (finding.fingerprint !== undefined && finding.fingerprint !== fingerprint) {
      throw new CanonicalResultError(
        `${label}: stored fingerprint does not match the tuple this result recomputes`,
      );
    }
    /** @type {CanonicalFinding} */
    const canonical = Object.freeze({
      kind,
      fingerprint,
      file,
      line: finding.line,
      severity,
      message,
      subject,
      lifecycle,
      ...(finding.verdict !== undefined
        ? { verdict: /** @type {import("./verify.mjs").Verdict} */ (finding.verdict) }
        : {}),
      ...(finding.reason !== undefined ? { reason: finding.reason } : {}),
      ...(finding.evidence !== undefined
        ? {
            evidence: Object.freeze({
              digest: finding.evidence.digest,
              excerpt: finding.evidence.excerpt,
            }),
          }
        : {}),
    });
    const earlier = kept.get(fingerprint);
    if (earlier !== undefined) {
      collapsed.push(Object.freeze({ fingerprint, message }));
      return;
    }
    kept.set(fingerprint, canonical);
    canonicalFindings.push(canonical);
  });

  return Object.freeze({
    version: CANONICAL_VERSION,
    head,
    run: Object.freeze({
      state: /** @type {typeof RUN_STATES[number]} */ (state),
      verdict: /** @type {typeof RUN_VERDICTS[number]} */ (verdict),
      ...(publication !== undefined ? { publication } : {}),
    }),
    findings: Object.freeze(canonicalFindings),
    collapsed: Object.freeze(collapsed),
    ...(coverage !== undefined
      ? {
          coverage: /** @type {import("./coverage.mjs").CoverageReport} */ (
            Object.freeze({
              covered: Object.freeze([...coverage.covered]),
              uncovered: Object.freeze([...coverage.uncovered]),
              total: coverage.total,
            })
          ),
        }
      : {}),
  });
}

/**
 * Attaches the real publication outcome to a built canonical result — the
 * one fact a run learns only after the record exists, when the comment
 * write returns. Pure: the same record and outcome yield the same frozen
 * result, reusing the findings, collapsed claims and coverage by reference;
 * nothing is recomputed. The fact stays independent of the verdict by law —
 * publication success is not the review's verdict — and the merge gate
 * never reads it.
 *
 * @param {CanonicalResult} canonical
 * @param {string} publication the upsert's outcome — "created", "updated" or "abandoned"
 * @returns {CanonicalResult}
 */
export function withRunPublication(canonical, publication) {
  const outcome = /** @type {typeof PUBLICATION_OUTCOMES[number]} */ (
    inVocabulary(publication, PUBLICATION_OUTCOMES, "run.publication")
  );
  return Object.freeze({
    ...canonical,
    run: Object.freeze({ ...canonical.run, publication: outcome }),
  });
}

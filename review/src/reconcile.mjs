/**
 * The cross-run reconciliation — the label a finding carries between two
 * canonical results of one pull request (ADR 004 decision 3, the run
 * contract's "The canonical review result"). The model never decides it:
 * every label is computed from the findings' identity alone, never from
 * their wording, grade, verification outcome or lifecycle.
 *
 * Identity is the finding's `fingerprint` (`identity.mjs`): position-,
 * wording- and grade-independent, span- and kind-keyed. Matching is by
 * fingerprint alone. That makes the one asymmetric case deliberate: a
 * cross-FILE move rewrites the identity key's path arm, so it mints a fresh
 * fingerprint and publishes as `resolved` + `new` — never `moved`. Only a
 * same-key line drift is a move.
 *
 * The labels (`vocabulary.mjs` `RECONCILIATIONS`):
 * - fingerprint in both runs, identical line — `persisting` on both sides;
 * - fingerprint in both runs, differing line — `moved` on both sides;
 * - fingerprint only in the current run — `new` on the current finding;
 * - fingerprint only in the previous run — `resolved` on the previous finding.
 *
 * Two run-state rules bound the labels:
 * - an incomplete current run (`current.run.state` not `published`) may
 *   still be writing, so it never retires a previous finding: `resolved` is
 *   suppressed and those previous findings are left without a label. The
 *   current findings keep theirs — `new`, `persisting` or `moved` — they
 *   were observed. A fingerprint match still labels both sides, since the
 *   match rules carry no run-state qualifier.
 * - a previous run that never published cleanly (`abandoned`, `refused`,
 *   `skip`, `failed`) counts as empty: no identity map, every current
 *   finding is `new`, and the previous side of the result is empty.
 *
 * Pure and deterministic: the same pair of results always yields the same
 * labels, the inputs are never mutated, and what comes back is fresh
 * frozen objects — no timestamps, no aliasing into either input.
 */

/**
 * A canonical finding carrying its cross-run label. `reconciliation` is
 * present exactly when this reconciliation could decide one — an incomplete
 * current run leaves an unmatched previous finding without it.
 *
 * @typedef {Omit<import("./canonical.mjs").CanonicalFinding, "reconciliation"> & {
 *   reconciliation?: import("./vocabulary.mjs").Reconciliation,
 * }} ReconciledFinding
 */

/**
 * @param {import("./canonical.mjs").CanonicalFinding} finding
 * @param {import("./vocabulary.mjs").Reconciliation} reconciliation
 * @returns {ReconciledFinding}
 */
const labelled = (finding, reconciliation) => Object.freeze({ ...finding, reconciliation });

/**
 * @param {import("./canonical.mjs").CanonicalFinding} finding
 * @returns {ReconciledFinding}
 */
const unlabelled = (finding) => Object.freeze({ ...finding });

/**
 * Reconciles two canonical results of one pull request. `previous` may be
 * missing entirely — a first run reconciles against nothing — and a
 * previous result whose run state is not `published` counts as empty.
 *
 * @param {{
 *   previous?: import("./canonical.mjs").CanonicalResult | null,
 *   current: import("./canonical.mjs").CanonicalResult,
 * }} input
 * @returns {{ current: readonly ReconciledFinding[], previous: readonly ReconciledFinding[] }}
 */
export function reconcile({ previous, current }) {
  const priorRun = previous ?? null;

  /** @type {Map<string, import("./canonical.mjs").CanonicalFinding>} */
  const identity = new Map();
  if (priorRun !== null && priorRun.run.state === "published") {
    for (const finding of priorRun.findings) {
      // Canonical results collapse same-key claims, so the key is unique
      // already; first-wins keeps the map honest even if that ever changes.
      if (!identity.has(finding.fingerprint)) identity.set(finding.fingerprint, finding);
    }
  }

  /** @type {Map<string, import("./canonical.mjs").CanonicalFinding>} */
  const matched = new Map();
  const currentSide = current.findings.map((finding) => {
    const prior = identity.get(finding.fingerprint);
    if (prior === undefined) return labelled(finding, "new");
    matched.set(finding.fingerprint, finding);
    return labelled(finding, prior.line === finding.line ? "persisting" : "moved");
  });

  const previousSide =
    priorRun !== null && priorRun.run.state === "published"
      ? priorRun.findings.map((finding) => {
          const observed = matched.get(finding.fingerprint);
          if (observed === undefined) {
            // An incomplete current run may still be writing — it never
            // retires a previous finding; the label is left unset.
            return current.run.state === "published"
              ? labelled(finding, "resolved")
              : unlabelled(finding);
          }
          return labelled(finding, observed.line === finding.line ? "persisting" : "moved");
        })
      : [];

  return Object.freeze({
    current: Object.freeze(currentSide),
    previous: Object.freeze(previousSide),
  });
}

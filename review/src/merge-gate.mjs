/**
 * The merge gate — ADR 004 decision 4's fail-closed decision over a canonical
 * result. The model never decides this: the gate is a pure function of the
 * recorded facts, and every arm it blocks on is a defect the record already
 * carries. A merged review is one that published, answered, read what the
 * diff touched, and left no confirmed or unresolved finding standing.
 */

import { FINDING_KINDS } from "./vocabulary.mjs";

/**
 * A merge-gate policy. `blockKinds` names the finding kinds a confirmed
 * finding blocks on — a subset of the closed vocabulary; naming an arm the
 * vocabulary does not carry is a policy defect and fails loud, never a
 * silent narrowing. `blockUnresolved` false lets a finding the verifier
 * could not decide through; the default is a hollow pass is a defect.
 *
 * @typedef {object} ReviewGatePolicy
 * @property {readonly import("./vocabulary.mjs").FindingKind[]} [blockKinds] the confirmed kinds that block — default: every kind
 * @property {boolean} [blockUnresolved] whether an `unresolved` finding blocks — default: true
 */

/**
 * The gate's decision. `BLOCK` is fail-closed: one arm is enough, and every
 * arm that fired is named in `reasons`, in a deterministic order.
 *
 * @typedef {object} ReviewGateDecision
 * @property {"PASS" | "BLOCK"} verdict the merge decision
 * @property {string[]} reasons why the gate blocked — empty exactly when it passes
 */

/** A merge-gate policy that names a finding kind outside the closed vocabulary. */
export class GatePolicyError extends Error {}

/**
 * The pure merge decision over one canonical result. No I/O, no model, no
 * clock: the same input always yields a deep-equal decision. The fail-closed
 * arms, each adding one reason, in the order they are tested:
 *
 * 1. the run did not publish;
 * 2. the run's verdict is `unknown` — an unanswered review is no pass;
 * 3. the run's verdict is `fail` — an incomplete review is no pass;
 * 4. the run carried a coverage report and left changed files unread;
 * 5. a `confirmed` finding whose kind the policy blocks on;
 * 6. an `unresolved` finding, when the policy blocks them.
 *
 * A `refuted` finding never blocks. Finding reasons follow the findings'
 * publication order; structural reasons precede them.
 *
 * @param {import("./canonical.mjs").CanonicalResult} result the run's canonical record
 * @param {ReviewGatePolicy} [policy] the merge policy — the all-blocking default when omitted
 * @returns {ReviewGateDecision}
 */
export function decideReviewGate(result, policy = {}) {
  const blockKinds = policy.blockKinds ?? FINDING_KINDS;
  const blockUnresolved = policy.blockUnresolved ?? true;
  for (const kind of blockKinds) {
    if (!FINDING_KINDS.includes(kind)) {
      throw new GatePolicyError(`merge gate policy: '${kind}' is not a finding kind`);
    }
  }

  /** @type {string[]} */
  const reasons = [];
  if (result.run.state !== "published") {
    reasons.push(
      `run state '${result.run.state}' is not 'published' — the review never concluded.`,
    );
  }
  if (result.run.verdict === "unknown") {
    reasons.push("run verdict 'unknown' never passes — a hollow verdict is a defect.");
  }
  if (result.run.verdict === "fail") {
    reasons.push("run verdict 'fail' never passes — an incomplete review is no pass.");
  }
  if (result.coverage !== undefined && result.coverage.uncovered.length > 0) {
    const { uncovered, total } = result.coverage;
    const files = total === 1 ? "file was" : "files were";
    reasons.push(
      `${uncovered.length} of ${total} changed ${files} never read: ${uncovered.join(", ")}.`,
    );
  }
  for (const finding of result.findings) {
    if (finding.lifecycle === "confirmed") {
      if (blockKinds.includes(finding.kind)) {
        reasons.push(`confirmed ${finding.kind} finding at ${finding.file}:${finding.line}.`);
      }
    } else if (finding.lifecycle === "unresolved" && blockUnresolved) {
      reasons.push(`unresolved ${finding.kind} finding at ${finding.file}:${finding.line}.`);
    }
  }

  return { verdict: reasons.length === 0 ? "PASS" : "BLOCK", reasons };
}

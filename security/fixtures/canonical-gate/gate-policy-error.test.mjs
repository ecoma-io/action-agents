// Gate policy error — the merge gate fails loud, and enforcement never
// rides on the model's word or the action's exit code.
//
// Two properties of the gate are security-relevant enough to pin:
//
// 1. A policy that names a finding kind outside the closed vocabulary is a
//    defect in the code that owns the policy, and `decideReviewGate`
//    throws rather than silently narrowing — a typo that dropped a kind
//    from `blockKinds` would otherwise widen what merges, and a widening
//    that never announces itself is a hole. Fail closed, fail loud.
// 2. The action's own exit never enforces the gate: a BLOCK under
//    `gate-mode: observe` renders a `neutral` check run and the run stays
//    green — the verdict is recorded, not enforced. Enforcement is the
//    check run a ruleset can make required, a deterministic contract
//    output rendered by code (`renderGateCheckRun`), never a consequence
//    the model composes or asks for.
//
// Deterministic and offline: pure functions, no filesystem, no network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCanonicalResult } from "../../../review/src/canonical.mjs";
import { renderGateCheckRun } from "../../../review/src/index.mjs";
import { decideReviewGate, GatePolicyError } from "../../../review/src/merge-gate.mjs";

const HEAD = "a".repeat(40);

/** A published record carrying one confirmed finding — the gate's food. */
function canonicalWithConfirmedFinding() {
  return createCanonicalResult({
    head: HEAD,
    run: { state: "published", verdict: "pass" },
    findings: [
      {
        kind: "correctness",
        file: "src/a.mjs",
        line: 2,
        severity: "concern",
        message: "off-by-one",
        subject: "line2",
        lifecycle: "confirmed",
        reason: "the verification confirmed it",
        evidence: { digest: "d".repeat(64), excerpt: "line2" },
      },
    ],
    coverage: { covered: ["src/a.mjs"], uncovered: [], total: 1 },
  });
}

describe("the merge gate fails loud on a policy defect and never enforces by exit code", () => {
  it("a blockKinds entry outside the closed vocabulary throws, never narrows silently", () => {
    assert.throws(
      () => decideReviewGate(canonicalWithConfirmedFinding(), { blockKinds: ["naming"] }),
      (error) => {
        assert.ok(error instanceof GatePolicyError);
        assert.match(/** @type {Error} */ (error).message, /'naming' is not a finding kind/);
        return true;
      },
    );
  });

  it("a confirmed finding blocks under the all-kinds default policy", () => {
    const gate = decideReviewGate(canonicalWithConfirmedFinding(), {});
    assert.equal(gate.verdict, "BLOCK");
    assert.deepEqual(gate.reasons, ["confirmed correctness finding at src/a.mjs:2."]);
  });

  it("observe records the BLOCK and enforces nothing — the exit stays neutral", () => {
    const gate = decideReviewGate(canonicalWithConfirmedFinding(), {});
    const check = renderGateCheckRun({ gate, gateMode: "observe" });
    assert.equal(check.conclusion, "neutral");
    assert.equal(check.name, "review gate");
    assert.equal(check.summary, "confirmed correctness finding at src/a.mjs:2.");
    // And `required` is the only mode whose check run blocks a merge.
    assert.equal(renderGateCheckRun({ gate, gateMode: "required" }).conclusion, "failure");
  });
});

// Tests for the declared run gates: each gate passes and fails on
// constructed facts, malformed facts are refused fail-closed, the declared
// order is stable, and the overall verdict composes from the per-gate
// results. No gate may pass on a missing fact.

import { describe, expect, it } from "vitest";

import { GATES, GateFactsError, evaluateGate, evaluateGates } from "./gates.mjs";

/** @returns {import("./gates.mjs").ConclusionFacts} */
function conclusionFacts() {
  return { held: true };
}

/** @returns {import("./gates.mjs").BoundFacts} */
function boundFacts(over = {}) {
  return {
    bound: undefined,
    readingTurns: 1,
    maxTurns: 5,
    toolCalls: 2,
    maxToolCalls: 200,
    evidenceBytes: 100,
    maxEvidenceBytes: 512 * 2 ** 10,
    ...over,
  };
}

/** @returns {import("./gates.mjs").CoverageFacts} */
function coverageFacts(over = {}) {
  return { report: { covered: [], uncovered: [], total: 0 }, strictness: "medium", ...over };
}

/** @returns {import("./gates.mjs").ProvenanceFacts} */
function provenanceFacts(over = {}) {
  return { published: [], quarantined: [], ledger: [ledgerRead()], ...over };
}

/** @returns {import("./gates.mjs").VerificationFacts} */
function verificationFacts(over = {}) {
  return {
    planned: [],
    outcomes: [],
    skipped: [],
    strategy: "standard",
    strictness: "medium",
    ...over,
  };
}

/**
 * One planned finding's outcome record.
 *
 * @param {string} id
 * @param {import("./gates.mjs").PublishedLifecycle} lifecycle
 * @param {import("./verify.mjs").Verdict} [verdict]
 * @returns {import("./gates.mjs").VerificationOutcome}
 */
function outcome(id, lifecycle, verdict) {
  return verdict === undefined ? { id, lifecycle } : { id, lifecycle, verdict };
}

/** @returns {import("./gates.mjs").RunFacts} */
function runFacts(over = {}) {
  return {
    conclusion: conclusionFacts(),
    bound: boundFacts(),
    coverage: coverageFacts(),
    provenance: provenanceFacts(),
    verification: verificationFacts(),
    ...over,
  };
}

/** A published finding with its anchored read reference. */
function anchored(over = {}) {
  return {
    severity: "concern",
    file: "src/a.mjs",
    line: 2,
    message: "off-by-one",
    provenance: { path: "src/a.mjs", startLine: 1, endLine: 40 },
    ...over,
  };
}

/** The recorded read `anchored()`'s provenance names — ledger data, not the finding's claim. */
function ledgerRead(over = {}) {
  return { path: "src/a.mjs", startLine: 1, endLine: 40, ...over };
}

/** A quarantined finding — the #84 mechanism working as declared. */
function quarantined(over = {}) {
  return {
    finding: { severity: "nit", file: "src/b.mjs", line: 1, message: "style nit" },
    reason: "unanchored",
    ...over,
  };
}

describe("the declared set", () => {
  it("declares the five gates frozen, in the run's precedence order", () => {
    expect(Object.isFrozen(GATES)).toBe(true);
    expect([...GATES]).toEqual(["conclusion", "bound", "coverage", "provenance", "verification"]);
  });

  it("refuses an unknown gate name", () => {
    expect(() => evaluateGate(/** @type {any} */ ("nonexistent"), {})).toThrow(GateFactsError);
    expect(() => evaluateGate(/** @type {any} */ ("nonexistent"), {})).toThrow(
      /the declared set is conclusion, bound, coverage, provenance, verification/,
    );
  });
});

describe("gate conclusion", () => {
  it("passes when the contract held", () => {
    expect(evaluateGate("conclusion", conclusionFacts())).toEqual({
      gate: "conclusion",
      passed: true,
    });
  });

  it("fails with the defect as the reason when the contract did not hold", () => {
    const result = evaluateGate("conclusion", {
      held: false,
      defect: "the answer is not a JSON object",
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("the answer is not a JSON object");
  });

  it("refuses a missing held flag and a refused conclusion without its defect", () => {
    expect(() => evaluateGate("conclusion", {})).toThrow(GateFactsError);
    expect(() => evaluateGate("conclusion", { held: "yes" })).toThrow(GateFactsError);
    expect(() => evaluateGate("conclusion", { held: false })).toThrow(GateFactsError);
    expect(() => evaluateGate("conclusion", { held: false, defect: 7 })).toThrow(GateFactsError);
  });
});

describe("gate bound", () => {
  it("passes when no bound fired and no cap stands reached", () => {
    expect(evaluateGate("bound", boundFacts())).toEqual({ gate: "bound", passed: true });
  });

  it("fails with the bound's sentence when the turn budget fired", () => {
    const result = evaluateGate("bound", boundFacts({ bound: "max-turns", readingTurns: 5 }));
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "the reading-turn budget was reached before the reviewer stopped asking questions.",
    );
  });

  it("fails with the bound's sentence when the tool-call ceiling fired", () => {
    const result = evaluateGate("bound", boundFacts({ bound: "tool-calls", toolCalls: 200 }));
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "the tool-call ceiling was reached before the reviewer stopped reading.",
    );
  });

  it("fails with the bound's sentence when the evidence budget fired", () => {
    const result = evaluateGate(
      "bound",
      boundFacts({ bound: "evidence", evidenceBytes: 512 * 2 ** 10 }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "the evidence budget was reached before the reviewer finished reading.",
    );
  });

  it("fails closed when a bound was recorded but no cap stands reached", () => {
    const result = evaluateGate("bound", boundFacts({ bound: "tool-calls", toolCalls: 2 }));
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "the loop's bound accounting does not close: 'tool-calls' was recorded but no cap stands reached",
    );
  });

  it("fails closed when a cap stands reached but no bound was recorded", () => {
    const result = evaluateGate("bound", boundFacts({ toolCalls: 200 }));
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "the loop's bound accounting does not close: the tool-calls cap stands reached but no bound was recorded",
    );
  });

  it("fails closed when the recorded bound is not the cap the precedence names", () => {
    const result = evaluateGate(
      "bound",
      boundFacts({ bound: "max-turns", evidenceBytes: 512 * 2 ** 10 }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "the loop's bound accounting does not close: 'max-turns' was recorded but the accounting closes at 'evidence'",
    );
  });

  it("refuses malformed accounting: bad counts, zero caps, a misspelled bound", () => {
    expect(() => evaluateGate("bound", {})).toThrow(GateFactsError);
    expect(() => evaluateGate("bound", boundFacts({ toolCalls: 1.5 }))).toThrow(GateFactsError);
    expect(() => evaluateGate("bound", boundFacts({ maxTurns: 0 }))).toThrow(GateFactsError);
    expect(() => evaluateGate("bound", boundFacts({ bound: "walls" }))).toThrow(GateFactsError);
    expect(() => evaluateGate("bound", boundFacts({ bound: null }))).toThrow(GateFactsError);
  });
});

describe("gate coverage", () => {
  it("passes at the standard arm even with every expected file unread", () => {
    const result = evaluateGate(
      "coverage",
      coverageFacts({ report: { covered: [], uncovered: ["src/a.mjs"], total: 1 } }),
    );
    expect(result).toEqual({ gate: "coverage", passed: true });
  });

  it("passes at the strict arm when the expected set is fully read", () => {
    const result = evaluateGate(
      "coverage",
      coverageFacts({
        report: { covered: ["src/a.mjs"], uncovered: [], total: 1 },
        strictness: "high",
      }),
    );
    expect(result).toEqual({ gate: "coverage", passed: true });
  });

  it("fails at the strict arm with the gap sentence the comment leads with", () => {
    const result = evaluateGate(
      "coverage",
      coverageFacts({
        report: { covered: ["src/a.mjs"], uncovered: ["src/b.mjs"], total: 2 },
        strictness: "high",
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("1 of 2 changed files were never read: src/b.mjs.");
  });

  it("keeps the singular sentence for a one-file universe", () => {
    const result = evaluateGate(
      "coverage",
      coverageFacts({
        report: { covered: [], uncovered: ["src/a.mjs"], total: 1 },
        strictness: "high",
      }),
    );
    expect(result.reason).toBe("1 of 1 changed file was never read: src/a.mjs.");
  });

  it("refuses a malformed report or an unknown strictness arm", () => {
    expect(() => evaluateGate("coverage", {})).toThrow(GateFactsError);
    expect(() =>
      evaluateGate("coverage", coverageFacts({ report: { covered: [], total: 0 } })),
    ).toThrow(GateFactsError);
    expect(() => evaluateGate("coverage", coverageFacts({ strictness: "extreme" }))).toThrow(
      GateFactsError,
    );
  });
});

describe("gate provenance", () => {
  it("passes when every published finding's provenance is a recorded read covering its anchor", () => {
    const result = evaluateGate(
      "provenance",
      provenanceFacts({ published: [anchored()], quarantined: [quarantined()] }),
    );
    expect(result).toEqual({ gate: "provenance", passed: true });
  });

  it("accepts a reference spelled differently but normalising to the anchored file", () => {
    const result = evaluateGate(
      "provenance",
      provenanceFacts({
        published: [anchored({ provenance: { path: "./src/a.mjs", startLine: 1, endLine: 40 } })],
        quarantined: [],
      }),
    );
    expect(result).toEqual({ gate: "provenance", passed: true });
  });

  it("fails the tautology regression: a published finding with no ledger-backed anchor", () => {
    // The #105 defect's shape: a set published without any recorded read
    // behind one of its findings. The pre-#105 gate re-checked the
    // attached reference in isolation and could not fail on real input;
    // this gate derives the verdict from the ledger.
    const result = evaluateGate(
      "provenance",
      provenanceFacts({
        published: [
          { severity: "concern", file: "src/z.mjs", line: 2, message: "unanchored claim" },
        ],
        quarantined: [],
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "an unanchored finding remains in the publication set: " +
        "src/z.mjs:2 unanchored claim — no provenance reference a recorded read can back",
    );
  });

  it("fails when the reference names another path after normalisation", () => {
    const result = evaluateGate(
      "provenance",
      provenanceFacts({
        published: [anchored(), anchored({ file: "src/c.mjs", line: 9, message: "off-by-two" })],
        quarantined: [],
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "an unanchored finding remains in the publication set: " +
        "src/c.mjs:9 off-by-two — provenance names src/a.mjs, not the anchored file",
    );
  });

  it("fails when the recorded span does not cover the finding's line", () => {
    const result = evaluateGate(
      "provenance",
      provenanceFacts({
        published: [anchored({ provenance: { path: "src/a.mjs", startLine: 40, endLine: 80 } })],
        quarantined: [],
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("src/a.mjs:2 off-by-one");
    expect(result.reason).toContain("provenance span 40-80 misses the anchor line");
  });

  it("fails when the reference matches no recorded read — a claim the ledger never made", () => {
    const result = evaluateGate(
      "provenance",
      provenanceFacts({
        published: [anchored({ provenance: { path: "src/a.mjs", startLine: 1, endLine: 30 } })],
        quarantined: [],
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("provenance does not match any recorded read");
  });

  it("judges the published list it receives — a finding the strictness drop removed is no longer its business", () => {
    // The anchored set held a nit on src/drop.mjs too; the strictness drop
    // removed it before publication. The gate judges the final set: the
    // dropped finding's provenance is not required, the survivor's is.
    const result = evaluateGate(
      "provenance",
      provenanceFacts({
        published: [anchored()],
        quarantined: [],
        ledger: [ledgerRead(), ledgerRead({ path: "src/drop.mjs" })],
      }),
    );
    expect(result).toEqual({ gate: "provenance", passed: true });
  });

  it("holds refuted and unresolved findings to the same provenance law — they still publish", () => {
    const backed = provenanceFacts({
      published: [
        anchored({
          id: "1",
          lifecycle: "refuted",
          verdict: "refuted",
          reason: "the guard exists at line 5",
        }),
        anchored({
          file: "src/b.mjs",
          line: 3,
          message: "unresolved claim",
          provenance: { path: "src/b.mjs", startLine: 1, endLine: 30 },
          id: "2",
          lifecycle: "unresolved",
          verdict: "uncertain",
          reason: "the evidence ran out",
        }),
      ],
      ledger: [ledgerRead(), ledgerRead({ path: "src/b.mjs", endLine: 30 })],
      quarantined: [],
    });
    expect(evaluateGate("provenance", backed)).toEqual({ gate: "provenance", passed: true });

    const unbacked = provenanceFacts({
      published: [anchored({ provenance: undefined, lifecycle: "refuted", id: "1" })],
      quarantined: [],
    });
    const result = evaluateGate("provenance", unbacked);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("src/a.mjs:2 off-by-one");
  });

  it("refuses malformed findings in either list", () => {
    expect(() => evaluateGate("provenance", { published: [{}], quarantined: [] })).toThrow(
      GateFactsError,
    );
    expect(() =>
      evaluateGate("provenance", {
        published: [],
        quarantined: [{ finding: {}, reason: "unanchored" }],
      }),
    ).toThrow(GateFactsError);
    expect(() =>
      evaluateGate("provenance", { published: [], quarantined: [quarantined({ reason: 3 })] }),
    ).toThrow(GateFactsError);
  });

  it("treats a missing or malformed provenance value as unanchored, not as an error", () => {
    for (const provenance of [undefined, null, "src/a.mjs", { path: 7 }]) {
      const result = evaluateGate(
        "provenance",
        provenanceFacts({ published: [anchored({ provenance })], quarantined: [] }),
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("src/a.mjs:2 off-by-one");
    }
  });

  it("refuses a malformed ledger fail-closed — every entry checked, none coerced", () => {
    expect(() =>
      evaluateGate("provenance", { published: [], quarantined: [], ledger: "nope" }),
    ).toThrow(GateFactsError);
    expect(() => evaluateGate("provenance", provenanceFacts({ ledger: [{}] }))).toThrow(
      GateFactsError,
    );
    expect(() =>
      evaluateGate(
        "provenance",
        provenanceFacts({ ledger: [{ path: "a.mjs", startLine: 5, endLine: 2 }] }),
      ),
    ).toThrow(GateFactsError);
  });

  it("refuses slices whose lists are not arrays or whose entries are not objects", () => {
    expect(() =>
      evaluateGate("provenance", { published: "none", quarantined: [], ledger: [] }),
    ).toThrow(GateFactsError);
    expect(() =>
      evaluateGate("provenance", { published: [], quarantined: ["nit"], ledger: [] }),
    ).toThrow(GateFactsError);
    expect(() =>
      evaluateGate("provenance", { published: [null], quarantined: [], ledger: [] }),
    ).toThrow(GateFactsError);
    expect(() => evaluateGate("provenance", { published: [], quarantined: [] })).toThrow(
      GateFactsError,
    );
  });
});

describe("gate verification", () => {
  /** The three policy modes, each spelled by the facts that derive it. */
  const MODES = [
    { name: "normal", over: {} },
    { name: "strict", over: { strictness: "high" } },
    { name: "adversarial", over: { strategy: "adversarial", strictness: "low" } },
  ];

  it("passes the empty plan trivially under every mode", () => {
    for (const { over } of MODES) {
      expect(evaluateGate("verification", verificationFacts(over))).toEqual({
        gate: "verification",
        passed: true,
      });
    }
  });

  it("passes when every planned finding confirmed, under every mode", () => {
    for (const { over } of MODES) {
      const result = evaluateGate(
        "verification",
        verificationFacts({
          planned: ["1", "2"],
          outcomes: [
            outcome("1", "confirmed", "confirmed"),
            outcome("2", "confirmed", "confirmed"),
          ],
          ...over,
        }),
      );
      expect(result.passed).toBe(true);
    }
  });

  it("passes with a refuted finding — refuted is a verification outcome, under every mode", () => {
    for (const { over } of MODES) {
      const result = evaluateGate(
        "verification",
        verificationFacts({
          planned: ["1", "2"],
          outcomes: [outcome("1", "confirmed", "confirmed"), outcome("2", "refuted", "refuted")],
          ...over,
        }),
      );
      expect(result.passed).toBe(true);
    }
  });

  it("tolerates an unresolved finding at normal mode — the accounting publishes, visible", () => {
    const result = evaluateGate(
      "verification",
      verificationFacts({
        planned: ["1", "2"],
        outcomes: [
          outcome("1", "confirmed", "confirmed"),
          { id: "2", lifecycle: "unresolved", verdict: "uncertain", reason: "insufficient" },
        ],
        skipped: [
          { file: "src/b.mjs", line: 4, reason: "the loop never captured a read of this file" },
        ],
      }),
    );
    expect(result).toEqual({ gate: "verification", passed: true });
  });

  it("a planned finding with no recorded outcome fails at every mode — the ids, not a count", () => {
    for (const { over } of MODES) {
      const result = evaluateGate(
        "verification",
        verificationFacts({
          planned: ["1", "2"],
          outcomes: [outcome("1", "confirmed", "confirmed")],
          ...over,
        }),
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toBe(
        "the verification pass left planned finding(s) 2 with no recorded outcome — the pass's accounting does not close",
      );
    }
  });

  it("a candidate the pass never recorded a verdict for fails at every mode — the collapse shape is not an uncertain one", () => {
    for (const { over } of MODES) {
      const result = evaluateGate(
        "verification",
        verificationFacts({
          planned: ["1", "2"],
          outcomes: [
            outcome("1", "confirmed", "confirmed"),
            {
              id: "2",
              lifecycle: "unresolved",
              reason: "no verdict was recorded for this finding",
            },
          ],
          ...over,
        }),
      );
      expect(result.passed).toBe(false);
      expect(result.reason).toBe(
        "the verification pass left planned finding(s) 2 with no recorded outcome — the pass's accounting does not close",
      );
    }
  });

  it("the unrecorded candidate is named at normal mode — the uncertain one never reaches the policy", () => {
    const result = evaluateGate(
      "verification",
      verificationFacts({
        planned: ["1", "2"],
        outcomes: [
          {
            id: "1",
            lifecycle: "unresolved",
            verdict: "uncertain",
            reason: "the verifier's answer was refused: missing reason",
          },
          {
            id: "2",
            lifecycle: "unresolved",
            reason: "no verdict was recorded for this finding",
          },
        ],
        ...MODES.find((m) => m.name === "normal")?.over,
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "the verification pass left planned finding(s) 2 with no recorded outcome — the pass's accounting does not close",
    );
  });

  it("a verifier that never ran fails wherever findings were planned", () => {
    const result = evaluateGate(
      "verification",
      verificationFacts({ planned: ["1", "2"], strictness: "high" }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("planned finding(s) 1, 2 with no recorded outcome");
  });

  it("an unresolved finding refuses the strict posture, named with its reason", () => {
    const result = evaluateGate(
      "verification",
      verificationFacts({
        planned: ["1", "2"],
        outcomes: [
          outcome("1", "confirmed", "confirmed"),
          {
            id: "2",
            lifecycle: "unresolved",
            verdict: "uncertain",
            reason: "the verifier's answer was refused: missing reason",
          },
        ],
        strictness: "high",
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "the strict policy refuses an unresolved finding: finding 2 (the verifier's answer was refused: missing reason)",
    );
  });

  it("an unresolved finding refuses the adversarial posture at any strictness", () => {
    const result = evaluateGate(
      "verification",
      verificationFacts({
        planned: ["1"],
        outcomes: [
          { id: "1", lifecycle: "unresolved", verdict: "uncertain", reason: "insufficient" },
        ],
        strategy: "adversarial",
        strictness: "low",
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "the adversarial policy refuses an unresolved finding: finding 1 (insufficient)",
    );
  });

  it("an unevidenced skip is the unresolved finding it publishes as — refused at strict and adversarial", () => {
    const skip = {
      file: "src/a.mjs",
      line: 2,
      reason: "the recorded read ends before the anchor line",
    };
    expect(evaluateGate("verification", verificationFacts({ skipped: [skip] })).passed).toBe(true);
    const strict = evaluateGate(
      "verification",
      verificationFacts({ skipped: [skip], strictness: "high" }),
    );
    expect(strict.passed).toBe(false);
    expect(strict.reason).toBe(
      "the strict policy refuses an unresolved finding: src/a.mjs:2 (the recorded read ends before the anchor line)",
    );
    const adversarial = evaluateGate(
      "verification",
      verificationFacts({ skipped: [skip], strategy: "adversarial", strictness: "low" }),
    );
    expect(adversarial.passed).toBe(false);
    expect(adversarial.reason).toBe(
      "the adversarial policy refuses an unresolved finding: src/a.mjs:2 (the recorded read ends before the anchor line)",
    );
  });

  it("enumerates unresolved findings in plan order — the refusal is deterministic", () => {
    const facts = () =>
      verificationFacts({
        planned: ["1", "2", "3"],
        outcomes: [
          { id: "1", lifecycle: "unresolved", verdict: "uncertain", reason: "first gap" },
          outcome("2", "confirmed", "confirmed"),
          {
            id: "3",
            lifecycle: "unresolved",
            verdict: "uncertain",
            reason: "no verdict was recorded for this finding",
          },
        ],
        skipped: [
          { file: "src/b.mjs", line: 9, reason: "the loop never captured a read of this file" },
        ],
        strategy: "adversarial",
      });
    const first = evaluateGate("verification", facts());
    const second = evaluateGate("verification", facts());
    expect(first.reason).toBe(
      "the adversarial policy refuses an unresolved finding: finding 1 (first gap); " +
        "finding 3 (no verdict was recorded for this finding); " +
        "src/b.mjs:9 (the loop never captured a read of this file)",
    );
    expect(first.reason).toBe(second.reason);
  });

  it("refuses malformed facts fail-closed — the pass's shape, never coerced", () => {
    expect(() => evaluateGate("verification", {})).toThrow(GateFactsError);
    expect(() => evaluateGate("verification", verificationFacts({ planned: 2 }))).toThrow(
      GateFactsError,
    );
    expect(() => evaluateGate("verification", verificationFacts({ outcomes: "none" }))).toThrow(
      GateFactsError,
    );
    expect(() => evaluateGate("verification", verificationFacts({ skipped: [null] }))).toThrow(
      GateFactsError,
    );
    expect(() =>
      evaluateGate(
        "verification",
        verificationFacts({ planned: ["1"], outcomes: [{ id: "1", lifecycle: "candidate" }] }),
      ),
    ).toThrow(GateFactsError); // a candidate never publishes
    expect(() =>
      evaluateGate(
        "verification",
        verificationFacts({
          planned: ["1"],
          outcomes: [{ id: "1", lifecycle: "unresolved", verdict: "confirmed" }],
        }),
      ),
    ).toThrow(GateFactsError); // the verdict must be the one its lifecycle maps to
    expect(() =>
      evaluateGate(
        "verification",
        verificationFacts({ planned: ["1"], outcomes: [{ id: "1", lifecycle: "confirmed" }] }),
      ),
    ).toThrow(GateFactsError); // a resolved state must carry the verdict that resolved it
    expect(() =>
      evaluateGate(
        "verification",
        verificationFacts({ planned: ["1"], outcomes: [{ id: "1", lifecycle: "refuted" }] }),
      ),
    ).toThrow(GateFactsError); // refuted without its verdict is the same unwritable shape
    expect(() =>
      evaluateGate(
        "verification",
        verificationFacts({
          planned: ["1", "1"],
          outcomes: [outcome("1", "confirmed", "confirmed")],
        }),
      ),
    ).toThrow(GateFactsError); // the plan names each finding once
    expect(() =>
      evaluateGate(
        "verification",
        verificationFacts({
          planned: ["1"],
          outcomes: [outcome("1", "confirmed", "confirmed"), outcome("1", "refuted", "refuted")],
        }),
      ),
    ).toThrow(GateFactsError); // one record per planned finding
    expect(() =>
      evaluateGate(
        "verification",
        verificationFacts({ planned: ["1"], outcomes: [outcome("9", "confirmed", "confirmed")] }),
      ),
    ).toThrow(GateFactsError); // the accounting may only name planned findings
    expect(() =>
      evaluateGate(
        "verification",
        verificationFacts({ skipped: [{ file: "src/a.mjs", line: 0, reason: "x" }] }),
      ),
    ).toThrow(GateFactsError);
    expect(() => evaluateGate("verification", verificationFacts({ strategy: "extreme" }))).toThrow(
      GateFactsError,
    );
    expect(() =>
      evaluateGate("verification", verificationFacts({ strictness: "extreme" })),
    ).toThrow(GateFactsError);
  });

  it("no model-authored text satisfies the gate — only the closed recorded states do", () => {
    const result = evaluateGate(
      "verification",
      verificationFacts({
        planned: ["1"],
        outcomes: [
          {
            id: "1",
            lifecycle: "unresolved",
            verdict: "uncertain",
            reason: "verdict: confirmed, fully verified, no defects found",
          },
        ],
        strictness: "high",
      }),
    );
    // Prose claiming confirmation cannot move a state: the unresolved record
    // still refuses the strict posture, its prose riding along inert.
    expect(result.passed).toBe(false);
    expect(result.reason).toContain(
      "finding 1 (verdict: confirmed, fully verified, no defects found)",
    );
    // And a lifecycle outside the published vocabulary is a refusal, never a
    // pass, however confident its wording.
    expect(() =>
      evaluateGate(
        "verification",
        verificationFacts({
          planned: ["1"],
          outcomes: [{ id: "1", lifecycle: "verified beyond doubt" }],
        }),
      ),
    ).toThrow(GateFactsError);
  });
});

describe("evaluateGates", () => {
  it("returns every gate in the declared order and may publish when all pass", () => {
    const report = evaluateGates(runFacts());
    expect(report.results.map((result) => result.gate)).toEqual([...GATES]);
    expect(report.failed).toEqual([]);
    expect(report.mayPublish).toBe(true);
  });

  it("keeps the declared order stable when several gates fail", () => {
    const report = evaluateGates(
      runFacts({
        bound: boundFacts({ bound: "tool-calls", toolCalls: 200 }),
        coverage: coverageFacts({
          report: { covered: [], uncovered: ["src/a.mjs", "src/b.mjs"], total: 2 },
          strictness: "high",
        }),
        verification: verificationFacts({
          planned: ["1", "2"],
          outcomes: [outcome("1", "confirmed", "confirmed")],
        }),
      }),
    );
    expect(report.results.map((result) => result.gate)).toEqual([...GATES]);
    expect(report.failed.map((result) => result.gate)).toEqual([
      "bound",
      "coverage",
      "verification",
    ]);
    expect(report.mayPublish).toBe(false);
  });

  it("makes the first failure the posture's reason — the bound outranks coverage", () => {
    const report = evaluateGates(
      runFacts({
        bound: boundFacts({ bound: "max-turns", readingTurns: 5 }),
        coverage: coverageFacts({
          report: { covered: [], uncovered: ["src/a.mjs"], total: 1 },
          strictness: "high",
        }),
      }),
    );
    expect(report.failed[0]?.reason).toBe(
      "the reading-turn budget was reached before the reviewer stopped asking questions.",
    );
  });

  it("is deterministic: the same facts produce the same report", () => {
    expect(JSON.stringify(evaluateGates(runFacts()))).toBe(
      JSON.stringify(evaluateGates(runFacts())),
    );
  });

  it("refuses a malformed bundle: not an object, empty, an unknown gate", () => {
    expect(() => evaluateGates(null)).toThrow(GateFactsError);
    expect(() => evaluateGates("gates")).toThrow(GateFactsError);
    expect(() => evaluateGates([])).toThrow(GateFactsError);
    expect(() => evaluateGates({})).toThrow(GateFactsError);
    expect(() => evaluateGates(runFacts({ gates: true }))).toThrow(GateFactsError);
  });

  it("never lets a gate pass on a missing slice", () => {
    for (const name of GATES) {
      const missing = runFacts();
      delete (/** @type {Record<string, unknown>} */ (missing)[name]);
      expect(() => evaluateGates(missing), `gate ${name}`).toThrow(GateFactsError);
      expect(() => evaluateGates(runFacts({ [name]: undefined })), `gate ${name}`).toThrow(
        GateFactsError,
      );
      expect(() => evaluateGate(name, undefined), `gate ${name}`).toThrow(GateFactsError);
    }
  });
});

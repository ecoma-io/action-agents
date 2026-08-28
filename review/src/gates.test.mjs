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
  return { published: [], quarantined: [], ...over };
}

/** @returns {import("./gates.mjs").VerificationFacts} */
function verificationFacts(over = {}) {
  return { planned: 0, recorded: 0, ...over };
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
  it("passes when every published finding is anchored, quarantined or not", () => {
    const result = evaluateGate(
      "provenance",
      provenanceFacts({ published: [anchored()], quarantined: [quarantined()] }),
    );
    expect(result).toEqual({ gate: "provenance", passed: true });
  });

  it("fails when an unanchored finding remains in the publication set", () => {
    const result = evaluateGate(
      "provenance",
      provenanceFacts({
        published: [anchored(), anchored({ file: "src/c.mjs", line: 9, message: "off-by-two" })],
        quarantined: [],
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "an unanchored finding remains in the publication set: src/c.mjs:9 off-by-two",
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

  it("refuses slices whose lists are not arrays or whose entries are not objects", () => {
    expect(() => evaluateGate("provenance", { published: "none", quarantined: [] })).toThrow(
      GateFactsError,
    );
    expect(() => evaluateGate("provenance", { published: [], quarantined: ["nit"] })).toThrow(
      GateFactsError,
    );
    expect(() => evaluateGate("provenance", { published: [null], quarantined: [] })).toThrow(
      GateFactsError,
    );
  });
});

describe("gate verification", () => {
  it("passes when every planned finding has its verdict recorded, including the empty plan", () => {
    expect(evaluateGate("verification", verificationFacts())).toEqual({
      gate: "verification",
      passed: true,
    });
    expect(evaluateGate("verification", { planned: 3, recorded: 3 }).passed).toBe(true);
  });

  it("fails when the pass's outcome is not fully recorded", () => {
    const result = evaluateGate("verification", { planned: 2, recorded: 1 });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe(
      "the verification pass recorded 1 verdict(s) against 2 planned finding(s) — the pass's outcome is not fully recorded",
    );
  });

  it("fails closed when more verdicts are recorded than findings planned", () => {
    const result = evaluateGate("verification", { planned: 1, recorded: 2 });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("recorded 2 verdict(s) against 1 planned finding(s)");
  });

  it("refuses malformed counts", () => {
    expect(() => evaluateGate("verification", {})).toThrow(GateFactsError);
    expect(() => evaluateGate("verification", { planned: -1, recorded: 0 })).toThrow(
      GateFactsError,
    );
    expect(() => evaluateGate("verification", { planned: 1, recorded: "1" })).toThrow(
      GateFactsError,
    );
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
        verification: verificationFacts({ planned: 2, recorded: 1 }),
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

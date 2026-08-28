// Tests for the phase machine: the declared order and its frozen set, every
// legal transition edge, every refusal (typed, never coerced), the tool
// policy as an exhaustive narrowing of the fixed registry, the strict
// conclude gate, and determinism — the same ledger facts always resolve the
// same machine state, whatever order they are asked in.

import { describe, expect, it } from "vitest";

import { TOOL_SPECS } from "./tools.mjs";
import {
  FIRST_PHASE,
  PHASES,
  PHASE_PROCEDURES,
  PHASE_TOOL_POLICY,
  PhaseError,
  nextPhase,
  phaseTools,
  validatePhaseToolPolicy,
} from "./phases.mjs";

/**
 * @param {Partial<import("./phases.mjs").PhaseContext>} [over]
 * @returns {import("./phases.mjs").PhaseContext}
 */
function context(over = {}) {
  return {
    coverage: { covered: [], uncovered: [], total: 0 },
    toolCalls: 0,
    maxToolCalls: 200,
    readingTurns: 0,
    maxTurns: 30,
    evidenceBytes: 0,
    evidenceLimit: 512 * 2 ** 10,
    lanesAssigned: true,
    strictness: "medium",
    ...over,
  };
}

/**
 * @param {() => unknown} fn
 * @returns {PhaseError}
 */
function phaseFailure(fn) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PhaseError);
    return /** @type {PhaseError} */ (error);
  }
  throw new Error("expected the call to refuse, but it resolved");
}

describe("the declared phases", () => {
  it("walk orient → investigate → verify → conclude, in that frozen order", () => {
    expect([...PHASES]).toEqual(["orient", "investigate", "verify", "conclude"]);
    expect(Object.isFrozen(PHASES)).toBe(true);
    expect(FIRST_PHASE).toBe("orient");
  });

  it("refuses mutation of the declared set", () => {
    const mutable = /** @type {string[]} */ (PHASES);
    expect(() => mutable.push("warp")).toThrow(TypeError);
  });
});

describe("legal transitions", () => {
  it("orient ends after one recorded reading turn with the lanes fixed", () => {
    expect(nextPhase("orient", context({ readingTurns: 1 }))).toBe("investigate");
  });

  it("orient holds until a turn is spent", () => {
    expect(nextPhase("orient", context())).toBe("orient");
  });

  it("orient holds while the lanes are not fixed, whatever the turns say", () => {
    expect(nextPhase("orient", context({ readingTurns: 7, lanesAssigned: false }))).toBe("orient");
  });

  it("investigate ends on a fully covered expected set", () => {
    const full = context({ coverage: { covered: ["a.mjs"], uncovered: [], total: 1 } });
    expect(nextPhase("investigate", full)).toBe("verify");
  });

  it("investigate holds while files are uncovered — no ledger fact ends it early", () => {
    const partial = context({ coverage: { covered: ["a.mjs"], uncovered: ["b.mjs"], total: 2 } });
    expect(nextPhase("investigate", partial)).toBe("investigate");
  });

  it("investigate holds when there is no expected set to cover", () => {
    expect(nextPhase("investigate", context())).toBe("investigate");
  });

  it("verify holds until a reading bound fires", () => {
    expect(nextPhase("verify", context({ readingTurns: 12 }))).toBe("verify");
  });

  it("conclude is terminal", () => {
    expect(nextPhase("conclude", context({ toolCalls: 0 }))).toBe("conclude");
  });

  it("a fired bound reaches conclude from every reading phase", () => {
    for (const phase of /** @type {const} */ (["orient", "investigate", "verify"])) {
      expect(nextPhase(phase, context({ toolCalls: 5, maxToolCalls: 5 }))).toBe("conclude");
      expect(nextPhase(phase, context({ readingTurns: 30, maxTurns: 30 }))).toBe("conclude");
      expect(
        nextPhase(phase, context({ evidenceBytes: 512 * 2 ** 10, evidenceLimit: 512 * 2 ** 10 })),
      ).toBe("conclude");
    }
  });

  it("a bound below its cap never moves the machine to conclude", () => {
    expect(nextPhase("verify", context({ toolCalls: 5, maxToolCalls: 6 }))).toBe("verify");
  });

  it("the conclude edge wins over the stepwise edges: one bound exit, not one more verify hop", () => {
    const atBound = context({
      coverage: { covered: ["a.mjs"], uncovered: [], total: 1 },
      toolCalls: 9,
      maxToolCalls: 9,
    });
    expect(nextPhase("investigate", atBound)).toBe("conclude");
  });

  it("the machine steps once per call even when several edges' facts hold", () => {
    const allAtOnce = context({
      coverage: { covered: ["a.mjs"], uncovered: [], total: 1 },
      readingTurns: 1,
    });
    expect(nextPhase("orient", allAtOnce)).toBe("investigate");
  });
});

describe("the strict conclude gate", () => {
  it("refuses conclude at high strictness while files are uncovered, from any phase", () => {
    const strictUncovered = context({
      coverage: { covered: ["a.mjs"], uncovered: ["b.mjs"], total: 2 },
      strictness: "high",
      readingTurns: 1,
      toolCalls: 5,
      maxToolCalls: 5,
    });
    expect(nextPhase("orient", strictUncovered)).toBe("investigate");
    expect(nextPhase("investigate", strictUncovered)).toBe("investigate");
    expect(nextPhase("verify", strictUncovered)).toBe("verify");
  });

  it("reaches conclude at high strictness once nothing is uncovered", () => {
    const strictCovered = context({
      coverage: { covered: ["a.mjs", "b.mjs"], uncovered: [], total: 2 },
      strictness: "high",
      toolCalls: 5,
      maxToolCalls: 5,
    });
    expect(nextPhase("verify", strictCovered)).toBe("conclude");
  });

  it("binds the gate to high only — low and medium conclude over uncovered files", () => {
    for (const strictness of /** @type {const} */ (["low", "medium"])) {
      const partial = context({
        coverage: { covered: [], uncovered: ["b.mjs"], total: 1 },
        strictness,
        toolCalls: 5,
        maxToolCalls: 5,
      });
      expect(nextPhase("verify", partial)).toBe("conclude");
    }
  });

  it("never gates an exit that has not fired — strict alone moves nothing", () => {
    const strictMidRead = context({
      coverage: { covered: ["a.mjs"], uncovered: ["b.mjs"], total: 2 },
      strictness: "high",
    });
    expect(nextPhase("verify", strictMidRead)).toBe("verify");
  });
});

describe("refusals", () => {
  it("refuses phase names the machine does not own", () => {
    for (const phase of /** @type {const} */ ([
      "warp",
      "",
      "ORIENT",
      "orient ",
      42,
      undefined,
      null,
    ])) {
      const failure = phaseFailure(() => nextPhase(/** @type {any} */ (phase), context()));
      expect(failure.name).toBe("PhaseError");
      expect(failure.message).toContain("not a declared phase");
    }
  });

  it("refuses a context that is not the ledger-shaped record", () => {
    for (const bad of /** @type {const} */ ([null, undefined, 42, "context", {}])) {
      const failure = phaseFailure(() => nextPhase("orient", /** @type {any} */ (bad)));
      expect(failure).toBeInstanceOf(PhaseError);
    }
  });

  it("refuses a malformed coverage report", () => {
    const shapes = /** @type {const} */ ([
      {},
      { covered: "a.mjs", uncovered: [], total: 1 },
      { covered: [], uncovered: [3], total: 1 },
      { covered: [], uncovered: [], total: -1 },
      { covered: [], uncovered: [], total: 1.5 },
      { covered: [], uncovered: [], total: "2" },
    ]);
    for (const coverage of shapes) {
      const failure = phaseFailure(() =>
        nextPhase("orient", context({ coverage: /** @type {any} */ (coverage) })),
      );
      expect(failure).toBeInstanceOf(PhaseError);
    }
  });

  it("refuses every malformed ledger field, one typed error each", () => {
    const badValues = /** @type {const} */ ([-1, 1.5, NaN, "3", null, undefined]);
    for (const field of /** @type {const} */ ([
      "toolCalls",
      "maxToolCalls",
      "readingTurns",
      "maxTurns",
      "evidenceBytes",
      "evidenceLimit",
    ])) {
      for (const value of badValues) {
        const failure = phaseFailure(() =>
          nextPhase("orient", context({ [field]: /** @type {any} */ (value) })),
        );
        expect(failure.message).toContain(field);
      }
    }
  });

  it("refuses a non-boolean lanes flag and an unknown strictness", () => {
    expect(
      phaseFailure(() =>
        nextPhase("orient", context({ lanesAssigned: /** @type {any} */ ("yes") })),
      ).message,
    ).toContain("lanesAssigned");
    for (const strictness of /** @type {const} */ (["extreme", "", undefined, null])) {
      const failure = phaseFailure(() =>
        nextPhase("orient", context({ strictness: /** @type {any} */ (strictness) })),
      );
      expect(failure.message).toContain("strictness");
    }
  });
});

describe("the per-phase tool policy", () => {
  it("narrows exactly as declared, exhaustively over the registry", () => {
    expect({ ...PHASE_TOOL_POLICY }).toEqual({
      orient: ["list_files", "search"],
      investigate: ["list_files", "search", "read_file"],
      verify: ["list_files", "search", "read_file"],
      conclude: [],
    });
  });

  it("is frozen at every level, and never names a tool the registry lacks", () => {
    const registryNames = TOOL_SPECS.map((spec) => spec.name);
    expect(Object.isFrozen(PHASE_TOOL_POLICY)).toBe(true);
    for (const phase of PHASES) {
      const names = PHASE_TOOL_POLICY[phase];
      expect(Object.isFrozen(names)).toBe(true);
      for (const name of names) expect(registryNames).toContain(name);
    }
  });

  it("hands out the registry entries the phase allows, in registry order", () => {
    expect(phaseTools("orient").map((spec) => spec.name)).toEqual(["list_files", "search"]);
    expect(phaseTools("investigate").map((spec) => spec.name)).toEqual([
      "read_file",
      "list_files",
      "search",
    ]);
    expect(phaseTools("verify").map((spec) => spec.name)).toEqual([
      "read_file",
      "list_files",
      "search",
    ]);
    expect(phaseTools("conclude")).toEqual([]);
  });

  it("narrows a foreign registry the same way — additions are impossible", () => {
    const foreign = [
      ...TOOL_SPECS.filter((spec) => spec.name === "read_file"),
      {
        name: "deploy",
        description: "a tool no phase may ever see",
        parameters: { type: "object", properties: {} },
      },
    ];
    expect(phaseTools("orient", foreign)).toEqual([]);
    expect(phaseTools("investigate", foreign).map((spec) => spec.name)).toEqual(["read_file"]);
    expect(phaseTools("conclude", foreign)).toEqual([]);
  });

  it("validatePhaseToolPolicy refuses a map that is not a pure narrowing", () => {
    const full = {
      orient: ["list_files", "search"],
      investigate: ["list_files", "search", "read_file"],
      verify: ["list_files", "search", "read_file"],
      conclude: [],
    };
    expect(() => validatePhaseToolPolicy({ ...full, warp: [] })).toThrow(PhaseError);
    expect(() =>
      validatePhaseToolPolicy({ ...full, orient: /** @type {any} */ ("list_files") }),
    ).toThrow(PhaseError);
    expect(() => validatePhaseToolPolicy({ ...full, orient: [/** @type {any} */ (7)] })).toThrow(
      PhaseError,
    );
    expect(() => validatePhaseToolPolicy({ ...full, orient: ["search", "search"] })).toThrow(
      PhaseError,
    );
    expect(() => validatePhaseToolPolicy({ ...full, conclude: ["deploy"] })).toThrow(
      /may only narrow/,
    );
    const { conclude: _omitted, ...missing } = full;
    expect(() => validatePhaseToolPolicy(missing)).toThrow(PhaseError);
  });

  it("carries one validated procedure paragraph per declared phase", () => {
    expect(Object.keys(PHASE_PROCEDURES)).toEqual([...PHASES]);
    expect(Object.isFrozen(PHASE_PROCEDURES)).toBe(true);
    for (const phase of PHASES) {
      expect(PHASE_PROCEDURES[phase].startsWith(`Review phase — "${phase}"`)).toBe(true);
    }
  });
});

describe("determinism", () => {
  it("resolves the same ledger facts to the same phase, every time", () => {
    const ctx = context({
      coverage: { covered: ["a.mjs"], uncovered: ["b.mjs"], total: 2 },
      readingTurns: 3,
      strictness: "high",
    });
    expect(nextPhase("investigate", ctx)).toBe(nextPhase("investigate", ctx));
  });

  it("a replayed scenario resolves identically in any asking order", () => {
    /** @type {[import("./phases.mjs").PhaseName, Partial<import("./phases.mjs").PhaseContext>][]} */
    const scenario = [
      ["orient", {}],
      ["orient", { readingTurns: 1 }],
      ["investigate", { readingTurns: 1 }],
      ["investigate", { coverage: { covered: ["a"], uncovered: [], total: 1 } }],
      ["verify", { coverage: { covered: ["a"], uncovered: [], total: 1 } }],
      ["verify", { toolCalls: 4, maxToolCalls: 4 }],
      ["conclude", { toolCalls: 4, maxToolCalls: 4 }],
      ["orient", { toolCalls: 2, maxToolCalls: 2, strictness: "high" }],
      ["investigate", { readingTurns: 2, lanesAssigned: false }],
      ["verify", { evidenceBytes: 1, evidenceLimit: 1 }],
    ];
    const firstPass = scenario.map(([phase, over]) => nextPhase(phase, context(over)));
    const secondPass = scenario.map(([phase, over]) => nextPhase(phase, context(over)));
    const reversedPass = [...scenario]
      .reverse()
      .map(([phase, over]) => nextPhase(phase, context(over)));
    expect(firstPass).toEqual(secondPass);
    expect(firstPass).toEqual(reversedPass.reverse());
  });
});

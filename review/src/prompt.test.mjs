// Tests for the review-mode paragraphs: the system message names the
// strictness posture, appends the adversarial paragraph only when the
// strategy asks for it, and never lets the mode text leak into the user
// message that carries the evidence.

import { describe, expect, it } from "vitest";

import { buildPrompt } from "./prompt.mjs";

/**
 * @param {Partial<import("./prompt.mjs").PromptParts>} [over]
 * @returns {import("./prompt.mjs").PromptParts}
 */
function parts(over = {}) {
  return {
    repoName: "acme/widgets",
    repoDescription: "",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    title: "a change",
    body: "",
    language: "en",
    strictness: "medium",
    strategy: "standard",
    lanes: [],
    laneBudgets: { deep: 0, standard: 0, skim: 0 },
    reviewed: [],
    instruction: undefined,
    posture: undefined,
    activeRules: [],
    ruleDocuments: new Map(),
    ...over,
  };
}

/**
 * @param {string} filename
 * @returns {import("./inventory.mjs").ChangedFile}
 */
function file(filename) {
  return { filename, status: "modified", additions: 2, deletions: 1 };
}

/**
 * @param {import("./prompt.mjs").PromptParts} parts
 * @returns {string}
 */
function systemOf(parts) {
  const { messages } = buildPrompt(parts);
  expect(messages).toHaveLength(2);
  expect(messages[0]?.role).toBe("system");
  expect(messages[1]?.role).toBe("user");
  return /** @type {string} */ (messages[0]?.content);
}

describe("strictness mode paragraphs", () => {
  it("low: prioritises concerns, light investigation, precise anchors", () => {
    const system = systemOf(parts({ strictness: "low" }));
    expect(system).toContain('strictness "low"');
    expect(system).toContain("prioritise concerns over completeness");
    expect(system).toContain("Report only findings you are confident matter");
    expect(system).toContain("Investigate lightly");
  });

  it("medium: the default thorough review, made explicit", () => {
    const system = systemOf(parts({ strictness: "medium" }));
    expect(system).toContain('strictness "medium"');
    expect(system).toContain("a normal, thorough review");
    expect(system).toContain("anchor every finding precisely");
  });

  it("high: evidence-driven, verification before reporting, coverage as expectation", () => {
    const system = systemOf(parts({ strictness: "high" }));
    expect(system).toContain('strictness "high"');
    expect(system).toContain("Verify every finding against the concrete code");
    expect(system).toContain("no unconfirmed hypotheses");
    expect(system).toContain("Reading every changed file is the expectation");
    // The expectation is phrased as effort, never as an enforcement promise.
    expect(system).not.toMatch(/will be enforced|guaranteed|automatically checks/);
  });

  it("exactly one strictness paragraph is present", () => {
    const system = systemOf(parts({ strictness: "high" }));
    expect(system.match(/Review mode — strictness/g) ?? []).toHaveLength(1);
  });
});

describe("adversarial strategy paragraph", () => {
  it("appends the adversarial paragraph at any strictness", () => {
    for (const strictness of /** @type {const} */ (["low", "medium", "high"])) {
      const system = systemOf(parts({ strictness, strategy: "adversarial" }));
      expect(system).toContain('Review strategy — "adversarial"');
      expect(system).toContain("hypotheses pending");
      expect(system).toContain("counterexamples");
      expect(system).toContain("a separate verification stage follows this review");
      expect(system.match(/Review strategy/g) ?? []).toHaveLength(1);
    }
  });

  it("standard strategy never carries the adversarial paragraph", () => {
    for (const strictness of /** @type {const} */ (["low", "medium", "high"])) {
      expect(systemOf(parts({ strictness, strategy: "standard" }))).not.toContain(
        "Review strategy",
      );
    }
  });

  it("keeps the mode paragraphs out of the evidence message", () => {
    const { messages } = buildPrompt(parts({ strategy: "adversarial", strictness: "high" }));
    const user = /** @type {string} */ (messages[1]?.content);
    expect(user).not.toContain("Review mode");
    expect(user).not.toContain("Review strategy");
  });
});

describe("risk lane procedure and annotations", () => {
  /** Two lanes, one of each depth the inventory exercises. */
  const LANES = [
    {
      path: "src/auth/login.ts",
      risk: /** @type {const} */ ("high"),
      lane: /** @type {const} */ ("deep"),
    },
    {
      path: "src/util.ts",
      risk: /** @type {const} */ ("low"),
      lane: /** @type {const} */ ("skim"),
    },
  ];
  const BUDGETS = { deep: 3, standard: 0, skim: 1 };

  it("states the lane procedure once, with the effort split and the exemption refusal", () => {
    const system = systemOf(
      parts({
        reviewed: [file("src/auth/login.ts"), file("src/util.ts")],
        lanes: LANES,
        laneBudgets: BUDGETS,
      }),
    );
    expect(system).toContain("Review lanes");
    expect(system).toContain('"deep", "standard" or "skim"');
    expect(system).toContain("a lane is not an exemption");
    expect(system).toContain("every changed file still counts toward coverage");
    expect(system).toContain("The mode paragraphs above stay authoritative");
    expect(system).toContain("deep: 3, standard: 0, skim: 1");
    expect(system.match(/Review lanes/g) ?? []).toHaveLength(1);
  });

  it("no lane assignments, no procedure paragraph", () => {
    expect(systemOf(parts())).not.toContain("Review lanes");
  });

  it("sits the procedure below the mode paragraphs, which stay authoritative", () => {
    const system = systemOf(
      parts({
        strictness: "high",
        strategy: "adversarial",
        reviewed: [file("src/auth/login.ts"), file("src/util.ts")],
        lanes: LANES,
        laneBudgets: BUDGETS,
      }),
    );
    expect(system.indexOf("Review mode — strictness")).toBeLessThan(system.indexOf("Review lanes"));
    expect(system.indexOf("Review lanes")).toBeLessThan(system.indexOf("Review strategy"));
  });

  it("annotates every inventory line with its code-assigned lane", () => {
    const { messages } = buildPrompt(
      parts({
        reviewed: [file("src/auth/login.ts"), file("src/util.ts")],
        lanes: LANES,
        laneBudgets: BUDGETS,
      }),
    );
    const user = /** @type {string} */ (messages[1]?.content);
    const deep = user.split("\n").find((line) => line.startsWith("- src/auth/login.ts"));
    const skim = user.split("\n").find((line) => line.startsWith("- src/util.ts"));
    expect(deep).toBe("- src/auth/login.ts (+2/-1, modified, lane: deep)");
    expect(skim).toBe("- src/util.ts (+2/-1, modified, lane: skim)");
  });

  it("never phrases a skim lane as skippable in the data message", () => {
    const { messages } = buildPrompt(
      parts({
        reviewed: [file("src/util.ts")],
        lanes: [{ path: "src/util.ts", risk: "low", lane: "skim" }],
        laneBudgets: { deep: 0, standard: 0, skim: 2 },
      }),
    );
    const user = /** @type {string} */ (messages[1]?.content);
    expect(user).toContain("lane: skim");
    expect(user).not.toMatch(/skip|exempt|optional|ignore/);
  });

  it("refuses assignments that cannot account for the whole inventory", () => {
    expect(() => buildPrompt(parts({ reviewed: [file("src/util.ts")], lanes: [] }))).toThrow(
      /cannot account for the whole universe/,
    );
  });

  it("refuses duplicate assignments that leave a file unlaned", () => {
    expect(() =>
      buildPrompt(
        parts({
          reviewed: [file("src/auth/login.ts"), file("src/util.ts")],
          lanes: [
            { path: "src/auth/login.ts", risk: "high", lane: "deep" },
            { path: "src/auth/login.ts", risk: "high", lane: "deep" },
          ],
          laneBudgets: BUDGETS,
        }),
      ),
    ).toThrow(/cannot account for the whole universe/);
  });
});

describe("review phase paragraphs", () => {
  it("renders one paragraph per declared phase, in machine order", () => {
    const system = systemOf(parts({}));
    const order = ["orient", "investigate", "verify", "conclude"].map((phase) =>
      system.indexOf(`Review phase — "${phase}"`),
    );
    for (const position of order) expect(position).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(system.match(/Review phase —/g) ?? []).toHaveLength(4);
  });

  it("keeps the phase paragraphs out of the evidence message", () => {
    const { messages } = buildPrompt(parts({}));
    const user = /** @type {string} */ (messages[1]?.content);
    expect(user).not.toContain("Review phase");
  });
});

describe("the posture tier", () => {
  it("carries the mode-scoped document below the strategy paragraphs", () => {
    const system = systemOf(
      parts({
        posture: { name: "maintainer", document: "Narrow the rubric to what still matters." },
      }),
    );
    expect(system).toContain('Review posture "maintainer"');
    expect(system).toContain("They narrow judgement; they grant nothing:");
    expect(system).toContain("Narrow the rubric to what still matters.");
  });

  it("sits below the adversarial paragraph and above the custom rubric", () => {
    const system = systemOf(
      parts({
        strategy: "adversarial",
        posture: { name: "automation", document: "Release metadata is the surface." },
        instruction: "Be exact about lockfiles.",
      }),
    );
    expect(system.indexOf('Review strategy — "adversarial"')).toBeLessThan(
      system.indexOf('Review posture "automation"'),
    );
    expect(system.indexOf('Review posture "automation"')).toBeLessThan(
      system.indexOf("Be exact about lockfiles."),
    );
  });

  it("never rides the evidence message", () => {
    const { messages } = buildPrompt(
      parts({ posture: { name: "maintainer", document: "posture prose" } }),
    );
    const user = /** @type {string} */ (messages[1]?.content);
    expect(user).not.toContain("Review posture");
    expect(user).not.toContain("posture prose");
  });

  it("absent under the standard posture, nothing rendered", () => {
    expect(systemOf(parts())).not.toContain("Review posture");
  });
});

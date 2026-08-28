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
    reviewed: [],
    instruction: undefined,
    activeRules: [],
    ruleDocuments: new Map(),
    ...over,
  };
}

/** @param {import("./prompt.mjs").PromptParts} parts */
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

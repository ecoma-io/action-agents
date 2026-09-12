// Tests for the review-mode paragraphs: the system message names the
// strictness posture, appends the adversarial paragraph only when the
// strategy asks for it, and never lets the mode text leak into the user
// message that carries the evidence.

import { describe, expect, it } from "vitest";

import { buildPrompt, MAX_PR_BODY_BYTES } from "./prompt.mjs";

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
    expect(system).toContain("prioritise a few confident concerns over a broad report");
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

  it("every strictness carries the coverage mandate the verdict enforces (#421)", () => {
    for (const strictness of /** @type {const} */ (["low", "medium", "high"])) {
      const system = systemOf(parts({ strictness }));
      expect(system).toContain("read every changed file with the provided tools");
      expect(system).toContain("an incomplete review is no pass");
      // The mandate states the code's law in the gate's own words; it never
      // promises an enforcement mechanism prose cannot run.
      expect(system).not.toMatch(/will be enforced|guaranteed|automatically checks/);
    }
  });

  it("the coverage mandate outranks the mode paragraphs at every strictness (#424)", () => {
    for (const strictness of /** @type {const} */ (["low", "medium", "high"])) {
      const system = systemOf(parts({ strictness }));
      // A weak model reading "Investigate lightly" must not read it as an
      // exemption: the mandate names its own priority over every mode below.
      expect(system).toContain("This holds at every strictness");
      expect(system).toContain("no mode paragraph below exempts a changed file from being read");
      expect(system.indexOf("an incomplete review is no pass")).toBeLessThan(
        system.indexOf("Review mode — strictness"),
      );
      // The priority sentence is no enforcement promise either.
      expect(system).not.toMatch(/will be enforced|guaranteed|automatically checks/);
    }
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

describe("the description bound (#527)", () => {
  /**
   * The pr-body evidence block out of a built user message — the block the
   * fit estimate counts — from its begin marker to before its end marker.
   *
   * @param {string} body
   * @returns {string}
   */
  function bodyBlock(body) {
    const { messages } = buildPrompt(parts({ body }));
    const user = /** @type {string} */ (messages[1]?.content);
    const label = user.indexOf(" pr-body]");
    if (label === -1) return "";
    const start = user.lastIndexOf("[evidence:", label);
    const end = user.indexOf("[end-evidence:", label);
    return user.slice(start === -1 ? 0 : start, end === -1 ? undefined : end);
  }

  /**
   * The block's content — everything after the begin-marker line, so the
   * random per-run delimiter never defeats a byte comparison.
   *
   * @param {string} body
   * @returns {string}
   */
  function bodyContent(body) {
    const block = bodyBlock(body);
    return block.slice(block.indexOf("\n") + 1);
  }

  it("carries a description within the bound whole", () => {
    const body = "x".repeat(MAX_PR_BODY_BYTES);
    const content = bodyContent(body);
    expect(content).toBe(`${body}\n`);
    expect(bodyBlock(body)).not.toContain("pr-body truncated");
  });

  it("cuts a description past the bound, marked, to the bytes the run sends (#527)", () => {
    const body = `${"x".repeat(MAX_PR_BODY_BYTES)}then the growth that must not count`;
    const block = bodyBlock(body);
    expect(block).toContain(
      `[pr-body truncated: ${String(MAX_PR_BODY_BYTES)} of ${String(body.length)} bytes shown]`,
    );
    // The block the estimate counts stays bounded no matter how far the
    // description grew: begin marker + the bound's bytes + the mark.
    expect(block.length).toBeLessThan(MAX_PR_BODY_BYTES + 200);
  });

  it("never splits a code point or a surrogate pair at the cut", () => {
    // "€" is 3 UTF-8 bytes and "😀" a surrogate pair of two 3-byte
    // sequences; MAX_PR_BODY_BYTES is not divisible by 3, so a raw byte cut
    // would land mid-sequence. The kept text ends on whole code points.
    const body = "€😀".repeat(2_000);
    const block = bodyBlock(body);
    expect(block).not.toContain("�");
    const kept = block.slice(0, /** @type {number} */ (block.indexOf("\n[pr-body truncated:")));
    expect(kept.endsWith("€") || kept.endsWith("😀")).toBe(true);
  });

  it("is deterministic: the same description builds the same content twice", () => {
    const body = "context\n".repeat(3_000);
    expect(bodyContent(body)).toBe(bodyContent(body));
  });

  it("an empty description still rides no block at all", () => {
    const { messages } = buildPrompt(parts({ body: "" }));
    const user = /** @type {string} */ (messages[1]?.content);
    expect(user).not.toContain("pr-body");
  });
});

describe("the architecture evidence section", () => {
  /**
   * The smallest evidence the frozen reader can carry — one introduced
   * violation with a site, verdict fail, everything else empty.
   *
   * @returns {import("#core/architecture.mjs").ArchitectureEvidence}
   */
  function evidence() {
    return {
      verdict: "fail",
      stale: false,
      incompleteness: null,
      provenance: {
        head: { commit: "a".repeat(40), dirty: false },
        base: { commit: "b".repeat(40), dirty: false },
      },
      policyChanged: false,
      provider: "node-workspace",
      toolVersion: "0.29.0",
      policyFingerprints: { head: `sha256:${"1".repeat(64)}`, base: `sha256:${"2".repeat(64)}` },
      reportSha256: `sha256:${"3".repeat(64)}`,
      introduced: [
        {
          messageId: "onlyTagsConstraintViolation",
          sourceProject: "scope:widgets-a",
          target: "widgets-b/src/index.mjs",
          targetIsSpecifier: false,
          constraint: null,
          waived: false,
          waivedBy: null,
          baseCount: 0,
          headCount: 1,
          baseSites: [],
          headSites: [{ file: "src/summary.js", line: 3 }],
          reason: null,
          note: null,
        },
      ],
      resolved: [],
      unchangedCount: 0,
      introducedWaived: 0,
      renamePairs: [],
      occurrencesReduced: [],
      customRules: null,
      unresolvable: { introduced: 0, resolved: 0, unchanged: 0, unknown: 0 },
      coverage: {
        complete: true,
        analyzedFiles: 2,
        notAnalyzedCount: 0,
        blindSpotCount: 0,
        notes: [],
      },
    };
  }

  /**
   * Parts carrying the evidence, over the file the site names.
   *
   * @param {Partial<import("./prompt.mjs").PromptParts>} [over]
   * @returns {import("./prompt.mjs").PromptParts}
   */
  function awareParts(over = {}) {
    return parts({
      reviewed: [file("src/summary.js")],
      lanes: [{ path: "src/summary.js", risk: "high", lane: "deep" }],
      laneBudgets: { deep: 1, standard: 0, skim: 0 },
      architecture: { evidence: evidence(), adr: null, omittedRefs: 0 },
      ...over,
    });
  }

  it("rides the user message as one wrapped block beside the changed files, before any attacker word", () => {
    const { messages } = buildPrompt(awareParts({ title: "pr words", body: "body words" }));
    const user = /** @type {string} */ (messages[1]?.content);
    // The wrapper's begin marker carries the random per-run delimiter; the
    // label is what identifies the block.
    expect(user).toContain(" architecture]");
    expect(user).toContain("[end-evidence:");
    expect(user).toContain("verdict: fail");
    // Order: after the changed-files list, before the title — evidence rides
    // above every attacker-authored byte the message also carries.
    const list = user.indexOf("- src/summary.js");
    const block = user.indexOf(" architecture]");
    const title = user.indexOf(" pr-title]");
    expect(list).toBeGreaterThan(-1);
    expect(list).toBeLessThan(block);
    expect(block).toBeLessThan(title);
  });

  it("carries the system-side meaning paragraph exactly when the block rides", () => {
    const system = systemOf(awareParts());
    expect(system).toContain("Architecture evidence");
    expect(system).toContain("not verdicts to echo");
    expect(system).toContain("do not narrate architecture as reviewed, clean or violated");
    expect(system.match(/Architecture evidence —/g) ?? []).toHaveLength(1);
    // The meaning is system-side only; the user message carries the facts.
    const { messages } = buildPrompt(awareParts());
    expect(/** @type {string} */ (messages[1]?.content)).not.toContain("not verdicts to echo");
  });

  it("a blind prompt carries neither the block nor the paragraph, byte for byte", () => {
    const blindParts = parts({
      reviewed: [file("src/summary.js")],
      lanes: [{ path: "src/summary.js", risk: "high", lane: "deep" }],
      laneBudgets: { deep: 1, standard: 0, skim: 0 },
    });
    const blind = buildPrompt(blindParts);
    expect(/** @type {string} */ (blind.messages[0]?.content)).not.toContain(
      "Architecture evidence",
    );
    const user = /** @type {string} */ (blind.messages[1]?.content);
    expect(user).not.toContain("architecture");
    expect(user).not.toContain("verdict: fail");
  });
});

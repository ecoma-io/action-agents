// Tests for the policy engine — the deterministic stage that turns Evidence
// and Assessment into the Decision. Every decision here is a pure function
// of the inputs: no chat, no forge. What these tests pin is that the model's
// judgement is bounded by the sheet, that size is measured and replaced not
// asked and added, that the workflow marker is cleared by code on a
// classification, that off-sheet answers are refused not coerced, and that
// the decision's logs carry the exact lines a run must announce.

import { describe, expect, it } from "vitest";

import { decide } from "./policy.mjs";
import { renderDryRun } from "./decision.mjs";

const LADDER = [
  { upTo: 10, label: "size/xs" },
  { upTo: 50, label: "size/s" },
  { label: "size/xl" },
];

/** @type {import("./config.mjs").TriageConfig} */
const CONFIG = {
  labels: {
    use: new Set(["bug", "docs", "question", "breaking"]),
    roles: new Map([
      ["bug", "semantic-classification"],
      ["docs", "semantic-classification"],
      ["question", "routing-area"],
    ]),
    exclusive: [],
    workflowMarkers: [],
    triageOwned: new Set(),
    priority: new Map(),
    needsMoreInfo: null,
    routing: {},
  },
  size: {
    exclude: [],
    ladder: LADDER,
  },
  instructions: {},
};

const SHEET = new Map([
  ["bug", "a bug"],
  ["docs", "a doc"],
  ["question", "a question"],
]);

/**
 * @param {object} [overrides]
 * @param {Partial<import("./evidence.mjs").Evidence>} [overrides.evidence]
 * @param {import("./assessment.mjs").Assessment} [overrides.assessment]
 * @returns {import("./policy.mjs").PolicyInput}
 */
function input(overrides = {}) {
  return {
    evidence: {
      thread: {
        type: "issue",
        number: 7,
        title: "t",
        body: "b",
        labels: [],
        createdAt: "2026-01-01T00:00:00Z",
        creator: "author",
        state: "open",
      },
      repository: { name: "repo", description: "d" },
      policy: CONFIG,
      sheet: SHEET,
      labelMetadata: new Map([["bug", { name: "bug", description: "a bug", color: "blue" }]]),
      files: [],
      measuredSize: null,
      quality: null,
      forgeSearch: null,
      eventAction: "opened",
      ...(overrides.evidence ?? {}),
      // Evidence requires `pr` even on an issue thread — absent reads as null.
      pr: overrides.evidence?.pr ?? null,
    },
    assessment: { intent: "labels", labels: ["bug"], rationale: "Because." },
    ...(overrides.assessment === undefined ? {} : { assessment: overrides.assessment }),
  };
}

describe("decide — labels intent", () => {
  it("applies on-sheet labels the thread does not already carry", () => {
    const decision = decide(input());
    expect(decision.kind).toBe("labels");
    expect(decision.add).toEqual(["bug"]);
    expect(decision.remove).toEqual([]);
    expect(decision.refusals).toEqual([]);
    expect(decision.comment).toBeUndefined();
  });

  it("adds nothing for labels already present — idempotent", () => {
    const decision = decide(
      input({
        evidence: {
          thread: {
            type: "issue",
            number: 7,
            title: "t",
            body: "b",
            labels: ["bug"],
            createdAt: "2026-01-01T00:00:00Z",
            creator: "author",
            state: "open",
          },
        },
      }),
    );
    expect(decision.add).toEqual([]);
  });

  it("applies a repeated label once, not twice", () => {
    const decision = decide(
      input({ assessment: { intent: "labels", labels: ["bug", "bug"], rationale: "r" } }),
    );
    expect(decision.add).toEqual(["bug"]);
  });

  it("refuses the off-sheet half of a partly off-sheet answer and applies the on-sheet half", () => {
    const decision = decide(
      input({
        assessment: { intent: "labels", labels: ["bug", "made-up"], rationale: "r" },
      }),
    );
    expect(decision.add).toEqual(["bug"]);
    expect(decision.refusals).toEqual(["made-up"]);
    expect(decision.logs[0]).toEqual({
      level: "warning",
      text: "refused the off-sheet label 'made-up' — it is not on the effective sheet; not applied",
    });
  });

  it("refuses an entirely off-sheet answer with the exact red-run message", () => {
    expect(() =>
      decide(input({ assessment: { intent: "labels", labels: ["nope"], rationale: "r" } })),
    ).toThrow("the model's answer was entirely off-sheet — refusing rather than applying nothing");
  });

  it("accepts an empty verdict as valid and writes nothing", () => {
    const decision = decide(
      input({ assessment: { intent: "labels", labels: [], rationale: "None fit." } }),
    );
    expect(decision.add).toEqual([]);
    expect(decision.refusals).toEqual([]);
    expect(decision.remove).toEqual([]);
  });

  it("collapses and caps a multi-line rationale to one log line", () => {
    const decision = decide(
      input({
        assessment: { intent: "labels", labels: ["bug"], rationale: "first\nsecond\tline" },
      }),
    );
    const rationaleLog = decision.logs.find((log) => log.text.startsWith("rationale: "));
    expect(rationaleLog).toEqual({ level: "info", text: "rationale: first second line" });
  });

  it("caps a rationale at RATIONALE_CHARS characters", () => {
    const decision = decide(
      input({
        assessment: { intent: "labels", labels: ["bug"], rationale: "x".repeat(400) },
      }),
    );
    const rationaleLog = decision.logs.find((log) => log.text.startsWith("rationale: "));
    expect(rationaleLog?.text).toHaveLength("rationale: ".length + 300);
  });

  it("emits no rationale log for an empty rationale", () => {
    const decision = decide(
      input({ assessment: { intent: "labels", labels: ["bug"], rationale: "" } }),
    );
    expect(decision.logs.every((log) => !log.text.startsWith("rationale: "))).toBe(true);
  });

  it("warns before rationale, matching the run's announcement order", () => {
    const decision = decide(
      input({ assessment: { intent: "labels", labels: ["bug", "nope"], rationale: "r" } }),
    );
    expect(decision.logs.map((log) => log.level)).toEqual(["warning", "info"]);
  });
});

describe("decide — exclusive and priority are single-valued role rules", () => {
  it("applies a lone member of an exclusive role", () => {
    const decision = decide(
      input({
        evidence: {
          policy: {
            ...CONFIG,
            labels: { ...CONFIG.labels, exclusive: ["semantic-classification"] },
          },
        },
        assessment: { intent: "labels", labels: ["bug"], rationale: "r" },
      }),
    );
    expect(decision.add).toEqual(["bug"]);
  });

  it("refuses two members of one exclusive role — fail closed, no mutation", () => {
    expect(() =>
      decide(
        input({
          evidence: {
            policy: {
              ...CONFIG,
              labels: { ...CONFIG.labels, exclusive: ["semantic-classification"] },
            },
          },
          assessment: { intent: "labels", labels: ["bug", "docs"], rationale: "r" },
        }),
      ),
    ).toThrow("single-valued 'semantic-classification' role");
  });

  it("allows one label per exclusive role — different roles do not conflict", () => {
    const decision = decide(
      input({
        evidence: {
          policy: {
            ...CONFIG,
            labels: { ...CONFIG.labels, exclusive: ["semantic-classification"] },
          },
        },
        assessment: { intent: "labels", labels: ["bug", "question"], rationale: "r" },
      }),
    );
    expect(decision.add).toEqual(["bug", "question"]);
  });

  it("refuses an exclusive member when the thread already carries another of that role", () => {
    expect(() =>
      decide(
        input({
          evidence: {
            thread: {
              type: "issue",
              number: 7,
              title: "t",
              body: "b",
              labels: ["bug"],
              createdAt: "2026-01-01T00:00:00Z",
              creator: "author",
              state: "open",
            },
            policy: {
              ...CONFIG,
              labels: { ...CONFIG.labels, exclusive: ["semantic-classification"] },
            },
          },
          assessment: { intent: "labels", labels: ["docs"], rationale: "r" },
        }),
      ),
    ).toThrow("single-valued 'semantic-classification' role");
  });

  it("re-applying the same exclusive member is idempotent, not a conflict", () => {
    const decision = decide(
      input({
        evidence: {
          thread: {
            type: "issue",
            number: 7,
            title: "t",
            body: "b",
            labels: ["bug"],
            createdAt: "2026-01-01T00:00:00Z",
            creator: "author",
            state: "open",
          },
          policy: {
            ...CONFIG,
            labels: { ...CONFIG.labels, exclusive: ["semantic-classification"] },
          },
        },
        assessment: { intent: "labels", labels: ["bug"], rationale: "r" },
      }),
    );
    expect(decision.add).toEqual([]);
  });

  it("refuses two priority-role labels — ordering metadata is single-valued", () => {
    expect(() =>
      decide(
        input({
          evidence: {
            sheet: new Map([
              ["bug", "a bug"],
              ["docs", "a doc"],
              ["prio/a", "priority a"],
              ["prio/b", "priority b"],
            ]),
            policy: {
              ...CONFIG,
              labels: {
                ...CONFIG.labels,
                use: new Set(["bug", "docs", "prio/a", "prio/b"]),
                roles: new Map([
                  ["bug", "semantic-classification"],
                  ["prio/a", "priority"],
                  ["prio/b", "priority"],
                ]),
                priority: new Map(),
              },
            },
          },
          assessment: { intent: "labels", labels: ["prio/a", "prio/b"], rationale: "r" },
        }),
      ),
    ).toThrow("single-valued 'priority' role");
  });
  it("applies a lone priority-role label", () => {
    const decision = decide(
      input({
        evidence: {
          sheet: new Map([
            ["bug", "a bug"],
            ["prio/a", "priority a"],
          ]),
          policy: {
            ...CONFIG,
            labels: {
              ...CONFIG.labels,
              use: new Set(["bug", "prio/a"]),
              roles: new Map([
                ["bug", "semantic-classification"],
                ["prio/a", "priority"],
              ]),
              priority: new Map(),
            },
          },
        },
        assessment: { intent: "labels", labels: ["prio/a"], rationale: "r" },
      }),
    );
    expect(decision.add).toEqual(["prio/a"]);
  });
});

describe("decide — size semantics", () => {
  /**
   * @param {string[]} labels
   * @param {string | null} measured
   * @param {import("./size.mjs").SizeRung[]} [ladder]
   * @returns {Partial<import("./evidence.mjs").Evidence>}
   */
  const prEvidence = (labels, measured, ladder = LADDER) => ({
    thread: {
      type: "pr",
      number: 8,
      title: "t",
      body: "b",
      labels,
      createdAt: "2026-01-01T00:00:00Z",
      creator: "author",
      state: "open",
    },
    policy: { ...CONFIG, size: { exclude: [], ladder } },
    sheet: SHEET,
    labelMetadata: new Map(),
    files: [{ filename: "a.mjs", status: "modified", additions: 5, deletions: 0 }],
    measuredSize: measured === null ? null : { counted: 5, excluded: 0, files: 1, label: measured },
    eventAction: "opened",
    repository: { name: "repo", description: "d" },
  });

  it("adds the measured rung when the thread carries no size label", () => {
    const decision = decide(
      input({
        evidence: prEvidence([], "size/xs"),
        assessment: { intent: "labels", labels: ["bug"], rationale: "r" },
      }),
    );
    expect(decision.add).toContain("size/xs");
  });

  it("replaces a stale measured rung instead of adding beside it", () => {
    const decision = decide(
      input({
        evidence: prEvidence(["size/xl"], "size/xs"),
        assessment: { intent: "labels", labels: ["bug"], rationale: "r" },
      }),
    );
    expect(decision.add).toEqual(["bug", "size/xs"]);
    expect(decision.remove).toEqual([{ name: "size/xl", reason: "size" }]);
  });

  it("keeps the current rung when the measurement agrees with it", () => {
    const decision = decide(
      input({
        evidence: prEvidence(["size/xs"], "size/xs"),
        assessment: { intent: "labels", labels: ["bug"], rationale: "r" },
      }),
    );
    expect(decision.add).toEqual(["bug"]);
    expect(decision.remove).toEqual([]);
  });

  it("does not treat a measured rung as a label twice when the model names it", () => {
    const decision = decide(
      input({
        evidence: prEvidence([], "size/xs"),
        assessment: { intent: "labels", labels: ["bug", "size/xs"], rationale: "r" },
      }),
    );
    // size/xs is not on the offered sheet — the model cannot name it, and it
    // is never applied raw; the measured rung is added once, by code.
    expect(decision.refusals).not.toContain("size/xs");
    expect(decision.add.filter((name) => name === "size/xs")).toHaveLength(1);
  });

  it("treats a rung-only answer as entirely off-sheet on an issue, where there is no measurement", () => {
    expect(() =>
      decide(input({ assessment: { intent: "labels", labels: ["size/xs"], rationale: "r" } })),
    ).toThrow("the model's answer was entirely off-sheet — refusing rather than applying nothing");
  });

  it("replaces no size label when the config declares no size policy", () => {
    const decision = decide(
      input({
        evidence: {
          thread: {
            type: "pr",
            number: 8,
            title: "t",
            body: "b",
            labels: ["size/xl"],
            createdAt: "2026-01-01T00:00:00Z",
            creator: "author",
            state: "open",
          },
          policy: {
            labels: {
              use: new Set(["bug"]),
              roles: new Map([["bug", "semantic-classification"]]),
              exclusive: [],
              workflowMarkers: [],
              triageOwned: new Set(),
              priority: new Map(),
              needsMoreInfo: null,
              routing: {},
            },
            size: undefined,
            instructions: {},
          },
          sheet: SHEET,
          labelMetadata: new Map(),
          files: [{ filename: "a.mjs", status: "modified", additions: 5, deletions: 0 }],
          measuredSize: null,
          eventAction: "opened",
          repository: { name: "repo", description: "d" },
        },
        assessment: { intent: "labels", labels: ["bug"], rationale: "r" },
      }),
    );
    expect(decision.remove).toEqual([]);
    expect(decision.add).toEqual(["bug"]);
  });

  it("removes size labels in the order the ladder reads them", () => {
    const decision = decide(
      input({
        evidence: prEvidence(["size/xs", "size/xl"], "size/s"),
        assessment: { intent: "labels", labels: ["bug"], rationale: "r" },
      }),
    );
    expect(decision.remove.map((removal) => removal.name)).toEqual(["size/xs", "size/xl"]);
  });
});

describe("decide — workflow marker semantics", () => {
  /**
   * @param {string[]} threadLabels
   * @returns {Partial<import("./evidence.mjs").Evidence>}
   */
  const markerEvidence = (threadLabels) => ({
    thread: {
      type: "issue",
      number: 7,
      title: "t",
      body: "b",
      labels: threadLabels,
      createdAt: "2026-01-01T00:00:00Z",
      creator: "author",
      state: "open",
    },
    policy: {
      ...CONFIG,
      labels: { ...CONFIG.labels, workflowMarkers: ["needs triage"] },
    },
    sheet: SHEET,
    labelMetadata: new Map(),
    files: [],
    measuredSize: null,
    eventAction: "opened",
    repository: { name: "repo", description: "d" },
  });

  it("clears the marker once a semantic-classification label is accepted", () => {
    const decision = decide(
      input({
        evidence: markerEvidence(["needs triage"]),
        assessment: { intent: "labels", labels: ["bug"], rationale: "r" },
      }),
    );
    expect(decision.remove).toEqual([{ name: "needs triage", reason: "marker" }]);
  });

  it("keeps the marker when only non-category labels are accepted", () => {
    const decision = decide(
      input({
        evidence: markerEvidence(["needs triage"]),
        assessment: { intent: "labels", labels: ["question"], rationale: "r" },
      }),
    );
    expect(decision.remove).toEqual([]);
  });

  it("leaves every label alone when the config declares no marker", () => {
    const decision = decide(
      input({
        evidence: {
          thread: {
            type: "issue",
            number: 7,
            title: "t",
            body: "b",
            labels: ["needs triage"],
            createdAt: "2026-01-01T00:00:00Z",
            creator: "author",
            state: "open",
          },
        },
        assessment: { intent: "labels", labels: ["bug"], rationale: "r" },
      }),
    );
    expect(decision.remove).toEqual([]);
  });

  it("does not clear a marker the thread does not carry", () => {
    const decision = decide(
      input({
        evidence: markerEvidence(["bug"]),
        assessment: { intent: "labels", labels: ["bug"], rationale: "r" },
      }),
    );
    expect(decision.remove).toEqual([]);
  });

  it("clears all markers when a classification is accepted and the thread carries multiple", () => {
    const ev = markerEvidence(["needs triage", "needs review"]);
    const decision = decide(
      input({
        evidence: {
          ...ev,
          policy: {
            ...CONFIG,
            labels: { ...CONFIG.labels, workflowMarkers: ["needs triage", "needs review"] },
          },
        },
        assessment: { intent: "labels", labels: ["bug"], rationale: "r" },
      }),
    );
    expect(decision.remove).toEqual([
      { name: "needs triage", reason: "marker" },
      { name: "needs review", reason: "marker" },
    ]);
  });
});

describe("decide — comment intent", () => {
  it("produces a comment decision carrying the classification untouched", () => {
    const decision = decide(
      input({
        evidence: {
          thread: {
            type: "issue",
            number: 7,
            title: "t",
            body: "b",
            labels: [],
            createdAt: "2026-01-01T00:00:00Z",
            creator: "author",
            state: "open",
          },
          repository: { name: "repo", description: "d" },
          policy: null,
          sheet: null,
          labelMetadata: new Map(),
          files: [],
          measuredSize: null,
          eventAction: "opened",
        },
        assessment: { intent: "comment", classification: "a bug", rationale: "Because." },
      }),
    );
    expect(decision.kind).toBe("comment");
    expect(decision.add).toEqual([]);
    expect(decision.remove).toEqual([]);
    expect(decision.refusals).toEqual([]);
    expect(decision.comment).toEqual({ classification: "a bug", rationale: "Because." });
  });
});

describe("decide — issue evaluators (sheet mode)", () => {
  // The sheet-mode issue block reads evidence.quality, evidence.forgeSearch
  // and assessment.dimensions, and composes the decision only from maps the
  // config declares. These tests pin each dimension's derivation: the
  // deterministic routing map, the priority map and its triageOwned replace,
  // the needs-more-info label-versus-comment split, the relationship best
  // pick, and the fact that the decision surface offers no close/assign/
  // mention route at all.

  /**
   * @param {Partial<import("./evidence.mjs").Evidence>} [over]
   * @returns {Partial<import("./evidence.mjs").Evidence>}
   */
  const issueEvidence = (over = {}) => ({
    thread: {
      type: "issue",
      number: 7,
      title: "t",
      body: "b",
      labels: [],
      createdAt: "2026-01-01T00:00:00Z",
      creator: "author",
      state: "open",
    },
    policy: CONFIG,
    sheet: SHEET,
    labelMetadata: new Map([["bug", { name: "bug", description: "a bug", color: "blue" }]]),
    files: [],
    measuredSize: null,
    eventAction: "opened",
    repository: { name: "repo", description: "d" },
    ...over,
  });

  /**
   * `assess()` stamps every dimension slot on a real run; these tests
   * bypass it, so each fixture spreads its partial over the full five-slot
   * shape the Assessment contract requires.
   *
   * @param {import("./answer.mjs").IssueDimensions} dims
   * @returns {import("./assessment.mjs").AssessmentDimensions}
   */
  const fullDimensions = (dims) => ({
    classification: undefined,
    quality: undefined,
    relationships: undefined,
    priority: undefined,
    pr: undefined,
    ...dims,
  });

  it("routes deterministically by the matched form id", () => {
    const policy = {
      ...CONFIG,
      labels: { ...CONFIG.labels, routing: { "bug-report": "question" } },
    };
    const decision = decide(
      input({
        evidence: issueEvidence({
          policy,
          quality: {
            template: { id: "bug-report", name: "Bug report" },
            missingRequired: [],
            bodyLength: 10,
            urlCount: 0,
            fieldsPresent: [],
            templatesOverflow: false,
          },
        }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({}),
        },
      }),
    );
    // routing maps the form to the area label, added beside the classification.
    expect(decision.add).toEqual(["bug", "question"]);
  });

  it("derives the priority label from a severity on the map", () => {
    const policy = {
      ...CONFIG,
      labels: {
        ...CONFIG.labels,
        use: new Set(["bug", "p1", "p2"]),
        roles: new Map([
          ["bug", "semantic-classification"],
          ["p1", "priority"],
          ["p2", "priority"],
        ]),
        priority: new Map([["high", "p1"]]),
      },
    };
    const decision = decide(
      input({
        evidence: issueEvidence({ policy }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({ priority: { severity: "high", confidence: 0.9 } }),
        },
      }),
    );
    expect(decision.add).toEqual(["bug", "p1"]);
    expect(decision.remove).toEqual([]);
  });

  it("does not re-list a derived priority label the thread already carries", () => {
    const policy = {
      ...CONFIG,
      labels: {
        ...CONFIG.labels,
        use: new Set(["bug", "p1"]),
        roles: new Map([
          ["bug", "semantic-classification"],
          ["p1", "priority"],
        ]),
        priority: new Map([["high", "p1"]]),
      },
    };
    const decision = decide(
      input({
        evidence: issueEvidence({
          policy,
          thread: {
            type: "issue",
            number: 7,
            title: "t",
            body: "b",
            labels: ["p1"],
            createdAt: "2026-01-01T00:00:00Z",
            creator: "author",
            state: "open",
          },
        }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({ priority: { severity: "high", confidence: 0.9 } }),
        },
      }),
    );
    // The derived rung is already on the thread: a no-op, never a re-list —
    // in the decision, in the dry-run preview, and therefore in the write
    // (mutate sends `decision.add` verbatim).
    expect(decision.add).toEqual(["bug"]);
    expect(decision.remove).toEqual([]);
    const [line] = renderDryRun(decision);
    expect(line).toContain("would add [bug]");
    expect(line).not.toMatch(/p1/);
  });

  it("warns on an off-map severity and derives no priority label", () => {
    const policy = {
      ...CONFIG,
      labels: {
        ...CONFIG.labels,
        priority: new Map([["high", "p1"]]),
      },
    };
    const decision = decide(
      input({
        evidence: issueEvidence({ policy }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({ priority: { severity: "nowhere", confidence: 0.9 } }),
        },
      }),
    );
    expect(decision.add).toEqual(["bug"]);
    expect(
      decision.logs.some((log) =>
        log.text.includes("severity 'nowhere' is not on the labels.priority map"),
      ),
    ).toBe(true);
  });

  it("replaces a triage-owned priority label instead of leaving it beside the derived one", () => {
    const policy = {
      ...CONFIG,
      labels: {
        ...CONFIG.labels,
        use: new Set(["bug", "p1", "p2"]),
        roles: new Map([
          ["bug", "semantic-classification"],
          ["p1", "priority"],
          ["p2", "priority"],
        ]),
        triageOwned: new Set(["p2"]),
        priority: new Map([["high", "p1"]]),
      },
    };
    const decision = decide(
      input({
        evidence: issueEvidence({
          policy,
          thread: {
            type: "issue",
            number: 7,
            title: "t",
            body: "b",
            labels: ["p2"],
            createdAt: "2026-01-01T00:00:00Z",
            creator: "author",
            state: "open",
          },
        }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({ priority: { severity: "high", confidence: 0.9 } }),
        },
      }),
    );
    // The old owned priority is removed (reason "owned") and the derived one added.
    expect(decision.remove).toEqual([{ name: "p2", reason: "owned" }]);
    expect(decision.add).toEqual(["bug", "p1"]);
  });

  it("red-runs when a foreign priority-role label sits with the derived one and is not triage-owned", () => {
    const policy = {
      ...CONFIG,
      labels: {
        ...CONFIG.labels,
        use: new Set(["bug", "p1", "p2"]),
        roles: new Map([
          ["bug", "semantic-classification"],
          ["p1", "priority"],
          ["p2", "priority"],
        ]),
        triageOwned: new Set(),
        priority: new Map([["high", "p1"]]),
      },
    };
    expect(() =>
      decide(
        input({
          evidence: issueEvidence({
            policy,
            thread: {
              type: "issue",
              number: 7,
              title: "t",
              body: "b",
              labels: ["p2"],
              createdAt: "2026-01-01T00:00:00Z",
              creator: "author",
              state: "open",
            },
          }),
          assessment: {
            intent: "labels",
            labels: ["bug"],
            rationale: "r",
            dimensions: fullDimensions({ priority: { severity: "high", confidence: 0.9 } }),
          },
        }),
      ),
    ).toThrow(/single-valued 'priority' role/);
  });

  it("applies the needs-more-info label when declared and the issue is incomplete", () => {
    const policy = {
      ...CONFIG,
      labels: { ...CONFIG.labels, needsMoreInfo: "question" },
    };
    const decision = decide(
      input({
        evidence: issueEvidence({
          policy,
          quality: {
            template: null,
            missingRequired: ["Steps to reproduce"],
            bodyLength: 5,
            urlCount: 0,
            fieldsPresent: [],
            templatesOverflow: false,
          },
        }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({}),
        },
      }),
    );
    expect(decision.add).toEqual(["bug", "question"]);
    expect(decision.signal).toBeNull();
  });

  it("signals the missing-required fields when no needs-more-info label is declared", () => {
    // CONFIG declares needsMoreInfo: null — the judgement becomes a signal.
    const decision = decide(
      input({
        evidence: issueEvidence({
          quality: {
            template: null,
            missingRequired: ["Steps to reproduce"],
            bodyLength: 5,
            urlCount: 0,
            fieldsPresent: [],
            templatesOverflow: false,
          },
        }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({}),
        },
      }),
    );
    expect(decision.signal).toEqual({
      needsMoreInfo: ["Steps to reproduce"],
      modelJudgedQuality: false,
      related: null,
    });
  });

  it("signals a model-judged incompleteness even with no missing required fields", () => {
    const decision = decide(
      input({
        evidence: issueEvidence({
          quality: {
            template: null,
            missingRequired: [],
            bodyLength: 200,
            urlCount: 0,
            fieldsPresent: [],
            templatesOverflow: false,
          },
        }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({
            quality: { completeness: "missing-evidence", confidence: 0.8 },
          }),
        },
      }),
    );
    expect(decision.signal).toEqual({
      needsMoreInfo: [],
      modelJudgedQuality: true,
      related: null,
    });
  });

  it("picks the most confident relationship candidate", () => {
    const forgeSearch = {
      candidates: [
        { number: 10, title: "ten", state: "open", url: "u", createdAt: "2026-01-01T00:00:00Z" },
        { number: 11, title: "eleven", state: "open", url: "u", createdAt: "2026-01-01T00:00:00Z" },
      ],
      totalCount: 2,
      cappedAt: 10,
    };
    const decision = decide(
      input({
        evidence: issueEvidence({ forgeSearch }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({
            relationships: {
              candidates: [
                { index: 1, type: "duplicate", confidence: 0.6, evidence: "same crash" },
                { index: 0, type: "related", confidence: 0.4, evidence: "similar" },
              ],
            },
          }),
        },
      }),
    );
    expect(decision.signal?.related).toEqual({
      number: 11,
      title: "eleven",
      type: "duplicate",
    });
  });

  it("breaks a confidence tie toward the lowest candidate number", () => {
    const forgeSearch = {
      candidates: [
        { number: 10, title: "ten", state: "open", url: "u", createdAt: "2026-01-01T00:00:00Z" },
        { number: 11, title: "eleven", state: "open", url: "u", createdAt: "2026-01-01T00:00:00Z" },
      ],
      totalCount: 2,
      cappedAt: 10,
    };
    const decision = decide(
      input({
        evidence: issueEvidence({ forgeSearch }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({
            relationships: {
              candidates: [
                { index: 1, type: "duplicate", confidence: 0.5, evidence: "e" },
                { index: 0, type: "related", confidence: 0.5, evidence: "e" },
              ],
            },
          }),
        },
      }),
    );
    // Equal confidence -> the lower-numbered candidate (#10) wins.
    expect(decision.signal?.related?.number).toBe(10);
  });

  it("ignores off-vocabulary types and out-of-range indexes with a warning, signalling nothing", () => {
    const decision = decide(
      input({
        evidence: issueEvidence({
          forgeSearch: {
            candidates: [
              {
                number: 10,
                title: "ten",
                state: "open",
                url: "u",
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
            totalCount: 1,
            cappedAt: 10,
          },
        }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({
            relationships: {
              candidates: [
                { index: 5, type: "duplicate", confidence: 0.9, evidence: "oob" },
                { index: 0, type: "is-a-parent-of", confidence: 0.9, evidence: "off-vocab" },
              ],
            },
          }),
        },
      }),
    );
    expect(decision.signal).toBeNull();
    expect(decision.logs.some((log) => log.text.includes("ignored a relationship judgement"))).toBe(
      true,
    );
  });

  it("signals nothing when no dimension needs it", () => {
    const decision = decide(
      input({
        evidence: issueEvidence({
          quality: {
            template: null,
            missingRequired: [],
            bodyLength: 200,
            urlCount: 0,
            fieldsPresent: [],
            templatesOverflow: false,
          },
        }),
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({}),
        },
      }),
    );
    expect(decision.signal).toBeNull();
    expect(decision.add).toEqual(["bug"]);
  });

  it("is gated off for a PR thread even with a sheet", () => {
    const decision = decide(
      input({
        evidence: {
          thread: {
            type: "pr",
            number: 8,
            title: "t",
            body: "b",
            labels: [],
            createdAt: "2026-01-01T00:00:00Z",
            creator: "author",
            state: "open",
          },
          repository: { name: "repo", description: "d" },
          policy: {
            ...CONFIG,
            labels: {
              ...CONFIG.labels,
              needsMoreInfo: "question",
              routing: { "bug-report": "question" },
            },
          },
          sheet: SHEET,
          labelMetadata: new Map(),
          files: [],
          measuredSize: null,
          eventAction: "opened",
        },
        assessment: {
          intent: "labels",
          labels: ["bug"],
          rationale: "r",
          dimensions: fullDimensions({ priority: { severity: "high" } }),
        },
      }),
    );
    // The issue block never runs on a PR: no routing, no priority, no signal.
    expect(decision.add).toEqual(["bug"]);
    expect(decision.remove).toEqual([]);
    expect(decision.signal).toBeNull();
  });

  it("offers no close, assign or mention route on the decision surface", () => {
    const decision = decide(input());
    // The Decision shape (kind/add/remove/refusals/logs/rationale/comment/signal)
    // has no field that could carry a close, an assignee or a @mention; the
    // spec forbids all three and the shape makes them inexpressible.
    expect(decision).not.toHaveProperty("close");
    expect(decision).not.toHaveProperty("assign");
    expect(decision).not.toHaveProperty("mention");
    expect(JSON.stringify(decision)).not.toMatch(/@\w+/);
  });
});

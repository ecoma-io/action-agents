// Tests for the policy engine — the deterministic stage that turns Evidence
// and Assessment into the Decision. Every decision here is a pure function
// of the inputs: no chat, no forge. What these tests pin is that the model's
// judgement is bounded by the sheet, that size is measured and replaced not
// asked and added, that the workflow marker is cleared by code on a
// classification, that off-sheet answers are refused not coerced, and that
// the decision's logs carry the exact lines a run must announce.

import { describe, expect, it } from "vitest";

import { decide } from "./policy.mjs";

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
      thread: { type: "issue", number: 7, title: "t", body: "b", labels: [] },
      repository: { name: "repo", description: "d" },
      policy: CONFIG,
      sheet: SHEET,
      labelMetadata: new Map([["bug", { name: "bug", description: "a bug", color: "blue" }]]),
      files: [],
      measuredSize: null,
      eventAction: "opened",
      ...(overrides.evidence ?? {}),
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
        evidence: { thread: { type: "issue", number: 7, title: "t", body: "b", labels: ["bug"] } },
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
    ).toThrow(
      "the model's answer names two members of the single-valued 'semantic-classification' role",
    );
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
                priority: new Map([
                  ["prio/a", 1],
                  ["prio/b", 2],
                ]),
              },
            },
          },
          assessment: { intent: "labels", labels: ["prio/a", "prio/b"], rationale: "r" },
        }),
      ),
    ).toThrow("the model's answer names two members of the single-valued 'priority' role");
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
              priority: new Map([["prio/a", 1]]),
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
    thread: { type: "pr", number: 8, title: "t", body: "b", labels },
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
          thread: { type: "pr", number: 8, title: "t", body: "b", labels: ["size/xl"] },
          policy: {
            labels: {
              use: new Set(["bug"]),
              roles: new Map([["bug", "semantic-classification"]]),
              exclusive: [],
              workflowMarkers: [],
              triageOwned: new Set(),
              priority: new Map(),
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
    thread: { type: "issue", number: 7, title: "t", body: "b", labels: threadLabels },
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
          thread: { type: "issue", number: 7, title: "t", body: "b", labels: ["needs triage"] },
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
});

describe("decide — comment intent", () => {
  it("produces a comment decision carrying the classification untouched", () => {
    const decision = decide(
      input({
        evidence: {
          thread: { type: "issue", number: 7, title: "t", body: "b", labels: [] },
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

// Tests for `harmonise` incremental report — the structured accounting of a
// run's deterministic decisions.
//
// What is pinned: the declared shape is enforced fail-closed (unknown keys,
// missing mandatory fields, out-of-vocabulary values, and counts that
// contradict the per-pair list are each refused with a typed error — never
// coerced, never filled in); the report is deterministic (stable pair order,
// sparse reason maps in vocabulary order, byte-identical output across
// calls); the report is a frozen, losslessly serializable plain object with
// stable key order; rendering is a fixed-section markdown projection that
// collapses untrusted strings to one line and refuses to render past the
// declared length cap; and the empty run is a valid minimal report.

import { describe, expect, it } from "vitest";

import {
  MAX_REPORT_MARKDOWN_LENGTH,
  ReportLengthError,
  ReportValidationError,
  buildReport,
  renderReport,
} from "./report.mjs";

/**
 * A translated pair with a planned change shape; override any field. Pass
 * `changeShape: null` to drop the change shape entirely.
 *
 * @param {{identity?: string, outcome?: import("./report.mjs").PairOutcome, reason?: import("./report.mjs").SkipReason | import("./report.mjs").RefusalReason, changeShape?: import("./report.mjs").ChangeShape | null}} [overrides]
 * @returns {import("./report.mjs").PairFact}
 */
function pair(overrides = {}) {
  const {
    changeShape = { planning: "planned", changed: 1, unchanged: 2, added: 0, removed: 0 },
    ...rest
  } = overrides;
  return {
    identity: "vi manual/dev.md",
    outcome: "translated",
    ...rest,
    ...(changeShape === null ? {} : { changeShape }),
  };
}

/**
 * A small valid run: one translated pair with a planned shape, one pair
 * skipped as in-step. Override any top-level field.
 *
 * @param {Partial<import("./report.mjs").RunFacts>} [overrides]
 * @returns {import("./report.mjs").RunFacts}
 */
function facts(overrides = {}) {
  return {
    pairsTotal: 2,
    translated: 1,
    failed: 0,
    skipped: { "in-step": 1 },
    refused: {},
    pairs: [
      pair(),
      pair({
        identity: "vi guides/setup.md",
        outcome: "skipped",
        reason: "in-step",
        changeShape: null,
      }),
    ],
    degradations: [],
    publication: null,
    modelCalls: 2,
    ...overrides,
  };
}

/**
 * A run with zero of everything — the empty schedule is a real run.
 *
 * @returns {import("./report.mjs").RunFacts}
 */
function emptyFacts() {
  return facts({
    pairsTotal: 0,
    translated: 0,
    failed: 0,
    skipped: {},
    refused: {},
    pairs: [],
    degradations: [],
    publication: null,
    modelCalls: 0,
  });
}

/**
 * A deep clone of the facts, loosely typed — the harness refusal tests
 * mutate. The clone is itself proof the facts serialize as plain JSON.
 *
 * @param {Partial<import("./report.mjs").RunFacts>} [overrides]
 * @returns {any}
 */
function loose(overrides = {}) {
  return JSON.parse(JSON.stringify(facts(overrides)));
}

/**
 * Asserts `build` refuses with a {@link ReportValidationError} carrying
 * exactly `code`.
 *
 * @param {() => unknown} build
 * @param {string} code
 * @returns {void}
 */
function expectRefused(build, code) {
  /** @type {unknown} */
  let caught;
  try {
    build();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReportValidationError);
  expect(/** @type {ReportValidationError} */ (caught).code).toBe(code);
}

/**
 * Asserts `build` refuses with a {@link ReportLengthError} — the length cap,
 * a different failure from a malformed report.
 *
 * @param {() => unknown} build
 * @returns {void}
 */
function expectTooLong(build) {
  /** @type {unknown} */
  let caught;
  try {
    build();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReportLengthError);
  expect(caught).not.toBeInstanceOf(ReportValidationError);
}

describe("buildReport — a valid run", () => {
  it("builds the expected report", () => {
    expect(buildReport(facts())).toEqual({
      schemaVersion: 1,
      pairsTotal: 2,
      translated: 1,
      skipped: { "in-step": 1 },
      refused: {},
      failed: 0,
      pairs: [
        { identity: "vi guides/setup.md", outcome: "skipped", reason: "in-step" },
        {
          identity: "vi manual/dev.md",
          outcome: "translated",
          changeShape: { planning: "planned", changed: 1, unchanged: 2, added: 0, removed: 0 },
        },
      ],
      degradations: [],
      publication: null,
      modelCalls: 2,
    });
  });

  it("deep-freezes the report", () => {
    const report = buildReport(facts());
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.pairs)).toBe(true);
    expect(Object.isFrozen(report.skipped)).toBe(true);
    expect(Object.isFrozen(report.pairs[1])).toBe(true);
    expect(Object.isFrozen(report.pairs[1]?.changeShape)).toBe(true);
  });

  it("keeps a stable key order at every level", () => {
    const report = buildReport(facts());
    expect(Object.keys(report)).toEqual([
      "schemaVersion",
      "pairsTotal",
      "translated",
      "skipped",
      "refused",
      "failed",
      "pairs",
      "degradations",
      "publication",
      "modelCalls",
    ]);
    expect(Object.keys(report.pairs[1] ?? {})).toEqual(["identity", "outcome", "changeShape"]);
    expect(Object.keys(report.pairs[1]?.changeShape ?? {})).toEqual([
      "planning",
      "changed",
      "unchanged",
      "added",
      "removed",
    ]);
  });

  it("keeps only the reasons that occurred, in vocabulary order", () => {
    const report = buildReport(
      facts({
        pairsTotal: 4,
        translated: 0,
        skipped: {},
        refused: { "over-cap": 2, planner: 1, "frontmatter-guard": 1 },
        pairs: [
          pair({ identity: "a", outcome: "refused", reason: "over-cap", changeShape: null }),
          pair({ identity: "b", outcome: "refused", reason: "planner", changeShape: null }),
          pair({
            identity: "c",
            outcome: "refused",
            reason: "frontmatter-guard",
            changeShape: null,
          }),
          pair({ identity: "d", outcome: "refused", reason: "over-cap", changeShape: null }),
        ],
        modelCalls: 0,
      }),
    );
    expect(report.refused).toEqual({ planner: 1, "frontmatter-guard": 1, "over-cap": 2 });
    expect(Object.keys(report.refused)).toEqual(["planner", "frontmatter-guard", "over-cap"]);
  });

  it("round-trips degradation and publication fields", () => {
    const report = buildReport(
      facts({
        degradations: [
          { kind: "corrupt-tm", detail: "the memory file does not parse" },
          { kind: "corrupt-state", detail: "the state file on the branch does not parse" },
        ],
        publication: { branch: "harmonise/main-to-i18n", commit: "abc1234567" },
      }),
    );
    expect(report.degradations).toEqual([
      { kind: "corrupt-state", detail: "the state file on the branch does not parse" },
      { kind: "corrupt-tm", detail: "the memory file does not parse" },
    ]);
    expect(report.publication).toEqual({ branch: "harmonise/main-to-i18n", commit: "abc1234567" });
  });

  it("serializes losslessly to plain JSON", () => {
    const report = buildReport(
      facts({
        publication: { branch: "harmonise/main-to-i18n", commit: "abc1234567" },
        degradations: [{ kind: "corrupt-state", detail: "unreadable" }],
      }),
    );
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("does not mutate the facts it was built from", () => {
    const input = facts({
      publication: { branch: "harmonise/main-to-i18n", commit: "abc1234567" },
      degradations: [{ kind: "corrupt-state", detail: "unreadable" }],
    });
    const before = JSON.parse(JSON.stringify(input));
    buildReport(input);
    expect(input).toEqual(before);
  });

  it("orders pairs by identity whatever order the facts hold", () => {
    const report = buildReport(
      facts({
        pairs: [
          pair({ identity: "zz manual/z.md" }),
          pair({
            identity: "aa manual/a.md",
            outcome: "skipped",
            reason: "in-step",
            changeShape: null,
          }),
        ],
      }),
    );
    expect(report.pairs.map((entry) => entry.identity)).toEqual([
      "aa manual/a.md",
      "zz manual/z.md",
    ]);
  });
});

describe("buildReport — refused facts", () => {
  it("refuses a runFacts value that is not a plain object", () => {
    expectRefused(() => buildReport(null), "invalid_type");
    expectRefused(() => buildReport("a string"), "invalid_type");
    expectRefused(() => buildReport([facts()]), "invalid_type");
  });

  it("refuses an unknown top-level key", () => {
    const facts_ = loose();
    facts_.surprise = true;
    expectRefused(() => buildReport(facts_), "unknown_key");
  });

  it("refuses a missing mandatory top-level field", () => {
    const noCalls = loose();
    delete noCalls.modelCalls;
    expectRefused(() => buildReport(noCalls), "missing_field");

    const noMap = loose();
    delete noMap.skipped;
    expectRefused(() => buildReport(noMap), "missing_field");
  });

  it("refuses a count that is not a non-negative integer", () => {
    const fractional = loose();
    fractional.translated = 1.5;
    expectRefused(() => buildReport(fractional), "invalid_type");

    const negative = loose();
    negative.modelCalls = -1;
    expectRefused(() => buildReport(negative), "invalid_value");
  });

  it("refuses an unknown key inside a reason map", () => {
    const skipped = loose();
    skipped.skipped = { vibes: 1 };
    expectRefused(() => buildReport(skipped), "unknown_key");

    const refused = loose();
    refused.refused = { vibes: 1 };
    expectRefused(() => buildReport(refused), "unknown_key");
  });

  it("refuses a reason-map value that is not a non-negative integer", () => {
    const negative = loose();
    negative.skipped = { "in-step": -1 };
    expectRefused(() => buildReport(negative), "invalid_value");

    const fractional = loose();
    fractional.skipped = { "in-step": 0.5 };
    expectRefused(() => buildReport(fractional), "invalid_value");
  });

  it("refuses a pairs value that is not an array", () => {
    const facts_ = loose();
    facts_.pairs = "nope";
    expectRefused(() => buildReport(facts_), "invalid_type");
  });

  it("refuses an unknown key inside a pair", () => {
    const facts_ = loose();
    facts_.pairs[0].surprise = true;
    expectRefused(() => buildReport(facts_), "unknown_key");
  });

  it("refuses a missing pair identity and a non-string identity", () => {
    const absent = loose();
    delete absent.pairs[0].identity;
    expectRefused(() => buildReport(absent), "missing_field");

    const numeric = loose();
    numeric.pairs[0].identity = 42;
    expectRefused(() => buildReport(numeric), "invalid_value");

    const empty = loose();
    empty.pairs[0].identity = "";
    expectRefused(() => buildReport(empty), "invalid_value");
  });

  it("refuses an outcome outside the declared set", () => {
    const facts_ = loose();
    facts_.pairs[0].outcome = "vibes";
    expectRefused(() => buildReport(facts_), "invalid_value");
  });

  it("refuses a reason on an outcome that cannot carry one", () => {
    const facts_ = loose();
    facts_.pairs[0].reason = "in-step";
    expectRefused(() => buildReport(facts_), "invalid_value");
  });

  it("refuses a skipped or refused pair without its reason", () => {
    const facts_ = loose();
    delete facts_.pairs[1].reason;
    expectRefused(() => buildReport(facts_), "missing_field");
  });

  it("refuses a reason outside the declared vocabulary for its outcome", () => {
    const skip = loose();
    skip.pairs[1].reason = "vibes";
    expectRefused(() => buildReport(skip), "invalid_value");

    const refused = loose({
      pairsTotal: 1,
      translated: 0,
      skipped: {},
      refused: { "over-cap": 1 },
      pairs: [
        pair({
          identity: "fr guides/setup.md",
          outcome: "refused",
          reason: "over-cap",
          changeShape: null,
        }),
      ],
    });
    /** @type {any} */ (refused).pairs[0].reason = "in-step";
    expectRefused(() => buildReport(refused), "invalid_value");
  });

  it("refuses a duplicate pair identity", () => {
    const facts_ = loose();
    facts_.pairs[1].identity = facts_.pairs[0].identity;
    expectRefused(() => buildReport(facts_), "invalid_value");
  });

  it("refuses an unknown key inside a change shape", () => {
    const facts_ = loose();
    facts_.pairs[0].changeShape.surprise = true;
    expectRefused(() => buildReport(facts_), "unknown_key");
  });

  it("refuses a change shape whose planning is outside the declared set", () => {
    const facts_ = loose();
    facts_.pairs[0].changeShape.planning = "vibes";
    expectRefused(() => buildReport(facts_), "invalid_value");
  });

  it("refuses a planned shape that is missing a block count", () => {
    const facts_ = loose();
    delete facts_.pairs[0].changeShape.added;
    expectRefused(() => buildReport(facts_), "missing_field");
  });

  it("refuses a planned shape whose block count is not a non-negative integer", () => {
    const fractional = loose();
    fractional.pairs[0].changeShape.changed = 1.5;
    expectRefused(() => buildReport(fractional), "invalid_value");

    const negative = loose();
    negative.pairs[0].changeShape.changed = -1;
    expectRefused(() => buildReport(negative), "invalid_value");
  });

  it("refuses the two change-shape variants mixed into one another", () => {
    const wholeWithCounts = loose();
    wholeWithCounts.pairs[0].changeShape = { planning: "whole-file", changed: 1 };
    expectRefused(() => buildReport(wholeWithCounts), "invalid_value");

    const plannedWithReason = loose();
    plannedWithReason.pairs[0].changeShape.reason = "why";
    expectRefused(() => buildReport(plannedWithReason), "invalid_value");
  });

  it("refuses a whole-file reason that is not a non-empty string", () => {
    const facts_ = loose();
    facts_.pairs[0].changeShape = { planning: "whole-file", reason: "" };
    expectRefused(() => buildReport(facts_), "invalid_value");
  });

  it("refuses counts that contradict the per-pair list", () => {
    const total = loose();
    total.pairsTotal = 5;
    expectRefused(() => buildReport(total), "count_mismatch");

    const translated = loose();
    translated.translated = 2;
    expectRefused(() => buildReport(translated), "count_mismatch");

    const failed = loose();
    failed.failed = 1;
    expectRefused(() => buildReport(failed), "count_mismatch");
  });

  it("refuses a per-reason count that contradicts the per-pair list", () => {
    const absent = loose();
    delete absent.skipped["in-step"];
    expectRefused(() => buildReport(absent), "count_mismatch");

    const wrong = loose();
    wrong.skipped = { "in-step": 2 };
    expectRefused(() => buildReport(wrong), "count_mismatch");

    const ghost = loose();
    ghost.refused = { planner: 1 };
    expectRefused(() => buildReport(ghost), "count_mismatch");
  });

  it("refuses an unknown key inside a degradation and a kind outside the vocabulary", () => {
    const surprise = loose();
    surprise.degradations = [{ kind: "corrupt-state", detail: "unreadable", surprise: true }];
    expectRefused(() => buildReport(surprise), "unknown_key");

    const kind = loose();
    kind.degradations = [{ kind: "exploded", detail: "unreadable" }];
    expectRefused(() => buildReport(kind), "invalid_value");
  });

  it("refuses a degradation without its detail", () => {
    const facts_ = loose();
    facts_.degradations = [{ kind: "corrupt-state" }];
    expectRefused(() => buildReport(facts_), "missing_field");

    const empty = loose();
    empty.degradations = [{ kind: "corrupt-state", detail: "" }];
    expectRefused(() => buildReport(empty), "invalid_value");
  });

  it("refuses a degradations value that is not an array", () => {
    const facts_ = loose();
    facts_.degradations = null;
    expectRefused(() => buildReport(facts_), "invalid_type");
  });

  it("refuses a publication that is neither null nor a branch-and-commit object", () => {
    const facts_ = loose();
    facts_.publication = "nope";
    expectRefused(() => buildReport(facts_), "invalid_type");

    const surprise = loose();
    surprise.publication = { branch: "b", commit: "c", surprise: true };
    expectRefused(() => buildReport(surprise), "unknown_key");

    const half = loose();
    half.publication = { commit: "c" };
    expectRefused(() => buildReport(half), "missing_field");

    const empty = loose();
    empty.publication = { branch: "", commit: "c" };
    expectRefused(() => buildReport(empty), "invalid_value");
  });
});

describe("renderReport", () => {
  it("renders the stable markdown snapshot", () => {
    const report = buildReport(
      facts({
        publication: { branch: "harmonise/main-to-i18n", commit: "abc1234567" },
        degradations: [{ kind: "corrupt-tm", detail: "the memory file does not parse" }],
      }),
    );
    const expected =
      [
        "### Harmonise run report",
        "",
        "Pairs: 2 total — 1 translated, 1 skipped, 0 refused, 0 failed.",
        "Model calls: 2.",
        "",
        "#### Skipped",
        "",
        "- `in-step`: 1",
        "",
        "#### Pairs",
        "",
        "- `vi guides/setup.md` — skipped (`in-step`)",
        "- `vi manual/dev.md` — translated, blocks planned: changed 1, unchanged 2, added 0, removed 0",
        "",
        "#### Degradations",
        "",
        "- `corrupt-tm`: the memory file does not parse",
        "",
        "#### Publication",
        "",
        "- branch `harmonise/main-to-i18n`, commit `abc1234567`",
      ].join("\n") + "\n";
    expect(renderReport(report)).toBe(expected);
    expect(expected.length).toBeLessThan(MAX_REPORT_MARKDOWN_LENGTH);
  });

  it("renders the empty run as a valid minimal report", () => {
    const report = buildReport(emptyFacts());
    expect(renderReport(report)).toBe(
      [
        "### Harmonise run report",
        "",
        "Pairs: 0 total — 0 translated, 0 skipped, 0 refused, 0 failed.",
        "Model calls: 0.",
      ].join("\n") + "\n",
    );
  });

  it("renders a whole-file change shape with its reason", () => {
    const report = buildReport(
      facts({
        pairs: [
          pair({
            identity: "vi manual/dev.md",
            changeShape: {
              planning: "whole-file",
              reason: "no segmentation stage exists for the current source",
            },
          }),
          pair({
            identity: "vi guides/setup.md",
            outcome: "skipped",
            reason: "in-step",
            changeShape: null,
          }),
        ],
      }),
    );
    expect(renderReport(report)).toContain(
      "- `vi manual/dev.md` — translated, blocks whole-file " +
        "(no segmentation stage exists for the current source)",
    );
  });

  it("collapses newlines in strings the loop carried through", () => {
    const injected = buildReport(
      facts({
        pairsTotal: 1,
        translated: 1,
        skipped: {},
        pairs: [pair({ identity: "vi man\nual/dev.md — translated, blocks whole-file" })],
      }),
    );
    const rendered = renderReport(injected);
    expect(rendered).toContain(
      "- `vi man ual/dev.md — translated, blocks whole-file` — translated",
    );
    expect(rendered).not.toMatch(/^- `vi man$/m);

    const degraded = buildReport(
      facts({
        degradations: [
          { kind: "corrupt-state", detail: "the state file\non the branch is unreadable" },
        ],
      }),
    );
    expect(renderReport(degraded)).toContain(
      "- `corrupt-state`: the state file on the branch is unreadable",
    );
  });

  it("refuses to render past the declared length cap instead of truncating", () => {
    const many = facts({
      pairsTotal: 200,
      translated: 200,
      skipped: {},
      pairs: Array.from({ length: 200 }, (_, index) =>
        pair({ identity: `pair-${String(index)} of two hundred manual/dev.md` }),
      ),
      modelCalls: 200,
    });
    expectTooLong(() => renderReport(buildReport(many)));
  });

  it("is byte-for-byte deterministic across calls with identical input", () => {
    const input = facts({
      publication: { branch: "harmonise/main-to-i18n", commit: "abc1234567" },
      degradations: [{ kind: "corrupt-state", detail: "unreadable" }],
    });
    const first = buildReport(input);
    const second = buildReport(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(renderReport(first)).toBe(renderReport(second));
    expect(renderReport(first)).toBe(renderReport(first));
  });

  it("refuses a value that is not the object buildReport returns", () => {
    expectRefused(() => renderReport(null), "invalid_type");
    expectRefused(() => renderReport("a string"), "invalid_type");
  });
});

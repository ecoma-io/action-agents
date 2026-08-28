// Tests for the adversarial verification pass — the pure module. The plan
// is proven deterministic; the parser is proven fail-closed; the application
// proves the verifier can only ever remove.

import { describe, expect, it } from "vitest";

import {
  applyVerdicts,
  parseVerdict,
  planVerification,
  verifierMessages,
  VERDICT_REASON_CHARS,
  EXCERPT_LINE_CHARS,
} from "./verify.mjs";
import { createEvidence, FRAMING } from "#core/untrusted.mjs";

const READS = { "src/a.mjs": "line1\nline2\nline3\n" };

/**
 * @param {{ strategy?: import("./config.mjs").Strategy, lanes?: Record<string, import("./lanes.mjs").AttentionLane>, reads?: Record<string, string> }} [over]
 * @returns {import("./verify.mjs").VerificationPolicy}
 */
function makePolicy({ strategy = "standard", lanes = {}, reads = READS } = {}) {
  return {
    strategy,
    laneOf: (path) => lanes[path],
    recordedReads: new Map(Object.entries(reads)),
  };
}

/**
 * @param {Partial<import("./answer.mjs").Finding>} [over]
 * @returns {import("./answer.mjs").Finding}
 */
function finding(over = {}) {
  return { severity: "concern", file: "src/a.mjs", line: 2, message: "off-by-one", ...over };
}

describe("planVerification", () => {
  it("is deterministic — the same findings and policy yield the same plan", () => {
    const findings = [finding(), finding({ severity: "nit", line: 3, message: "typo" })];
    const policy = makePolicy({ strategy: "adversarial", lanes: { "src/a.mjs": "deep" } });
    const first = planVerification(findings, policy);
    const second = planVerification(findings, policy);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.items).toHaveLength(2);
  });

  it("plans a concern at standard strategy even on a skim lane", () => {
    const plan = planVerification([finding()], makePolicy({ lanes: { "src/a.mjs": "skim" } }));
    expect(plan.items).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
  });

  it("leaves a skim-lane nit unplanned at standard strategy — not even skipped", () => {
    const nit = finding({ severity: "nit", message: "typo" });
    const plan = planVerification([nit], makePolicy({ lanes: { "src/a.mjs": "skim" } }));
    expect(plan.items).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it("plans every severity under the adversarial strategy", () => {
    const nit = finding({ severity: "nit", message: "typo" });
    const plan = planVerification(
      [nit],
      makePolicy({ strategy: "adversarial", lanes: { "src/a.mjs": "skim" } }),
    );
    expect(plan.items).toHaveLength(1);
  });

  it("plans a nit on a deep lane at standard strategy — the lane is a threshold too", () => {
    const nit = finding({ severity: "nit", message: "typo" });
    const plan = planVerification([nit], makePolicy({ lanes: { "src/a.mjs": "deep" } }));
    expect(plan.items).toHaveLength(1);
  });

  it("skips a plannable finding whose file the loop never captured", () => {
    const plan = planVerification([finding()], makePolicy({ reads: {} }));
    expect(plan.items).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.reason).toContain("never captured");
  });

  it("skips a plannable finding whose anchor lies past the captured read", () => {
    const plan = planVerification([finding({ line: 99 })], makePolicy());
    expect(plan.items).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.reason).toContain("ends before the anchor");
  });

  it("numbers ids 1..n over the planned items in findings order", () => {
    const findings = [
      finding({ line: 1, message: "first" }),
      finding({ severity: "nit", line: 2, message: "second" }),
      finding({ line: 3, message: "third" }),
    ];
    const plan = planVerification(findings, makePolicy({ strategy: "adversarial" }));
    expect(plan.items.map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  it("cuts the evidence window around the anchor, capped per line", () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line${String(index + 1)}`);
    lines[4] = `x`.repeat(EXCERPT_LINE_CHARS + 50);
    const content = `${lines.join("\n")}\n`;
    const plan = planVerification(
      [finding({ line: 5 })],
      makePolicy({ reads: { "src/a.mjs": content } }),
    );
    const evidence = plan.items[0]?.evidence;
    if (!evidence) throw new Error("expected the plannable finding to carry evidence");
    expect(evidence.path).toBe("src/a.mjs");
    expect(evidence.lineStart).toBe(2);
    expect(evidence.lineEnd).toBe(8);
    expect(evidence.excerpt).toContain("2: line2");
    expect(evidence.excerpt).toContain("8: line8");
    expect(evidence.excerpt).not.toContain("9: line9");
    const anchorLine = evidence.excerpt.split("\n").find((line) => line.startsWith("5: "));
    expect(anchorLine?.length).toBeLessThanOrEqual(
      "5: ".length + EXCERPT_LINE_CHARS + "…[truncated]".length,
    );
    expect(anchorLine?.endsWith("…[truncated]")).toBe(true);
  });
});

describe("parseVerdict", () => {
  it("accepts a well-formed verdict", () => {
    const parsed = parseVerdict('{"verdict":"confirmed","reason":"the line is correct"}');
    expect(parsed).toEqual({ ok: true, verdict: "confirmed", reason: "the line is correct" });
  });

  it("accepts a fenced verdict", () => {
    const parsed = parseVerdict('```json\n{"verdict":"refuted","reason":"no"}\n```');
    expect(parsed).toEqual({ ok: true, verdict: "refuted", reason: "no" });
  });

  it("refuses an unknown key", () => {
    const parsed = parseVerdict('{"verdict":"confirmed","reason":"ok","confidence":1}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.defect).toContain("confidence");
  });

  it("refuses a missing reason", () => {
    const parsed = parseVerdict('{"verdict":"confirmed"}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.defect).toContain("reason");
  });

  it("refuses a verdict outside the vocabulary", () => {
    const parsed = parseVerdict('{"verdict":"partially","reason":"x"}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.defect).toContain("vocabulary");
  });

  it("refuses a non-string verdict", () => {
    const parsed = parseVerdict('{"verdict":1,"reason":"x"}');
    expect(parsed.ok).toBe(false);
  });

  it("refuses an empty reason", () => {
    const parsed = parseVerdict('{"verdict":"confirmed","reason":"   "}');
    expect(parsed.ok).toBe(false);
  });

  it("sanitises the reason — mentions broken, tags escaped", () => {
    const parsed = parseVerdict('{"verdict":"confirmed","reason":"@user said <b>hi</b>"}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.reason).toContain("@\u200Cuser");
      expect(parsed.reason).toContain("&lt;b>");
    }
  });

  it("caps a long reason at the declared bound, marked not silent", () => {
    const parsed = parseVerdict(`{"verdict":"confirmed","reason":"${"r".repeat(1000)}"}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.reason.length).toBeLessThanOrEqual(
        VERDICT_REASON_CHARS + "…[truncated]".length,
      );
      expect(parsed.reason.endsWith("…[truncated]")).toBe(true);
    }
  });
});

describe("applyVerdicts", () => {
  const plannedFinding = finding();
  const plan = planVerification([plannedFinding], makePolicy());

  it("publishes a confirmed finding unchanged", () => {
    const applied = applyVerdicts(
      [plannedFinding],
      [{ id: "1", verdict: "confirmed", reason: "holds" }],
      { strictness: "medium", plan },
    );
    expect(applied.findings).toEqual([plannedFinding]);
    expect(applied.drops).toHaveLength(0);
    expect(applied.refusals).toHaveLength(0);
  });

  it("drops a refuted finding, logging the finding's identity", () => {
    const applied = applyVerdicts(
      [plannedFinding],
      [{ id: "1", verdict: "refuted", reason: "the line is correct" }],
      { strictness: "medium", plan },
    );
    expect(applied.findings).toHaveLength(0);
    expect(applied.drops).toEqual([
      {
        id: "1",
        file: "src/a.mjs",
        line: 2,
        verdict: "refuted",
        reason: "the line is correct",
      },
    ]);
  });

  it("publishes an uncertain finding at medium and drops it at high", () => {
    /** @type {import("./verify.mjs").VerdictEntry[]} */
    const verdicts = [{ id: "1", verdict: "uncertain", reason: "cannot decide" }];
    const atMedium = applyVerdicts([plannedFinding], verdicts, { strictness: "medium", plan });
    expect(atMedium.findings).toEqual([plannedFinding]);
    const atHigh = applyVerdicts([plannedFinding], verdicts, { strictness: "high", plan });
    expect(atHigh.findings).toHaveLength(0);
    expect(atHigh.drops[0]?.verdict).toBe("uncertain");
  });

  it("refuses a verdict naming an id outside the plan — never maps by guess", () => {
    const applied = applyVerdicts(
      [plannedFinding],
      [{ id: "9", verdict: "refuted", reason: "wrong id" }],
      { strictness: "medium", plan },
    );
    expect(applied.findings).toEqual([plannedFinding]);
    expect(applied.refusals).toHaveLength(1);
    expect(applied.refusals[0]).toContain("9");
  });

  it("is fail-closed with an empty plan — every verdict refused, every finding published", () => {
    const unplanned = finding({ severity: "nit", message: "typo" });
    const emptyPlan = planVerification([unplanned], makePolicy({ lanes: { "src/a.mjs": "skim" } }));
    expect(emptyPlan.items).toHaveLength(0);
    const applied = applyVerdicts(
      [unplanned],
      [{ id: "1", verdict: "refuted", reason: "no plan" }],
      { strictness: "high", plan: emptyPlan },
    );
    expect(applied.findings).toEqual([unplanned]);
    expect(applied.refusals).toHaveLength(1);
    expect(applied.drops).toHaveLength(0);
  });

  it("removes only — the publication set is the input minus the drops", () => {
    const concern = finding({ line: 1, message: "one" });
    const nit = finding({ severity: "nit", line: 2, message: "two" });
    const other = finding({ line: 3, message: "three" });
    const wide = planVerification([concern, nit, other], makePolicy({ strategy: "adversarial" }));
    const applied = applyVerdicts(
      [concern, nit, other],
      [
        { id: "2", verdict: "refuted", reason: "gone" },
        { id: "1", verdict: "confirmed", reason: "holds" },
      ],
      { strictness: "high", plan: wide },
    );
    expect(applied.findings).toEqual([concern, other]);
    expect(applied.drops).toHaveLength(1);
  });
});

describe("verifierMessages", () => {
  it("wraps the claim and evidence as data, with the code-authored contract first", () => {
    const evidence = createEvidence(() => "fixedid");
    const item = {
      id: "1",
      finding: finding(),
      evidence: {
        path: "src/a.mjs",
        lineStart: 1,
        lineEnd: 3,
        excerpt: "1: line1\n2: line2\n3: line3",
      },
    };
    const messages = verifierMessages(item, evidence);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain('"confirmed"|"refuted"|"uncertain"');
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain(FRAMING);
    expect(messages[1]?.content).toContain("[evidence:fixedid verification]");
    expect(messages[1]?.content).toContain("off-by-one");
    expect(messages[1]?.content).toContain("2: line2");
  });
});

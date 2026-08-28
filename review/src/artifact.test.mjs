// Tests for the machine-readable run artifact — the pure module. The builder
// is proven fail-closed; the serialiser is proven byte-stable; the artifact
// round-trips the run's policy, risk table, coverage, phase log and gate
// table unchanged; and the comment is proven to be a projection of the same
// facts the artifact records.

import { describe, expect, it } from "vitest";

import { findingIdentity } from "./answer.mjs";
import {
  ArtifactError,
  assertFreshArtifact,
  buildArtifact,
  reviewArtifactSchemaVersion,
  serialiseArtifact,
  withCommentId,
} from "./artifact.mjs";
import { utf8Compare } from "./order.mjs";
import { MESSAGE_CHARS, renderComment } from "./render.mjs";
import { VERDICT_REASON_CHARS } from "./verify.mjs";

const HEAD = "0".repeat(40);
const OTHER_HEAD = "f".repeat(40);

/**
 * @param {Partial<import("./artifact.mjs").RunFacts>} [over]
 * @returns {import("./artifact.mjs").RunFacts}
 */
function facts(over = {}) {
  return {
    repository: "octocat/example",
    pullRequest: 7,
    headRef: HEAD,
    outcome: { classification: "published", reason: "Complete review published (2 findings)" },
    policy: { strictness: "high", strategy: "adversarial" },
    risk: [
      { path: "src/a.mjs", risk: "medium", lane: "standard" },
      { path: "src/b.mjs", risk: "low", lane: "skim" },
    ],
    findings: [
      {
        id: "1",
        lifecycle: "confirmed",
        verdict: "confirmed",
        reason: "the captured bounds check the index",
        severity: "concern",
        file: "src/a.mjs",
        line: 2,
        message: "off-by-one",
        provenance: { path: "src/a.mjs", startLine: 1, endLine: 3 },
      },
      {
        severity: "nit",
        file: "src/b.mjs",
        line: 9,
        message: "typo",
        provenance: { path: "src/b.mjs", startLine: 9, endLine: 9 },
      },
    ],
    verification: { gate: { passed: true } },
    gates: [
      { gate: "conclusion", passed: true },
      { gate: "bound", passed: true },
      { gate: "coverage", passed: true },
      { gate: "provenance", passed: true },
      { gate: "verification", passed: true },
    ],
    coverage: { total: 2, covered: ["src/a.mjs"], uncovered: ["src/b.mjs"] },
    phases: [
      { from: "orient", to: "investigate" },
      { from: "investigate", to: "conclude" },
    ],
    provenance: { commentId: 42 },
    ...over,
  };
}

/**
 * A deep clone of the default facts, handed to a mutator with the type system
 * out of the way — every refusal test corrupts exactly one thing.
 *
 * @param {(facts: any) => void} mutate
 * @returns {any}
 */
function tampered(mutate) {
  const facts = /** @type {any} */ (structuredClone(base()));
  mutate(facts);
  return facts;
}

function base() {
  return facts();
}

describe("buildArtifact", () => {
  it("builds the expected artifact from valid facts", () => {
    const artifact = buildArtifact(facts());
    expect(artifact.schemaVersion).toBe(reviewArtifactSchemaVersion);
    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.repository).toBe("octocat/example");
    expect(artifact.pullRequest).toBe(7);
    expect(artifact.headRef).toBe(HEAD);
    expect(artifact.outcome).toEqual({
      classification: "published",
      reason: "Complete review published (2 findings)",
    });
    expect(artifact.policy).toEqual({ strictness: "high", strategy: "adversarial" });
    expect(artifact.risk).toEqual(facts().risk);
    expect(artifact.gates).toEqual(facts().gates);
    expect(artifact.findings).toHaveLength(2);
    const [first, second] = artifact.findings;
    if (first === undefined || second === undefined) throw new Error("expected two findings");
    expect(first).toEqual({
      identity: findingIdentity({
        severity: "concern",
        file: "src/a.mjs",
        line: 2,
        message: "off-by-one",
      }),
      severity: "concern",
      file: "src/a.mjs",
      line: 2,
      message: "off-by-one",
      lifecycle: "confirmed",
      verdict: "confirmed",
      reason: "the captured bounds check the index",
      provenance: { path: "src/a.mjs", startLine: 1, endLine: 3 },
    });
    expect(second.identity).toBe(
      findingIdentity({ severity: "nit", file: "src/b.mjs", line: 9, message: "typo" }),
    );
    expect(second).not.toHaveProperty("lifecycle");
    expect(second).not.toHaveProperty("verdict");
    expect(second).not.toHaveProperty("reason");
    expect(artifact.verification).toEqual({
      gate: { passed: true },
      verdicts: [
        {
          findingIdentity: first.identity,
          verdict: "confirmed",
          lifecycle: "confirmed",
          reason: "the captured bounds check the index",
        },
      ],
    });
    expect(artifact.coverage).toEqual({
      total: 2,
      covered: ["src/a.mjs"],
      uncovered: ["src/b.mjs"],
    });
    expect(artifact.phases).toEqual(facts().phases);
    expect(artifact.provenance).toEqual({ commentId: 42 });
  });

  it("derives every bound verdict from its finding — the ledger cannot disagree with the rows", () => {
    const artifact = buildArtifact(facts());
    const first = artifact.findings[0];
    if (first === undefined) throw new Error("expected a finding");
    expect(artifact.verification.verdicts).toHaveLength(1);
    const entry = artifact.verification.verdicts[0];
    expect(entry).toEqual({
      findingIdentity: first.identity,
      verdict: first.verdict,
      lifecycle: first.lifecycle,
      reason: first.reason,
    });
  });

  it("gives an unresolved finding no verdict entry — the state rides on the finding itself", () => {
    const skipped = facts({
      findings: [
        {
          lifecycle: "unresolved",
          reason: "the read that covered it was quarantined",
          severity: "concern",
          file: "src/a.mjs",
          line: 2,
          message: "off-by-one",
          provenance: { path: "src/a.mjs", startLine: 1, endLine: 3 },
        },
      ],
      verification: { gate: { passed: true } },
    });
    const artifact = buildArtifact(skipped);
    expect(artifact.verification.verdicts).toEqual([]);
    expect(artifact.findings[0]?.lifecycle).toBe("unresolved");
    expect(artifact.findings[0]).not.toHaveProperty("verdict");
  });

  it("carries an uncertain verdict as an unresolved lifecycle with its entry", () => {
    const uncertain = facts({
      findings: [
        {
          id: "1",
          lifecycle: "unresolved",
          verdict: "uncertain",
          reason: "the evidence was ambiguous",
          severity: "concern",
          file: "src/a.mjs",
          line: 2,
          message: "off-by-one",
          provenance: { path: "src/a.mjs", startLine: 1, endLine: 3 },
        },
      ],
    });
    const artifact = buildArtifact(uncertain);
    expect(artifact.verification.verdicts).toHaveLength(1);
    expect(artifact.verification.verdicts[0]?.lifecycle).toBe("unresolved");
    expect(artifact.findings[0]?.lifecycle).toBe("unresolved");
  });

  it("is frozen — the code's record is not mutable by a consumer", () => {
    const artifact = buildArtifact(facts());
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.findings)).toBe(true);
    expect(Object.isFrozen(artifact.findings[0])).toBe(true);
    expect(Object.isFrozen(artifact.verification)).toBe(true);
    expect(Object.isFrozen(artifact.verification.verdicts)).toBe(true);
    expect(Object.isFrozen(artifact.outcome)).toBe(true);
  });

  it("round-trips the policy, risk table, coverage, phase log and gate table unchanged", () => {
    const input = facts();
    const artifact = buildArtifact(input);
    expect(artifact.policy).toStrictEqual(input.policy);
    expect(artifact.risk).toStrictEqual(input.risk);
    expect(artifact.coverage).toStrictEqual(input.coverage);
    expect(artifact.phases).toStrictEqual(input.phases);
    expect(artifact.gates).toStrictEqual(input.gates);
  });

  it("preserves finding order as given — no reordering, no sorting", () => {
    const ordered = facts({
      findings: [
        {
          severity: "nit",
          file: "src/z.mjs",
          line: 1,
          message: "zzz",
          provenance: { path: "src/z.mjs", startLine: 1, endLine: 1 },
        },
        {
          severity: "concern",
          file: "src/a.mjs",
          line: 1,
          message: "aaa",
          provenance: { path: "src/a.mjs", startLine: 1, endLine: 2 },
        },
      ],
    });
    const artifact = buildArtifact(ordered);
    expect(artifact.findings.map((f) => f.file)).toEqual(["src/z.mjs", "src/a.mjs"]);
    expect(JSON.stringify(buildArtifact(ordered).findings)).toBe(JSON.stringify(artifact.findings));
  });

  it("allows an empty publication set — a run that found nothing", () => {
    const empty = facts({
      findings: [],
      outcome: { classification: "published", reason: "Complete review published (0 findings)" },
    });
    const artifact = buildArtifact(empty);
    expect(artifact.findings).toEqual([]);
    expect(artifact.verification.verdicts).toEqual([]);
  });
});

describe("buildArtifact refusals", () => {
  it("refuses a non-object run facts", () => {
    expect(() => buildArtifact(/** @type {any} */ (null))).toThrow(ArtifactError);
    expect(() => buildArtifact(/** @type {any} */ ("nope"))).toThrow(ArtifactError);
    expect(() => buildArtifact(/** @type {any} */ (undefined))).toThrow(ArtifactError);
    expect(() => buildArtifact(/** @type {any} */ ([facts()]))).toThrow(ArtifactError);
  });

  it("refuses an unknown top-level key — including the retired separate verdicts list", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.extra = "nope";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.verdicts = [{ id: "1", verdict: "confirmed", lifecycle: "confirmed", reason: "x" }];
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it.each([
    [
      "outcome",
      (/** @type {any} */ f) => {
        f.outcome.extra = "x";
      },
    ],
    [
      "policy",
      (/** @type {any} */ f) => {
        f.policy.extra = "x";
      },
    ],
    [
      "risk row",
      (/** @type {any} */ f) => {
        f.risk[0].extra = "x";
      },
    ],
    [
      "finding",
      (/** @type {any} */ f) => {
        f.findings[0].extra = "x";
      },
    ],
    [
      "finding provenance",
      (/** @type {any} */ f) => {
        f.findings[0].provenance.extra = "x";
      },
    ],
    [
      "verification",
      (/** @type {any} */ f) => {
        f.verification.extra = "x";
      },
    ],
    [
      "verification gate",
      (/** @type {any} */ f) => {
        f.verification.gate.extra = "x";
      },
    ],
    [
      "gate entry",
      (/** @type {any} */ f) => {
        f.gates[0].extra = "x";
      },
    ],
    [
      "coverage",
      (/** @type {any} */ f) => {
        f.coverage.extra = "x";
      },
    ],
    [
      "phase entry",
      (/** @type {any} */ f) => {
        f.phases[0].extra = "x";
      },
    ],
    [
      "provenance",
      (/** @type {any} */ f) => {
        f.provenance.extra = "x";
      },
    ],
  ])("refuses an unknown key in %s", (_name, mutate) => {
    expect(() => buildArtifact(tampered(mutate))).toThrow(ArtifactError);
  });

  it("refuses a missing mandatory field", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.headRef;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.outcome.reason;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.risk;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.verification;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.verification.gate;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.gates;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.coverage;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.findings[0].severity;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.findings[0].provenance;
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("raises typed ArtifactError instances naming the defect", () => {
    try {
      buildArtifact(
        tampered((f) => {
          delete f.headRef;
        }),
      );
      expect.unreachable("expected buildArtifact to refuse");
    } catch (error) {
      const typed = /** @type {ArtifactError} */ (error);
      expect(typed).toBeInstanceOf(ArtifactError);
      expect(typed.name).toBe("ArtifactError");
      expect(typed.message).toMatch(/headRef/);
      expect(typed.message).toMatch(/refused/);
    }
  });

  it("refuses a head ref that is not a 40-char hex sha", () => {
    expect(() => buildArtifact(facts({ headRef: "not-a-sha" }))).toThrow(ArtifactError);
    expect(() => buildArtifact(facts({ headRef: "" }))).toThrow(ArtifactError);
  });

  it("refuses a non-positive pull request number", () => {
    expect(() => buildArtifact(facts({ pullRequest: 0 }))).toThrow(ArtifactError);
  });

  it.each([
    [
      "classification",
      (/** @type {any} */ f) => {
        f.outcome.classification = "published?";
      },
    ],
    [
      "strictness",
      (/** @type {any} */ f) => {
        f.policy.strictness = "ultra";
      },
    ],
    [
      "strategy",
      (/** @type {any} */ f) => {
        f.policy.strategy = "aggressive";
      },
    ],
    [
      "risk level",
      (/** @type {any} */ f) => {
        f.risk[0].risk = "existential";
      },
    ],
    [
      "attention lane",
      (/** @type {any} */ f) => {
        f.risk[0].lane = "deepish";
      },
    ],
    [
      "severity",
      (/** @type {any} */ f) => {
        f.findings[0].severity = "blocker";
      },
    ],
    [
      "verdict value",
      (/** @type {any} */ f) => {
        f.findings[0].verdict = "maybe";
      },
    ],
    [
      "lifecycle state",
      (/** @type {any} */ f) => {
        f.findings[0].lifecycle = "candidate";
      },
    ],
    [
      "gate name",
      (/** @type {any} */ f) => {
        f.gates[0].gate = "vibes";
      },
    ],
    [
      "phase name",
      (/** @type {any} */ f) => {
        f.phases[0].from = "scan";
      },
    ],
  ])("refuses a %s outside the vocabulary", (_name, mutate) => {
    expect(() => buildArtifact(tampered(mutate))).toThrow(ArtifactError);
  });

  it("refuses a risk table that is not byte-wise sorted by path or that duplicates a path", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          const [a, b] = f.risk;
          f.risk = [b, a];
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.risk[1].path = "src/a.mjs";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.risk[0].path = "";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.risk = "nope";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.risk[0] = { path: "src/a.mjs", risk: "medium" };
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a finding message over the documented cap, accepts one at it", () => {
    const over = facts({
      findings: [
        {
          id: "1",
          lifecycle: "confirmed",
          verdict: "confirmed",
          reason: "ok",
          severity: "concern",
          file: "src/a.mjs",
          line: 2,
          message: "x".repeat(MESSAGE_CHARS + 1),
          provenance: { path: "src/a.mjs", startLine: 1, endLine: 3 },
        },
      ],
    });
    expect(() => buildArtifact(over)).toThrow(ArtifactError);
    const atCap = facts({
      findings: [
        {
          id: "1",
          lifecycle: "confirmed",
          verdict: "confirmed",
          reason: "ok",
          severity: "concern",
          file: "src/a.mjs",
          line: 2,
          message: "x".repeat(MESSAGE_CHARS),
          provenance: { path: "src/a.mjs", startLine: 1, endLine: 3 },
        },
      ],
    });
    expect(() => buildArtifact(atCap)).not.toThrow();
  });

  it("refuses a verdict reason over the documented cap", () => {
    const over = facts({
      findings: [
        {
          id: "1",
          lifecycle: "confirmed",
          verdict: "confirmed",
          reason: "y".repeat(VERDICT_REASON_CHARS + 1),
          severity: "concern",
          file: "src/a.mjs",
          line: 2,
          message: "off-by-one",
          provenance: { path: "src/a.mjs", startLine: 1, endLine: 3 },
        },
      ],
    });
    expect(() => buildArtifact(over)).toThrow(ArtifactError);
  });

  it("refuses empty or non-string finding and outcome text", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].message = "";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].message = 3;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].reason = "";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.outcome.reason = "";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a non-positive or fractional finding line", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].line = 0;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].line = 1.5;
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a finding provenance that captures no lines or names no path", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].provenance.startLine = 3;
          f.findings[0].provenance.endLine = 1;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].provenance.startLine = 0;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].provenance.endLine = 1.5;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].provenance.path = "";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.findings[0].provenance.endLine;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].provenance = "src/a.mjs:1-3";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a lifecycle without its reason, or a reason without a lifecycle", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.findings[0].reason;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.findings[0].lifecycle;
          delete f.findings[0].verdict;
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a planned finding with no lifecycle — never left a candidate", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.findings[0].lifecycle;
          delete f.findings[0].verdict;
          delete f.findings[0].reason;
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a lifecycle a candidate never publishes", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].lifecycle = "candidate";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a duplicate finding id", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[1].id = "1";
          f.findings[1].lifecycle = "unresolved";
          f.findings[1].verdict = "uncertain";
          f.findings[1].reason = "second";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a verdict whose lifecycle does not follow from the verdict", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].lifecycle = "refuted";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a confirmed or refuted lifecycle with no verdict bound", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.findings[0].verdict;
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a bound verdict missing its id, lifecycle or reason", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.findings[0].id;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.findings[0].reason;
          f.findings[0].lifecycle = "unresolved";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a non-planned lifecycle above unresolved — only a skip survives without an id", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          delete f.findings[0].id;
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("accepts a skipped finding — unresolved with no id and no verdict", () => {
    const skipped = facts({
      findings: [
        {
          lifecycle: "unresolved",
          reason: "the finding's file was gone from the workspace",
          severity: "concern",
          file: "src/gone.mjs",
          line: 4,
          message: "unreachable",
          provenance: { path: "src/gone.mjs", startLine: 1, endLine: 4 },
        },
      ],
    });
    const artifact = buildArtifact(skipped);
    expect(artifact.verification.verdicts).toEqual([]);
    expect(artifact.findings[0]?.lifecycle).toBe("unresolved");
    expect(artifact.findings[0]).not.toHaveProperty("id");
  });

  it("accepts an unplanned finding — no id, no lifecycle, published as it arrived", () => {
    const skim = facts({
      findings: [
        {
          severity: "nit",
          file: "src/b.mjs",
          line: 9,
          message: "typo",
          provenance: { path: "src/b.mjs", startLine: 9, endLine: 9 },
        },
      ],
    });
    const artifact = buildArtifact(skim);
    expect(artifact.findings[0]).not.toHaveProperty("lifecycle");
  });

  it("refuses a gate table that is not the declared gates in the declared order", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.gates = f.gates.slice(0, 4);
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          const [first, second] = f.gates;
          f.gates[0] = second;
          f.gates[1] = first;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.gates[2].gate = "vibes";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.gates = "nope";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.gates[0].passed = "yes";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a gate outcome that passes with a reason or fails without one", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.gates[0].reason = "unexpected";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.gates[2].passed = false;
          delete f.gates[2].reason;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.gates[2].passed = false;
          f.gates[2].reason = "";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.verification.gate = { passed: true, reason: "unexpected" };
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.verification.gate = { passed: false };
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.verification.gate = { passed: "yes" };
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a verification slice that disagrees with the gate table's verification entry", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.verification.gate = { passed: false, reason: "could not confirm one finding" };
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.gates[4].passed = false;
          f.gates[4].reason = "could not confirm one finding";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a coverage summary that does not partition the expected set", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.coverage.total = 3;
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.coverage.total = -1;
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a path that is both covered and uncovered", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.coverage.uncovered = ["src/a.mjs"];
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a coverage list that is not byte-wise sorted", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.coverage.covered = ["src/b.mjs", "src/a.mjs"];
          f.coverage.uncovered = [];
          f.coverage.total = 2;
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a non-array or non-string coverage list", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.coverage.covered = "src/a.mjs";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.coverage.uncovered = [3];
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a non-array findings, risk or gates list", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings = "nope";
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.gates = "nope";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a no-op or unknown phase transition", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.phases[0] = { from: "orient", to: "orient" };
        }),
      ),
    ).toThrow(ArtifactError);
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.phases[0] = { from: "compile", to: "conclude" };
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a provenance commentId that is not a positive integer", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.provenance.commentId = 0;
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("allows an empty provenance — a run that wrote nothing", () => {
    const noWrite = facts({ provenance: {} });
    expect(buildArtifact(noWrite).provenance).toEqual({});
  });
});

describe("assertFreshArtifact", () => {
  it("accepts an artifact whose head ref matches the pull request's head", () => {
    const artifact = buildArtifact(facts());
    expect(() => assertFreshArtifact(artifact, HEAD)).not.toThrow();
  });

  it("refuses a stale snapshot naming both heads", () => {
    const artifact = buildArtifact(facts());
    try {
      assertFreshArtifact(artifact, OTHER_HEAD);
      expect.unreachable("expected assertFreshArtifact to refuse");
    } catch (error) {
      const typed = /** @type {ArtifactError} */ (error);
      expect(typed).toBeInstanceOf(ArtifactError);
      expect(typed.message).toMatch(/stale snapshot/);
      expect(typed.message).toContain(HEAD.slice(0, 12));
      expect(typed.message).toContain(OTHER_HEAD.slice(0, 12));
    }
  });

  it("refuses a head ref that is not a 40-char hex sha on either side", () => {
    const artifact = buildArtifact(facts());
    expect(() => assertFreshArtifact(artifact, "main")).toThrow(ArtifactError);
    expect(() => assertFreshArtifact(artifact, "")).toThrow(ArtifactError);
    const foreign = /** @type {any} */ ({ ...artifact, headRef: "main" });
    expect(() => assertFreshArtifact(foreign, HEAD)).toThrow(ArtifactError);
  });
});

describe("withCommentId", () => {
  it("attaches the comment's identity and serialises to the canonical bytes", () => {
    const builtLate = withCommentId(buildArtifact(facts({ provenance: {} })), 42);
    expect(serialiseArtifact(builtLate)).toBe(serialiseArtifact(buildArtifact(facts())));
  });

  it("returns a frozen record whose provenance is frozen", () => {
    const built = withCommentId(buildArtifact(facts({ provenance: {} })), 42);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.provenance)).toBe(true);
  });
  it("refuses to attach a second comment", () => {
    const built = withCommentId(buildArtifact(facts({ provenance: {} })), 42);
    expect(() => withCommentId(built, 43)).toThrow(ArtifactError);
  });

  it("refuses an id that is not a positive integer", () => {
    const fresh = buildArtifact(facts({ provenance: {} }));
    for (const id of [0, -1, 1.5, Number.NaN, "7"]) {
      expect(() => withCommentId(fresh, /** @type {any} */ (id))).toThrow(ArtifactError);
    }
  });
});

describe("the comment is a projection of the same facts", () => {
  const COMPLETE = "Complete";
  const PARTIAL = "Partial";

  it("renders the head, coverage counts and every anchored finding the artifact records", () => {
    const input = facts();
    const artifact = buildArtifact(input);
    const body = renderComment({
      status: COMPLETE,
      headSha: input.headRef,
      summary: "one concern survived verification",
      findings: input.findings,
      strictness: input.policy.strictness,
      coverage: { ...input.coverage, covered: input.coverage.covered },
    });
    expect(body).toContain(`Reviewed head \`${artifact.headRef}\``);
    expect(body).toContain(
      `Changed files examined: ${String(artifact.coverage.covered.length)}/${String(artifact.coverage.total)}.`,
    );
    for (const finding of artifact.findings) {
      expect(body).toContain(`\`${finding.file}:${String(finding.line)}\``);
    }
    const first = artifact.findings[0];
    if (first === undefined) throw new Error("expected a finding");
    expect(body).toContain("evidence: `src/a.mjs:1-3`");
  });

  it("a complete posture means every gate passed — a partial one names the gate the artifact refused", () => {
    const input = facts();
    const artifact = buildArtifact(input);
    const allPassed = artifact.gates.every((gate) => gate.passed);
    expect(allPassed).toBe(true);

    const failedReason = "verification could not confirm one finding";
    const partialFacts = facts({
      gates: [
        { gate: "conclusion", passed: true },
        { gate: "bound", passed: true },
        { gate: "coverage", passed: true },
        { gate: "provenance", passed: true },
        { gate: "verification", passed: false, reason: failedReason },
      ],
      verification: { gate: { passed: false, reason: failedReason } },
    });
    const partial = buildArtifact(partialFacts);
    const failed = partial.gates.find((gate) => !gate.passed);
    expect(failed?.reason).toBe(failedReason);
    const body = renderComment({
      status: PARTIAL,
      headSha: partialFacts.headRef,
      summary: "one concern survived verification",
      findings: partialFacts.findings,
      strictness: partialFacts.policy.strictness,
      ...(failed?.reason === undefined ? {} : { partialReason: failed.reason }),
      coverage: { ...partialFacts.coverage },
    });
    expect(body).toContain(`> ⚠️ This review is partial: ${failedReason}`);
  });
});

describe("serialiseArtifact", () => {
  it("produces byte-identical output across two calls with identical input", () => {
    const first = serialiseArtifact(buildArtifact(facts()));
    const second = serialiseArtifact(buildArtifact(facts()));
    expect(first).toBe(second);
  });

  it("includes the schema version", () => {
    expect(serialiseArtifact(buildArtifact(facts()))).toContain('"schemaVersion":2');
  });

  it("serialises to valid JSON that parses back to the artifact", () => {
    const artifact = buildArtifact(facts());
    expect(JSON.parse(serialiseArtifact(artifact))).toStrictEqual(artifact);
  });

  it("is deterministic across key insertion-order shuffles of equivalent inputs (builder normalises)", () => {
    const ordered = facts();
    const shuffled = {
      provenance: { commentId: 42 },
      phases: ordered.phases.map((p) => ({ to: p.to, from: p.from })),
      coverage: {
        uncovered: ordered.coverage.uncovered,
        covered: ordered.coverage.covered,
        total: ordered.coverage.total,
      },
      gates: ordered.gates.map((g) =>
        "reason" in g
          ? { reason: g.reason, passed: g.passed, gate: g.gate }
          : { passed: g.passed, gate: g.gate },
      ),
      verification: {
        gate: { passed: ordered.verification.gate.passed },
      },
      risk: ordered.risk.map((r) => ({ lane: r.lane, risk: r.risk, path: r.path })),
      findings: ordered.findings.map((f) => ({
        message: f.message,
        line: f.line,
        file: f.file,
        severity: f.severity,
        provenance: {
          endLine: f.provenance.endLine,
          startLine: f.provenance.startLine,
          path: f.provenance.path,
        },
        ...(f.id === undefined ? {} : { id: f.id }),
        ...(f.lifecycle === undefined ? {} : { lifecycle: f.lifecycle }),
        ...(f.verdict === undefined ? {} : { verdict: f.verdict }),
        ...(f.reason === undefined ? {} : { reason: f.reason }),
      })),
      policy: { strategy: ordered.policy.strategy, strictness: ordered.policy.strictness },
      outcome: { reason: ordered.outcome.reason, classification: ordered.outcome.classification },
      headRef: ordered.headRef,
      pullRequest: ordered.pullRequest,
      repository: ordered.repository,
    };
    const first = serialiseArtifact(buildArtifact(ordered));
    const second = serialiseArtifact(buildArtifact(/** @type {any} */ (shuffled)));
    expect(second).toBe(first);
  });

  it("does not rely on object insertion order — a key-shuffled artifact serialises identically", () => {
    const artifact = buildArtifact(facts());
    const shuffled = {
      provenance: artifact.provenance,
      phases: artifact.phases,
      coverage: artifact.coverage,
      verification: artifact.verification,
      gates: artifact.gates,
      risk: artifact.risk,
      findings: artifact.findings,
      policy: artifact.policy,
      outcome: artifact.outcome,
      headRef: artifact.headRef,
      pullRequest: artifact.pullRequest,
      repository: artifact.repository,
      schemaVersion: artifact.schemaVersion,
    };
    expect(serialiseArtifact(/** @type {any} */ (shuffled))).toBe(serialiseArtifact(artifact));
  });

  it("refuses to serialise a foreign object", () => {
    expect(() => serialiseArtifact(/** @type {any} */ ({}))).toThrow(ArtifactError);
    expect(() => serialiseArtifact(/** @type {any} */ ({ schemaVersion: 2 }))).toThrow(
      ArtifactError,
    );
    expect(() =>
      serialiseArtifact(/** @type {any} */ ({ ...buildArtifact(facts()), schemaVersion: 1 })),
    ).toThrow(ArtifactError);
    expect(() => serialiseArtifact(/** @type {any} */ (null))).toThrow(ArtifactError);
    expect(() =>
      serialiseArtifact(/** @type {any} */ ({ ...buildArtifact(facts()), extra: "x" })),
    ).toThrow(ArtifactError);
  });

  it("refuses to serialise a non-data value inside the artifact", () => {
    const withFunction = /** @type {any} */ (structuredClone(buildArtifact(facts())));
    withFunction.findings[0].message = () => {};
    expect(() => serialiseArtifact(withFunction)).toThrow(ArtifactError);
    const withUndefined = /** @type {any} */ (structuredClone(buildArtifact(facts())));
    withUndefined.findings[0].message = undefined;
    expect(() => serialiseArtifact(withUndefined)).toThrow(ArtifactError);
  });
});

describe("the canonical sort order", () => {
  // The pipeline has one canonical order — UTF-8 byte order, the order
  // `utf8Compare` defines. It governs every LIST the facts can rearrange
  // (risk rows, coverage, findings — `assertUtf8Sorted` refuses anything
  // else) and every KEY the serialiser emits: `stableStringify` sorts with
  // the default code-unit `.sort()`, which agrees with byte order on every
  // key the schema can hold. This pins that agreement over the artifact's
  // whole nested key universe — a future key whose two orders diverge fails
  // here, before it can make two runs of one review disagree in bytes.

  /**
   * Every object key list a value holds, however nested — arrays walked,
   * objects collected in place.
   *
   * @param {unknown} value
   * @param {string[][]} sink
   * @returns {void}
   */
  function collectKeyLists(value, sink) {
    if (Array.isArray(value)) {
      for (const element of value) collectKeyLists(element, sink);
      return;
    }
    if (value !== null && typeof value === "object") {
      const object = /** @type {Record<string, unknown>} */ (value);
      sink.push(Object.keys(object));
      for (const nested of Object.values(object)) collectKeyLists(nested, sink);
    }
  }

  it("byte order and the serialiser's default key sort agree on every key the artifact can hold", () => {
    /** @type {string[][]} */
    const keyLists = [];
    collectKeyLists(buildArtifact(facts()), keyLists);
    collectKeyLists(buildArtifact(facts({ provenance: {} })), keyLists);
    expect(keyLists.length).toBeGreaterThan(10);
    for (const keys of keyLists) {
      expect([...keys].sort()).toEqual([...keys].sort(utf8Compare));
    }
  });
});

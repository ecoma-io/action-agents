// Tests for the machine-readable run artifact — the pure module. The builder
// is proven fail-closed; the serialiser is proven byte-stable; the artifact
// round-trips the run's policy, coverage and phase log unchanged.

import { describe, expect, it } from "vitest";

import { findingIdentity } from "./answer.mjs";
import {
  ArtifactError,
  buildArtifact,
  reviewArtifactSchemaVersion,
  serialiseArtifact,
} from "./artifact.mjs";
import { MESSAGE_CHARS } from "./render.mjs";
import { VERDICT_REASON_CHARS } from "./verify.mjs";

const HEAD = "0".repeat(40);

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
    findings: [
      { id: "1", severity: "concern", file: "src/a.mjs", line: 2, message: "off-by-one" },
      { severity: "nit", file: "src/b.mjs", line: 9, message: "typo" },
    ],
    verdicts: [{ id: "1", verdict: "confirmed", reason: "the captured bounds check the index" }],
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
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.repository).toBe("octocat/example");
    expect(artifact.pullRequest).toBe(7);
    expect(artifact.headRef).toBe(HEAD);
    expect(artifact.outcome).toEqual({
      classification: "published",
      reason: "Complete review published (2 findings)",
    });
    expect(artifact.policy).toEqual({ strictness: "high", strategy: "adversarial" });
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
    });
    expect(second.identity).toBe(
      findingIdentity({ severity: "nit", file: "src/b.mjs", line: 9, message: "typo" }),
    );
    expect(artifact.verdicts).toEqual([
      {
        findingIdentity: first.identity,
        verdict: "confirmed",
        reason: "the captured bounds check the index",
      },
    ]);
    expect(artifact.coverage).toEqual({
      total: 2,
      covered: ["src/a.mjs"],
      uncovered: ["src/b.mjs"],
    });
    expect(artifact.phases).toEqual(facts().phases);
    expect(artifact.provenance).toEqual({ commentId: 42 });
  });

  it("is frozen — the code's record is not mutable by a consumer", () => {
    const artifact = buildArtifact(facts());
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.findings)).toBe(true);
    expect(Object.isFrozen(artifact.findings[0])).toBe(true);
    expect(Object.isFrozen(artifact.outcome)).toBe(true);
  });

  it("round-trips the policy, coverage and phase log unchanged", () => {
    const input = facts();
    const artifact = buildArtifact(input);
    expect(artifact.policy).toStrictEqual(input.policy);
    expect(artifact.coverage).toStrictEqual(input.coverage);
    expect(artifact.phases).toStrictEqual(input.phases);
  });

  it("preserves finding order as given — no reordering, no sorting", () => {
    const ordered = facts({
      findings: [
        { severity: "nit", file: "src/z.mjs", line: 1, message: "zzz" },
        { severity: "concern", file: "src/a.mjs", line: 1, message: "aaa" },
      ],
      verdicts: [],
    });
    const artifact = buildArtifact(ordered);
    expect(artifact.findings.map((f) => f.file)).toEqual(["src/z.mjs", "src/a.mjs"]);
    expect(JSON.stringify(buildArtifact(ordered).findings)).toBe(JSON.stringify(artifact.findings));
  });

  it("allows an empty publication set — a run that found nothing", () => {
    const empty = facts({
      findings: [],
      verdicts: [],
      outcome: { classification: "published", reason: "Complete review published (0 findings)" },
    });
    const artifact = buildArtifact(empty);
    expect(artifact.findings).toEqual([]);
    expect(artifact.verdicts).toEqual([]);
  });
});

describe("buildArtifact refusals", () => {
  it("refuses a non-object run facts", () => {
    expect(() => buildArtifact(/** @type {any} */ (null))).toThrow(ArtifactError);
    expect(() => buildArtifact(/** @type {any} */ ("nope"))).toThrow(ArtifactError);
    expect(() => buildArtifact(/** @type {any} */ (undefined))).toThrow(ArtifactError);
    expect(() => buildArtifact(/** @type {any} */ ([facts()]))).toThrow(ArtifactError);
  });

  it("refuses an unknown top-level key", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.extra = "nope";
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
      "finding",
      (/** @type {any} */ f) => {
        f.findings[0].extra = "x";
      },
    ],
    [
      "verdict",
      (/** @type {any} */ f) => {
        f.verdicts[0].extra = "x";
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
          delete f.verdicts[0].id;
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
      "severity",
      (/** @type {any} */ f) => {
        f.findings[0].severity = "blocker";
      },
    ],
    [
      "verdict value",
      (/** @type {any} */ f) => {
        f.verdicts[0].verdict = "maybe";
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

  it("refuses a finding message over the documented cap", () => {
    const over = facts({
      findings: [
        {
          id: "1",
          severity: "concern",
          file: "src/a.mjs",
          line: 2,
          message: "x".repeat(MESSAGE_CHARS + 1),
        },
      ],
      verdicts: [{ id: "1", verdict: "confirmed", reason: "ok" }],
    });
    expect(() => buildArtifact(over)).toThrow(ArtifactError);
    const atCap = facts({
      findings: [
        {
          id: "1",
          severity: "concern",
          file: "src/a.mjs",
          line: 2,
          message: "x".repeat(MESSAGE_CHARS),
        },
      ],
      verdicts: [{ id: "1", verdict: "confirmed", reason: "ok" }],
    });
    expect(() => buildArtifact(atCap)).not.toThrow();
  });

  it("refuses a verdict reason over the documented cap", () => {
    const over = facts({
      verdicts: [{ id: "1", verdict: "confirmed", reason: "y".repeat(VERDICT_REASON_CHARS + 1) }],
    });
    expect(() => buildArtifact(over)).toThrow(ArtifactError);
  });

  it("refuses empty or non-string finding and verdict text", () => {
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
          f.verdicts[0].reason = "";
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

  it("refuses a verdict that names a finding id no finding carries", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.verdicts[0].id = "99";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a finding id with no verdict", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[0].id = "5";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a duplicate finding id", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.findings[1].id = "1";
        }),
      ),
    ).toThrow(ArtifactError);
  });

  it("refuses a duplicate verdict id", () => {
    expect(() =>
      buildArtifact(
        tampered((f) => {
          f.verdicts.push({ id: "1", verdict: "uncertain", reason: "duplicate" });
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

  it("refuses a non-array findings or verdicts list", () => {
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
          f.verdicts = "nope";
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

describe("serialiseArtifact", () => {
  it("produces byte-identical output across two calls with identical input", () => {
    const first = serialiseArtifact(buildArtifact(facts()));
    const second = serialiseArtifact(buildArtifact(facts()));
    expect(first).toBe(second);
  });

  it("includes the schema version", () => {
    expect(serialiseArtifact(buildArtifact(facts()))).toContain('"schemaVersion":1');
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
      verdicts: ordered.verdicts.map((v) => ({ reason: v.reason, verdict: v.verdict, id: v.id })),
      findings: ordered.findings.map((f) => ({
        message: f.message,
        line: f.line,
        file: f.file,
        severity: f.severity,
        ...(f.id === undefined ? {} : { id: f.id }),
      })),
      policy: { strategy: ordered.policy.strategy, strictness: ordered.policy.strictness },
      outcome: { reason: ordered.outcome.reason, classification: ordered.outcome.classification },
      headRef: ordered.headRef,
      pullRequest: ordered.pullRequest,
      repository: ordered.repository,
    };
    const first = serialiseArtifact(buildArtifact(ordered));
    const second = serialiseArtifact(buildArtifact(shuffled));
    expect(second).toBe(first);
  });

  it("does not rely on object insertion order — a key-shuffled artifact serialises identically", () => {
    const artifact = buildArtifact(facts());
    const shuffled = {
      provenance: artifact.provenance,
      phases: artifact.phases,
      coverage: artifact.coverage,
      verdicts: artifact.verdicts,
      findings: artifact.findings,
      policy: artifact.policy,
      outcome: artifact.outcome,
      headRef: artifact.headRef,
      pullRequest: artifact.pullRequest,
      repository: artifact.repository,
      schemaVersion: artifact.schemaVersion,
    };
    expect(serialiseArtifact(shuffled)).toBe(serialiseArtifact(artifact));
  });

  it("refuses to serialise a foreign object", () => {
    expect(() => serialiseArtifact(/** @type {any} */ ({}))).toThrow(ArtifactError);
    expect(() => serialiseArtifact(/** @type {any} */ ({ schemaVersion: 2 }))).toThrow(
      ArtifactError,
    );
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

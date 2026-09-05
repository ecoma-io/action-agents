// Tests for the merge gate: every fail-closed arm fires in isolation, the clean
// pass path accepts published results with complete coverage and no blocking
// findings, policy narrowing works, unknown kinds fail loud, and the decision
// is deterministic and stable across repeated calls.

import { describe, expect, it } from "vitest";

import { decideReviewGate, GatePolicyError } from "./merge-gate.mjs";

/** @returns {import("./canonical.mjs").CanonicalFinding} a minimal published finding */
const finding = (over = {}) => ({
  kind: "correctness",
  fingerprint: "a".repeat(64),
  file: "src/a.mjs",
  line: 12,
  severity: "concern",
  message: "the guard is missing",
  subject: "if (!x) return;",
  lifecycle: "confirmed",
  ...over,
});

/** A complete coverage report with all expected paths read. */
const fullCoverage = { covered: ["src/a.mjs"], uncovered: [], total: 1 };

/** @returns {import("./canonical.mjs").CanonicalResult} a complete result with one confirmed finding */
const build = (over = {}) => ({
  version: 1,
  head: "9c9473e",
  run: { state: "published", verdict: "pass" },
  findings: [],
  collapsed: [],
  ...over,
});

describe("decideReviewGate", () => {
  it("passes a clean result with complete coverage and no findings", () => {
    expect(decideReviewGate(build({ coverage: fullCoverage }))).toEqual({
      verdict: "PASS",
      reasons: [],
    });
  });

  it("passes with no findings and no coverage present", () => {
    const result = build();
    expect("coverage" in result).toBe(false);
    expect(decideReviewGate(result)).toEqual({ verdict: "PASS", reasons: [] });
  });

  it("blocks on a non-published run state", () => {
    const result = build({ run: { state: "partial", verdict: "pass" } });
    const decision = decideReviewGate(result);
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.reasons).toEqual([
      "run state 'partial' is not 'published' — the review never concluded.",
    ]);
  });

  it("blocks on every non-published run state", () => {
    for (const state of ["partial", "refused", "abandoned", "skip", "failed"]) {
      const result = build({ run: { state, verdict: "pass" } });
      const decision = decideReviewGate(result);
      expect(decision.verdict).toBe("BLOCK");
      expect(decision.reasons[0]).toContain(`run state '${state}'`);
    }
  });

  it("blocks on an unknown run verdict", () => {
    const result = build({ run: { state: "published", verdict: "unknown" } });
    const decision = decideReviewGate(result);
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.reasons).toEqual([
      "run verdict 'unknown' never passes — a hollow verdict is a defect.",
    ]);
  });

  it("blocks when coverage is present and files remain unread", () => {
    const result = build({
      coverage: { covered: ["src/a.mjs"], uncovered: ["src/b.mjs", "src/c.mjs"], total: 3 },
    });
    const decision = decideReviewGate(result);
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.reasons).toEqual([
      "2 of 3 changed files were never read: src/b.mjs, src/c.mjs.",
    ]);
  });

  it("uses singular 'file was' when exactly one file is missing", () => {
    const result = build({
      coverage: { covered: [], uncovered: ["src/a.mjs"], total: 1 },
    });
    const decision = decideReviewGate(result);
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.reasons).toEqual(["1 of 1 changed file was never read: src/a.mjs."]);
  });

  it("blocks on a confirmed finding whose kind is in blockKinds", () => {
    const result = build({ findings: [finding()] });
    const decision = decideReviewGate(result);
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.reasons).toEqual(["confirmed correctness finding at src/a.mjs:12."]);
  });

  it("blocks on an unresolved finding by default", () => {
    const result = build({
      findings: [finding({ lifecycle: "unresolved" })],
    });
    const decision = decideReviewGate(result);
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.reasons).toEqual(["unresolved correctness finding at src/a.mjs:12."]);
  });

  it("passes when blockUnresolved is false and only unresolved findings exist", () => {
    const result = build({
      findings: [finding({ lifecycle: "unresolved" })],
    });
    expect(decideReviewGate(result, { blockUnresolved: false })).toEqual({
      verdict: "PASS",
      reasons: [],
    });
  });

  it("passes when the only finding is refuted", () => {
    const result = build({
      findings: [finding({ lifecycle: "refuted" })],
    });
    expect(decideReviewGate(result)).toEqual({
      verdict: "PASS",
      reasons: [],
    });
  });

  it("passes when policy blockKinds excludes the only confirmed kind", () => {
    const result = build({ findings: [finding({ kind: "correctness" })] });
    expect(decideReviewGate(result, { blockKinds: /** @type {const} */ (["security"]) })).toEqual({
      verdict: "PASS",
      reasons: [],
    });
  });

  it("still blocks on confirmed findings when blockUnresolved is false", () => {
    const result = build({ findings: [finding()] });
    expect(decideReviewGate(result, { blockUnresolved: false })).toEqual({
      verdict: "BLOCK",
      reasons: ["confirmed correctness finding at src/a.mjs:12."],
    });
  });

  it("throws GatePolicyError for a kind not in FINDING_KINDS", () => {
    const policy = { blockKinds: ["correctness", /** @type {any} */ ("plot")] };
    expect(() => decideReviewGate(build(), policy)).toThrow(GatePolicyError);
    expect(() => decideReviewGate(build(), policy)).toThrow(/'plot'/);
  });

  it("returns the same decision for identical inputs (determinism)", () => {
    const result = build({
      findings: [finding({ lifecycle: "unresolved" })],
      coverage: { covered: ["src/a.mjs"], uncovered: ["src/b.mjs"], total: 2 },
    });
    expect(decideReviewGate(result)).toEqual(decideReviewGate(result));
  });

  it("preserves stable reason ordering across findings", () => {
    const result = build({
      findings: [
        finding({ lifecycle: "unresolved", kind: "style", file: "src/u.mjs", line: 3 }),
        finding({ kind: "security", file: "src/c.mjs", line: 9 }),
        finding({ lifecycle: "refuted", kind: "correctness", file: "src/r.mjs", line: 7 }),
      ],
    });
    const decision = decideReviewGate(result);
    expect(decision).toEqual({
      verdict: "BLOCK",
      reasons: [
        "unresolved style finding at src/u.mjs:3.",
        "confirmed security finding at src/c.mjs:9.",
      ],
    });
  });

  it("structures reasons in order: state, verdict, coverage, findings", () => {
    const result = build({
      run: { state: "failed", verdict: "unknown" },
      coverage: { covered: [], uncovered: ["src/a.mjs"], total: 1 },
      findings: [finding()],
    });
    const decision = decideReviewGate(result);
    expect(decision).toEqual({
      verdict: "BLOCK",
      reasons: [
        "run state 'failed' is not 'published' — the review never concluded.",
        "run verdict 'unknown' never passes — a hollow verdict is a defect.",
        "1 of 1 changed file was never read: src/a.mjs.",
        "confirmed correctness finding at src/a.mjs:12.",
      ],
    });
  });
});

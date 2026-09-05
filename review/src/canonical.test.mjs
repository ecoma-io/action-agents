// Tests for the canonical result contract: the constructor is the only way
// in, every closed vocabulary is enforced, fingerprints are recomputed and
// checked against the reviewed bytes' own spelling, same-key claims collapse
// to the first in publication order, and what it returns is frozen.

import { describe, expect, it } from "vitest";

import {
  CANONICAL_VERSION,
  CanonicalResultError,
  RUN_STATES,
  RUN_VERDICTS,
  createCanonicalResult,
} from "./canonical.mjs";
import { isDigest } from "./digest.mjs";
import { findingFingerprint } from "./identity.mjs";
import { FINDING_KINDS, RECONCILIATIONS } from "./vocabulary.mjs";

/** A publication finding as the verification pass leaves it. */
const finding = (over = {}) => ({
  kind: "correctness",
  file: "src/a.mjs",
  line: 12,
  severity: "concern",
  message: "the guard is missing",
  subject: "if (!x) return;",
  lifecycle: "confirmed",
  ...over,
});

const build = (over = {}) =>
  createCanonicalResult({
    head: "9c9473e",
    run: { state: "published", verdict: "pass" },
    findings: [finding()],
    ...over,
  });

describe("createCanonicalResult", () => {
  it("builds the frozen result with a recomputed fingerprint", () => {
    const result = build();
    expect(result.version).toBe(CANONICAL_VERSION);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
    expect(Object.isFrozen(result.findings[0])).toBe(true);
    expect(Object.isFrozen(result.run)).toBe(true);
    expect(Object.isFrozen(result.collapsed)).toBe(true);
    expect(result.findings[0]?.fingerprint).toBe(
      findingFingerprint({ file: "src/a.mjs", kind: "correctness", subject: "if (!x) return;" }),
    );
  });

  it("normalises the path and the subject before hashing", () => {
    const result = build({
      findings: [finding({ file: "./src/a.mjs", subject: " if  (!x)  return; " })],
    });
    expect(result.findings[0]?.file).toBe("src/a.mjs");
    expect(result.findings[0]?.subject).toBe("if (!x) return;");
    expect(result.findings[0]?.fingerprint).toBe(
      findingFingerprint({ file: "src/a.mjs", kind: "correctness", subject: "if (!x) return;" }),
    );
  });

  it("collapses claims that share the identity key to the first in publication order", () => {
    const result = build({
      findings: [
        finding({ message: "first claim" }),
        finding({ message: "second claim, same span and kind" }),
      ],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toBe("first claim");
    expect(result.collapsed).toEqual([
      { fingerprint: result.findings[0]?.fingerprint, message: "second claim, same span and kind" },
    ]);
  });

  it("keeps claims on one span apart when their kinds differ", () => {
    const result = build({
      findings: [finding(), finding({ kind: "style", message: "naming" })],
    });
    expect(result.findings).toHaveLength(2);
    expect(result.collapsed).toEqual([]);
  });

  it("rejects a stored fingerprint that the reviewed bytes do not spell", () => {
    expect(() => build({ findings: [finding({ fingerprint: "0".repeat(64) })] })).toThrow(
      CanonicalResultError,
    );
  });

  it("accepts a stored fingerprint the constructor itself spells", () => {
    const fingerprint = findingFingerprint({
      file: "src/a.mjs",
      kind: "correctness",
      subject: "if (!x) return;",
    });
    const result = build({ findings: [finding({ fingerprint })] });
    expect(result.findings[0]?.fingerprint).toBe(fingerprint);
  });

  it("rejects findings outside the closed vocabularies", () => {
    expect(() => build({ findings: [finding({ kind: "plot" })] })).toThrow(/findings\[0\]\.kind/);
    expect(() => build({ findings: [finding({ severity: "blocker" })] })).toThrow(/severity/);
    expect(() => build({ findings: [finding({ lifecycle: "candidate" })] })).toThrow(/lifecycle/);
    expect(() => build({ findings: [finding({ verdict: "maybe" })] })).toThrow(/verdict/);
  });

  it("rejects a verdict whose publication state disagrees", () => {
    expect(() =>
      build({ findings: [finding({ verdict: "refuted", lifecycle: "confirmed" })] }),
    ).toThrow(/publishes as refuted/);
    const uncertain = build({
      findings: [finding({ verdict: "uncertain", lifecycle: "unresolved" })],
    });
    expect(uncertain.findings[0]?.lifecycle).toBe("unresolved");
  });

  it("rejects a run record outside the contract vocabulary", () => {
    expect(() => build({ run: { state: "settled", verdict: "pass" } })).toThrow(/run\.state/);
    expect(() => build({ run: { state: "published", verdict: "fine" } })).toThrow(/run\.verdict/);
    expect(() => build({ run: null })).toThrow(/run must carry/);
  });

  it("rejects a head that is not a git sha", () => {
    expect(() => build({ head: "not-a-sha" })).toThrow(/head/);
    expect(build({ head: "9c9473e9227c09fbbf9a1bdd96fd3ea7cf8ffd81" }).head).toBe(
      "9c9473e9227c09fbbf9a1bdd96fd3ea7cf8ffd81",
    );
  });

  it("rejects findings that are not anchored or not named", () => {
    expect(() => build({ findings: [finding({ line: 0 })] })).toThrow(/line/);
    expect(() => build({ findings: [finding({ line: 1.5 })] })).toThrow(/line/);
    expect(() => build({ findings: [finding({ file: "" })] })).toThrow(/file/);
    expect(() => build({ findings: [finding({ message: "" })] })).toThrow(/message/);
    expect(() => build({ findings: [finding({ subject: "" })] })).toThrow(/subject/);
  });

  it("rejects evidence that does not carry a content digest", () => {
    expect(() =>
      build({ findings: [finding({ evidence: { digest: "nope", excerpt: "…" } })] }),
    ).toThrow(/evidence\.digest/);
    const bound = build({
      findings: [
        finding({
          verdict: "confirmed",
          evidence: { digest: "a".repeat(64), excerpt: "if (!x) return;" },
        }),
      ],
    });
    expect(isDigest(bound.findings[0]?.evidence?.digest)).toBe(true);
  });

  it("builds the nothing-to-review result", () => {
    const result = build({ findings: [] });
    expect(result.findings).toEqual([]);
    expect(result.collapsed).toEqual([]);
  });

  it("carries the coverage report when the run has one", () => {
    const coverage = { complete: true, expected: [], read: [] };
    const result = build({ coverage });
    expect(result.coverage).toBe(coverage);
    expect("coverage" in build()).toBe(false);
  });
});

describe("the closed vocabularies", () => {
  it("pin the run-contract states and verdicts", () => {
    expect([...RUN_STATES]).toEqual([
      "published",
      "partial",
      "refused",
      "abandoned",
      "skip",
      "failed",
    ]);
    expect([...RUN_VERDICTS]).toEqual(["pass", "fail", "unknown"]);
  });

  it("pin the reconciliation states — code computes them, the model never writes one", () => {
    expect([...RECONCILIATIONS]).toEqual(["new", "persisting", "moved", "resolved", "unresolved"]);
  });

  it("pin the finding kinds the identity is keyed on", () => {
    expect([...FINDING_KINDS]).toEqual([
      "correctness",
      "security",
      "performance",
      "api-misuse",
      "resource-safety",
      "style",
      "test-gap",
      "documentation",
    ]);
  });
});

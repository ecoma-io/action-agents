// Tests for the cross-run reconciliation: identity is the fingerprint, the
// label is code-owned on both sides of a match, an incomplete current run
// never retires a previous finding, a previous run that never published
// cleanly counts as empty, and neither input is ever mutated.

import { describe, expect, it } from "vitest";

import { RUN_STATES, createCanonicalResult } from "./canonical.mjs";
import { reconcile } from "./reconcile.mjs";

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

const run = (over = {}) =>
  createCanonicalResult({
    head: "9c9473e",
    run: { state: "published", verdict: "pass" },
    findings: [],
    ...over,
  });

describe("reconcile", () => {
  it("labels every current finding new against no previous result", () => {
    const current = run({
      findings: [
        finding(),
        finding({ file: "src/b.mjs", line: 3, message: "leak", subject: "let y = 2;" }),
      ],
    });
    for (const out of [reconcile({ current }), reconcile({ previous: null, current })]) {
      expect(out.previous).toEqual([]);
      expect(out.current.map((f) => f.reconciliation)).toEqual(["new", "new"]);
    }
  });

  it("labels every previous finding resolved when the current run reports none", () => {
    const previous = run({
      findings: [
        finding(),
        finding({ file: "src/b.mjs", line: 3, message: "leak", subject: "let y = 2;" }),
      ],
    });
    const out = reconcile({ previous, current: run({ findings: [] }) });
    expect(out.current).toEqual([]);
    expect(out.previous.map((f) => f.reconciliation)).toEqual(["resolved", "resolved"]);
  });

  it("labels a reworded claim persisting on both sides", () => {
    const previous = run({ findings: [finding({ message: "the guard is missing" })] });
    const current = run({ findings: [finding({ message: "a guard is missing on this path" })] });
    expect(current.findings[0]?.fingerprint).toBe(previous.findings[0]?.fingerprint);
    const out = reconcile({ previous, current });
    expect(out.current[0]?.reconciliation).toBe("persisting");
    expect(out.previous[0]?.reconciliation).toBe("persisting");
  });

  it("labels a regraded severity persisting on both sides", () => {
    const previous = run({ findings: [finding({ severity: "concern" })] });
    const current = run({ findings: [finding({ severity: "nit" })] });
    const out = reconcile({ previous, current });
    expect(out.current[0]?.reconciliation).toBe("persisting");
    expect(out.previous[0]?.reconciliation).toBe("persisting");
  });

  it("labels a line move moved on both sides", () => {
    const previous = run({ findings: [finding({ line: 12 })] });
    const current = run({ findings: [finding({ line: 30 })] });
    expect(current.findings[0]?.fingerprint).toBe(previous.findings[0]?.fingerprint);
    const out = reconcile({ previous, current });
    expect(out.current[0]?.reconciliation).toBe("moved");
    expect(out.previous[0]?.reconciliation).toBe("moved");
  });

  it("retires and mints across a reclassification instead of merging", () => {
    const previous = run({ findings: [finding({ kind: "correctness" })] });
    const current = run({ findings: [finding({ kind: "style", message: "naming" })] });
    expect(current.findings[0]?.fingerprint).not.toBe(previous.findings[0]?.fingerprint);
    const out = reconcile({ previous, current });
    expect(out.previous[0]?.reconciliation).toBe("resolved");
    expect(out.current[0]?.reconciliation).toBe("new");
  });

  it("retires and mints across a file change instead of moving", () => {
    const previous = run({ findings: [finding({ file: "src/a.mjs" })] });
    const current = run({ findings: [finding({ file: "src/b.mjs" })] });
    expect(current.findings[0]?.fingerprint).not.toBe(previous.findings[0]?.fingerprint);
    const out = reconcile({ previous, current });
    expect(out.previous[0]?.reconciliation).toBe("resolved");
    expect(out.current[0]?.reconciliation).toBe("new");
  });

  it("never retires a previous finding when the current run is incomplete", () => {
    const previous = run({
      findings: [
        finding(),
        finding({ file: "src/b.mjs", line: 3, message: "leak", subject: "let y = 2;" }),
        finding({ file: "src/c.mjs", line: 7, message: "vanished", subject: "gone();" }),
      ],
    });
    const current = run({
      run: { state: "partial", verdict: "fail" },
      findings: [
        finding(),
        finding({ file: "src/b.mjs", line: 9, message: "leak", subject: "let y = 2;" }),
        finding({ file: "src/d.mjs", line: 5, message: "arrived", subject: "fresh();" }),
      ],
    });
    const out = reconcile({ previous, current });
    expect(out.previous.map((f) => f.reconciliation)).toEqual(["persisting", "moved", undefined]);
    expect(out.previous.some((f) => f.reconciliation === "resolved")).toBe(false);
    expect(out.current.map((f) => f.reconciliation)).toEqual(["persisting", "moved", "new"]);
    expect(out.previous[2] ?? {}).not.toHaveProperty("reconciliation");
  });

  it("treats a previous run that never published cleanly as empty", () => {
    const unpublished = RUN_STATES.filter((state) => state !== "published" && state !== "partial");
    expect(unpublished).toEqual(["refused", "abandoned", "skip", "failed"]);
    for (const state of unpublished) {
      const previous = run({ run: { state, verdict: "unknown" }, findings: [finding()] });
      const current = run({ findings: [finding()] });
      const out = reconcile({ previous, current });
      expect(out.previous).toEqual([]);
      expect(out.current.map((f) => f.reconciliation)).toEqual(["new"]);
    }
  });

  it("labels a verdict-only change persisting — lifecycle is not identity", () => {
    const previous = run({ findings: [finding({ verdict: "refuted", lifecycle: "refuted" })] });
    const current = run({ findings: [finding({ verdict: "confirmed" })] });
    expect(current.findings[0]?.fingerprint).toBe(previous.findings[0]?.fingerprint);
    const out = reconcile({ previous, current });
    expect(out.current[0]?.reconciliation).toBe("persisting");
    expect(out.previous[0]?.reconciliation).toBe("persisting");
  });

  it("never mutates its inputs and freezes what it returns", () => {
    const previous = run({ findings: [finding()] });
    const current = run({
      run: { state: "partial", verdict: "fail" },
      findings: [finding({ line: 20 })],
    });
    const previousSnapshot = structuredClone(previous);
    const currentSnapshot = structuredClone(current);
    const out = reconcile({ previous, current });
    expect(previous).toEqual(previousSnapshot);
    expect(current).toEqual(currentSnapshot);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.current)).toBe(true);
    expect(Object.isFrozen(out.previous)).toBe(true);
    expect(Object.isFrozen(out.current[0])).toBe(true);
    expect(Object.isFrozen(out.previous[0])).toBe(true);
    expect(out.current[0]).not.toBe(current.findings[0]);
    expect(out.previous[0]).not.toBe(previous.findings[0]);
  });

  it("is deterministic across calls", () => {
    const previous = run({
      findings: [
        finding(),
        finding({ file: "src/b.mjs", line: 3, message: "leak", subject: "let y = 2;" }),
      ],
    });
    const current = run({
      findings: [
        finding({ line: 30 }),
        finding({ file: "src/b.mjs", line: 3, message: "leak", subject: "let y = 2;" }),
      ],
    });
    expect(reconcile({ previous, current })).toEqual(reconcile({ previous, current }));
  });
});

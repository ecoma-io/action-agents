// Tests for the deterministic PR-side signals.
//
// These signals are the PR-D evaluators' contribution to the `pr` dimension:
// scope facts, risk categories, dependency/release signals, readiness and
// review routing. Everything here is computed in code and is evidence-only —
// the invariants pinned below are that no signal can reject, merge, assign or
// @mention anything: triage's mutation power never grows through this module.

import { describe, expect, it } from "vitest";
import { computePrSignals } from "./pr.mjs";
/**
 * @param {{ files?: import("./evidence.mjs").PullRequestFile[], pr?: Partial<import("./evidence.mjs").PrEvidence> | null }} [over]
 * @returns {import("./evidence.mjs").Evidence}
 */
function evidence(over = {}) {
  const files = over.files ?? [];
  const pr = over.pr
    ? {
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        hasConflicts: false,
        base: { ref: "main", sha: "b" },
        head: { ref: "h", sha: "a" },
        body: "",
        checks: { total: 0, byConclusion: {} },
        reviewRequested: [],
        reviews: [],
        ...over.pr,
      }
    : null;
  return {
    thread: {
      type: "pr",
      number: 7,
      title: "t",
      body: "",
      labels: [],
      createdAt: "2026-01-01T00:00:00Z",
      creator: "tester",
      state: "open",
    },
    repository: { name: "repo", description: "d" },
    policy: null,
    sheet: null,
    labelMetadata: new Map(),
    files,
    measuredSize: null,
    quality: null,
    forgeSearch: null,
    eventAction: "opened",
    pr,
  };
}

describe("computePrSignals scope", () => {
  it("sums the diff counts and classifies the path categories", () => {
    const signals = computePrSignals(
      evidence({
        files: [
          { filename: "src/index.ts", status: "modified", additions: 10, deletions: 2 },
          { filename: "README.md", status: "modified", additions: 3, deletions: 0 },
          { filename: "src/api.test.ts", status: "added", additions: 20, deletions: 0 },
        ],
      }),
    );
    expect(signals.scope.fileCount).toBe(3);
    expect(signals.scope.totalAdditions).toBe(33);
    expect(signals.scope.totalDeletions).toBe(2);
    expect(signals.scope.categories).toEqual(expect.arrayContaining(["code", "docs", "tests"]));
    expect(signals.scope.lockfileOnly).toBe(false);
  });

  it("flags a lockfile-only diff and the release-please base branch", () => {
    const signals = computePrSignals(
      evidence({
        files: [{ filename: "pnpm-lock.yaml", status: "modified", additions: 40, deletions: 9 }],
        pr: {
          base: { ref: "release-please--branches--main", sha: "b" },
          head: { ref: "h", sha: "a" },
        },
      }),
    );
    expect(signals.scope.lockfileOnly).toBe(true);
    expect(signals.dependency.lockfileOnly).toBe(true);
    expect(signals.dependency.releasePlease).toBe(true);
  });
});

describe("computePrSignals risk", () => {
  it("surfaces risk categories from the touched paths, deterministically", () => {
    const signals = computePrSignals(
      evidence({
        files: [
          { filename: "src/api.ts", status: "modified", additions: 1, deletions: 1 },
          { filename: "db/migrations/0002.sql", status: "added", additions: 4, deletions: 0 },
          { filename: "src/auth.ts", status: "modified", additions: 1, deletions: 1 },
          { filename: "package.json", status: "modified", additions: 1, deletions: 1 },
          { filename: "dist/bundle.js", status: "added", additions: 500, deletions: 0 },
        ],
      }),
    );
    for (const cat of [
      "api-surface",
      "migration-schema",
      "auth-security",
      "dependency",
      "generated-files",
    ]) {
      expect(signals.risk.categories).toContain(cat);
    }
  });
  it("reads a major-version bump out of a dependency manifest patch hunk", () => {
    const signals = computePrSignals(
      evidence({
        files: [
          {
            filename: "package.json",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: `@@ -1,3 +1,3 @@
-  "react": "^17.0.0",
+  "react": "^18.0.0",
`,
          },
        ],
      }),
    );
    expect(signals.risk.majorVersionBumps).toContainEqual({
      package: "react",
      from: "^17.0.0",
      to: "^18.0.0",
      file: "package.json",
    });
  });

  it("leaves majorVersionBumps empty for a same-major manifest change", () => {
    const signals = computePrSignals(
      evidence({
        files: [
          {
            filename: "package.json",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: `@@ -1,3 +1,3 @@
-  "react": "^17.4.1",
+  "react": "^17.5.0",
`,
          },
        ],
      }),
    );
    expect(signals.risk.majorVersionBumps).toEqual([]);
  });
});

describe("computePrSignals readiness", () => {
  const READY_PR = {
    draft: false,
    merged: false,
    mergeable: true,
    hasConflicts: false,
    base: { ref: "main", sha: "b" },
    head: { ref: "h", sha: "a" },
    checks: {
      total: 3,
      byConclusion: { success: 3 },
    },
    reviewRequested: [],
    reviews: [],
  };

  it("a clean, described, tested, non-draft PR is ready", () => {
    const signals = computePrSignals(
      evidence({
        files: [{ filename: "src/index.test.ts", status: "modified", additions: 2, deletions: 1 }],
        pr: { ...READY_PR, body: "what and why" },
      }),
    );
    expect(signals.readiness.ready).toBe(true);
    expect(signals.readiness.testsPresent).toBe(true);
    expect(signals.readiness.descriptionPresent).toBe(true);
  });

  it("readiness is distinct from mergeability — a mergeable draft is not ready", () => {
    const signals = computePrSignals(
      evidence({
        files: [],
        pr: { ...READY_PR, draft: true, body: "what and why" },
      }),
    );
    expect(signals.readiness.mergeable).toBe(true);
    expect(signals.readiness.ready).toBe(false);
  });

  it("failing checks and conflicts make it not ready even when mergeable", () => {
    const signals = computePrSignals(
      evidence({
        files: [],
        pr: {
          ...READY_PR,
          hasConflicts: true,
          checks: { total: 2, byConclusion: { failure: 2 } },
          body: "what and why",
        },
      }),
    );
    expect(signals.readiness.checks.failing).toBe(2);
    expect(signals.readiness.ready).toBe(false);
  });

  it("a still-computing mergeability (null) with no reported checks is not ready", () => {
    const signals = computePrSignals(
      evidence({
        files: [],
        pr: {
          ...READY_PR,
          mergeable: null,
          checks: { total: 0, byConclusion: {} },
          body: "what and why",
        },
      }),
    );
    expect(signals.readiness.mergeable).toBeNull();
    expect(signals.readiness.checks.present).toBe(false);
    // Absent check data is absent, never green: no checks reported means
    // the PR is not ready to be looked at, even when mergeability is only
    // still computing.
    expect(signals.readiness.ready).toBe(false);
  });

  it("a forge-error read (checks null) is not ready", () => {
    const signals = computePrSignals(
      evidence({
        files: [],
        pr: { ...READY_PR, checks: null, body: "what and why" },
      }),
    );
    expect(signals.readiness.checks.present).toBe(false);
    expect(signals.readiness.ready).toBe(false);
  });

  it("an empty description is a fact, and reads as not-present", () => {
    const signals = computePrSignals(
      evidence({
        files: [],
        pr: { ...READY_PR, body: "" },
      }),
    );
    expect(signals.readiness.descriptionPresent).toBe(false);
  });
});

describe("computePrSignals routing", () => {
  it("never assigns and never @mentions — the signal is evidence only", () => {
    const signals = computePrSignals(
      evidence({
        files: [],
        pr: {
          reviewRequested: ["alice"],
          reviews: [{ state: "COMMENTED", count: 1 }],
        },
      }),
    );
    expect(signals.routing.active).toBe(false);
    expect(signals.routing.requested).toEqual(["alice"]);
    // The routing object has no assignee or mention surface at all — nothing
    // a caller could turn into a write.
    expect(Object.keys(signals.routing).sort()).toEqual(["active", "requested", "reviewed"]);
  });
});

describe("computePrSignals has no mutation power", () => {
  it("exposes only evidence-shaped fields — no reject, assign or label verdict key", () => {
    const signals = computePrSignals(evidence());
    const keys = [...Object.keys(signals)];
    for (const action of ["reject", "assign", "approve", "labels", "add", "remove", "mention"]) {
      expect(keys).not.toContain(action);
    }
    // No singleton green/red verdict hiding an action: readiness is a signal
    // a policy may weigh, not a decision this module makes.
    expect(signals.readiness.ready).toBe(false);
  });
});

// Tests for the pure coverage accounting: the diff-path parser, the
// diff-text renderer that feeds it at the run's boundary, the set
// accounting, and the code-owned conclusion verdict. Everything here is
// deterministic — no I/O, no model, no clock — so the pins are exact.

import { describe, expect, it } from "vitest";

import {
  canConcludeReview,
  coverageReport,
  normaliseReadPath,
  parseDiffPaths,
  unifiedDiff,
} from "./coverage.mjs";

describe("parseDiffPaths", () => {
  it("returns nothing for an empty diff", () => {
    expect(parseDiffPaths("")).toEqual([]);
  });

  it("counts a modified file by its +++ path, git prefixes stripped", () => {
    const diff = [
      "diff --git a/src/a.mjs b/src/a.mjs",
      "index 1111111..2222222 100644",
      "--- a/src/a.mjs",
      "+++ b/src/a.mjs",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["src/a.mjs"]);
  });

  it("counts an added file by its +++ path", () => {
    const diff = ["--- /dev/null", "+++ b/src/new.mjs", "@@ -0,0 +1 @@", "+fresh"].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["src/new.mjs"]);
  });

  it("counts a deleted file by its --- path", () => {
    const diff = ["--- a/lib/gone.mjs", "+++ /dev/null", "@@ -1 +0,0 @@", "-old"].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["lib/gone.mjs"]);
  });

  it("counts a rename with content by the new path only", () => {
    const diff = [
      "diff --git a/lib/old.mjs b/lib/new.mjs",
      "similarity index 90%",
      "rename from lib/old.mjs",
      "rename to lib/new.mjs",
      "--- a/lib/old.mjs",
      "+++ b/lib/new.mjs",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["lib/new.mjs"]);
  });

  it("counts a pure rename's rename-to path when no content headers exist", () => {
    const diff = [
      "diff --git a/lib/before.mjs b/lib/after.mjs",
      "similarity index 100%",
      "rename from lib/before.mjs",
      "rename to lib/after.mjs",
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["lib/after.mjs"]);
  });

  it("counts a copy by the copy-to path only", () => {
    const diff = [
      "diff --git a/app/origin.mjs b/app/copy.mjs",
      "copy from app/origin.mjs",
      "copy to app/copy.mjs",
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["app/copy.mjs"]);
  });

  it("counts a binary file by the differ line real git emits without content headers", () => {
    const diff = [
      "diff --git a/app/logo.png b/app/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/app/logo.png and b/app/logo.png differ",
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["app/logo.png"]);
  });

  it("counts an added binary by its headers around the differ line", () => {
    const diff = [
      "diff --git a/app/logo.png b/app/logo.png",
      "--- /dev/null",
      "+++ b/app/logo.png",
      "Binary files /dev/null and b/app/logo.png differ",
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["app/logo.png"]);
  });

  it("counts nothing for a mode-only section with no content headers", () => {
    const diff = [
      "diff --git a/tools/run.sh b/tools/run.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual([]);
  });

  it("never reads a header out of a hunk body, whatever the content looks like", () => {
    const diff = [
      "diff --git a/src/a.mjs b/src/a.mjs",
      "--- a/src/a.mjs",
      "+++ b/src/a.mjs",
      "@@ -1,1 +1,2 @@",
      " context",
      "+++ b/fake.mjs",
      "-- a/ghost.mjs",
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["src/a.mjs"]);
  });

  it("closes a hunk by line count, so the next section's headers parse", () => {
    const diff = [
      "--- a/lib/one.mjs",
      "+++ b/lib/one.mjs",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "--- a/lib/two.mjs",
      "+++ b/lib/two.mjs",
      "@@ -1 +1 @@",
      "-q",
      "+r",
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["lib/one.mjs", "lib/two.mjs"]);
  });

  it("unquotes git's quoted form and keeps spaces", () => {
    const diff = ['--- "a/src/with space.mjs"', '+++ "b/src/with space.mjs"'].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["src/with space.mjs"]);
  });

  it("resolves C-style escapes: tab, quote, backslash and octal UTF-8", () => {
    const diff = [
      "diff --git a/one.mjs b/one.mjs",
      '--- "a/src/tab\\there.mjs"',
      '+++ "b/src/tab\\there.mjs"',
      "diff --git a/two.mjs b/two.mjs",
      '--- "a/src/quote\\"here.mjs"',
      '+++ "b/src/quote\\"here.mjs"',
      "diff --git a/three.mjs b/three.mjs",
      '--- "a/src/back\\\\here.mjs"',
      '+++ "b/src/back\\\\here.mjs"',
      "diff --git a/four.mjs b/four.mjs",
      '--- "a/src/caf\\303\\251.mjs"',
      '+++ "b/src/caf\\303\\251.mjs"',
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual([
      "src/back\\here.mjs",
      "src/caf\u00e9.mjs",
      'src/quote"here.mjs',
      "src/tab\there.mjs",
    ]);
  });

  it("takes an unquoted token's path at the tab, where a timestamp would sit", () => {
    const diff = ["--- a/src/a.mjs\t2026-01-01 00:00:00", "+++ b/src/a.mjs\t2026-01-02"].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["src/a.mjs"]);
  });

  it("strips a CRLF carriage return from the header token", () => {
    const diff = "--- a/src/a.mjs\r\n+++ b/src/a.mjs\r\n";
    expect(parseDiffPaths(diff)).toEqual(["src/a.mjs"]);
  });

  it("normalises a leading ./ on either side", () => {
    const diff = ["--- ./lib/before.mjs", "+++ b/./lib/after.mjs"].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["lib/after.mjs"]);
  });

  it("strips only the synthetic prefix, so a file named b/x.mjs survives", () => {
    const diff = ["--- a/b/x.mjs", "+++ b/b/x.mjs"].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["b/x.mjs"]);
  });

  it("skips malformed headers: empty tokens, bare verbs, /dev/null alone", () => {
    expect(parseDiffPaths(["--- ", "+++"].join("\n"))).toEqual([]);
    expect(parseDiffPaths(["+++ /dev/null"].join("\n"))).toEqual([]);
    expect(parseDiffPaths(["+++ b/"].join("\n"))).toEqual([]);
  });

  it("drops a combined-diff @@-triple section instead of misreading its body", () => {
    const diff = [
      "diff --git a/src/a.mjs b/src/a.mjs",
      "--- a/src/a.mjs",
      "+++ b/src/a.mjs",
      "@@@ -1,1 -1,1 +1,2 @@@",
      "--- a/ghost.mjs",
      "+++ b/ghost.mjs",
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual([]);
  });

  it("deduplicates and sorts byte-wise whatever order the diff names", () => {
    const diff = [
      "--- a/src/zeta.mjs",
      "+++ b/src/zeta.mjs",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "--- a/src/alpha.mjs",
      "+++ b/src/alpha.mjs",
      "@@ -1 +1 @@",
      "-q",
      "+r",
      "--- a/src/zeta.mjs",
      "+++ b/src/zeta.mjs",
    ].join("\n");
    expect(parseDiffPaths(diff)).toEqual(["src/alpha.mjs", "src/zeta.mjs"]);
  });
});

describe("unifiedDiff", () => {
  /** @type {import("./inventory.mjs").ChangedFile[]} */
  const files = [
    {
      filename: "src/changed.mjs",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-x\n+y",
    },
    {
      filename: "src/added.mjs",
      status: "added",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1 @@",
    },
    { filename: "lib/dropped.mjs", status: "removed", additions: 0, deletions: 1 },
    {
      filename: "lib/renamed.mjs",
      status: "renamed",
      additions: 0,
      deletions: 0,
      previousFilename: "lib/earlier.mjs",
    },
    {
      filename: "app/cloned.mjs",
      status: "copied",
      additions: 0,
      deletions: 0,
      previousFilename: "app/origin.mjs",
    },
    { filename: "app/picture.png", status: "modified", additions: 0, deletions: 0 },
  ];

  it("round-trips the inventory's entries into exactly their head paths", () => {
    expect(parseDiffPaths(unifiedDiff(files))).toEqual([
      "app/cloned.mjs",
      "app/picture.png",
      "lib/dropped.mjs",
      "lib/renamed.mjs",
      "src/added.mjs",
      "src/changed.mjs",
    ]);
  });

  it("emits /dev/null on the empty side of an add and a remove", () => {
    const text = unifiedDiff([
      { filename: "src/added.mjs", status: "added", additions: 1, deletions: 0 },
      { filename: "lib/gone.mjs", status: "removed", additions: 0, deletions: 1 },
    ]);
    expect(text).toContain("--- /dev/null"); // the added file's old side
    expect(text).toContain("+++ b/src/added.mjs");
    expect(text).toContain("--- a/lib/gone.mjs");
    expect(text).toContain("+++ /dev/null"); // the removed file's new side
  });

  it("quotes a filename whose characters would end the token early, and reads it back", () => {
    const tricky = "src/with\ttab.mjs";
    const text = unifiedDiff([
      { filename: tricky, status: "modified", additions: 1, deletions: 0 },
    ]);
    expect(parseDiffPaths(text)).toEqual([tricky]);
  });

  it("renders the empty universe as an empty diff", () => {
    expect(unifiedDiff([])).toBe("");
  });
});

describe("coverageReport", () => {
  it("partitions the expected set against the read record", () => {
    const report = coverageReport(["src/a.mjs", "src/b.mjs", "src/c.mjs"], ["src/b.mjs"]);
    expect(report).toEqual({
      covered: ["src/b.mjs"],
      uncovered: ["src/a.mjs", "src/c.mjs"],
      total: 3,
    });
  });

  it("sorts its outputs whatever order the inputs came in", () => {
    const report = coverageReport(["src/z.mjs", "src/a.mjs"], ["src/z.mjs", "src/a.mjs"]);
    expect(report.covered).toEqual(["src/a.mjs", "src/z.mjs"]);
    expect(report.uncovered).toEqual([]);
    expect(report.total).toBe(2);
  });

  it("treats both inputs as sets", () => {
    const report = coverageReport(["src/a.mjs", "src/a.mjs"], ["src/a.mjs", "src/extra.mjs"]);
    expect(report).toEqual({ covered: ["src/a.mjs"], uncovered: [], total: 1 });
  });

  it("reports an empty universe as all-zero", () => {
    expect(coverageReport([], ["src/a.mjs"])).toEqual({ covered: [], uncovered: [], total: 0 });
  });
});

describe("canConcludeReview", () => {
  const clean = { covered: ["src/a.mjs"], uncovered: [], total: 1 };
  const gaps = { covered: [], uncovered: ["src/a.mjs"], total: 1 };

  it("holds the strict arm to an empty uncovered set", () => {
    expect(canConcludeReview(gaps, "high")).toBe(false);
    expect(canConcludeReview(clean, "high")).toBe(true);
  });

  it("lets the standard arm conclude with the report surfaced instead", () => {
    expect(canConcludeReview(gaps, "medium")).toBe(true);
    expect(canConcludeReview(gaps, "low")).toBe(true);
    expect(canConcludeReview(clean, "low")).toBe(true);
  });
});

describe("normaliseReadPath", () => {
  it("collapses the spellings a tool argument may carry to the diff's form", () => {
    expect(normaliseReadPath("./src/a.mjs")).toBe("src/a.mjs");
    expect(normaliseReadPath("lib/./x/../y.mjs")).toBe("lib/y.mjs");
    expect(normaliseReadPath("src/a.mjs")).toBe("src/a.mjs");
  });
});

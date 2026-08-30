// Tests for `harmonise` three-way target merge: deterministic LCS alignment,
// one-sided preservation and adoption, agreement, conflicts that keep the
// manual text, disjoint regions applied in order, empty and trailing-newline
// edges, bounded excerpts, and the summary counts.
//
// The regression cases pin the union-boundary rule: lines a side inserted
// just before a conflicting region are emitted once, never swept into the
// union's rendition a second time.

import { describe, expect, it } from "vitest";

import { mergeThreeWay, summarizeMerge } from "./threeway.mjs";

describe("no changes at all", () => {
  it("returns the base text unchanged when all three inputs are identical", () => {
    const result = mergeThreeWay("alpha\nbeta\n", "alpha\nbeta\n", "alpha\nbeta\n");
    expect(result).toEqual({ merged: "alpha\nbeta\n", conflicts: [], changes: [] });
  });

  it("keeps the exact text without a trailing newline", () => {
    const result = mergeThreeWay("alpha", "alpha", "alpha");
    expect(result).toEqual({ merged: "alpha", conflicts: [], changes: [] });
  });
});

describe("one-sided edits", () => {
  it("preserves a manual edit when the fresh side is unchanged", () => {
    const result = mergeThreeWay("a\nb\nc", "a\nB\nc", "a\nb\nc");
    expect(result.merged).toBe("a\nB\nc");
    expect(result.changes).toEqual([{ type: "manual", startLine: 2 }]);
    expect(summarizeMerge(result)).toEqual({ preservedManual: 1, adoptedFresh: 0, conflicts: 0 });
  });

  it("adopts the fresh translation when the manual side is unchanged", () => {
    const result = mergeThreeWay("a\nb\nc", "a\nb\nc", "a\nF\nc");
    expect(result.merged).toBe("a\nF\nc");
    expect(result.changes).toEqual([{ type: "fresh", startLine: 2 }]);
    expect(summarizeMerge(result)).toEqual({ preservedManual: 0, adoptedFresh: 1, conflicts: 0 });
  });

  it("preserves a manual deletion", () => {
    const result = mergeThreeWay("a\nb\nc", "a\nc", "a\nb\nc");
    expect(result.merged).toBe("a\nc");
    expect(result.changes).toEqual([{ type: "manual", startLine: 2 }]);
  });

  it("adopts a fresh deletion", () => {
    const result = mergeThreeWay("a\nb\nc", "a\nb\nc", "a\nc");
    expect(result.merged).toBe("a\nc");
    expect(result.changes).toEqual([{ type: "fresh", startLine: 2 }]);
  });

  it("preserves a manual trailing-newline removal", () => {
    const result = mergeThreeWay("a\nb\n", "a\nb", "a\nb\n");
    expect(result.merged).toBe("a\nb");
    expect(result.changes).toEqual([{ type: "manual", startLine: 3 }]);
  });

  it("preserves a manual trailing-newline addition", () => {
    const result = mergeThreeWay("a\nb", "a\nb\n", "a\nb");
    expect(result.merged).toBe("a\nb\n");
    expect(result.changes).toEqual([{ type: "manual", startLine: 3 }]);
  });

  it("adopts a fresh trailing-newline addition", () => {
    const result = mergeThreeWay("a\nb", "a\nb", "a\nb\n");
    expect(result.merged).toBe("a\nb\n");
    expect(result.changes).toEqual([{ type: "fresh", startLine: 3 }]);
  });

  it("adopts the fresh text wholesale when the manual side never moved", () => {
    const result = mergeThreeWay("a\nb", "a\nb", "X\nY");
    expect(result.merged).toBe("X\nY");
    expect(result.conflicts).toEqual([]);
  });
});

describe("disjoint edits land in base order", () => {
  it("applies a manual edit above a fresh edit", () => {
    const result = mergeThreeWay("a\nb\nc\nd\ne", "A\nb\nc\nd\ne", "a\nb\nc\nD\ne");
    expect(result.merged).toBe("A\nb\nc\nD\ne");
    expect(result.changes).toEqual([
      { type: "manual", startLine: 1 },
      { type: "fresh", startLine: 4 },
    ]);
    expect(summarizeMerge(result)).toEqual({ preservedManual: 1, adoptedFresh: 1, conflicts: 0 });
  });

  it("applies a fresh edit above a manual edit", () => {
    const result = mergeThreeWay("a\nb\nc\nd\ne", "a\nb\nc\nD\ne", "A\nb\nc\nd\ne");
    expect(result.merged).toBe("A\nb\nc\nD\ne");
    expect(result.changes).toEqual([
      { type: "fresh", startLine: 1 },
      { type: "manual", startLine: 4 },
    ]);
  });
});

describe("both sides changed the same region", () => {
  it("emits an identical change once and counts it nowhere", () => {
    const result = mergeThreeWay("a\nb\nc", "a\nB\nc", "a\nB\nc");
    expect(result.merged).toBe("a\nB\nc");
    expect(result.changes).toEqual([{ type: "both", startLine: 2 }]);
    expect(result.conflicts).toEqual([]);
    expect(summarizeMerge(result)).toEqual({ preservedManual: 0, adoptedFresh: 0, conflicts: 0 });
  });

  it("emits an identical deletion once", () => {
    const result = mergeThreeWay("a\nb\nc", "a\nc", "a\nc");
    expect(result.merged).toBe("a\nc");
    expect(result.changes).toEqual([{ type: "both", startLine: 2 }]);
  });

  it("keeps the manual text and reports a conflict when the changes differ", () => {
    const result = mergeThreeWay("a\nb\nc", "a\nM\nc", "a\nF\nc");
    expect(result.merged).toBe("a\nM\nc");
    expect(result.conflicts).toEqual([
      { startLine: 2, baseExcerpt: "b", manualExcerpt: "M", freshExcerpt: "F" },
    ]);
    expect(result.changes).toEqual([{ type: "conflict", startLine: 2 }]);
    expect(summarizeMerge(result)).toEqual({ preservedManual: 0, adoptedFresh: 0, conflicts: 1 });
  });

  it("renders a partially overlapping union from both sides", () => {
    const result = mergeThreeWay("a\nb\nc\nd\ne", "a\nB2\nB3\nd\ne", "a\nb\nF3\nF4\nF5");
    expect(result.merged).toBe("a\nB2\nB3\nd\ne");
    expect(result.conflicts).toEqual([
      {
        startLine: 2,
        baseExcerpt: "b\nc\nd\ne",
        manualExcerpt: "B2\nB3\nd\ne",
        freshExcerpt: "b\nF3\nF4\nF5",
      },
    ]);
  });

  it("grows a union while further regions overlap it", () => {
    const result = mergeThreeWay(
      "a\nb\nc\nd\ne\nf\ng",
      "a\nB\nC\nd\nE\nf\ng",
      "a\nb\nF3\nF4\nF5\nf\ng",
    );
    expect(result.merged).toBe("a\nB\nC\nd\nE\nf\ng");
    expect(result.conflicts).toEqual([
      {
        startLine: 2,
        baseExcerpt: "b\nc\nd\ne",
        manualExcerpt: "B\nC\nd\nE",
        freshExcerpt: "b\nF3\nF4\nF5",
      },
    ]);
  });

  it("grows a union from the fresh side too", () => {
    const result = mergeThreeWay(
      "a\nb\nc\nd\ne\nf\ng",
      "a\nb\nF3\nF4\nF5\nf\ng",
      "a\nB\nC\nd\nE\nf\ng",
    );
    expect(result.merged).toBe("a\nb\nF3\nF4\nF5\nf\ng");
    expect(result.conflicts).toEqual([
      {
        startLine: 2,
        baseExcerpt: "b\nc\nd\ne",
        manualExcerpt: "b\nF3\nF4\nF5",
        freshExcerpt: "B\nC\nd\nE",
      },
    ]);
  });

  it("keeps a manual deletion against a fresh rewrite", () => {
    const result = mergeThreeWay("a\nb\nc", "a\nc", "a\nF\nc");
    expect(result.merged).toBe("a\nc");
    expect(result.conflicts).toEqual([
      { startLine: 2, baseExcerpt: "b", manualExcerpt: "", freshExcerpt: "F" },
    ]);
  });
});

describe("insertions", () => {
  it("conflicts when both sides insert different lines at the same point", () => {
    const result = mergeThreeWay("a\nc", "a\nM1\nM2\nc", "a\nF1\nc");
    expect(result.merged).toBe("a\nM1\nM2\nc");
    expect(result.conflicts).toEqual([
      { startLine: 2, baseExcerpt: "", manualExcerpt: "M1\nM2", freshExcerpt: "F1" },
    ]);
  });

  it("emits identical same-point insertions once", () => {
    const result = mergeThreeWay("a\nc", "a\nX\nc", "a\nX\nc");
    expect(result.merged).toBe("a\nX\nc");
    expect(result.changes).toEqual([{ type: "both", startLine: 2 }]);
    expect(result.conflicts).toEqual([]);
  });

  it("applies a manual insertion cleanly before a fresh replacement", () => {
    const result = mergeThreeWay("a\nb\nc\nd\ne", "a\nb\nX\nc\nd\ne", "a\nb\nF3\nF4\nF5");
    expect(result.merged).toBe("a\nb\nX\nF3\nF4\nF5");
    expect(result.changes).toEqual([
      { type: "manual", startLine: 3 },
      { type: "fresh", startLine: 4 },
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("applies a fresh insertion cleanly before a manual replacement", () => {
    const result = mergeThreeWay("a\nb\nc\nd\ne", "a\nb\nM3\nM4\nM5", "a\nb\nX\nc\nd\ne");
    expect(result.merged).toBe("a\nb\nX\nM3\nM4\nM5");
    expect(result.changes).toEqual([
      { type: "fresh", startLine: 3 },
      { type: "manual", startLine: 4 },
    ]);
    expect(result.conflicts).toEqual([]);
  });
});

describe("empty inputs", () => {
  it("merges three empty texts to an empty text", () => {
    expect(mergeThreeWay("", "", "")).toEqual({ merged: "", conflicts: [], changes: [] });
  });

  it("conflicts at line 1 when two sides fill an empty base differently", () => {
    const result = mergeThreeWay("", "manual line", "fresh line");
    expect(result.merged).toBe("manual line");
    expect(result.conflicts).toEqual([
      {
        startLine: 1,
        baseExcerpt: "",
        manualExcerpt: "manual line",
        freshExcerpt: "fresh line",
      },
    ]);
  });

  it("emits an identical fill of an empty base once", () => {
    const result = mergeThreeWay("", "same", "same");
    expect(result.merged).toBe("same");
    expect(result.changes).toEqual([{ type: "both", startLine: 1 }]);
    expect(result.conflicts).toEqual([]);
  });

  it("treats an empty side as no change", () => {
    const freshOnly = mergeThreeWay("", "", "x");
    expect(freshOnly.merged).toBe("x");
    expect(freshOnly.changes).toEqual([{ type: "fresh", startLine: 1 }]);

    const manualOnly = mergeThreeWay("", "x", "");
    expect(manualOnly.merged).toBe("x");
    expect(manualOnly.changes).toEqual([{ type: "manual", startLine: 1 }]);
  });
});

describe("regression: insertions at a union boundary are emitted once", () => {
  it("does not sweep an emitted insertion into the union's rendition again", () => {
    const result = mergeThreeWay("1\n2\n3\n4", "1\n2\nX\n3\n3'\n4", "1\n2\nF3\nF4");
    expect(result.merged).toBe("1\n2\nX\n3\n3'\n4");
    expect(result.changes).toEqual([
      { type: "manual", startLine: 3 },
      { type: "conflict", startLine: 4 },
    ]);
    expect(result.conflicts).toEqual([
      {
        startLine: 4,
        baseExcerpt: "3\n4",
        manualExcerpt: "3\n3'\n4",
        freshExcerpt: "F3\nF4",
      },
    ]);
  });

  it("does not re-emit a whole earlier region that ends at the union start", () => {
    const result = mergeThreeWay("1\n2\n3\n4", "1'\n2'\nX\n3\n3'\n4", "1\n2\nF3\nF4");
    expect(result.merged).toBe("1'\n2'\nX\n3\n3'\n4");
    expect(result.changes).toEqual([
      { type: "manual", startLine: 1 },
      { type: "conflict", startLine: 4 },
    ]);
    expect(result.conflicts).toEqual([
      {
        startLine: 4,
        baseExcerpt: "3\n4",
        manualExcerpt: "3\n3'\n4",
        freshExcerpt: "F3\nF4",
      },
    ]);
  });
});

describe("excerpts are bounded and deterministic", () => {
  it("truncates excerpts past 120 characters with an ellipsis", () => {
    const result = mergeThreeWay("a\nb", `a\n${"m".repeat(200)}`, `a\n${"f".repeat(200)}`);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.baseExcerpt).toBe("b");
    expect(result.conflicts[0]?.manualExcerpt).toBe(`${"m".repeat(117)}...`);
    expect(result.conflicts[0]?.freshExcerpt).toBe(`${"f".repeat(117)}...`);
    expect(result.conflicts[0]?.manualExcerpt).toHaveLength(120);
  });

  it("keeps an exactly 120-character excerpt whole", () => {
    const result = mergeThreeWay("a\nb", `a\n${"m".repeat(120)}`, `a\n${"F".repeat(120)}`);
    expect(result.conflicts[0]?.manualExcerpt).toBe("m".repeat(120));
  });
});

describe("determinism and summaries", () => {
  it("produces deep-equal results for identical inputs", () => {
    const base = "a\nb\nc\nd\ne\nf\ng";
    const manual = "a\nB\nC\nd\nE\nf\ng";
    const fresh = "a\nb\nF3\nF4\nF5\nf\ng";
    expect(mergeThreeWay(base, manual, fresh)).toEqual(mergeThreeWay(base, manual, fresh));
  });

  it("summarizes a mixed merge: one preserved, one adopted, one conflict", () => {
    const result = mergeThreeWay("a\nb\nc\nd\ne", "A\nb\nc\nd", "a\nb\nC\nd\nE");
    expect(result.merged).toBe("A\nb\nC\nd");
    expect(result.changes).toEqual([
      { type: "manual", startLine: 1 },
      { type: "fresh", startLine: 3 },
      { type: "conflict", startLine: 5 },
    ]);
    expect(result.conflicts[0]?.startLine).toBe(5);
    expect(summarizeMerge(result)).toEqual({ preservedManual: 1, adoptedFresh: 1, conflicts: 1 });
  });
});

describe("table budget", () => {
  it("refuses a merge whose LCS table would exceed the budget, as a content refusal", () => {
    // 4 000-line sides: (4001)² ≈ 16 M Int32 entries, far past the 2²³ cap —
    // a short-line document that would otherwise allocate a ~64 MB table.
    const big = Array.from({ length: 4_000 }, (_, i) => `line ${i}`).join("\n");
    expect(() => mergeThreeWay(big, big, "fresh\nonly\n")).toThrow(/too large to reconcile safely/);
  });
});

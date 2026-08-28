// Tests for `harmonise` changed-block planning: the deterministic diff
// between a document's previous source blocks and its current ones.
//
// What is pinned: matching is by content fingerprint, never by index — a
// position-only move is `unchanged`; leftover blocks pair in ascending
// order into `changed`; true insertions and deletions are `added` and
// `removed`, each array indexing its own side; duplicate identical blocks
// match in occurrence order; every field is sorted and the same inputs
// always produce the same plan.

import { describe, expect, it } from "vitest";

import { planBlocks, summarizePlan } from "./blocks.mjs";

/** A block carrying exactly the planner's field. @param {string} content @returns {import("./blocks.mjs").SourceBlock} */
function block(content) {
  return { content };
}

/** @param {...string} contents @returns {import("./blocks.mjs").SourceBlock[]} */
function blocks(...contents) {
  return contents.map(block);
}

/** The empty-plan shape every classification test starts from. */
const NOTHING = { unchanged: [], changed: [], added: [], removed: [] };

describe("planBlocks", () => {
  it("classifies an identical document as entirely unchanged", () => {
    expect(planBlocks(blocks("Install", "Usage"), blocks("Install", "Usage"))).toEqual({
      ...NOTHING,
      unchanged: [0, 1],
    });
  });

  it("keeps a position-only move unchanged — reordering is not a change", () => {
    const plan = planBlocks(blocks("one", "two", "three"), blocks("three", "one", "two"));

    expect(plan).toEqual({ ...NOTHING, unchanged: [0, 1, 2] });
  });

  it("classifies an in-place edit as changed and keeps neighbours unchanged", () => {
    const plan = planBlocks(blocks("before", "keep"), blocks("after", "keep"));

    expect(plan).toEqual({ ...NOTHING, changed: [0], unchanged: [1] });
  });

  it("aligns leftovers in ascending order when contents are unrelated", () => {
    // No fingerprint matches, so the doctrine's positional pairing applies:
    // previous 0 aligns with current 0 as `changed`, previous 1 has no
    // partner and is `removed`. The pairing is alignment, not resemblance.
    const plan = planBlocks(blocks("alpha", "beta"), blocks("gamma"));

    expect(plan).toEqual({ ...NOTHING, changed: [0], removed: [1] });
  });

  it("classifies an insertion as added, not changed", () => {
    const plan = planBlocks(blocks("keep"), blocks("inserted", "keep"));

    expect(plan).toEqual({ ...NOTHING, added: [0], unchanged: [1] });
  });

  it("classifies a deletion as removed, indexing the previous array", () => {
    const plan = planBlocks(blocks("a", "b", "c"), blocks("b"));

    // `unchanged` points into the current array, `removed` into the
    // previous one — the two index domains are different arrays.
    expect(plan).toEqual({ ...NOTHING, unchanged: [0], removed: [0, 2] });
  });

  it("makes every current block added when the previous array is empty", () => {
    const plan = planBlocks([], blocks("one", "two"));

    expect(plan).toEqual({ ...NOTHING, added: [0, 1] });
  });

  it("makes every previous block removed when the current array is empty", () => {
    const plan = planBlocks(blocks("one", "two"), []);

    expect(plan).toEqual({ ...NOTHING, removed: [0, 1] });
  });

  it("produces the empty plan for two empty arrays", () => {
    expect(planBlocks([], [])).toEqual(NOTHING);
  });

  describe("duplicate identical blocks", () => {
    it("matches in occurrence order — k-th previous with k-th current", () => {
      const plan = planBlocks(blocks("same", "between", "same"), blocks("between", "same", "same"));

      expect(plan).toEqual({ ...NOTHING, unchanged: [0, 1, 2] });
    });

    it("pairs the surplus duplicate with its edited sibling rather than adding or removing", () => {
      const plan = planBlocks(blocks("same", "same"), blocks("same", "edited"));

      expect(plan).toEqual({ ...NOTHING, unchanged: [0], changed: [1] });
    });

    it("reports the surplus duplicate as removed when current has fewer", () => {
      const plan = planBlocks(blocks("same", "same"), blocks("same"));

      expect(plan).toEqual({ ...NOTHING, unchanged: [0], removed: [1] });
    });

    it("reports the surplus duplicate as added when previous has fewer", () => {
      const plan = planBlocks(blocks("same"), blocks("same", "same"));

      expect(plan).toEqual({ ...NOTHING, unchanged: [0], added: [1] });
    });
  });

  it("ignores fields beyond content — extra metadata never breaks identity", () => {
    const previous = [{ content: "same words", kind: "heading" }];
    const current = [{ content: "same words", kind: "paragraph" }];

    expect(planBlocks(previous, current)).toEqual({ ...NOTHING, unchanged: [0] });
  });

  it("never calls a one-byte difference unchanged — the fingerprint moves", () => {
    const plan = planBlocks(blocks("words "), blocks("words"));

    // Unrelated by fingerprint, so the pairing rule classifies the pair.
    expect(plan).toEqual({ ...NOTHING, changed: [0] });
  });

  it("sorts every field ascending when a revision edits, inserts and reorders", () => {
    // prev: a b c d → current: c' b f g a. "b" and "a" match wherever they
    // sit; "c edited" pairs with leftover "c" and "f" with leftover "d";
    // "g" is the surplus the current side carries.
    const plan = planBlocks(blocks("a", "b", "c", "d"), blocks("c edited", "b", "f", "g", "a"));

    expect(plan).toEqual({
      unchanged: [1, 4],
      changed: [0, 2],
      added: [3],
      removed: [],
    });
  });

  it("sorts every field ascending when a revision edits and deletes", () => {
    // prev: a b c d e → current: c' b a. "c edited" consumes leftover "c";
    // "d" and "e" are the surplus the previous side carries, indexed into
    // the previous array.
    const plan = planBlocks(blocks("a", "b", "c", "d", "e"), blocks("c edited", "b", "a"));

    expect(plan).toEqual({
      unchanged: [1, 2],
      changed: [0],
      added: [],
      removed: [3, 4],
    });
  });

  it("is deterministic — the same inputs produce the same plan", () => {
    const previous = blocks("one", "two", "three");
    const current = blocks("three", "one changed", "four", "two");

    expect(planBlocks(previous, current)).toEqual(planBlocks(previous, current));
  });
});

describe("summarizePlan", () => {
  it("counts each field of a mixed plan", () => {
    const plan = planBlocks(blocks("a", "b", "c", "d"), blocks("c edited", "b", "f", "g", "a"));

    expect(summarizePlan(plan)).toEqual({ unchanged: 2, changed: 2, added: 1, removed: 0 });
  });

  it("counts the empty plan as zeros", () => {
    expect(summarizePlan(planBlocks([], []))).toEqual({
      unchanged: 0,
      changed: 0,
      added: 0,
      removed: 0,
    });
  });
});

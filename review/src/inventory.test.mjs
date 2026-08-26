// Tests for the changed-file inventory: universe filtering, byte-wise
// budget accounting, rename membership by head path, and rule selection.
// Every number here is computed, never asked of a model — these pins are
// what makes that claim checkable.

import { describe, expect, it } from "vitest";

import { buildInventory, selectActiveRules } from "./inventory.mjs";

/**
 * @param {string} filename
 * @param {number} additions
 * @param {number} deletions
 * @param {Partial<import("#core/forge.mjs").PullRequestFile>} [extra]
 * @returns {import("#core/forge.mjs").PullRequestFile}
 */
function file(filename, additions, deletions, extra = {}) {
  return { filename, status: "modified", additions, deletions, ...extra };
}

describe("the universe filter", () => {
  it("drops ignored files from every list and from the count", () => {
    const inventory = buildInventory({
      files: [
        file("src/a.mjs", 10, 0),
        file("pnpm-lock.yaml", 400, 400),
        file("dist/bundle.js", 5000, 0),
      ],
      ignore: ["pnpm-lock.yaml", "dist/**"],
      maxDiffLines: 100,
    });

    expect(inventory.ignored.map((f) => f.filename)).toEqual(["pnpm-lock.yaml", "dist/bundle.js"]);
    expect(inventory.reviewed.map((f) => f.filename)).toEqual(["src/a.mjs"]);
    expect(inventory.countedDiffLines).toBe(10);
  });

  it("decides renames by their head path only", () => {
    const inventory = buildInventory({
      files: [
        file("build/out.js", 5, 5, { status: "renamed", previousFilename: "src/old.js" }),
        file("src/moved-in.js", 1, 1, { status: "renamed", previousFilename: "dist/x.js" }),
      ],
      ignore: ["build/**", "dist/**"],
      maxDiffLines: 100,
    });

    // Renamed out of the ignore set → reviewed under its new name; renamed
    // into it → gone, whatever it used to be called.
    expect(inventory.reviewed.map((f) => f.filename)).toEqual(["src/moved-in.js"]);
    expect(inventory.ignored.map((f) => f.filename)).toEqual(["build/out.js"]);
  });
});

describe("the diff budget", () => {
  it("accumulates in byte-wise path order until the budget breaks", () => {
    const inventory = buildInventory({
      files: [file("z/last.mjs", 50, 0), file("a/first.mjs", 30, 0), file("m/mid.mjs", 30, 0)],
      ignore: [],
      maxDiffLines: 60,
    });

    // a (30) fits; m lands exactly on 60; z would push to 110 > 60, so z is
    // the remainder — in path order, not API order.
    expect(inventory.reviewed.map((f) => f.filename)).toEqual(["a/first.mjs", "m/mid.mjs"]);
    expect(inventory.excluded.map((f) => f.filename)).toEqual(["z/last.mjs"]);
    expect(inventory.countedDiffLines).toBe(60);
    expect(inventory.excludedDiffLines).toBe(50);
  });

  it("admits a file that lands exactly on the budget, refuses only what exceeds it", () => {
    const exact = buildInventory({
      files: [file("a.mjs", 25, 25), file("b.mjs", 10, 10)],
      ignore: [],
      maxDiffLines: 50,
    });
    expect(exact.reviewed.map((f) => f.filename)).toEqual(["a.mjs"]);
    expect(exact.countedDiffLines).toBe(50);
    expect(exact.excluded.map((f) => f.filename)).toEqual(["b.mjs"]);

    const oneOver = buildInventory({
      files: [file("a.mjs", 26, 25)],
      ignore: [],
      maxDiffLines: 50,
    });
    expect(oneOver.reviewed).toHaveLength(0);
    expect(oneOver.countedDiffLines).toBe(0);
    expect(oneOver.excludedDiffLines).toBe(51);
  });

  it("keeps zero-change entries inside any budget — they cost nothing", () => {
    const inventory = buildInventory({
      files: [file("mode-only.mjs", 0, 0), file("binary.png", 0, 0)],
      ignore: [],
      maxDiffLines: 1,
    });
    expect(inventory.reviewed).toHaveLength(2);
  });

  it("sorts candidates itself, immune to GitHub's answer order", () => {
    const first = buildInventory({
      files: [file("b.mjs", 40, 0), file("a.mjs", 40, 0)],
      ignore: [],
      maxDiffLines: 50,
    });
    expect(first.reviewed.map((f) => f.filename)).toEqual(["a.mjs"]);
  });
});

describe("rule selection", () => {
  const rules = [
    { include: ["src/**/*.mjs"], instruction: "js.md" },
    { include: ["handbook/**", "!handbook/internal/**"], instruction: "docs.md" },
    { include: ["**/*.rs"], instruction: "rust.md" },
  ];

  it("selects every rule matching at least one reviewed file, in config order", () => {
    const active = selectActiveRules(rules, [
      file("handbook/guide.md", 3, 0),
      file("src/index.mjs", 3, 0),
    ]);
    expect(active.map((r) => r.instruction)).toEqual(["js.md", "docs.md"]);
  });

  it("lets negation within an include list keep a rule dormant", () => {
    const active = selectActiveRules(rules, [file("handbook/internal/secret.md", 1, 1)]);
    expect(active).toEqual([]);
  });

  it("is dormancy, not an error, when nothing matches", () => {
    expect(selectActiveRules(rules, [])).toEqual([]);
  });
});

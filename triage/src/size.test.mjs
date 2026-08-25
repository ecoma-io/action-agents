// Tests for the size ladder.
//
// Measurement is the review-effort basis: additions plus deletions over the
// files exclude has not dropped, with renamed/binary/submodule entries
// contributing nothing because GitHub accounts them as zero. `upTo` is
// inclusive, the final rung catches everything, and validation refuses
// every ladder a diff could fall out of.

import { describe, expect, it } from "vitest";

import { measureSize, validateSizeConfig } from "./size.mjs";

const LADDER = [
  { upTo: 10, label: "size/xs" },
  { upTo: 50, label: "size/s" },
  { upTo: 200, label: "size/m" },
  { label: "size/xl" },
];

const PR_SHEET = new Set(["bug", "docs", "size/xs", "size/s", "size/m", "size/xl"]);

/** @param {Partial<{ filename: string, status: string, additions: number, deletions: number }>} file */
function file(file = {}) {
  return { filename: "a.mjs", status: "modified", additions: 0, deletions: 0, ...file };
}

describe("validateSizeConfig", () => {
  it("accepts the documented ladder and keeps the catch-all", () => {
    const config = validateSizeConfig({ ladder: LADDER, exclude: ["pnpm-lock.yaml"] }, PR_SHEET);
    expect(config.ladder).toEqual(LADDER);
    expect(config.exclude).toEqual(["pnpm-lock.yaml"]);
  });

  it("refuses a size label that is not on the PR sheet", () => {
    expect(() =>
      validateSizeConfig(
        { ladder: [{ upTo: 10, label: "size/xs" }, { label: "giant" }] },
        PR_SHEET,
      ),
    ).toThrow(/'giant' is not on the PR sheet/);
  });

  it("refuses a label declared on two rungs", () => {
    expect(() =>
      validateSizeConfig(
        { ladder: [{ upTo: 10, label: "size/xs" }, { label: "size/xs" }] },
        PR_SHEET,
      ),
    ).toThrow(/two rungs/);
  });

  it("refuses upTo values that do not ascend", () => {
    expect(() =>
      validateSizeConfig(
        {
          ladder: [
            { upTo: 50, label: "size/s" },
            { upTo: 10, label: "size/xs" },
            { label: "size/xl" },
          ],
        },
        PR_SHEET,
      ),
    ).toThrow(/must ascend/);
  });

  it("refuses a ladder without a final catch-all", () => {
    expect(() =>
      validateSizeConfig({ ladder: [{ upTo: 10, label: "size/xs" }] }, PR_SHEET),
    ).toThrow(/catch-all/);
  });

  it("refuses a catch-all in the middle of the ladder", () => {
    expect(() =>
      validateSizeConfig(
        { ladder: [{ label: "size/xl" }, { upTo: 10, label: "size/xs" }] },
        PR_SHEET,
      ),
    ).toThrow(/only the final rung/);
  });

  it("refuses upTo that is not a positive integer", () => {
    expect(() =>
      validateSizeConfig(
        { ladder: [{ upTo: 0, label: "size/xs" }, { label: "size/xl" }] },
        PR_SHEET,
      ),
    ).toThrow(/positive integer/);
    expect(() =>
      validateSizeConfig(
        { ladder: [{ upTo: 1.5, label: "size/xs" }, { label: "size/xl" }] },
        PR_SHEET,
      ),
    ).toThrow(/positive integer/);
  });

  it("refuses exclude patterns that are not non-empty strings", () => {
    expect(() => validateSizeConfig({ ladder: LADDER, exclude: [""] }, PR_SHEET)).toThrow(
      /patterns/,
    );
    expect(
      () =>
        /** @type {unknown} */ (
          validateSizeConfig({ ladder: LADDER, exclude: "docs/**" }, PR_SHEET)
        ),
    ).toThrow(/patterns/);
  });
});

describe("measureSize", () => {
  it("lands on the first rung for zero counted lines", () => {
    expect(measureSize([], [], LADDER).label).toBe("size/xs");
  });

  it("counts one line and lands on the first rung", () => {
    expect(measureSize([file({ additions: 1 })], [], LADDER).label).toBe("size/xs");
  });

  it("treats upTo as inclusive — 50 counted lines is size/s, 51 is size/m", () => {
    const exactly = measureSize([file({ additions: 25, deletions: 25 })], [], LADDER);
    const beyond = measureSize([file({ additions: 26, deletions: 25 })], [], LADDER);
    expect(exactly.label).toBe("size/s");
    expect(beyond.label).toBe("size/m");
  });

  it("lands on the catch-all above every rung", () => {
    expect(measureSize([file({ additions: 10_000 })], [], LADDER).label).toBe("size/xl");
  });

  it("drops excluded files from the measurement itself", () => {
    const files = [
      file({ filename: "pnpm-lock.yaml", additions: 5_000 }),
      file({ filename: "src/a.mjs", additions: 5 }),
    ];
    const measured = measureSize(files, ["pnpm-lock.yaml"], LADDER);
    expect(measured.label).toBe("size/xs");
    expect(measured.excluded).toBe(1);
  });

  it("counts zero for a diff whose every file is excluded, and lands on the first rung", () => {
    const files = [file({ filename: "pnpm-lock.yaml", additions: 9_999 })];
    const measured = measureSize(files, ["pnpm-lock.yaml"], LADDER);
    expect(measured).toMatchObject({ label: "size/xs", counted: 0, excluded: 1 });
  });

  it("counts renamed, binary and submodule entries as nothing — GitHub's own accounting", () => {
    const files = [
      file({ filename: "a.mjs", status: "renamed", additions: 0, deletions: 0 }),
      file({ filename: "b.png", status: "modified", additions: 0, deletions: 0 }),
      file({ filename: "vendor/lib", status: "modified", additions: 0, deletions: 0 }),
    ];
    expect(measureSize(files, [], LADDER).label).toBe("size/xs");
  });
});

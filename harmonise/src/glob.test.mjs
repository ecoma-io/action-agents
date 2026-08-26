// Tests for the glob matcher duplicate. The original lives in
// `triage/src/glob.mjs` and carries the full dialect suite; what is pinned
// here is that THIS copy speaks the same dialect — a divergence between the
// two files is a bug in whichever was edited alone.

import { describe, expect, it } from "vitest";

import { matchGlob } from "./glob.mjs";

describe("matchGlob (harmonise's copy)", () => {
  it("matches within one segment with * and across segments with **", () => {
    expect(matchGlob(["manual/*.md"], "manual/a.md")).toBe(true);
    expect(matchGlob(["manual/*.md"], "manual/a/b.md")).toBe(false);
    expect(matchGlob(["manual/**/*.md"], "manual/a/b.md")).toBe(true);
    expect(matchGlob(["**"], "anything/at/all")).toBe(true);
  });

  it("applies negations last-match-wins", () => {
    const patterns = ["manual/**", "!manual/private/**"];

    expect(matchGlob(patterns, "manual/open.md")).toBe(true);
    expect(matchGlob(patterns, "manual/private/x.md")).toBe(false);
  });

  it("selects nothing when given no patterns", () => {
    expect(matchGlob([], "any/path")).toBe(false);
  });

  it("keeps a trailing double star under its prefix — never a sibling", () => {
    expect(matchGlob(["manual/changelog/**"], "manual/changelogx.md")).toBe(false);
    expect(matchGlob(["manual/changelog/**"], "manual/changelog")).toBe(false);
    expect(matchGlob(["manual/changelog/**"], "manual/changelog/a.md")).toBe(true);
    expect(matchGlob(["manual/**"], "manual/x.md")).toBe(true);
    expect(matchGlob(["manual/**"], "manualx.md")).toBe(false);
  });
});

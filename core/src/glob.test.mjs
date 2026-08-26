// Tests for the glob dialect.
//
// The dialect is configuration.md's, and each rule it names is pinned by a
// case: `*` stays inside a segment, a double star crosses them, `!`
// negates, and the last match wins. The absence of gitignore's implicit
// any-depth is pinned too — it is the one difference a consumer would
// silently trip on. This is the promoted matcher: `triage` and `harmonise`
// import it exactly as `review` will.

import { describe, expect, it } from "vitest";

import { matchGlob } from "./glob.mjs";

describe("a single star", () => {
  it("matches within one path segment, and only there", () => {
    expect(matchGlob(["*.min.js"], "app.min.js")).toBe(true);
    expect(matchGlob(["*.min.js"], "build/app.min.js")).toBe(false);
    expect(matchGlob(["src/*.mjs"], "src/a.mjs")).toBe(true);
    expect(matchGlob(["src/*.mjs"], "src/ui/a.mjs")).toBe(false);
  });

  it("matches a bare name only at the root — there is no implicit any-depth", () => {
    expect(matchGlob(["pnpm-lock.yaml"], "pnpm-lock.yaml")).toBe(true);
    expect(matchGlob(["pnpm-lock.yaml"], "pkg/pnpm-lock.yaml")).toBe(false);
  });

  it("matches literal dots and any other regex metacharacter as themselves", () => {
    expect(matchGlob(["a.b.mjs"], "axb.mjs")).toBe(false);
    expect(matchGlob(["a+b.mjs"], "a+b.mjs")).toBe(true);
  });
});

describe("a double star", () => {
  it("crosses segments, including none", () => {
    expect(matchGlob(["**/*.min.js"], "app.min.js")).toBe(true);
    expect(matchGlob(["**/*.min.js"], "build/app.min.js")).toBe(true);
    expect(matchGlob(["**/*.min.js"], "a/b/c/app.min.js")).toBe(true);
    expect(matchGlob(["lib/**"], "lib/a/b.md")).toBe(true);
    expect(matchGlob(["**"], "any/thing/at/all")).toBe(true);
  });

  it("matches a whole path in the middle", () => {
    expect(matchGlob(["src/**/test.mjs"], "src/a/b/test.mjs")).toBe(true);
    expect(matchGlob(["src/**/test.mjs"], "src/test.mjs")).toBe(true);
    expect(matchGlob(["src/**/test.mjs"], "src/a/b/other.mjs")).toBe(false);
  });
});

describe("entries in order, last match wins", () => {
  it("lets a later entry override an earlier one", () => {
    expect(matchGlob(["lib/**", "!lib/secret.md"], "lib/secret.md")).toBe(false);
    expect(matchGlob(["lib/**", "!lib/secret.md"], "lib/open.md")).toBe(true);
    expect(matchGlob(["!**/*.min.js", "keep.min.js"], "keep.min.js")).toBe(true);
  });

  it("matches nothing when no entry matches", () => {
    expect(matchGlob(["lib/**"], "src/a.mjs")).toBe(false);
    expect(matchGlob([], "src/a.mjs")).toBe(false);
  });

  it("keeps a trailing double star under its prefix — never a sibling", () => {
    expect(matchGlob(["docs/changelog/**"], "docs/changelogx.md")).toBe(false);
    expect(matchGlob(["docs/changelog/**"], "docs/changelog")).toBe(false);
    expect(matchGlob(["docs/changelog/**"], "docs/changelog/a")).toBe(true);
    expect(matchGlob(["docs/**"], "docs/x.md")).toBe(true);
    expect(matchGlob(["docs/**"], "manualx.md")).toBe(false);
  });
});

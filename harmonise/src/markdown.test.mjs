// Tests for the Markdown mechanics: fence tracking, offset-preserving code
// span masking, and the structural profile a translation is judged by.

import { describe, expect, it } from "vitest";

import {
  compareStructuralProfiles,
  fenceMask,
  maskCodeSpans,
  maskDestinations,
  splitLines,
  structuralProfile,
} from "./markdown.mjs";

describe("fenceMask", () => {
  it("marks fence interiors and delimiters, not the lines around them", () => {
    const lines = splitLines("a\n```js\nconst x = 1;\n```\nb");

    expect(fenceMask(lines)).toEqual([false, true, true, true, false]);
  });

  it("tracks tilde fences and requires the same character to close", () => {
    const lines = splitLines("~~~\na\n```\nstill inside\n~~~\nout");

    expect(fenceMask(lines)).toEqual([true, true, true, true, true, false]);
  });

  it("ignores shorter or mismatched closers", () => {
    const lines = splitLines("````\na\n```\nstill\n````\n");

    expect(fenceMask(lines)).toEqual([true, true, true, true, true, false]);
  });

  it("leaves an unclosed fence open to the end", () => {
    const lines = splitLines("a\n```\nb\nc");

    expect(fenceMask(lines)).toEqual([false, true, true, true]);
  });

  it("accepts up to three leading spaces on a delimiter", () => {
    const lines = splitLines("   ```\nx\n   ```\ny");

    expect(fenceMask(lines)).toEqual([true, true, true, false]);
  });
});

describe("maskCodeSpans", () => {
  it("masks span interiors without changing length or columns", () => {
    const line = "use `npm run x` now";
    const masked = maskCodeSpans(line);

    expect(masked.length).toBe(line.length);
    // Delimiters stay literal; the nine interior characters become NULs.
    expect(masked.slice(5, 14)).toBe("\u0000".repeat(9));
    expect(masked[4]).toBe("`");
    expect(masked[14]).toBe("`");
  });

  it("keeps escaped backticks literal", () => {
    const line = "a \\` b `code`";
    const masked = maskCodeSpans(line);

    expect(masked.slice(0, 7)).toBe("a \\` b ");
    expect(masked[8]).toBe("\u0000");
    expect(masked[12]).toBe("`");
  });

  it("masks an unterminated span conservatively to end of line", () => {
    const masked = maskCodeSpans("a `b c d");

    expect(masked).toBe("a `\u0000\u0000\u0000\u0000\u0000");
  });
});

describe("maskDestinations", () => {
  it("blanks an inline construct's interior while keeping link text visible", () => {
    const line = 'see [the repo](repo/x.md "docs") and ![img](i.png) now';
    const masked = maskDestinations(line);

    expect(masked).toHaveLength(line.length);
    expect(masked.startsWith("see [the repo](")).toBe(true);
    // Destination and title are one machinery interior; the second link's
    // destination masks the same way; the prose around stays.
    expect(masked).toBe(
      "see [the repo](" +
        "\u0000".repeat('repo/x.md "docs"'.length) +
        ") and ![img](" +
        "\u0000".repeat(5) +
        ") now",
    );
  });

  it("preserves length even with astral characters around and inside machinery", () => {
    for (const line of [
      "[x](a🎉.md) repository lives",
      "🎉 [docs](v1🎉guide.md); the repository grows 🎉",
      "emoji 👨‍👩‍👧 family then [l](d.md) tail repository",
    ]) {
      expect(maskDestinations(line)).toHaveLength(line.length);
    }
  });

  it("locates a reference definition's destination by its own match index", () => {
    // The label repeats the destination's text: only the destination masks.
    const line = '[repository]: repository.md "docs"';
    const masked = maskDestinations(line);

    expect(masked).toHaveLength(line.length);
    expect(masked.slice(0, "[repository]: ".length)).toBe("[repository]: ");
    expect(
      masked.includes('repository.md "docs"'.replace("repository.md", "\u0000".repeat(12))),
    ).toBe(true);
  });

  it("keeps prose after an unprovable construct unmasked", () => {
    const line = '[a](b.md "see ](" ) repository';
    const masked = maskDestinations(line);

    // The first construct never closes, so it proves nothing and masks
    // nothing; the stray `](` in the title opens only the two bytes before
    // its own `)`. The trailing prose keeps full protection.
    expect(masked).toBe('[a](b.md "see ](' + "\u0000\u0000" + ") repository");
  });

  it("does not open a window on an escaped bracket", () => {
    const line = "escape \\]( not-a-link repository";
    const masked = maskDestinations(line);

    expect(masked).toBe(line);
  });

  it("masks angle autolinks and bare scheme URLs whole", () => {
    const line = "visit <https://x.repository/a> or https://y.repository/commit today";
    const masked = maskDestinations(line);
    const blanked = masked.split("\u0000").length - 1;

    expect(masked).toHaveLength(line.length);
    expect(blanked).toBe("<https://x.repository/a>".length + "https://y.repository/commit".length);
  });
});

describe("structuralProfile", () => {
  it("counts fences, heading levels and broken inline constructs", () => {
    const profile = structuralProfile(
      "# Title\n\n```js\nlet a = 1;\n```\n\n## Next\n\ntext [broken](x\n",
    );

    expect(profile.fenceCount).toBe(1);
    expect(profile.headingLevels).toEqual([1, 2]);
    expect(profile.brokenInlineCount).toBe(1);
  });

  it("does not count fences, headings or links inside code fences", () => {
    const profile = structuralProfile("# T\n\n```\n## not a heading\n[not a link](x\n```\n");

    expect(profile.fenceCount).toBe(1);
    expect(profile.headingLevels).toEqual([1]);
    expect(profile.brokenInlineCount).toBe(0);
  });

  it("does not count inline-code contents as constructs", () => {
    const profile = structuralProfile("run `[broken](x` first\n");

    expect(profile.brokenInlineCount).toBe(0);
  });
});

describe("compareStructuralProfiles", () => {
  it("passes identical profiles with no violations", () => {
    const source = structuralProfile("# A\n\n```js\nx\n```\n\n## B\n");
    expect(compareStructuralProfiles(source, source)).toEqual([]);
  });

  it("names a changed fence count", () => {
    const source = structuralProfile("```\nx\n```\n");
    const candidate = structuralProfile("");

    expect(compareStructuralProfiles(source, candidate)).toHaveLength(1);
    expect(compareStructuralProfiles(source, candidate)[0]).toMatch(/fenced code block/);
  });

  it("names a changed heading level and count", () => {
    const source = structuralProfile("# A\n\n## B\n");
    const leveled = structuralProfile("# A\n\n### B\n");
    const counted = structuralProfile("# A\n");

    expect(compareStructuralProfiles(source, leveled)[0]).toMatch(/changed level: h2 → h3/);
    expect(compareStructuralProfiles(source, counted)).toContainEqual(
      expect.stringMatching(/heading count changed/),
    );
  });

  it("flags new broken inline syntax but tolerates the source's own", () => {
    const source = structuralProfile("[fine](x.md) and [broken](y\n");
    const worse = structuralProfile("[fine](x.md) and [broken](y\n plus [worse](z\n");
    const better = structuralProfile("[fine](x.md)\n");

    expect(compareStructuralProfiles(source, worse)).toContainEqual(
      expect.stringMatching(/broken inline/),
    );
    expect(compareStructuralProfiles(source, better)).toEqual([]);
  });
});

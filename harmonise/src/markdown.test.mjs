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

  it("profiles list blocks: shape, item count and nesting depth", () => {
    const profile = structuralProfile(
      "- one\n- two\n  - nested\n- back\n\n1. alpha\n2. beta\n   1. deep\n",
    );

    expect(profile.listBlocks).toEqual([
      { ordered: false, marker: "-", items: 4, maxDepth: 2 },
      { ordered: true, marker: "1.", items: 3, maxDepth: 2 },
    ]);
  });

  it("normalizes ordered markers to their shape, never their start digit", () => {
    const profile = structuralProfile("3. a\n4. b\n");

    expect(profile.listBlocks).toEqual([{ ordered: true, marker: "1.", items: 2, maxDepth: 1 }]);
    expect(structuralProfile("1) a\n2) b\n").listBlocks[0]?.marker).toBe("1)");
  });

  it("reads thematic breaks and bare markers as breaks, not list items", () => {
    const profile = structuralProfile("-\n- - -\n* * *\n---\n");

    expect(profile.listBlocks).toEqual([]);
  });

  it("opens a new block on a marker shallower than every open level", () => {
    const profile = structuralProfile("  - a\n- b\n");

    expect(profile.listBlocks).toEqual([
      { ordered: false, marker: "-", items: 1, maxDepth: 1 },
      { ordered: false, marker: "-", items: 1, maxDepth: 1 },
    ]);
  });

  it("profiles blockquote blocks and their nesting depth", () => {
    const profile = structuralProfile("> one\n> two\n\nplain\n\n> > deep\n>shallow\n");

    expect(profile.blockquoteBlocks).toEqual({ count: 2, maxDepths: [1, 2] });
  });

  it("profiles pipe tables: rows, columns and delimiter alignment", () => {
    const profile = structuralProfile(
      "| a | b | c |\n| :-- | --: | :-: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n",
    );

    expect(profile.tables).toEqual([{ rows: 3, cols: 3, alignment: ["left", "right", "center"] }]);
  });

  it("does not split a cell on an escaped pipe", () => {
    const profile = structuralProfile("| a \\| b |\n| --- |\n| 1 |\n");

    expect(profile.tables).toEqual([{ rows: 2, cols: 1, alignment: ["none"] }]);
  });

  it("does not count a table whose delimiter row has a stray cell", () => {
    const profile = structuralProfile("| a | b |\n| --- | x |\n");

    expect(profile.tables).toEqual([]);
  });

  it("ends a table at its first following line without a pipe", () => {
    const profile = structuralProfile("| a | b |\n| --- | --- |\n| 1 | 2 |\nprose tail\n");

    expect(profile.tables).toEqual([{ rows: 2, cols: 2, alignment: ["none", "none"] }]);
  });

  it("counts reference definitions", () => {
    const profile = structuralProfile('[one]: guide.md\n[two]: handbook/x.md "title"\n');

    expect(profile.referenceDefinitionCount).toBe(2);
  });

  it("counts complete inline links, images and angle autolinks only", () => {
    const profile = structuralProfile(
      "see [guide](guide.md) and ![logo](logo.png), browse <https://example.com/x>, " +
        "use [ref][one], bare https://example.com/y, broken [text](\n",
    );

    expect(profile.linkConstructs).toEqual({ inlineLinks: 1, images: 1, autolinks: 1 });
  });

  it("counts an escaped bang as a link, not an image", () => {
    const profile = structuralProfile("\\![a](x.md)\n");

    expect(profile.linkConstructs).toEqual({ inlineLinks: 1, images: 0, autolinks: 0 });
  });

  it("counts one construct when a balanced title itself contains ](", () => {
    const profile = structuralProfile('[a](x.md "t]( )t")\n');

    expect(profile.linkConstructs).toEqual({ inlineLinks: 1, images: 0, autolinks: 0 });
  });

  it("skips escaped characters while matching a destination's parens", () => {
    const profile = structuralProfile("[a](x\\)y.md)\n");

    expect(profile.linkConstructs.inlineLinks).toBe(1);
  });

  it("profiles a closed leading frontmatter block and ignores its interior", () => {
    const profile = structuralProfile("---\ntitle: # not a heading\n---\n# Real\n");

    expect(profile.frontmatter).toEqual({ present: true, lines: 3 });
    expect(profile.headingLevels).toEqual([1]);
  });

  it("treats an unclosed leading --- block as no frontmatter", () => {
    const profile = structuralProfile("---\ntitle: x\n# Real\n");

    expect(profile.frontmatter).toEqual({ present: false, lines: 0 });
  });

  it("keeps list and table machinery out of fences, code spans and quote tails", () => {
    const fenced = structuralProfile(
      "```\n- not a list\n| not | a | table |\n| --- | --- |\n```\n",
    );
    const spanned = structuralProfile("`- not a list`\n");
    const afterQuote = structuralProfile("> quoted\n- not a list\n");

    expect(fenced.listBlocks).toEqual([]);
    expect(fenced.tables).toEqual([]);
    expect(spanned.listBlocks).toEqual([]);
    expect(afterQuote.listBlocks).toEqual([]);
  });

  it("keeps a list block open across a fenced block inside an item", () => {
    const profile = structuralProfile("- one\n\n  ```js\n  keep()\n  ```\n\n- two\n");

    expect(profile.listBlocks).toEqual([{ ordered: false, marker: "-", items: 2, maxDepth: 1 }]);
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

  it("names a changed list block count, marker, items and depth", () => {
    const base = structuralProfile("- one\n- two\n- three\n");
    expect(
      compareStructuralProfiles(base, structuralProfile("- one\n- two\n\n1. x\n")),
    ).toContainEqual("list block count changed: 1 → 2");
    expect(
      compareStructuralProfiles(base, structuralProfile("1. one\n1. two\n1. three\n")),
    ).toContainEqual("list block 1 marker changed: - to 1.");
    expect(compareStructuralProfiles(base, structuralProfile("- one\n- two\n"))).toContainEqual(
      "list block 1 item count changed: 3 → 2",
    );
    expect(
      compareStructuralProfiles(base, structuralProfile("- one\n- two\n  - three\n")),
    ).toContainEqual("list block 1 max depth changed: 1 → 2");
  });

  it("names changed blockquote count and depth", () => {
    const base = structuralProfile("> quoted\n");

    expect(compareStructuralProfiles(base, structuralProfile(""))).toContainEqual(
      "blockquote count changed: 1 → 0",
    );
    expect(compareStructuralProfiles(base, structuralProfile("> > quoted\n"))).toContainEqual(
      "blockquote block 1 max depth changed: 1 → 2",
    );
  });

  it("names changed table count, rows, columns and alignment", () => {
    const base = structuralProfile("| a | b |\n| :-- | --: |\n| 1 | 2 |\n");

    expect(
      compareStructuralProfiles(base, structuralProfile("| a | b |\n| :-- | --: |\n")),
    ).toContainEqual("table 1 row count changed: 2 → 1");
    expect(
      compareStructuralProfiles(
        base,
        structuralProfile("| a | b | c |\n| :-- | --: | --- |\n| 1 | 2 | 3 |\n"),
      ),
    ).toContainEqual("table 1 column count changed: 2 → 3");
    expect(
      compareStructuralProfiles(base, structuralProfile("| a | b |\n| --- | --- |\n| 1 | 2 |\n")),
    ).toContainEqual("table 1 column alignment changed: left,right to none,none");
    expect(compareStructuralProfiles(base, structuralProfile(""))).toContainEqual(
      "table count changed: 1 → 0",
    );
  });

  it("names a changed reference definition count", () => {
    const base = structuralProfile("[one]: guide.md\n");

    expect(
      compareStructuralProfiles(base, structuralProfile("[one]: guide.md\n[two]: other.md\n")),
    ).toContainEqual("reference definition count changed: 1 → 2");
  });

  it("names changed inline link, image and autolink counts", () => {
    const base = structuralProfile("see [guide](guide.md) and ![logo](logo.png)\n");

    expect(
      compareStructuralProfiles(base, structuralProfile("see guide and ![logo](logo.png)\n")),
    ).toContainEqual("inline link count changed: 1 → 0");
    expect(
      compareStructuralProfiles(base, structuralProfile("see [guide](guide.md)\n")),
    ).toContainEqual("image count changed: 1 → 0");
    expect(
      compareStructuralProfiles(
        structuralProfile("![logo](logo.png)\n"),
        structuralProfile("[logo](logo.png)\n"),
      ),
    ).toContainEqual("image count changed: 1 → 0");
    expect(
      compareStructuralProfiles(
        base,
        structuralProfile("see [guide](guide.md) and ![logo](logo.png) at <https://example.com>\n"),
      ),
    ).toContainEqual("autolink count changed: 0 → 1");
  });

  it("names changed frontmatter presence and extent", () => {
    const base = structuralProfile("---\ntitle: x\n---\nbody\n");

    expect(compareStructuralProfiles(base, structuralProfile("body\n"))).toContainEqual(
      "frontmatter presence changed: present to absent",
    );
    expect(
      compareStructuralProfiles(base, structuralProfile("---\ntitle: x\nlang: fr\n---\nbody\n")),
    ).toContainEqual("frontmatter line count changed: 3 → 4");
  });

  it("still flags reordered or re-charactered fenced blocks", () => {
    const source = structuralProfile("```js\na()\n```\n\ntext\n\n~~~\nb()\n~~~\n");
    const candidate = structuralProfile("~~~\nb()\n~~~\n\ntext\n\n```js\na()\n```\n");

    expect(compareStructuralProfiles(source, candidate)).toContainEqual(
      "fenced code blocks appear in a different order or kind",
    );
  });
});

describe("structural profile tolerance", () => {
  /** @type {[string, string, string][]} */ const cases = [
    ["paragraph split or merge", "one two\nthree\n", "one\n\ntwo\n\nthree\n"],
    ["re-wrapped lines", "one two three four five six\n", "one two three\nfour five six\n"],
    ["emphasis changes", "a **bold** and *light* word\n", "a *bold* and **light** word\n"],
    ["lazy continuation items", "- one\n  cont\n", "- uno\n  cont\n"],
    [
      "indented code inside a list item",
      "- one\n\n    code()\n\n- two\n",
      "- uno\n\n    code()\n\n- dos\n",
    ],
    ["horizontal rules", "a\n\n---\n\nb\n", "a\n\n***\n\nb\n"],
    ["setext headings", "Title\n=====\n\ntext\n", "Title\n=====\n\nprose\n"],
    ["item reorder of the same shape", "- one\n- two\n", "- two\n- one\n"],
    ["tight to loose lists", "- one\n- two\n", "- one\n\n- two\n"],
  ];

  for (const [name, source, candidate] of cases) {
    it(`accepts ${name}`, () => {
      expect(
        compareStructuralProfiles(structuralProfile(source), structuralProfile(candidate)),
      ).toEqual([]);
    });
  }
});

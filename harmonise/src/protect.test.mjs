// Tests for protected spans: skip directives and glossary terms, the
// placeholders that carry them, and the restoration that must be byte-for-byte.
//
// The adversarial cases are the point: a malformed directive is refused rather
// than silently honored or ignored, a source cannot forge this run's tokens,
// and a translation that loses, duplicates or edits a token never restores.

import { describe, expect, it } from "vitest";

import { protectDocument, restoreDocument } from "./protect.mjs";

/** A stable run id so tests can name tokens exactly. @returns {string} */
const fixedId = () => "0123456789abcdef";

/**
 * @param {string} source
 * @param {object} [options]
 * @param {string[]} [options.glossary]
 * @returns {{ protection: ReturnType<typeof protectDocument> }}
 */
function protect(source, options = {}) {
  return {
    protection: protectDocument(source, {
      glossary: options.glossary ?? [],
      newId: fixedId,
    }),
  };
}

describe("glossary protection", () => {
  it("replaces a single term with one token and counts it", () => {
    const { protection } = protect("The repository grows.\n", { glossary: ["repository"] });

    expect(protection.text).toBe("The [[harmonise:0123456789abcdef:g1]] grows.\n");
    expect(protection.glossaryHits).toBe(1);
    expect(protection.counts.get("[[harmonise:0123456789abcdef:g1]]")).toBe(1);
  });

  it("uses one token per term across repeated occurrences", () => {
    const { protection } = protect("a pull request opens a pull request\n", {
      glossary: ["pull request"],
    });

    expect(protection.text).toBe(
      "a [[harmonise:0123456789abcdef:g1]] opens a [[harmonise:0123456789abcdef:g1]]\n",
    );
    expect(protection.glossaryHits).toBe(2);
  });

  it("matches case-sensitively and leaves other casings alone", () => {
    const { protection } = protect("Repository and repository\n", { glossary: ["Repository"] });

    expect(protection.text).toBe("[[harmonise:0123456789abcdef:g1]] and repository\n");
  });

  it("prefers the longest term where terms share a prefix", () => {
    const { protection } = protect("one pull request template\n", {
      glossary: ["request", "pull request"],
    });

    // "pull request" wins as a whole; "request" inside it is untouched.
    expect(protection.text).toBe("one [[harmonise:0123456789abcdef:g2]] template\n");
  });

  it("never matches inside fenced blocks or inline code spans", () => {
    const source = "```\nrepository\n```\n\nrun `repository --help`\n";
    const { protection } = protect(source, { glossary: ["repository"] });

    expect(protection.text).toBe(source);
    expect(protection.glossaryHits).toBe(0);
  });
});

describe("skip directives", () => {
  it("preserves the next non-blank line after harmonise:skip", () => {
    const source = "before\n<!-- harmonise:skip -->\n\nkeep me verbatim\nafter\n";
    const { protection } = protect(source);

    expect(protection.text).toContain("before\n[[harmonise:0123456789abcdef:s1]]\nafter");
    expect(protection.skippedSpans).toBe(1);
    expect(protection.spans.get("[[harmonise:0123456789abcdef:s1]]")).toBe(
      "<!-- harmonise:skip -->\n\nkeep me verbatim",
    );
  });

  it("preserves a whole region including its markers", () => {
    const source =
      "a\n<!-- harmonise:skip-start -->\nraw **stuff**\n<!-- harmonise:skip-end -->\nb\n";
    const { protection } = protect(source);

    expect(protection.text).toBe("a\n[[harmonise:0123456789abcdef:s1]]\nb\n");
    expect(protection.spans.get("[[harmonise:0123456789abcdef:s1]]")).toBe(
      "<!-- harmonise:skip-start -->\nraw **stuff**\n<!-- harmonise:skip-end -->",
    );
  });

  it("tolerates whitespace inside the comment", () => {
    const source = "<!--harmonise:skip-->\nx\n";
    const { protection } = protect(source);

    expect(protection.skippedSpans).toBe(1);
  });

  it("treats directives inside fences as content", () => {
    const source = "```\n<!-- harmonise:skip-end -->\n```\n";
    const { protection } = protect(source);

    expect(protection.text).toBe(source);
    expect(protection.skippedSpans).toBe(0);
  });

  it("refuses an unknown order to the action", () => {
    expect(() => protect("x\n<!-- harmonise:skip-everything -->\ny\n")).toThrow(
      /addresses harmonise but is not one of/,
    );
  });

  it("refuses a skip-end with no open region", () => {
    expect(() => protect("a\n<!-- harmonise:skip-end -->\n")).toThrow(/no open/);
  });

  it("refuses nested regions", () => {
    expect(() =>
      protect("<!-- harmonise:skip-start -->\na\n<!-- harmonise:skip-start -->\nb\n"),
    ).toThrow(/nested regions are not supported|already open/);
  });

  it("refuses an unclosed region", () => {
    expect(() => protect("a\n<!-- harmonise:skip-start -->\nb\n")).toThrow(/never closed/);
  });

  it("refuses a trailing skip with no line to preserve", () => {
    expect(() => protect("a\n<!-- harmonise:skip -->")).toThrow(/no following line to preserve/);
  });

  it("refuses a skip whose next non-blank line is fenced", () => {
    expect(() => protect("a\n<!-- harmonise:skip -->\n```js\ncode\n```\nafter\n")).toThrow(
      /would target a fenced code block/,
    );
    // Even when more content follows the fence: the directive's target is the
    // fenced line, and that target is refused rather than widened past it.
    expect(() => protect("<!-- harmonise:skip -->\n```\n```\nb\n")).toThrow(
      /would target a fenced code block/,
    );
  });

  it("carries fences inside regions verbatim", () => {
    const source = "<!-- harmonise:skip-start -->\n```js\nx\n```\n<!-- harmonise:skip-end -->\n";
    const { protection } = protect(source);

    expect(protection.skippedSpans).toBe(1);
  });

  it("coalesces overlapping claims into their union instead of colliding", () => {
    const source = "<!-- harmonise:skip -->\n<!-- harmonise:skip -->\nshared target\n";
    const { protection } = protect(source);

    expect(protection.skippedSpans).toBe(1);
    expect(protection.spans.get("[[harmonise:0123456789abcdef:s1]]")).toBe(
      "<!-- harmonise:skip -->\n<!-- harmonise:skip -->\nshared target",
    );
  });
});

describe("placeholder security", () => {
  it("regenerates the id when a source already contains the namespace", () => {
    let call = 0;
    /** @returns {string} */
    const colliding = () => {
      call += 1;
      return call <= 1 ? "deadbeefdeadbeef" : fixedId();
    };
    // The source carries literal text in the token namespace; the term's
    // minted token must not reuse that id.
    const protection = protectDocument(
      "holds [[harmonise:deadbeefdeadbeef:g9]] and the repository\n",
      { glossary: ["repository"], newId: colliding },
    );

    expect(call).toBe(2);
    expect(protection.text).toContain("the [[harmonise:0123456789abcdef:g1]]");
    expect(protection.text).not.toContain("[[harmonise:deadbeefdeadbeef:g1]]");
  });

  it("refuses a source that keeps colliding with fresh ids", () => {
    expect(() =>
      protectDocument("[[harmonise:0000000000000000:g1]]\n", {
        glossary: [],
        newId: () => "0000000000000000",
      }),
    ).toThrow(/colliding with 5 consecutive/);
  });
});

describe("restoration", () => {
  it("restores tokens to the exact original bytes", () => {
    const source =
      "# T\n\nThe repository holds:\n\n<!-- harmonise:skip-start -->\n```raw\nstuff\n```\n<!-- harmonise:skip-end -->\n";
    const { protection } = protect(source, { glossary: ["repository"] });

    const translated =
      "# T\n\nLe [[harmonise:0123456789abcdef:g1]] contient :\n\n" +
      "[[harmonise:0123456789abcdef:s1]]\n";

    // Prose is the model's business; tokens come back byte-for-byte.
    expect(restoreDocument(translated, protection)).toBe(
      "# T\n\nLe repository contient :\n\n<!-- harmonise:skip-start -->\n```raw\nstuff\n```\n<!-- harmonise:skip-end -->\n",
    );
  });

  it("refuses a translation that lost a token", () => {
    const { protection } = protect("the repository\n", { glossary: ["repository"] });

    expect(() => restoreDocument("le dépôt\n", protection)).toThrow(
      /appears 0 times, expected 1.*lost protected content/s,
    );
  });

  it("refuses a translation that duplicated a token", () => {
    const { protection } = protect("the repository\n", { glossary: ["repository"] });
    const token = "[[harmonise:0123456789abcdef:g1]]";

    expect(() => restoreDocument(`x ${token} y ${token}\n`, protection)).toThrow(
      /appears 2 times, expected 1/,
    );
  });

  it("refuses a token this run never minted", () => {
    const { protection } = protect("plain\n");

    expect(() => restoreDocument("[[harmonise:ffffffffffffffff:g99]]\n", protection)).toThrow(
      /which this run never minted/,
    );
  });

  it("round-trips arbitrary bytes through protect → restore", () => {
    const source =
      "a\r\n<!-- harmonise:skip-start -->\r\n  spaced \t lines \r\n<!-- harmonise:skip-end -->\r\nz\r\n";
    const { protection } = protect(source);

    const retranslated = `${protection.text}`;
    expect(restoreDocument(retranslated, protection)).toBe(source);
  });
});

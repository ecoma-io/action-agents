// Tests for protected spans: skip directives and glossary terms, the
// placeholders that carry them, and the restoration that must be byte-for-byte.
//
// The adversarial cases are the point: a malformed directive is refused rather
// than silently honored or ignored, a source cannot forge this run's tokens,
// and a translation that loses, duplicates or edits a token never restores.

import { describe, expect, it } from "vitest";

import { protectDocument, restoreDocument } from "./protect.mjs";
import { DeterministicRefusalError } from "./refusal.mjs";

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

  it("does not match inside a longer word — no stemming by substring", () => {
    const { protection } = protect("He committed to the commitment and will recommit.\n", {
      glossary: ["commit"],
    });

    expect(protection.text).toBe("He committed to the commitment and will recommit.\n");
    expect(protection.glossaryHits).toBe(0);
  });

  it("does not match when an underscore joins it into one identifier", () => {
    const { protection } = protect("set commit_hash before committing\n", {
      glossary: ["commit"],
    });

    expect(protection.glossaryHits).toBe(0);
  });

  it("matches a term adjacent to punctuation", () => {
    const { protection } = protect('The repository, (repository) "repository" works.\n', {
      glossary: ["repository"],
    });
    const token = "[[harmonise:0123456789abcdef:g1]]";

    expect(protection.text).toBe(`The ${token}, (${token}) "${token}" works.\n`);
    expect(protection.glossaryHits).toBe(3);
  });

  it("matches link text but never a link or image destination", () => {
    const source = "See [the repository](repo/repository.md) and ![the repository](img.png) now.\n";
    const { protection } = protect(source, { glossary: ["repository"] });

    // The two prose occurrences are protected; both destinations survive
    // byte-for-byte so the link rewriter still sees real paths.
    expect(protection.text).toBe(
      "See [the [[harmonise:0123456789abcdef:g1]]](repo/repository.md) and " +
        "![the [[harmonise:0123456789abcdef:g1]]](img.png) now.\n",
    );
    expect(protection.glossaryHits).toBe(2);
  });

  it("never matches inside a reference definition's destination", () => {
    const source = '[docs]: repo/repository.md "the repository docs"\n';
    const { protection } = protect(source, { glossary: ["repository"] });

    expect(protection.text).toBe(
      '[docs]: repo/repository.md "the [[harmonise:0123456789abcdef:g1]] docs"\n',
    );
    expect(protection.glossaryHits).toBe(1);
  });

  it("never matches inside bare URLs or angle autolinks", () => {
    const source =
      "Read https://example.com/commit-guidelines and <https://example.com/repository>.\n";
    const { protection } = protect(source, { glossary: ["commit", "repository"] });

    expect(protection.text).toBe(source);
    expect(protection.glossaryHits).toBe(0);
  });

  it("keeps offsets exact when an astral character precedes machinery and prose", () => {
    // A surrogate pair before a link shifts UTF-16 columns; the term after
    // the link must still be protected at its true position, and the
    // destination must survive untouched.
    const source = "🎉 [docs](v1🎉guide.md); the repository grows\n";
    const { protection } = protect(source, { glossary: ["repository"] });
    const token = "[[harmonise:0123456789abcdef:g1]]";

    expect(protection.text).toBe(`🎉 [docs](v1🎉guide.md); the ${token} grows\n`);
    expect(restoreDocument(protection.text, protection)).toBe(source);
  });

  it("still protects prose after a construct whose title hides another ](", () => {
    const source = '[a](b.md "see ](" ) repository\n';
    const { protection } = protect(source, { glossary: ["repository"] });

    // The unprovable construct is left entirely alone; the term after it is.
    // not sacrificed to it.
    expect(protection.glossaryHits).toBe(1);
    expect(restoreDocument(protection.text, protection)).toBe(source);
  });

  it("matches a short term standalone and the long term at its own position", () => {
    const { protection } = protect("file a request, then review a pull request\n", {
      glossary: ["pull request", "request"],
    });

    expect(protection.text).toBe(
      "file a [[harmonise:0123456789abcdef:g2]], then review a [[harmonise:0123456789abcdef:g1]]\n",
    );
    expect(protection.glossaryHits).toBe(2);
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

  it("round-trips a CRLF document with glossary and skip-next byte-for-byte", () => {
    const source =
      "Title\r\n\r\n<!-- harmonise:skip -->\r\n\r\nkeep me verbatim\r\nThe repository holds.\r\n";
    const { protection } = protect(source, { glossary: ["repository"] });

    expect(protection.skippedSpans).toBe(1);
    expect(protection.glossaryHits).toBe(1);
    expect(restoreDocument(protection.text, protection)).toBe(source);
  });

  it("round-trips mixed LF and CRLF newlines byte-for-byte", () => {
    const source = "one\n<!-- harmonise:skip -->\r\n\r\nkeep\r\ntwo\nrepository\n";
    const { protection } = protect(source, { glossary: ["repository"] });

    expect(protection.glossaryHits).toBe(1);
    expect(restoreDocument(protection.text, protection)).toBe(source);
  });

  it("round-trips a document with no trailing newline byte-for-byte", () => {
    const source =
      "head\r\n<!-- harmonise:skip-start -->\r\nbody\r\n<!-- harmonise:skip-end -->\ntail repository";
    const { protection } = protect(source, { glossary: ["repository"] });

    expect(protection.glossaryHits).toBe(1);
    expect(restoreDocument(protection.text, protection)).toBe(source);
  });
});

describe("placeholder order", () => {
  /** @param {number} n @returns {string} */
  const g = (n) => `[[harmonise:0123456789abcdef:g${String(n)}]]`;
  /** @param {number} n @returns {string} */
  const s = (n) => `[[harmonise:0123456789abcdef:s${String(n)}]]`;

  it("refuses a candidate that swaps two single-occurrence placeholders", () => {
    const { protection } = protect("Alpha keeps logs 30 days. Beta must ship weekly.\n", {
      glossary: ["logs 30 days", "ship weekly"],
    });
    const candidate = `Alpha keeps ${g(2)}. Beta must ${g(1)}.\n`;
    expect(() => restoreDocument(candidate, protection)).toThrow(
      `placeholder ${g(2)} appears before ${g(1)} — the candidate does not preserve the protected content's order`,
    );
    expect(() => restoreDocument(candidate, protection)).toThrow(DeterministicRefusalError);
  });

  it("refuses the issue's transposition repro", () => {
    const { protection } = protect("Alpha keeps logs 30 days. Beta must ship weekly.", {
      glossary: ["logs 30 days", "ship weekly"],
    });
    const swapped = protection.text
      .replace(g(1), "@@A@@")
      .replace(g(2), g(1))
      .replace("@@A@@", g(2));
    expect(() => restoreDocument(swapped, protection)).toThrow(
      `placeholder ${g(2)} appears before ${g(1)} — the candidate does not preserve the protected content's order`,
    );
  });

  it("refuses a singleton swapped with a repeated token's first occurrence", () => {
    const { protection } = protect(
      "Alpha keeps logs 30 days. Beta must ship weekly. Gamma cites ship weekly again.\n",
      { glossary: ["logs 30 days", "ship weekly"] },
    );
    // g(1) is required once, g(2) twice: counts match, yet the first g(2)
    // landing before g(1) means the protected bytes come back swapped (#358).
    const candidate = `Alpha keeps ${g(2)}. Beta must ${g(1)}. Gamma cites ${g(2)} again.\n`;
    expect(() => restoreDocument(candidate, protection)).toThrow(
      `placeholder ${g(2)} appears before ${g(1)} — the candidate does not preserve the protected content's order`,
    );
    expect(() => restoreDocument(candidate, protection)).toThrow(DeterministicRefusalError);
  });

  it("restores a repeated token in place beside its singleton neighbour", () => {
    const { protection } = protect(
      "Alpha keeps logs 30 days. Beta must ship weekly. Gamma cites ship weekly again.\n",
      { glossary: ["logs 30 days", "ship weekly"] },
    );
    expect(restoreDocument(protection.text, protection)).toBe(
      "Alpha keeps logs 30 days. Beta must ship weekly. Gamma cites ship weekly again.\n",
    );
  });

  it("restores an in-order candidate byte-for-byte", () => {
    const source = "Alpha keeps logs 30 days. Beta must ship weekly.\n";
    const { protection } = protect(source, { glossary: ["logs 30 days", "ship weekly"] });
    expect(restoreDocument(`Alpha keeps ${g(1)}. Beta must ${g(2)}.\n`, protection)).toBe(source);
  });

  it("pins a repeated token's first occurrence and lets its later ones land by counts alone", () => {
    const { protection } = protect(
      "Alpha keeps logs 30 days. Beta must logs 30 days. Gamma will ship weekly.\n",
      { glossary: ["logs 30 days", "ship weekly"] },
    );
    // Document order is g(1), g(1), g(2): the first g(1) must precede the
    // first g(2), but where the second g(1) lands is counts' business.
    const clustered = `First ${g(1)}. Then ${g(1)} and ${g(2)}.\n`;
    expect(restoreDocument(clustered, protection)).toBe(
      "First logs 30 days. Then logs 30 days and ship weekly.\n",
    );
    const firstSwapped = `First ${g(2)}. Then ${g(1)} and ${g(1)}.\n`;
    expect(() => restoreDocument(firstSwapped, protection)).toThrow(
      `placeholder ${g(2)} appears before ${g(1)} — the candidate does not preserve the protected content's order`,
    );
  });

  it("refuses transposed skip placeholders and passes in-order ones", () => {
    const source =
      "<!-- harmonise:skip -->\nfirst kept\n\nprose\n\n<!-- harmonise:skip -->\nsecond kept\n";
    const { protection } = protect(source);
    const swapped = protection.text
      .replace(s(1), "@@A@@")
      .replace(s(2), s(1))
      .replace("@@A@@", s(2));
    expect(() => restoreDocument(swapped, protection)).toThrow(
      `placeholder ${s(2)} appears before ${s(1)} — the candidate does not preserve the protected content's order`,
    );
    expect(restoreDocument(protection.text, protection)).toBe(source);
  });

  it("keeps one order across skip and glossary placeholders", () => {
    const source = "<!-- harmonise:skip -->\nkept verbatim\n\nThe repository grows.\n";
    const { protection } = protect(source, { glossary: ["repository"] });
    const swapped = `The ${g(1)} grows.\n\n${s(1)}\n`;
    expect(() => restoreDocument(swapped, protection)).toThrow(
      `placeholder ${g(1)} appears before ${s(1)} — the candidate does not preserve the protected content's order`,
    );
    expect(restoreDocument(`${s(1)}\n\nThe ${g(1)} grows tall.\n`, protection)).toBe(
      "<!-- harmonise:skip -->\nkept verbatim\n\nThe repository grows tall.\n",
    );
  });

  it("pins the order key: the protected text is document order, the spans map is not", () => {
    const { protection } = protect(
      "<!-- harmonise:skip -->\na\n\nx\n\n<!-- harmonise:skip -->\nb\n",
    );
    expect(protection.text.indexOf(s(1))).toBeLessThan(protection.text.indexOf(s(2)));
    expect([...protection.spans.keys()]).toEqual([s(2), s(1)]);
  });
});

// Tests for post-model link-graph validation.
//
// The rewriter decides where every internal reference points before the
// model sees the document; this module is the gate that proves the answer
// came back pointing there still. The adversarial cases below are the
// mutations a compromised or sloppy model could make that every earlier
// gate — placeholder restoration, HTML sanitiser, structural profile —
// would wave through: re-targeted destinations, injected schemes, stripped
// anchors, kind swaps, and reference-definition rewrites.

import { describe, expect, it } from "vitest";

import { collectLinks, validateLinkGraph } from "./link-graph.mjs";

/**
 * @param {object} [options]
 * @param {Record<string, string>} [options.documents] repository-absolute path → localized target
 * @param {Record<string, string>} [options.images] repository-absolute path → localized variant
 * @param {string} [options.translatedDocPath]
 * @returns {import("./link-graph.mjs").LinkGraphContext}
 */
function context(options = {}) {
  const documents = new Map(Object.entries(options.documents ?? {}));
  const images = new Map(Object.entries(options.images ?? {}));
  return {
    translatedDocPath: options.translatedDocPath ?? "manual/vi/dev.md",
    resolveDocument: (absPath) => documents.get(absPath) ?? null,
    resolveImage: (absPath) => images.get(absPath) ?? null,
  };
}

/**
 * Collects both sides and judges them in one step.
 *
 * @param {string} source the model-visible (rewritten) source document
 * @param {string} candidate the sanitised model answer
 * @param {import("./link-graph.mjs").LinkGraphContext} [contextInput]
 * @returns {import("./link-graph.mjs").LinkGraphVerdict}
 */
function judge(source, candidate, contextInput = context()) {
  return validateLinkGraph({
    sourceLinks: collectLinks(source),
    candidateLinks: collectLinks(candidate),
    context: contextInput,
  });
}

describe("collectLinks", () => {
  it("collects an inline link with its destination, text, and line", () => {
    expect(collectLinks("See [the guide](guide/setup.md) first.\n")).toEqual([
      {
        kind: "link",
        destination: "guide/setup.md",
        title: undefined,
        line: 1,
        text: "the guide",
      },
    ]);
  });

  it("collects an image as its own kind", () => {
    expect(collectLinks("![flow diagram](images/flow.png)\n")).toEqual([
      {
        kind: "image",
        destination: "images/flow.png",
        title: undefined,
        line: 1,
        text: "flow diagram",
      },
    ]);
  });

  it("keeps the quoted title tail as authored", () => {
    const links = collectLinks('[setup](guide/setup.md "The setup guide")\n');
    expect(links[0]?.destination).toBe("guide/setup.md");
    expect(links[0]?.title).toBe(' "The setup guide"');
  });

  it("collects an angle autolink as machinery", () => {
    expect(collectLinks("Visit <https://x.example/a> today.\n")).toEqual([
      {
        kind: "autolink",
        destination: "https://x.example/a",
        title: undefined,
        line: 1,
        text: "<https://x.example/a>",
      },
    ]);
  });

  it("collects a reference definition's label and destination token", () => {
    expect(collectLinks("[api]: guide/api.md\n")).toEqual([
      {
        kind: "reference-definition",
        destination: "guide/api.md",
        title: undefined,
        line: 1,
        text: "api",
      },
    ]);
  });

  it("keeps an angle-bracket definition destination whole", () => {
    const links = collectLinks("[x]: <guide/a b.md>\n");
    expect(links[0]?.destination).toBe("<guide/a b.md>");
  });

  it("skips fenced blocks entirely", () => {
    const text = ["```text", "[a](b.md)", "```", ""].join("\n");
    expect(collectLinks(text)).toEqual([]);
  });

  it("skips destinations inside code spans", () => {
    const text = "Run `f(a](b)` now.\n";
    expect(collectLinks(text)).toEqual([]);
  });

  it("honours the rewriter's claim discipline on one line", () => {
    // The nested `](` inside the first construct's destination is content
    // of the claimed construct, not a construct of its own.
    const links = collectLinks("[a]([b](x.md)) and ![c](y.png)\n");
    expect(links).toHaveLength(2);
    expect(links[0]?.kind).toBe("link");
    expect(links[1]?.kind).toBe("image");
    expect(links[1]?.destination).toBe("y.png");
  });

  it("numbers lines 1-based across blank lines", () => {
    const links = collectLinks("one [a](x.md)\n\nthree [b](y.md)\n");
    expect(links.map((link) => link.line)).toEqual([1, 3]);
  });

  it("survives a title containing a closing paren", () => {
    // The extent scan ends at the first unescaped `)` — the rewriter's own
    // behavior — so the construct truncates; extraction and rewrite agree
    // on where its bytes end, which is all validation needs.
    const links = collectLinks('[t](guide/a.md "ends with ) paren")\n');
    expect(links[0]?.destination).toBe('guide/a.md "ends with');
  });

  it("collects an angle-bracket inline destination the rewriter passes through", () => {
    const links = collectLinks("[t](<guide/a b.md>)\n");
    expect(links).toHaveLength(1);
    expect(links[0]?.destination).toBe("<guide/a b.md>");
  });

  it("does not double-count an autolink inside a proven destination", () => {
    const links = collectLinks("[t](<https://x.example/a>)\n");
    expect(links).toHaveLength(1);
    expect(links[0]?.kind).toBe("link");
  });
});

describe("validateLinkGraph", () => {
  it("passes an honest translation unchanged", () => {
    const source = "# Hướng dẫn\n\nSee [details](../guide/details.md) and ![p](images/p.png).\n";
    const candidate = "# Hướng dẫn\n\nSee [details](../guide/details.md) and ![p](images/p.png).\n";
    expect(judge(source, candidate)).toEqual({ ok: true, violations: [] });
  });

  it("passes when prose reordering moves links with their sentences", () => {
    const source = "A [x](x.md)\n\nB [y](y.md)\n";
    const candidate = "B [y](y.md)\n\nA [x](x.md)\n";
    expect(judge(source, candidate)).toEqual({ ok: true, violations: [] });
  });

  it("passes a re-spelled internal destination through the resolver", () => {
    const contextInput = context({
      documents: { "manual/vi/setup.md": "manual/vi/setup.vi.md" },
    });
    expect(judge("[setup](setup.md)\n", "[setup](./setup.md)\n", contextInput).ok).toBe(true);
  });

  it("fails a link re-targeted at an external host, naming both destinations", () => {
    const verdict = judge(
      "See [details](../guide/details.md).\n",
      "See [details](https://evil.example/steal).\n",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join("\n")).toMatch(
      /line 1: link destination changed: '\.\.\/guide\/details\.md' → 'https:\/\/evil\.example\/steal'/,
    );
  });

  it("fails an injected javascript: destination", () => {
    const verdict = judge(
      "See [details](../guide/details.md).\n",
      "See [details](../guide/details.md) [pwn](javascript:alert(1)).\n",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join("\n")).toMatch(
      /link added with destination 'javascript:alert\(1\)'/,
    );
  });

  it("fails an entity-encoded javascript: destination without crashing", () => {
    const verdict = judge(
      "See [details](../guide/details.md).\n",
      "See [details](java&#115;cript:alert(1)).\n",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join("\n")).toMatch(
      /link destination changed: '\.\.\/guide\/details\.md' → 'java&#115;cript:alert\(1\)'/,
    );
  });

  it("fails a sanitizer-blanked destination without crashing", () => {
    const verdict = judge(
      "See [details](../guide/details.md).\n",
      'See [details](<a href="        ">blank</a>).\n',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toHaveLength(1);
  });

  it("fails a link pointed at a different document", () => {
    const verdict = judge(
      "See [a](guide/one.md).\n",
      "See [a](guide/two.md).\n",
      context({ documents: { "manual/guide/one.md": "m", "manual/guide/two.md": "m2" } }),
    );
    expect(verdict.violations.join("\n")).toMatch(
      /link destination changed: 'guide\/one\.md' → 'guide\/two\.md'/,
    );
  });

  it("fails an image and link swapped for one another", () => {
    const verdict = judge(
      "[x](guide/a.md) ![y](images/p.png)\n",
      "![x](guide/a.md) [y](images/p.png)\n",
    );
    expect(verdict.ok).toBe(false);
    const report = verdict.violations.join("\n");
    expect(report).toMatch(/link destination changed: 'guide\/a\.md' → 'images\/p\.png'/);
    expect(report).toMatch(/image destination changed: 'images\/p\.png' → 'guide\/a\.md'/);
  });

  it("fails a stripped anchor fragment", () => {
    const verdict = judge(
      "See [details](../guide/details.md#install).\n",
      "See [details](../guide/details.md).\n",
    );
    expect(verdict.violations.join("\n")).toMatch(
      /link destination changed: '\.\.\/guide\/details\.md#install' → '\.\.\/guide\/details\.md'/,
    );
  });

  it("fails an altered query tail", () => {
    const verdict = judge(
      "See [search](../guide/search.md?q=en).\n",
      "See [search](../guide/search.md?q=vi).\n",
    );
    expect(verdict.violations.join("\n")).toMatch(/destination changed/);
    expect(verdict.violations.join("\n")).toContain("?q=vi");
  });

  it("fails a reference definition reused with a changed destination", () => {
    const source = "[api]: ../guide/api.md\n\nUse [api] now.\n";
    const candidate = "[api]: ../guide/evil.md\n\nUse [api] now.\n";
    const verdict = judge(source, candidate);
    expect(verdict.violations.join("\n")).toMatch(
      /line 1: reference-definition destination changed: '\.\.\/guide\/api\.md' → '\.\.\/guide\/evil\.md'/,
    );
  });

  it("fails a renamed reference definition label", () => {
    const source = "[api]: ../guide/api.md\n";
    const candidate = "[apiv2]: ../guide/api.md\n";
    const verdict = judge(source, candidate);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toHaveLength(1);
  });

  it("fails percent-encoded traversal", () => {
    const verdict = judge(
      "See [details](../guide/details.md).\n",
      "See [details](%2e%2e/secrets.md).\n",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join("\n")).toContain("%2e%2e/secrets.md");
  });

  it("passes duplicate identical links and fails exactly one mutated copy", () => {
    const source = "[a](x.md) [b](x.md)\n";
    expect(judge(source, "[a](x.md) [b](x.md)\n").ok).toBe(true);

    const verdict = judge(source, "[a](x.md) [b](y.md)\n");
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations.join("\n")).toMatch(/link destination changed: 'x\.md' → 'y\.md'/);
  });

  it("fails a dropped link", () => {
    const verdict = judge("A [x](x.md)\n\nB [y](y.md)\n", "B [y](y.md)\n");
    expect(verdict.violations.join("\n")).toMatch(/link destination 'x\.md' removed/);
  });

  it("fails an invented link", () => {
    const verdict = judge("A [x](x.md)\n", "A [x](x.md)\n\nB [y](../guide/y.md)\n");
    expect(verdict.violations.join("\n")).toMatch(
      /line 3: link added with destination '\.\.\/guide\/y\.md'/,
    );
  });

  it("fails when only the title changed", () => {
    const verdict = judge('[t](guide/a.md "Read this")\n', '[t](guide/a.md "Read that")\n');
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toHaveLength(1);
  });

  it("passes hostile titles byte-identically", () => {
    const line = '[t](guide/a.md "brackets ] and ) inside")\n';
    expect(judge(line, line).ok).toBe(true);
  });

  it("validates images through resolveImage", () => {
    const contextInput = context({
      images: { "manual/images/p.png": "manual/vi/images/p.vi.png" },
    });
    expect(judge("![p](../images/p.png)\n", "![p](../images/p.png)\n", contextInput).ok).toBe(true);

    const mutated = judge("![p](../images/p.png)\n", "![p](../images/other.png)\n", contextInput);
    expect(mutated.violations.join("\n")).toMatch(
      /image destination changed: '\.\.\/images\/p\.png' → '\.\.\/images\/other\.png'/,
    );
  });

  it("keeps the violation report exact and ordered when every link in a large document is re-targeted", () => {
    const count = 2_500;
    const source = Array.from(
      { length: count },
      (_, index) => `See [item ${index}](guide/${index}.md).\n`,
    ).join("");
    const candidate = Array.from(
      { length: count },
      (_, index) => `See [item ${index}](https://evil.example/${index}).\n`,
    ).join("");

    const verdict = judge(source, candidate);

    // Exactly one violation per re-targeted link, paired in document order —
    // an exact count, not an unbounded set.
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toHaveLength(count);
    expect(verdict.violations[0]).toBe(
      "line 1: link destination changed: 'guide/0.md' → 'https://evil.example/0'",
    );
    expect(verdict.violations[count - 1]).toBe(
      `line ${count}: link destination changed: 'guide/${count - 1}.md' → 'https://evil.example/${count - 1}'`,
    );
  });
});

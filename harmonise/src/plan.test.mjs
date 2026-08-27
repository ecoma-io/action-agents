// Tests for pair preparation and HTML sanitisation of model output.
//
// The sanitiser is a defence against HARM-001: model translation output
// committed verbatim can carry HTML that executes if the repository serves
// translated docs through GitHub Pages or similar. The sanitiser blanks
// dangerous HTML from prose in place — overwriting with same-length spaces,
// never deleting, so a construct cannot re-form from the leftovers — while
// preserving fenced code blocks and code spans unchanged.

import { describe, expect, it } from "vitest";

import { sanitizeTranslationHtml } from "./plan.mjs";

describe("sanitizeTranslationHtml", () => {
  it("strips script tags from prose", () => {
    const input = "# Title\n\n<script>alert('xss')</script>\n\nParagraph.";
    const result = sanitizeTranslationHtml(input);
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("</script>");
    expect(result).toContain("# Title");
    expect(result).toContain("Paragraph.");
  });

  it("strips iframe, object, embed, and form tags from prose", () => {
    const input =
      '<iframe src="evil.com"></iframe>\n<object></object>\n<embed>\n<form><input onfocus=alert(1)></form>';
    const result = sanitizeTranslationHtml(input);
    expect(result).not.toContain("<iframe");
    expect(result).not.toContain("<object");
    expect(result).not.toContain("<embed");
    expect(result).not.toContain("<form");
    expect(result).not.toContain("<input");
  });

  it("strips on* event handler attributes from any tag", () => {
    const input = '<div onmouseover="alert(1)">text</div>\n<img src=x onerror="alert(1)">';
    const result = sanitizeTranslationHtml(input);
    expect(result).not.toContain("onmouseover");
    expect(result).not.toContain("onerror");
  });

  it("preserves fenced code blocks unchanged", () => {
    const input = [
      "# Title",
      "",
      "```html",
      "<script>alert('xss')</script>",
      "```",
      "",
      "Paragraph.",
    ].join("\n");
    const result = sanitizeTranslationHtml(input);
    expect(result).toContain("<script>alert('xss')</script>");
    expect(result).toContain("```html");
  });

  it("preserves inline code spans unchanged", () => {
    const input = "Use `<script>` to embed scripts.";
    const result = sanitizeTranslationHtml(input);
    expect(result).toContain("`<script>`");
  });

  it("strips harmonise directive comments", () => {
    const input = "Text\n<!-- harmonise:skip -->\nMore text.";
    const result = sanitizeTranslationHtml(input);
    expect(result).not.toContain("harmonise:skip");
    // The directive prefix is blanked in place: the comment survives with
    // its content whitespace-padded, and the line keeps its length.
    expect(result).toMatch(/<!--\s+skip -->/);
  });

  it("preserves safe HTML like tables and details", () => {
    const input =
      "| Col |\n| --- |\n| val |\n\n<details><summary>click</summary>\n\nContent.\n\n</details>";
    const result = sanitizeTranslationHtml(input);
    expect(result).toContain("| Col |");
    expect(result).toContain("<details>");
    expect(result).toContain("<summary>");
  });

  it("strips link, meta, base, svg, math, and foreignObject tags", () => {
    const input =
      '<link rel="stylesheet" href="evil.css">\n<meta http-equiv="refresh" content="0;url=evil.com">\n<base href="evil.com">\n<svg onload="alert(1)"></svg>\n<math><script></script></math>\n<foreignObject><body onload="alert(1)"></body></foreignObject>';
    const result = sanitizeTranslationHtml(input);
    expect(result).not.toContain("<link");
    expect(result).not.toContain("<meta");
    expect(result).not.toContain("<base");
    expect(result).not.toContain("<svg");
    expect(result).not.toContain("<math");
    expect(result).not.toContain("<foreignObject");
  });

  it("strips javascript: URI schemes in href and src attributes", () => {
    const input =
      '<a href="javascript:alert(1)">click</a>\n<img src="javascript:alert(1)">\n<a href="JAVASCRIPT:alert(1)">click</a>';
    const result = sanitizeTranslationHtml(input);
    expect(result).not.toContain("javascript:");
    expect(result).not.toContain("JAVASCRIPT:");
  });

  it("blanks tab-split javascript: schemes in href and src whole", () => {
    // A browser strips tab, LF and CR bytes from a URL before scheme
    // dispatch, so java<TAB>script: executes as javascript: wherever the
    // committed markup is rendered without a second sanitiser.
    const input = '<a href="java\tscript:alert(1)">click</a>\n<img src="java\tscript:alert(1)">';
    const result = sanitizeTranslationHtml(input);
    expect(result).not.toContain("java\tscript:");
    expect(result).not.toContain("script:alert(1)");
    expect(result).toContain("click");
  });

  it("blanks entity-split javascript: schemes whole", () => {
    // Attribute values are entity-decoded before scheme dispatch, so the
    // numeric reference is read as the tab byte it spells.
    const input = '<a href="java&#x09;script:alert(1)">click</a>';
    const result = sanitizeTranslationHtml(input);
    expect(result).not.toContain("&#x09;");
    expect(result).not.toContain("script:alert(1)");
    expect(result).toContain("click");
  });

  it("leaves ordinary https URLs in href and src untouched", () => {
    const input =
      '<a href="https://example.com/docs">docs</a>\n<img src="https://example.com/img.png">';
    const result = sanitizeTranslationHtml(input);
    expect(result).toBe(input);
  });

  it("leaves text without HTML unchanged", () => {
    const input = "# Title\n\nNo HTML here.\n\n- item 1\n- item 2";
    const result = sanitizeTranslationHtml(input);
    expect(result).toBe(input);
  });

  it("cannot reconstruct a stripped tag from nested leftovers", () => {
    // A deleting strip turns <scr<script>ipt> into <script> — the inner tag
    // removed, the outer one re-formed from the leftovers. Blanking in place
    // leaves <scr        ipt>, from which nothing re-forms.
    const input = "<scr<script>ipt>alert(1)</scr</script>ipt>";
    const result = sanitizeTranslationHtml(input);
    expect(result.toLowerCase()).not.toContain("script");
  });

  it("blanks nested event-handler spellings whole", () => {
    const input = "<div ononfocus=alert(1)>text</div>";
    const result = sanitizeTranslationHtml(input);
    expect(result).not.toContain("onfocus");
    expect(result).not.toContain("ononfocus");
    expect(result).toContain("text");
  });

  it("preserves code spans on a line where HTML was blanked", () => {
    // Regression: a deleting strip shifted the mask's byte offsets, so the
    // restore wrote NUL bytes where the span interior belonged.
    const input = "a <script>alert(1)</script> and `code` here";
    const result = sanitizeTranslationHtml(input);
    expect(result).not.toContain("<script");
    expect(result).toContain("`code`");
    expect(result).not.toContain(String.fromCharCode(0));
  });

  it("keeps every line's length — the code-span restore aligns by column", () => {
    const input = [
      "# Title",
      "",
      "<script>alert(1)</script>",
      "Text with `code` and <iframe src=x></iframe>.",
      "<!-- harmonise:skip -->",
    ].join("\n");
    const resultLines = sanitizeTranslationHtml(input).split("\n");
    const inputLines = input.split("\n");
    for (const [index, line] of inputLines.entries()) {
      expect(resultLines[index]?.length).toBe(line.length);
    }
  });
});

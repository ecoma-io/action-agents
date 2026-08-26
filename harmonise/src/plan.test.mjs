// Tests for pair preparation and HTML sanitisation of model output.
//
// The sanitiser is a defence against HARM-001: model translation output
// committed verbatim can carry HTML that executes if the repository serves
// translated docs through GitHub Pages or similar. The sanitiser strips
// dangerous HTML from prose while preserving fenced code blocks and code
// spans unchanged.

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
    // The directive prefix is stripped but the comment delimiters remain.
    expect(result).toContain("<!-- skip -->");
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

  it("leaves text without HTML unchanged", () => {
    const input = "# Title\n\nNo HTML here.\n\n- item 1\n- item 2";
    const result = sanitizeTranslationHtml(input);
    expect(result).toBe(input);
  });
});

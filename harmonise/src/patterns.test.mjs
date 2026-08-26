// Tests for language patterns: extraction, application, and the localized
// image naming convention.

import { describe, expect, it } from "vitest";

import { localizedImagePath, parseLanguagePattern, validateLanguagePattern } from "./patterns.mjs";

describe("validateLanguagePattern", () => {
  it("accepts a pattern with exactly one placeholder", () => {
    expect(validateLanguagePattern("docs/{document}.md", "test")).toBe("docs/{document}.md");
    expect(validateLanguagePattern("{document}", "test")).toBe("{document}");
  });

  it("refuses an empty or non-string pattern", () => {
    // @ts-expect-error exercising the runtime refusal of a non-string
    expect(() => validateLanguagePattern(42, "test")).toThrow(/non-empty pattern string/);
    expect(() => validateLanguagePattern("", "test")).toThrow(/non-empty pattern string/);
  });

  it("refuses a pattern with zero or two placeholders", () => {
    expect(() => validateLanguagePattern("docs/*.md", "t")).toThrow(/exactly once, got 0/);
    expect(() => validateLanguagePattern("docs/{document}/{document}.md", "t")).toThrow(
      /exactly once, got 2/,
    );
  });

  it("refuses a second brace group even when {document} is present", () => {
    expect(() => validateLanguagePattern("docs/{document}.{lang}.md", "t")).toThrow(
      /second placeholder '\{lang\}'/,
    );
  });
});

describe("parseLanguagePattern", () => {
  it("extracts slugs across path segments", () => {
    const pattern = parseLanguagePattern("manual/{document}.md");

    expect(pattern.slugFromPath("manual/dev.md")).toBe("dev");
    expect(pattern.slugFromPath("manual/guides/setup.md")).toBe("guides/setup");
    expect(pattern.slugFromPath("manual/dev.rst")).toBeNull();
    expect(pattern.slugFromPath("other/dev.md")).toBeNull();
  });

  it("applies slugs back into the pattern's shape", () => {
    const vi = parseLanguagePattern("locales/vi/{document}");

    expect(vi.pathFromSlug("guides/setup")).toBe("locales/vi/guides/setup");
  });

  it("escapes regex-meaningful literals in the pattern", () => {
    const pattern = parseLanguagePattern("v1.0 ({document}).md");

    expect(pattern.slugFromPath("v1.0 (dev).md")).toBe("dev");
    expect(pattern.slugFromPath("v1X0 dev.md")).toBeNull();
  });

  it("weights patterns by their literal length — specificity made comparable", () => {
    const broad = parseLanguagePattern("manual/{document}.md");
    const nested = parseLanguagePattern("docs/vi/{document}.md");

    expect(nested.weight).toBeGreaterThan(broad.weight);
  });
});

describe("localizedImagePath", () => {
  it("inserts the tag before a final extension", () => {
    expect(localizedImagePath("images/dev.png", "vi")).toBe("images/dev.vi.png");
    expect(localizedImagePath("logo.brand.svg", "pt-BR")).toBe("logo.brand.pt-BR.svg");
  });

  it("tags an extensionless path at its end", () => {
    expect(localizedImagePath("images/diagram", "vi")).toBe("images/diagram.vi");
    expect(localizedImagePath("images/.hidden", "vi")).toBe("images/.hidden.vi");
  });
});

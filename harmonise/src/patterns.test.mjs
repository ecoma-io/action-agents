// Tests for language patterns: extraction, application, the localized
// image naming convention, and the configurable asset layouts that extend
// it.

import { describe, expect, it } from "vitest";

import {
  MAX_ASSET_LAYOUTS,
  localizedImagePath,
  parseAssetLayout,
  parseLanguagePattern,
  validateLanguagePattern,
} from "./patterns.mjs";

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
    expect(localizedImagePath("images/dev.png", "vi")).toEqual(["images/dev.vi.png"]);
    expect(localizedImagePath("logo.brand.svg", "pt-BR")).toEqual(["logo.brand.pt-BR.svg"]);
  });

  it("tags an extensionless path at its end", () => {
    expect(localizedImagePath("images/diagram", "vi")).toEqual(["images/diagram.vi"]);
    expect(localizedImagePath("images/.hidden", "vi")).toEqual(["images/.hidden.vi"]);
  });
});

describe("parseAssetLayout", () => {
  it("compiles a valid template into a renderer over the four parts", () => {
    const layout = parseAssetLayout("assets/{lang}/{dir}/{base}.{ext}", "assets.layouts[0]");

    expect(layout.template).toBe("assets/{lang}/{dir}/{base}.{ext}");
    expect(layout.render({ dir: "images", base: "dev", ext: "png", lang: "vi" })).toBe(
      "assets/vi/images/dev.png",
    );
  });

  it("refuses an empty or non-string template", () => {
    // @ts-expect-error exercising the runtime refusal of a non-string
    expect(() => parseAssetLayout(42, "assets.layouts[0]")).toThrow(/non-empty template string/);
    expect(() => parseAssetLayout("", "assets.layouts[0]")).toThrow(/non-empty template string/);
  });

  it("refuses unknown or empty placeholders", () => {
    expect(() => parseAssetLayout("assets/{locale}/{base}.{ext}", "t")).toThrow(
      /unknown placeholder '\{locale\}'/,
    );
    expect(() => parseAssetLayout("assets/{}/f", "t")).toThrow(/empty placeholder/);
  });

  it("requires {lang} and {base} exactly once; {dir} and {ext} are optional and repeatable", () => {
    expect(() => parseAssetLayout("assets/{base}.{ext}", "t")).toThrow(/exactly once, got 0/);
    expect(() => parseAssetLayout("{base}.{lang}.{lang}", "t")).toThrow(/exactly once, got 2/);
    expect(() => parseAssetLayout("{base}", "t")).toThrow(/must contain \{lang\} exactly once/);
    expect(() => parseAssetLayout("{lang}/{base}", "t")).not.toThrow();
    expect(() => parseAssetLayout("{lang}/{base}.{ext}.{ext}", "t")).not.toThrow();
  });

  it("refuses literal parts that could only escape the document's directory", () => {
    expect(() => parseAssetLayout("/assets/{lang}/{base}.{ext}", "t")).toThrow(/starts with '/);
    expect(() => parseAssetLayout("C:{lang}/{base}.{ext}", "t")).toThrow(/names a drive/);
    expect(() => parseAssetLayout("assets/../{lang}/{base}.{ext}", "t")).toThrow(/with '\.\.'/);
    expect(() => parseAssetLayout("assets//{lang}/{base}.{ext}", "t")).toThrow(
      /empty path segment/,
    );
    expect(() => parseAssetLayout("assets/{lang}/{base}.{ext}/", "t")).toThrow(
      /empty path segment/,
    );
  });
});

describe("localizedImagePath candidates", () => {
  const layouts = [
    parseAssetLayout("assets/{lang}/{dir}/{base}.{ext}", "t"),
    parseAssetLayout("{dir}/localized/{lang}-{base}.{ext}", "t"),
  ];

  it("yields configured layouts first in config order, the built-in convention last", () => {
    expect(
      localizedImagePath("manual/images/dev.png", "vi", {
        layouts,
        fromDocPath: "manual/dev.md",
      }),
    ).toEqual([
      "manual/assets/vi/images/dev.png",
      "manual/images/localized/vi-dev.png",
      "manual/images/dev.vi.png",
    ]);
  });

  it("renders {dir} empty for a same-directory reference and {ext} empty for no extension", () => {
    const flat = [parseAssetLayout("assets/{lang}/{base}.{ext}", "t")];

    expect(
      localizedImagePath("manual/dev.png", "vi", { layouts: flat, fromDocPath: "manual/dev.md" }),
    ).toEqual(["manual/assets/vi/dev.png", "manual/dev.vi.png"]);
    expect(
      localizedImagePath("manual/diagram", "vi", { layouts: flat, fromDocPath: "manual/dev.md" }),
    ).toEqual(["manual/assets/vi/diagram.", "manual/diagram.vi"]);
  });

  it("skips configured layouts for a reference outside the document's directory", () => {
    expect(
      localizedImagePath("shared/logo.png", "vi", {
        layouts: [parseAssetLayout("assets/{lang}/{base}.{ext}", "t")],
        fromDocPath: "manual/dev.md",
      }),
    ).toEqual(["shared/logo.vi.png"]);
  });

  it("discards a rendered candidate that escapes the document or carries an empty segment", () => {
    // A same-directory reference renders {dir} empty, so the built-in shape
    // rebuilt from a template would start with a slash — an empty segment,
    // skipped rather than normalized into acceptance.
    expect(
      localizedImagePath("manual/dev.png", "vi", {
        layouts: [parseAssetLayout("{dir}/{base}.{lang}.{ext}", "t")],
        fromDocPath: "manual/dev.md",
      }),
    ).toEqual(["manual/dev.vi.png"]);
  });

  it("falls back to the built-in convention when no layouts are configured or no document named", () => {
    expect(localizedImagePath("manual/images/dev.png", "vi", { layouts: [] })).toEqual([
      "manual/images/dev.vi.png",
    ]);
    expect(
      localizedImagePath("manual/images/dev.png", "vi", { layouts, fromDocPath: undefined }),
    ).toEqual(["manual/images/dev.vi.png"]);
  });

  it("couples the layout cap to the constant the config validator refuses with", () => {
    expect(MAX_ASSET_LAYOUTS).toBe(8);
  });
});

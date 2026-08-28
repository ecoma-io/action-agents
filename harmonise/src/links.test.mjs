// Tests for internal link and image localization. The rule under test is
// narrow: a destination moves only when the inventory proves its target, the
// author's encoding survives whenever the small edit can land, and anything
// external, absolute, or unprovable stays exactly as written.
//
// Relativization aims at the TRANSLATION's directory: a translation living at
// manual/vi/dev.md references its neighbor manual/vi/api.md as `api.md`, exactly
// as the source referenced its own neighbor — which is why several cases
// below assert that a correctly-localized link can look identical to the
// original while others show the path that changed.

import { describe, expect, it } from "vitest";

import { rewriteLinks } from "./links.mjs";

/**
 * A context for docs living at `manual/dev.md` translating into `manual/vi/dev.md`,
 * with resolver answers given as literal sets.
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.documents] abs source doc path → abs localized target
 * @param {string} [options.translatedDocPath]
 * @param {(p: string) => string | null} [options.resolveImage]
 */
function context(options = {}) {
  const documents = new Map(Object.entries(options.documents ?? {}));
  return {
    sourceDocPath: "manual/dev.md",
    translatedDocPath: options.translatedDocPath ?? "manual/vi/dev.md",
    languageTag: "vi",
    /** @param {string} p */
    resolveDocument: (p) => documents.get(p) ?? null,
    resolveImage: options.resolveImage ?? (() => null),
  };
}

describe("internal document links", () => {
  it("re-points a sibling document when the localized home sits elsewhere", () => {
    // manual/api.md localizes to guides/vi/api.md; from the translation living
    // at manual/vi/, that target reads ../../guides/vi/api.md.
    const ctx = context({
      documents: { "manual/api.md": "guides/vi/api.md" },
    });

    expect(rewriteLinks("[api](api.md)", ctx)).toEqual({
      text: "[api](../../guides/vi/api.md)",
      count: 1,
    });
  });

  it("rewrites to the same spelling when both sides sit side by side", () => {
    // dev.md and api.md are neighbors in en and stay neighbors in vi — the
    // rewritten link spells identically, which is correctness, not a miss.
    const ctx = context({ documents: { "manual/api.md": "manual/vi/api.md" } });

    expect(rewriteLinks("[api](api.md)", ctx)).toEqual({ text: "[api](api.md)", count: 1 });
  });

  it("leaves the link alone when no localized version exists or is planned", () => {
    const result = rewriteLinks("see [other](other.md)", context());

    expect(result.text).toBe("see [other](other.md)");
    expect(result.count).toBe(0);
  });

  it("keeps fragments and queries attached to the rewritten destination", () => {
    const ctx = context({ documents: { "manual/setup.md": "locales/vi/setup.md" } });

    expect(rewriteLinks("[install](setup.md#install)", ctx).text).toBe(
      "[install](../../locales/vi/setup.md#install)",
    );
    const qctx = context({ documents: { "manual/old.md": "locales/vi/old.md" } });
    expect(rewriteLinks("[v2](old.md?version=2)", qctx).text).toBe(
      "[v2](../../locales/vi/old.md?version=2)",
    );
  });

  it("never touches schemes, protocol-relative targets or same-page anchors", () => {
    const line =
      "[w](https://example.com/x) [m](mailto:a@b.c) [d](data:text/plain,x) [p](//host/p) [a](#anchor)";

    expect(rewriteLinks(line, context())).toEqual({ text: line, count: 0 });
  });

  it("never lets a relative path escape the repository", () => {
    // `../../x.md` from manual/dev.md resolves above the root; nothing provable,
    // so nothing moves.
    const result = rewriteLinks("[up](../../x.md)", context());

    expect(result.text).toBe("[up](../../x.md)");
    expect(result.count).toBe(0);
  });

  it("rewrites a resolvable parent-relative link that stays inside the repository", () => {
    // ../other.md from manual/dev.md lands on the root document other.md,
    // whose Vietnamese home is vi/other.md; rebuilt from the translation's
    // directory at manual/vi/, that reads ../../vi/other.md.
    const ctx = context({ documents: { "other.md": "vi/other.md" } });

    expect(rewriteLinks("[up](../other.md)", ctx)).toEqual({
      text: "[up](../../vi/other.md)",
      count: 1,
    });
  });
});

describe("internal image links", () => {
  it("re-points an image at its localized variant, re-relativized", () => {
    const ctx = context({
      resolveImage: (p) => (p === "images/arch.png" ? "images/arch.vi.png" : null),
    });

    expect(rewriteLinks("![Architecture](../images/arch.png)", ctx)).toEqual({
      text: "![Architecture](../../images/arch.vi.png)",
      count: 1,
    });
  });

  it("keeps the original reference when the localized image does not exist", () => {
    expect(rewriteLinks("![A](images/missing.png)", context())).toEqual({
      text: "![A](images/missing.png)",
      count: 0,
    });
  });

  it("keeps the reference when a configured layout's candidates all miss", () => {
    // An inventory-style double: configured layouts first, built-in
    // convention last, answered only for files the branch holds. Nothing
    // matches, so the reference stays exactly as authored.
    const held = new Set(["manual/assets/vi/other.png"]);
    const ctx = context({
      resolveImage: (p) => (held.has(`manual/assets/vi/${p}`) ? `manual/assets/vi/${p}` : null),
    });

    expect(rewriteLinks("![d](imgs/diagram.png)", ctx)).toEqual({
      text: "![d](imgs/diagram.png)",
      count: 0,
    });
  });

  it("never rewrites external or data images", () => {
    const line = "![e](https://example.com/a.png) ![d](data:image/png;base64,AAA)";

    expect(rewriteLinks(line, context())).toEqual({ text: line, count: 0 });
  });

  it("tags query strings and fragments after the localized name", () => {
    const ctx = context({
      resolveImage: (p) => (p === "manual/imgs/f.png" ? "manual/imgs/f.vi.png" : null),
    });

    expect(rewriteLinks("![f](imgs/f.png?v=2#fig)", ctx).text).toBe(
      "![f](../imgs/f.vi.png?v=2#fig)",
    );
  });
});

describe("encoding and syntax preservation", () => {
  it("prefers the smallest edit, preserving the author's own encoding bytes", () => {
    const ctx = context({
      documents: { "manual/my file.md": "manual/vi/my file.vi.md" },
    });

    expect(rewriteLinks("[f](my%20file.md)", ctx).text).toBe("[f](my%20file.vi.md)");
  });

  it("re-encodes rebuilt paths segment-wise when the name itself changed", () => {
    const ctx = context({
      documents: { "manual/café.md": "manual/vi/rename-café.md" },
    });

    // The small edit cannot land — the localized name differs beyond the tag
    // — so the path rebuilds and non-ASCII re-encodes conservatively.
    expect(rewriteLinks("[c](caf%C3%A9.md)", ctx).text).toBe("[c](rename-caf%C3%A9.md)");
  });

  it("leaves angle-bracket destinations alone in v1", () => {
    const ctx = context({ documents: { "manual/x.md": "manual/vi/x.md" } });

    expect(rewriteLinks("[x](<x.md>)", ctx).text).toBe("[x](<x.md>)");
  });

  it("preserves link titles verbatim", () => {
    const ctx = context({ documents: { "manual/a.md": "locales/vi/a.md" } });

    expect(rewriteLinks('[t](a.md "the title")', ctx).text).toBe(
      '[t](../../locales/vi/a.md "the title")',
    );
  });

  it("handles nested brackets in link text without mis-detecting images", () => {
    const ctx = context({
      documents: { "manual/b.md": "manual/vi/b.md" },
      resolveImage: (p) => (p === "manual/i.png" ? "manual/i.vi.png" : null),
    });

    expect(rewriteLinks("[![icon](i.png)](b.md)", ctx).text).toBe("[![icon](../i.vi.png)](b.md)");
  });

  it("handles nested parentheses inside a destination", () => {
    const ctx = context({
      documents: { "manual/file(1).md": "manual/vi/file(1).md" },
    });

    // The depth-aware scan reads the destination as `file(1).md`, not
    // `file(1` followed by stray bytes.
    expect(rewriteLinks("[w](file(1).md)", ctx)).toEqual({
      text: "[w](file(1).md)",
      count: 1,
    });
  });

  it("rewrites reference-style destinations too", () => {
    const ctx = context({ documents: { "manual/ref.md": "manual/ref.vi.md" } });

    // The translation lives one level deeper than the localized target.
    expect(rewriteLinks("[id]: ref.md\nuse [text][id]", ctx).text).toBe(
      "[id]: ../ref.vi.md\nuse [text][id]",
    );
  });

  it("ignores everything inside fenced blocks and inline code", () => {
    const source = "```\n[a](b.md)\n```\nrun `[c](d.md)`\n";

    expect(rewriteLinks(source, context()).text).toBe(source);
  });

  it("leaves a construct that never closes on its line alone", () => {
    expect(rewriteLinks("[broken](x.md\n", context()).text).toBe("[broken](x.md\n");
  });
});

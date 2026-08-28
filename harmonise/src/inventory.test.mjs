// Tests for the document inventory: classification, pairing, orphans, and
// the resolvers link rewriting leans on. Determinism is asserted directly —
// same tree in, same order out.

import { describe, expect, it } from "vitest";

import { buildInventory } from "./inventory.mjs";
import { parseAssetLayout, parseLanguagePattern } from "./patterns.mjs";

/**
 * @param {object} [options]
 * @param {string[]} [options.paths]
 * @param {string[]} [options.ignore]
 * @param {string[]} [options.documents]
 * @param {string[]} [options.layouts] asset layout templates, in config order
 * @returns {Parameters<typeof buildInventory>[0]}
 */
function input(options = {}) {
  return {
    entries: (options.paths ?? []).map((path) => ({ path, type: "blob" })),
    config: {
      sourceLanguage: "en",
      languages: {
        en: parseLanguagePattern("manual/{document}.md"),
        vi: parseLanguagePattern("manual/vi/{document}.md"),
        fr: parseLanguagePattern("manual/fr/{document}.md"),
      },
      ignore: options.ignore ?? [],
      glossary: [],
      instructions: { languages: {} },
      concurrency: 2,
      ...(options.layouts === undefined
        ? {}
        : { assets: { layouts: options.layouts.map((t) => parseAssetLayout(t, "t")) } }),
    },
    documents: options.documents ?? [],
  };
}

describe("classification and pairing", () => {
  it("pairs a source with an existing translation", () => {
    const inventory = buildInventory(input({ paths: ["manual/dev.md", "manual/vi/dev.md"] }));

    expect(inventory.sourcePaths).toEqual(["manual/dev.md"]);
    expect(inventory.pairs[0]?.targets).toEqual([
      { lang: "fr", path: "manual/fr/dev.md", state: "missing", planned: true },
      { lang: "vi", path: "manual/vi/dev.md", state: "existing", planned: false },
    ]);
  });

  it("reports a source with no translations at all", () => {
    const inventory = buildInventory(input({ paths: ["manual/solo.md"] }));

    expect(inventory.pairs[0]?.targets.every((target) => target.state === "missing")).toBe(true);
    expect(inventory.orphanTranslations).toEqual([]);
  });

  it("reports orphan translations without touching them", () => {
    const inventory = buildInventory(
      input({ paths: ["manual/vi/ghost.md", "manual/fr/ghost.md", "manual/live.md"] }),
    );

    expect(inventory.orphanTranslations).toEqual([
      { path: "manual/fr/ghost.md", lang: "fr" },
      { path: "manual/vi/ghost.md", lang: "vi" },
    ]);
    expect(inventory.sourcePaths).toEqual(["manual/live.md"]);
  });

  it("never calls an ignored source's translations orphans", () => {
    const inventory = buildInventory(
      input({
        paths: ["manual/generated.md", "manual/vi/generated.md"],
        ignore: ["manual/generated.md"],
      }),
    );

    expect(inventory.orphanTranslations).toEqual([]);
    expect(inventory.sourcePaths).toEqual([]);
  });

  it("keeps planned false for missing targets outside the documents filter", () => {
    const inventory = buildInventory(
      input({ paths: ["manual/a.md", "manual/b.md"], documents: ["manual/a.md"] }),
    );
    const pairA = inventory.pairs.find((pair) => pair.slug === "a");
    const pairB = inventory.pairs.find((pair) => pair.slug === "b");

    expect(pairA?.targets.every((target) => target.planned)).toBe(true);
    expect(pairB?.targets.every((target) => target.planned)).toBe(false);
  });
});

describe("specificity", () => {
  it("gives nested patterns their own directory back without refusing", () => {
    // The canonical per-language layout: both shapes claim the vi twin,
    // and the deeper one wins.
    const config = input({ paths: ["manual/dev.md", "manual/vi/dev.md"] });
    const inventory = buildInventory(config);

    expect(inventory.sourcePaths).toEqual(["manual/dev.md"]);
    expect(inventory.pairs[0]?.targets.find((t) => t.lang === "vi")?.state).toBe("existing");
  });

  it("refuses two equally specific claims on one file", () => {
    // Two languages, the same pattern: every file either shape can name is
    // claimed with equal literal weight, and classification is genuinely
    // arbitrary — refused with both names in the error.
    expect(() =>
      buildInventory({
        entries: [{ path: "manual/dev.md", type: "blob" }],
        config: {
          sourceLanguage: "en",
          languages: {
            en: parseLanguagePattern("manual/{document}.md"),
            vi: parseLanguagePattern("manual/{document}.md"),
          },
          ignore: [],
          glossary: [],
          instructions: { languages: {} },
          concurrency: 2,
        },
        documents: [],
      }),
    ).toThrow(/matches several language patterns equally well \('en', 'vi'\)/);
  });
});

describe("resolvers", () => {
  it("resolveDocument answers existing and planned targets, nothing else", () => {
    const inventory = buildInventory(input({ paths: ["manual/live.md", "manual/vi/live.md"] }));

    // vi exists; fr is missing but planned (empty filter selects everything).
    expect(inventory.resolveDocument("manual/live.md", "vi")).toBe("manual/vi/live.md");
    expect(inventory.resolveDocument("manual/live.md", "fr")).toBe("manual/fr/live.md");
    expect(inventory.resolveDocument("manual/unmapped.md", "vi")).toBeNull();
  });

  it("withholds unplanned targets — a filter can make a neighbor unreachable", () => {
    const inventory = buildInventory(
      input({ paths: ["manual/live.md"], documents: ["!manual/**"] }),
    );

    expect(inventory.resolveDocument("manual/live.md", "vi")).toBeNull();
  });

  it("resolveImage only ever names files the branch holds", () => {
    const inventory = buildInventory(
      input({ paths: ["manual/dev.md", "manual/images/dev.vi.png"] }),
    );

    expect(inventory.resolveImage("manual/images/dev.png", "vi")).toBe("manual/images/dev.vi.png");
    expect(inventory.resolveImage("manual/images/absent.png", "vi")).toBeNull();
  });

  it("resolveImage answers with the first configured candidate the branch holds", () => {
    const inventory = buildInventory(
      input({
        paths: ["manual/dev.md", "manual/assets/vi/images/dev.png", "manual/images/dev.vi.png"],
        layouts: ["assets/{lang}/{dir}/{base}.{ext}"],
      }),
    );

    // The configured layout's candidate exists and outranks the built-in
    // convention's, though both do.
    expect(inventory.resolveImage("manual/images/dev.png", "vi", "manual/dev.md")).toBe(
      "manual/assets/vi/images/dev.png",
    );

    // The configured layout misses; the built-in convention still catches it.
    const partial = buildInventory(
      input({
        paths: ["manual/dev.md", "manual/images/dev.vi.png"],
        layouts: ["assets/{lang}/{dir}/{base}.{ext}"],
      }),
    );
    expect(partial.resolveImage("manual/images/dev.png", "vi", "manual/dev.md")).toBe(
      "manual/images/dev.vi.png",
    );
  });

  it("resolveImage resolves per document — same basename, different directories", () => {
    const inventory = buildInventory(
      input({
        paths: [
          "guides/a.md",
          "reference/b.md",
          "guides/assets/vi/diagram.png",
          "reference/assets/vi/diagram.png",
        ],
        layouts: ["assets/{lang}/{base}.{ext}"],
      }),
    );

    expect(inventory.resolveImage("guides/diagram.png", "vi", "guides/a.md")).toBe(
      "guides/assets/vi/diagram.png",
    );
    expect(inventory.resolveImage("reference/diagram.png", "vi", "reference/b.md")).toBe(
      "reference/assets/vi/diagram.png",
    );
  });

  it("resolveImage stays null for a reference no candidate covers", () => {
    const inventory = buildInventory(
      input({
        paths: ["manual/dev.md"],
        layouts: ["assets/{lang}/{base}.{ext}"],
      }),
    );

    expect(inventory.resolveImage("manual/missing.png", "vi", "manual/dev.md")).toBeNull();
    // Without the document a layout is relative to, only the built-in
    // convention applies.
    expect(inventory.resolveImage("manual/missing.png", "vi")).toBeNull();
  });
});

describe("determinism", () => {
  it("returns pairs and orphans in stable sorted order regardless of listing order", () => {
    const first = buildInventory(
      input({ paths: ["manual/z.md", "manual/a.md", "manual/vi/z.md"] }),
    );
    const second = buildInventory(
      input({ paths: ["manual/vi/z.md", "manual/a.md", "manual/z.md"] }),
    );

    expect(first.pairs.map((pair) => pair.slug)).toEqual(["a", "z"]);
    expect(second.pairs.map((pair) => pair.slug)).toEqual(["a", "z"]);
    expect(first.blobPaths).toEqual(second.blobPaths);
  });
});

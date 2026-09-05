// Tests for pair preparation and HTML sanitisation of model output.
//
// The sanitiser is a defence against HARM-001: model translation output
// committed verbatim can carry HTML that executes if the repository serves
// translated docs through GitHub Pages or similar. The sanitiser blanks
// dangerous HTML from prose in place — overwriting with same-length spaces,
// never deleting, so a construct cannot re-form from the leftovers — while
// preserving fenced code blocks and code spans unchanged.

import { describe, expect, it } from "vitest";

import { HttpError } from "#core/transport-errors.mjs";

import { buildInventory } from "./inventory.mjs";
import { parseAssetLayout, parseLanguagePattern } from "./patterns.mjs";
import {
  MAX_SOURCE_BYTES,
  pairBlockShape,
  planFrontmatterGuard,
  preparePair,
  sanitizeTranslationHtml,
  translatePair,
} from "./plan.mjs";
import { RefusalError } from "./recovery.mjs";
import { DeterministicRefusalError } from "./refusal.mjs";

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
  it("judges a javascript: scheme whose colon is a named character reference", () => {
    // &colon; is one of the named references the URI table resolves; the
    // scheme must be judged on the decoded value, however it is spelled.
    const input = '<a href="javascript&colon;alert(1)">click</a>';
    const result = sanitizeTranslationHtml(input);
    expect(result).toBe(
      "<a" + " ".repeat(1 + 'href="javascript&colon;alert(1)"'.length) + ">click</a>",
    );
  });

  it("leaves unknown named and out-of-range numeric character references as written", () => {
    // &nope; is no reference this sanitiser resolves, and &#x110000; /
    // &#1114112; spell code points past U+10FFFF: none may be guessed at,
    // so the attribute value passes through byte for byte.
    const input = '<a href="https://example.com/?q=&nope;&#x110000;&#1114112;">text</a>';
    const result = sanitizeTranslationHtml(input);
    expect(result).toBe(input);
  });
});

describe("translatePair", () => {
  /**
   * A real inventory over a tiny tree — resolveDocument answers exactly the
   * files the tree holds, the way the run resolves them.
   *
   * @param {string[]} paths
   * @returns {import("./inventory.mjs").Inventory}
   */
  function inventoryFor(paths) {
    return buildInventory({
      entries: paths.map((path) => ({ path, type: "blob" })),
      config: {
        sourceLanguage: "en",
        languages: {
          en: parseLanguagePattern("manual/{document}.md"),
          vi: parseLanguagePattern("manual/vi/{document}.md"),
        },
        ignore: [],
        glossary: [],
        instructions: { languages: {} },
        concurrency: 2,
      },
      documents: [],
    });
  }

  /**
   * A chat double that answers with canned bodies, repeating the last one,
   * and counts the requests it received.
   *
   * @param {string[]} bodies
   * @returns {import("#core/chat.mjs").Chat & { calls: () => number }}
   */
  function chatWith(bodies) {
    let cursor = 0;
    let calls = 0;
    return /** @type {import("#core/chat.mjs").Chat & { calls: () => number }} */ ({
      calls: () => calls,
      async complete() {
        const body = bodies[Math.min(cursor, bodies.length - 1)];
        cursor++;
        calls++;
        return { content: body ?? "", toolCalls: [], finishReason: "stop" };
      },
    });
  }

  /** @param {string} content @returns {string} a JSON answer proposing a translation */
  function proposes(content) {
    return JSON.stringify({ drift: true, summary: "kept in step", content });
  }

  const evidence = /** @type {import("#core/untrusted.mjs").Evidence} */ ({
    /** @param {string} label @param {string} content */
    wrap(label, content) {
      return `[${label}]\n${content}`;
    },
  });
  const config = /** @type {import("./config.mjs").HarmoniseConfig} */ ({
    sourceLanguage: "en",
    languages: { vi: parseLanguagePattern("manual/vi/{document}.md") },
    ignore: [],
    glossary: [],
    instructions: { languages: {} },
    concurrency: 2,
  });
  const sourceText = "# Dev\n\nSee [api](api.md).\n";

  /**
   * Prepares the dev → vi pair; the resolver answers `manual/vi/api.md`,
   * which localizes back to the same `api.md` spelling, so the protected
   * text keeps `[api](api.md)` unchanged.
   */
  function prepare() {
    return preparePair({
      slug: "dev",
      lang: "vi",
      sourcePath: "manual/dev.md",
      target: { path: "manual/vi/dev.md", state: "missing" },
      sourceText,
      inventory: inventoryFor(["manual/dev.md", "manual/api.md", "manual/vi/api.md"]),
      config,
    });
  }

  /** @param {import("./plan.mjs").PreparedPair} prepared @param {string} answerBody */
  function translate(prepared, answerBody) {
    return translatePair({
      prepared,
      sourceLanguage: "en",
      existingText: undefined,
      model: "gpt-x",
      chat: chatWith([answerBody]),
      evidence,
      repository: { name: "acme/docs", description: "Documentation" },
      documents: { languages: {} },
    });
  }

  it("accepts an honest translation with its links untouched", async () => {
    const prepared = prepare();
    const chat = chatWith([proposes(prepared.protectedText)]);
    const result = await translatePair({
      prepared,
      sourceLanguage: "en",
      existingText: undefined,
      model: "gpt-x",
      chat,
      evidence,
      repository: { name: "acme/docs", description: "Documentation" },
      documents: { languages: {} },
    });
    expect(result.outcome).toBe("proposal");
    expect(result.summary).toBe("kept in step");
    expect(chat.calls()).toBe(1);
  });

  it("rejects a re-targeted link on the first attempt, tagged refusal", async () => {
    const prepared = prepare();
    const evil = proposes(
      prepared.protectedText.replace("[api](api.md)", "[api](https://evil.example)"),
    );
    const chat = chatWith([evil, evil]);
    const pending = translatePair({
      prepared,
      sourceLanguage: "en",
      existingText: undefined,
      model: "gpt-x",
      chat,
      evidence,
      repository: { name: "acme/docs", description: "Documentation" },
      documents: { languages: {} },
    });
    await expect(pending).rejects.toThrowError(
      /link validation failed: line 3: link destination changed: 'api\.md' → 'https:\/\/evil\.example'/,
    );
    await expect(pending).rejects.toBeInstanceOf(RefusalError);
    expect(chat.calls()).toBe(1);
  });

  it("keeps a protection refusal's typed class for the boundary", async () => {
    const prepared = preparePair({
      slug: "dev",
      lang: "vi",
      sourcePath: "manual/dev.md",
      target: { path: "manual/vi/dev.md", state: "missing" },
      sourceText: "Alpha keeps logs 30 days. Beta must ship weekly.\n",
      inventory: inventoryFor(["manual/dev.md"]),
      config: /** @type {import("./config.mjs").HarmoniseConfig} */ ({
        ...config,
        glossary: ["logs 30 days", "ship weekly"],
      }),
    });
    const [first, second] = /** @type {[string, string]} */ ([...prepared.protection.spans.keys()]);
    const transposed = prepared.protectedText
      .replace(first, "@@A@@")
      .replace(second, first)
      .replace("@@A@@", second);
    const chat = chatWith([proposes(transposed), proposes(transposed)]);
    const pending = translatePair({
      prepared,
      sourceLanguage: "en",
      existingText: undefined,
      model: "gpt-x",
      chat,
      evidence,
      repository: { name: "acme/docs", description: "Documentation" },
      documents: { languages: {} },
    });
    await expect(pending).rejects.toBeInstanceOf(DeterministicRefusalError);
    await expect(pending).rejects.toThrowError(/does not preserve the protected content's order/);
    expect(chat.calls()).toBe(1);
  });

  it("passes a transport-layer error through untagged", async () => {
    const chat = /** @type {import("#core/chat.mjs").Chat} */ ({
      async complete() {
        throw new HttpError("the request was refused", {
          status: 401,
          url: "https://api.example/v1/chat/completions",
          excerpt: "bad credentials",
        });
      },
    });
    const pending = translatePair({
      prepared: prepare(),
      sourceLanguage: "en",
      existingText: undefined,
      model: "gpt-x",
      chat,
      evidence,
      repository: { name: "acme/docs", description: "Documentation" },
      documents: { languages: {} },
    });
    await expect(pending).rejects.toBeInstanceOf(HttpError);
    await expect(pending).rejects.not.toBeInstanceOf(RefusalError);
  });

  it("leaves sanitizer output alone when no links changed", async () => {
    // The sanitizer blanks dangerous HTML before validation runs; a
    // translation with no link drift passes regardless.
    const prepared = prepare();
    const result = await translate(prepared, proposes(prepared.protectedText));
    expect(result.outcome).toBe("proposal");
  });
  it("refuses a sanitised proposal past the byte cap, naming the count", async () => {
    const prepared = prepare();
    const filler = "Ordinary prose sentences carry the payload past the cap. ";
    const big =
      prepared.protectedText + filler.repeat(Math.ceil((MAX_SOURCE_BYTES + 1) / filler.length));
    await expect(translate(prepared, proposes(big))).rejects.toThrowError(
      new RegExp(
        "^the translated document is " +
          `${String(new TextEncoder().encode(big).byteLength)} bytes, past the ` +
          `${String(MAX_SOURCE_BYTES)}-byte cap$`,
      ),
    );
  });

  it("records a noop when the sanitised proposal is byte-identical to what it replaces", async () => {
    // The glossary mints a placeholder, so the answer echoing the protected
    // text differs from the published bytes by one token; restoration and
    // sanitisation erase exactly that difference. Identical bytes are no
    // drift whatever the flag claimed — the pair must come back a noop, not
    // a proposal.
    const sourceText = "# Dev\n\nUse api here.\n";
    const glossaryConfig = /** @type {import("./config.mjs").HarmoniseConfig} */ ({
      ...config,
      glossary: ["api"],
    });
    const prepared = preparePair({
      slug: "dev",
      lang: "vi",
      sourcePath: "manual/dev.md",
      target: { path: "manual/vi/dev.md", state: "existing" },
      sourceText,
      inventory: inventoryFor(["manual/dev.md"]),
      config: glossaryConfig,
    });
    expect(prepared.protectedText).not.toBe(sourceText);
    const result = await translatePair({
      prepared,
      sourceLanguage: "en",
      existingText: sourceText,
      model: "gpt-x",
      chat: chatWith([proposes(prepared.protectedText)]),
      evidence,
      repository: { name: "acme/docs", description: "Documentation" },
      documents: { languages: {} },
    });
    expect(result.outcome).toBe("noop");
    expect(result.summary).toBe("kept in step");
  });
});

describe("preparePair asset layouts", () => {
  /**
   * A real inventory over a tiny tree, with the configured asset layouts
   * compiled in — the same wiring a run uses.
   *
   * @param {string[]} paths
   * @param {string[]} [layouts]
   * @returns {import("./inventory.mjs").Inventory}
   */
  function inventoryFor(paths, layouts) {
    return buildInventory({
      entries: paths.map((path) => ({ path, type: "blob" })),
      config: {
        sourceLanguage: "en",
        languages: {
          en: parseLanguagePattern("manual/{document}.md"),
          vi: parseLanguagePattern("manual/vi/{document}.md"),
        },
        ignore: [],
        glossary: [],
        instructions: { languages: {} },
        concurrency: 2,
        ...(layouts === undefined
          ? {}
          : { assets: { layouts: layouts.map((t) => parseAssetLayout(t, "t")) } }),
      },
      documents: [],
    });
  }

  const config = /** @type {import("./config.mjs").HarmoniseConfig} */ ({
    sourceLanguage: "en",
    languages: { vi: parseLanguagePattern("manual/vi/{document}.md") },
    ignore: [],
    glossary: [],
    instructions: { languages: {} },
    concurrency: 2,
    assets: { layouts: [parseAssetLayout("assets/{lang}/{dir}/{base}.{ext}", "t")] },
  });

  it("rewrites an image reference through a configured layout", () => {
    // Only the layout's candidate exists on the branch; the built-in
    // convention's does not, so the rewrite must land on the layout's file.
    const prepared = preparePair({
      slug: "dev",
      lang: "vi",
      sourcePath: "manual/dev.md",
      target: { path: "manual/vi/dev.md", state: "missing" },
      sourceText: "![d](imgs/diagram.png)\n",
      inventory: inventoryFor(
        ["manual/dev.md", "manual/assets/vi/imgs/diagram.png"],
        ["assets/{lang}/{dir}/{base}.{ext}"],
      ),
      config,
    });

    expect(prepared.protectedText).toBe("![d](../assets/vi/imgs/diagram.png)\n");
    expect(prepared.linksRewritten).toBe(1);
  });

  it("keeps the reference when no candidate exists on the branch", () => {
    const prepared = preparePair({
      slug: "dev",
      lang: "vi",
      sourcePath: "manual/dev.md",
      target: { path: "manual/vi/dev.md", state: "missing" },
      sourceText: "![d](imgs/diagram.png)\n",
      inventory: inventoryFor(["manual/dev.md"], ["assets/{lang}/{dir}/{base}.{ext}"]),
      config,
    });

    expect(prepared.protectedText).toBe("![d](imgs/diagram.png)\n");
    expect(prepared.linksRewritten).toBe(0);
  });

  it("accepts an honest translation echoing a layout-rewritten reference", async () => {
    // Validation judges the rewritten reference from the translation's
    // directory and both sides must land on one identity — the proof that
    // the validation-side resolver anchors where the rewrite spelled.
    const prepared = preparePair({
      slug: "dev",
      lang: "vi",
      sourcePath: "manual/dev.md",
      target: { path: "manual/vi/dev.md", state: "existing" },
      sourceText: "![d](imgs/diagram.png)\n",
      inventory: inventoryFor(
        ["manual/dev.md", "manual/vi/dev.md", "manual/assets/vi/imgs/diagram.png"],
        ["assets/{lang}/{dir}/{base}.{ext}"],
      ),
      config,
    });
    expect(prepared.protectedText).toContain("../assets/vi/imgs/diagram.png");

    const result = await translatePair({
      prepared,
      sourceLanguage: "en",
      existingText: "old\n",
      model: "gpt-x",
      chat: {
        async complete() {
          return {
            content: JSON.stringify({
              drift: true,
              summary: "kept in step",
              content: prepared.protectedText,
            }),
            toolCalls: [],
            finishReason: "stop",
          };
        },
      },
      evidence: /** @type {import("#core/untrusted.mjs").Evidence} */ ({
        /** @param {string} label @param {string} content */
        wrap(label, content) {
          return `[${label}]\n${content}`;
        },
      }),
      repository: { name: "acme/docs", description: "Documentation" },
      documents: { languages: {} },
    });

    expect(result.outcome).toBe("proposal");
  });
});

describe("pairBlockShape", () => {
  it("plans when both sides provably carry blocks", () => {
    const recorded = /** @type {any} */ ({
      sourceBlocks: [{ content: "# A\n" }, { content: "# B\n" }],
    });
    expect(pairBlockShape(recorded, [{ content: "# A\n" }, { content: "# B changed\n" }])).toEqual({
      planning: "planned",
      changed: 1,
      unchanged: 1,
      added: 0,
      removed: 0,
    });
  });

  it("degrades to whole-file when the recorded state carries no blocks", () => {
    const absent = {
      planning: "whole-file",
      reason: "the recorded state carries no block fingerprints to plan against",
    };
    expect(pairBlockShape(null, [{ content: "# A\n" }])).toEqual(absent);
    expect(pairBlockShape(/** @type {any} */ ({}), [{ content: "# A\n" }])).toEqual(absent);
  });

  it("degrades to whole-file when no segmentation stage exists for the current source", () => {
    const recorded = /** @type {any} */ ({ sourceBlocks: [{ content: "# A\n" }] });
    expect(pairBlockShape(recorded, null)).toEqual({
      planning: "whole-file",
      reason: "no segmentation stage exists for the current source",
    });
  });

  it("degrades to whole-file on recorded blocks that are not content-carrying blocks", () => {
    const malformed = /** @type {any} */ ({ sourceBlocks: [{ content: 7 }] });
    expect(pairBlockShape(malformed, [{ content: "# A\n" }]).planning).toBe("whole-file");
    const notAList = /** @type {any} */ ({ sourceBlocks: "nope" });
    expect(pairBlockShape(notAList, [{ content: "# A\n" }]).planning).toBe("whole-file");
  });
});

describe("planFrontmatterGuard", () => {
  it("passes a frontmatter-less document through as absent", () => {
    expect(planFrontmatterGuard("# Dev\n\nProse.\n")).toEqual({ kind: "absent" });
  });

  it("refuses frontmatter the recognizer cannot parse", () => {
    const result = planFrontmatterGuard("---\ntitle: a\ntitle: b\n---\n");
    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.code).toBe("duplicate-key");
  });

  it("plans a guard whose masked raw carries tokens and whose restore map holds the exact bytes", () => {
    const result = planFrontmatterGuard("---\ntitle: Dev guide\nslug: dev\n---\n");
    expect(result.kind).toBe("planned");
    if (result.kind !== "planned") return;
    expect(result.guard.maskedRaw).toContain("title: Dev guide");
    expect(result.guard.maskedRaw).toMatch(/slug: \[\[harmonise:[0-9a-f]{16}:f1\]\]/);
    expect([...result.guard.restoreMap.values()]).toEqual(["dev"]);
  });
});

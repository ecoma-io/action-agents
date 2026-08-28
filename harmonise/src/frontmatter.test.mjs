import { describe, expect, it } from "vitest";

import {
  DEFAULT_FRONTMATTER_POLICY,
  extractFrontmatter,
  planFrontmatterProtection,
  validateFrontmatter,
} from "./frontmatter.mjs";

/** The run id every plan in this suite mints, so tokens are assertable. */
const fixedId = () => "0123456789abcdef";

/** The first two tokens a plan mints under that id. */
const TOKEN1 = "[[harmonise:0123456789abcdef:f1]]";
const TOKEN2 = "[[harmonise:0123456789abcdef:f2]]";

/** The canonical extraction fixture: two scalars and one nested mapping. */
const SOURCE = [
  "---",
  "title: Hello",
  "slug: first-post",
  "menu:",
  "  main:",
  "    name: X",
  "    weight: 1",
  "---",
  "# Heading",
  "",
].join("\n");

/** The raw frontmatter `SOURCE` carries between its fence lines. */
const RAW = [
  "title: Hello",
  "slug: first-post",
  "menu:",
  "  main:",
  "    name: X",
  "    weight: 1",
  "",
].join("\n");

/**
 * Extracts, or fails the test — the extraction the assertions go on.
 *
 * @param {string} source
 * @returns {{
 *   raw: string,
 *   contentStart: number,
 *   contentEnd: number,
 *   startLine: number,
 *   endLine: number,
 *   keys: Array<{ name: string, kind: string, valueStart: number, valueEnd: number }>,
 * }}
 */
function extract(source) {
  const extracted = extractFrontmatter(source);
  if (extracted.kind !== "extracted") {
    throw new Error(`expected an extraction, got ${JSON.stringify(extracted)}`);
  }
  return extracted;
}

/**
 * Plans with the fixed run id, or fails the test — the plan the assertions go on.
 *
 * @param {string} raw
 * @param {typeof DEFAULT_FRONTMATTER_POLICY} [policy]
 * @returns {{ masked: string, restoreMap: Map<string, string> }}
 */
function plan(raw, policy = DEFAULT_FRONTMATTER_POLICY) {
  const planned = planFrontmatterProtection(raw, policy, { newId: fixedId });
  if (planned.kind !== "planned") {
    throw new Error(`expected a plan, got ${JSON.stringify(planned)}`);
  }
  return planned;
}

/**
 * Puts the original bytes back, the way a caller's restore step would.
 *
 * @param {string} text
 * @param {Map<string, string>} restoreMap
 * @returns {string}
 */
function restore(text, restoreMap) {
  let out = text;
  for (const [token, original] of restoreMap) out = out.split(token).join(original);
  return out;
}

/**
 * Joins fixture lines into frontmatter text.
 *
 * @param {string[]} lines the lines of the raw frontmatter, no trailing newline of their own
 * @returns {string}
 */
function raw(lines) {
  return `${lines.join("\n")}\n`;
}

/**
 * Asserts a plan-shaped result was refused with the given stable code.
 *
 * @param {unknown} result
 * @param {string} code
 */
function expectRefusal(result, code) {
  expect(result).toMatchObject({ kind: "refused", code });
}

describe("DEFAULT_FRONTMATTER_POLICY", () => {
  it("protects the structural keys", () => {
    expect(DEFAULT_FRONTMATTER_POLICY.protectedKeys).toEqual([
      "slug",
      "permalink",
      "url",
      "path",
      "layout",
      "template",
      "draft",
      "date",
      "publishdate",
      "lastmod",
      "weight",
      "order",
      "id",
      "uuid",
      "type",
    ]);
  });

  it("translates exactly the prose keys", () => {
    expect(DEFAULT_FRONTMATTER_POLICY.translatableKeys).toEqual([
      "title",
      "description",
      "summary",
      "excerpt",
    ]);
  });

  it("keeps the two lists disjoint", () => {
    const protectedKeys = new Set(DEFAULT_FRONTMATTER_POLICY.protectedKeys);
    for (const name of DEFAULT_FRONTMATTER_POLICY.translatableKeys) {
      expect(protectedKeys.has(name)).toBe(false);
    }
  });
});

describe("extractFrontmatter", () => {
  it("reports absence when the source has no leading fence", () => {
    expect(extractFrontmatter("# Heading\n\nBody text.\n")).toEqual({ kind: "absent" });
  });

  it("treats an unclosed leading '---' as a thematic break, not frontmatter", () => {
    expect(extractFrontmatter("---\ntitle: x\n\n# Heading\n")).toEqual({ kind: "absent" });
  });

  it("extracts the block between the fence lines", () => {
    expect(extract(SOURCE)).toMatchObject({
      raw: RAW,
      contentStart: 4,
      startLine: 0,
      endLine: 7,
    });
  });

  it("reports contentEnd one past the raw frontmatter, in source bytes", () => {
    const extracted = extract(SOURCE);
    expect(extracted.contentEnd).toBe(extracted.contentStart + RAW.length);
  });

  it("measures contentEnd in UTF-8 bytes, not characters", () => {
    const source = "---\ntitle: Café — «déjà» 😀\nslug: first-post\n---\nBody\n";
    const extracted = extract(source);
    const bytes = new TextEncoder().encode(extracted.raw).byteLength;
    expect(extracted.raw.length).toBeLessThan(bytes); // the fixture really is multibyte
    expect(extracted.contentEnd - extracted.contentStart).toBe(bytes);
  });

  it("encodes a lone surrogate the way TextEncoder does", () => {
    const source = `---\ntitle: news \uD800 alone\nslug: x\n---\nBody\n`;
    const extracted = extract(source);
    const bytes = new TextEncoder().encode(extracted.raw).byteLength;
    expect(extracted.contentEnd - extracted.contentStart).toBe(bytes);
  });

  it("keeps CRLF line endings in the raw text and out of the value spans", () => {
    const source = "---\r\ntitle: Hello\r\nslug: first-post\r\n---\r\nBody\r\n";
    const extracted = extract(source);
    expect(extracted.raw).toBe("title: Hello\r\nslug: first-post\r\n");
    const slug = extracted.keys.find((key) => key.name === "slug");
    expect(slug?.valueEnd).toBeDefined();
    if (slug === undefined) throw new Error("slug not recognized");
    expect(extracted.raw.slice(slug.valueStart, slug.valueEnd)).toBe("first-post");
  });

  it("accepts an empty block", () => {
    const extracted = extract("---\n---\nBody\n");
    expect(extracted.raw).toBe("");
    expect(extracted.keys).toEqual([]);
  });

  it("accepts fence lines with trailing spaces", () => {
    const extracted = extract("--- \ntitle: x\n--- \nBody\n");
    expect(extracted.raw).toBe("title: x\n");
  });

  it("stops at the first closing fence", () => {
    const extracted = extract("---\ntitle: x\n---\n---\nnot frontmatter\n");
    expect(extracted.raw).toBe("title: x\n");
    expect(extracted.endLine).toBe(2);
  });

  it("keeps CRLF line endings in the raw text and out of the value spans", () => {
    const source = "---\r\ntitle: Hello\r\nslug: first-post\r\n---\r\nBody\r\n";
    const extracted = extract(source);
    expect(extracted.raw).toBe("title: Hello\r\nslug: first-post\r\n");
    const slug = extracted.keys.find((key) => key.name === "slug");
    if (slug === undefined) throw new Error("slug not recognized");
    expect(extracted.raw.slice(slug.valueStart, slug.valueEnd)).toBe("first-post");
  });
  it("encodes a lone low surrogate the way TextEncoder does", () => {
    const source = `---\ntitle: stray \uDC00 alone\nslug: x\n---\nBody\n`;
    const extracted = extract(source);
    const bytes = new TextEncoder().encode(extracted.raw).byteLength;
    expect(extracted.contentEnd - extracted.contentStart).toBe(bytes);
  });

  it("reads quoted values with escaped quotes inside", () => {
    const extracted = extract('---\ntitle: "say \\"hi\\" now"\nslug: x\n---\nBody\n');
    const title = extracted.keys.find((key) => key.name === "title");
    if (title === undefined) throw new Error("title not recognized");
    expect(title.kind).toBe("scalar");
    expect(extracted.raw.slice(title.valueStart, title.valueEnd)).toBe('"say \\"hi\\" now"');
    const doubled = extract("---\ntitle: 'it''s fine'\nslug: x\n---\nBody\n");
    const fine = doubled.keys.find((key) => key.name === "title");
    if (fine === undefined) throw new Error("title not recognized");
    expect(doubled.raw.slice(fine.valueStart, fine.valueEnd)).toBe("'it''s fine'");
  });

  it("spans a mapping from its colon to its last line, grandchildren included", () => {
    const extracted = extract(SOURCE);
    const menu = extracted.keys.find((key) => key.name === "menu");
    if (menu === undefined) throw new Error("menu not recognized");
    expect(extracted.raw.slice(menu.valueStart, menu.valueEnd)).toBe(
      "\n  main:\n    name: X\n    weight: 1",
    );
  });

  it("accepts a dedent back to the parent mapping's own indent", () => {
    const source = "---\nmenu:\n  main:\n    name: X\n  weight: 1\n---\nBody\n";
    const extracted = extract(source);
    expect(extracted.keys.map((key) => key.name)).toEqual(["menu", "main", "name", "weight"]);
  });

  it("slices each scalar value exactly between its span", () => {
    const extracted = extract(SOURCE);
    expect(extracted.keys.map((key) => extracted.raw.slice(key.valueStart, key.valueEnd))).toEqual([
      "Hello",
      "first-post",
      "\n  main:\n    name: X\n    weight: 1",
      "\n    name: X\n    weight: 1",
      "X",
      "1",
    ]);
  });

  it("reads a quoted value that contains ': '", () => {
    const extracted = extract('---\ntitle: "Chapter 1: Beginnings"\nslug: x\n---\nBody\n');
    const title = extracted.keys.find((key) => key.name === "title");
    if (title === undefined) throw new Error("title not recognized");
    expect(title.kind).toBe("scalar");
    expect(extracted.raw.slice(title.valueStart, title.valueEnd)).toBe('"Chapter 1: Beginnings"');
  });

  it("counts a single-line flow collection as a flow value", () => {
    const extracted = extract("---\ntags: [one, two]\nslug: x\n---\nBody\n");
    const tags = extracted.keys.find((key) => key.name === "tags");
    expect(tags?.kind).toBe("flow");
  });

  it("refuses a duplicate key", () => {
    expectRefusal(
      extractFrontmatter(`---\n${raw(["title: a", "title: b"])}---\n`),
      "duplicate-key",
    );
  });

  it("refuses anchors, on a value or starting a line", () => {
    expectRefusal(extractFrontmatter(`---\n${raw(["title: &intro text"])}---\n`), "anchor");
    expectRefusal(extractFrontmatter(`---\n${raw(["&intro title: x"])}---\n`), "anchor");
  });

  it("refuses aliases", () => {
    expectRefusal(extractFrontmatter(`---\n${raw(["title: *intro"])}---\n`), "alias");
  });

  it("refuses a whole-line alias", () => {
    expectRefusal(extractFrontmatter(`---\n${raw(["title: x", "*intro"])}---\n`), "alias");
  });

  it("refuses merge keys", () => {
    expectRefusal(extractFrontmatter(`---\n${raw(["title: x", "<<: *base"])}---\n`), "merge-key");
  });

  it("refuses multi-line scalars, literal and folded", () => {
    expectRefusal(
      extractFrontmatter(`---\n${raw(["title: |", "  text"])}---\n`),
      "multiline-scalar",
    );
    expectRefusal(
      extractFrontmatter(`---\n${raw(["summary: >", "  text"])}---\n`),
      "multiline-scalar",
    );
  });

  it("refuses sequence entries", () => {
    expectRefusal(extractFrontmatter(`---\n${raw(["tags:", "  - one"])}---\n`), "sequence-entry");
  });

  it("refuses a flow collection that spans lines", () => {
    expectRefusal(
      extractFrontmatter(`---\n${raw(["tags: [one,", "  two]"])}---\n`),
      "unrecognized-line",
    );
  });

  it("refuses tab indentation", () => {
    expectRefusal(extractFrontmatter(`---\n${raw(["title: x", "\tslug: y"])}---\n`), "tab-indent");
  });

  it("refuses a colon with no following space", () => {
    expectRefusal(extractFrontmatter(`---\n${raw(["title:Café"])}---\n`), "unrecognized-line");
  });

  it("refuses a second ': ' in an unquoted value", () => {
    const result = extractFrontmatter(`---\n${raw(["title: a: b"])}---\n`);
    expectRefusal(result, "unrecognized-line");
    expect(result.kind === "refused" && result.message).toContain(
      "a second ': ' makes the value ambiguous",
    );
  });

  it("records a bare key at end of input as an empty scalar", () => {
    // `title:` with no following content line resolves at end of input: an
    // empty scalar whose value span sits just past the line terminator,
    // whether that terminator is LF or CRLF.
    const extracted = extract("---\ntitle:\n---\nBody\n");
    expect(extracted.keys).toEqual([{ name: "title", kind: "scalar", valueStart: 6, valueEnd: 6 }]);
    const crlf = extract("---\r\ntitle:\r\n---\r\nBody\r\n");
    expect(crlf.keys).toEqual([{ name: "title", kind: "scalar", valueStart: 7, valueEnd: 7 }]);
  });

  it("refuses a quoted key", () => {
    expectRefusal(extractFrontmatter(`---\n${raw(['"quoted": x'])}---\n`), "unrecognized-line");
  });

  it("refuses a quoted value that does not close on its line", () => {
    expectRefusal(
      extractFrontmatter(`---\n${raw(['title: "never ends'])}---\n`),
      "unrecognized-line",
    );
  });

  it("refuses ragged indentation inside one mapping", () => {
    expectRefusal(
      extractFrontmatter(`---\n${raw(["menu:", "  main:", "    name: X", "     extra: Y"])}---\n`),
      "inconsistent-indent",
    );
  });

  it("refuses a dedent that skips a level", () => {
    expectRefusal(
      extractFrontmatter(`---\n${raw(["a:", "    b:", "        c: 1", "  d: 2"])}---\n`),
      "inconsistent-indent",
    );
  });
});

describe("planFrontmatterProtection", () => {
  it("masks protected values and leaves translatable keys in the clear", () => {
    const planned = plan(RAW);
    expect(planned.masked).toBe(`title: Hello\nslug: ${TOKEN1}\nmenu:${TOKEN2}\n`);
    expect(planned.restoreMap).toEqual(
      new Map([
        [TOKEN1, "first-post"],
        [TOKEN2, "\n  main:\n    name: X\n    weight: 1"],
      ]),
    );
  });

  it("round-trips the masked text through the restore map", () => {
    const planned = plan(RAW);
    expect(restore(planned.masked, planned.restoreMap)).toBe(RAW);
  });

  it("numbers tokens in document order", () => {
    const planned = plan(raw(["slug: first-post", "permalink: /content/post/first-post/"]));
    expect(planned.masked).toBe(`slug: ${TOKEN1}\npermalink: ${TOKEN2}\n`);
  });

  it("protects a key the policy has never heard of", () => {
    const planned = plan(raw(["slug: first-post", "custom-meta: keep-me"]));
    expect(planned.masked).toBe(`slug: ${TOKEN1}\ncustom-meta: ${TOKEN2}\n`);
    expect(restore(planned.masked, planned.restoreMap)).toBe(
      raw(["slug: first-post", "custom-meta: keep-me"]),
    );
  });

  it("carries a protected nested mapping as one token", () => {
    const planned = plan(RAW);
    expect(restore(planned.masked, planned.restoreMap)).toBe(RAW);
  });

  it("refuses a translatable key with a nested mapping", () => {
    const result = planFrontmatterProtection(
      raw(["title:", "  quoted: value"]),
      DEFAULT_FRONTMATTER_POLICY,
      {
        newId: fixedId,
      },
    );
    expect(result).toMatchObject({ kind: "refused", code: "translatable-key-not-scalar" });
    expect(result.kind === "refused" && result.message).toContain("nested mapping");
  });

  it("refuses a translatable key with a flow value", () => {
    const result = planFrontmatterProtection(
      raw(["title: [not, scalar]"]),
      DEFAULT_FRONTMATTER_POLICY,
      {
        newId: fixedId,
      },
    );
    expect(result).toMatchObject({ kind: "refused", code: "translatable-key-not-scalar" });
    expect(result.kind === "refused" && result.message).toContain("flow collection");
  });

  it("refuses raw text already wearing the placeholder namespace", () => {
    expectRefusal(
      planFrontmatterProtection(
        raw(["title: [[harmonise:deadbeefdeadbeef:g1]] hello"]),
        DEFAULT_FRONTMATTER_POLICY,
        { newId: fixedId },
      ),
      "token-collision",
    );
  });

  it("refuses a policy that protects and translates the same key", () => {
    expectRefusal(
      planFrontmatterProtection(RAW, {
        protectedKeys: ["title", "slug"],
        translatableKeys: ["title"],
      }),
      "policy-conflict",
    );
  });

  it("refuses a policy that is not a policy", () => {
    for (const bad of [
      null,
      ["title"],
      { translatableKeys: ["title"] },
      { protectedKeys: [3], translatableKeys: ["title"] },
      { protectedKeys: [""], translatableKeys: ["title"] },
      { protectedKeys: ["slug"] },
    ]) {
      expectRefusal(
        planFrontmatterProtection(RAW, /** @type {any} */ (bad), { newId: fixedId }),
        "invalid-policy",
      );
    }
  });

  it("honors a custom policy and still protects what it does not name", () => {
    const planned = plan(raw(["title: Hello", "slug: first-post", "note: internal"]), {
      protectedKeys: ["slug"],
      translatableKeys: ["title"],
    });
    expect(planned.masked).toBe(`title: Hello\nslug: ${TOKEN1}\nnote: ${TOKEN2}\n`);
  });

  it("plans an empty block to an empty mask", () => {
    const planned = plan("");
    expect(planned.masked).toBe("");
    expect(planned.restoreMap.size).toBe(0);
  });

  it("mints no token for an empty value and carries a whitespace-only one", () => {
    const planned = plan(raw(["slug:", "draft:   "]));
    expect(planned.masked).toBe(`slug:\ndraft: ${TOKEN1}\n`);
    expect(planned.restoreMap).toEqual(new Map([[TOKEN1, "  "]]));
    expect(restore(planned.masked, planned.restoreMap)).toBe(raw(["slug:", "draft:   "]));
  });

  it("carries no token for a bare key at end of input", () => {
    const planned = plan(raw(["slug:"]));
    expect(planned.masked).toBe("slug:\n");
    expect(planned.restoreMap.size).toBe(0);
    expect(restore(planned.masked, planned.restoreMap)).toBe(raw(["slug:"]));
  });

  it("refuses raw text that still wears its fences", () => {
    expectRefusal(
      planFrontmatterProtection("---\ntitle: x\n---\n", DEFAULT_FRONTMATTER_POLICY, {
        newId: fixedId,
      }),
      "fence-line",
    );
  });

  it("mints a default run id shaped like every other token", () => {
    const planned = planFrontmatterProtection(
      raw(["slug: first-post"]),
      DEFAULT_FRONTMATTER_POLICY,
    );
    if (planned.kind !== "planned") throw new Error("expected a plan");
    const [token] = [...planned.restoreMap.keys()];
    expect(token).toMatch(/^\[\[harmonise:[0-9a-f]{16}:f1\]\]$/);
  });
});

describe("validateFrontmatter", () => {
  it("passes identical frontmatter", () => {
    expect(validateFrontmatter(RAW, RAW, DEFAULT_FRONTMATTER_POLICY)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("passes the full pipeline: plan, translate, restore", () => {
    const planned = plan(RAW);
    const restored = restore(planned.masked.replace("Hello", "Bonjour"), planned.restoreMap);
    expect(restored).not.toBe(RAW); // the translation really moved the prose
    expect(validateFrontmatter(RAW, restored, DEFAULT_FRONTMATTER_POLICY)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("passes the full pipeline on CRLF frontmatter", () => {
    const text = "title: Hello\r\nslug: first-post\r\n";
    const planned = plan(text);
    const restored = restore(planned.masked.replace("Hello", "Bonjour"), planned.restoreMap);
    expect(validateFrontmatter(text, restored, DEFAULT_FRONTMATTER_POLICY)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("reports a protected value that came back different", () => {
    const planned = plan(RAW);
    const restored = restore(planned.masked, planned.restoreMap).replace("first-post", "moved");
    const { ok, violations } = validateFrontmatter(RAW, restored, DEFAULT_FRONTMATTER_POLICY);
    expect(ok).toBe(false);
    expect(violations).toEqual([
      {
        code: "protected-value-changed",
        key: "slug",
        detail: expect.stringContaining("byte-identical"),
      },
    ]);
  });

  it("reports an unknown key that came back different", () => {
    const text = raw(["title: x", "custom-meta: keep-me"]);
    const { violations } = validateFrontmatter(
      text,
      text.replace("keep-me", "changed"),
      DEFAULT_FRONTMATTER_POLICY,
    );
    expect(violations).toEqual([
      {
        code: "protected-value-changed",
        key: "custom-meta",
        detail: expect.any(String),
      },
    ]);
  });

  it("reports a key the translation added", () => {
    const { violations } = validateFrontmatter(RAW, `${RAW}extra: 1\n`, DEFAULT_FRONTMATTER_POLICY);
    expect(violations).toEqual([{ code: "added-key", key: "extra", detail: expect.any(String) }]);
  });

  it("reports a key the translation lost", () => {
    const { violations } = validateFrontmatter(
      RAW,
      RAW.replace("slug: first-post\n", ""),
      DEFAULT_FRONTMATTER_POLICY,
    );
    expect(violations).toEqual([{ code: "missing-key", key: "slug", detail: expect.any(String) }]);
  });

  it("reports reordered keys", () => {
    const reordered = raw([
      "slug: first-post",
      "title: Hello",
      "menu:",
      "  main:",
      "    name: X",
      "    weight: 1",
    ]);
    const { ok, violations } = validateFrontmatter(RAW, reordered, DEFAULT_FRONTMATTER_POLICY);
    expect(ok).toBe(false);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("reordered-key");
  });

  it("reports a scalar that came back a mapping", () => {
    const changed = raw([
      "title:",
      "  main: x",
      "slug: first-post",
      "menu:",
      "  main:",
      "    name: X",
      "    weight: 1",
    ]);
    const { violations } = validateFrontmatter(RAW, changed, DEFAULT_FRONTMATTER_POLICY);
    expect(violations).toEqual([
      { code: "changed-kind", key: "title", detail: expect.stringContaining("came back a map") },
    ]);
  });

  it("reports a translatable key that holds a flow collection", () => {
    const { violations } = validateFrontmatter(
      raw(["title: [a, b]", "slug: x"]),
      raw(["title: [c, d]", "slug: x"]),
      DEFAULT_FRONTMATTER_POLICY,
    );
    expect(violations).toEqual([
      {
        code: "translatable-key-not-scalar",
        key: "title",
        detail: expect.stringContaining("flow"),
      },
    ]);
  });

  it("reports an empty translatable value that the translation filled", () => {
    const { violations } = validateFrontmatter(
      raw(["title:", "slug: x"]),
      raw(["title: words", "slug: x"]),
      DEFAULT_FRONTMATTER_POLICY,
    );
    expect(violations).toEqual([
      { code: "empty-translatable-filled", key: "title", detail: expect.any(String) },
    ]);
  });

  it("reports an original it cannot parse", () => {
    const { ok, violations } = validateFrontmatter(
      raw(["title: &anchor x"]),
      RAW,
      DEFAULT_FRONTMATTER_POLICY,
    );
    expect(ok).toBe(false);
    expect(violations[0]?.code).toBe("unparseable-original");
  });

  it("reports a translation it cannot parse", () => {
    const { ok, violations } = validateFrontmatter(
      RAW,
      raw(["title: *alias"]),
      DEFAULT_FRONTMATTER_POLICY,
    );
    expect(ok).toBe(false);
    expect(violations[0]?.code).toBe("unparseable-translated");
  });

  it("reports an invalid policy as one violation", () => {
    const { ok, violations } = validateFrontmatter(RAW, RAW, /** @type {any} */ (null));
    expect(ok).toBe(false);
    expect(violations).toEqual([{ code: "invalid-policy", detail: expect.any(String) }]);
  });

  it("reports a placeholder token that survived restoration", () => {
    const forged = RAW.replace("Hello", "[[harmonise:deadbeefdeadbeef:f1]]");
    const { ok, violations } = validateFrontmatter(RAW, forged, DEFAULT_FRONTMATTER_POLICY);
    expect(ok).toBe(false);
    // A residual token is a refusal on its own, and it may also unbalance
    // the value it hides in — the namespace check runs regardless.
    expect(violations.map((v) => v.code)).toContain("residual-token");
    expect(violations.find((v) => v.code === "residual-token")?.detail).toContain(
      "1 harmonise placeholder",
    );
  });
});

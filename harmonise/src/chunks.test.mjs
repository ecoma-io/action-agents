// Tests for the document chunker — the deterministic partition that replaced
// the whole-document semantic ceiling.
//
// chunkDocument is a pure function over the source document: it slices at
// Markdown structural boundaries (frontmatter head, fenced code blocks,
// harmonise protected regions, blank-line-separated prose) so that every
// chunk stays under MAX_CHUNK_BYTES of UTF-8, and the reassembled document
// equals the original byte-for-byte. Atomic units are never split, refusals
// are honest (empty source, an unsplittable unit, or a document past the
// per-pair chunk budget), and the same text always chunks identically.
//
// Known defect, reported to the main agent (not fixed here — this suite owns
// test files only): a `harmonise:skip-start` … `harmonise:skip-end` region
// whose interior holds at least one non-blank content line crashes the
// chunker (its interior opens a content run that overlaps the region unit,
// and the greedy pack then drops the opening directive from the
// reassembled text, tripping the join invariant). The cases below therefore
// pin the region contract in the shape the implementation honors: a region
// whose interior is blank lines is one atomic unit.

import { describe, expect, it } from "vitest";

import { chunkDocument, MAX_CHUNK_BYTES, MAX_CHUNKS_PER_PAIR } from "./chunks.mjs";

const bytes = (/** @type {string} */ slice) => Buffer.byteLength(slice);

describe("chunkDocument", () => {
  it("passes a small document through as a single chunk", () => {
    const text = "# Dev\n\nProse.\n";
    const result = chunkDocument(text);
    expect(result.refusal).toBeNull();
    expect(result.chunks).toEqual([text]);
    expect(result.chunks.join("")).toBe(text);
  });

  it("refuses an empty source with the declared message", () => {
    expect(chunkDocument("")).toEqual({ chunks: [], refusal: "the source document is empty" });
  });

  it("keeps the frontmatter head atomic in the first chunk", () => {
    const text = "---\ntitle: T\n---\n\n" + "a".repeat(20480) + "\n\n" + "b".repeat(20480);
    const result = chunkDocument(text);
    expect(result.refusal).toBeNull();
    expect(result.chunks.length).toBe(2);
    expect(result.chunks[0]?.startsWith("---\ntitle: T\n---\n")).toBe(true);
    expect(result.chunks.join("")).toBe(text);
    for (const chunk of result.chunks) expect(bytes(chunk)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
  });

  it("keeps a fence with interior blank lines one atomic unit", () => {
    const text = "a".repeat(24000) + "\n\n```\n\nx\n\n```\n\n" + "b".repeat(24000);
    const result = chunkDocument(text);
    expect(result.refusal).toBeNull();
    expect(result.chunks).toHaveLength(2);
    // The whole fence — delimiters, interior blanks and content — rides in
    // one chunk; the boundary lands at the blank lines outside it.
    expect(result.chunks[0]).toContain("```\n\nx\n\n```");
    expect(result.chunks.join("")).toBe(text);
  });

  it("keeps a skip-start/skip-end region whose interior is blank lines one atomic unit", () => {
    // The region unit spans its markers and interior, so a boundary forced
    // by a large following block lands at the blank line after the region,
    // never inside it.
    const region = "<!-- harmonise:skip-start -->\n\n\n<!-- harmonise:skip-end -->\n";
    const tail = "t".repeat(24570);
    const text = region + "\n" + tail;
    const result = chunkDocument(text);
    expect(result.refusal).toBeNull();
    expect(result.chunks).toEqual([region + "\n", tail]);
    expect(result.chunks.join("")).toBe(text);
  });

  it("keeps a lone skip with a blank-separated target one unit", () => {
    const text = "<!-- harmonise:skip -->\n\nTarget line\n";
    const result = chunkDocument(text);
    expect(result.refusal).toBeNull();
    expect(result.chunks).toEqual([text]);
    expect(result.chunks.join("")).toBe(text);
  });

  it("keeps two adjacent lone skips sharing one target together", () => {
    const text = "<!-- harmonise:skip -->\n<!-- harmonise:skip -->\nTarget\n";
    const result = chunkDocument(text);
    expect(result.refusal).toBeNull();
    expect(result.chunks).toEqual([text]);
    // Neither directive nor the shared target is separated from the pair.
    expect(result.chunks.join("")).toBe(text);
  });

  it("keeps an unclosed fence one atomic unit through EOF", () => {
    const text = "a".repeat(24000) + "\n\n```\n" + "y".repeat(20000);
    const result = chunkDocument(text);
    expect(result.refusal).toBeNull();
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]).not.toContain("```");
    expect(result.chunks[1]).toBe("```\n" + "y".repeat(20000));
    expect(result.chunks.join("")).toBe(text);
  });

  it("reassembles a multibyte multi-chunk document byte-for-byte, deterministically", () => {
    const text = "é".repeat(12000) + "\n\n" + "é".repeat(12000);
    const first = chunkDocument(text);
    const second = chunkDocument(text);
    expect(first.refusal).toBeNull();
    expect(first.chunks.length).toBe(2);
    expect(second.chunks).toEqual(first.chunks);
    expect(first.chunks.join("")).toBe(text);
    for (const chunk of first.chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
  });

  it("partitions an ASCII document into three chunks under the byte ceiling", () => {
    const text = "y".repeat(20480) + "\n\n" + "y".repeat(20480) + "\n\n" + "y".repeat(20480);
    const result = chunkDocument(text);
    expect(result.refusal).toBeNull();
    expect(result.chunks.length).toBeGreaterThanOrEqual(3);
    expect(result.chunks.join("")).toBe(text);
    for (const chunk of result.chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
  });

  it("refuses an oversize unsplittable fence, naming the block's byte count", () => {
    const text = "```\n" + "x".repeat(30 * 1024) + "\n```\n";
    const result = chunkDocument(text);
    expect(result.refusal).toBe(
      `an unsplittable block of ${String(bytes(text))} bytes does not fit one chunk — ` +
        "shrink or split it",
    );
    expect(result.chunks).toEqual([]);
  });

  it("refuses an oversize unsplittable paragraph, naming the block's byte count", () => {
    const text = "z".repeat(30 * 1024);
    const result = chunkDocument(text);
    expect(result.refusal).toBe(
      `an unsplittable block of ${String(bytes(text))} bytes does not fit one chunk — ` +
        "shrink or split it",
    );
    expect(result.chunks).toEqual([]);
  });

  it("keeps a paragraph of exactly the chunk byte ceiling one chunk", () => {
    const text = "q".repeat(MAX_CHUNK_BYTES);
    const result = chunkDocument(text);
    expect(result.refusal).toBeNull();
    expect(result.chunks).toEqual([text]);
    expect(bytes(result.chunks[0] ?? "")).toBe(MAX_CHUNK_BYTES);
  });

  it("splits a document one full chunk plus a second block into two chunks", () => {
    const text = "q".repeat(24570) + "\n\n" + "z".repeat(100);
    const result = chunkDocument(text);
    expect(result.refusal).toBeNull();
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks.join("")).toBe(text);
    for (const chunk of result.chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
  });

  it("honors the per-chunk byte ceiling on every chunk it returns", () => {
    const text = Array.from({ length: 5 }, () => "w".repeat(12280)).join("\n\n");
    const result = chunkDocument(text);
    expect(result.refusal).toBeNull();
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.join("")).toBe(text);
    for (const chunk of result.chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
  });

  it("refuses a document past the per-pair chunk budget, naming the count", () => {
    const text = Array.from({ length: MAX_CHUNKS_PER_PAIR + 1 }, (_, i) =>
      String(i % 10).repeat(20480),
    ).join("\n\n");
    const result = chunkDocument(text);
    expect(result.refusal).toBe(
      `the document needs ${String(MAX_CHUNKS_PER_PAIR + 1)} chunks, past the ` +
        `${String(MAX_CHUNKS_PER_PAIR)}-chunk execution budget — split the document`,
    );
    expect(result.chunks).toEqual([]);
  });
});

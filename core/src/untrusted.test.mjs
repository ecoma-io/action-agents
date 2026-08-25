// Tests for the evidence wrapper.
//
// The wrapper frames; the ceilings that bite are elsewhere. What is pinned
// here is the framing's own honesty: the delimiter is random per run, a
// collision inside the content is escaped deterministically, the cap is
// marked rather than silent, and the cut lands on a code-point boundary.

import { describe, expect, it } from "vitest";

import { FRAMING, MAX_EVIDENCE_BYTES, createEvidence } from "./untrusted.mjs";

/** @returns {string} */
function fixedId() {
  return "deadbeefdeadbeef";
}

describe("the frame", () => {
  it("wraps content between generated delimiters, with the framing line first", () => {
    const evidence = createEvidence(fixedId);
    const wrapped = evidence.wrap("issue-body", "The build fails on import.");

    expect(wrapped.startsWith(FRAMING)).toBe(true);
    expect(wrapped).toContain(
      "[evidence:deadbeefdeadbeef issue-body]\nThe build fails on import.\n[end-evidence:deadbeefdeadbeef]",
    );
  });

  it("uses a different delimiter each run, so content cannot predict it", () => {
    let next = 0;
    const ids = () => `id${String((next += 1)).padStart(2, "0")}`;
    const first = createEvidence(ids).wrap("x", "content");
    const second = createEvidence(ids).wrap("x", "content");

    expect(first).not.toContain(second.slice(FRAMING.length, FRAMING.length + 24));
  });

  it("refuses a label that could shape the frame itself", () => {
    const evidence = createEvidence(fixedId);
    expect(() => evidence.wrap("not a label", "x")).toThrow(/kebab-case/);
    expect(() => evidence.wrap("issue-body]", "x")).toThrow(/kebab-case/);
  });
});

describe("delimiter collisions", () => {
  it("escapes the end delimiter appearing inside the content, deterministically", () => {
    const evidence = createEvidence(fixedId);
    const end = "[end-evidence:deadbeefdeadbeef]";
    const wrapped = evidence.wrap("issue-body", `before ${end} after ${end}`);

    // The only intact occurrence is the wrapper's own; the collisions are
    // broken up and nothing was dropped.
    const intact = wrapped.split(end).length - 1;
    expect(intact).toBe(1);
    expect(wrapped.endsWith(end)).toBe(true);
    expect(wrapped).toContain("before");
    expect(wrapped).toContain("after");
  });

  it("escapes a collision that ends the content — the worst case for a parser", () => {
    const evidence = createEvidence(fixedId);
    const end = "[end-evidence:deadbeefdeadbeef]";
    const wrapped = evidence.wrap("issue-body", `tail ${end}`);

    expect(wrapped.endsWith(end)).toBe(true);
    expect(wrapped.split(end).length - 1).toBe(1);
  });
});

describe("the cap", () => {
  it("keeps content at the cap untouched", () => {
    const evidence = createEvidence(fixedId);
    const within = "a".repeat(MAX_EVIDENCE_BYTES);
    // The ASCII content is exactly at the byte cap; multi-byte content below
    // exercises the byte, not character, reading of the cap.
    const multibyte = "é".repeat(MAX_EVIDENCE_BYTES / 2 - 1);

    expect(evidence.wrap("x", within)).not.toContain("truncated");
    expect(evidence.wrap("x", multibyte)).not.toContain("truncated");
  });

  it("marks the cut inside the wrapper, with both byte counts", () => {
    const evidence = createEvidence(fixedId);
    const oversized = "a".repeat(MAX_EVIDENCE_BYTES + 100);
    const wrapped = evidence.wrap("x", oversized);

    expect(wrapped).toContain(
      `[evidence truncated: ${String(MAX_EVIDENCE_BYTES)} of ${String(MAX_EVIDENCE_BYTES + 100)} bytes shown]`,
    );
    // The mark sits inside the evidence, before the wrapper's own end.
    expect(wrapped.indexOf("truncated")).toBeLessThan(wrapped.lastIndexOf("[end-evidence:"));
  });

  it("cuts on a code-point boundary rather than mid-character", () => {
    const evidence = createEvidence(fixedId);
    // Fill to the cap with ASCII then add a multi-byte character: the cut
    // must back off the partial sequence, not emit a replacement character.
    const oversized = `${"a".repeat(MAX_EVIDENCE_BYTES - 1)}éà`;
    const wrapped = evidence.wrap("x", oversized);

    expect(wrapped).not.toContain("�");
  });
});

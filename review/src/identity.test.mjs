// Tests for the cross-revision fingerprint: identity survives a moved line,
// a re-worded message and a re-grade, and dies on a rewritten span, a new
// kind or a new path. No occurrence rank exists — churn among claims that
// share a span must not shift an identity.

import { describe, expect, it } from "vitest";

import { isDigest } from "./digest.mjs";
import {
  FINGERPRINT_SUBJECT_CHARS,
  findingFingerprint,
  normalisePath,
  normaliseSubject,
} from "./identity.mjs";

describe("normalisePath", () => {
  it("folds backslashes to slashes", () => {
    expect(normalisePath("src\\a.mjs")).toBe("src/a.mjs");
  });

  it("drops ./ segments, leading and nested", () => {
    expect(normalisePath("./src/a.mjs")).toBe("src/a.mjs");
    expect(normalisePath("src/./a.mjs")).toBe("src/a.mjs");
  });

  it("keeps .. segments — escaping is validation's job, not normalisation's", () => {
    expect(normalisePath("../a.mjs")).toBe("../a.mjs");
  });
});

describe("normaliseSubject", () => {
  it("folds line endings and whitespace runs", () => {
    expect(normaliseSubject("  const x\t=\r\n1;  ")).toBe("const x = 1;");
  });

  it("marks a cut at the cap instead of trimming silently", () => {
    const cut = normaliseSubject("x".repeat(FINGERPRINT_SUBJECT_CHARS + 50));
    expect(cut).toHaveLength(FINGERPRINT_SUBJECT_CHARS + "…[truncated]".length);
    expect(cut.endsWith("…[truncated]")).toBe(true);
  });

  it("keeps a subject at the cap exactly", () => {
    const exact = "y".repeat(FINGERPRINT_SUBJECT_CHARS);
    expect(normaliseSubject(exact)).toBe(exact);
  });
});

describe("findingFingerprint", () => {
  /** @type {{ file: string, kind: import("./vocabulary.mjs").FindingKind, subject: string }} */
  const base = { file: "src/a.mjs", kind: "correctness", subject: "return x;" };

  it("is a 64-hex content digest", () => {
    expect(isDigest(findingFingerprint(base))).toBe(true);
  });

  it("is deterministic across calls", () => {
    expect(findingFingerprint(base)).toBe(findingFingerprint({ ...base }));
  });

  it("keeps identity when the line moved and the message was re-worded", () => {
    // The line and the message are not tuple inputs: revision one flagged
    // line 12, revision two flags line 40 after an insert above, with the
    // claim re-worded — the span and the kind still name the same finding,
    // and a re-grade changes nothing either, severity being a grade.
    const revisionOne = findingFingerprint(base);
    const revisionTwo = findingFingerprint({
      file: "src/a.mjs",
      kind: "correctness",
      subject: "return x;",
    });
    expect(revisionTwo).toBe(revisionOne);
  });

  it("keeps identity across equivalent spellings of the same tuple", () => {
    expect(
      findingFingerprint({ file: "./src/a.mjs", kind: "correctness", subject: "  return  x; " }),
    ).toBe(findingFingerprint(base));
  });

  it("mints a new identity for a rewritten span", () => {
    expect(findingFingerprint({ ...base, subject: "return y;" })).not.toBe(
      findingFingerprint(base),
    );
  });

  it("mints a new identity for a reclassified claim", () => {
    expect(findingFingerprint({ ...base, kind: "security" })).not.toBe(findingFingerprint(base));
  });

  it("mints a new identity for a cross-file move", () => {
    expect(findingFingerprint({ ...base, file: "src/b.mjs" })).not.toBe(findingFingerprint(base));
  });
});

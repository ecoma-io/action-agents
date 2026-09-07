// Tests for the cross-revision fingerprint: identity survives a moved line,
// a re-worded message and a re-grade, and dies on a rewritten span, a new
// kind or a new path. No occurrence rank exists — churn among claims that
// share a span must not shift an identity.

import { describe, expect, it } from "vitest";

import { isDigest } from "./digest.mjs";
import {
  findingFingerprint,
  findingFingerprintV1,
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

  it("keeps a long span whole — truncation is display-only, never the identity's job", () => {
    expect(normaliseSubject("x".repeat(250))).toBe("x".repeat(250));
  });

  it("keeps a long folded span whole — the fold is normalisation, the cut is gone", () => {
    expect(normaliseSubject(`${"line\n".repeat(60)}end`)).toBe("line ".repeat(60) + "end");
  });
});

describe("findingFingerprintV1 — the retired spelling, kept to verify stored records", () => {
  /** @type {{ file: string, kind: import("./vocabulary.mjs").FindingKind, subject: string }} */
  const base = { file: "src/a.mjs", kind: "correctness", subject: "return x;" };

  it("is a 64-hex content digest", () => {
    expect(isDigest(findingFingerprintV1(base))).toBe(true);
  });

  it("collapses two spans that share their first 200 characters — the defect the v2 tuple retired", () => {
    const prefix = "x".repeat(200);
    const long = prefix + "a".repeat(50);
    const twin = prefix + "b".repeat(50);
    expect(long.length).toBeGreaterThan(200);
    expect(findingFingerprintV1({ ...base, subject: long })).toBe(
      findingFingerprintV1({ ...base, subject: twin }),
    );
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

  it("distinguishes two spans that share their first 200 characters — the truncation collision v1 had", () => {
    const prefix = "x".repeat(200);
    const long = prefix + "a".repeat(50);
    const twin = prefix + "b".repeat(50);
    expect(findingFingerprint({ ...base, subject: long })).not.toBe(
      findingFingerprint({ ...base, subject: twin }),
    );
  });
});

// Tests for `harmonise` fingerprinting: sha-256 content digests and the
// canonical-JSON policy hash.
//
// What is pinned: the digests are sha-256 over UTF-8 bytes (grounded by known
// vectors); every policy input moves the hash; object key order is normalized
// away while array order is preserved — declaration order is part of the
// policy.

import { describe, expect, it } from "vitest";

import { TRANSFORMATION_VERSION, contentFingerprint, policyFingerprint } from "./fingerprint.mjs";

/** Full policy input set, varied by each sensitivity test. @returns {import("./fingerprint.mjs").PolicyInputs} */
function policy() {
  return {
    glossary: ["harmonise", "Orca"],
    instruction: "Keep headings in step.",
    languageInstructions: { vi: "Dịch giữ nguyên mã lệnh." },
    transformationVersion: TRANSFORMATION_VERSION,
  };
}

describe("TRANSFORMATION_VERSION", () => {
  it("is 1 — the first pipeline version", () => {
    expect(TRANSFORMATION_VERSION).toBe(1);
  });
});

describe("contentFingerprint", () => {
  it("produces the sha-256 hex of the UTF-8 bytes (known vectors)", () => {
    // sha256("")
    expect(contentFingerprint("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    // sha256 of the UTF-8 bytes of "héllo" — c3 a9 for é
    expect(contentFingerprint("héllo")).toBe(
      "3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179",
    );
  });

  it("is stable across calls — same text, same digest", () => {
    expect(contentFingerprint("manual/dev.md")).toBe(contentFingerprint("manual/dev.md"));
  });

  it("moves when a single character changes", () => {
    expect(contentFingerprint("manual/dev.md")).not.toBe(contentFingerprint("manual/dev.MD"));
  });

  it("distinguishes encodings — a precomposed é differs from e + combining accent", () => {
    // NFC: U+00E9 alone. NFD: "e" + U+0301 combining acute — different UTF-8
    // byte sequences, so different digests.
    expect(contentFingerprint("é")).not.toBe(contentFingerprint("e\u0301"));
  });
});

describe("policyFingerprint", () => {
  it("is stable across calls — same inputs, same digest", () => {
    expect(policyFingerprint(policy())).toBe(policyFingerprint(policy()));
  });

  it("moves when the glossary changes", () => {
    expect(policyFingerprint(policy())).not.toBe(
      policyFingerprint({ ...policy(), glossary: ["harmonise", "Orca", "loom"] }),
    );
  });

  it("moves when the instruction changes", () => {
    expect(policyFingerprint(policy())).not.toBe(
      policyFingerprint({ ...policy(), instruction: "Keep lists in step." }),
    );
  });

  it("moves when a language instruction changes", () => {
    expect(policyFingerprint(policy())).not.toBe(
      policyFingerprint({
        ...policy(),
        languageInstructions: { vi: "Giữ nguyên đường dẫn." },
      }),
    );
  });

  it("moves when the transformation version changes", () => {
    expect(policyFingerprint(policy())).not.toBe(
      policyFingerprint({ ...policy(), transformationVersion: 2 }),
    );
  });

  it("moves when the glossary is absent — an input adds to the hash even from nothing", () => {
    const bare = { transformationVersion: 1 };
    expect(policyFingerprint(bare)).not.toBe(
      policyFingerprint({ ...bare, glossary: ["harmonise"] }),
    );
  });

  it("normalizes object key insertion order — {b,a} hashes like {a,b}", () => {
    expect(
      policyFingerprint({
        glossary: ["x"],
        languageInstructions: { vi: "d", en: "c" },
        transformationVersion: 1,
      }),
    ).toBe(
      policyFingerprint({
        glossary: ["x"],
        languageInstructions: { en: "c", vi: "d" },
        transformationVersion: 1,
      }),
    );
  });

  it("preserves array order — [a,b] hashes differently from [b,a]", () => {
    expect(
      policyFingerprint({ glossary: ["harmonise", "Orca"], transformationVersion: 1 }),
    ).not.toBe(policyFingerprint({ glossary: ["Orca", "harmonise"], transformationVersion: 1 }));
  });

  it("hashes an explicit null the same as an absent field", () => {
    // @ts-expect-error exercising the canonicalization of an explicit null,
    // which the declared type does not carry but a raw config could
    expect(policyFingerprint({ instruction: null, transformationVersion: 1 })).toBe(
      policyFingerprint({ transformationVersion: 1 }),
    );
  });
});

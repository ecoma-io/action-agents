// Tests for the terminology module: deterministic compilation, masking that
// mints the same placeholder for the same configuration on every run,
// restoration that is byte-for-byte or nothing, and the post-translation
// accounting that refuses rather than repairs.
//
// The adversarial cases are the point: an entry whose shape is anything but
// the declared one is refused at compile time, text cannot collide with the
// tokens masking would mint, and every way an output can fail the accounting
// — a lost occurrence, an added one, a residual placeholder, a forbidden
// rendering — is named as a violation, never coerced into a pass.

import { describe, expect, it } from "vitest";

import { checkTermConsistency, compileTermBase, maskTerms, unmaskTerms } from "./terms.mjs";

const KUBERNETES_TOKEN = "[[harmonise:9a66e6edaaaf6b4d:g1]]";

/** @param {unknown[]} entries @param {string} lang @returns {ReturnType<typeof compileTermBase>} */
function compile(entries, lang = "en") {
  return compileTermBase(entries, lang);
}

describe("compileTermBase", () => {
  it("mints the placeholder the documented derivation predicts", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    expect(base.lang).toBe("en");
    expect(base.entries).toHaveLength(1);
    const entry = base.entries[0];
    expect(entry?.term).toBe("Kubernetes");
    expect(entry?.rendering).toBe("Kubernetes");
    expect(entry?.forbidden).toEqual([]);
    expect(entry?.g).toBe(1);
    expect(entry?.token).toBe(KUBERNETES_TOKEN);
  });

  it("mints the same placeholder for the same configuration on every compile", () => {
    const entries = [{ term: "Kubernetes", translations: { en: "Kubernetes", de: "Kubernetes" } }];
    expect(compile(entries, "en").entries[0]?.token).toBe(compile(entries, "en").entries[0]?.token);
  });

  it("mints different placeholders for different languages and renderings", () => {
    const single = [
      { term: "Kubernetes", translations: { en: "Kubernetes", de: "Kubernetes-Cluster" } },
    ];
    const en = compile(single, "en").entries[0]?.token ?? "";
    const de = compile(single, "de").entries[0]?.token ?? "";
    expect(en).not.toBe(de);
    expect(de).toMatch(/^\[\[harmonise:[0-9a-f]{16}:g1\]\]$/);
  });

  it("numbers entries by configuration position", () => {
    const base = compile([
      { term: "Kubernetes", translations: { en: "Kubernetes" } },
      { term: "C++", translations: { en: "C++" } },
    ]);
    expect(base.entries.map((entry) => entry.g)).toEqual([1, 2]);
    expect(base.entries[1]?.token).toMatch(/:g2\]\]$/);
  });

  it("accepts a forbidden variant equal to the term when the rendering differs", () => {
    const base = compile([
      { term: "K8s", translations: { en: "Kubernetes" }, forbidden: ["K8s", "k8s"] },
    ]);
    expect(base.entries[0]?.forbidden).toEqual(["K8s", "k8s"]);
  });

  it("refuses entries that are not an array", () => {
    expect(() => compileTermBase("Kubernetes", "en")).toThrow(/must be an array/);
    expect(() => compileTermBase(undefined, "en")).toThrow(/must be an array/);
  });

  it("refuses a language that is not a non-empty string", () => {
    expect(() => compile([], "")).toThrow(/non-empty string/);
    expect(() => compile([], /** @type {any} */ (42))).toThrow(/non-empty string/);
  });

  it("refuses an entry that is not an object of the declared shape", () => {
    expect(() => compile([null])).toThrow(/shaped \{ term, translations, forbidden\? \}/);
    expect(() => compile(["Kubernetes"])).toThrow(/shaped \{ term, translations, forbidden\? \}/);
    expect(() => compile([["Kubernetes"]])).toThrow(/shaped \{ term, translations, forbidden\? \}/);
  });

  it("refuses an entry carrying an unknown key", () => {
    expect(() =>
      compile([{ term: "Kubernetes", translations: { en: "Kubernetes" }, policy: "strict" }]),
    ).toThrow(/do not accept the key 'policy'/);
  });

  it("refuses a term that is empty or not a string", () => {
    expect(() => compile([{ term: "", translations: { en: "Kubernetes" } }])).toThrow(
      /non-empty string term/,
    );
    expect(() => compile([{ term: 7, translations: { en: "Kubernetes" } }])).toThrow(
      /non-empty string term/,
    );
  });

  it("refuses translations that are not an object", () => {
    expect(() => compile([{ term: "Kubernetes", translations: "Kubernetes" }])).toThrow(
      /translations object/,
    );
    expect(() => compile([{ term: "Kubernetes", translations: null }])).toThrow(
      /translations object/,
    );
    expect(() => compile([{ term: "Kubernetes", translations: ["Kubernetes"] }])).toThrow(
      /translations object/,
    );
  });

  it("refuses a rendering that is empty or not a string, for any declared language", () => {
    expect(() => compile([{ term: "Kubernetes", translations: { en: "" } }])).toThrow(
      /empty or non-string rendering for language 'en'/,
    );
    expect(() =>
      compile([{ term: "Kubernetes", translations: { en: "Kubernetes", de: "" } }]),
    ).toThrow(/empty or non-string rendering for language 'de'/);
    expect(() => compile([{ term: "Kubernetes", translations: { en: 3 } }])).toThrow(
      /non-string rendering/,
    );
  });

  it("refuses the compiled language having no rendering", () => {
    expect(() =>
      compile([{ term: "Kubernetes", translations: { de: "Kubernetes" } }], "en"),
    ).toThrow(/no approved rendering for language 'en'/);
  });

  it("refuses a duplicate term", () => {
    const entry = { term: "Kubernetes", translations: { en: "Kubernetes" } };
    expect(() => compile([entry, { ...entry }])).toThrow(/configured twice/);
  });

  it("refuses forbidden variants that are not an array of distinct non-empty strings", () => {
    const term = "Kubernetes";
    const translations = { en: "Kubernetes" };
    expect(() => compile([{ term, translations, forbidden: "K8s" }])).toThrow(/not an array/);
    expect(() => compile([{ term, translations, forbidden: [""] }])).toThrow(
      /not a non-empty string/,
    );
    expect(() => compile([{ term, translations, forbidden: [7] }])).toThrow(
      /not a non-empty string/,
    );
    expect(() => compile([{ term, translations, forbidden: ["K8s", "K8s"] }])).toThrow(/twice/);
  });

  it("refuses a forbidden variant equal to the approved rendering", () => {
    expect(() =>
      compile([
        { term: "Kubernetes", translations: { en: "Kubernetes" }, forbidden: ["Kubernetes"] },
      ]),
    ).toThrow(/forbids 'Kubernetes', which is its own approved rendering/);
  });
});

describe("maskTerms", () => {
  it("replaces one occurrence with the entry's deterministic token", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const mask = maskTerms("Kubernetes runs the cluster.", base);
    expect(mask.text).toBe(`${KUBERNETES_TOKEN} runs the cluster.`);
    expect(mask.edits).toBe(1);
    expect(mask.spans.get(KUBERNETES_TOKEN)).toBe("Kubernetes");
    expect(mask.counts.get(KUBERNETES_TOKEN)).toBe(1);
  });

  it("uses one token per entry across repeated occurrences", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const mask = maskTerms("Kubernetes here, Kubernetes there.", base);
    expect(mask.text).toBe(`${KUBERNETES_TOKEN} here, ${KUBERNETES_TOKEN} there.`);
    expect(mask.counts.get(KUBERNETES_TOKEN)).toBe(2);
    expect(mask.edits).toBe(2);
  });

  it("matches case-sensitively and leaves other casings alone", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const mask = maskTerms("kubernetes and KUBERNETES stay.", base);
    expect(mask.text).toBe("kubernetes and KUBERNETES stay.");
    expect(mask.edits).toBe(0);
  });

  it("prefers the longest rendering where renderings share a prefix", () => {
    const base = compile([
      { term: "Kubernetes", translations: { en: "Kubernetes" } },
      { term: "Kubernetes Cluster", translations: { en: "Kubernetes Cluster" } },
    ]);
    const mask = maskTerms("the Kubernetes Cluster and Kubernetes", base);
    expect(mask.text).toMatch(
      /^the \[\[harmonise:[0-9a-f]{16}:g2\]\] and \[\[harmonise:[0-9a-f]{16}:g1\]\]$/,
    );
    expect(mask.edits).toBe(2);
  });

  it("matches beside punctuation but never inside a longer word", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const mask = maskTerms("Kubernetes-based, (Kubernetes), myKubernetes and Kubernetes_v2.", base);
    expect(mask.text).toBe(
      `${KUBERNETES_TOKEN}-based, (${KUBERNETES_TOKEN}), myKubernetes and Kubernetes_v2.`,
    );
    expect(mask.edits).toBe(2);
  });

  it("matches a regex-special rendering literally", () => {
    const base = compile([{ term: "C++", translations: { en: "C++" } }]);
    const mask = maskTerms("C++ and C++Builder differ.", base);
    expect(mask.text).toBe("[[harmonise:08f0c31ff63a83a1:g1]] and C++Builder differ.");
    expect(mask.edits).toBe(1);
  });

  it("is byte-for-byte deterministic for the same input", () => {
    const base = compile([
      { term: "Kubernetes", translations: { en: "Kubernetes" } },
      { term: "C++", translations: { en: "C++" } },
    ]);
    const source = "Kubernetes and C++ and Kubernetes again.";
    const first = maskTerms(source, base);
    const second = maskTerms(source, base);
    expect(first.text).toBe(second.text);
    expect(first.edits).toBe(second.edits);
    expect([...first.spans]).toEqual([...second.spans]);
    expect([...first.counts]).toEqual([...second.counts]);
  });

  it("refuses text that already contains a placeholder masking would mint", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    expect(() => maskTerms(`already ${KUBERNETES_TOKEN} here`, base)).toThrow(/already contains/);
  });

  it("leaves another layer's placeholder untouched and reports nothing itself", () => {
    const base = compile([{ term: "G1", translations: { en: "g1" } }]);
    const foreign = "[[harmonise:ffffffffffffffff:g1]]";
    const mask = maskTerms(`kept ${foreign} verbatim`, base);
    expect(mask.text).toBe(`kept ${foreign} verbatim`);
    expect(mask.edits).toBe(0);
    expect(unmaskTerms(mask.text, mask).violations).toHaveLength(1);
  });

  it("passes text through untouched when the base has no entries", () => {
    const mask = maskTerms("nothing is protected", compile([]));
    expect(mask.text).toBe("nothing is protected");
    expect(mask.edits).toBe(0);
    expect(mask.spans.size).toBe(0);
    expect(mask.counts.size).toBe(0);
  });

  it("refuses input that is not a string", () => {
    expect(() => maskTerms(undefined, compile([]))).toThrow(/must be a string/);
  });

  it("refuses a term base that was not compiled", () => {
    expect(() => maskTerms("text", /** @type {any} */ ({ lang: "en", entries: "no" }))).toThrow(
      /malformed/,
    );
  });
  it("refuses a term base that is not an object", () => {
    expect(() => maskTerms("text", /** @type {any} */ (null))).toThrow(
      "the term base must be the object compileTermBase returned",
    );
  });

  it("refuses a term base holding a malformed entry", () => {
    expect(() =>
      maskTerms("text", /** @type {any} */ ({ lang: "en", entries: [{ term: 7 }] })),
    ).toThrow("the term base holds a malformed entry — compile it with compileTermBase");
  });
});

describe("unmaskTerms", () => {
  it("restores byte-identical originals and reports nothing", () => {
    const base = compile([
      { term: "Kubernetes", translations: { en: "Kubernetes" } },
      { term: "C++", translations: { en: "C++" } },
    ]);
    const source = "Kubernetes beats C++ here.";
    const mask = maskTerms(source, base);
    const outcome = unmaskTerms(mask.text, mask);
    expect(outcome.text).toBe(source);
    expect(outcome.violations).toEqual([]);
  });

  it("reports a placeholder this run never minted and leaves it verbatim", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const mask = maskTerms("Kubernetes stays.", base);
    const forged = `${mask.text} [[harmonise:00000000000000ff:g9]]`;
    const outcome = unmaskTerms(forged, mask);
    expect(outcome.text).toBe("Kubernetes stays. [[harmonise:00000000000000ff:g9]]");
    expect(outcome.violations).toEqual([
      "the output contains '[[harmonise:00000000000000ff:g9]]', which this run never minted — left in place, reported",
    ]);
  });

  it("names a re-cased placeholder as unknown rather than accepting it", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const mask = maskTerms("Kubernetes stays.", base);
    const reCased = mask.text.toUpperCase();
    const outcome = unmaskTerms(reCased, mask);
    expect(outcome.text).toBe(reCased);
    expect(outcome.violations[0]).toMatch(/never minted/);
  });

  it("reports a placeholder the output duplicates, and replaces every occurrence", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const mask = maskTerms("Kubernetes once.", base);
    const duplicated = `${mask.text} and ${mask.text.slice(0, mask.text.indexOf(" once."))}`;
    const outcome = unmaskTerms(duplicated, mask);
    expect(outcome.text).toBe("Kubernetes once. and Kubernetes");
    expect(outcome.violations).toEqual([
      `placeholder '${KUBERNETES_TOKEN}' appears 2 times but masking minted 1 — the output duplicates it`,
    ]);
  });

  it("leaves a minted-but-absent placeholder to the consistency check, not an error", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const mask = maskTerms("Kubernetes once.", base);
    const outcome = unmaskTerms("the model dropped it", mask);
    expect(outcome.text).toBe("the model dropped it");
    expect(outcome.violations).toEqual([]);
  });

  it("refuses input that is not a string", () => {
    const mask = maskTerms(
      "Kubernetes.",
      compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]),
    );
    expect(() => unmaskTerms(42, mask)).toThrow(/must be a string/);
  });

  it("refuses a mask that was not built by maskTerms", () => {
    expect(() => unmaskTerms("text", /** @type {any} */ ({}))).toThrow(/malformed/);
  });
  it("refuses a mask that is not an object", () => {
    expect(() => unmaskTerms("text", /** @type {any} */ (null))).toThrow(
      "the mask must be the object maskTerms returned",
    );
  });
});

describe("checkTermConsistency", () => {
  /** @returns {{ base: ReturnType<typeof compileTermBase>, source: string, mask: ReturnType<typeof maskTerms> }} */
  function masked() {
    const base = compile([
      { term: "Kubernetes", translations: { en: "Kubernetes" } },
      { term: "C++", translations: { en: "C++" } },
    ]);
    const source = "Kubernetes beats C++ twice: Kubernetes, C++.";
    return { base, source, mask: maskTerms(source, base) };
  }

  it("passes a faithful translation through all three counts", () => {
    const { base, mask } = masked();
    const outcome = checkTermConsistency(
      "Kubernetes beats C++ twice: Kubernetes, C++.",
      base,
      mask,
    );
    expect(outcome).toEqual({ ok: true, violations: [] });
  });

  it("refuses a lost occurrence", () => {
    const { base, mask } = masked();
    const outcome = checkTermConsistency("Kubernetes beats C++ twice: C++.", base, mask);
    expect(outcome.ok).toBe(false);
    expect(outcome.violations).toEqual(["'Kubernetes' occurs 1 time in the output, expected 2"]);
  });

  it("refuses an added occurrence", () => {
    const { base, mask } = masked();
    const outcome = checkTermConsistency(
      "Kubernetes beats C++ twice: Kubernetes, C++, C++.",
      base,
      mask,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.violations).toEqual([
      "'C++' occurs 3 times in the output, expected 2 — an occurrence was added",
    ]);
  });

  it("refuses an original that vanished entirely", () => {
    const { base, mask } = masked();
    const outcome = checkTermConsistency("nothing survived", base, mask);
    expect(outcome.ok).toBe(false);
    expect(outcome.violations).toEqual([
      "'Kubernetes' occurs 0 times in the output, expected 2 — a masked occurrence was lost",
      "'C++' occurs 0 times in the output, expected 2 — a masked occurrence was lost",
    ]);
  });

  it("refuses a residual well-formed placeholder", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const mask = maskTerms("Kubernetes.", base);
    const outcome = checkTermConsistency(`Kubernetes. ${KUBERNETES_TOKEN}`, base, mask);
    expect(outcome.ok).toBe(false);
    expect(outcome.violations).toEqual([
      "1 residual placeholder fragment starting '[[harmonise:' remains in the output",
    ]);
  });

  it("refuses a residual half-erased placeholder fragment", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const mask = maskTerms("Kubernetes.", base);
    const outcome = checkTermConsistency("Kubernetes. [[harmonise:zz", base, mask);
    expect(outcome.ok).toBe(false);
    expect(outcome.violations[0]).toMatch(/residual placeholder/);
  });

  it("refuses a forbidden variant as a word", () => {
    const base = compile([
      { term: "Kubernetes", translations: { en: "Kubernetes" }, forbidden: ["k8s"] },
    ]);
    const mask = maskTerms("Kubernetes runs.", base);
    const outcome = checkTermConsistency("Kubernetes runs, but k8s leaked.", base, mask);
    expect(outcome.ok).toBe(false);
    expect(outcome.violations).toEqual([
      "'k8s' is a forbidden rendering of term 'Kubernetes' and occurs 1 time in the output",
    ]);
  });

  it("does not flag a forbidden variant embedded in a longer word", () => {
    const base = compile([
      { term: "Kubernetes", translations: { en: "Kubernetes" }, forbidden: ["api"] },
    ]);
    const mask = maskTerms("Kubernetes runs.", base);
    expect(checkTermConsistency("Kubernetes runs rapidly.", base, mask)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("accounts aggregate when two entries share a rendering", () => {
    const base = compile([
      { term: "Kubernetes", translations: { en: "Kubernetes" } },
      { term: "kubernetes upstream", translations: { en: "Kubernetes" } },
    ]);
    const mask = maskTerms("Kubernetes and Kubernetes.", base);
    expect(mask.counts.get(base.entries[0]?.token ?? "")).toBe(2);
    expect(checkTermConsistency("Kubernetes and Kubernetes.", base, mask)).toEqual({
      ok: true,
      violations: [],
    });
    expect(checkTermConsistency("Kubernetes only.", base, mask).ok).toBe(false);
  });

  it("refuses input that is not a string", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const mask = maskTerms("Kubernetes.", base);
    expect(() => checkTermConsistency(null, base, mask)).toThrow(/must be a string/);
  });
});

describe("round trip", () => {
  it("mask, translate, unmask and check agree on a faithful output", () => {
    const base = compile(
      [
        { term: "Kubernetes", translations: { de: "Kubernetes" }, forbidden: ["K8s", "k8s"] },
        { term: "C++", translations: { de: "C++" } },
      ],
      "de",
    );
    const source = "Kubernetes und C++ bleiben Kubernetes und C++.";
    const mask = maskTerms(source, base);
    const translated = "Kubernetes bleibt C++."; // the model kept both placeholders
    const restored = unmaskTerms(translated, mask);
    const checked = checkTermConsistency(restored.text, base, mask);
    expect(restored.text).toBe("Kubernetes bleibt C++.");
    expect(restored.violations).toEqual([]);
    expect(checked.ok).toBe(false); // the source masked four occurrences, the output kept two
    expect(checked.violations).toHaveLength(2);
  });

  it("masks deterministically across two runs of the same pipeline", () => {
    const base = compile([{ term: "Kubernetes", translations: { en: "Kubernetes" } }]);
    const source = "Kubernetes, Kubernetes.";
    const first = maskTerms(source, base);
    const second = maskTerms(source, base);
    expect(unmaskTerms(first.text, first).text).toBe(source);
    expect(unmaskTerms(second.text, second).text).toBe(source);
    expect(first.text).toBe(second.text);
  });
});

// Tests for the harmonise run record — the pure module. The builder is proven
// byte-deterministic and fail-closed, the outcome vocabulary is pinned to the
// run contract's own words, the pairs accounting is proven to partition the
// selected schedule — `selected` recorded and the four counts refused when
// they do not total it — and the filename rule is proven to land inside the
// upload glob.

import { describe, expect, it } from "vitest";

import {
  HARMONISE_OUTCOMES,
  REASON_CHARS,
  buildHarmoniseRecord,
  harmoniseRecordFilename,
  harmoniseRecordSchemaVersion,
  serialiseHarmoniseRecord,
  validateHarmoniseRecord,
} from "./run-record.mjs";

const SHA = "a".repeat(40);

/**
 * @param {Partial<Parameters<typeof buildHarmoniseRecord>[0]>} [over]
 * @returns {import("./run-record.mjs").HarmoniseRecord}
 */
function recordFixture(over = {}) {
  return buildHarmoniseRecord({
    repository: "octocat/example",
    eventName: "workflow_dispatch",
    sourceLanguage: "en",
    dryRun: false,
    outcome: "published",
    reason: "opened pull request #42 (harmonise/vi → main)",
    pairs: { selected: 6, proposed: 3, unchanged: 1, skipped: 2, failed: 0 },
    pullRequest: { number: 42, created: true },
    headSha: SHA,
    ...over,
  });
}

/**
 * A mutable copy of a valid record, for validator refusal tests: the built
 * record is frozen, so the clone is what gets malformed.
 *
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, unknown>}
 */
function cloneFixture(over = {}) {
  return { ...JSON.parse(JSON.stringify(recordFixture())), ...over };
}

describe("buildHarmoniseRecord", () => {
  it("builds the expected record from valid run facts", () => {
    expect(recordFixture()).toEqual({
      schemaVersion: 3,
      repository: "octocat/example",
      eventName: "workflow_dispatch",
      sourceLanguage: "en",
      dryRun: false,
      outcome: "published",
      reason: "opened pull request #42 (harmonise/vi → main)",
      pairs: { selected: 6, proposed: 3, unchanged: 1, skipped: 2, failed: 0 },
      pullRequest: { number: 42, created: true },
      headSha: SHA,
    });
  });

  it("carries the honest null when the run wrote no pull request", () => {
    const record = recordFixture({ outcome: "skip", pullRequest: null, dryRun: true });
    expect(record.pullRequest).toBeNull();
    expect(() => validateHarmoniseRecord(record)).not.toThrow();
  });
  it("carries the honest nulls of a red run that died before its facts (#344)", () => {
    const record = recordFixture({
      outcome: "failed",
      reason: "every pair failed: vi manual/dev.md: the model refused",
      pairs: null,
      headSha: null,
      pullRequest: null,
    });
    expect(record.pairs).toBeNull();
    expect(record.headSha).toBeNull();
    expect(() => validateHarmoniseRecord(record)).not.toThrow();
    expect(Object.isFrozen(record)).toBe(true);
  });
  it("caps an astral-plane reason by UTF-16 length — the validator's own metric (#347)", () => {
    // 200 emoji are 200 code points but 400 UTF-16 units: a cap that counted
    // code points passed the reason whole and the validator refused it —
    // the red run left no record at all.
    const record = recordFixture({
      outcome: "failed",
      reason: "\u{1F600}".repeat(200),
      pullRequest: null,
    });
    expect(record.reason.length).toBe(REASON_CHARS);
    expect(record.reason.endsWith("…[truncated]")).toBe(true);
  });

  it("caps an astral reason the code-point count would have passed untouched (#347)", () => {
    // 177 emoji: 177 code points — under the cap, so uncapped — but 354
    // UTF-16 units, over the validator's bound. The mismatch threw with no
    // truncation note anywhere.
    const record = recordFixture({ reason: "\u{1F600}".repeat(177) });
    expect(record.reason.length).toBe(REASON_CHARS);
    expect(record.reason.endsWith("…[truncated]")).toBe(true);
  });

  it("keeps an exactly-at-bound astral reason without a cut", () => {
    const record = recordFixture({ reason: "\u{1F600}".repeat(150) });
    expect(record.reason).toBe("\u{1F600}".repeat(150));
  });

  it("carries an updated pull request without pretending it was created", () => {
    const record = recordFixture({
      pullRequest: { number: 42, created: false },
      reason: "updated pull request #42 in place (harmonise/vi → main)",
    });
    expect(record.pullRequest).toEqual({ number: 42, created: false });
  });

  it("is frozen — the code's record is not mutable by a consumer", () => {
    expect(Object.isFrozen(recordFixture())).toBe(true);
    expect(Object.isFrozen(recordFixture().pairs)).toBe(true);
  });

  it("serialises to byte-identical JSON across two builds — no wall-clock anywhere", () => {
    expect(serialiseHarmoniseRecord(recordFixture())).toBe(
      serialiseHarmoniseRecord(recordFixture()),
    );
  });

  it("serialises with the keys sorted, compact and without a trailing newline", () => {
    const bytes = serialiseHarmoniseRecord(recordFixture());
    expect(bytes.startsWith('{"dryRun"')).toBe(true);
    // Compact: no whitespace between tokens — the only spaces are the ones
    // inside the strings themselves.
    expect(bytes).not.toMatch(/": /);
    expect(bytes).not.toMatch(/, /);
    expect(bytes).not.toMatch(/\n$/);
    expect(JSON.parse(bytes)).toStrictEqual(recordFixture());
  });

  it("serialises a key-shuffled equivalent identically — the bytes do not depend on insertion order", () => {
    const shuffled = {
      headSha: SHA,
      pullRequest: { created: true, number: 42 },
      pairs: { failed: 0, skipped: 2, unchanged: 1, proposed: 3, selected: 6 },
      reason: "opened pull request #42 (harmonise/vi → main)",
      outcome: "published",
      dryRun: false,
      sourceLanguage: "en",
      eventName: "workflow_dispatch",
      repository: "octocat/example",
      schemaVersion: 3,
    };
    expect(serialiseHarmoniseRecord(validateHarmoniseRecord(shuffled))).toBe(
      serialiseHarmoniseRecord(recordFixture()),
    );
  });
});

describe("validateHarmoniseRecord", () => {
  it("accepts the record the builder built", () => {
    expect(() => validateHarmoniseRecord(recordFixture())).not.toThrow();
  });

  it("refuses an unknown top-level key", () => {
    expect(() => validateHarmoniseRecord(cloneFixture({ model: "harmonise" }))).toThrow(
      /unknown key 'model'/,
    );
  });

  it("refuses a missing mandatory key", () => {
    const missing = cloneFixture();
    delete missing["pairs"];
    expect(() => validateHarmoniseRecord(missing)).toThrow(/missing 'pairs'/);
  });

  it("refuses a wrong schemaVersion", () => {
    expect(() => validateHarmoniseRecord(cloneFixture({ schemaVersion: 4 }))).toThrow(
      /schemaVersion is not 3/,
    );
  });

  it("refuses the version-1 record the partition superseded — the released shape is named and refused", () => {
    const v1 = cloneFixture();
    v1["schemaVersion"] = 1;
    v1["pairs"] = { proposed: 3, unchanged: 1, skipped: 2, failed: 0 };
    expect(() => validateHarmoniseRecord(v1)).toThrow(/schemaVersion is not 3/);
  });

  it("refuses an outcome outside the run contract's terminal states", () => {
    expect(() => validateHarmoniseRecord(cloneFixture({ outcome: "dry-run" }))).toThrow(
      /outside the run contract's terminal states/,
    );
    expect(() => validateHarmoniseRecord(cloneFixture({ outcome: "abandoned" }))).toThrow(
      /outside the run contract's terminal states/,
    );
  });

  it("refuses a head sha that is not 40 hex — a branch name is not a pin", () => {
    expect(() => validateHarmoniseRecord(cloneFixture({ headSha: "main" }))).toThrow(/headSha/);
    expect(() => validateHarmoniseRecord(cloneFixture({ headSha: SHA.toUpperCase() }))).toThrow(
      /headSha/,
    );
  });
  it("accepts the red record's nulls, and nothing looser (#344)", () => {
    // `null` is the one shape a red run may carry in their place: a run
    // that died before pinning a base or finalising its accounting. A
    // present-but-garbage value is still refused exactly as before.
    expect(() =>
      validateHarmoniseRecord(cloneFixture({ outcome: "failed", pairs: null, headSha: null })),
    ).not.toThrow();
    expect(() =>
      validateHarmoniseRecord(cloneFixture({ outcome: "refused", pairs: null, headSha: null })),
    ).not.toThrow();
    expect(() => validateHarmoniseRecord(cloneFixture({ headSha: "abc" }))).toThrow(/headSha/);
    expect(() =>
      validateHarmoniseRecord(cloneFixture({ pairs: { selected: 2, proposed: 1 } })),
    ).toThrow(/missing 'unchanged'/);
  });

  it("refuses a pairs block that is not five non-negative integers", () => {
    expect(() =>
      validateHarmoniseRecord(
        cloneFixture({ pairs: { selected: 6, proposed: -1, unchanged: 0, skipped: 0, failed: 0 } }),
      ),
    ).toThrow(/pairs.proposed/);
    expect(() =>
      validateHarmoniseRecord(
        cloneFixture({
          pairs: { selected: 6, proposed: 1.5, unchanged: 0, skipped: 0, failed: 0 },
        }),
      ),
    ).toThrow(/pairs.proposed/);
    expect(() =>
      validateHarmoniseRecord(
        cloneFixture({ pairs: { selected: -1, proposed: 3, unchanged: 1, skipped: 2, failed: 0 } }),
      ),
    ).toThrow(/pairs.selected/);
    const extra = cloneFixture();
    extra["pairs"] = { .../** @type {any} */ (extra["pairs"]), total: 6 };
    expect(() => validateHarmoniseRecord(extra)).toThrow(/unknown key 'total'/);
  });

  it("refuses a pairs block missing 'selected' — the partition's other side is mandatory", () => {
    const missing = cloneFixture();
    delete (/** @type {any} */ (missing["pairs"])["selected"]);
    expect(() => validateHarmoniseRecord(missing)).toThrow(/missing 'selected'/);
  });

  it("refuses a pairs block whose four counts do not partition the selected schedule", () => {
    // Over-count: the four total 6 against a selected of 5.
    expect(() =>
      validateHarmoniseRecord(
        cloneFixture({ pairs: { selected: 5, proposed: 3, unchanged: 1, skipped: 2, failed: 0 } }),
      ),
    ).toThrow(
      /pairs' does not partition the selected schedule: proposed \+ unchanged \+ skipped \+ failed is 6, 'selected' is 5/,
    );
    // Under-count: the same four total 6 against a selected of 7.
    expect(() =>
      validateHarmoniseRecord(
        cloneFixture({ pairs: { selected: 7, proposed: 3, unchanged: 1, skipped: 2, failed: 0 } }),
      ),
    ).toThrow(
      /pairs' does not partition the selected schedule: proposed \+ unchanged \+ skipped \+ failed is 6, 'selected' is 7/,
    );
  });

  it("accepts the empty partition — nothing selected, nothing in any bucket", () => {
    expect(() =>
      validateHarmoniseRecord(
        cloneFixture({ pairs: { selected: 0, proposed: 0, unchanged: 0, skipped: 0, failed: 0 } }),
      ),
    ).not.toThrow();
  });

  it("refuses a pull request that is neither null nor the exact two-key shape", () => {
    expect(() => validateHarmoniseRecord(cloneFixture({ pullRequest: { number: 42 } }))).toThrow(
      /missing 'created'/,
    );
    expect(() =>
      validateHarmoniseRecord(cloneFixture({ pullRequest: { number: 0, created: true } })),
    ).toThrow(/pullRequest.number/);
    expect(() =>
      validateHarmoniseRecord(cloneFixture({ pullRequest: { number: 42, created: "yes" } })),
    ).toThrow(/pullRequest.created/);
    expect(() => validateHarmoniseRecord(cloneFixture({ pullRequest: 42 }))).toThrow(/pullRequest/);
  });

  it("refuses empty text and a non-boolean dry run", () => {
    expect(() => validateHarmoniseRecord(cloneFixture({ repository: "" }))).toThrow(/repository/);
    expect(() => validateHarmoniseRecord(cloneFixture({ dryRun: "false" }))).toThrow(/dryRun/);
  });

  it("refuses to serialise a shape it did not build", () => {
    expect(() => serialiseHarmoniseRecord(/** @type {any} */ ({}))).toThrow(TypeError);
    expect(() =>
      serialiseHarmoniseRecord(/** @type {any} */ (cloneFixture({ extra: true }))),
    ).toThrow(TypeError);
  });
});

describe("harmoniseRecordFilename", () => {
  it("names a record after the base commit the run pinned to", () => {
    expect(harmoniseRecordFilename(recordFixture())).toBe(`harmonise-record-${SHA}.json`);
  });
  it("names a run that died before pinning a base, still inside the upload glob", () => {
    const name = harmoniseRecordFilename(
      recordFixture({ outcome: "failed", pairs: null, headSha: null }),
    );
    expect(name).toBe("harmonise-record-no-base.json");
    expect(/^harmonise-record-.+\.json$/.test(name)).toBe(true);
    // Never a collision with a pinned run's 40-hex name.
    expect(name).not.toMatch(/^harmonise-record-[0-9a-f]{40}\.json$/);
  });

  it("keeps every name inside the workflow's upload glob", () => {
    for (const outcome of HARMONISE_OUTCOMES) {
      const name = harmoniseRecordFilename(recordFixture({ outcome }));
      expect(/^harmonise-record-[0-9a-f]{40}\.json$/.test(name)).toBe(true);
    }
  });
});

describe("the record's vocabulary", () => {
  it("carries the five terminal states harmonise reaches, whole and in the contract's order", () => {
    expect(HARMONISE_OUTCOMES).toEqual(["published", "partial", "refused", "failed", "skip"]);
  });

  it("pins the schema version the docs state", () => {
    expect(harmoniseRecordSchemaVersion).toBe(3);
  });
});

describe("the record's reason boundary", () => {
  // The reason is the one record field whose provenance is not purely
  // code-owned — the publication path interpolates the repository's default
  // branch name — so it passes the sanitiser at the build site under a
  // declared cap, and the validator refuses an over-cap value. The
  // assertions are on the record's bytes; what the sanitiser bit off is the
  // run log's business.

  it("caps an over-limit reason at the build site, visibly", () => {
    const record = recordFixture({ reason: "x".repeat(400) });
    expect(record.reason.length).toBeLessThanOrEqual(REASON_CHARS);
    expect(record.reason.endsWith("…[truncated]")).toBe(true);
  });

  it("keeps adversarial fragments out of the record: no structure, no mention, one line", () => {
    // The control character is minted, not typed — a literal one in the
    // source would be the very byte this test refuses in the record.
    const control = String.fromCharCode(0x0b);
    const record = recordFixture({
      reason: `<script>alert(1)</script> <!-- comment --> @mention\ttabbed\nline${control}`,
    });
    // The sanitiser's guarantees, exactly: structural tokens removed, the
    // tag-shaped `<` escaped, the mention broken with the zero-width
    // non-joiner, and the whitespace family — tab, newline, the vertical
    // tab — collapsed to single spaces by the one-line pass.
    expect(record.reason).toBe("&lt;script>alert(1)&lt;/script>  comment  @‌mention tabbed line");
    expect(record.reason).not.toContain("\n");
    expect(record.reason).not.toContain("\t");
    for (const char of record.reason) {
      const code = char.codePointAt(0) ?? 0;
      expect(code <= 0x1f || code === 0x7f).toBe(false);
    }
    expect(record.reason).not.toContain("<script>");
    expect(record.reason).not.toContain("<!--");
    expect(record.reason).toContain("@‌mention");
  });

  it("strips the non-whitespace control characters the one-line collapse cannot reach (#361)", () => {
    // Minted, not typed: a literal control byte in the source would be the
    // very byte this test refuses in the record. ESC, BEL and BS ride model
    // answers and source filenames, and none of them — nor DEL — is
    // whitespace, so the one-line collapse alone leaves them standing; the
    // strip rule at this boundary is what removes them.
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const bs = String.fromCharCode(0x08);
    const del = String.fromCharCode(0x7f);
    const record = recordFixture({
      reason: `refused${bel}while${esc}[31mred${bs}flag${del}end`,
    });
    // Each stripped byte became a space and the collapse tightened the run;
    // the visible fragments survive in order.
    expect(record.reason).toBe("refused while [31mred flag end");
    for (const char of record.reason) {
      const code = char.codePointAt(0) ?? 0;
      expect(code <= 0x1f || code === 0x7f).toBe(false);
    }
  });

  it("takes a reason at the cap and refuses one past it", () => {
    expect(() =>
      validateHarmoniseRecord(cloneFixture({ reason: "x".repeat(REASON_CHARS) })),
    ).not.toThrow();
    expect(() =>
      validateHarmoniseRecord(cloneFixture({ reason: "x".repeat(REASON_CHARS + 1) })),
    ).toThrow(/exceeds its 300-character cap/u);
  });

  it("refuses a reason that is not a string", () => {
    expect(() => validateHarmoniseRecord(cloneFixture({ reason: 7 }))).toThrow(
      /'reason' is not a string/u,
    );
  });

  it("leaves the real composed sentences byte-for-byte — the sanitiser has nothing to bite", () => {
    expect(recordFixture().reason).toBe("opened pull request #42 (harmonise/vi → main)");
    expect(
      recordFixture({ reason: "updated pull request #42 in place (harmonise/vi → main)" }).reason,
    ).toBe("updated pull request #42 in place (harmonise/vi → main)");
  });

  it("same run facts build the same bytes at the reason boundary", () => {
    const reason = "x".repeat(REASON_CHARS);
    const bytes = serialiseHarmoniseRecord(recordFixture({ reason }));
    expect(bytes).toBe(serialiseHarmoniseRecord(recordFixture({ reason })));
    expect(JSON.parse(bytes)).toStrictEqual(recordFixture({ reason }));
  });
});

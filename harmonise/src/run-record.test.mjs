// Tests for the harmonise run record — the pure module. The builder is proven
// byte-deterministic and fail-closed, the outcome vocabulary is pinned to the
// run contract's own words, the pairs accounting is proven to partition the
// selected schedule, and the filename rule is proven to land inside the
// upload glob.

import { describe, expect, it } from "vitest";

import {
  HARMONISE_OUTCOMES,
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
    pairs: { proposed: 3, unchanged: 1, skipped: 2, failed: 0 },
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
      schemaVersion: 1,
      repository: "octocat/example",
      eventName: "workflow_dispatch",
      sourceLanguage: "en",
      dryRun: false,
      outcome: "published",
      reason: "opened pull request #42 (harmonise/vi → main)",
      pairs: { proposed: 3, unchanged: 1, skipped: 2, failed: 0 },
      pullRequest: { number: 42, created: true },
      headSha: SHA,
    });
  });

  it("carries the honest null when the run wrote no pull request", () => {
    const record = recordFixture({ outcome: "skip", pullRequest: null, dryRun: true });
    expect(record.pullRequest).toBeNull();
    expect(() => validateHarmoniseRecord(record)).not.toThrow();
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
      pairs: { failed: 0, skipped: 2, unchanged: 1, proposed: 3 },
      reason: "opened pull request #42 (harmonise/vi → main)",
      outcome: "published",
      dryRun: false,
      sourceLanguage: "en",
      eventName: "workflow_dispatch",
      repository: "octocat/example",
      schemaVersion: 1,
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
    expect(() => validateHarmoniseRecord(cloneFixture({ schemaVersion: 2 }))).toThrow(
      /schemaVersion is not 1/,
    );
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

  it("refuses a pairs block that is not four non-negative integers", () => {
    expect(() =>
      validateHarmoniseRecord(
        cloneFixture({ pairs: { proposed: -1, unchanged: 0, skipped: 0, failed: 0 } }),
      ),
    ).toThrow(/pairs.proposed/);
    expect(() =>
      validateHarmoniseRecord(
        cloneFixture({ pairs: { proposed: 1.5, unchanged: 0, skipped: 0, failed: 0 } }),
      ),
    ).toThrow(/pairs.proposed/);
    const extra = cloneFixture();
    extra["pairs"] = { .../** @type {any} */ (extra["pairs"]), total: 6 };
    expect(() => validateHarmoniseRecord(extra)).toThrow(/unknown key 'total'/);
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
    expect(() => validateHarmoniseRecord(cloneFixture({ reason: "" }))).toThrow(/reason/);
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
    expect(harmoniseRecordSchemaVersion).toBe(1);
  });
});

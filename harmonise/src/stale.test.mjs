// Tests for `harmonise` stale classification — the deterministic decision that
// lets an unchanged pair skip the model.
//
// What is pinned: exactly one verdict for every input; `unchanged` only when
// all three compared fields are equal; content drift beats policy drift;
// nothing recorded is `new-pair`; and every unusable input, on the recorded
// side or the current side, is `unknown` — the refusal to guess. Also pinned:
// the inputs are never mutated.

import { describe, expect, it } from "vitest";

import { STATE_SCHEMA_VERSION } from "./state.mjs";
import { classifyPair } from "./stale.mjs";

/**
 * The current fingerprints matching the default recorded record, so a test
 * names only what drifted.
 *
 * @param {Partial<import("./stale.mjs").PairFingerprints>} overrides
 * @returns {import("./stale.mjs").PairFingerprints}
 */
function current(overrides = {}) {
  return {
    sourceFingerprint: "a".repeat(64),
    policyFingerprint: "c".repeat(64),
    transformationVersion: 1,
    ...overrides,
  };
}

/**
 * A recorded record in the full `SyncStateRecord` shape `parseState`
 * produces, matching {@link current} by default.
 *
 * @param {Partial<import("./state.mjs").SyncStateRecord>} overrides
 * @returns {import("./state.mjs").SyncStateRecord}
 */
function recorded(overrides = {}) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    sourcePath: "manual/dev.md",
    destinationPath: "manual/vi/dev.md",
    language: "vi",
    sourceFingerprint: "a".repeat(64),
    translationFingerprint: "b".repeat(64),
    policyFingerprint: "c".repeat(64),
    transformationVersion: 1,
    ...overrides,
  };
}

/**
 * Classifies a pair whose sides carry arbitrary override fields — the shape
 * the refusal tests need, where the point is that a value is NOT the declared
 * type.
 *
 * @param {Record<string, unknown>} recordedOverrides
 * @param {Record<string, unknown>} currentOverrides
 * @returns {import("./stale.mjs").StaleVerdict}
 */
function classifyOverrides(recordedOverrides = {}, currentOverrides = {}) {
  return classifyPair(
    /** @type {import("./stale.mjs").RecordedPairState} */ ({
      ...recorded(),
      ...recordedOverrides,
    }),
    /** @type {import("./stale.mjs").PairFingerprints} */ ({
      ...current(),
      ...currentOverrides,
    }),
  );
}

describe("unchanged", () => {
  it("verdicts a full record whose every compared field equals the current one", () => {
    expect(classifyPair(recorded(), current())).toBe("unchanged");
  });

  it("tolerates a recorded side carrying only the fingerprint slice", () => {
    expect(classifyPair({ ...current() }, current())).toBe("unchanged");
  });
});

describe("content-stale", () => {
  it("verdicts a differing source fingerprint as content-stale", () => {
    expect(classifyPair(recorded({ sourceFingerprint: "d".repeat(64) }), current())).toBe(
      "content-stale",
    );
  });

  it("content drift beats policy drift", () => {
    expect(
      classifyPair(
        recorded({ sourceFingerprint: "d".repeat(64), policyFingerprint: "e".repeat(64) }),
        current(),
      ),
    ).toBe("content-stale");
  });
});

describe("policy-stale", () => {
  it("verdicts a differing policy fingerprint while content is identical", () => {
    expect(classifyPair(recorded({ policyFingerprint: "e".repeat(64) }), current())).toBe(
      "policy-stale",
    );
  });

  it("verdicts a differing transformation version while content and policy are identical", () => {
    expect(classifyPair(recorded({ transformationVersion: 0 }), current())).toBe("policy-stale");
  });
});

describe("new-pair", () => {
  it("verdicts a null recorded side as new", () => {
    expect(classifyPair(null, current())).toBe("new-pair");
  });

  it("verdicts an undefined recorded side as new", () => {
    expect(classifyPair(undefined, current())).toBe("new-pair");
  });

  it("absence wins over an unusable current side", () => {
    expect(classifyPair(null, null)).toBe("new-pair");
  });
});

describe("unknown — unusable recorded state", () => {
  it("refuses an empty object", () => {
    expect(classifyPair(/** @type {any} */ ({}), current())).toBe("unknown");
  });

  it("refuses a missing source fingerprint", () => {
    expect(classifyOverrides({ sourceFingerprint: undefined })).toBe("unknown");
  });

  it("refuses a missing policy fingerprint", () => {
    expect(classifyOverrides({ policyFingerprint: undefined })).toBe("unknown");
  });

  it("refuses a missing transformation version", () => {
    expect(classifyOverrides({ transformationVersion: undefined })).toBe("unknown");
  });

  it("refuses a non-string source fingerprint", () => {
    expect(classifyOverrides({ sourceFingerprint: 42 })).toBe("unknown");
  });

  it("refuses an empty-string policy fingerprint", () => {
    expect(classifyOverrides({ policyFingerprint: "" })).toBe("unknown");
  });

  it("refuses a string transformation version", () => {
    expect(classifyOverrides({ transformationVersion: "1" })).toBe("unknown");
  });

  it("refuses a NaN transformation version", () => {
    expect(classifyOverrides({ transformationVersion: Number.NaN })).toBe("unknown");
  });

  it("refuses an infinite transformation version", () => {
    expect(classifyOverrides({ transformationVersion: Number.POSITIVE_INFINITY })).toBe("unknown");
  });

  it("refuses a foreign schema version", () => {
    expect(classifyOverrides({ schemaVersion: STATE_SCHEMA_VERSION + 1 })).toBe("unknown");
  });

  it("refuses a null schema version", () => {
    expect(classifyOverrides({ schemaVersion: null })).toBe("unknown");
  });

  it("refuses a non-object record", () => {
    expect(classifyPair(/** @type {any} */ ("leftover"), current())).toBe("unknown");
  });

  it("refuses an array record", () => {
    expect(classifyPair(/** @type {any} */ ([]), current())).toBe("unknown");
  });

  it("refuses when both sides are unusable", () => {
    expect(classifyOverrides({ sourceFingerprint: 42 }, { policyFingerprint: null })).toBe(
      "unknown",
    );
  });
});

describe("unknown — unusable current side", () => {
  it("refuses a null current side", () => {
    expect(classifyPair(recorded(), null)).toBe("unknown");
  });

  it("refuses an undefined current side", () => {
    expect(classifyPair(recorded(), undefined)).toBe("unknown");
  });

  it("refuses a missing transformation version", () => {
    expect(classifyOverrides({}, { transformationVersion: undefined })).toBe("unknown");
  });

  it("refuses an empty-string source fingerprint", () => {
    expect(classifyOverrides({}, { sourceFingerprint: "" })).toBe("unknown");
  });

  it("refuses a NaN transformation version", () => {
    expect(classifyOverrides({}, { transformationVersion: Number.NaN })).toBe("unknown");
  });

  it("refuses a non-object current side", () => {
    expect(classifyPair(recorded(), /** @type {any} */ ("nope"))).toBe("unknown");
  });

  it("refuses an array current side", () => {
    expect(classifyPair(recorded(), /** @type {any} */ ([]))).toBe("unknown");
  });
});

describe("purity", () => {
  it("does not mutate its inputs", () => {
    const rec = recorded();
    const cur = current();
    classifyPair(rec, cur);
    expect(rec).toStrictEqual(recorded());
    expect(cur).toStrictEqual(current());
  });
});

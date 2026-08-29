// Tests for `harmonise` drift detection: comparing the fingerprint recorded
// at last publication against a fingerprint computed from the target's
// current bytes.
//
// What is pinned: exactly one verdict per call; `canonical` is reachable
// only by exact digest equality; an absent record reads `unrecorded`
// regardless of the current input; every malformed recorded state and every
// malformed current input refuses to `unknown` (fail-closed) — nothing else.

import { describe, expect, it } from "vitest";

import { detectDrift } from "./drift.mjs";
import { TRANSFORMATION_VERSION, contentFingerprint } from "./fingerprint.mjs";
import { STATE_SCHEMA_VERSION } from "./state.mjs";

const PUBLISHED = "# Guide de démarrage\n\nCe guide décrit l'installation pas à pas.\n";
const EDITED = "# Guide de démarrage\n\nCe guide décrit l'installation complète pas à pas.\n";

/**
 * A well-formed sync-state record as a publication run would have written
 * it: `translationFingerprint` pins the bytes of `PUBLISHED`, so
 * `detectDrift(record(), PUBLISHED)` is `canonical`.
 *
 * @returns {import("./state.mjs").SyncStateRecord}
 */
function record() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    sourcePath: "manuel/source.md",
    destinationPath: "manuel/traductions/guide.md",
    language: "fr",
    sourceFingerprint: contentFingerprint(PUBLISHED),
    translationFingerprint: contentFingerprint(PUBLISHED),
    policyFingerprint: contentFingerprint("glossaire"),
    transformationVersion: TRANSFORMATION_VERSION,
  };
}

/**
 * A record with fields deliberately corrupted for a refusal test. Typed
 * loosely on purpose: the whole point is feeding `detectDrift` values the
 * schema forbids.
 *
 * @param {Record<string, unknown>} overrides fields to overwrite
 * @param {string[]} [remove] fields to delete entirely
 * @returns {Record<string, unknown>}
 */
function corrupted(overrides = {}, remove = []) {
  const base = /** @type {Record<string, unknown>} */ (record());
  for (const key of remove) {
    delete base[key];
  }
  return { ...base, ...overrides };
}

describe("detectDrift", () => {
  describe("canonical", () => {
    it("accepts the exact bytes harmonise published", () => {
      expect(detectDrift(record(), PUBLISHED)).toBe("canonical");
    });

    it("is stable across repeated calls on the same input", () => {
      expect(detectDrift(record(), PUBLISHED)).toBe(detectDrift(record(), PUBLISHED));
    });

    it("accepts a published empty file — empty content is real content", () => {
      const rec = corrupted({ translationFingerprint: contentFingerprint("") });
      expect(detectDrift(rec, "")).toBe("canonical");
    });
  });

  describe("target-drift", () => {
    it("fires when one word of the target changed", () => {
      expect(detectDrift(record(), EDITED)).toBe("target-drift");
    });

    it("fires on wholly different content", () => {
      expect(detectDrift(record(), "remplacé de bout en bout")).toBe("target-drift");
    });

    it("fires when the target was emptied after publishing non-empty content", () => {
      expect(detectDrift(record(), "")).toBe("target-drift");
    });
  });

  describe("unrecorded", () => {
    it("answers `unrecorded` when nothing was recorded for the pair", () => {
      expect(detectDrift(undefined, PUBLISHED)).toBe("unrecorded");
    });

    it("answers `unrecorded` for an explicit null record", () => {
      expect(detectDrift(null, PUBLISHED)).toBe("unrecorded");
    });

    it("decides absence without inspecting the current input", () => {
      // Precedence is part of the contract: a missing record is provable
      // without the target, so even a malformed current input stays
      // `unrecorded` rather than `unknown`.
      expect(detectDrift(undefined, 42)).toBe("unrecorded");
    });
  });

  describe("unknown — malformed recorded state", () => {
    it("refuses an array in place of a record", () => {
      expect(detectDrift([record()], PUBLISHED)).toBe("unknown");
    });

    it("refuses a string in place of a record", () => {
      expect(detectDrift("published", PUBLISHED)).toBe("unknown");
    });

    it("refuses a number in place of a record", () => {
      expect(detectDrift(1, PUBLISHED)).toBe("unknown");
    });

    it("refuses a record missing `schemaVersion`", () => {
      expect(detectDrift(corrupted({}, ["schemaVersion"]), PUBLISHED)).toBe("unknown");
    });

    it("refuses a non-numeric `schemaVersion`", () => {
      expect(detectDrift(corrupted({ schemaVersion: "1" }), PUBLISHED)).toBe("unknown");
    });

    it("refuses a foreign `schemaVersion` instead of interpreting it", () => {
      // The same refusal `parseState` makes: a record from another schema
      // era must not be silently compared field by field.
      expect(detectDrift(corrupted({ schemaVersion: 2 }), PUBLISHED)).toBe("unknown");
    });

    it("refuses a record missing `translationFingerprint`", () => {
      expect(detectDrift(corrupted({}, ["translationFingerprint"]), PUBLISHED)).toBe("unknown");
    });

    it("refuses a non-string `translationFingerprint`", () => {
      expect(detectDrift(corrupted({ translationFingerprint: 42 }), PUBLISHED)).toBe("unknown");
    });

    it("refuses an empty `translationFingerprint`", () => {
      expect(detectDrift(corrupted({ translationFingerprint: "" }), PUBLISHED)).toBe("unknown");
    });

    it("refuses a truncated digest", () => {
      expect(detectDrift(corrupted({ translationFingerprint: "deadbeef" }), PUBLISHED)).toBe(
        "unknown",
      );
    });

    it("refuses an uppercase digest — not the shape `contentFingerprint` emits", () => {
      expect(
        detectDrift(
          corrupted({ translationFingerprint: contentFingerprint(PUBLISHED).toUpperCase() }),
          PUBLISHED,
        ),
      ).toBe("unknown");
    });
  });

  describe("unknown — malformed current input", () => {
    it("refuses an undefined target", () => {
      expect(detectDrift(record(), undefined)).toBe("unknown");
    });

    it("refuses a null target", () => {
      expect(detectDrift(record(), null)).toBe("unknown");
    });

    it("refuses a numeric target", () => {
      expect(detectDrift(record(), 42)).toBe("unknown");
    });

    it("refuses a boolean target", () => {
      expect(detectDrift(record(), true)).toBe("unknown");
    });

    it("refuses an object target", () => {
      expect(detectDrift(record(), { content: PUBLISHED })).toBe("unknown");
    });

    it("refuses an array target", () => {
      expect(detectDrift(record(), [PUBLISHED])).toBe("unknown");
    });
  });

  it("never returns more than one verdict shape", () => {
    const verdicts = new Set(
      [
        detectDrift(record(), PUBLISHED),
        detectDrift(record(), EDITED),
        detectDrift(undefined, PUBLISHED),
        detectDrift(record(), undefined),
      ].map((verdict) => typeof verdict),
    );
    expect(verdicts).toEqual(new Set(["string"]));
  });
});

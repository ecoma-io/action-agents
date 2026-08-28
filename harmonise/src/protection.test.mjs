// Tests for the manual-edit protection policy: the deterministic mapping
// from a drift verdict plus the target's existence to exactly one action
// class.
//
// What is pinned: the full four-verdict × two-existence table —
// `republish-safe` only for a canonical target that exists,
// `create-allowed` only for an unrecorded pair with no target, everything
// else preserves (fail-closed, including the contradictory rows where a
// content-implying verdict meets a missing target); refusal by `TypeError`
// of any verdict outside the declared set and any non-boolean existence;
// and the declared action set is frozen, so callers validate against the
// same list the policy returns from.

import { describe, expect, it } from "vitest";

import { PROTECTION_ACTIONS, protectionDecision } from "./protection.mjs";

/** @typedef {import("./drift.mjs").DriftVerdict} DriftVerdict */

describe("protectionDecision", () => {
  describe("canonical", () => {
    it("blesses republication when the disk is exactly what harmonise published", () => {
      expect(protectionDecision("canonical", true)).toBe("republish-safe");
    });

    it("preserves a missing canonical target — the world contradicts the record", () => {
      expect(protectionDecision("canonical", false)).toBe("preserve-required");
    });
  });

  describe("target-drift", () => {
    it("preserves a target that was edited outside harmonise", () => {
      expect(protectionDecision("target-drift", true)).toBe("preserve-required");
    });

    it("preserves when a drifted target is missing — contradictory input preserves", () => {
      expect(protectionDecision("target-drift", false)).toBe("preserve-required");
    });
  });

  describe("unrecorded", () => {
    it("preserves an existing target harmonise never published — its content is treated as human-authored", () => {
      expect(protectionDecision("unrecorded", true)).toBe("preserve-required");
    });

    it("allows creation when no target exists and none was ever published", () => {
      expect(protectionDecision("unrecorded", false)).toBe("create-allowed");
    });
  });

  describe("unknown", () => {
    it("preserves regardless of existence — uncertainty lands on the preserving side", () => {
      expect(protectionDecision("unknown", true)).toBe("preserve-required");
      expect(protectionDecision("unknown", false)).toBe("preserve-required");
    });
  });

  describe("the whole table", () => {
    it("maps each of the eight verdict × existence combinations to exactly one action", () => {
      /** @type {Array<[DriftVerdict, boolean, import("./protection.mjs").ProtectionAction]>} */
      const expected = [
        ["canonical", true, "republish-safe"],
        ["canonical", false, "preserve-required"],
        ["target-drift", true, "preserve-required"],
        ["target-drift", false, "preserve-required"],
        ["unrecorded", true, "preserve-required"],
        ["unrecorded", false, "create-allowed"],
        ["unknown", true, "preserve-required"],
        ["unknown", false, "preserve-required"],
      ];
      for (const [verdict, exists, action] of expected) {
        expect(protectionDecision(verdict, exists)).toBe(action);
      }
    });

    it("is stable across repeated calls on the same input", () => {
      expect(protectionDecision("canonical", true)).toBe(protectionDecision("canonical", true));
      expect(protectionDecision("unrecorded", false)).toBe(protectionDecision("unrecorded", false));
    });

    it("only ever returns declared actions", () => {
      /** @type {DriftVerdict[]} */
      const verdicts = ["canonical", "target-drift", "unrecorded", "unknown"];
      for (const verdict of verdicts) {
        for (const exists of [true, false]) {
          expect(PROTECTION_ACTIONS).toContain(protectionDecision(verdict, exists));
        }
      }
    });
  });

  describe("refusals", () => {
    it("refuses a verdict outside the declared set with a TypeError", () => {
      expect(() => protectionDecision(/** @type {any} */ ("republished"), true)).toThrow(TypeError);
    });

    it("names the offending verdict and the declared set in the refusal", () => {
      expect(() => protectionDecision(/** @type {any} */ ("stale"), true)).toThrow(
        /unknown drift verdict 'stale'/,
      );
      expect(() => protectionDecision(/** @type {any} */ ("stale"), true)).toThrow(
        /canonical, target-drift, unrecorded, unknown/,
      );
    });

    it("refuses a non-string or absent verdict", () => {
      expect(() => protectionDecision(/** @type {any} */ (42), true)).toThrow(TypeError);
      expect(() => protectionDecision(/** @type {any} */ (undefined), true)).toThrow(TypeError);
      expect(() => protectionDecision(/** @type {any} */ (null), false)).toThrow(TypeError);
      expect(() => protectionDecision(/** @type {any} */ ({ verdict: "canonical" }), true)).toThrow(
        TypeError,
      );
    });

    it("refuses a non-boolean existence even for a declared verdict", () => {
      for (const exists of ["true", 1, 0, null, undefined, {}]) {
        expect(() => protectionDecision("canonical", /** @type {any} */ (exists))).toThrow(
          TypeError,
        );
      }
    });

    it("names the offending existence in the refusal", () => {
      expect(() => protectionDecision("canonical", /** @type {any} */ ("yes"))).toThrow(
        /targetExists must be a boolean, got string/,
      );
      expect(() => protectionDecision("canonical", /** @type {any} */ (null))).toThrow(/got null/);
    });

    it("refuses a bad verdict even when the existence is also bad", () => {
      expect(() =>
        protectionDecision(/** @type {any} */ ("stale"), /** @type {any} */ (1)),
      ).toThrow(/unknown drift verdict/);
    });
  });
});

describe("PROTECTION_ACTIONS", () => {
  it("declares exactly the three action classes", () => {
    expect([...PROTECTION_ACTIONS]).toEqual([
      "republish-safe",
      "preserve-required",
      "create-allowed",
    ]);
  });

  it("is frozen — callers cannot widen the declared set", () => {
    expect(Object.isFrozen(PROTECTION_ACTIONS)).toBe(true);
  });
});

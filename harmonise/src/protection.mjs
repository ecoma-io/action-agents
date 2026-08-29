/**
 * `harmonise` manual-edit protection policy — the deterministic mapping from
 * a drift verdict plus one fact about the world to exactly one action class.
 *
 * This is the policy `drift.mjs` was written for. Detection names one of
 * four facts (`canonical | target-drift | unrecorded | unknown`) and stops;
 * this module decides what a later task may do about it. Detection and
 * decision are separate modules on purpose: a verdict is evidence, and the
 * decision that consumes it is a total, table-driven mapping a reviewer can
 * read as one table.
 *
 * ## DOCTRINE
 *
 * A consumer's hand edits to published translations must never be silently
 * overwritten by generated text.
 *
 * - **Human edits win ties.** When the record and the disk disagree about
 *   what the target should be, the disk — touched by a maintainer or
 *   another tool — is treated as authored work, never as stale garbage.
 * - **Generated text never silently displaces human work.** Overwriting is
 *   never this policy's answer. The only regeneration it blesses is
 *   republication of bytes provably identical to what harmonise last
 *   published; the only creation it blesses is a first-time translation
 *   where no target exists and none was ever published.
 * - **Uncertainty always lands on the preserving side.** Anything not
 *   provably safe preserves: an `unknown` verdict preserves regardless of
 *   existence, and a world that contradicts the record (a verdict that
 *   implies target content, a target that is missing) preserves too.
 *
 * The doctrine is enforced by refusal as well as by mapping: a verdict
 * outside the declared set or a non-boolean existence throws a `TypeError`
 * rather than guessing — the same posture `drift.mjs` takes toward a value
 * outside its declared vocabulary.
 *
 * The policy is a pure mapping: its one runtime import is `drift.mjs`'s
 * frozen verdict vocabulary — a side-effect-free constant; it reads no
 * files, calls no model, consults no configuration, and wires into nothing.
 * A later task decides what an action class is allowed to cause —
 * `preserve-required` is what routes manual edits through the three-way
 * merge.
 *
 * @module harmonise/src/protection
 */

import { VERDICTS } from "./drift.mjs";

/**
 * A drift verdict, as `drift.mjs` declares it. Referenced rather than
 * redefined, so the two unions cannot drift apart silently: a verdict
 * drift renames or removes becomes a typecheck failure here.
 *
 * @typedef {import("./drift.mjs").DriftVerdict} DriftVerdict
 */

/**
 * The action classes this policy returns. Exactly one for every accepted
 * call:
 *
 * - `republish-safe` — the disk matches what harmonise last published.
 *   Regenerating reproduces the same bytes, so republication displaces
 *   nothing.
 * - `preserve-required` — manual edits are present or cannot be ruled out.
 *   The content must be preserved; any update goes through the three-way
 *   merge, never a silent overwrite.
 * - `create-allowed` — no target exists and harmonise never published one:
 *   a first-time translation may be created.
 *
 * @typedef {"republish-safe" | "preserve-required" | "create-allowed"} ProtectionAction
 */

/**
 * The declared action set, frozen. Callers validate against this same list
 * instead of copying it.
 *
 * @type {readonly ProtectionAction[]}
 */
export const PROTECTION_ACTIONS = Object.freeze([
  "republish-safe",
  "preserve-required",
  "create-allowed",
]);

/**
 * The drift verdicts this policy accepts — `drift.mjs`'s own declared set,
 * imported rather than copied. One declaration means a verdict the detector
 * renames cannot leave this policy refusing on a stale list: the import is
 * the whole mechanism, where an annotation was the mitigation.
 *
 * @type {readonly DriftVerdict[]}
 */
const DRIFT_VERDICTS = VERDICTS;

/**
 * The policy itself: every accepted (verdict, existence) combination with
 * exactly one action each. Declared as a total record over `DriftVerdict`,
 * so a verdict drift adds without a policy row is a typecheck failure —
 * totality is declared, not remembered.
 *
 * The two rows drift's own semantics make contradictory — a verdict that
 * implies target content over a missing target — land on
 * `preserve-required`: the world disagrees with the record, and
 * disagreement preserves.
 *
 * @type {Readonly<
 *   Record<DriftVerdict, Readonly<{exists: ProtectionAction, missing: ProtectionAction}>>
 * >}
 */
const POLICY = Object.freeze({
  canonical: Object.freeze({ exists: "republish-safe", missing: "preserve-required" }),
  "target-drift": Object.freeze({ exists: "preserve-required", missing: "preserve-required" }),
  unrecorded: Object.freeze({ exists: "preserve-required", missing: "create-allowed" }),
  unknown: Object.freeze({ exists: "preserve-required", missing: "preserve-required" }),
});

/**
 * Decides the action class for one destination pair: what a later task may
 * do with a target whose drift verdict is already known and whose presence
 * on disk is a settled fact.
 *
 * The mapping, in full:
 *
 * | verdict        | target exists       | target missing      |
 * | -------------- | ------------------- | ------------------- |
 * | `canonical`    | `republish-safe`    | `preserve-required` |
 * | `target-drift` | `preserve-required` | `preserve-required` |
 * | `unrecorded`   | `preserve-required` | `create-allowed`    |
 * | `unknown`      | `preserve-required` | `preserve-required` |
 *
 * @param {DriftVerdict} driftVerdict
 *   the pair's verdict from `detectDrift`. Untrusted: validated here,
 *   never assumed — a value outside the declared set is refused.
 * @param {boolean} targetExists whether the target file exists on disk
 *   right now; likewise refused in any other type
 * @returns {ProtectionAction} exactly one action class
 * @throws {TypeError} a verdict outside the declared set, or a non-boolean
 *   existence — refused, never a best guess
 */
export function protectionDecision(driftVerdict, targetExists) {
  if (!DRIFT_VERDICTS.includes(driftVerdict)) {
    throw new TypeError(
      `unknown drift verdict '${String(driftVerdict)}' — expected one of ` +
        `${DRIFT_VERDICTS.join(", ")}`,
    );
  }
  if (typeof targetExists !== "boolean") {
    throw new TypeError(
      `targetExists must be a boolean, got ${targetExists === null ? "null" : typeof targetExists}`,
    );
  }
  const row = POLICY[driftVerdict];
  return targetExists ? row.exists : row.missing;
}

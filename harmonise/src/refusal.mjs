/**
 * The typed deterministic refusal — `docs/run-contract.md`'s own "typed
 * refusal" made into a class. The action's ceilings declined to act on
 * deterministic grounds: a config the map refuses (F-02), a protection
 * verdict over human work, a ceiling-exceeded (F-11). The raise sites carry
 * the class so nothing ever tells a refusal from a defect by matching
 * message text, and the run boundary reads it: a red run whose throw carries
 * the class is recorded `refused`, every other undeclared throw records
 * `failed` (F-15).
 *
 * The class is for the run's own ceilings only. A provider's junk answer is
 * F-09's other arm — it fails, it does not refuse — and `recovery.mjs`'s
 * `RefusalError` stays the pair loop's retry taxonomy for answer content:
 * that class says "re-asking never helps", this one says "the run declined",
 * and a red record is decided by the run boundary, not the retry policy.
 */
export class DeterministicRefusalError extends Error {
  /**
   * @param {string} message Why the run declined to act, in the refusal site's own words.
   * @param {ErrorOptions} [options] the wrapped cause, for a refusal retyped at a boundary
   */
  constructor(message, options) {
    super(message, options);
    this.name = "DeterministicRefusalError";
  }
}

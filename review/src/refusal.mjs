/**
 * The typed deterministic refusal — `docs/run-contract.md`'s own "typed
 * refusal" made into a class, the twin of `harmonise/src/refusal.mjs`'s.
 * The action's ceilings declined to act on deterministic grounds: a config
 * the validator refuses (F-02), the diff-line budget, the prompt-headroom
 * ceiling (F-11), the posture-document guard, the output contract (F-09's
 * off-sheet arm). The raise sites carry the class so nothing ever tells a
 * refusal from a defect by matching message text, and the run boundary
 * reads it: a red run whose throw carries the class is recorded `refused`,
 * every other undeclared throw records `failed` (F-15).
 *
 * The class is for the run's own ceilings only. A transport break, an auth
 * failure, a policy source that will not resolve and a wire defect in the
 * provider's tool calls are environment breaks and defects — they fail,
 * they do not refuse — and the coverage-accounting and gate-table guards
 * are internal invariants whose firing is a code defect, so they stay plain
 * errors and record `failed` too. The class lives in `review/` rather than
 * `core/` because which throws are ceilings is this action's domain, not
 * shared infrastructure; it duplicates harmonise's few lines under the
 * boundary law's own remediation guidance, and promotes into core when a
 * third action needs one.
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

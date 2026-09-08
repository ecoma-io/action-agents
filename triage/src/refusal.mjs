/**
 * The typed deterministic refusal — `docs/run-contract.md`'s own "typed
 * refusal" made into a class. The action's ceilings declined to act on
 * deterministic grounds: here, a policy file present but failing to validate
 * (F-02), which the run's validation wrap retypes once instead of every
 * raise site carrying the class. The run boundary reads the class: a red run
 * whose throw carries it is recorded `refused`, every other throw records
 * `failed` (F-15) — so nothing ever tells a refusal from a defect by
 * matching message text.
 *
 * The class is for the run's own ceilings only. A transport break, an auth
 * failure, a policy source that will not resolve and the reader faults — a
 * configured `config-path` that is absent, a policy declared twice, a
 * foreign schema major — are environment breaks and defects: they fail, they
 * do not refuse, because the reading call interleaves transport breaks a
 * blanket retype would mislabel. Absent default locations are no fault at
 * all — policy-empty, the posture the run contract blesses — and a run on
 * them has no sheet, so it has no label writes to refuse.
 *
 * The class lives in `triage/` rather than `core/` because which throws are
 * ceilings is this action's domain, not shared infrastructure; it duplicates
 * review's and harmonise's few lines under the boundary law's own remediation
 * guidance, and the promotion into `core/` a third copy argues for is
 * #472's recorded follow-up, deliberately not this change.
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

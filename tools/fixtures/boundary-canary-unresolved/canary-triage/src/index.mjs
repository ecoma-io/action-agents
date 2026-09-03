// The blind spot this fixture exists to hold VISIBLE: an action reaching
// into another action over a subpath specifier that no compiler options can
// resolve — this workspace names no `#canary-review` package, so the
// specifier goes dark and archkeep records the import site in its coverage
// blind spots instead of judging it. The gate that runs this fixture asserts
// the site is NAMED there — visibility, not verdict: whether archkeep should
// also fail such a tree is a question for archkeep, not for this fixture,
// and nobody may tighten this assertion into a pass/fail claim without
// re-measuring first. See `tools/check-arch-canary.mjs`.
import { canaryReviewLabel } from "#canary-review/src/index.mjs";

/**
 * Consumes the cross-boundary import so the dependency is used rather than
 * dead — the edge this file exists to keep visible is one the resolver
 * cannot see and coverage must name.
 *
 * @returns {string} whatever the other action's export answers
 */
export function canaryTriageLabel() {
  return canaryReviewLabel();
}

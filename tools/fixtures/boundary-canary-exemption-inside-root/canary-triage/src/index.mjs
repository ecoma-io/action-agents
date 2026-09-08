// The edge this fixture carries is inherited from the boundary canary and is
// deliberately still illegal: an action reaching into another action, over a
// RELATIVE specifier that resolves with no compiler options at all. The run
// this fixture exists to pin never gets as far as judging it — archkeep
// refuses the config at load, because its `coverage.exempt` names a glob that
// matches files a project owns — and that ordering is the point: an exemption
// cannot be used to blind the tree's interior and let this edge through. See
// `module-boundaries.config.mjs` beside this file, and
// `tools/check-arch-canary-extended.mjs`, which fails the run the day a pin
// honors the exemption instead of refusing it.
import { canaryReviewLabel } from "../../canary-review/src/index.mjs";

/**
 * Consumes the cross-boundary import so the dependency is used rather than
 * dead — the edge stays real and resolvable, so the fixture cannot be misread
 * as one whose tree is merely empty.
 *
 * @returns {string} whatever the other action's export answers
 */
export function canaryTriageLabel() {
  return canaryReviewLabel();
}

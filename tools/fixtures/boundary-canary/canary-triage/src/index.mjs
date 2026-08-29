// The violation this fixture exists to hold: an action reaching into another
// action, over a RELATIVE specifier. The relative form is load-bearing — it
// resolves with no compiler options at all, while the subpath imports the
// repository itself uses (`#core/…`) go dark and are reported `allowed` the
// moment `tsConfig` is missing from `archkeep.json`. This fixture's config
// omits that key on purpose, so this edge stays resolvable — and stays a
// violation the gate must name — under exactly the condition that once
// silenced the root gate. See `module-boundaries.config.mjs` beside this
// file, and `tools/check-arch-canary.mjs`, which fails the run the day the
// gate stops reporting this import.
import { canaryReviewLabel } from "../../canary-review/src/index.mjs";

/**
 * Consumes the cross-boundary import so the dependency is used rather than
 * dead — the edge this file exists to keep illegal is one the resolver can
 * see and the gate must judge.
 *
 * @returns {string} whatever the other action's export answers
 */
export function canaryTriageLabel() {
  return canaryReviewLabel();
}

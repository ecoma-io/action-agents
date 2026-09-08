/**
 * A real export for the canary edge to reach for, inside the project whose
 * interior the fixture's `coverage.exempt` glob claims — the match the loader
 * must refuse rather than honor. The value is arbitrary; what matters is that
 * the specifier in `canary-triage/src/index.mjs` resolves to a real symbol in
 * a real file owned by this project.
 *
 * @returns {string} a constant the other project's canary file imports
 */
export function canaryReviewLabel() {
  return "canary-review";
}

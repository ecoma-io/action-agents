/**
 * A real export for the canary to reach for. The value is arbitrary; what
 * matters is that the specifier in `canary-triage/src/index.mjs` resolves to
 * a real symbol in a real file, so the illegal edge between the two projects
 * exists as an edge — resolvable, judged, reported — and not as an unresolved
 * import a quiet gate would wave through.
 *
 * @returns {string} a constant the other project's canary file imports
 */
export function canaryReviewLabel() {
  return "canary-review";
}

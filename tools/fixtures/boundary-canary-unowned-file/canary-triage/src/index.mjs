// The clean, properly-owned half of this fixture: a file the project graph
// owns, importing nothing, violating nothing. It exists so the run's refusal
// is demonstrably about the stray file beside it and not about this tree's
// edges — there are none. If a future pin refused this tree for any other
// reason, `tools/check-arch-canary-extended.mjs` would still hold it to the
// measured contract: exit 3, and `coverage.notAnalyzed` naming `unowned.mjs`
// and nothing else.

/**
 * A real export owned by the fixture's one project — analyzable, judged, and
 * silent.
 *
 * @returns {string} a constant no other file reaches for
 */
export function canaryTriageLabel() {
  return "canary-triage";
}

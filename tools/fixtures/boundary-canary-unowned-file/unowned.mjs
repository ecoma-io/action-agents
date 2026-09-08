// The stray file this fixture exists to hold NAMED: a tracked, analyzable
// `.mjs` file at the workspace root, outside every project's root and claimed
// by no coverage exemption. Measured at this repository's archkeep pin
// (0.27.0): archkeep refuses the tree (exit 3, run status "no-verdict",
// verdict "unknown") and lists this file in `coverage.notAnalyzed` with a
// reason reading "is not owned by any project" — visibility plus refusal, the
// same shape the unresolved-import canary holds. A file the project graph
// cannot place is never silently skipped, and the run is never green over it.
// If a future pin passes this tree, or stops naming the file, the runner
// fails the run for it — fix the gate, never the canary.

/**
 * A real export, so the file is analyzable code rather than an empty stub a
 * resolver could legitimately ignore.
 *
 * @returns {string} a constant no project's file imports
 */
export function unownedLabel() {
  return "unowned";
}

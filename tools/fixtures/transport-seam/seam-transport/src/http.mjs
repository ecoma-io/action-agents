// A minimal stand-in for the transport client this fixture's law walls off.
// One export is all an illegal import needs to reach for; the value is
// arbitrary. What matters is that the specifier in
// `seam-action/src/index.mjs` resolves to a real symbol in a real file, so
// the illegal edge exists as an edge — resolvable, judged, reported — not as
// an unresolved import a quiet gate would wave through.

/**
 * A real export for the canary to reach for.
 *
 * @returns {string} a constant the action's illegal import reaches for
 */
export function transportClientName() {
  return "seam-transport";
}

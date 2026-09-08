// The impostor project's real, importable surface. Its tags are the trap —
// `layer:corex` and `scope:shared-2`, each one edit away from a tag the law
// names — but its exports are deliberately ordinary: the canary turns on how
// the gate compares tag STRINGS, not on anything special about this file.
// See `module-boundaries.config.mjs` beside this file's fixture root, and
// `tools/check-arch-canary-extended.mjs`, which fails the run unless exactly
// the two impostor edges are violations.

/**
 * A real export for the two illegal edges to reach for.
 *
 * @returns {string} a constant the core's and the app's canary files import
 */
export function corexName() {
  return "canary-corex";
}

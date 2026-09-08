// The tag-identity canary's boundary law — a deliberate miniature of the root
// `module-boundaries.config.mjs`, judged by the same `archkeep check` binary
// that judges the repository. Three projects carry the prefix traps in their
// tags: `canary-core` is the real thing (`layer:core`, `scope:shared`), and
// `canary-corex` is its impostor — every tag one character or one hyphen away
// from a real one (`layer:corex`, `scope:shared-2`). Neither string is a
// prefix the other extends by accident: `scope:shared-2` is NOT `scope:shared`,
// and `layer:corex` is NOT `layer:core`, no matter what a prefix-matching
// implementation would pretend.
//
// The contract this fixture pins: tag matching in the depConstraints table is
// EXACT, on both axes. The first row says of `canary-app` what the root law
// says of every action — it may use the real core, and the run must prove the
// row can still say yes: `canary-app → canary-core` is judged legal. The same
// row refuses `canary-app → canary-corex`: the impostor carries
// `layer:corex`, which the row's allow-list does not name. The second row says
// of the core what it says in the real tree — it may use `scope:shared` — and
// refuses `canary-core → canary-corex` for the same reason on the scope axis:
// `scope:shared-2` is not named either. Measured at this repository's
// archkeep pin (0.27.0) by the integration-lab campaign — the mutation batch
// over this contract records verdict CONFIRMED — and re-measured at authoring
// time: exit 1, verdict "fail", `coverage.complete: true`, and EXACTLY TWO
// violations, both `onlyTagsConstraintViolation`, naming those two edges and
// neither the legal one. A pin that prefix-matched tags would pass the
// impostor's edges and collapse the run toward green — a fail-open no other
// canary in this directory catches, because every other one turns on
// resolution, not on how a tag string is compared. If either count moves,
// `tools/check-arch-canary-extended.mjs` fails the run; the change is
// re-measured and reviewed, never absorbed.

/**
 * Builds one depConstraints row.
 *
 * @param {string} sourceTag the tag the row is keyed on
 * @param {string[]} allowedTags the only target tags an edge from a source
 *   carrying `sourceTag` may cross
 * @param {string} description what the row says, in the law's own words
 * @returns {object} the row
 */
function row(sourceTag, allowedTags, description) {
  return {
    sourceTag,
    onlyDependOnLibsWithTags: allowedTags,
    description,
    remediation: "The violation is the point; fix the gate, never the canary",
  };
}

export const depConstraints = [
  row(
    "layer:action",
    ["layer:core", "scope:shared"],
    "an action may use the real core and nothing else — the impostor's near-miss tags are not on this list",
  ),
  row(
    "layer:core",
    ["scope:shared"],
    "the core may use shared infrastructure and nothing else — scope:shared-2 is not shared",
  ),
];

export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

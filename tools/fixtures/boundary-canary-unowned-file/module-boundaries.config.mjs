// The unowned-file canary's boundary law — a deliberate miniature of the root
// `module-boundaries.config.mjs`, judged by the same `archkeep check` binary
// that judges the repository. The single row says of `canary-triage` what the
// root law says of every action, and the tree is clean: `canary-triage`
// imports nothing, so no row could ever fire here. The clean tree is the
// point — a refusal this fixture could get from an illegal edge would prove
// nothing about coverage.
//
// The contract this fixture pins: every analyzable file the workspace tracks
// must be owned by a project. A tracked, analyzable `.mjs` file sits at this
// fixture's root, `unowned.mjs`, outside every project root and claimed by no
// exemption. Measured at this repository's archkeep pin (0.27.0) by the
// integration-lab campaign — the mutation batch over this contract records
// verdict CONFIRMED — and re-measured at authoring time: archkeep refuses the
// tree (exit 3, run status "no-verdict", verdict "unknown") and names the
// stray file in `coverage.notAnalyzed`, its reason opening "is not owned by
// any project declared or inferred from archkeep.json". The file is not
// silently skipped, and the verdict is not
// green over a file nothing judged: a tree the graph cannot place refuses the
// verdict instead. If a future pin skips the file and passes, or drops it
// from `coverage.notAnalyzed`, `tools/check-arch-canary-extended.mjs` fails
// the run — a change that large is a reviewed gate change, never an absorbed
// one.

/** @param {string} name @returns {object} */
function actionRow(name) {
  return {
    sourceTag: `scope:${name}`,
    onlyDependOnLibsWithTags: [`scope:${name}`, "scope:shared"],
    description: `${name} may use itself and nothing else — this fixture declares no shared project`,
    remediation: "The violation is the point; fix the gate, never the canary",
  };
}

export const depConstraints = [actionRow("canary-triage")];

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

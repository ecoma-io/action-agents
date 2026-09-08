// The exemption-refusal canary's boundary law — a deliberate miniature of the
// root `module-boundaries.config.mjs`, judged by the same `archkeep check`
// binary that judges the repository. The two rows say of each canary project
// what the root law says of every action, and the tree carries the same
// relative cross-action import the boundary canary carries: `canary-triage`
// reaching into `canary-review`. That edge is beside the point here — a run of
// this fixture must refuse before any row is read.
//
// The contract this fixture pins: a coverage exemption may not blind a
// project's own interior. The `archkeep.json` beside this file adds to the
// usual law exemption a glob, `canary-review/**`, that matches files the
// `canary-review` project OWNS. Measured at this repository's archkeep pin
// (0.27.0) by the integration-lab campaign — the mutation batch over this
// contract records verdict CONFIRMED — and re-measured at authoring time:
// archkeep refuses to load such a config (exit 3, run status "no-verdict",
// verdict "unknown"), naming the row with a reason in the shape
// "coverage.exempt: … matches no unclaimed file". An exemption that could
// claim a project's own files would let one glob silence any interior file,
// so the loader refuses the row instead of quietly excusing the match. If a
// future pin accepts the row, `tools/check-arch-canary-extended.mjs` fails
// the run — a change that large is a reviewed gate change, never an absorbed
// one. See also `docs/archkeep-integration.md`: a coverage exemption is a
// reviewed decision, and this is the wall that keeps it one.

/** @param {string} name @returns {object} */
function actionRow(name) {
  return {
    sourceTag: `scope:${name}`,
    onlyDependOnLibsWithTags: [`scope:${name}`, "scope:shared"],
    description: `${name} may use itself and nothing else — this fixture declares no shared project`,
    remediation: "The violation is the point; fix the gate, never the canary",
  };
}

export const depConstraints = [actionRow("canary-triage"), actionRow("canary-review")];

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

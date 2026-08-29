// The transport-seam canary's boundary law — a deliberate miniature of the
// root `module-boundaries.config.mjs`, judged by the same `archkeep check`
// binary that judges the repository. The single row says of `seam-action`
// what the root law says of every action: it depends on itself and on
// `scope:shared` and on nothing else. This fixture declares no shared
// project, so the import in `seam-action/src/index.mjs` — reaching into
// `seam-transport`, the transport client's project, tagged `scope:transport`
// — is a violation the gate must name on every run.
//
// Why this fixture exists beside the boundary canary: that canary's illegal
// specifier is relative, so archkeep reports it through its own
// `noRelativeOrAbsoluteImportsAcrossLibraries` check, which fires before the
// depConstraints table is read. This fixture's illegal specifier is the
// shape the root rule actually guards — an action importing the transport
// client by its public subpath (`#seam-transport/http.mjs`, the exact shape
// of `#core-transport/http.mjs` in the real tree) — so the refusal must come
// from the depConstraints row itself: `scope:transport` is simply absent
// from the action's `onlyDependOnLibsWithTags` list. Resolution needs the
// Node imports map, so unlike the canary this fixture carries a
// `package.json`, and its `archkeep.json` names `tsConfig` — without
// compiler options a subpath import goes dark and is reported `allowed`,
// the fail-open the boundary canary's own config records. If any link in
// that chain breaks, `tools/check-transport-seam.mjs` fails the run for it.
//
// The proof that the row, not the resolver, is the rejector: give
// `seam-transport` a `scope:shared` tag in a scratch copy of this fixture
// and `archkeep check` passes the identical tree. The check script's header
// records how to run that variant.

/** @param {string} name @returns {object} */
function actionRow(name) {
  return {
    sourceTag: `scope:${name}`,
    onlyDependOnLibsWithTags: [`scope:${name}`, "scope:shared"],
    description: `${name} may use itself and nothing else — this fixture declares no shared project`,
    remediation: "The violation is the point; fix the gate, never the canary",
  };
}

export const depConstraints = [actionRow("seam-action")];

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

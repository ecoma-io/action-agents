// The canary's boundary law — a deliberate miniature of the root
// `module-boundaries.config.mjs`, judged by the same `archkeep check` binary
// that judges the repository. The two rows say of each canary project what
// the root law says of every action: it depends on itself and on `core/`
// (`scope:shared`) and on nothing else. This fixture declares no shared
// project, so the import `canary-triage/src/index.mjs` holds by design —
// `canary-triage` reaching into `canary-review` — is a violation the gate
// must name on every run. Archkeep reports this one through its own
// `noRelativeOrAbsoluteImportsAcrossLibraries` check, which fires before the
// depConstraints table is read; the rows restate the same rule at table
// level, as the root law does for every action.
//
// Why this fixture exists: the root law's header records the fail-open this
// canary keeps closed. Archkeep reads compiler options from the tsConfig named
// in `archkeep.json`, defaulting to `tsconfig.base.json` — an Nx convention —
// and this fixture deliberately sets no `tsConfig` key, so its options come
// from the default path alone: the `tsconfig.base.json` beside this file. A
// TypeScript resolver without compiler options resolves nothing — a Node
// subpath import (`#core/…`) and a relative specifier alike go dark, and
// archkeep reports an unresolved import as `allowed` while saying "no
// boundary violations" — the root gate once failed exactly that way over a
// graph with zero edges, and nothing failed. With options in place the
// canary's illegal edge resolves, so the gate must judge it and name it. If
// any link in that chain breaks — options discovery, resolution, judgment —
// the gate passes an illegal tree, and `tools/check-arch-canary.mjs` fails
// the run for it.

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

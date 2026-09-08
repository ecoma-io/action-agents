// The dynamic-import canary's boundary law — a deliberate miniature of the
// root `module-boundaries.config.mjs`, judged by the same `archkeep check`
// binary that judges the repository. The single row says of `canary-dynamic`
// what the root law says of every action: it depends on itself and on
// `scope:shared`, and this fixture declares no shared project, so every
// resolvable edge out of it would be a violation. The tree carries none — no
// static import, no resolvable dynamic one — because this fixture does not
// pin a violation. It pins a blind spot's exact shape.
//
// The contract this fixture pins — the declared limit of the refusal lane,
// recorded in `docs/archkeep-integration.md`: a dynamic specifier the
// resolver can never see as a literal is named in `coverage.blindSpots` and
// does NOT withhold the verdict. The single source file calls
// `import(\`./\${part}.mjs\`)` — a computed template literal with no static
// form. Measured at this repository's archkeep pin (0.27.0) by the
// integration-lab campaign — the mutation batch over this contract records
// verdict CONFIRMED — and re-measured at authoring time: the run exits 0 with
// verdict "pass" and `coverage.complete: true`, and `coverage.blindSpots`
// carries exactly one entry, flagged `dynamic: true`, naming this file and
// line. Complete WITH a declared blind spot: an unresolvable dynamic site is
// a documented coverage limit, not a hole the verdict may lie over — the
// contrast with the unresolved-import canary, whose literal-but-unresolvable
// site refuses the run, is the whole reason this fixture exists beside it.
// If a future pin changes any half of that pair — a blind spot that refuses,
// or a pass that stops naming the site — `tools/check-arch-canary-extended.mjs`
// fails the run, and the change is re-measured and reviewed, never absorbed.

/** @param {string} name @returns {object} */
function actionRow(name) {
  return {
    sourceTag: `scope:${name}`,
    onlyDependOnLibsWithTags: [`scope:${name}`, "scope:shared"],
    description: `${name} may use itself and nothing else — this fixture declares no shared project`,
    remediation: "The violation is the point; fix the gate, never the canary",
  };
}

export const depConstraints = [actionRow("canary-dynamic")];

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

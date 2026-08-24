// The boundary law. One table, read by `pnpm arch` (Archkeep) — and shaped the
// same way `@nx/enforce-module-boundaries` takes it, so it stays portable.
//
// This file is the mechanism behind a design principle that would otherwise be
// nothing but good intentions: core holds infrastructure, never an action's
// domain logic, and no action may reach into another. A repository of four
// actions sharing one directory has exactly one way to rot — `core/` slowly
// absorbing whatever the second action happened to need — and a rule nobody can
// run is not a rule. These rows are runnable.
//
// The tags come from `archkeep.json`. Adding an action means adding its project
// there and its `scope:` row here; there is no third place to remember.

/** @param {string} name @returns {object} */
function actionRow(name) {
  return {
    sourceTag: `scope:${name}`,
    onlyDependOnLibsWithTags: [`scope:${name}`, "scope:shared"],
    description: `${name} may use core and nothing else`,
    remediation:
      "Duplicate the few lines you need, or promote them into core once a second action genuinely needs them",
  };
}

export const depConstraints = [
  {
    // Core is the bottom of the graph. An import from `core/` into an action
    // inverts the dependency and makes the shared layer a consumer of the
    // policy it exists to serve — which is how "shared runtime primitives"
    // becomes a second copy of every action.
    sourceTag: "layer:core",
    onlyDependOnLibsWithTags: ["layer:core"],
    description: "core is infrastructure: it may not depend on any action",
    remediation:
      "Invert the call — pass what core needs in as an argument, or move the logic into the action that owns it",
  },
  actionRow("triage"),
  actionRow("review"),
  actionRow("harmonise"),
];

export const moduleBoundaryOptions = {
  allow: [],
  // There is no build in this repository — the source is what the runner
  // executes — so there are no build targets for the buildable-lib rule to
  // consult, and the rule has nothing to enforce.
  buildTargets: [],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};

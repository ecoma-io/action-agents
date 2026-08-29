// The boundary law. One table, read by `pnpm arch` (Archkeep) — and shaped the
// same way `@nx/enforce-module-boundaries` takes it, so it stays portable.
//
// This file is the mechanism behind a design principle that would otherwise be
// nothing but good intentions: core holds infrastructure, never an action's
// domain logic, and no action may reach into another. A repository of three
// actions sharing one directory has exactly one way to rot — `core/` slowly
// absorbing whatever the second action happened to need — and a rule nobody can
// run is not a rule. These rows are runnable.
//
// The tags come from `archkeep.json`. Adding an action means adding its project
// there and its `scope:` row here; there is no third place to remember.
//
// `archkeep.json` also sets `"tsConfig": "tsconfig.json"`, and that line is
// load-bearing rather than decorative. Archkeep defaults to
// `tsconfig.base.json` — an Nx convention, and a file this repository does not
// have. Without the override it reads no compiler options at all, and every
// cross-project import here goes through a Node subpath import (`#core/…`)
// that then resolves to nothing. An unresolved import is reported as
// `allowed`, so the run said "✔ no boundary violations" over a graph with
// ZERO edges: the rows below had never once been applied to a real import.
// Measured, not reasoned — `archkeep graph` showed `0 edges` before and
// `3 edges` after, and an illegal `triage → review` import was ruled allowed
// before and is a violation after. If that field is ever dropped, this whole
// file goes quiet without failing.
//
// The transport seam is its own project (`core/transport`, `scope:transport`)
// and is deliberately NOT `scope:shared`: an action never opens, configures
// or inspects the transport client — every network byte crosses `forge` or
// `chat`, and transport failures reach actions as typed facts from
// `core/src/transport-errors.mjs` (`HttpError` with its status,
// `TransportError`, and the retry-policy constants recovery mirrors). The
// action rows below enforce this without a row of their own:
// `scope:transport` is simply absent from every `onlyDependOnLibsWithTags`
// list, so an action reaching for the client directly is a violation the
// gate names.

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

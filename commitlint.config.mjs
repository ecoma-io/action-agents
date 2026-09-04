// Conventional Commits, enforced by lefthook's commit-msg hook and re-checked
// against the pull request title in CI (the squash subject never reaches the
// hook). Rules and examples: CONTRIBUTING.md.
//
// This repository is three separate actions over one shared layer, so the scope
// carries routing information the type cannot: it says whether a change is to
// the infrastructure every action shares, or to one action's own behaviour.
// That distinction is the repository's whole point — a change scoped to an
// action must not be a change to `core/` wearing an action's name.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        // The shared layer. Infrastructure only: no action's policy lives here,
        // and `pnpm arch` is what judges that.
        "core",

        // The actions — one scope each. A new action adds a scope here in the
        // commit that adds the action.
        "triage",
        "review",
        "harmonise",

        // Everything else.
        "docs",
        "workspace", // release-please's release pull request uses this scope
        "evaluation", // the offline corpus and evaluator under evaluation/
        "deps", // Renovate writes chore(deps):
        "ci", // Renovate writes chore(ci):
      ],
    ],
    "body-max-line-length": [0],
  },
};

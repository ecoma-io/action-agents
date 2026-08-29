// The dogfood fixtures this repository's own review policy runs against —
// the three pull-request shapes the applicability design names (#192's
// Release Please automation, #193's maintainer docs change, a synthetic
// first-time fork), as raw event payload fragments plus the dogfood policy.
// Shared by the applicability engine tests and the run-orchestrator tests so
// the recorded behaviour and the live derivation stay one fixture set.

/** The full name of this repository, as the event payload reports it. */
export const BASE_REPO_FULL_NAME = "ecoma-io/action-agents";

/**
 * #192 — Release Please, the repository's own automation identity: a Bot
 * user, `NONE` association, a same-repo head, and the release-please branch
 * and title conventions.
 */
export const RELEASE_AUTOMATION = {
  number: 192,
  user: { login: "ecoma-io", type: "Bot" },
  author_association: "NONE",
  head: {
    ref: "release-please--branches--main--components--action-agents",
    sha: "c".repeat(40),
    repo: { full_name: BASE_REPO_FULL_NAME },
  },
  base: { ref: "main", sha: "d".repeat(40) },
  title: "chore(workspace): release 0.6.0",
};

/** #193 — a maintainer's docs change: write-class association, same repo. */
export const MAINTAINER_DOCS = {
  number: 193,
  user: { login: "johnitvn", type: "User" },
  author_association: "MEMBER",
  head: {
    ref: "docs/applicability",
    sha: "e".repeat(40),
    repo: { full_name: BASE_REPO_FULL_NAME },
  },
  base: { ref: "main", sha: "d".repeat(40) },
  title: "docs(review): document the applicability policy",
};

/** A synthetic first-time fork — the external context, never skippable. */
export const FIRST_TIME_FORK = {
  number: 194,
  user: { login: "new-contributor", type: "User" },
  author_association: "FIRST_TIME_CONTRIBUTOR",
  head: {
    ref: "patch-1",
    sha: "f".repeat(40),
    repo: { full_name: "new-contributor/action-agents" },
  },
  base: { ref: "main", sha: "d".repeat(40) },
  title: "fix(review): a tweak from a fork",
};

/** The dogfood policy as a config object. */
export const DOGFOOD_POLICY = {
  applicability: {
    bots: ["ecoma-io", "dependabot[bot]"],
    rules: [
      {
        id: "release-prs",
        context: "automation",
        when: {
          title: "^chore(\\([\\w-]+\\))?: release",
          branch: "^release-please--",
        },
        run: false,
      },
    ],
  },
};

/** The dogfood policy as a review.json5 body — JSON is valid JSON5. */
export const DOGFOOD_CONFIG = JSON.stringify({ schemaVersion: 1, ...DOGFOOD_POLICY });

/**
 * The dogfood policy with the posture axis in effect: the same release skip,
 * plus the maintainer posture for docs changes under a docs-scoped rule —
 * the #193 shape. The instruction is a policy-source-relative document path;
 * its content is {@link DOGFOOD_POSTURE_DOCUMENT} at
 * {@link DOGFOOD_POSTURE_DOCUMENT_PATH}.
 */
export const DOGFOOD_POSTURE_POLICY = {
  applicability: {
    bots: ["ecoma-io", "dependabot[bot]"],
    rules: [
      DOGFOOD_POLICY.applicability.rules[0],
      {
        id: "docs-maintainer",
        context: "maintainer",
        when: { paths: ["docs/**"] },
        posture: "maintainer",
        instruction: ".github/action-agents/review/postures/docs.md",
      },
    ],
  },
};

/** The posture dogfood policy as a review.json5 body. */
export const DOGFOOD_POSTURE_CONFIG = JSON.stringify({
  schemaVersion: 1,
  ...DOGFOOD_POSTURE_POLICY,
});

/** Where the maintainer posture's document lives on the policy source. */
export const DOGFOOD_POSTURE_DOCUMENT_PATH = ".github/action-agents/review/postures/docs.md";

/** A mode-scoped maintainer instruction, well under the byte cap. */
export const DOGFOOD_POSTURE_DOCUMENT = [
  "# Maintainer posture",
  "",
  "The author maintains this repository. Narrow the rubric to what a",
  "maintainer's own branch still needs:",
  "",
  "- A docs change is judged on accuracy against the code it describes, not",
  "  on prose style.",
  "- Do not report conventions the repository's own history contradicts.",
  "- Nits that a maintainer would not block on are still welcome, clearly",
  "  marked as nits.",
].join("\n");

/**
 * The dogfood policy with the intensity axis in effect: the same release
 * skip, the docs-maintainer rule now carrying its posture document and a
 * `low` strictness override — a maintainer's own docs change runs shallower
 * — plus an external rule deepening review on the core sources. Deepening
 * needs no context; the lowering is anchored to the immune maintainer one.
 * The instruction is {@link DOGFOOD_POSTURE_DOCUMENT} at
 * {@link DOGFOOD_POSTURE_DOCUMENT_PATH}.
 */
export const DOGFOOD_INTENSITY_POLICY = {
  applicability: {
    bots: ["ecoma-io", "dependabot[bot]"],
    rules: [
      DOGFOOD_POLICY.applicability.rules[0],
      {
        id: "docs-maintainer",
        context: "maintainer",
        when: { paths: ["docs/**"] },
        posture: "maintainer",
        instruction: ".github/action-agents/review/postures/docs.md",
        intensity: { strictness: "low" },
      },
      {
        id: "core-external",
        context: "external",
        when: { paths: ["core/src/**"] },
        intensity: { strictness: "high" },
      },
    ],
  },
};

/** The intensity dogfood policy as a review.json5 body — JSON is valid JSON5. */
export const DOGFOOD_INTENSITY_CONFIG = JSON.stringify({
  schemaVersion: 1,
  ...DOGFOOD_INTENSITY_POLICY,
});

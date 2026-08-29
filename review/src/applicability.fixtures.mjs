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

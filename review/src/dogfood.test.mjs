/**
 * The repository's own policy, replayed — the self-dogfood evidence.
 *
 * `.github/action-agents/review/review.json5` is read by the production
 * loader, validated by the production validator, and its eligibility rules
 * are evaluated with the production evaluator against the real author
 * shapes this repository sees: the release-please pull request (the exact
 * shape of #335), an unlisted bot, a human maintainer, and an oversized
 * human change. The configuration is product input here — editing it badly
 * fails this suite, the same way editing source badly fails its tests.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadConfigFile, validateConfig } from "./config.mjs";
import {
  changeTotals,
  classificationInputs,
  classifyContext,
  evaluateApplicability,
} from "./applicability.mjs";

const OWN_POLICY = ".github/action-agents/review/review.json5";

/** The production reader, pointed at the working tree. */
const forge = {
  /** @param {string} path */
  async getContents(path) {
    if (path !== OWN_POLICY) return null;
    return {
      content: readFileSync(fileURLToPath(new URL(`../../${OWN_POLICY}`, import.meta.url)), "utf8"),
    };
  },
};

/** Load and validate the repository's own policy the way a run does. */
async function ownPolicy() {
  /** @type {import("#core/policy.mjs").PolicySource} */
  const source = { basis: "base", branch: "main", sha: "0".repeat(40) };
  const { raw } = await loadConfigFile({ forge, configPath: "", source });
  return validateConfig(raw);
}

/**
 * The exact evaluation block a run performs, over one real shape: the
 * pull-request payload drives classification, the snapshot facts drive the
 * eligibility evaluation.
 *
 * @param {import("./applicability.mjs").ApplicabilityPolicy | undefined} applicability
 * @param {{ number: number, login: string, type: string, association: string, branch: string, title: string, labels?: string[], files?: import("./inventory.mjs").PullRequestFile[] }} shape
 */
function decide(applicability, shape) {
  const payload = {
    number: shape.number,
    user: { login: shape.login, type: shape.type },
    author_association: shape.association,
    head: {
      ref: shape.branch,
      sha: "b2c3d4e5f60718293a4b5c6d7e8f901234567890",
      repo: { full_name: "ecoma-io/action-agents" },
    },
    base: { ref: "main" },
  };
  const cls = classificationInputs(payload, "ecoma-io/action-agents", applicability?.bots ?? []);
  const derived = classifyContext(cls);
  const evaluated = evaluateApplicability({
    policy: applicability ?? { bots: [], rules: [] },
    context: derived.context,
    title: shape.title,
    branch: shape.branch,
    base: "main",
    labels: shape.labels ?? [],
    author: { login: cls.authorLogin, isBot: cls.authorType === "Bot" },
    changes: shape.files === undefined ? null : changeTotals(shape.files),
    paths: [],
  });
  return { cls, derived, evaluated };
}

describe("the repository's own eligibility policy", () => {
  it("validates through the production loader, three rules, one allowlisted bot", async () => {
    const config = await ownPolicy();
    expect(config.applicability?.bots).toEqual(["ecoma-io[bot]"]);
    expect(config.applicability?.rules.map((rule) => rule.id)).toEqual([
      "release-prs",
      "unlisted-bots",
      "oversized",
    ]);
  });

  it("the release pull request skips by its pinned context (#335's shape)", async () => {
    const { derived, evaluated } = decide(await ownPolicy().then((c) => c.applicability), {
      number: 335,
      login: "ecoma-io[bot]",
      type: "Bot",
      association: "CONTRIBUTOR",
      branch: "release-please--branches--main--components--action-agents",
      title: "chore(workspace): release 0.8.4",
    });
    expect(derived.context).toBe("automation");
    expect(derived.inputs.authorType).toBe("bot-allowlisted");
    expect(evaluated).toMatchObject({
      applicable: false,
      matchedRule: "release-prs",
    });
  });

  it("an unlisted bot skips by the attestation, classified external", async () => {
    const { derived, evaluated } = decide(await ownPolicy().then((c) => c.applicability), {
      number: 7,
      login: "renovate[bot]",
      type: "Bot",
      association: "NONE",
      branch: "renovate/vite-8.x",
      title: "chore(deps): update vite to 8.2.1",
    });
    expect(derived.context).toBe("external");
    expect(derived.inputs.authorType).toBe("bot-unlisted");
    expect(evaluated).toMatchObject({
      applicable: false,
      matchedRule: "unlisted-bots",
    });
  });

  it("a human maintainer's pull request stays reviewable", async () => {
    const { derived, evaluated } = decide(await ownPolicy().then((c) => c.applicability), {
      number: 339,
      login: "johnitvn",
      type: "User",
      association: "MEMBER",
      branch: "johnitvn/review-eligibility-policy",
      title: "feat(review): the review eligibility policy",
      files: [
        { filename: "review/src/run.mjs", status: "modified", additions: 120, deletions: 30 },
        { filename: "review/src/run.test.mjs", status: "modified", additions: 40, deletions: 10 },
      ],
    });
    expect(derived.context).toBe("maintainer");
    expect(evaluated).toMatchObject({ applicable: true, matchedRule: null });
  });

  it("an oversized human change skips with its measured totals", async () => {
    const applicability = (await ownPolicy()).applicability;
    const files = [
      { filename: "src/generated-000.mjs", status: "modified", additions: 6000, deletions: 0 },
      { filename: "src/generated-001.mjs", status: "modified", additions: 4000, deletions: 0 },
    ];
    const { evaluated } = decide(applicability, {
      number: 340,
      login: "johnitvn",
      type: "User",
      association: "MEMBER",
      branch: "codegen/regenerate-all",
      title: "chore: regenerate the generated modules",
      files,
    });
    expect(evaluated).toMatchObject({
      applicable: false,
      matchedRule: "oversized",
    });
    expect(changeTotals(files)).toEqual({ files: 2, lines: 10000 });
  });

  it("pre-ignore totals below the guard stay reviewable — the ignored paths change nothing here", async () => {
    // The guard reads pre-ignore totals by design, so whether these paths
    // sit in the scope layer's ignore set is irrelevant to it: 7500 < 8000
    // is reviewable at the eligibility stage. (Downstream, an
    // ignored-paths-only change meets an empty universe and becomes the
    // nothing-to-review skip — the scope layer's own honest outcome.)
    const { evaluated } = decide(await ownPolicy().then((c) => c.applicability), {
      number: 341,
      login: "johnitvn",
      type: "User",
      association: "MEMBER",
      branch: "chore/skill-sync",
      title: "chore: sync vendored skills",
      files: [
        { filename: ".claude/skills/a.md", status: "modified", additions: 4000, deletions: 1000 },
        { filename: ".agents/skills/a.md", status: "modified", additions: 2000, deletions: 500 },
      ],
    });
    expect(evaluated).toMatchObject({ applicable: true, matchedRule: null });
  });
});

// Tests for the applicability engine — the pure module. The classification
// derivation is proven against the dogfood fixtures and its adversarial
// edges (case-sensitive logins, unallowlisted bots, deleted heads, absent
// payloads); the rule evaluation is proven first-match and dialect-faithful;
// every validation refusal is proven red before any model call could run.

import { describe, expect, it } from "vitest";

import {
  classificationInputs,
  classifyContext,
  evaluateApplicability,
  validateApplicabilityPolicy,
} from "./applicability.mjs";
import {
  BASE_REPO_FULL_NAME,
  DOGFOOD_POLICY,
  FIRST_TIME_FORK,
  MAINTAINER_DOCS,
  RELEASE_AUTOMATION,
} from "./applicability.fixtures.mjs";

describe("context classification", () => {
  it("reads the release-automation fixture as automation", () => {
    const derived = classifyContext(
      classificationInputs(
        RELEASE_AUTOMATION,
        BASE_REPO_FULL_NAME,
        DOGFOOD_POLICY.applicability.bots,
      ),
    );
    expect(derived.context).toBe("automation");
    expect(derived.inputs).toEqual({
      association: "NONE",
      head: "same-repo",
      authorType: "bot-allowlisted",
    });
  });

  it("reads the maintainer fixture as maintainer", () => {
    const derived = classifyContext(
      classificationInputs(MAINTAINER_DOCS, BASE_REPO_FULL_NAME, DOGFOOD_POLICY.applicability.bots),
    );
    expect(derived.context).toBe("maintainer");
    expect(derived.inputs).toEqual({
      association: "MEMBER",
      head: "same-repo",
      authorType: "human",
    });
  });

  it("reads the fork fixture as external", () => {
    const derived = classifyContext(
      classificationInputs(FIRST_TIME_FORK, BASE_REPO_FULL_NAME, DOGFOOD_POLICY.applicability.bots),
    );
    expect(derived.context).toBe("external");
    expect(derived.inputs).toEqual({
      association: "FIRST_TIME_CONTRIBUTOR",
      head: "fork",
      authorType: "human",
    });
  });

  it("matches bot logins case-sensitively — a look-alike falls through, not down", () => {
    const inputs = classificationInputs(
      { ...RELEASE_AUTOMATION, user: { login: "Ecoma-IO", type: "Bot" } },
      BASE_REPO_FULL_NAME,
      DOGFOOD_POLICY.applicability.bots,
    );
    const derived = classifyContext(inputs);
    expect(derived.context).toBe("external");
    expect(derived.inputs.authorType).toBe("bot-unlisted");
  });

  it("never promotes an allowlisted login without the Bot type", () => {
    const inputs = classificationInputs(
      { ...RELEASE_AUTOMATION, user: { login: "ecoma-io", type: "User" } },
      BASE_REPO_FULL_NAME,
      DOGFOOD_POLICY.applicability.bots,
    );
    const derived = classifyContext(inputs);
    expect(derived.context).toBe("external");
    expect(derived.inputs.authorType).toBe("human");
  });

  it("leaves an unallowlisted bot outside automation — a NONE association never rescues it", () => {
    const inputs = classificationInputs(
      { ...RELEASE_AUTOMATION, user: { login: "renovate[bot]", type: "Bot" } },
      BASE_REPO_FULL_NAME,
      DOGFOOD_POLICY.applicability.bots,
    );
    const derived = classifyContext(inputs);
    expect(derived.context).toBe("external");
    expect(derived.inputs.authorType).toBe("bot-unlisted");
  });

  it("counts a write-class association for an unallowlisted bot — never demoted", () => {
    const inputs = classificationInputs(
      {
        ...RELEASE_AUTOMATION,
        user: { login: "renovate[bot]", type: "Bot" },
        author_association: "OWNER",
      },
      BASE_REPO_FULL_NAME,
      DOGFOOD_POLICY.applicability.bots,
    );
    const derived = classifyContext(inputs);
    expect(derived.context).toBe("maintainer");
    expect(derived.inputs.authorType).toBe("bot-unlisted");
  });

  it("demotes a write-class author to external when the head repository is deleted", () => {
    const inputs = classificationInputs(
      { ...MAINTAINER_DOCS, head: { ref: "gone", sha: "0".repeat(40) } },
      BASE_REPO_FULL_NAME,
      DOGFOOD_POLICY.applicability.bots,
    );
    const derived = classifyContext(inputs);
    expect(derived.context).toBe("external");
    expect(derived.inputs.head).toBe("deleted");
  });

  it("normalises an absent payload to honest absence, never a crash", () => {
    const inputs = classificationInputs(
      undefined,
      BASE_REPO_FULL_NAME,
      DOGFOOD_POLICY.applicability.bots,
    );
    expect(inputs).toEqual({
      bots: DOGFOOD_POLICY.applicability.bots,
      authorLogin: "",
      authorType: "",
      association: "NONE",
      headRepoFullName: null,
      baseRepoFullName: BASE_REPO_FULL_NAME,
    });
    const derived = classifyContext(inputs);
    expect(derived.context).toBe("external");
    expect(derived.inputs.authorType).toBe("unknown");
  });

  it("is deterministic — the same payload classifies identically on replay", () => {
    for (const fixture of [RELEASE_AUTOMATION, MAINTAINER_DOCS, FIRST_TIME_FORK]) {
      const first = JSON.stringify(
        classifyContext(
          classificationInputs(fixture, BASE_REPO_FULL_NAME, DOGFOOD_POLICY.applicability.bots),
        ),
      );
      const replay = JSON.stringify(
        classifyContext(
          classificationInputs(fixture, BASE_REPO_FULL_NAME, DOGFOOD_POLICY.applicability.bots),
        ),
      );
      expect(replay).toBe(first);
    }
  });
});

describe("rule evaluation", () => {
  it("skips the #192 fixture on the dogfood automation rule", () => {
    const policy = validateApplicabilityPolicy(DOGFOOD_POLICY.applicability);
    const derived = classifyContext(
      classificationInputs(RELEASE_AUTOMATION, BASE_REPO_FULL_NAME, policy.bots),
    );
    const evaluated = evaluateApplicability({
      policy,
      context: derived.context,
      title: RELEASE_AUTOMATION.title,
      branch: RELEASE_AUTOMATION.head.ref,
      paths: null,
    });
    expect(evaluated).toEqual({ applicable: false, matchedRule: "release-prs", basis: "rule" });
  });

  it("defaults a maintainer docs change to full review — the rule's context does not apply", () => {
    const policy = validateApplicabilityPolicy(DOGFOOD_POLICY.applicability);
    const derived = classifyContext(
      classificationInputs(MAINTAINER_DOCS, BASE_REPO_FULL_NAME, policy.bots),
    );
    const evaluated = evaluateApplicability({
      policy,
      context: derived.context,
      title: MAINTAINER_DOCS.title,
      branch: MAINTAINER_DOCS.head.ref,
      paths: ["docs/development/review.md"],
    });
    expect(evaluated).toEqual({ applicable: true, matchedRule: null, basis: "default" });
  });

  it("matches in config order, first match wins", () => {
    const policy = validateApplicabilityPolicy({
      bots: ["ecoma-io"],
      rules: [
        { id: "first", context: "automation", when: { title: "release" }, run: false },
        { id: "second", context: "automation", when: { title: "release" }, run: false },
      ],
    });
    const evaluated = evaluateApplicability({
      policy,
      context: "automation",
      title: "chore: release 1.2.3",
      branch: "release-please--main",
      paths: null,
    });
    expect(evaluated.matchedRule).toBe("first");
  });

  it("records a matching run: true rule — applicability is recorded, review runs", () => {
    const policy = validateApplicabilityPolicy({
      bots: ["ecoma-io"],
      rules: [{ id: "own-bots", context: "automation" }],
    });
    const evaluated = evaluateApplicability({
      policy,
      context: "automation",
      title: "chore(deps): bump",
      branch: "dependabot/npm_and_yarn/foo",
      paths: null,
    });
    expect(evaluated).toEqual({ applicable: true, matchedRule: "own-bots", basis: "rule" });
  });

  it("matches a contextless rule against any context", () => {
    const policy = validateApplicabilityPolicy({
      rules: [{ id: "wip", when: { title: "^\\[wip\\]" }, run: true }],
    });
    for (const context of /** @type {const} */ (["automation", "maintainer", "external"])) {
      const evaluated = evaluateApplicability({
        policy,
        context,
        title: "[wip] speculative",
        branch: "wip",
        paths: null,
      });
      expect(evaluated).toEqual({ applicable: true, matchedRule: "wip", basis: "rule" });
    }
  });

  it("treats a null paths listing as no match for a paths condition", () => {
    const policy = validateApplicabilityPolicy({
      rules: [{ id: "docs", context: "maintainer", when: { paths: ["docs/**"] }, run: false }],
    });
    const evaluated = evaluateApplicability({
      policy,
      context: "maintainer",
      title: "docs: x",
      branch: "docs/x",
      paths: null,
    });
    expect(evaluated).toEqual({ applicable: true, matchedRule: null, basis: "default" });
  });

  it("speaks the one glob dialect — negations exclude paths from the match", () => {
    const policy = validateApplicabilityPolicy({
      rules: [
        {
          id: "public-handbook",
          context: "maintainer",
          when: { paths: ["handbook/**", "!handbook/private/**"] },
          run: false,
        },
      ],
    });
    /** @param {string[] | null} paths */
    const evaluate = (paths) =>
      evaluateApplicability({
        policy,
        context: "maintainer",
        title: "handbook: x",
        branch: "handbook/x",
        paths,
      });
    expect(evaluate(["handbook/a.md"]).matchedRule).toBe("public-handbook");
    expect(evaluate(["src/a.mjs", "handbook/b.md"]).matchedRule).toBe("public-handbook");
    expect(evaluate(["handbook/private/a.md"]).matchedRule).toBe(null);
    expect(evaluate(["handbook/a.md", "handbook/private/a.md", "src/a.mjs"]).matchedRule).toBe(
      "public-handbook",
    );
  });

  it("is deterministic — the same inputs evaluate identically on replay", () => {
    const policy = validateApplicabilityPolicy(DOGFOOD_POLICY.applicability);
    const args = /** @type {Parameters<typeof evaluateApplicability>[0]} */ ({
      policy,
      context: "automation",
      title: RELEASE_AUTOMATION.title,
      branch: RELEASE_AUTOMATION.head.ref,
      paths: null,
    });
    expect(JSON.stringify(evaluateApplicability(args))).toBe(
      JSON.stringify(evaluateApplicability(args)),
    );
  });
});

describe("policy validation refusals", () => {
  /** @param {unknown} applicability @returns {string} */
  const refused = (applicability) => {
    try {
      validateApplicabilityPolicy(applicability);
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
    throw new Error(`expected a refusal for ${JSON.stringify(applicability)}`);
  };

  it("refuses a non-object policy", () => {
    expect(refused(42)).toMatch(/must be an object/);
    expect(refused("skip")).toMatch(/must be an object/);
    expect(refused([])).toMatch(/must be an object/);
    expect(refused(null)).toMatch(/must be an object/);
  });

  it("refuses later-PR surface as unknown keys, never silently ignored", () => {
    expect(refused({ posture: {} })).toMatch(/unknown key 'posture'/);
    expect(refused({ intensity: {} })).toMatch(/unknown key 'intensity'/);
    expect(refused({ instructions: { instruction: "x" } })).toMatch(/unknown key 'instructions'/);
  });

  it("refuses a malformed bots allowlist", () => {
    expect(refused({ bots: "ecoma-io" })).toMatch(/bots must be an array/);
    expect(refused({ bots: [42] })).toMatch(/non-empty login/);
    expect(refused({ bots: [""] })).toMatch(/non-empty login/);
  });

  it("refuses a malformed rule list", () => {
    expect(refused({ rules: {} })).toMatch(/rules must be an array/);
    expect(refused({ rules: [42] })).toMatch(/must be an object/);
    expect(refused({ rules: [{ context: "automation", run: false }] })).toMatch(
      /\.id must be a non-empty string/,
    );
    expect(refused({ rules: [{ id: "x" }, { id: "x" }] })).toMatch(/repeats id 'x'/);
  });

  it("refuses an unknown context", () => {
    expect(refused({ rules: [{ id: "x", context: "fork" }] })).toMatch(
      /context must be one of automation, maintainer, external/,
    );
  });

  it("refuses a non-boolean run", () => {
    expect(refused({ rules: [{ id: "x", context: "maintainer", run: "false" }] })).toMatch(
      /run must be true or false/,
    );
  });

  it("refuses an external-skipping rule — the frozen context", () => {
    expect(refused({ rules: [{ id: "x", context: "external", run: false }] })).toMatch(
      /external context is frozen/,
    );
  });

  it("refuses a run: false rule without a context — conventions never govern alone", () => {
    expect(refused({ rules: [{ id: "x", run: false }] })).toMatch(/without a context/);
  });

  it("refuses an automation skip with an empty allowlist", () => {
    expect(refused({ bots: [], rules: [{ id: "x", context: "automation", run: false }] })).toMatch(
      /allowlist\s+is empty/,
    );
  });

  it("refuses malformed when conditions", () => {
    expect(refused({ rules: [{ id: "x", when: "chore" }] })).toMatch(/when must be an object/);
    expect(refused({ rules: [{ id: "x", when: { instruction: "x" } }] })).toMatch(
      /when holds unknown key 'instruction'/,
    );
    expect(refused({ rules: [{ id: "x", when: { title: "" } }] })).toMatch(
      /non-empty regular-expression source/,
    );
    expect(refused({ rules: [{ id: "x", when: { title: "[" } }] })).toMatch(
      /does not compile as a regular expression/,
    );
    expect(refused({ rules: [{ id: "x", when: { branch: "(" } }] })).toMatch(
      /does not compile as a regular expression/,
    );
    expect(refused({ rules: [{ id: "x", when: { paths: [] } }] })).toMatch(
      /non-empty array of globs/,
    );
    expect(refused({ rules: [{ id: "x", when: { paths: [""] } }] })).toMatch(/dialect rejects/);
    expect(refused({ rules: [{ id: "x", when: { paths: ["!"] } }] })).toMatch(/dialect rejects/);
    expect(refused({ rules: [{ id: "x", when: { paths: "docs/**" } }] })).toMatch(
      /non-empty array of globs/,
    );
  });

  it("accepts the dogfood policy and normalises it", () => {
    const policy = validateApplicabilityPolicy(DOGFOOD_POLICY.applicability);
    expect(policy.bots).toEqual(["ecoma-io", "dependabot[bot]"]);
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]).toEqual({
      id: "release-prs",
      context: "automation",
      when: {
        title: /^chore(\([\w-]+\))?: release/,
        branch: /^release-please--/,
      },
      run: false,
    });
  });

  it("accepts an empty policy — declared but inert", () => {
    const policy = validateApplicabilityPolicy({ rules: [] });
    expect(policy).toEqual({ bots: [], rules: [] });
  });
});

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
  DOGFOOD_INTENSITY_POLICY,
  DOGFOOD_POLICY,
  DOGFOOD_POSTURE_DOCUMENT_PATH,
  DOGFOOD_POSTURE_POLICY,
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
    const policy = validateApplicabilityPolicy(DOGFOOD_POLICY.applicability, "medium");
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
    expect(evaluated).toEqual({
      applicable: false,
      matchedRule: "release-prs",
      basis: "rule",
      posture: "standard",
    });
  });

  it("defaults a maintainer docs change to full review — the rule's context does not apply", () => {
    const policy = validateApplicabilityPolicy(DOGFOOD_POLICY.applicability, "medium");
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
    expect(evaluated).toEqual({
      applicable: true,
      matchedRule: null,
      basis: "default",
      posture: "standard",
    });
  });

  it("matches in config order, first match wins", () => {
    const policy = validateApplicabilityPolicy(
      {
        bots: ["ecoma-io"],
        rules: [
          { id: "first", context: "automation", when: { title: "release" }, run: false },
          { id: "second", context: "automation", when: { title: "release" }, run: false },
        ],
      },
      "medium",
    );
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
    const policy = validateApplicabilityPolicy(
      {
        bots: ["ecoma-io"],
        rules: [{ id: "own-bots", context: "automation" }],
      },
      "medium",
    );
    const evaluated = evaluateApplicability({
      policy,
      context: "automation",
      title: "chore(deps): bump",
      branch: "dependabot/npm_and_yarn/foo",
      paths: null,
    });
    expect(evaluated).toEqual({
      applicable: true,
      matchedRule: "own-bots",
      basis: "rule",
      posture: "standard",
    });
  });

  it("matches a contextless rule against any context", () => {
    const policy = validateApplicabilityPolicy(
      {
        rules: [{ id: "wip", when: { title: "^\\[wip\\]" }, run: true }],
      },
      "medium",
    );
    for (const context of /** @type {const} */ (["automation", "maintainer", "external"])) {
      const evaluated = evaluateApplicability({
        policy,
        context,
        title: "[wip] speculative",
        branch: "wip",
        paths: null,
      });
      expect(evaluated).toEqual({
        applicable: true,
        matchedRule: "wip",
        basis: "rule",
        posture: "standard",
      });
    }
  });

  it("treats a null paths listing as no match for a paths condition", () => {
    const policy = validateApplicabilityPolicy(
      {
        rules: [{ id: "docs", context: "maintainer", when: { paths: ["docs/**"] }, run: false }],
      },
      "medium",
    );
    const evaluated = evaluateApplicability({
      policy,
      context: "maintainer",
      title: "docs: x",
      branch: "docs/x",
      paths: null,
    });
    expect(evaluated).toEqual({
      applicable: true,
      matchedRule: null,
      basis: "default",
      posture: "standard",
    });
  });

  it("speaks the one glob dialect — negations exclude paths from the match", () => {
    const policy = validateApplicabilityPolicy(
      {
        rules: [
          {
            id: "public-handbook",
            context: "maintainer",
            when: { paths: ["handbook/**", "!handbook/private/**"] },
            run: false,
          },
        ],
      },
      "medium",
    );
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
    const policy = validateApplicabilityPolicy(DOGFOOD_POLICY.applicability, "medium");
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
      validateApplicabilityPolicy(applicability, "medium");
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
    const policy = validateApplicabilityPolicy(DOGFOOD_POLICY.applicability, "medium");
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
    const policy = validateApplicabilityPolicy({ rules: [] }, "medium");
    expect(policy).toEqual({ bots: [], rules: [] });
  });
});

describe("the posture axis", () => {
  /**
   * @param {typeof import("./applicability.fixtures.mjs").RELEASE_AUTOMATION} fixture
   * @param {{ bots: string[], rules: import("./applicability.mjs").ApplicabilityRule[] }} policy
   * @param {string[] | null} paths
   */
  const evaluate = (fixture, policy, paths) => {
    const derived = classifyContext(
      classificationInputs(fixture, BASE_REPO_FULL_NAME, policy.bots),
    );
    return {
      derived,
      evaluated: evaluateApplicability({
        policy,
        context: derived.context,
        title: fixture.title,
        branch: fixture.head.ref,
        paths,
      }),
    };
  };

  it("evaluates the #193-shaped docs change into the maintainer posture with its document", () => {
    const policy = validateApplicabilityPolicy(DOGFOOD_POSTURE_POLICY.applicability, "medium");
    const { evaluated } = evaluate(MAINTAINER_DOCS, policy, ["docs/development/review.md"]);
    expect(evaluated).toEqual({
      applicable: true,
      matchedRule: "docs-maintainer",
      basis: "rule",
      posture: "maintainer",
      instruction: DOGFOOD_POSTURE_DOCUMENT_PATH,
    });
  });

  it("classifies the #192 fixture identically under the posture policy — no cross-PR drift", () => {
    const policy = validateApplicabilityPolicy(DOGFOOD_POSTURE_POLICY.applicability, "medium");
    const { evaluated } = evaluate(RELEASE_AUTOMATION, policy, null);
    expect(evaluated).toEqual({
      applicable: false,
      matchedRule: "release-prs",
      basis: "rule",
      posture: "standard",
      instruction: undefined,
    });
  });

  it("leaves the external fixture on the default — a maintainer rule never reaches a fork", () => {
    const policy = validateApplicabilityPolicy(DOGFOOD_POSTURE_POLICY.applicability, "medium");
    const { evaluated } = evaluate(FIRST_TIME_FORK, policy, ["docs/guide.md"]);
    expect(evaluated).toEqual({
      applicable: true,
      matchedRule: null,
      basis: "default",
      posture: "standard",
      instruction: undefined,
    });
  });

  /**
   * A rule refused-at-validation candidate: id and an immune maintainer
   * context pre-set, the disputed keys spread in.
   *
   * @param {Record<string, unknown>} rule
   * @returns {() => void}
   */
  const refused = (rule) => () =>
    validateApplicabilityPolicy(
      {
        bots: ["acme"],
        rules: [/** @type {any} */ ({ id: "x", context: "maintainer", run: true, ...rule })],
      },
      "medium",
    );

  it("refuses an unknown posture value — the set is fixed in code", () => {
    expect(refused({ posture: "relaxed", instruction: ".github/postures/x.md" })).toThrow(
      /must be one of standard, maintainer, automation/,
    );
  });

  it("refuses the default restated as a posture", () => {
    expect(refused({ posture: "standard" })).toThrow(/the default restated is dead weight/);
  });

  it("refuses a non-standard posture without an immune context", () => {
    expect(
      refused({
        context: undefined,
        posture: "maintainer",
        instruction: ".github/postures/docs.md",
      }),
    ).toThrow(/a convention never governs alone/);
  });

  it("refuses reframing the frozen external context off the standard posture", () => {
    expect(() =>
      validateApplicabilityPolicy(
        {
          bots: ["acme"],
          rules: [
            /** @type {any} */ ({
              id: "x",
              context: "external",
              run: true,
              posture: "automation",
              instruction: ".github/postures/auto.md",
            }),
          ],
        },
        "medium",
      ),
    ).toThrow(/external context is frozen/);
  });

  it("refuses a posture on a skipped run — dead weight", () => {
    expect(
      refused({ run: false, posture: "maintainer", instruction: ".github/postures/docs.md" }),
    ).toThrow(/run: false ends the run before a posture could apply/);
  });
  it("refuses an instruction without a non-standard posture", () => {
    expect(refused({ instruction: ".github/postures/docs.md" })).toThrow(
      /nothing to be the document of/,
    );
  });
  it("refuses a posture without its document — a non-standard posture is never a second engine", () => {
    expect(refused({ posture: "maintainer" })).toThrow(/without an instruction/);
  });
  it("refuses a malformed instruction path", () => {
    expect(refused({ posture: "maintainer", instruction: "" })).toThrow(/must be a document path/);
    expect(refused({ posture: "maintainer", instruction: 42 })).toThrow(/must be a document path/);
  });

  it("keeps a validated posture rule's shape exact — posture and instruction ride together", () => {
    const policy = validateApplicabilityPolicy(DOGFOOD_POSTURE_POLICY.applicability, "medium");
    expect(policy.rules[1]).toEqual({
      id: "docs-maintainer",
      context: "maintainer",
      when: { paths: ["docs/**"] },
      run: true,
      posture: "maintainer",
      instruction: ".github/action-agents/review/postures/docs.md",
    });
  });
});

describe("the intensity axis", () => {
  /** @returns {ReturnType<typeof validateApplicabilityPolicy>} */
  const dogfoodIntensity = () =>
    validateApplicabilityPolicy(DOGFOOD_INTENSITY_POLICY.applicability, "medium");

  /**
   * @param {typeof import("./applicability.fixtures.mjs").RELEASE_AUTOMATION} fixture
   * @param {import("./applicability.mjs").ApplicabilityPolicy} policy
   * @param {string[] | null} paths
   */
  const evaluate = (fixture, policy, paths) => {
    const derived = classifyContext(
      classificationInputs(fixture, BASE_REPO_FULL_NAME, policy.bots),
    );
    return evaluateApplicability({
      policy,
      context: derived.context,
      title: fixture.title,
      branch: fixture.head.ref,
      paths,
    });
  };

  /**
   * A refused-at-validation candidate: id and an immune maintainer context
   * pre-set, the disputed keys spread in. The baseline is the file's own
   * `medium`.
   *
   * @param {Record<string, unknown>} rule
   * @returns {() => void}
   */
  const refused = (rule) => () =>
    validateApplicabilityPolicy(
      {
        bots: ["acme"],
        rules: [/** @type {any} */ ({ id: "x", context: "maintainer", run: true, ...rule })],
      },
      "medium",
    );

  it("rides the matched rule's override onto the verdict — absolute, the run's own dial", () => {
    expect(evaluate(MAINTAINER_DOCS, dogfoodIntensity(), ["docs/development/review.md"])).toEqual({
      applicable: true,
      matchedRule: "docs-maintainer",
      basis: "rule",
      posture: "maintainer",
      instruction: DOGFOOD_POSTURE_DOCUMENT_PATH,
      intensity: { strictness: "low" },
    });
  });

  it("deepens an external pull request with no context — the only contextless key", () => {
    expect(evaluate(FIRST_TIME_FORK, dogfoodIntensity(), ["core/src/glob.mjs"])).toEqual({
      applicable: true,
      matchedRule: "core-external",
      basis: "rule",
      posture: "standard",
      instruction: undefined,
      intensity: { strictness: "high" },
    });
  });

  it("leaves the defaults' verdict empty — no matched rule, no override", () => {
    expect(evaluate(FIRST_TIME_FORK, dogfoodIntensity(), ["README.md"])).toEqual({
      applicable: true,
      matchedRule: null,
      basis: "default",
      posture: "standard",
      instruction: undefined,
      intensity: undefined,
    });
  });

  it("refuses an unknown arm — the set is fixed in code", () => {
    expect(refused({ intensity: { strictness: "stricter" } })).toThrow(
      /must be one of low, medium, high — got 'stricter'/,
    );
  });

  it("refuses a second delta — intensity carries strictness alone in v1", () => {
    expect(refused({ intensity: { strictness: "low", nitDrop: true } })).toThrow(
      /unknown key 'nitDrop'/,
    );
  });

  it("refuses a non-object intensity", () => {
    expect(refused({ intensity: "low" })).toThrow(/must be an object holding strictness/);
  });

  it("refuses lowering without an immune context — a convention never governs alone", () => {
    expect(refused({ context: undefined, intensity: { strictness: "low" } })).toThrow(
      /lowers intensity without a context/,
    );
  });

  it("refuses lowering the frozen external context", () => {
    expect(() =>
      validateApplicabilityPolicy(
        {
          bots: ["acme"],
          rules: [
            /** @type {any} */ ({
              id: "x",
              context: "external",
              run: true,
              intensity: { strictness: "low" },
            }),
          ],
        },
        "medium",
      ),
    ).toThrow(/lowers an external pull request's intensity/);
  });

  it("refuses an intensity on a skipped run — dead weight, as with posture", () => {
    expect(refused({ run: false, intensity: { strictness: "low" } })).toThrow(
      /intensity on a skipped run/,
    );
  });

  it("keeps a validated intensity rule's shape exact — the override rides the rule", () => {
    expect(dogfoodIntensity().rules[1]).toEqual({
      id: "docs-maintainer",
      context: "maintainer",
      when: { paths: ["docs/**"] },
      run: true,
      posture: "maintainer",
      instruction: ".github/action-agents/review/postures/docs.md",
      intensity: { strictness: "low" },
    });
  });
});

describe("the eligibility conditions", () => {
  /**
   * Evaluates a policy against the standard fact sheet, overridden per test.
   *
   * @param {import("./applicability.mjs").ApplicabilityPolicy} policy
   * @param {Partial<import("./applicability.mjs").RuleFacts> & { context?: import("./applicability.mjs").ExecutionContext }} [over]
   */
  const evaluated = (policy, over = {}) => {
    /** @type {import("./applicability.mjs").RuleFacts & { context: import("./applicability.mjs").ExecutionContext }} */
    const facts = {
      context: "external",
      title: "the change",
      branch: "feature",
      base: "main",
      labels: ["triage"],
      author: { login: "someone", isBot: false },
      changes: { files: 4, lines: 300 },
      paths: null,
      ...over,
    };
    return evaluateApplicability({ ...facts, policy });
  };

  /** A rule factory: id plus when, run: false unless said otherwise. */
  /** @param {Record<string, unknown>} when @param {string} [id] */
  const skipRule = (when, id = "skip-rule") => ({ id, when, run: false });

  it("skips on the GitHub-attested bot type, allowlist not required", () => {
    const policy = validateApplicabilityPolicy(
      { bots: [], rules: [skipRule({ author: { isBot: true } })] },
      "medium",
    );
    const result = evaluated(policy, { author: { login: "renovate[bot]", isBot: true } });
    expect(result.applicable).toBe(false);
    expect(result.matchedRule).toBe("skip-rule");
    expect(result.basis).toBe("rule");
  });

  it("never matches isBot on a missing or non-bot type — a gap costs more review", () => {
    const policy = validateApplicabilityPolicy(
      { bots: [], rules: [skipRule({ author: { isBot: true } })] },
      "medium",
    );
    expect(evaluated(policy, { author: { login: "someone", isBot: false } }).applicable).toBe(true);
    expect(evaluated(policy, { author: undefined }).applicable).toBe(true);
  });

  it("matches author.equals exactly and case-sensitively", () => {
    const policy = validateApplicabilityPolicy(
      {
        bots: [],
        rules: [
          {
            id: "mine",
            context: "maintainer",
            when: { author: { equals: ["someone"] } },
            run: false,
          },
        ],
      },
      "medium",
    );
    expect(
      evaluated(policy, { context: "maintainer", author: { login: "someone", isBot: false } })
        .applicable,
    ).toBe(false);
    expect(
      evaluated(policy, { context: "maintainer", author: { login: "Someone", isBot: false } })
        .applicable,
    ).toBe(true);
  });

  it("matches the base ref by flag-less regex", () => {
    const policy = validateApplicabilityPolicy(
      { bots: [], rules: [{ id: "main-only", when: { base: "^main$" } }] },
      "medium",
    );
    expect(evaluated(policy, { base: "main" }).matchedRule).toBe("main-only");
    expect(evaluated(policy, { base: "release" }).matchedRule).toBeNull();
  });

  it("matches labels any-of, exact and case-sensitively", () => {
    const policy = validateApplicabilityPolicy(
      { bots: [], rules: [{ id: "labelled", when: { labels: ["No-Review"] } }] },
      "medium",
    );
    expect(evaluated(policy, { labels: ["triage", "No-Review"] }).matchedRule).toBe("labelled");
    expect(evaluated(policy, { labels: ["triage", "no-review"] }).matchedRule).toBeNull();
    expect(evaluated(policy, { labels: [] }).matchedRule).toBeNull();
    expect(evaluated(policy, { labels: undefined }).matchedRule).toBeNull();
  });

  it("guards size strictly — gt is a strict more-than, at the eligibility level", () => {
    const policy = validateApplicabilityPolicy(
      { bots: [], rules: [skipRule({ changes: { lines: { gt: 299 }, files: { gt: 3 } } })] },
      "medium",
    );
    expect(evaluated(policy, { changes: { files: 4, lines: 300 } }).applicable).toBe(false);
    expect(evaluated(policy, { changes: { files: 4, lines: 299 } }).applicable).toBe(true);
    expect(evaluated(policy, { changes: { files: 3, lines: 300 } }).applicable).toBe(true);
  });

  it("combines families conjunctively — one false conjunct skips the rule, not the run", () => {
    const policy = validateApplicabilityPolicy(
      {
        bots: [],
        rules: [skipRule({ author: { isBot: true }, changes: { lines: { gt: 100 } } })],
      },
      "medium",
    );
    expect(
      evaluated(policy, {
        author: { login: "b[bot]", isBot: true },
        changes: { files: 9, lines: 101 },
      }).applicable,
    ).toBe(false);
    expect(
      evaluated(policy, {
        author: { login: "b[bot]", isBot: true },
        changes: { files: 9, lines: 100 },
      }).applicable,
    ).toBe(true);
  });

  it("fails every family on honest absence of the fact it needs", () => {
    const policy = validateApplicabilityPolicy(
      {
        bots: [],
        rules: [
          skipRule(
            { base: "main", labels: ["x"], author: { isBot: true }, changes: { lines: { gt: 0 } } },
            "needs-everything",
          ),
        ],
      },
      "medium",
    );
    // Each family's fact is omitted from the sheet — base, labels, author,
    // then changes — and each gap fails the family that needs it. An
    // omitted key and an explicitly-undefined one are the same refusal at
    // the evaluator; `changes` alone can also arrive as null (no listing
    // was fetched), the one gap that is a value.
    expect(evaluated(policy, {}).applicable).toBe(true);
    expect(evaluated(policy, { changes: null }).applicable).toBe(true);
  });

  it("keeps first-match order across old and new families", () => {
    const policy = validateApplicabilityPolicy(
      {
        bots: [],
        rules: [
          { id: "first", when: { base: "^nope" }, run: true },
          skipRule({ author: { isBot: true } }, "second"),
        ],
      },
      "medium",
    );
    const result = evaluated(policy, { author: { login: "b[bot]", isBot: true } });
    expect(result.matchedRule).toBe("second");
    expect(result.applicable).toBe(false);
  });

  it("is deterministic — the same facts decide the same way, twice", () => {
    const policy = validateApplicabilityPolicy(
      { bots: [], rules: [skipRule({ changes: { files: { gt: 1 } } })] },
      "medium",
    );
    const facts = { changes: { files: 5, lines: 10 } };
    expect(evaluated(policy, facts)).toEqual(evaluated(policy, facts));
  });

  it("counts the pre-ignore totals with changeTotals", async () => {
    const { changeTotals } = await import("./applicability.mjs");
    expect(
      changeTotals([
        /** @type {any} */ ({ additions: 2, deletions: 1 }),
        /** @type {any} */ ({ additions: 10, deletions: 0 }),
        /** @type {any} */ ({ additions: 0, deletions: 4 }),
      ]),
    ).toEqual({ files: 3, lines: 17 });
  });
});

describe("the eligibility grammar", () => {
  /** @param {unknown} rule */
  const ruleRefused = (rule) => () =>
    validateApplicabilityPolicy({ bots: ["acme"], rules: [rule] }, "medium");

  it("refuses an unknown when key", () => {
    expect(ruleRefused({ id: "x", when: { draft: true } })).toThrow(/unknown key 'draft'/);
  });

  it("refuses malformed labels", () => {
    expect(ruleRefused({ id: "x", when: { labels: [] } })).toThrow(
      /non-empty array of label names/,
    );
    expect(ruleRefused({ id: "x", when: { labels: [42] } })).toThrow(
      /non-string or empty label name/,
    );
    expect(ruleRefused({ id: "x", when: { labels: [""] } })).toThrow(
      /non-string or empty label name/,
    );
  });

  it("refuses an empty or unknown-keyed author family", () => {
    expect(ruleRefused({ id: "x", when: { author: {} } })).toThrow(/author must not be empty/);
    expect(ruleRefused({ id: "x", when: { author: { smile: true } } })).toThrow(
      /author holds unknown key 'smile'/,
    );
  });

  it("refuses any isBot but true — the attestation may not be negated", () => {
    expect(ruleRefused({ id: "x", when: { author: { isBot: false } } })).toThrow(
      /isBot must be true when present/,
    );
    expect(ruleRefused({ id: "x", when: { author: { isBot: "yes" } } })).toThrow(
      /isBot must be true when present/,
    );
  });

  it("refuses malformed equals", () => {
    expect(ruleRefused({ id: "x", when: { author: { equals: [] } } })).toThrow(
      /non-empty array of logins/,
    );
    expect(ruleRefused({ id: "x", when: { author: { equals: [""] } } })).toThrow(
      /non-string or empty login/,
    );
  });

  it("refuses an empty or unknown-keyed changes family", () => {
    expect(ruleRefused({ id: "x", when: { changes: {} } })).toThrow(/changes must not be empty/);
    expect(ruleRefused({ id: "x", when: { changes: { total: { gt: 1 } } } })).toThrow(
      /unknown key 'total'/,
    );
  });

  it("refuses a malformed lines or files guard", () => {
    expect(ruleRefused({ id: "x", when: { changes: { lines: 80 } } })).toThrow(
      /lines must be an object holding gt/,
    );
    expect(ruleRefused({ id: "x", when: { changes: { files: { gt: 1, atLeast: 1 } } } })).toThrow(
      /files carries only gt/,
    );
  });

  it("refuses a gt that is negative, fractional, or not a number", () => {
    expect(ruleRefused({ id: "x", when: { changes: { lines: { gt: -1 } } } })).toThrow(
      /whole number/,
    );
    expect(ruleRefused({ id: "x", when: { changes: { lines: { gt: 1.5 } } } })).toThrow(
      /whole number/,
    );
    expect(ruleRefused({ id: "x", when: { changes: { files: { gt: "80" } } } })).toThrow(
      /whole number/,
    );
  });

  it("accepts gt 0 — strictly more than zero, an empty change never matches", () => {
    const policy = validateApplicabilityPolicy(
      { bots: [], rules: [{ id: "x", when: { changes: { files: { gt: 0 } } } }] },
      "medium",
    );
    expect(policy.rules[0]?.when.changes).toEqual({ files: { gt: 0 } });
  });

  it("accepts the full eligibility grammar in one policy", () => {
    const policy = validateApplicabilityPolicy(
      {
        bots: ["ecoma-io"],
        rules: [
          { id: "bots", when: { author: { isBot: true } }, run: false },
          {
            id: "mine",
            context: "maintainer",
            when: { author: { equals: ["johnitvn"] }, labels: ["no-review"], base: "^release/" },
            run: false,
          },
          {
            id: "oversized",
            when: { changes: { lines: { gt: 8000 }, files: { gt: 200 } } },
            run: false,
          },
        ],
      },
      "medium",
    );
    expect(policy.rules).toHaveLength(3);
  });
});

describe("the anchor law", () => {
  /** @param {unknown} rule */
  const ruleRefused = (rule) => () =>
    validateApplicabilityPolicy({ bots: ["acme"], rules: [rule] }, "medium");

  it("accepts a bot-anchored contextless skip — the attestation is the anchor", () => {
    const policy = validateApplicabilityPolicy(
      { bots: [], rules: [{ id: "bots", when: { author: { isBot: true } }, run: false }] },
      "medium",
    );
    expect(policy.rules[0]?.run).toBe(false);
  });

  it("accepts a size-anchored contextless skip — the measurement is the anchor", () => {
    const policy = validateApplicabilityPolicy(
      {
        bots: [],
        rules: [{ id: "oversized", when: { changes: { lines: { gt: 8000 } } }, run: false }],
      },
      "medium",
    );
    expect(policy.rules[0]?.run).toBe(false);
  });

  it("refuses an equals-only contextless skip — a login list narrows, it never anchors", () => {
    expect(
      ruleRefused({ id: "x", when: { author: { equals: ["someuser"] } }, run: false }),
    ).toThrow(/without a context/);
  });

  it("refuses label- and base-anchored contextless skips — conventions never govern alone", () => {
    expect(ruleRefused({ id: "x", when: { labels: ["no-review"] }, run: false })).toThrow(
      /without a context/,
    );
    expect(ruleRefused({ id: "x", when: { base: "^release/" }, run: false })).toThrow(
      /without a context/,
    );
  });

  it("refuses the frozen external context even with the new anchors", () => {
    expect(
      ruleRefused({ id: "x", context: "external", when: { author: { isBot: true } }, run: false }),
    ).toThrow(/external context is frozen/);
    expect(
      ruleRefused({
        id: "x",
        context: "external",
        when: { changes: { lines: { gt: 1 } } },
        run: false,
      }),
    ).toThrow(/external context is frozen/);
  });

  it("keeps a pinned non-external context sufficient on its own", () => {
    const policy = validateApplicabilityPolicy(
      {
        bots: ["acme"],
        rules: [{ id: "x", context: "automation", when: { labels: ["x"] }, run: false }],
      },
      "medium",
    );
    expect(policy.rules[0]?.run).toBe(false);
  });
});

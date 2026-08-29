/**
 * The applicability engine — execution-context derivation and the rule
 * evaluator, one pure module over injected inputs. It decides, before diff
 * accounting and before any model call, whether review applies to a pull
 * request at all (`run`), which posture it takes, and how deep it goes —
 * the `strictness` delta the intensity axis resolves for the run — naming
 * the rule or default that decided each.
 *
 * The doctrine, restated where it bites: classification reads event
 * metadata and consumer-declared conventions, never review content; title,
 * branch and paths are values to match, never instruction; the model is
 * nowhere in this module; and every refusal is red at startup, before the
 * first model call.
 */

import { matchGlob } from "#core/glob.mjs";
import { STRICTNESS } from "./vocabulary.mjs";

/** The three derived execution contexts, in derivation-table order. */
export const EXECUTION_CONTEXTS = /** @type {const} */ (["automation", "maintainer", "external"]);

/** Where a decision's authority came from. */
export const APPLICABILITY_BASES = /** @type {const} */ (["rule", "default", "state"]);

/** The three review postures, fixed in code — a policy file selects, never defines. */
export const POSTURES = /** @type {const} */ (["standard", "maintainer", "automation"]);

/**
 * The strictness arms the intensity axis's one delta speaks, single-homed in
 * `vocabulary.mjs` — same reason as every mirror here: an unknown policy is
 * a refusal, never a guess.
 */
export const STRICTNESS_ARMS = STRICTNESS;

/** The bases a skipped run can carry — the defaults never skip. */
export const SKIPPED_BASES = /** @type {const} */ (["rule", "state"]);

/** The head provenance the derivation can prove. Absent head repo is a deleted fork. */
export const HEAD_PROVENANCES = /** @type {const} */ (["same-repo", "fork", "deleted"]);

/** The author provenance the derivation read, allowlist outcome included. */
export const AUTHOR_PROVENANCES = /** @type {const} */ ([
  "bot-allowlisted",
  "bot-unlisted",
  "human",
  "unknown",
]);

/** Write-class associations GitHub computes; anything else fails toward more review. */
const WRITE_CLASS_ASSOCIATIONS = /** @type {const} */ (["OWNER", "MEMBER", "COLLABORATOR"]);

/** @typedef {(typeof EXECUTION_CONTEXTS)[number]} ExecutionContext */
/** @typedef {(typeof APPLICABILITY_BASES)[number]} ApplicabilityBasis */
/** @typedef {(typeof SKIPPED_BASES)[number]} SkippedBasis */
/** @typedef {(typeof HEAD_PROVENANCES)[number]} HeadProvenance */
/** @typedef {(typeof AUTHOR_PROVENANCES)[number]} AuthorProvenance */
/** @typedef {(typeof POSTURES)[number]} Posture */
/**
 * @typedef {object} RuleIntensity the intensity axis's one delta: the
 * `strictness` dial, stated as the absolute value the run runs under.
 * @property {import("./config.mjs").Strictness} strictness
 */

/**
 * @typedef {object} ApplicabilityRule a validated rule: `context` plus
 * `when` conditions combine conjunctively; `run` defaults true. A
 * non-standard `posture` is the same pipeline with a mode-scoped document,
 * so `posture` and `instruction` appear together or not at all.
 * @property {string} id the name the audit record carries
 * @property {ExecutionContext} [context] absent matches every derived context
 * @property {{ title?: RegExp, branch?: RegExp, paths?: string[] }} when compiled conditions
 * @property {boolean} run the applicability axis value
 * @property {Exclude<Posture, "standard">} [posture] the posture axis value, present only when a deviation is declared
 * @property {string} [instruction] the posture document's path on the policy source, alongside a non-standard posture
 * @property {RuleIntensity} [intensity] the intensity axis value, present only when the rule declares it
 */

/**
 * @typedef {object} ApplicabilityPolicy the validated `applicability` key.
 * @property {string[]} bots exact logins (case-sensitive) that may classify as automation
 * @property {ApplicabilityRule[]} rules ordered, first-match-wins
 */

/**
 * @typedef {object} ClassificationInputs what the derivation actually read.
 * @property {string[]} bots the policy's allowlist
 * @property {string} authorLogin raw `pull_request.user.login`
 * @property {string} authorType raw `pull_request.user.type`
 * @property {string} association raw `pull_request.author_association`
 * @property {string | null} headRepoFullName the head repository's full name; null when absent
 * @property {string} baseRepoFullName the base repository's full name
 */

/**
 * @typedef {object} DerivedApplicability the derivation's whole output.
 * @property {ExecutionContext} context
 * @property {{ association: string, head: HeadProvenance, authorType: AuthorProvenance }} inputs
 *     the provenance snapshot the audit record carries
 */

/**
 * Normalises the raw event payload into the derivation's inputs. Missing
 * fields are honest absence, not guesses: a missing type or login never
 * allowlists, a missing association is GitHub's own `NONE`, and a missing
 * head repository is a deleted fork.
 *
 * @param {unknown} pullRequest the event's `pull_request` object, untrusted and possibly absent
 * @param {string} baseRepoFullName the base repository's full name
 * @param {string[]} bots the policy's allowlist
 * @returns {ClassificationInputs}
 */
export function classificationInputs(pullRequest, baseRepoFullName, bots) {
  const payload = recordOf(pullRequest);
  const user = recordOf(payload["user"]);
  const head = recordOf(payload["head"]);
  const headRepo = recordOf(head["repo"]);
  const association = payload["author_association"];
  return {
    bots,
    authorLogin: typeof user["login"] === "string" ? user["login"] : "",
    authorType: typeof user["type"] === "string" ? user["type"] : "",
    association: typeof association === "string" && association !== "" ? association : "NONE",
    headRepoFullName: typeof headRepo["full_name"] === "string" ? headRepo["full_name"] : null,
    baseRepoFullName,
  };
}

/**
 * Derives exactly one execution context, ordered and first-match:
 * automation (Bot type and an exact, case-sensitive allowlisted login),
 * maintainer (write-class association and provable same-repo head),
 * external (everything else). An unallowlisted bot falls through, not down
 * — a wrong guess about a bot must cost more review, never less. Same-repo
 * is claimed by nothing: compared against the base repository's full name,
 * and an absent head repository is a deleted fork.
 *
 * @param {ClassificationInputs} inputs what the derivation read
 * @returns {DerivedApplicability}
 */
export function classifyContext(inputs) {
  const botTyped = inputs.authorType === "Bot";
  const allowlisted = botTyped && inputs.bots.includes(inputs.authorLogin);
  const authorType = /** @type {AuthorProvenance} */ (
    !botTyped && inputs.authorType !== ""
      ? "human"
      : botTyped
        ? allowlisted
          ? "bot-allowlisted"
          : "bot-unlisted"
        : "unknown"
  );
  const head = /** @type {HeadProvenance} */ (
    inputs.headRepoFullName === null
      ? "deleted"
      : inputs.headRepoFullName === inputs.baseRepoFullName
        ? "same-repo"
        : "fork"
  );
  const context = /** @type {ExecutionContext} */ (
    allowlisted
      ? "automation"
      : WRITE_CLASS_ASSOCIATIONS.includes(/** @type {never} */ (inputs.association)) &&
          head === "same-repo"
        ? "maintainer"
        : "external"
  );
  return { context, inputs: { association: inputs.association, head, authorType } };
}

/**
 * Evaluates the rule list against a derived context, in config order,
 * first match wins — never reordered, scored or merged. Nothing matching
 * means: run, standard posture, file intensity — the defaults, literally.
 * The matched rule's posture rides the verdict with its document path, so
 * the caller never re-finds the rule; `instruction` is set exactly when the
 * posture is not standard, and `intensity` exactly when the rule declares
 * the strictness override. `title`, `branch` and the changed paths are
 * match values, never instruction; the paths globs speak the one
 * configuration dialect and run over the post-ignore inventory.
 *
 * @param {object} input
 * @param {ApplicabilityPolicy} input.policy the validated policy
 * @param {ExecutionContext} input.context the derived context
 * @param {string} input.title the pull request's title
 * @param {string} input.branch the head ref name
 * @param {string[] | null} input.paths the post-ignore changed paths, or null when no rule carries a paths condition and no listing was fetched
 * @returns {{ applicable: boolean, matchedRule: string | null, basis: "rule" | "default", posture: Posture, instruction: string | undefined, intensity: RuleIntensity | undefined }}
 */
export function evaluateApplicability({ policy, context, title, branch, paths }) {
  for (const rule of policy.rules) {
    if (rule.context !== undefined && rule.context !== context) continue;
    if (!conditionsHold(rule.when, title, branch, paths)) continue;
    return {
      applicable: rule.run,
      matchedRule: rule.id,
      basis: "rule",
      posture: rule.posture ?? "standard",
      instruction: rule.instruction,
      intensity: rule.intensity,
    };
  }
  return {
    applicable: true,
    matchedRule: null,
    basis: "default",
    posture: "standard",
    instruction: undefined,
    intensity: undefined,
  };
}

/**
 * @param {{ title?: RegExp, branch?: RegExp, paths?: string[] }} when
 * @param {string} title
 * @param {string} branch
 * @param {string[] | null} paths
 * @returns {boolean}
 */
function conditionsHold(when, title, branch, paths) {
  if (when.title !== undefined && !when.title.test(title)) return false;
  if (when.branch !== undefined && !when.branch.test(branch)) return false;
  if (when.paths !== undefined) {
    if (paths === null || !paths.some((path) => matchGlob(when.paths ?? [], path))) return false;
  }
  return true;
}

/**
 * Validates the `applicability` key into an {@link ApplicabilityPolicy}.
 * Absent means the policy is off entirely — no classification, no axes,
 * byte-for-byte today's behaviour. Every refusal below is red at startup,
 * before the first model call, the same refusal class as a bad
 * `strictness`. A rule's `intensity` carries the one delta v1 ships — the
 * `strictness` dial — and the lower-gates judge its direction against
 * `fileStrictness`, the config file's own value the run would inherit.
 *
 * @param {unknown} value the raw key value
 * @param {import("./config.mjs").Strictness} fileStrictness the config file's own strictness, the baseline an intensity delta is judged against
 * @returns {ApplicabilityPolicy}
 */
export function validateApplicabilityPolicy(value, fileStrictness) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("applicability must be an object with bots and rules");
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(raw)) {
    if (key !== "bots" && key !== "rules") {
      throw new Error(
        `applicability holds unknown key '${key}' — applicability carries bots and rules; ` +
          `a rule carries its axes, intensity included`,
      );
    }
  }

  /** @type {string[]} */
  let bots = [];
  if (raw["bots"] !== undefined) {
    const declared = raw["bots"];
    if (!Array.isArray(declared)) throw new Error("applicability.bots must be an array of logins");
    for (const entry of declared) {
      if (typeof entry !== "string" || entry === "") {
        throw new Error("every applicability.bots entry must be a non-empty login");
      }
    }
    bots = /** @type {string[]} */ (declared);
  }

  /** @type {ApplicabilityRule[]} */
  let rules = [];
  if (raw["rules"] !== undefined) {
    const declared = raw["rules"];
    if (!Array.isArray(declared)) throw new Error("applicability.rules must be an array");
    /** @type {Set<string>} */
    const ids = new Set();
    /** @type {ApplicabilityRule[]} */
    const validated = [];
    for (const [index, entry] of declared.entries()) {
      validated.push(validateRule(entry, index, ids, fileStrictness));
    }
    rules = validated;
  }

  for (const rule of rules) {
    if (rule.context === "automation" && bots.length === 0) {
      throw new Error(
        `applicability rule '${rule.id}' declares context 'automation' but the bots allowlist ` +
          `is empty — an automation rule without an allowlist classifies nothing`,
      );
    }
  }
  return { bots, rules };
}

/**
 * @param {unknown} entry
 * @param {number} index
 * @param {Set<string>} ids rule ids seen so far
 * @param {import("./config.mjs").Strictness} fileStrictness the config file's own strictness, the baseline an intensity delta is judged against
 * @returns {ApplicabilityRule}
 */
function validateRule(entry, index, ids, fileStrictness) {
  const label = `applicability.rules[${String(index)}]`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${label} must be an object with id, context, when and run`);
  }
  const raw = /** @type {Record<string, unknown>} */ (entry);
  for (const key of Object.keys(raw)) {
    if (
      key !== "id" &&
      key !== "context" &&
      key !== "when" &&
      key !== "run" &&
      key !== "posture" &&
      key !== "instruction" &&
      key !== "intensity"
    ) {
      throw new Error(`${label} holds unknown key '${key}'`);
    }
  }

  const id = raw["id"];
  if (typeof id !== "string" || id === "") {
    throw new Error(`${label}.id must be a non-empty string — the audit record names it`);
  }
  if (ids.has(id)) {
    throw new Error(`${label} repeats id '${id}' — every rule's id is the audit record's name`);
  }
  ids.add(id);

  let context;
  if (raw["context"] !== undefined) {
    const declared = raw["context"];
    if (
      typeof declared !== "string" ||
      !EXECUTION_CONTEXTS.includes(/** @type {never} */ (declared))
    ) {
      throw new Error(
        `${label}.context must be one of automation, maintainer, external — got '${String(declared)}'`,
      );
    }
    context = /** @type {ExecutionContext} */ (declared);
  }

  let run = true;
  if (raw["run"] !== undefined) {
    const declared = raw["run"];
    if (typeof declared !== "boolean") {
      throw new Error(`${label}.run must be true or false — got '${String(declared)}'`);
    }
    run = declared;
  }
  // The eligibility doctrine, enforced here rather than by review discipline:
  // the external context is frozen, and a convention never governs alone.
  if (!run && context === undefined) {
    throw new Error(
      `${label} sets run: false without a context — a rule built from title, branch or paths ` +
        `conventions never governs alone; it must declare an immune context`,
    );
  }
  if (!run && context === "external") {
    throw new Error(
      `${label} skips an external pull request — the external context is frozen; ` +
        `full review is what an untrusted contribution is for`,
    );
  }

  // The posture axis: the mode set is fixed in code, the default restated
  // is dead weight, and the same eligibility doctrine that guards `run`
  // guards the reframe — a convention never governs alone, the external
  // context is frozen, and a skipped run takes no posture at all. A
  // non-standard posture IS its mode-scoped document, so the two keys stand
  // or fall together.
  /** @type {Exclude<Posture, "standard"> | undefined} */
  let posture;
  if (raw["posture"] !== undefined) {
    const declared = raw["posture"];
    if (typeof declared !== "string" || !POSTURES.includes(/** @type {never} */ (declared))) {
      throw new Error(
        `${label}.posture must be one of standard, maintainer, automation — got '${String(declared)}'`,
      );
    }
    if (declared === "standard") {
      throw new Error(
        `${label} declares posture 'standard' — the default restated is dead weight; ` +
          `a posture key states only a deviation`,
      );
    }
    if (context === undefined) {
      throw new Error(
        `${label} sets a non-standard posture without a context — a convention never governs ` +
          `alone; it must declare an immune context`,
      );
    }
    if (context === "external") {
      throw new Error(
        `${label} reframes an external pull request off the standard posture — the external ` +
          `context is frozen; full review is what an untrusted contribution is for`,
      );
    }
    if (!run) {
      throw new Error(
        `${label} sets a posture on a skipped run — run: false ends the run before a posture ` +
          `could apply, so the declaration is dead weight`,
      );
    }
    posture = /** @type {Exclude<Posture, "standard">} */ (declared);
  }
  let instruction;
  if (raw["instruction"] !== undefined) {
    const declared = raw["instruction"];
    if (typeof declared !== "string" || declared === "") {
      throw new Error(`${label}.instruction must be a document path`);
    }
    if (posture === undefined) {
      throw new Error(
        `${label} declares an instruction without a non-standard posture — the document has ` +
          `nothing to be the document of`,
      );
    }
    instruction = declared;
  }
  if (posture !== undefined && instruction === undefined) {
    throw new Error(
      `${label} declares posture '${posture}' without an instruction — a non-standard posture ` +
        `is its mode-scoped document, never a second engine`,
    );
  }

  // The intensity axis: one delta in v1, the `strictness` dial, stated as
  // the absolute value the run runs under. The eligibility doctrine reads
  // the direction against the config file's own strictness — lowering
  // requires an immune pinned context and is never available to the frozen
  // external one, deepening is free everywhere (the only contextless key
  // that survives validation), and a skipped run takes no intensity, as it
  // takes no posture.
  /** @type {RuleIntensity | undefined} */
  let intensity;
  if (raw["intensity"] !== undefined) {
    intensity = validateIntensity(raw["intensity"], label, fileStrictness, context, run);
  }
  let when = {};
  if (raw["when"] !== undefined) {
    when = validateWhen(raw["when"], label);
  }
  /** @type {ApplicabilityRule} */
  const rule = { id, ...(context !== undefined ? { context } : {}), when, run };
  if (posture !== undefined && instruction !== undefined) {
    rule.posture = posture;
    rule.instruction = instruction;
  }
  if (intensity !== undefined) {
    rule.intensity = intensity;
  }
  return rule;
}

/**
 * Validates a rule's `intensity` declaration. The shape is exact — one key,
 * `strictness`, holding one of the three arms — and the doctrine gates read
 * the declared value against the baseline: lower demands an immune anchor,
 * the external context never lowers, and `run: false` leaves no run for an
 * intensity to apply to.
 *
 * @param {unknown} value the raw `intensity` value
 * @param {string} label the rule's label in refusal messages
 * @param {import("./config.mjs").Strictness} fileStrictness the config file's own strictness, the baseline a delta is judged against
 * @param {ExecutionContext | undefined} context the rule's pinned context, if any
 * @param {boolean} run whether the rule runs review
 * @returns {RuleIntensity}
 */
function validateIntensity(value, label, fileStrictness, context, run) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}.intensity must be an object holding strictness`);
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(raw)) {
    if (key !== "strictness") {
      throw new Error(
        `${label}.intensity holds unknown key '${key}' — intensity carries strictness ` +
          `alone in v1`,
      );
    }
  }
  const declared = raw["strictness"];
  if (typeof declared !== "string" || !STRICTNESS_ARMS.includes(/** @type {never} */ (declared))) {
    throw new Error(
      `${label}.intensity.strictness must be one of low, medium, high — got '${String(declared)}'`,
    );
  }
  if (!run) {
    throw new Error(
      `${label} sets an intensity on a skipped run — run: false ends the run before an ` +
        `intensity could apply, so the declaration is dead weight`,
    );
  }
  const lowers =
    STRICTNESS_ARMS.indexOf(/** @type {import("./config.mjs").Strictness} */ (declared)) <
    STRICTNESS_ARMS.indexOf(fileStrictness);
  if (lowers && context === undefined) {
    throw new Error(
      `${label} lowers intensity without a context — a convention never governs alone; ` +
        `it must declare an immune context`,
    );
  }
  if (lowers && context === "external") {
    throw new Error(
      `${label} lowers an external pull request's intensity — the external context is ` +
        `frozen; full review is what an untrusted contribution is for`,
    );
  }
  return { strictness: /** @type {import("./config.mjs").Strictness} */ (declared) };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {{ title?: RegExp, branch?: RegExp, paths?: string[] }}
 */
function validateWhen(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}.when must be an object with title, branch and paths`);
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(raw)) {
    if (key !== "title" && key !== "branch" && key !== "paths") {
      throw new Error(`${label}.when holds unknown key '${key}'`);
    }
  }
  /** @type {{ title?: RegExp, branch?: RegExp, paths?: string[] }} */
  const when = {};
  for (const key of ["title", "branch"]) {
    const declared = raw[key];
    if (declared === undefined) continue;
    if (typeof declared !== "string" || declared === "") {
      throw new Error(`${label}.when.${key} must be a non-empty regular-expression source`);
    }
    try {
      // No flags, ever: a consumer's pattern selects values, it never
      // changes what matching means.
      when[/** @type {"title" | "branch"} */ (key)] = new RegExp(declared);
    } catch {
      throw new Error(
        `${label}.when.${key} does not compile as a regular expression: '${String(declared)}'`,
      );
    }
  }
  if (raw["paths"] !== undefined) {
    const declared = raw["paths"];
    if (!Array.isArray(declared) || declared.length === 0) {
      throw new Error(`${label}.when.paths must be a non-empty array of globs`);
    }
    for (const pattern of declared) {
      if (typeof pattern !== "string" || pattern.replace(/^!/, "") === "") {
        throw new Error(
          `${label}.when.paths holds a glob the dialect rejects: '${String(pattern)}'`,
        );
      }
    }
    when.paths = /** @type {string[]} */ (declared);
  }
  return when;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function recordOf(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

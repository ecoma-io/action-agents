/**
 * The review's phase machine — `orient → investigate → verify → conclude`.
 *
 * Doctrine: phases are scaffolding the code owns. They bound what the model
 * may do next — which tools are offered, when concluding is reachable — and
 * nothing the model says can move the machine. `nextPhase` reads only the
 * loop's own ledger facts: the coverage report over the expected set, the
 * budgets as consumed against their caps, the findings on record, and the
 * lanes code fixed before the run. The model influences those facts only by
 * using tools; its prose is never a transition input. A phase name outside
 * the declared set, or a context that is not the ledger-shaped record the
 * loop passes, is refused with a {@link PhaseError} — never coerced to a
 * default, because a machine that guesses its own state is scaffolding that
 * bounds nothing.
 *
 * The per-phase tool policy is a declared narrowing of the fixed registry in
 * `tools.mjs`: it is validated against the registry's real names at module
 * load, so a policy entry the registry does not have is an import-time
 * failure, not a silent widening. The map can only ever narrow — enforcement
 * is the offer itself: the loop presents a phase's tools and nothing else,
 * the way it has always presented the registry and the withheld-tools
 * finalisation.
 */

import { TOOL_SPECS } from "./tools.mjs";
import { canConcludeReview } from "./coverage.mjs";
import { STRICTNESS } from "./vocabulary.mjs";

/**
 * The declared phases, in the order the machine walks them. Frozen: the set
 * is code's, not a parameter.
 *
 * @type {readonly PhaseName[]}
 */
export const PHASES = Object.freeze(["orient", "investigate", "verify", "conclude"]);

/** The phase every review opens in. */
export const FIRST_PHASE = /** @type {PhaseName} */ (PHASES[0]);

/**
 * @typedef {"orient" | "investigate" | "verify" | "conclude"} PhaseName
 */

/**
 * The typed refusal. Every refusal this module raises is one of these, so a
 * caller can distinguish "the machine was misused" from every other failure.
 */
export class PhaseError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "PhaseError";
  }
}

/**
 * The ledger facts one transition is computed from. Every field is a number,
 * list or flag the loop already holds; none of them is model text.
 *
 * @typedef {object} PhaseContext
 * @property {import("./coverage.mjs").CoverageReport} coverage expected set against the reads on record
 * @property {number} toolCalls tool calls consumed so far
 * @property {number} maxToolCalls the tool-call ceiling
 * @property {number} readingTurns reading turns consumed so far
 * @property {number} maxTurns the reading-turn ceiling
 * @property {number} evidenceBytes cumulative evidence bytes charged
 * @property {number} evidenceLimit the cumulative-evidence ceiling
 * @property {boolean} lanesAssigned whether code has fixed the attention lanes
 * @property {import("./config.mjs").Strictness} strictness the review policy; the conclude gate tightens at "high"
 */

/**
 * @typedef {Readonly<Record<PhaseName, readonly string[]>>} PhaseToolPolicy
 */

const STRICTNESS_VALUES = STRICTNESS;

/**
 * Validates one phase → tool-names map against the registry. The map must
 * name every declared phase exactly once, no tool twice, and no tool the
 * registry does not have — a policy that adds is refused, not trimmed,
 * because a widening that slipped through validation is exactly the failure
 * this check exists to catch.
 *
 * @param {Record<string, readonly string[]>} policy the map to validate
 * @param {readonly string[]} [registryNames] defaults to the live registry's names
 * @returns {PhaseToolPolicy}
 */
export function validatePhaseToolPolicy(
  policy,
  registryNames = TOOL_SPECS.map((spec) => spec.name),
) {
  const known = new Set(registryNames);
  for (const key of Object.keys(policy)) {
    if (!PHASES.includes(/** @type {PhaseName} */ (key))) {
      throw new PhaseError(`tool policy names "${key}", which is not a declared phase`);
    }
  }
  /** @type {Record<PhaseName, readonly string[]>} */
  const validated = /** @type {PhaseToolPolicy} */ ({});
  for (const phase of PHASES) {
    const names = policy[phase];
    if (!Array.isArray(names)) {
      throw new PhaseError(`tool policy for phase "${phase}" is not a list of tool names`);
    }
    /** @type {Set<string>} */
    const seen = new Set();
    for (const name of names) {
      if (typeof name !== "string") {
        throw new PhaseError(`tool policy for phase "${phase}" carries a non-string tool name`);
      }
      if (!known.has(name)) {
        throw new PhaseError(
          `tool policy for phase "${phase}" names "${name}", which the registry does not have — ` +
            `a phase policy may only narrow the registry, never add to it`,
        );
      }
      if (seen.has(name)) {
        throw new PhaseError(`tool policy for phase "${phase}" names "${name}" twice`);
      }
      seen.add(name);
    }
    validated[phase] = Object.freeze([...names]);
  }
  return Object.freeze(validated);
}

/**
 * The per-phase narrowing of the fixed registry, validated at module load:
 *
 * - `orient` — bearings only: listing and search, no file reads yet;
 * - `investigate` — file reading joins, on top of orient's tools;
 * - `verify` — the cited evidence stays re-readable: the same tools, now
 *   pointed at what was already read;
 * - `conclude` — nothing: the final answer is produced with the tools
 *   withheld, exactly as the loop's finalisation has always done.
 *
 * @type {PhaseToolPolicy}
 */
export const PHASE_TOOL_POLICY = validatePhaseToolPolicy({
  orient: ["list_files", "search"],
  investigate: ["list_files", "search", "read_file"],
  verify: ["list_files", "search", "read_file"],
  conclude: [],
});

/**
 * The registry entries one phase's policy narrows to, in registry order.
 *
 * @param {PhaseName} phase
 * @param {import("#core/chat.mjs").ChatTool[]} [registry] defaults to the fixed registry
 * @returns {import("#core/chat.mjs").ChatTool[]}
 */
export function phaseTools(phase, registry = TOOL_SPECS) {
  assertPhase(phase);
  const allowed = new Set(PHASE_TOOL_POLICY[phase]);
  return registry.filter((spec) => allowed.has(spec.name));
}

/**
 * The per-phase procedural meaning, one paragraph in the mode-paragraph
 * style, rendered into the prompt as data. Validated against the declared
 * phases at module load, like the tool policy: a phase without its paragraph
 * is a machine the model was never told about.
 *
 * @type {Readonly<Record<PhaseName, string>>}
 */
export const PHASE_PROCEDURES = validatePhaseProcedures({
  orient:
    'Review phase — "orient": the run opens here. Get your bearings before reading anything ' +
    "whole: the listing and search tools are what this phase offers. Map the change, then " +
    "decide what to read first.",
  investigate:
    'Review phase — "investigate": read the changed files and the context they touch; file ' +
    "reading joins the offered tools. Work toward having read every changed file.",
  verify:
    'Review phase — "verify": re-read the concrete code behind each candidate finding — ' +
    "already-read files stay readable — and keep only what the code confirms.",
  conclude:
    'Review phase — "conclude": the reading work ends, the tools go quiet, and the final ' +
    "JSON answer is produced under the output contract above.",
});

/**
 * @param {Record<string, string>} procedures
 * @returns {Readonly<Record<PhaseName, string>>}
 */
function validatePhaseProcedures(procedures) {
  for (const key of Object.keys(procedures)) {
    if (!PHASES.includes(/** @type {PhaseName} */ (key))) {
      throw new PhaseError(`procedure text names "${key}", which is not a declared phase`);
    }
  }
  /** @type {Record<PhaseName, string>} */
  const validated = /** @type {Record<PhaseName, string>} */ ({});
  for (const phase of PHASES) {
    const text = procedures[phase];
    if (typeof text !== "string" || text.trim() === "") {
      throw new PhaseError(`procedure text for phase "${phase}" is missing or empty`);
    }
    validated[phase] = text;
  }
  return Object.freeze(validated);
}

/**
 * The one transition step. Total over (declared phase, well-formed context):
 * every combination resolves to a declared phase — the phase it was already
 * in when no edge's facts hold, `conclude` once reached (terminal), or the
 * one edge whose facts hold. At most one step per call; the loop asks again
 * after every ledger update, so the walk stays stepwise and inspectable.
 *
 * The conclude edge is checked first from any phase: a fired bound is the
 * code-owned exit, and under strictness "high" it additionally requires the
 * coverage condition — no uncovered file — mirroring, at the phase layer,
 * the same rule the conclusion checks enforce at the status layer.
 *
 * @param {PhaseName} current
 * @param {PhaseContext} context
 * @returns {PhaseName}
 */
export function nextPhase(current, context) {
  assertPhase(current);
  assertContext(context);
  if (current === "conclude") return "conclude";
  if (concludeReachable(context)) return "conclude";
  switch (current) {
    case "orient":
      return oriented(context) ? "investigate" : "orient";
    case "investigate":
      return investigated(context) ? "verify" : "investigate";
    default:
      return "verify";
  }
}

/**
 * The conclude edge: a reading bound has fired, and under "high" the #69
 * coverage condition must also hold. Never fires while the budgets remain.
 *
 * @param {PhaseContext} context
 * @returns {boolean}
 */
function concludeReachable(context) {
  const boundFired =
    context.toolCalls >= context.maxToolCalls ||
    context.readingTurns >= context.maxTurns ||
    context.evidenceBytes >= context.evidenceLimit;
  return boundFired && canConcludeReview(context.coverage, context.strictness);
}

/**
 * Orient ends when the model has spent one recorded reading turn and code
 * has fixed the lanes — the bearings exist; reading may begin.
 *
 * @param {PhaseContext} context
 * @returns {boolean}
 */
function oriented(context) {
  return context.lanesAssigned && context.readingTurns >= 1;
}

/**
 * Investigate ends when the expected set is fully read. The reading ledger
 * holds no findings to short-circuit it — findings exist only once the
 * final answer lands, and verification is reachable only through coverage.
 *
 * @param {PhaseContext} context
 * @returns {boolean}
 */
function investigated(context) {
  return context.coverage.total > 0 && context.coverage.uncovered.length === 0;
}

/**
 * @param {PhaseName} phase
 * @returns {void}
 */
function assertPhase(phase) {
  if (typeof phase !== "string" || !PHASES.includes(/** @type {PhaseName} */ (phase))) {
    throw new PhaseError(
      `"${String(phase)}" is not a declared phase — the machine refuses names it does not own`,
    );
  }
}

/**
 * @param {PhaseContext} context
 * @returns {void}
 */
function assertContext(context) {
  if (typeof context !== "object" || context === null) {
    throw new PhaseError("the phase context is not an object");
  }
  const coverage = context.coverage;
  if (typeof coverage !== "object" || coverage === null) {
    throw new PhaseError("the phase context carries no coverage report");
  }
  if (!isStringList(coverage.covered) || !isStringList(coverage.uncovered)) {
    throw new PhaseError("the coverage report's covered/uncovered sets are not string lists");
  }
  if (!isCount(coverage.total)) {
    throw new PhaseError("the coverage report's total is not a non-negative integer");
  }
  for (const field of /** @type {const} */ ([
    "toolCalls",
    "maxToolCalls",
    "readingTurns",
    "maxTurns",
    "evidenceBytes",
    "evidenceLimit",
  ])) {
    if (!isCount(context[field])) {
      throw new PhaseError(`the phase context field "${field}" is not a non-negative integer`);
    }
  }
  if (typeof context.lanesAssigned !== "boolean") {
    throw new PhaseError('the phase context field "lanesAssigned" is not a boolean');
  }
  if (!STRICTNESS_VALUES.includes(context.strictness)) {
    throw new PhaseError(
      `the phase context strictness "${String(context.strictness)}" is not a review policy`,
    );
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isStringList(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

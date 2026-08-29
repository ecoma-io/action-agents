/**
 * Attention lanes — the risk classifier's verdict turned into a reading
 * plan. Code computes them: the deterministic classifier scores every
 * changed file, and the declared table below maps that score to an
 * attention lane (`deep`, `standard` or `skim`) under the review's
 * strictness. The model receives the assignments as context in the
 * prompt; it has no path to change its own lane or another file's — no
 * tool reads or writes a lane, no answer field carries one, and a lane
 * can only ever change when the config or the classifier's input does.
 *
 * A lane weights attention; it never exempts. A skim-lane file is still
 * an expected read: coverage accounting counts every changed file toward
 * the strict partial-review semantics whatever its lane. Nothing here
 * narrows the review's universe — it orders effort.
 */

import { utf8Compare } from "./order.mjs";
import { STRICTNESS } from "./vocabulary.mjs";

/** @typedef {import("./risk.mjs").RiskLevel} RiskLevel */
/** @typedef {import("./risk.mjs").RiskPlan} RiskPlan */
/** @typedef {import("./config.mjs").Strictness} Strictness */
/** @typedef {import("./config.mjs").ReviewConfig} ReviewConfig */

/**
 * The attention lanes a file can sit in, deepest attention first. The
 * classifier's own `Lane` names finding categories (correctness,
 * security, …); this is a different axis — how hard the review looks.
 *
 * @typedef {"deep" | "standard" | "skim"} AttentionLane
 */

/**
 * One file's lane input: where it lives and the classifier's per-file
 * plan for it.
 *
 * @typedef {object} LaneEntry
 * @property {string} path the repository-relative path at the reviewed head
 * @property {RiskPlan} riskPlan the classifier's plan for exactly this file
 */

/**
 * One file's lane output: the input's path and risk, plus the lane the
 * table assigned.
 *
 * @typedef {object} LaneAssignment
 * @property {string} path the repository-relative path at the reviewed head
 * @property {RiskLevel} risk the classifier's risk for this file
 * @property {AttentionLane} lane the attention lane assigned by code
 */

/**
 * The per-lane share of the review's effort bound, keyed by lane.
 *
 * @typedef {Record<AttentionLane, number>} LaneBudgets
 */

/**
 * The risk enum this module understands, mirrored from the classifier's
 * `RiskLevel`. The classifier owns the enum's meaning; this copy exists
 * so a plan carrying anything else is refused here rather than coerced
 * into a lane.
 *
 * @type {readonly RiskLevel[]}
 */
const RISK_LEVELS = /** @type {const} */ (["low", "medium", "high", "critical"]);

/**
 * The strictness values this module understands, mirrored from the
 * config schema — same reason: an unknown policy is a refusal, never a
 * guess.
 *
 * @type {readonly Strictness[]}
 */
const STRICTNESS_LEVELS = STRICTNESS;

/**
 * The mapping table — the classifier's risk to an attention lane. This
 * is the whole mapping: explicit, total over the declared risk enum, and
 * readable in one glance. A risk absent from this table cannot produce a
 * lane, because `assignLanes` refuses it before the lookup.
 *
 * @type {Record<RiskLevel, AttentionLane>}
 */
const RISK_TO_LANE = {
  low: "skim",
  medium: "standard",
  high: "deep",
  critical: "deep",
};

/** Every lane, deepest attention first — the budget's priority order. */
const DEEPEST_FIRST = /** @type {const} */ (["deep", "standard", "skim"]);

/**
 * Assigns each entry's attention lane from its classifier plan. The
 * mapping table is the base; the review's strictness can only raise
 * attention — at `high` strictness every file is read deeply, matching
 * the mode paragraph that makes reading every changed file the
 * expectation — never lower it. Pure and deterministic: the same entries
 * and policy always yield the same rows, sorted byte-wise by path.
 *
 * @param {LaneEntry[]} entries one per changed file
 * @param {Pick<ReviewConfig, "strictness">} policy the validated review policy
 * @returns {LaneAssignment[]} sorted byte-wise by path
 * @throws {TypeError} when the policy's strictness or an entry's risk is
 *   not a declared value — refused, never coerced into a lane
 */
export function assignLanes(entries, policy) {
  if (!STRICTNESS_LEVELS.includes(policy.strictness)) {
    throw new TypeError(
      `unknown strictness ${JSON.stringify(policy.strictness)} — attention lanes ` +
        `refuse a policy the schema does not declare, they do not guess it`,
    );
  }
  const rows = entries.map((entry) => {
    const risk = entry.riskPlan.risk;
    if (!RISK_LEVELS.includes(risk)) {
      throw new TypeError(
        `unknown risk ${JSON.stringify(risk)} for ${entry.path} — attention lanes ` +
          `refuse a risk the classifier's enum does not declare, they do not coerce it`,
      );
    }
    // Config raises attention, never lowers it: at high strictness the
    // table's verdict stands below the policy floor.
    const lane = policy.strictness === "high" ? "deep" : RISK_TO_LANE[risk];
    return { path: entry.path, risk, lane };
  });
  rows.sort((a, b) => utf8Compare(a.path, b.path));
  return rows;
}

/**
 * Splits a total effort bound across the lanes that hold at least one
 * file. The rule: occupied lanes share the bound in equal integer
 * parts, computed deepest-first; whatever the equal split leaves over
 * goes one extra part to the deepest occupied lanes first, so the
 * remainder lands where attention matters most and never disappears.
 * An unoccupied lane budgets zero, and a bound smaller than the
 * occupied-lane count starves the shallow lanes first.
 *
 * @param {LaneAssignment[]} lanes the assignments to split for
 * @param {number} totalBound the review's total effort bound, a non-negative integer
 * @returns {LaneBudgets} the per-lane share; the parts sum to `totalBound` exactly
 * @throws {TypeError} when the bound is not a non-negative integer
 */
export function laneBudget(lanes, totalBound) {
  if (!Number.isInteger(totalBound) || totalBound < 0) {
    throw new TypeError(
      `the lane budget takes a non-negative integer bound, got ${String(totalBound)} — ` +
        `refused, not clamped`,
    );
  }
  /** @type {LaneBudgets} */
  const budgets = { deep: 0, standard: 0, skim: 0 };
  const occupied = DEEPEST_FIRST.filter((lane) => lanes.some((entry) => entry.lane === lane));
  if (totalBound === 0 || occupied.length === 0) return budgets;
  const base = Math.floor(totalBound / occupied.length);
  let remainder = totalBound % occupied.length;
  for (const lane of occupied) {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder -= 1;
    budgets[lane] = base + extra;
  }
  return budgets;
}

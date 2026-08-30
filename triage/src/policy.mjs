/**
 * The Policy engine — the deterministic stage that turns Evidence and a
 * bounded Assessment into the final Decision.
 *
 * Item 2 of #224: a deterministic Policy engine that — not the model — turns
 * assessment + evidence + config into the final Decision/mutation plan. This
 * module has no chat seam and no forge reads: it is a pure function over the
 * `Evidence` (config + sheet + measured size + thread facts) and the
 * `Assessment`. Everything a human can audit about a run's decision is in
 * the `Decision` it returns, including the exact lines a dry run would show.
 *
 * Currently it reproduces, faithfully and deterministically, the mutation
 * semantics triage has always had — sheet ceiling, size measured/replaced,
 * workflow-marker clear, off-sheet refusal, entirely-off-sheet red, add
 * dedupe — and it enforces the one-per-thread role rules the policy can
 * already express: `labels.exclusive` groups and the single-valued
 * `priority` role (no two members of the same such role in one assessment;
 * off-policy is a red run, never a partial apply). Wiring `labels.triageOwned`
 * into mutation and deriving a priority label from a severity judgement are
 * the evaluator PRs' work (items 3/4 of #224) — the size ladder already
 * realises owned replacement for the shipped config — and this module is
 * where that decision logic will live.
 */

import { oneLine } from "#core/one-line.mjs";

import { matchLabels } from "./answer.mjs";
import { currentSizeLabels } from "./size.mjs";
import { RATIONALE_CHARS } from "./decision.mjs";

/** @typedef {import("./decision.mjs").Decision} Decision */
/** @typedef {import("./decision.mjs").DecisionLog} DecisionLog */
/** @typedef {import("./evidence.mjs").Evidence} Evidence */
/** @typedef {import("./assessment.mjs").Assessment} Assessment */

/**
 * @typedef {object} PolicyInput
 * @property {Evidence} evidence
 * @property {Assessment} assessment
 */

/**
 * Decides the mutation plan deterministically.
 *
 * @param {PolicyInput} input
 * @returns {Decision}
 */
export function decide({ evidence, assessment }) {
  const { policy, sheet, thread, measuredSize } = evidence;

  if (assessment.intent === "comment") {
    return {
      kind: "comment",
      add: [],
      remove: [],
      refusals: [],
      logs: rationaleLog(assessment.rationale),
      rationale: assessment.rationale,
      comment: {
        classification: assessment.classification,
        rationale: assessment.rationale,
      },
    };
  }

  const sheetNonNull = /** @type {Map<string, string>} */ (sheet);
  const { accepted, refused } = matchLabels(assessment.labels, sheetNonNull);

  // A size rung is a measurement, never a model choice: the ladder is never
  // offered, so a model naming a rung cannot be "on sheet" — but on a PR the
  // rung's only legitimate role is to echo the measurement the diff already
  // produced. A rung-named answer therefore never counts as off-sheet and is
  // never applied raw; the measured rung stays authoritative (code-derived,
  // always on-sheet, reversible). On an issue there is no measurement, so a
  // rung name is off-sheet like any other unoffered name.
  const rungs = policy?.size?.ladder.map((rung) => rung.label) ?? [];
  const offSheet =
    measuredSize === null ? refused : refused.filter((name) => !rungs.includes(name));

  /** @type {DecisionLog[]} */
  const logs = offSheet.map((name) => ({
    level: "warning",
    text: `refused the off-sheet label '${name}' — it is not on the effective sheet; not applied`,
  }));

  if (accepted.length === 0 && offSheet.length > 0) {
    throw new Error(
      "the model's answer was entirely off-sheet — refusing rather than applying nothing",
    );
  }

  // Exclusive groups and priority are one-per-thread role rules: a config
  // that lists `labels.exclusive` names roles of which only one label may sit
  // on a thread, and the `priority` role is ordering metadata that is by
  // definition single-valued. An assessment that proposes two labels under
  // the same such role is off-policy — not a judgement the policy can act on
  // deterministically — so it is refused as a red run: logged, no mutation.
  // The dogfood policy declares no exclusive group and no priority role, so
  // this is a no-op for the shipped config while still closing the loophole
  // for a policy that does declare one. Priority-role labels are never
  // offered to the model, so this branch is only reachable via a config that
  // places a priority label on the sheet; the rule still holds if one does.
  const roleOf = new Map([...(policy?.labels.roles ?? [])]);
  const singleValuedRoles = new Set([...(policy?.labels.exclusive ?? []), "priority"]);
  // The final state, not just the assessment: the thread's current labels and
  // the assessment together must never leave two members of a single-valued
  // role on the thread. A thread already carrying one exclusive member while
  // the assessment proposes another of the same role is off-policy too.
  const onThread = new Set([...thread.labels, ...accepted]);
  for (const role of singleValuedRoles) {
    const members = [...onThread].filter((name) => roleOf.get(name) === role);
    if (members.length > 1) {
      throw new Error(
        `the thread may carry only one member of the single-valued '${role}' role — ` +
          `'${members.join("', '")}' cannot sit together; refusing rather than applying both`,
      );
    }
  }

  // Add-only for the sheet's labels; replacement for size, whichever hand
  // applied the last one. The replacement reads the rungs.
  const add = accepted.filter((name) => !thread.labels.includes(name));
  const replace =
    measuredSize === null || policy?.size === undefined
      ? []
      : currentSizeLabels(thread.labels, policy.size.ladder)
          .filter((name) => name !== measuredSize.label)
          .map((name) => ({ name, reason: /** @type {"size"} */ ("size") }));
  const sizeAdd =
    measuredSize !== null && !thread.labels.includes(measuredSize.label)
      ? [measuredSize.label]
      : [];

  // Workflow markers (the queue label the issue forms apply — this
  // repository's is `needs triage`) sit in labels.workflowMarkers. A marker
  // is cleared — code-deterministically, never a model choice — once a
  // semantic-classification label is classified: a thread carrying a
  // category no longer awaits triage. Absent from the config, nothing is
  // removed; the model is never told the marker's name, because it is on no
  // sheet offered to it.
  const marker = policy?.labels.workflowMarkers[0];
  const classifiedCategory =
    marker !== undefined && policy !== null
      ? accepted.some((name) => policy.labels.roles.get(name) === "semantic-classification")
      : false;
  const clearMarker =
    marker !== undefined && classifiedCategory && thread.labels.includes(marker)
      ? [{ name: marker, reason: /** @type {"marker"} */ ("marker") }]
      : [];

  // Dedupe the add list: a model answer (or a size rung colliding with an
  // accepted category) must not send the same label twice, in the dry-run
  // log or in the write. GitHub would absorb the duplicate, but the dry-run
  // promise is a faithful preview.
  const toAdd = [...new Set([...add, ...sizeAdd])];

  return {
    kind: "labels",
    add: toAdd,
    remove: [...replace, ...clearMarker],
    refusals: offSheet,
    logs: [...logs, ...rationaleLog(assessment.rationale)],
    rationale: assessment.rationale,
    comment: undefined,
  };
}

/**
 * The rationale line a run logs — one line, collapsed, capped. Empty quote
 * emits nothing, exactly as before.
 *
 * @param {string} rationale
 * @returns {DecisionLog[]}
 */
function rationaleLog(rationale) {
  const flat = oneLine(rationale);
  if (flat === "") return [];
  return [{ level: "info", text: `rationale: ${flat.slice(0, RATIONALE_CHARS)}` }];
}

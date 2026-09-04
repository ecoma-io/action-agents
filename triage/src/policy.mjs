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
 * The relationship vocabulary the model may judge a candidate with. The
 * prompt offers exactly these five; anything else a model answers is
 * ignored with a warning, never coerced into one of these.
 */
const RELATIONSHIP_TYPES = new Set([
  "duplicate",
  "related",
  "likely-resolves",
  "supersedes",
  "similar",
]);
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
      signal: null,
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
  const markers = policy?.labels.workflowMarkers ?? [];
  const classifiedCategory =
    markers.length > 0 && policy !== null
      ? accepted.some((name) => policy.labels.roles.get(name) === "semantic-classification")
      : false;
  const clearMarker = classifiedCategory
    ? markers
        .filter((marker) => thread.labels.includes(marker))
        .map((name) => ({ name, reason: /** @type {"marker"} */ ("marker") }))
    : [];

  // Issue-side evaluator dimensions (PR-C): a sheet-mode issue run asks the
  // model three bounded questions — quality, relationships, priority —
  // and this deterministic stage turns the answers into
  // mutation. Every label these produce comes only through a map the config
  // declares (a form id's routing area, a severity's priority rung, the
  // needs-more-info label); a judgement the config cannot express as a
  // label becomes a signal comment (`decision.signal`), composed by the
  // action, never by the model. The whole block is gated on sheet + issue,
  // so a PR run or a no-sheet run changes nothing it did before.
  /** @type {string[]} */
  const issueAdds = [];
  /** @type {import("./decision.mjs").Removal[]} */
  const issueRemoves = [];
  /** @type {{ needsMoreInfo: string[], modelJudgedQuality: boolean, related: import("./decision.mjs").Signal["related"] }} */
  const signalParts = { needsMoreInfo: [], modelJudgedQuality: false, related: null };

  if (sheet !== null && thread.type === "issue") {
    const dimensions = /** @type {import("./answer.mjs").IssueDimensions} */ (
      assessment.dimensions
    );
    const qualityFacts = evidence.quality;

    // Routing is deterministic by form: the template the body matched names
    // the area label, exactly, with no model in the loop. The form facts are
    // code-measured on the issue itself, never model output.
    const routingArea = policy?.labels.routing?.[qualityFacts?.template?.id ?? ""];
    if (routingArea !== undefined) issueAdds.push(routingArea);

    // Priority is a derivation, never a proposal: the model's severity
    // judgement maps through `labels.priority` to exactly one label. A
    // severity off the map is a warning, not a failure — the judgement is
    // advisory, the derivation is the policy's own. Carrying a different
    // priority-role member is handled by the triageOwned replace below or
    // the single-valued-role red run above; the derived label itself is
    // code-derived, so it is excluded from the model's `accepted` set.
    const severity = dimensions?.priority?.severity;
    const priorityMap = policy?.labels.priority;
    if (severity !== undefined && severity !== null && priorityMap !== undefined) {
      const derived = priorityMap.get(severity);
      if (derived === undefined) {
        logs.push({
          level: "warning",
          text: `severity '${severity}' is not on the labels.priority map — no priority label applied`,
        });
      } else {
        const members = [...thread.labels, ...accepted].filter(
          (name) => roleOf.get(name) === "priority",
        );
        const carryingOther = members.find((name) => name !== derived);
        if (carryingOther !== undefined) {
          if (policy?.labels.triageOwned.has(carryingOther)) {
            // A triage-owned label is replaced, never left to sit beside a
            // derived priority: the ownership is the config's promise that
            // the label is replaceable.
            issueRemoves.push({ name: carryingOther, reason: "owned" });
            issueAdds.push(derived);
          } else {
            throw new Error(
              `the thread may carry only one member of the single-valued 'priority' role — ` +
                `'${carryingOther}', '${derived}' cannot sit together; refusing rather than applying both`,
            );
          }
        } else {
          issueAdds.push(derived);
        }
      }
    }

    // Quality: an issue judged incomplete gets the config's needs-more-info
    // label when one is declared; otherwise the judgement becomes a signal
    // comment naming the deterministic missing-required fields (or, when
    // only the model judged it, a fixed sentence — never model prose).
    const needsMoreInfoLabel = policy?.labels.needsMoreInfo ?? null;
    const modelJudgedIncomplete = dimensions?.quality?.completeness === "missing-evidence";
    const missingRequired = qualityFacts?.missingRequired ?? [];
    if (modelJudgedIncomplete || missingRequired.length > 0) {
      if (needsMoreInfoLabel !== null) {
        issueAdds.push(needsMoreInfoLabel);
      } else {
        signalParts.needsMoreInfo = [...missingRequired];
        signalParts.modelJudgedQuality = modelJudgedIncomplete;
      }
    }

    // Relationships: the model judges search candidates by index; the
    // deterministic stage keeps only judgements that point at a real
    // candidate with a known type and a positive confidence, and picks the
    // most confident (ties: lowest candidate number). Off-vocab types and
    // out-of-range indexes are ignored with a warning — a model naming
    // something that is not a candidate mutates nothing.
    const candidates = evidence.forgeSearch?.candidates ?? [];
    const judged = (dimensions?.relationships?.candidates ?? []).filter((item) => {
      const indexOk =
        Number.isInteger(item.index) && item.index >= 0 && item.index < candidates.length;
      const typeOk = typeof item.type === "string" && RELATIONSHIP_TYPES.has(item.type);
      if (!indexOk || !typeOk) {
        logs.push({
          level: "warning",
          text: `ignored a relationship judgement for candidate ${String(item.index)} (${String(
            item.type,
          )}) — not a search candidate or not a known relationship type`,
        });
        return false;
      }
      return typeof item.confidence === "number" && item.confidence > 0;
    });
    if (judged.length > 0) {
      let best = /** @type {(typeof judged)[number]} */ (judged[0]);
      for (const item of judged) {
        const itemConfidence = item.confidence ?? 0;
        const bestConfidence = best.confidence ?? 0;
        const bestItem = candidates[best.index];
        const itemFor = candidates[item.index];
        if (bestItem === undefined || itemFor === undefined) continue;
        const better =
          itemConfidence > bestConfidence ||
          (itemConfidence === bestConfidence && itemFor.number < bestItem.number);
        if (better) best = item;
      }
      const bestCandidate = candidates[best.index];
      if (bestCandidate !== undefined) {
        signalParts.related = {
          number: bestCandidate.number,
          title: bestCandidate.title,
          type: /** @type {string} */ (best.type),
        };
      }
    }
  }

  const signal =
    signalParts.needsMoreInfo.length > 0 ||
    signalParts.modelJudgedQuality ||
    signalParts.related !== null
      ? { ...signalParts }
      : null;

  // Dedupe the add list: a model answer (or a size rung colliding with an
  // accepted category, or an issue-side label colliding with either) must
  // not send the same label twice, in the dry-run log or in the write.
  // GitHub would absorb the duplicate, but the dry-run promise is a
  // faithful preview. The thread's own labels are the other dedupe: a
  // code-derived issue label — a routing area, a derived priority rung,
  // the needs-more-info label — the thread already carries is a no-op,
  // never a re-list.
  const derivedAdds = issueAdds.filter((name) => !thread.labels.includes(name));
  const toAdd = [...new Set([...add, ...sizeAdd, ...derivedAdds])];

  return {
    kind: "labels",
    add: toAdd,
    remove: [...replace, ...clearMarker, ...issueRemoves],
    refusals: offSheet,
    logs: [...logs, ...rationaleLog(assessment.rationale)],
    rationale: assessment.rationale,
    comment: undefined,
    signal,
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

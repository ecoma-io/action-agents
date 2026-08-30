/**
 * The Decision — the auditable, idempotent mutation plan at the heart of the
 * Work Item pipeline.
 *
 * The pipeline's contract: an `Evidence` object and a bounded `Assessment`
 * flow into the deterministic policy engine, which produces exactly one
 * `Decision`. Nothing else decides mutation. This module defines the shape of
 * that decision and renders it for a human (the dry-run preview and the
 * no-sheet comment body) — pure functions, no IO. Executing a decision is
 * `mutate.mjs`'s job, and it does nothing a decision does not name.
 */

import { oneLine } from "#core/one-line.mjs";
import { warning } from "#core/runtime.mjs";
import { sanitiseCommentText } from "#core/sanitise.mjs";

/** The rationale's cap in the marker comment and the run log, in characters. */
export const RATIONALE_CHARS = 300;

/**
 * A label this run removes, and why. The reason is carried so a dry run and
 * a live run say the same thing about the same removal — a size replace and
 * a marker clear are removed by code for different reasons, and the preview
 * spells out which is which.
 *
 * @typedef {object} Removal
 * @property {string} name
 * @property {"size" | "marker"} reason
 */

/**
 * A log line the executor should emit, so a run's words exactly match its
 * dry run.
 *
 * @typedef {object} DecisionLog
 * @property {"info" | "warning"} level
 * @property {string} text
 */

/**
 * The mutation plan. `mutate.mjs` executes exactly its `add`, `remove` and
 * `comment` — nothing else, so a decision can never reach assign, close,
 * merge, review or any surface `SECURITY.md` forbids.
 *
 * @typedef {object} Decision
 * @property {"labels" | "comment"} kind
 *   `labels`  → apply and remove labels
 *   `comment` → no sheet; upsert the classification comment
 * @property {string[]} add labels to add — idempotent, deduped
 * @property {Removal[]} remove labels to remove, each with its reason
 * @property {string[]} refusals off-sheet names refused, for the audit trail
 * @property {DecisionLog[]} logs lines the executor emits verbatim
 * @property {string} rationale the model's one-line rationale, for the run log
 * @property {{ classification: string, rationale: string } | undefined} comment present only when `kind === "comment"`
 */

/**
 * The marker comment written when there is no sheet — the whole of what the
 * action can produce in that mode. Model text reaches it only through the
 * sanitiser; the scaffolding around it is the action's own.
 *
 * @param {{ classification: string, rationale: string }} answer
 * @param {string} marker
 * @returns {string}
 */
export function commentBody(answer, marker) {
  const classification = sanitiseCommentText(oneLine(answer.classification), {
    maxChars: RATIONALE_CHARS,
    forbidden: [marker],
  });
  const rationale = sanitiseCommentText(oneLine(answer.rationale), {
    maxChars: RATIONALE_CHARS,
    forbidden: [marker],
  });
  for (const note of [...classification.notes, ...rationale.notes]) {
    warning(`sanitiser: ${note}`);
  }
  return [
    marker,
    "",
    `**${classification.text || "(no classification)"}**`,
    "",
    rationale.text === "" ? "" : `> ${rationale.text}`,
    "",
    "_Classified by the `triage` action. No label sheet is configured in this repository, so the classification is posted as a comment — configure `.github/action-agents/triage/triage.json5` to apply labels instead._",
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

/**
 * Renders a decision as a human-readable dry-run preview. Faithful: every
 * line here is exactly the line a live run would print or write, so the
 * dry-run promise — a preview that cannot surprise — is kept by
 * construction.
 *
 * @param {Decision} decision
 * @returns {string[]} the lines to print, in order
 */
export function renderDryRun(decision) {
  if (decision.kind === "comment") {
    const answer = /** @type {{ classification: string, rationale: string }} */ (decision.comment);
    return [
      "dry run — the classification would be written as this comment:",
      commentBody(answer, "<!-- action-agents:triage:dry-run -->"),
    ];
  }
  const replace = decision.remove.filter((removal) => removal.reason === "size");
  const clearMarker = decision.remove.filter((removal) => removal.reason === "marker");
  const parts = [`dry run — would add [${decision.add.join(", ")}]`];
  if (replace.length > 0) {
    parts.push(
      ` and remove [${replace.map((removal) => removal.name).join(", ")}] (size is replaced, not added to)`,
    );
  }
  if (clearMarker.length > 0) {
    parts.push(
      ` and remove [${clearMarker.map((removal) => removal.name).join(", ")}] (triage marker cleared on classification)`,
    );
  }
  return [parts.join("")];
}

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
 * @property {typeof REMOVAL_REASONS[number]} reason
 */

/** The vocabulary a removal's `reason` may carry, frozen; the run record's validator holds its copy from here so the two cannot drift. */
export const REMOVAL_REASONS = /** @type {const} */ (["size", "marker", "owned"]);

/**
 * A code-derived signal a sheet-mode issue run posts as a comment: the
 * action's own words about the thread's quality or relationship to another
 * thread. Only needs-more-info and a best relationship are signalled; a
 * priority the action derives is a label, never a signal. Every word here is
 * composed by the action — model text never reaches a signal body.
 *
 * @typedef {object} Signal
 * @property {string[]} needsMoreInfo the deterministic missing-required fields, when the issue is judged incomplete
 * @property {boolean} modelJudgedQuality true when the incomplete judgement came from the model's completeness, not from a missing form field
 * @property {{ number: number, title: string, type: string } | null} related the best relationship candidate, when one was judged
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
 * The mutation plan. `mutate.mjs` executes exactly the operations
 * `decisionWriteOps` derives from it — its `add`, `remove`, `comment` and
 * `signal` — nothing else, so a decision can never reach assign, close,
 * merge, review or any surface `SECURITY.md` forbids.
 *
 * @typedef {object} Decision
 * @property {"labels" | "comment"} kind
 *   `labels`  → apply and remove labels
 *   `comment` → no sheet; upsert the classification comment
 * @property {string[]} add labels to add — idempotent, deduped
 * @property {Removal[]} remove labels to remove, each with its reason
 * @property {string[]} refusals refused operations, for the audit trail — the off-sheet label names the policy refused, and the `verification downgraded '…'` lines the verification pass refused
 * @property {DecisionLog[]} logs lines the executor emits verbatim
 * @property {string} rationale the model's one-line rationale, for the run log
 * @property {{ classification: string, rationale: string } | undefined} comment present only when `kind === "comment"`
 * @property {Signal | null} [signal] a code-composed signal comment a sheet-mode issue run may post; absent for runs that post none
 */

/**
 * One concrete write operation a decision names: the forge primitive, the
 * code-minted id the verification plan and the record quote, what the write
 * acts on (the run log's name for it), and the op in the action's own words
 * (what the verifier is told).
 *
 * @typedef {object} DecisionWriteOp
 * @property {"removeLabel" | "addLabels" | "upsertComment"} write the forge primitive the executor issues
 * @property {string} opId `remove:<label>`, `add:<label>`, the bare `comment` or the bare `signal`
 * @property {string} target what the operation acts on
 * @property {string} description
 */

/** The code-minted id of the signal comment's one write. */
export const SIGNAL_OP_ID = "signal";

/**
 * The concrete write operations a decision names, in the order the executor
 * applies them: removals first, then the adds, then the one comment a
 * decision may carry — the classification or the signal. This function is
 * the single source of a decision's write surface: the verification plan is
 * minted from it (`verify.mjs`) and the executor builds its forge calls from
 * it (`mutate.mjs`), so the two cannot diverge — a write that exists for one
 * exists for the other, under the same code-minted id. Pure: a decision and
 * its rendered plan always agree.
 *
 * The adds are one entry per label even though the executor batches them
 * into a single write: each label is judged — and confirmed or downgraded —
 * on its own, and the batch the executor sends is built from exactly the
 * entries that survived.
 *
 * @param {Decision} decision
 * @returns {DecisionWriteOp[]}
 */
export function decisionWriteOps(decision) {
  /** @type {DecisionWriteOp[]} */
  const ops = [];
  for (const removal of decision.remove) {
    ops.push({
      write: "removeLabel",
      opId: `remove:${removal.name}`,
      target: removal.name,
      description: `remove the label '${removal.name}' (${removal.reason})`,
    });
  }
  for (const label of decision.add) {
    ops.push({
      write: "addLabels",
      opId: `add:${label}`,
      target: label,
      description: `apply the label '${label}'`,
    });
  }
  if (decision.kind === "comment") {
    ops.push({
      write: "upsertComment",
      opId: "comment",
      target: "classification comment",
      description: "upsert the classification comment the decision composed",
    });
  }
  if (decision.signal != null) {
    ops.push({
      write: "upsertComment",
      opId: SIGNAL_OP_ID,
      target: "signal comment",
      description: "upsert the code-composed signal comment the decision composed",
    });
  }
  return ops;
}

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
 * The signal comment a sheet-mode issue run posts — the action's own words,
 * never model prose. It states what is missing or related, and names the
 * one-click reversible surface (a comment) as the ceiling: it never asks to
 * close, assign or mention anyone. `#n` references and the candidate title
 * are the only untrusted fragments, and they pass through the sanitiser.
 *
 * @param {Signal} signal
 * @param {string} marker
 * @returns {string}
 */
export function signalBody(signal, marker) {
  /** @type {string[]} */
  const lines = [marker];
  // The field names enter `signal.needsMoreInfo` from the repository's own
  // `.github/ISSUE_TEMPLATE/*.yml` `attributes.label` entries — untrusted
  // repository data on its way into a comment. They get the same treatment
  // as the related-candidate title below: one line, mention-broken, tags
  // escaped, capped, and the action's own marker stripped.
  const missingFields =
    signal.needsMoreInfo.length > 0
      ? sanitiseCommentText(oneLine(signal.needsMoreInfo.join(", ")), {
          maxChars: 80,
          forbidden: [marker],
        }).text
      : "";
  if (signal.needsMoreInfo.length > 0 || signal.modelJudgedQuality) {
    lines.push(
      "",
      "This issue looks incomplete. This is a note, not a closing: the thread stays open and nothing is closed.",
      "",
      signal.modelJudgedQuality && signal.needsMoreInfo.length === 0
        ? "The report cannot be followed as written; adding steps to reproduce, expected-versus-actual, environment details or the run log would help."
        : `The following required field${signal.needsMoreInfo.length === 1 ? "" : "s"} ${
            signal.needsMoreInfo.length === 1 ? "is" : "are"
          } empty: ${missingFields}.`,
    );
  }
  if (signal.related !== null) {
    const title = sanitiseCommentText(oneLine(signal.related.title), {
      maxChars: 80,
      forbidden: [marker],
    }).text;
    lines.push(
      "",
      `Possibly ${signal.related.type} of #${String(signal.related.number)} — ${title || "(untitled)"}.`,
    );
  }
  lines.push("", "_Posted by the `triage` action._");
  return lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
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
  const owned = decision.remove.filter((removal) => removal.reason === "owned");
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
  if (owned.length > 0) {
    parts.push(
      ` and remove [${owned.map((removal) => removal.name).join(", ")}] (triage-owned label replaced by the derived priority)`,
    );
  }
  if (decision.signal != null) {
    parts.push(
      ` and post a signal comment: ${signalBody(decision.signal, "<!-- action-agents:triage:dry-run -->").replace(/\n/g, " ")}`,
    );
  }
  return [parts.join("")];
}

/**
 * `harmonise` changed-block planning — the deterministic diff between a
 * document's previous source blocks and its current ones.
 *
 * Harmonise retranslates whole documents. `planBlocks` is the piece that
 * makes block-level retranslation possible later: given the blocks of the
 * previous source and the blocks of the current source, it says exactly
 * which current blocks need a fresh translation (`changed`), which can be
 * kept as they are (`unchanged`), which are new (`added`), and which of the
 * previous blocks have no counterpart anymore (`removed`).
 *
 * ## DOCTRINE
 *
 * Block planning is deterministic fingerprint comparison. It never consults
 * the model, and model output has no path into the plan: the only inputs are
 * the two block arrays, the only signal is the sha-256 content fingerprint
 * from {@link import("./fingerprint.mjs").contentFingerprint}, and the only
 * tie-breaks are array order. The same two arrays always produce the same
 * plan.
 *
 * The rules, in precedence order:
 *
 * 1. Blocks are matched by content identity, never by index. A block whose
 *    fingerprint is unchanged stays `unchanged` no matter where it moved —
 *    a position-only move is not a change, so a consumer may reorder
 *    without retranslating.
 * 2. Duplicate identical blocks match in order: the k-th occurrence of a
 *    fingerprint in the previous array pairs with the k-th occurrence in
 *    the current array. This is the only tie-break duplicates get.
 * 3. Blocks left over after exact matching pair up in ascending index order
 *    (k-th leftover previous with k-th leftover current); each pair reports
 *    its current index as one `changed` block. The pairing is positional
 *    alignment for the consumer, not a claim that the contents resemble
 *    each other — no similarity heuristic exists in this module, and none
 *    may: anything beyond fingerprint equality would be a guess.
 * 4. Leftovers with no partner are `added` (current indexes) or `removed`
 *    (previous indexes).
 *
 * Edge cases are explicit, never silent: an empty previous array makes
 * every current block `added`; an empty current array makes every previous
 * block `removed`; both empty produce the empty plan.
 *
 * Every result array is sorted ascending. `unchanged`, `changed` and
 * `added` hold indexes into `currentBlocks`; `removed` holds indexes into
 * `previousBlocks`.
 *
 * Pure functions: no files, no model, no clock. The planner reads only each
 * block's `content` string; any further fields a segmentation stage adds
 * (a type, a heading level, …) ride along for the consumer and are ignored
 * here — content identity is the whole truth.
 *
 * @module harmonise/src/blocks
 */

import { contentFingerprint } from "./fingerprint.mjs";

/**
 * One block of a source document, as a segmentation stage produces it. The
 * planner's only field is `content`; a block without a string `content`
 * cannot be fingerprinted and is refused at the hashing boundary rather
 * than silently compared as something else.
 *
 * @typedef {object} SourceBlock
 * @property {string} content the block's exact source text
 */

/**
 * The plan: which current blocks to keep, which to retranslate, which are
 * new, and which previous blocks disappeared.
 *
 * @typedef {object} BlockPlan
 * @property {number[]} unchanged current blocks whose content is byte-identical to some previous block's, wherever they now sit
 * @property {number[]} changed current blocks aligned with a previous block of different content
 * @property {number[]} added current blocks with no previous block to align with
 * @property {number[]} removed previous blocks with no current counterpart
 */

/**
 * The plan reduced to counts, for run summaries and logs.
 *
 * @typedef {object} BlockPlanSummary
 * @property {number} unchanged
 * @property {number} changed
 * @property {number} added
 * @property {number} removed
 */

/**
 * Diffs the previous source blocks against the current ones into a
 * deterministic plan — see the module doctrine for the matching rules.
 *
 * @param {readonly SourceBlock[]} previousBlocks the previous source's blocks, in document order
 * @param {readonly SourceBlock[]} currentBlocks the current source's blocks, in document order
 * @returns {BlockPlan} every current block classified exactly once across
 *   `unchanged`, `changed` and `added`, and every previous block classified
 *   exactly once across the matching pairs and `removed`
 */
export function planBlocks(previousBlocks, currentBlocks) {
  // Fingerprint → ascending previous indexes, so duplicates offer their
  // occurrences in document order and the first-unmatched scan below is
  // the k-th-occurrence zip the doctrine names.
  /** @type {Map<string, number[]>} */
  const previousByFingerprint = new Map();
  for (const [index, block] of previousBlocks.entries()) {
    const fingerprint = contentFingerprint(block.content);
    const slots = previousByFingerprint.get(fingerprint);
    if (slots) slots.push(index);
    else previousByFingerprint.set(fingerprint, [index]);
  }

  const unchanged = new Set();
  const matchedPrevious = new Set();
  for (const [index, block] of currentBlocks.entries()) {
    const slots = previousByFingerprint.get(contentFingerprint(block.content));
    if (!slots) continue;
    for (const previousIndex of slots) {
      if (!matchedPrevious.has(previousIndex)) {
        matchedPrevious.add(previousIndex);
        unchanged.add(index);
        break;
      }
    }
  }

  const leftoverPrevious = [];
  for (const index of previousBlocks.keys()) {
    if (!matchedPrevious.has(index)) leftoverPrevious.push(index);
  }
  const leftoverCurrent = [];
  for (const index of currentBlocks.keys()) {
    if (!unchanged.has(index)) leftoverCurrent.push(index);
  }

  const paired = Math.min(leftoverPrevious.length, leftoverCurrent.length);
  return {
    unchanged: [...unchanged].sort((a, b) => a - b),
    changed: leftoverCurrent.slice(0, paired),
    added: leftoverCurrent.slice(paired),
    removed: leftoverPrevious.slice(paired),
  };
}

/**
 * Counts the plan's four fields. A pure projection of {@link planBlocks}
 * output — no re-computation, no new signal.
 *
 * @param {BlockPlan} plan a plan as {@link planBlocks} produced it
 * @returns {BlockPlanSummary}
 */
export function summarizePlan(plan) {
  return {
    unchanged: plan.unchanged.length,
    changed: plan.changed.length,
    added: plan.added.length,
    removed: plan.removed.length,
  };
}

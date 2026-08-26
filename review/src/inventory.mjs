/**
 * The changed-file inventory — what exists for this review, and how big the
 * diff is. Both answers come straight from GitHub's files API; the model is
 * never in a position to supply or influence either.
 *
 * `ignore` is the universe filter, applied first: a file whose head path
 * matches the ignore set does not exist for this run — not in the inventory,
 * not in the maxDiffLines basis, not anywhere. Membership is decided by the
 * path a file has at the reviewed head: the new path for a rename, the
 * recorded path for a deletion. The old path of a rename is never consulted.
 *
 * The diff budget then walks the survivors in byte-wise path order,
 * accumulating additions plus deletions until `maxDiffLines` breaks; that
 * file and everything after it in that order is the excluded remainder, and
 * the run refuses upstream with both numbers named. A half-reviewed diff
 * presented as a complete review is refused, never truncated.
 */

import { matchGlob } from "#core/glob.mjs";

import { utf8Compare } from "./order.mjs";

/** @typedef {import("#core/forge.mjs").PullRequestFile} PullRequestFile */

/**
 * One changed file that survived the universe filter — possibly not the
 * budget, which is what `excluded` separates out.
 *
 * @typedef {PullRequestFile} ChangedFile
 */

/**
 * @typedef {object} Inventory
 * @property {ChangedFile[]} reviewed non-ignored files inside the diff budget, sorted byte-wise
 * @property {ChangedFile[]} excluded the remainder past `maxDiffLines`, same order
 * @property {ChangedFile[]} ignored dropped by the universe filter, API order
 * @property {number} countedDiffLines additions plus deletions over `reviewed`
 * @property {number} excludedDiffLines the remainder's own count
 */

/**
 * @param {object} input
 * @param {PullRequestFile[]} input.files GitHub's listing, verbatim
 * @param {string[]} input.ignore the config's glob patterns
 * @param {number} input.maxDiffLines
 * @returns {Inventory}
 */
export function buildInventory({ files, ignore, maxDiffLines }) {
  /** @type {ChangedFile[]} */
  const ignored = [];
  /** @type {ChangedFile[]} */
  const candidates = [];
  for (const file of files) {
    if (matchGlob(ignore, file.filename)) {
      ignored.push(file);
      continue;
    }
    candidates.push(file);
  }
  // Byte-wise path order: the budget break, and therefore the excluded
  // remainder, must not depend on the order GitHub happened to answer in.
  candidates.sort((a, b) => utf8Compare(a.filename, b.filename));

  /** @type {ChangedFile[]} */
  const reviewed = [];
  /** @type {ChangedFile[]} */
  const excluded = [];
  let counted = 0;
  let excludedCounted = 0;
  let broken = false;
  for (const file of candidates) {
    const lines = file.additions + file.deletions;
    if (!broken && counted + lines > maxDiffLines) broken = true;
    if (broken) {
      excluded.push(file);
      excludedCounted += lines;
    } else {
      reviewed.push(file);
      counted += lines;
    }
  }

  return {
    reviewed,
    excluded,
    ignored,
    countedDiffLines: counted,
    excludedDiffLines: excludedCounted,
  };
}

/**
 * Every declared rule whose include matches at least one reviewed file, in
 * config order. Rules are additive: several may apply, none overrides
 * another, and matching nothing is dormancy — rules are declared for the
 * repository, not for one diff.
 *
 * @param {{ include: string[], instruction: string }[]} rules
 * @param {ChangedFile[]} reviewed
 * @returns {{ include: string[], instruction: string }[]}
 */
export function selectActiveRules(rules, reviewed) {
  return rules.filter((rule) => reviewed.some((file) => matchGlob(rule.include, file.filename)));
}

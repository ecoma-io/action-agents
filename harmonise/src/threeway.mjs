/**
 * `harmonise` three-way target merge — deterministic line-level diff3.
 *
 * When harmonise re-publishes a translated file, the consumer may have
 * hand-edited the published target since. Overwriting destroys those edits;
 * ignoring them loses the retranslation. This module computes the
 * deterministic answer: a three-way merge at line granularity between
 *
 * - `baseText` — what harmonise last published,
 * - `manualText` — the current target on disk, manual edits included,
 * - `freshText` — the fresh translation of the current source.
 *
 * Doctrine, binding for every change to this module:
 *
 * - **Deterministic text accounting.** The same three inputs always produce
 *   the same merged output, the same conflicts and the same counts. Nothing
 *   here consults the clock, the network or a model.
 * - **Manual edits win ties.** When both sides changed the same region, the
 *   merged output keeps the manual text for that region and the region is
 *   reported as a conflict. Generated text never silently displaces a human
 *   edit.
 * - **Conflicts are surfaced, never silently resolved.** `mergeThreeWay`
 *   reports every region it could not decide; choosing among the conflicting
 *   texts is policy that lives outside this module.
 * - **Model output has no authority over conflict outcomes.** A model-authored
 *   line participates only as the `freshText` input: it is adopted exactly
 *   where the manual side did not change, and it never wins a region the
 *   manual side also changed.
 *
 * Algorithm:
 *
 * 1. Each side is aligned against the base with a longest-common-subsequence
 *    line diff — dynamic programming over a flat `Int32Array`, O(B·M) and
 *    O(B·F) time and space for B base lines and M / F side lines (sized for
 *    documentation files). The backtrack is deterministic: when the current
 *    lines are equal the match is always taken (optimal for LCS); otherwise
 *    the walk advances toward the larger neighbour, preferring the base side
 *    on ties.
 * 2. Each side's changes reduce to maximal regions in base coordinates: a run
 *    of unmatched base lines, an insertion, or both. Regions on one side are
 *    always separated by at least one matched base line.
 * 3. A single sweep walks both sides' regions in base order. Two regions join
 *    into a union when their base ranges strictly intersect, or when both are
 *    zero-width insertions at the same point; adjacent (touching but
 *    disjoint) regions merge cleanly, because each side's content lands in
 *    order with nothing interleaved. A union grows while further regions
 *    overlap it.
 * 4. A union whose sides' renditions agree is emitted once. A union whose
 *    renditions disagree is a conflict: the manual rendition is emitted, and
 *    the fresh rendition survives only inside the reported excerpt.
 *
 * Line convention: lines split on `"\n"`; an empty string has no lines, and a
 * trailing newline is a final empty line — so `lines.join("\n")` always
 * rebuilds the exact input, trailing newline included. Only `"\n"` is
 * recognised; a caller holding `\r\n` text normalizes it first.
 */

import { RefusalError } from "./recovery.mjs";

/**
 * A region both sides changed differently: the merged output keeps the manual
 * text and reports the disagreement.
 *
 * `startLine` is the 1-indexed line in `merged` where the kept (manual)
 * rendition begins; a conflict that kept nothing — the manual side deleted
 * the region — points at the line after the join point. Excerpts are the
 * sides' renditions of the union region joined with newlines, truncated past
 * `EXCERPT_MAX_LENGTH` characters with a `...` suffix.
 *
 * @typedef {object} MergeConflict
 * @property {number} startLine 1-indexed line in the merged output.
 * @property {string} baseExcerpt The base's rendition of the union region.
 * @property {string} manualExcerpt The manual side's rendition — what was kept.
 * @property {string} freshExcerpt The fresh side's rendition — what was not.
 */

/**
 * One decided region of the merge, in merged-output coordinates.
 *
 * `type` is `"manual"` (base→manual changed, base→fresh did not — the manual
 * edit is preserved), `"fresh"` (base→fresh changed, base→manual did not —
 * the fresh translation is adopted), `"both"` (both sides made the same
 * change — emitted once, counted nowhere) or `"conflict"` (kept manual,
 * reported). `startLine` is the 1-indexed merged line where the region's
 * rendition begins; a region whose rendition is empty (a deletion) points at
 * the line after the join point.
 *
 * @typedef {object} MergeChange
 * @property {"manual" | "fresh" | "both" | "conflict"} type
 * @property {number} startLine
 */

/**
 * @typedef {object} MergeResult
 * @property {string} merged The merged text.
 * @property {MergeConflict[]} conflicts Regions that could not be decided.
 * @property {MergeChange[]} changes Every decided region, in output order.
 */

/**
 * @typedef {object} MergeSummary
 * @property {number} preservedManual Regions where a manual edit was preserved.
 * @property {number} adoptedFresh Regions where the fresh translation was adopted.
 * @property {number} conflicts Conflict regions. Counted separately, never as
 *   a preservation: a conflict keeps the manual text but still needs a human
 *   decision.
 */

/** Maximum character length of a conflict excerpt, `...` suffix included. */
const EXCERPT_MAX_LENGTH = 120;
/**
 * Cap on the LCS DP table size, in Int32 entries — `(n+1)·(m+1)` for each
 * diffed pair. Refused past this, never thrashed: the default policy then
 * declines to retry a merge no retry could make smaller.
 */
const MERGE_TABLE_LIMIT = 2 ** 23;

/**
 * Split text into lines: an empty string has no lines, a trailing newline is
 * a final empty line, and `toLines(t).join("\n") === t` for every input.
 *
 * @param {string} text
 * @returns {string[]}
 */
function toLines(text) {
  return text === "" ? [] : text.split("\n");
}

/**
 * Longest-common-subsequence match pairs between two line arrays.
 *
 * Deterministic: the DP table is filled row by row, and the backtrack always
 * takes an equal pair as a match (LCS-optimal) and otherwise advances toward
 * the larger neighbour, preferring the `a` side — a deletion — on ties.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<[number, number]>} `[aIndex, bIndex]` pairs, ascending.
 */
function lcsMatches(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // `dp[i * width + j]` — LCS length of `a[0..i)` and `b[0..j)`.
  const dp = new Int32Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    const row = i * width;
    const prev = row - width;
    const line = a[i - 1];
    for (let j = 1; j <= m; j++) {
      dp[row + j] =
        line === b[j - 1]
          ? (dp[prev + j - 1] ?? 0) + 1
          : Math.max(dp[prev + j] ?? 0, dp[row + j - 1] ?? 0);
    }
  }
  /** @type {Array<[number, number]>} */
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if ((dp[(i - 1) * width + j] ?? 0) >= (dp[i * width + (j - 1)] ?? 0)) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return pairs.reverse();
}

/**
 * First index in `matches` whose base line is `baseLine` or later (lower
 * bound over the ascending `aIndex` column).
 *
 * @param {Array<[number, number]>} matches
 * @param {number} baseLine
 * @returns {number}
 */
function lowerBound(matches, baseLine) {
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const pair = matches[mid];
    if (pair && pair[0] < baseLine) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * A side's rendition of the base range `[start, end)`: the lines that side
 * has in place of those base lines, unmatched-region insertions included and
 * neighbouring matched lines excluded.
 *
 * @param {Array<[number, number]>} matches
 * @param {string[]} other
 * @param {number} start
 * @param {number} end
 * @returns {string[]}
 */
function rendition(matches, other, start, end) {
  const lo = lowerBound(matches, start);
  const hi = lowerBound(matches, end);
  const before = matches[lo - 1];
  const after = matches[hi];
  const from = before ? before[1] + 1 : 0;
  const to = after ? after[1] : other.length;
  return other.slice(from, to);
}

/**
 * A side's rendition of a union region — the shared base range two or more
 * regions grew into. Unlike a side's own region, a union's start line belongs
 * to the side only when it changed base line `start` itself: when the side
 * kept the line, a match exists at exactly `start` and the rendition begins
 * there, because lines the side inserted in the gap just before `start` form
 * their own region — already emitted — and must not be swept in a second
 * time. For a zero-width union (two insertions merged at one point) those
 * gap lines are precisely the merged content, so the region rule applies.
 *
 * @param {Array<[number, number]>} matches
 * @param {string[]} other
 * @param {number} start
 * @param {number} end
 * @returns {string[]}
 */
function unionRendition(matches, other, start, end) {
  if (start === end) {
    return rendition(matches, other, start, end);
  }
  const lo = lowerBound(matches, start);
  const first = matches[lo];
  const before = matches[lo - 1];
  const from = first && first[0] === start ? first[1] : before ? before[1] + 1 : 0;
  const hi = lowerBound(matches, end);
  const after = matches[hi];
  const to = after ? after[1] : other.length;
  return other.slice(from, to);
}

/**
 * A side's changed regions in base coordinates, derived from its LCS match
 * pairs: every gap between consecutive matches where either the base lines or
 * the side's lines are non-empty. Zero-width regions are pure insertions.
 *
 * @param {Array<[number, number]>} matches
 * @param {number} baseLength
 * @param {number} otherLength
 * @returns {Array<{start: number, end: number}>} sorted, never touching.
 */
function changeRegions(matches, baseLength, otherLength) {
  /** @type {Array<{start: number, end: number}>} */
  const regions = [];
  let prevBase = -1;
  let prevOther = -1;
  for (let k = 0; k <= matches.length; k++) {
    const pair = matches[k];
    const base = pair ? pair[0] : baseLength;
    const other = pair ? pair[1] : otherLength;
    if (base > prevBase + 1 || other > prevOther + 1) {
      regions.push({ start: prevBase + 1, end: base });
    }
    prevBase = base;
    prevOther = other;
  }
  return regions;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function linesEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Bounded deterministic excerpt: lines joined with newlines, truncated past
 * `EXCERPT_MAX_LENGTH` characters with a `...` suffix.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function excerpt(lines) {
  const text = lines.join("\n");
  if (text.length <= EXCERPT_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, EXCERPT_MAX_LENGTH - 3)}...`;
}

/**
 * Three-way line merge. Manual edits win ties; conflicts are reported, never
 * silently resolved — see the doctrine in the module header.
 *
 * @param {string} baseText What harmonise last published.
 * @param {string} manualText The current target on disk, manual edits included.
 * @param {string} freshText The fresh translation of the current source.
 * @returns {MergeResult}
 */
export function mergeThreeWay(baseText, manualText, freshText) {
  const base = toLines(baseText);
  const manual = toLines(manualText);
  const fresh = toLines(freshText);
  // The LCS tables are (`n+1`)×(`m+1`) Int32 entries; short-line documents
  // let that product blow up quadratically (a single-char-per-line document
  // around 32 KB is ~16 K lines and a ~1 GB table). Refuse before allocating
  // — a merge this large is refused as content, never approximated.
  if (
    (base.length + 1) * (manual.length + 1) > MERGE_TABLE_LIMIT ||
    (base.length + 1) * (fresh.length + 1) > MERGE_TABLE_LIMIT
  ) {
    throw new RefusalError(
      `merge is too large to reconcile safely ` +
        `(${String(base.length)}/base, ${String(manual.length)}/manual, ` +
        `${String(fresh.length)}/fresh lines exceed the table budget)`,
    );
  }
  const manualMatches = lcsMatches(base, manual);
  const freshMatches = lcsMatches(base, fresh);
  const manualRegions = changeRegions(manualMatches, base.length, manual.length);
  const freshRegions = changeRegions(freshMatches, base.length, fresh.length);

  /** @type {string[]} */
  const merged = [];
  /** @type {MergeConflict[]} */
  const conflicts = [];
  /** @type {MergeChange[]} */
  const changes = [];

  // Base cursor: base lines below `bi` have already landed in `merged`.
  let bi = 0;

  /**
   * Emit one side's region and record the decision. The unchanged base lines
   * ahead of the region land first — identical on all three sides by the LCS
   * construction — then the region's rendition. The change is recorded before
   * the region's lines land, so a region with no rendition (a deletion) points
   * at the line after the join point.
   *
   * @param {Array<[number, number]>} matches
   * @param {string[]} other
   * @param {{start: number, end: number}} region
   * @param {"manual" | "fresh"} type
   */
  const emitSide = (matches, other, region, type) => {
    for (const line of base.slice(bi, region.start)) {
      merged.push(line);
    }
    changes.push({ type, startLine: merged.length + 1 });
    for (const line of rendition(matches, other, region.start, region.end)) {
      merged.push(line);
    }
    bi = region.end;
  };

  /**
   * True when two regions overlap in base coordinates: their ranges strictly
   * intersect, or both are zero-width insertions at the same point. Adjacent
   * (touching, disjoint) regions do not overlap — each side's content lands
   * in order with nothing interleaved, so there is nothing to decide.
   *
   * @param {{start: number, end: number}} a
   * @param {{start: number, end: number}} b
   * @returns {boolean}
   */
  const overlaps = (a, b) =>
    (a.start < b.end && b.start < a.end) ||
    (a.start === a.end && b.start === b.end && a.start === b.start);

  let mi = 0;
  let fi = 0;
  for (;;) {
    const a = manualRegions[mi];
    const b = freshRegions[fi];
    if (a === undefined) {
      // Manual side exhausted; the fresh region is why the loop is running.
      if (b === undefined) {
        break;
      }
      emitSide(freshMatches, fresh, b, "fresh");
      fi += 1;
      continue;
    }
    if (b === undefined) {
      emitSide(manualMatches, manual, a, "manual");
      mi += 1;
      continue;
    }
    if (!overlaps(a, b)) {
      // Non-overlapping: the region that ends first goes out first. At a
      // shared start, the zero-width insertion goes before a replacement.
      if (a.end <= b.start) {
        emitSide(manualMatches, manual, a, "manual");
        mi += 1;
      } else {
        emitSide(freshMatches, fresh, b, "fresh");
        fi += 1;
      }
      continue;
    }
    // Union region, grown while further regions overlap it.
    const start = Math.min(a.start, b.start);
    let end = Math.max(a.end, b.end);
    let nextManual = mi + 1;
    let nextFresh = fi + 1;
    for (;;) {
      let grew = false;
      const nextM = manualRegions[nextManual];
      const nextF = freshRegions[nextFresh];
      if (nextM && nextM.start < end) {
        end = Math.max(end, nextM.end);
        nextManual += 1;
        grew = true;
      }
      if (nextF && nextF.start < end) {
        end = Math.max(end, nextF.end);
        nextFresh += 1;
        grew = true;
      }
      if (!grew) {
        break;
      }
    }
    // Unchanged base lines ahead of the union: identical on all three sides.
    for (const line of base.slice(bi, start)) {
      merged.push(line);
    }
    bi = end;
    const manualLines = unionRendition(manualMatches, manual, start, end);
    const freshLines = unionRendition(freshMatches, fresh, start, end);
    if (linesEqual(manualLines, freshLines)) {
      // Both sides made the same change: emit it once, decide nothing.
      changes.push({ type: "both", startLine: merged.length + 1 });
      for (const line of manualLines) {
        merged.push(line);
      }
    } else {
      const startLine = merged.length + 1;
      changes.push({ type: "conflict", startLine });
      conflicts.push({
        startLine,
        baseExcerpt: excerpt(base.slice(start, end)),
        manualExcerpt: excerpt(manualLines),
        freshExcerpt: excerpt(freshLines),
      });
      // Conservative outcome: the manual text stays, the fresh text is
      // reported in `freshExcerpt` and otherwise dropped.
      for (const line of manualLines) {
        merged.push(line);
      }
    }
    mi = nextManual;
    fi = nextFresh;
  }
  // Trailing unchanged run; the whole text when no side changed anything.
  for (const line of base.slice(bi)) {
    merged.push(line);
  }
  return { merged: merged.join("\n"), conflicts, changes };
}

/**
 * Reporting counts for a merge result: how many regions preserved a manual
 * edit, how many adopted the fresh translation, how many conflicts need a
 * human. Agreement regions (both sides made the same change) count nowhere.
 *
 * @param {MergeResult} result
 * @returns {MergeSummary}
 */
export function summarizeMerge(result) {
  let preservedManual = 0;
  let adoptedFresh = 0;
  for (const change of result.changes) {
    if (change.type === "manual") {
      preservedManual += 1;
    } else if (change.type === "fresh") {
      adoptedFresh += 1;
    }
  }
  return { preservedManual, adoptedFresh, conflicts: result.conflicts.length };
}

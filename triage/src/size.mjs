/**
 * Size — measured from the diff, never asked of the model.
 *
 * The measurement is review effort, not raw magnitude: additions plus
 * deletions over the files `exclude` has not dropped, because a file nobody
 * would review does not count toward how much there is to read. Renamed,
 * binary and submodule entries contribute nothing by GitHub's own accounting
 * of them — they arrive with zero counts.
 *
 * The ladder is validated whole at startup, here as everywhere: a rung
 * without an `upTo` is the catch-all and must be the final rung, so no diff
 * can fall off the end; `upTo` values ascend and are inclusive — 50 counted
 * lines matches `{ upTo: 50 }`; and a size label declared on two rungs is
 * refused, not reconciled, like any other label declared twice.
 */

import { matchGlob } from "#core/glob.mjs";

/** @typedef {import("#core/forge.mjs").PullRequestFile} PullRequestFile */

/**
 * @typedef {object} SizeRung
 * @property {number | undefined} [upTo] inclusive ceiling; absent only on the final catch-all
 * @property {string} label
 */

/**
 * @typedef {object} SizeConfig
 * @property {string[]} exclude
 * @property {SizeRung[]} ladder
 */

/**
 * @param {unknown} raw the `size` value from the config file
 * @param {Set<string>} useSet every label the policy may apply — each size label must be a usable label
 * @returns {SizeConfig}
 */
export function validateSizeConfig(raw, useSet) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("size must be an object");
  }
  const size = /** @type {Record<string, unknown>} */ (raw);

  /** @type {string[]} */
  const exclude = [];
  if (size["exclude"] !== undefined) {
    if (!Array.isArray(size["exclude"]))
      throw new Error("size.exclude must be an array of patterns");
    for (const pattern of size["exclude"]) {
      if (typeof pattern !== "string" || pattern === "") {
        throw new Error("size.exclude must contain non-empty string patterns");
      }
      exclude.push(pattern);
    }
  }

  if (!Array.isArray(size["ladder"]) || size["ladder"].length === 0) {
    throw new Error("size.ladder must be a non-empty array of rungs");
  }

  /** @type {SizeRung[]} */
  const ladder = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const [index, entry] of size["ladder"].entries()) {
    const rung = /** @type {Record<string, unknown>} */ (
      typeof entry === "object" && entry !== null ? entry : {}
    );
    const label = rung["label"];
    if (typeof label !== "string" || label === "") {
      throw new Error(`size.ladder rung ${String(index)} has no label`);
    }
    if (seen.has(label)) {
      throw new Error(`the label '${label}' is declared on two rungs — refused, not reconciled`);
    }
    seen.add(label);
    if (!useSet.has(label)) {
      throw new Error(
        `the size label '${label}' is not in labels.use — a size label is applied like any other, ` +
          `so it must be declared in the policy's usable set`,
      );
    }
    const upTo = rung["upTo"];
    if (upTo !== undefined) {
      if (typeof upTo !== "number" || !Number.isInteger(upTo) || upTo < 1) {
        throw new Error(`size.ladder rung '${label}' has an upTo that is not a positive integer`);
      }
      const previous = ladder[ladder.length - 1]?.upTo;
      if (previous !== undefined && upTo <= previous) {
        throw new Error(`size.ladder upTo values must ascend: '${label}' has ${String(upTo)}`);
      }
    } else if (index !== size["ladder"].length - 1) {
      throw new Error(
        `size.ladder rung '${label}' has no upTo — only the final rung may be the catch-all`,
      );
    }
    ladder.push(upTo === undefined ? { label } : { upTo, label });
  }

  const last = ladder[ladder.length - 1];
  if (last === undefined || last.upTo !== undefined) {
    throw new Error("size.ladder must end with a catch-all rung — a rung with no upTo");
  }

  return { exclude, ladder };
}

/**
 * Measures the diff and lands it on a rung.
 *
 * @param {PullRequestFile[]} files the pull request's files, per-file counts as GitHub accounts them
 * @param {string[]} exclude patterns dropping files from the measurement itself
 * @param {SizeRung[]} ladder
 * @returns {{ label: string, counted: number, files: number, excluded: number }}
 */
export function measureSize(files, exclude, ladder) {
  let counted = 0;
  let excluded = 0;
  for (const file of files) {
    if (exclude.length > 0 && matchGlob(exclude, file.filename)) {
      excluded++;
      continue;
    }
    counted += file.additions + file.deletions;
  }

  for (const rung of ladder) {
    // A diff whose every file is excluded counts zero lines and lands on the
    // first rung: a lockfile-only pull request is small to read, so it is small.
    if (rung.upTo === undefined || counted <= rung.upTo) {
      return { label: rung.label, counted, files: files.length, excluded };
    }
  }
  // Unreachable while validation holds: the catch-all rung has no upTo.
  throw new Error(
    `no size rung holds ${String(counted)} counted lines — the ladder has no catch-all`,
  );
}

/**
 * The labels one thread currently carries that are size rungs — the ones a
 * new measurement replaces.
 *
 * @param {string[]} current the thread's labels now
 * @param {SizeRung[]} ladder
 * @returns {string[]}
 */
export function currentSizeLabels(current, ladder) {
  const rungs = new Set(ladder.map((rung) => rung.label));
  return current.filter((name) => rungs.has(name));
}

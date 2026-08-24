#!/usr/bin/env node
/**
 * Resolves every `(path#fragment)` link in README.md and `docs/**` against the
 * headings of the file it points at.
 *
 * The slug used is `github-slugger`'s `slug()` — the published package GitHub
 * itself renders with, pinned here — never a hand-rolled transform. An earlier
 * fix in a predecessor repository hand-asserted that an em-dash heading anchors
 * as a SINGLE hyphen; GitHub actually strips the U+2014 but keeps the two
 * surrounding spaces, each of which becomes a hyphen → DOUBLE hyphen. This
 * checker exists because that belief was wrong and every link the fix
 * "corrected" went dead.
 *
 * WHAT THIS OWNS, AND WHAT IT DOES NOT. `scripts/check-docs-links.mjs` already
 * reports a link whose target FILE does not exist, so this gate stays silent on
 * that case and answers one question only: does the fragment name a heading
 * that is really there. Two gates reporting the same failure teach a reader to
 * fix it twice.
 *
 * A DUPLICATE HEADING IS THE CASE THIS GETS RIGHT. GitHub disambiguates repeat
 * headings by suffix — three `## Setup` headings anchor as `setup`, `setup-1`
 * and `setup-2` — and `github-slugger` reproduces that only when one instance
 * slugs a whole file in order. Resetting it per heading (which this file used to
 * do, against its own comment saying otherwise) collapses all three to `setup`
 * and reports the perfectly valid `#setup-1` as broken.
 *
 * A run states how many fragments it inspected. Zero is legitimate here — a
 * repository may simply have no cross-file anchors — but a success line that
 * does not say what it covered is how a gate goes quietly blind.
 *
 * The facts are read from the filesystem by `readFacts`; the judgment is the
 * pure function `evaluate`, so the tests need no filesystem.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import GithubSlugger from "github-slugger";

export const LINK = /\]\((\S*?)#([^)\s]+)\)/g;
export const HEADING = /^#+\s+([^#].*)$/gm;

/**
 * Every anchor a markdown document exposes, in document order — which is what
 * makes the `-1`, `-2` suffixes on repeated headings come out right.
 *
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function headingSlugs(markdown) {
  const slugger = new GithubSlugger();
  /** @type {Set<string>} */
  const slugs = new Set();
  for (const match of markdown.matchAll(HEADING)) {
    slugs.add(slugger.slug((match[1] ?? "").trim()));
  }
  return slugs;
}

/**
 * @typedef {object} DocFile
 * @property {string} path
 * @property {string} text
 */

/**
 * @param {object} input
 * @param {DocFile[]} input.files the documents whose links are judged
 * @param {(path: string) => string | undefined} input.textOf contents of a target, or undefined when it does not exist
 * @returns {{ failures: string[], checked: number }}
 */
export function evaluate({ files, textOf }) {
  /** @type {string[]} */
  const failures = [];
  /** @type {Map<string, Set<string>>} */
  const cache = new Map();
  let checked = 0;

  for (const file of files) {
    for (const [index, line] of file.text.split(/\n/).entries()) {
      for (const match of line.matchAll(LINK)) {
        const rawPath = match[1] ?? "";
        const fragment = match[2] ?? "";
        if (rawPath.startsWith("http") || rawPath.startsWith("mailto:")) continue;

        const target = rawPath === "" ? file.path : normalize(join(dirname(file.path), rawPath));

        let headings = cache.get(target);
        if (headings === undefined) {
          const text = rawPath === "" ? file.text : textOf(target);
          // check-docs-links.mjs owns the missing-target failure; see the header.
          if (text === undefined) continue;
          headings = headingSlugs(text);
          cache.set(target, headings);
        }

        checked += 1;
        const wanted = fragment.replace(/^user-content-/, "");
        if (!headings.has(wanted)) {
          failures.push(
            `${file.path}:${String(index + 1)}: ${rawPath === "" ? file.path : rawPath}#${fragment} — ` +
              `no heading anchors to "${wanted}" in ${target}.`,
          );
        }
      }
    }
  }

  return { failures, checked };
}

/**
 * README.md plus every markdown page under `docs/`, which may not exist.
 *
 * @returns {DocFile[]}
 */
function readDocFiles() {
  /** @type {string[]} */
  const paths = [];
  if (existsSync("README.md")) paths.push("README.md");
  if (existsSync("docs")) {
    for (const entry of readdirSync("docs", { recursive: true })) {
      const rel = String(entry);
      if (rel.endsWith(".md")) paths.push(join("docs", rel));
    }
  }
  return paths.map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

/**
 * @param {string} path
 * @returns {string | undefined}
 */
function readTarget(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function main() {
  const { failures, checked } = evaluate({ files: readDocFiles(), textOf: readTarget });

  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    console.error(`\n${String(failures.length)} broken documentation link(s).`);
    process.exit(1);
  }

  console.log(`✔ ${String(checked)} documentation anchor(s) resolve against real headings`);
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 *
 * @param {string} moduleUrl
 * @param {string | undefined} [argv1]
 * @returns {boolean}
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (/** @type {string} */ path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

if (isProgramEntry(import.meta.url)) main();

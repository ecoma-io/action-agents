#!/usr/bin/env node
// Fails when the repository's README language set drifts out of agreement with
// itself. The multilingual README convention (#506) gives every README a
// protected header — badges region, then a language-selector region whose one
// line links every configured language twin — and `harmonise` protects those
// regions mechanically during a run. What no run protects is the space
// BETWEEN runs: a language added to `harmonise.json5` without its document,
// a translation saved with its selector row edited, a twin nobody configured.
// Those are exactly the failures the action's own gates cannot see, because
// the action only ever reads one document at a time.
//
// So this gate reads the whole set at once, and judges four facts against
// each other:
//
//   1. the `languages` map in the harmonise configuration — the one source of
//      truth for which languages exist; nothing here is hardcoded;
//   2. the documents on disk (`README.md` and its `README.<tag>.md` twins);
//   3. the selector line inside each document's protected region — every
//      configured language, in the configuration's own order, and nothing else;
//   4. the protected regions themselves — byte-identical across every
//      document, because a "translation" that re-rendered the badges or
//      translated the selector is a corruption the next harmonise run would
//      preserve, not repair.
//
// The directive grammar mirrored below is `harmonise/src/protect.mjs`'s, on
// purpose: a line this gate accepts but a run would refuse (or the reverse)
// is a gate lying about the mechanism it watches. The fence handling follows
// the same rule the other document gates state for themselves
// (scripts/check-docs-links.mjs): a self-contained approximation is honest
// here, and importing an action's domain modules into a repository gate is
// not. The JSON5 configuration, by contrast, is parsed with the very parser
// the action loads it with — core/src/json5-parse.mjs — so a configuration
// this gate reads is byte-for-byte the configuration a run reads.
//
// The facts are read from the filesystem by `readFacts`; the judgment is the
// pure function `evaluate`, which takes those facts as arguments and returns
// verdicts, so the tests need no filesystem and no mocking library.

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { json5Parse } from "../core/src/json5-parse.mjs";

/** Where this repository's harmonise configuration lives. */
const DEFAULT_CONFIG_PATH = ".github/action-agents/harmonise/harmonise.json5";

/** The document the convention governs — the pattern's `{document}` value. */
const DOCUMENT_NAME = "README";

/** The canonical twin's exact path; the convention has the source at root. */
const SOURCE_DOCUMENT_PATH = "README.md";

/** Any whole-line comment addressing this action, valid or not. */
const HARMONISE_COMMENT_LINE = /^<!--\s*harmonise:.*-->$/;
/** The three directives a run accepts — mirrored from protect.mjs. */
const DIRECTIVE_LINE = /^<!--\s*harmonise:(skip|skip-start|skip-end)\s*-->$/;

/** A fence opener — the same shapes protect.mjs's fence mask honors. */
const FENCE_LINE = /^\s*(```|~~~)/;
/** Selector links: an HTML `href` or a markdown link destination, in order. */
const SELECTOR_LINK = /(?:\bhref="([^"]+)"|\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\))/g;
/** Targets outside this tree — not judged, the way check-docs-links treats them. */
const EXTERNAL_TARGET = /^(https?:|mailto:|#)/;

/**
 * One protected region as this gate sees it: the exact lines from an opening
 * directive through its closing directive, markers included.
 *
 * @typedef {object} Region
 * @property {number} start first line of the region, 0-based
 * @property {number} end last line of the region, inclusive
 * @property {string} content the region's exact bytes, newline-joined
 */

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reads one document's protected structure. Mirrors protect.mjs's semantics:
 * a region runs from `skip-start` through its `skip-end`, markers included;
 * a lone `skip` protects the next non-blank line; comment-like text inside a
 * fence is content, never a directive; malformed or unclosed directives are
 * errors, never silently ignored.
 *
 * @param {string} text the document's exact bytes
 * @param {string} sourcePath the selector is the region linking this path
 * @returns {{ regions: Region[], selectorIndex: number, errors: string[] }}
 */
export function inspectDocument(text, sourcePath) {
  const lines = text.split("\n");
  /** @type {Region[]} */
  const regions = [];
  /** @type {string[]} */
  const errors = [];
  let inFence = false;
  let openStart = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_LINE.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (!HARMONISE_COMMENT_LINE.test(line)) continue;
    if (!DIRECTIVE_LINE.test(line)) {
      errors.push(`line ${i + 1}: a harmonise comment that is not a directive this action accepts`);
      continue;
    }
    if (line.includes("skip-start")) {
      if (openStart >= 0) {
        errors.push(
          `line ${i + 1}: a region opened at line ${openStart + 1} is still open — regions do not nest`,
        );
      } else {
        openStart = i;
      }
      continue;
    }
    if (line.includes("skip-end")) {
      if (openStart < 0) {
        errors.push(`line ${i + 1}: skip-end with no open region`);
      } else {
        regions.push({
          start: openStart,
          end: i,
          content: lines.slice(openStart, i + 1).join("\n"),
        });
        openStart = -1;
      }
      continue;
    }
    // A lone `skip`: it protects the next non-blank line, so the region is
    // the directive line plus that line — the bytes a run would carry whole.
    // Resolved immediately: a second skip's own region must not erase this
    // one, and two overlapping protections coalesce into their union anyway.
    let next = i + 1;
    while (next < lines.length && lines[next].trim() === "") next += 1;
    if (next >= lines.length) {
      errors.push(
        `line ${i + 1}: skip protects the next non-blank line, and the document ends first`,
      );
    } else {
      regions.push({
        start: i,
        end: next,
        content: lines.slice(i, next + 1).join("\n"),
      });
    }
  }
  if (openStart >= 0) {
    errors.push(`line ${openStart + 1}: a region opened here is never closed`);
  }

  const sourceLink = new RegExp(
    `(?:href="${escapeRegExp(sourcePath)}"|\\]\\(${escapeRegExp(sourcePath)}\\))`,
  );
  const selectorIndex = regions.findIndex((region) => sourceLink.test(region.content));
  return { regions, selectorIndex, errors };
}

/**
 * The language links a selector region carries, in document order: an HTML
 * `href` or a markdown destination per match; external targets dropped.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function selectorLinks(content) {
  /** @type {string[]} */
  const links = [];
  for (const match of content.matchAll(SELECTOR_LINK)) {
    const target = match[1] ?? match[2] ?? "";
    if (!EXTERNAL_TARGET.test(target)) links.push(target);
  }
  return links;
}

/**
 * @typedef {object} Facts
 * @property {string} configPath where the facts were read from, for messages
 * @property {Record<string, string>} languages tag → `{document}` pattern
 * @property {string} sourceLanguage the canonical language's tag
 * @property {{ path: string, text: string }[]} documents the README set
 */

/**
 * The pure judgment. Takes the facts as arguments, returns one line per
 * disagreement, named by the document or language that owns it.
 *
 * @param {Facts} facts
 * @returns {{ failures: string[], checked: number }}
 */
export function evaluate({ configPath, languages, sourceLanguage, documents }) {
  /** @type {string[]} */
  const failures = [];

  // Facts 1 and 2: the configuration against the documents on disk.
  const tags = Object.keys(languages ?? {});
  if (!tags.includes(sourceLanguage)) {
    failures.push(`${configPath}: sourceLanguage '${sourceLanguage}' is not a configured language`);
    return { failures, checked: documents.length };
  }
  /** @type {Map<string, string>} */
  const pathByTag = new Map();
  /** @type {Map<string, string>} */
  const tagByPath = new Map();
  for (const tag of tags) {
    const pattern = languages[tag];
    if (typeof pattern !== "string" || !pattern.includes("{document}")) {
      failures.push(`${configPath}: language '${tag}' pattern does not name {document}`);
      continue;
    }
    const path = pattern.replace("{document}", DOCUMENT_NAME);
    const claimant = tagByPath.get(path);
    if (claimant !== undefined) {
      failures.push(`${configPath}: languages '${claimant}' and '${tag}' both resolve to ${path}`);
      continue;
    }
    pathByTag.set(tag, path);
    tagByPath.set(path, tag);
  }
  if (pathByTag.get(sourceLanguage) !== SOURCE_DOCUMENT_PATH) {
    failures.push(
      `${configPath}: the source language must resolve to ${SOURCE_DOCUMENT_PATH}, not '${pathByTag.get(sourceLanguage)}'`,
    );
  }
  const expectedPaths = tags.map((tag) => pathByTag.get(tag)).filter((path) => path !== undefined);

  const byPath = new Map(documents.map((doc) => [doc.path, doc.text]));
  for (const [tag, path] of pathByTag) {
    if (!byPath.has(path)) {
      failures.push(`${path}: language '${tag}' is configured, but the document does not exist`);
    }
  }
  for (const doc of documents) {
    if (!tagByPath.has(doc.path)) {
      failures.push(`${doc.path}: a README twin no configured language claims`);
    }
  }

  // Facts 3 and 4: each document's protected structure, then the set.
  const inspected = documents.map((doc) => ({
    doc,
    ...inspectDocument(doc.text, SOURCE_DOCUMENT_PATH),
  }));
  for (const { doc, errors } of inspected) {
    for (const error of errors) failures.push(`${doc.path}: ${error}`);
  }
  if (inspected.some(({ errors }) => errors.length > 0)) {
    return { failures, checked: documents.length };
  }
  if (inspected.length === 0) return { failures, checked: 0 };

  const selectorIndexes = new Set(inspected.map(({ selectorIndex }) => selectorIndex));
  if (selectorIndexes.size !== 1) {
    failures.push(
      `${configPath}: exactly one selector region is expected in every document; documents report ${[...selectorIndexes].map(String).join(", ") || "none"}`,
    );
  } else if ([...selectorIndexes][0] < 0) {
    failures.push(
      `${configPath}: no document's protected regions link ${SOURCE_DOCUMENT_PATH} — no selector exists`,
    );
  }

  const regionCounts = new Set(inspected.map(({ regions }) => regions.length));
  if (regionCounts.size !== 1) {
    failures.push(
      `${configPath}: documents disagree on the protected region count: ${inspected
        .map(({ doc, regions }) => `${doc.path} has ${String(regions.length)}`)
        .join(", ")}`,
    );
  } else {
    const first = inspected[0];
    for (const other of inspected.slice(1)) {
      for (let i = 0; i < first.regions.length; i += 1) {
        if (first.regions[i].content !== other.regions[i].content) {
          failures.push(
            `${other.doc.path}: protected region ${String(i + 1)} differs from ${first.doc.path}'s — regions are byte-identical across translations, or they are not protected`,
          );
        }
      }
    }
  }

  // The selector's links, per document: every configured language in the
  // configuration's own order, and nothing else.
  for (const { doc, regions, selectorIndex } of inspected) {
    const selector = regions[selectorIndex];
    if (selector === undefined) continue;
    const links = selectorLinks(selector.content);
    const seen = new Set();
    for (const link of links) {
      if (seen.has(link)) failures.push(`${doc.path}: the selector links ${link} twice`);
      seen.add(link);
      if (!tagByPath.has(link)) {
        failures.push(
          `${doc.path}: the selector links '${link}', which no configured language resolves to`,
        );
      }
    }
    for (const path of expectedPaths) {
      if (!seen.has(path)) failures.push(`${doc.path}: the selector never links '${path}'`);
    }
    for (let i = 0; i < links.length && i < expectedPaths.length; i += 1) {
      if (links[i] !== expectedPaths[i]) {
        failures.push(
          `${doc.path}: the selector's language order disagrees with ${configPath} — expected '${expectedPaths[i]}', found '${links[i]}'`,
        );
        break;
      }
    }
  }

  return { failures, checked: documents.length };
}

/**
 * Reads the facts this gate judges: the harmonise configuration and every
 * README document at the repository root.
 *
 * @param {string} configPath
 * @returns {Facts}
 */
export function readFacts(configPath) {
  const raw = /** @type {any} */ (json5Parse(readFileSync(configPath, "utf8")));
  const languages = raw?.languages;
  const sourceLanguage = raw?.sourceLanguage;
  if (typeof languages !== "object" || languages === null || Array.isArray(languages)) {
    throw new Error(`${configPath}: no languages map to judge the READMEs against`);
  }
  if (typeof sourceLanguage !== "string") {
    throw new Error(`${configPath}: no sourceLanguage to judge the READMEs against`);
  }
  const documents = readdirSync(".")
    .filter((name) => /^README(\.[A-Za-z0-9]+)*\.md$/.test(name))
    .sort()
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));
  return { configPath, languages, sourceLanguage, documents };
}

function main() {
  const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH;
  let facts;
  try {
    facts = readFacts(configPath);
  } catch (cause) {
    console.error(`✗ ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  }
  const { failures, checked } = evaluate(facts);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    console.error(
      `\n${String(failures.length)} README language failure(s) across ${String(checked)} document(s).`,
    );
    process.exit(1);
  }
  console.log(`✔ ${String(checked)} README document(s) agree with ${facts.configPath}`);
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

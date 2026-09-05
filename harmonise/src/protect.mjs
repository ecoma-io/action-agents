/**
 * Protected spans — everything in a source document that must survive
 * translation untouched, replaced mechanically before the model sees the text
 * and restored byte-for-byte afterwards.
 *
 * Two things get protected, and they share one mechanism:
 *
 *   - **Glossary terms** — configured strings that stay in the source language
 *     everywhere outside code. One term maps to one placeholder, repeated at
 *     each of its occurrences;
 *   - **Skip directives** — author-marked lines and regions carried through
 *     verbatim. One protected region maps to one placeholder.
 *
 * The placeholder carries a random-per-run id (`core/untrusted.mjs`'s trick):
 * content cannot forge a token it could not have predicted, validation counts
 * every token the document holds, and restoration is byte-for-byte because the
 * originals sit in a map keyed by token, not in the model's memory.
 *
 * Everything here is deterministic given the injected id generator. What is
 * refused rather than guessed: malformed or nested skip directives, an
 * unclosed region, and a source that collides with several generated ids in a
 * row. Two protections that would overlap coalesce into their union — the
 * bytes are what matter, and the union protects exactly the same bytes.
 */

import { randomBytes } from "node:crypto";

import { fenceMask, maskCodeSpans, maskDestinations, splitLines } from "./markdown.mjs";

import { DeterministicRefusalError } from "./refusal.mjs";

/** The shape of every placeholder this module mints. Case-insensitive on purpose: a token the model re-cased must be named as an unknown, never pass for prose. */
const TOKEN_PATTERN = /\[\[harmonise:([0-9a-f]{16}):([gs])([1-9][0-9]*)\]\]/gi;

/** How many id regenerations a colliding source gets before refusal. */
const MAX_ID_ATTEMPTS = 5;

/**
 * A whole-line directive. Whitespace is tolerated inside the comment; nothing
 * else about the line may vary.
 */
const DIRECTIVE_LINE = /^<!--\s*harmonise:(skip|skip-start|skip-end)\s*-->$/;
/** Any whole-line comment addressing this action, valid or not. */
const HARMONISE_COMMENT_LINE = /^<!--\s*harmonise:.*-->$/;

/**
 * @typedef {object} Protection
 * @property {string} text the document with placeholders in place
 * @property {Map<string, string>} spans token → the exact original bytes
 * @property {Map<string, number>} counts token → how many times it must appear
 * @property {number} glossaryHits total term occurrences replaced
 * @property {number} skippedSpans protected regions replaced
 */

/**
 * Protects a source document. Throws on malformed directives — a source the
 * mechanism cannot protect is refused, never translated half-protected.
 *
 * @param {string} source
 * @param {object} input
 * @param {string[]} input.glossary configured terms, exact-match
 * @param {() => string} [input.newId] the run-id generator, injectable for tests
 * @returns {Protection}
 */
export function protectDocument(source, { glossary = [], newId = defaultId }) {
  const id = chooseId(source, newId);

  /** @type {[string, string][]} */
  const spans = [];
  /** @type {[string, number][]} */
  const counts = [];

  // Skip directives first, per the pipeline's order: a region's contents are
  // out of play before any term is matched against what remains.
  const ranges = mergeRanges(collectSkipRanges(splitLines(source)));
  let text = source;
  if (ranges.length > 0) {
    const lines = splitLines(source);
    // Numbered in document order, replaced bottom-up so earlier offsets hold.
    const tokens = ranges.map((_, index) => `[[harmonise:${id}:s${String(index + 1)}]]`);
    for (let index = ranges.length - 1; index >= 0; index--) {
      const range = ranges[index];
      const token = tokens[index];
      if (range === undefined || token === undefined) continue;
      text = replaceRange(text, range, token);
      spans.push([token, spliceLines(lines, range)]);
      counts.push([token, 1]);
    }
  }

  let glossaryHits = 0;
  if (glossary.length > 0) {
    const outcome = protectGlossary(text, glossary, id);
    text = outcome.text;
    glossaryHits = outcome.edits;
    for (const [token, term] of outcome.spans) {
      spans.push([token, term]);
      counts.push([token, outcome.counts.get(token) ?? 0]);
    }
  }

  return {
    text,
    spans: new Map(spans),
    counts: new Map(counts),
    glossaryHits,
    skippedSpans: ranges.length,
  };
}

/**
 * Restores a translated document: validates every placeholder this run minted
 * appears exactly as often as it must and, keyed on first occurrences, in the
 * protected document's order, that nothing unknown wears the namespace, then
 * substitutes the original bytes.
 *
 * @param {string} candidate the translated text
 * @param {Protection} protection what `protectDocument` returned
 * @returns {string} the candidate with placeholders restored byte-for-byte
 */
export function restoreDocument(candidate, protection) {
  const found = new Map();
  for (const match of candidate.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (!protection.spans.has(token)) {
      throw new Error(`the output contains '${token}', which this run never minted`);
    }
    found.set(token, (found.get(token) ?? 0) + 1);
  }
  for (const [token, expected] of protection.counts) {
    const actual = found.get(token) ?? 0;
    if (actual !== expected) {
      throw new Error(
        `placeholder ${token} appears ${String(actual)} times, expected ${String(expected)}` +
          (actual === 0 ? " — the translation lost protected content" : ""),
      );
    }
  }
  // Order: every token is pinned by its first occurrence, whatever its count
  // — a repeated token's first occurrence is a position like any other, and
  // exempting it would let a singleton swap with it unnoticed (#358). The
  // key is each token's first occurrence in the protected document itself,
  // not Map iteration order: the skip spans above are pushed bottom-up, so
  // Map order is not document order. In that document order, the
  // candidate's first occurrence of each token must never move backwards; a
  // decrease means the candidate does not preserve the protected content's
  // order, and restoring it would publish protected bytes in each other's
  // places. A legitimate translation that reorders clauses is refused here
  // too — never re-asked — because wrong bytes are worse than a refused run.
  /** @type {[number, string][]} */
  const tokenOrder = [];
  for (const [token] of protection.counts) {
    tokenOrder.push([protection.text.indexOf(token), token]);
  }
  tokenOrder.sort((a, b) => a[0] - b[0]);
  let previousAt = -1;
  let previousToken = "";
  for (const [, token] of tokenOrder) {
    const at = candidate.indexOf(token);
    if (at < previousAt) {
      throw new DeterministicRefusalError(
        `placeholder ${token} appears before ${previousToken} — the candidate does not preserve the protected content's order`,
      );
    }
    previousAt = at;
    previousToken = token;
  }
  let restored = candidate;
  for (const [token, original] of protection.spans) {
    restored = restored.split(token).join(original);
  }
  return restored;
}

/* ------------------------------------------------------------------------ */
/* Skip directives                                                           */
/* ------------------------------------------------------------------------ */

/**
 * The line ranges skip directives protect, validated while collected. Ranges
 * come back raw and possibly intersecting; `mergeRanges` unions them.
 *
 * @param {string[]} lines
 * @returns {[number, number][]} inclusive line indices, unordered
 */
function collectSkipRanges(lines) {
  const fences = fenceMask(lines);
  /** @type {[number, number][]} */
  const ranges = [];

  /** @type {number | undefined} */
  let openRegion;
  /** @type {number[]} */ // single-line directives awaiting their target line
  const pending = [];

  for (const [index, rawLine] of lines.entries()) {
    if (fences[index] === true) {
      // A fenced line may never be a skip target (the specification refuses
      // that): a pending single-line directive whose only candidates are
      // fenced is malformed authoring, refused rather than silently widened
      // to swallow the fence and whatever follows it.
      const unsettled = pending[0];
      if (unsettled !== undefined) {
        throw new DeterministicRefusalError(
          `harmonise:skip on line ${String(unsettled + 1)} would target a fenced code block — ` +
            `wrap the block in harmonise:skip-start / harmonise:skip-end instead`,
        );
      }
      continue;
    }
    const line = rawLine.trim();

    if (!HARMONISE_COMMENT_LINE.test(line)) {
      // A content line settles every pending directive — the next non-blank
      // line after each is this one.
      if (line !== "" && pending.length > 0) {
        for (const directive of pending.splice(0)) {
          ranges.push([directive, index]);
        }
      }
      continue;
    }

    const kind = DIRECTIVE_LINE.exec(line)?.[1];
    if (kind === undefined) {
      throw new DeterministicRefusalError(
        `line ${String(index + 1)}: '${line}' addresses harmonise but is not one of ` +
          `harmonise:skip, harmonise:skip-start, harmonise:skip-end`,
      );
    }

    if (kind === "skip") {
      pending.push(index);
    } else if (kind === "skip-start") {
      if (openRegion !== undefined) {
        throw new DeterministicRefusalError(
          `line ${String(index + 1)}: harmonise:skip-start opens a region while another ` +
            `(line ${String(openRegion + 1)}) is already open — nested regions are not supported`,
        );
      }
      openRegion = index;
    } else if (openRegion !== undefined) {
      ranges.push([openRegion, index]);
      openRegion = undefined;
    } else {
      throw new DeterministicRefusalError(
        `line ${String(index + 1)}: harmonise:skip-end with no open harmonise:skip-start`,
      );
    }
  }

  if (openRegion !== undefined) {
    throw new DeterministicRefusalError(
      `harmonise:skip-start on line ${String(openRegion + 1)} is never closed`,
    );
  }
  const unsettled = pending[0];
  if (unsettled !== undefined) {
    throw new DeterministicRefusalError(
      `harmonise:skip on line ${String(unsettled + 1)} has no following line to preserve`,
    );
  }
  return ranges;
}

/**
 * Unions ranges that share any line, so two claims on one line coalesce into
 * one span protecting all of it instead of colliding.
 *
 * @template {[number, number]} R
 * @param {R[]} ranges
 * @returns {[number, number][]}
 */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  /** @type {[number, number][]} */
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }
  return merged;
}

/** @param {string[]} lines @param {[number, number]} range @returns {string} */
function spliceLines(lines, [from, to]) {
  return lines.slice(from, to + 1).join("\n");
}

/**
 * Replaces an inclusive line range in `text` with one token line. Offsets are
 * recomputed from a line walk rather than assumed, so `\r`-bearing lines do
 * not shift anything.
 *
 * @param {string} text
 * @param {[number, number]} range
 * @param {string} token
 * @returns {string}
 */
function replaceRange(text, [from, to], token) {
  const lines = splitLines(text);
  return [...lines.slice(0, from), token, ...lines.slice(to + 1)].join("\n");
}

/* ------------------------------------------------------------------------ */
/* Glossary                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Glossary protection over text that already carries skip tokens. Terms are
 * matched longest-first so a longer configured term wins a shared prefix,
 * left-to-right, case-sensitive, never inside fenced blocks or inline code
 * spans, never inside link/image destinations, reference-definition
 * destinations or URLs — those are machinery, not prose — and never inside an
 * existing placeholder.
 *
 * A match must also stand alone as a word: a term flanked by a letter, digit
 * or underscore is a different word ("commit" inside "committed"), and
 * matching it would be stemming by another name. Punctuation adjacency is
 * fine — "repository," matches.
 *
 * Masking preserves byte length everywhere (fence interiors, destination
 * interiors, code-span interiors and token bodies become NUL runs of the same
 * size), so every match position in the masked text points at the identical
 * slice of the real text.
 *
 * @param {string} text
 * @param {string[]} glossary
 * @param {string} id
 * @returns {{ text: string, edits: number, spans: [string, string][], counts: Map<string, number> }}
 */
function protectGlossary(text, glossary, id) {
  const lines = splitLines(text);
  const fences = fenceMask(lines);
  const masked = lines
    .map((line, index) =>
      fences[index] === true ? "\u0000".repeat(line.length) : maskDestinations(maskCodeSpans(line)),
    )
    .join("\n")
    .replace(TOKEN_PATTERN, (token) => "\u0000".repeat(token.length));

  const alternatives = [...glossary]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // A word-boundary match without the baggage of `\b`, which misjudges terms
  // that begin or end in punctuation: the lookarounds forbid exactly a
  // flanking letter, digit or underscore, nothing else.
  const finder = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`,
    "gu",
  );

  /** @type {[number, string][]} */
  const positions = [];
  for (const match of masked.matchAll(finder)) {
    if (match[0] !== "") positions.push([match.index, match[0]]);
  }

  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {[string, string][]} */
  const spans = [];
  const ordered = positions.sort((a, b) => a[0] - b[0]);

  let result = "";
  let cursor = 0;
  for (const [at, term] of ordered) {
    const termIndex = glossary.indexOf(term);
    const token = `[[harmonise:${id}:g${String(termIndex + 1)}]]`;
    result += text.slice(cursor, at) + token;
    cursor = at + term.length;
    if (!spans.some(([existing]) => existing === token)) spans.push([token, term]);
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  result += text.slice(cursor);

  return { text: result, edits: ordered.length, spans, counts };
}

/* ------------------------------------------------------------------------ */
/* Ids                                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Picks a run-id absent from the source, regenerating on a collision. A
 * source that collides repeatedly is refused: it is either astronomically
 * unlucky or deliberately probing the namespace, and both deserve red.
 *
 * @param {string} source
 * @param {() => string} newId
 * @returns {string}
 */
function chooseId(source, newId) {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = newId();
    if (!source.includes(`[[harmonise:${id}:`)) return id;
  }
  throw new DeterministicRefusalError(
    `the document contains text colliding with ${String(MAX_ID_ATTEMPTS)} consecutive ` +
      `placeholder ids — refused rather than risk token ambiguity`,
  );
}

/** @returns {string} */
function defaultId() {
  return randomBytes(8).toString("hex");
}

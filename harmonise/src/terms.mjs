/**
 * Terminology — approved renderings per language, deterministic placeholders,
 * and the post-translation accounting that decides whether a translation kept
 * its words. A pure module: nothing here reads configuration, calls a model or
 * touches a file; the caller compiles a term base, masks, translates elsewhere,
 * unmasks and checks.
 *
 * Doctrine: **terminology enforcement is deterministic string accounting.**
 * What counts as consistent is decided entirely by the compiled term base and
 * byte comparisons on strings — model output has no authority over it. A
 * violation is reported, never repaired and never coerced into a pass; the
 * caller refuses the output.
 *
 * The placeholder is the same shape every harmonise module mints,
 * `[[harmonise:<16-hex>:g<n>]]`, but the id is derived, not random: the hex is
 * the first 16 hex digits of `sha256("harmonise:terms\0" + lang + "\0" + term +
 * "\0" + rendering)` and `n` is the entry's 1-based position in the compiled
 * base. The same configuration therefore mints the same tokens on every run —
 * a test can name a token exactly, and two runs are comparable byte for byte.
 *
 * Matching follows the glossary conventions of `protect.mjs`: case-sensitive,
 * a match must stand alone as a word (flanked by punctuation or nothing,
 * never a letter, digit or underscore), the longest rendering wins a shared
 * prefix, and regex-special characters are matched literally. Markdown
 * machinery is not this module's concern — a caller that needs code spans,
 * fences and destinations out of play pre-masks them first, exactly as
 * `protectDocument` does before its own glossary pass.
 *
 * What is refused rather than guessed, at compile time: an entries list that
 * is not an array, a language with no approved rendering, an empty term or
 * rendering, an entry whose shape is anything but
 * `{ term, translations, forbidden? }`, a duplicate term, a forbidden list
 * that is not an array of distinct non-empty strings, and a forbidden variant
 * equal to the rendering it forbids. At masking time: text that already
 * contains a placeholder this base would mint. Restoration reports what does
 * not round-trip — a placeholder this run never minted, or one the output
 * duplicates — as a violation, never as prose.
 *
 * The consistency check is aggregate by construction: restored occurrences are
 * indistinguishable strings, so the check counts non-overlapping occurrences
 * of each distinct original in the output and requires the total to equal the
 * number of times masking minted it. Two entries sharing a rendering are
 * accounted correctly under that rule and no finer rule is possible.
 */

import { createHash } from "node:crypto";

/** The shape of every placeholder this module mints or judges. Case-insensitive on purpose: a token the model re-cased is unknown, never prose. */
const TOKEN_PATTERN = /\[\[harmonise:([0-9a-f]{16}):g([1-9][0-9]*)\]\]/gi;

/** Every placeholder starts with this prefix; a residual fragment of one is as much a leak as a whole one. */
const TOKEN_PREFIX = "[[harmonise:";

/** Escapes a literal string for verbatim use inside a regular expression. */
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * @typedef {object} TermConfig
 * @property {string} term the configuration key that identifies the entry
 * @property {Record<string, string>} translations approved rendering per language
 * @property {string[]} [forbidden] renderings that must never appear in output
 */

/**
 * @typedef {object} TermEntry
 * @property {string} term the configuration key that identifies the entry
 * @property {string} rendering the approved rendering for the compiled language
 * @property {string[]} forbidden renderings that must never appear in output
 * @property {string} token the deterministic placeholder minted for the entry
 * @property {number} g the entry's 1-based position in the compiled base
 */

/**
 * @typedef {object} TermBase
 * @property {string} lang the language every rendering was compiled for
 * @property {TermEntry[]} entries in configuration order
 */

/**
 * @typedef {object} TermMask
 * @property {string} text the source text with placeholders in place
 * @property {Map<string, string>} spans token → the exact original bytes
 * @property {Map<string, number>} counts token → how many times it was minted
 * @property {number} edits total occurrences replaced
 */

/**
 * @typedef {object} UnmaskOutcome
 * @property {string} text the text with minted placeholders restored byte-for-byte
 * @property {string[]} violations every placeholder that did not round-trip
 */

/**
 * @typedef {object} ConsistencyOutcome
 * @property {boolean} ok whether the output satisfied the term base
 * @property {string[]} violations refusal conditions for the caller, never repairs
 */

/**
 * Compiles a per-language term base from configuration-shaped entries. The
 * whole shape is validated before anything is accepted — a term base that
 * would half-protect is refused, never coerced.
 *
 * @param {unknown} entries the configured entries, `{ term, translations, forbidden? }` each
 * @param {unknown} lang the language to compile renderings for
 * @returns {TermBase}
 */
export function compileTermBase(entries, lang) {
  if (!Array.isArray(entries)) {
    throw new Error("term entries must be an array of { term, translations, forbidden? } objects");
  }
  if (typeof lang !== "string" || lang === "") {
    throw new Error("the compiled language must be a non-empty string");
  }

  /** @type {TermEntry[]} */
  const compiled = [];
  const terms = new Set();

  for (const entry of entries) {
    const config = readEntry(entry);
    if (terms.has(config.term)) {
      throw new Error(`term '${config.term}' is configured twice — duplicate terms are refused`);
    }
    const rendering = config.translations[lang];
    if (typeof rendering !== "string" || rendering === "") {
      throw new Error(`term '${config.term}' has no approved rendering for language '${lang}'`);
    }
    /** @type {string[]} */
    const forbidden = [];
    if (config.forbidden !== undefined) {
      if (!Array.isArray(config.forbidden)) {
        throw new Error(
          `term '${config.term}' declares forbidden variants but they are not an array`,
        );
      }
      for (const variant of config.forbidden) {
        if (typeof variant !== "string" || variant === "") {
          throw new Error(
            `term '${config.term}' declares a forbidden variant that is not a non-empty string`,
          );
        }
        if (variant === rendering) {
          throw new Error(
            `term '${config.term}' forbids '${variant}', which is its own approved rendering for '${lang}'`,
          );
        }
        if (forbidden.includes(variant)) {
          throw new Error(
            `term '${config.term}' forbids '${variant}' twice — duplicates are refused`,
          );
        }
        forbidden.push(variant);
      }
    }
    const g = compiled.length + 1;
    const token = `[[harmonise:${tokenId(lang, config.term, rendering)}:g${String(g)}]]`;
    terms.add(config.term);
    compiled.push({ term: config.term, rendering, forbidden, token, g });
  }

  return { lang, entries: compiled };
}

/**
 * Validates one configured entry and returns its parts. Unknown keys are
 * refused: an entry this module does not fully understand could silently
 * protect less than its author believes.
 *
 * @param {unknown} entry
 * @returns {{ term: string, translations: Record<string, string>, forbidden: string[] | undefined }}
 */
function readEntry(entry) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("every term entry must be an object shaped { term, translations, forbidden? }");
  }
  const record = /** @type {{ [key: string]: unknown }} */ (entry);
  for (const key of Object.keys(record)) {
    if (key !== "term" && key !== "translations" && key !== "forbidden") {
      throw new Error(`term entries do not accept the key '${key}' — unknown shapes are refused`);
    }
  }
  if (typeof record["term"] !== "string" || record["term"] === "") {
    throw new Error("every term entry needs a non-empty string term");
  }
  const translations = record["translations"];
  if (typeof translations !== "object" || translations === null || Array.isArray(translations)) {
    throw new Error(
      `term '${String(record["term"])}' needs a translations object mapping language to rendering`,
    );
  }
  const renderings = /** @type {{ [key: string]: unknown }} */ (translations);
  for (const [language, rendering] of Object.entries(renderings)) {
    if (typeof rendering !== "string" || rendering === "") {
      throw new Error(
        `term '${String(record["term"])}' declares an empty or non-string rendering for language '${language}'`,
      );
    }
  }
  return {
    term: record["term"],
    translations: /** @type {Record<string, string>} */ (renderings),
    forbidden:
      record["forbidden"] === undefined ? undefined : /** @type {string[]} */ (record["forbidden"]),
  };
}

/**
 * Derives a placeholder id: the first 16 hex digits of SHA-256 over the
 * language, the term and the rendering, NUL-separated under a fixed prefix.
 * Same configuration, same id — the derivation this module documents in its
 * header, and the only source of determinism the token needs.
 *
 * @param {string} lang
 * @param {string} term
 * @param {string} rendering
 * @returns {string} 16 lowercase hex digits
 */
function tokenId(lang, term, rendering) {
  return createHash("sha256")
    .update(`harmonise:terms\0${lang}\0${term}\0${rendering}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Replaces every word-boundary occurrence of each approved rendering with the
 * entry's deterministic placeholder. Occurrences are replaced left-to-right;
 * renderings are matched longest-first so a longer rendering wins a shared
 * prefix; a match flanked by a letter, digit or underscore is a different word
 * and never matches.
 *
 * @param {unknown} text the source text, already free of any machinery the caller wants out of play
 * @param {TermBase} termBase what `compileTermBase` returned
 * @returns {TermMask}
 */
export function maskTerms(text, termBase) {
  if (typeof text !== "string") {
    throw new Error("the text to mask must be a string");
  }
  assertTermBase(termBase);

  /** @type {Map<string, string>} */
  const spans = new Map();
  /** @type {Map<string, number>} */
  const counts = new Map();
  if (termBase.entries.length === 0) return { text, spans, counts, edits: 0 };

  for (const entry of termBase.entries) {
    if (text.includes(entry.token)) {
      throw new Error(
        `the text already contains '${entry.token}', which masking would mint — refused rather than risk token ambiguity`,
      );
    }
  }

  // Existing placeholders — another layer's tokens — are machinery: nothing is
  // matched inside one. The masking view is byte-length-preserving, so every
  // match position points at the identical slice of the real text.
  const masked = text.replace(TOKEN_PATTERN, (token) => "\u0000".repeat(token.length));

  const alternatives = [...termBase.entries]
    .sort((a, b) => b.rendering.length - a.rendering.length)
    .map((entry) => entry.rendering.replace(REGEX_SPECIALS, "\\$&"));
  // A word-boundary match without the baggage of `\b`, which misjudges
  // renderings that begin or end in punctuation: the lookarounds forbid
  // exactly a flanking letter, digit or underscore, nothing else.
  const finder = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`,
    "gu",
  );

  /** @type {[number, TermEntry][]} */
  const positions = [];
  for (const match of masked.matchAll(finder)) {
    const matched = match[0];
    const at = match.index;
    if (matched === undefined || matched === "" || at === undefined) continue;
    const entry = termBase.entries.find((candidate) => candidate.rendering === matched);
    if (entry === undefined) continue;
    positions.push([at, entry]);
  }

  const ordered = positions.sort((a, b) => a[0] - b[0]);
  let result = "";
  let cursor = 0;
  let edits = 0;
  for (const [at, entry] of ordered) {
    result += text.slice(cursor, at) + entry.token;
    cursor = at + entry.rendering.length;
    spans.set(entry.token, entry.rendering);
    counts.set(entry.token, (counts.get(entry.token) ?? 0) + 1);
    edits += 1;
  }
  result += text.slice(cursor);

  return { text: result, spans, counts, edits };
}

/**
 * Restores what masking minted, byte for byte. A placeholder this mask never
 * minted — or one the output carries more often than it was minted — is a
 * violation: it stays verbatim in the text and is reported, never passed
 * through as if it were fine and never silently deleted.
 *
 * @param {unknown} text the translated text, placeholders and all
 * @param {TermMask} mask what `maskTerms` returned for the source
 * @returns {UnmaskOutcome}
 */
export function unmaskTerms(text, mask) {
  if (typeof text !== "string") {
    throw new Error("the text to unmask must be a string");
  }
  assertMask(mask);

  /** @type {string[]} */
  const violations = [];
  /** @type {Map<string, number>} */
  const found = new Map();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (token === undefined || token === "") continue;
    found.set(token, (found.get(token) ?? 0) + 1);
  }

  let restored = text;
  for (const [token, original] of mask.spans) {
    const actual = found.get(token) ?? 0;
    const expected = mask.counts.get(token) ?? 0;
    if (actual > expected) {
      violations.push(
        `placeholder '${token}' appears ${String(actual)} times but masking minted ${String(expected)} — the output duplicates it`,
      );
    }
    if (actual > 0) restored = restored.split(token).join(original);
  }
  for (const [token] of found) {
    if (!mask.spans.has(token)) {
      violations.push(
        `the output contains '${token}', which this run never minted — left in place, reported`,
      );
    }
  }

  return { text: restored, violations };
}

/**
 * Deterministic post-translation accounting over the final, restored output.
 * Three counts, all string arithmetic, none of them asking the model's
 * opinion: every original masking restored must occur in the output exactly as
 * often as it was minted, no placeholder prefix may remain, and no forbidden
 * variant of any term may occur as a word. Every violation is a refusal
 * condition for the caller — nothing here repairs.
 *
 * @param {unknown} translatedText the restored output
 * @param {TermBase} termBase what `compileTermBase` returned
 * @param {TermMask} mask what `maskTerms` returned for the source
 * @returns {ConsistencyOutcome}
 */
export function checkTermConsistency(translatedText, termBase, mask) {
  if (typeof translatedText !== "string") {
    throw new Error("the translated text to check must be a string");
  }
  assertTermBase(termBase);
  assertMask(mask);

  /** @type {string[]} */
  const violations = [];

  const residual = countSubstrings(translatedText, TOKEN_PREFIX);
  if (residual > 0) {
    violations.push(
      `${String(residual)} residual placeholder ${residual === 1 ? "fragment" : "fragments"} starting '${TOKEN_PREFIX}' ${residual === 1 ? "remains" : "remain"} in the output`,
    );
  }

  /** @type {Map<string, number>} */
  const expected = new Map();
  for (const [token, count] of mask.counts) {
    const original = mask.spans.get(token);
    if (original === undefined) continue;
    expected.set(original, (expected.get(original) ?? 0) + count);
  }
  for (const [original, wanted] of expected) {
    const actual = countSubstrings(translatedText, original);
    if (actual !== wanted) {
      violations.push(
        `'${original}' occurs ${String(actual)} ${actual === 1 ? "time" : "times"} in the output, expected ${String(wanted)}` +
          (actual === 0
            ? " — a masked occurrence was lost"
            : actual > wanted
              ? " — an occurrence was added"
              : ""),
      );
    }
  }

  for (const entry of termBase.entries) {
    for (const variant of entry.forbidden) {
      const count = countWordOccurrences(translatedText, variant);
      if (count > 0) {
        violations.push(
          `'${variant}' is a forbidden rendering of term '${entry.term}' and occurs ${String(count)} ${count === 1 ? "time" : "times"} in the output`,
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Non-overlapping occurrence count — the same arithmetic `split`-and-join
 * restoration performs, so accounting and restoration cannot disagree about
 * what an occurrence is.
 *
 * @param {string} text
 * @param {string} needle non-empty
 * @returns {number}
 */
function countSubstrings(text, needle) {
  return text.split(needle).length - 1;
}

/**
 * Occurrence count under the same word-boundary rule masking uses, so a
 * forbidden variant inside a longer word ("api" inside "rapid") is a
 * different word, not a hit.
 *
 * @param {string} text
 * @param {string} literal non-empty
 * @returns {number}
 */
function countWordOccurrences(text, literal) {
  const finder = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${literal.replace(REGEX_SPECIALS, "\\$&")})(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  let count = 0;
  for (const match of text.matchAll(finder)) {
    if (match[0] !== "") count += 1;
  }
  return count;
}

/**
 * Runtime shape guard for a compiled term base crossing a trust boundary.
 *
 * @param {TermBase} value
 * @returns {void}
 */
function assertTermBase(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the term base must be the object compileTermBase returned");
  }
  if (typeof value.lang !== "string" || !Array.isArray(value.entries)) {
    throw new Error("the term base is malformed — compile it with compileTermBase");
  }
  for (const entry of value.entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.term !== "string" ||
      typeof entry.rendering !== "string" ||
      typeof entry.token !== "string" ||
      !Array.isArray(entry.forbidden)
    ) {
      throw new Error("the term base holds a malformed entry — compile it with compileTermBase");
    }
  }
}

/**
 * Runtime shape guard for a mask crossing a trust boundary.
 *
 * @param {TermMask} value
 * @returns {void}
 */
function assertMask(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the mask must be the object maskTerms returned");
  }
  if (
    !(value.spans instanceof Map) ||
    !(value.counts instanceof Map) ||
    typeof value.edits !== "number"
  ) {
    throw new Error("the mask is malformed — build it with maskTerms");
  }
}

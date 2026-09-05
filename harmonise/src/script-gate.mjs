/**
 * The script gate — run-contract invariant I17: a published pair's
 * translatable prose carries the configured target language's script, and a
 * violation is a deterministic refusal of the pair.
 *
 * The gate is a script floor, not language identification. It counts the
 * candidate's letters per Unicode script and refuses when the expected set
 * does not hold more than half of them. What it accepts, by design:
 *
 * - **Same-script wrong-language passes.** An `en` answer for an `es` target
 *   is Latin on Latin — the gate has no opinion about the language itself.
 * - **Frontmatter keys, inline HTML tag names and code carried in prose skew
 *   the counts slightly.** They are letters in the candidate and vote like
 *   any other letter; only the machinery's own token spellings are excluded.
 * - **A primary subtag absent from the table means the gate is not applied.**
 *   A documented fail-open, strictly narrower than a wrong default, which
 *   would refuse correct translations wholesale.
 *
 * The table is code, not configuration: there is no new input surface, and
 * extending it is a reviewed decision about a language's script, not a
 * consumer setting.
 */

/**
 * Every Unicode script the table can expect, in one fixed evaluation order.
 * A letter is attributed to the first script in this order whose test matches
 * it, so multi-membership code points always count the same way — the order
 * is part of the gate's determinism and must never be reordered casually.
 *
 * @type {string[]}
 */
const SCRIPT_ORDER = [
  "Arabic",
  "Armenian",
  "Bengali",
  "Cyrillic",
  "Devanagari",
  "Ethiopic",
  "Georgian",
  "Greek",
  "Han",
  "Hangul",
  "Hebrew",
  "Hiragana",
  "Katakana",
  "Latin",
  "Tamil",
  "Thai",
];

const LETTER = /\p{L}/u;

const SCRIPT_TESTS = new Map(
  SCRIPT_ORDER.map((script) => [script, new RegExp(`\\p{Script=${script}}`, "u")]),
);

/**
 * The curated table: BCP-47 primary subtag → the Unicode scripts that must
 * hold the majority of a candidate's counted letters. Kept curated, not
 * exhaustive — a common tag is added when its script is uncontroversial, and
 * a tag left out leaves the pair unjudged by this gate rather than guessed
 * at. Multi-script targets (`ja`, `ko`) expect the union of their everyday
 * scripts; the majority is measured on the union, not per script.
 *
 * @type {Map<string, string[]>}
 */
const SCRIPTS_BY_PRIMARY_SUBTAG = new Map(
  Object.entries({
    // Latin script.
    en: ["Latin"],
    vi: ["Latin"],
    fr: ["Latin"],
    de: ["Latin"],
    es: ["Latin"],
    it: ["Latin"],
    pt: ["Latin"],
    nl: ["Latin"],
    pl: ["Latin"],
    tr: ["Latin"],
    id: ["Latin"],
    sv: ["Latin"],
    da: ["Latin"],
    no: ["Latin"],
    nb: ["Latin"],
    fi: ["Latin"],
    cs: ["Latin"],
    ro: ["Latin"],
    hu: ["Latin"],
    ca: ["Latin"],
    sq: ["Latin"],
    ms: ["Latin"],
    // Cyrillic script.
    ru: ["Cyrillic"],
    uk: ["Cyrillic"],
    bg: ["Cyrillic"],
    sr: ["Cyrillic"],
    // Han script.
    zh: ["Han"],
    // Japanese draws on three scripts together; Korean on Hangul with Han.
    ja: ["Han", "Hiragana", "Katakana"],
    ko: ["Hangul", "Han"],
    th: ["Thai"],
    ar: ["Arabic"],
    fa: ["Arabic"],
    ur: ["Arabic"],
    he: ["Hebrew"],
    el: ["Greek"],
    hi: ["Devanagari"],
    mr: ["Devanagari"],
    ne: ["Devanagari"],
    bn: ["Bengali"],
    ta: ["Tamil"],
    ka: ["Georgian"],
    hy: ["Armenian"],
    am: ["Ethiopic"],
  }),
);

/**
 * The spellings of the machinery's own placeholders — glossary (`g`), skip
 * (`s`) and frontmatter (`f`) tokens, as `protect.mjs` and `plan.mjs` mint
 * them. The tokenised candidate carries these in place of protected spans,
 * and their letters must never vote: a token is infrastructure, not prose.
 * The counts of `16` hex digits and the `gsf` kinds must cover every token
 * kind the pipeline mints — the token-heavy tests pin a real minted token
 * against this pattern.
 *
 * @type {RegExp}
 */
const HARMONISE_TOKEN = /\[\[harmonise:[0-9a-f]{16}:[gsf][1-9][0-9]*\]\]/gi;

/**
 * The primary subtag of a language tag, lowercased — `ja`, `vi-JP`,
 * `zh_Hant` all reduce to their table key. @param tags come from
 * configuration, which is validated upstream, so anything unusual degrades
 * to "gate not applied" rather than a throw.
 *
 * @param {string} languageTag
 * @returns {string | null}
 */
function primarySubtag(languageTag) {
  const match = /^[a-zA-Z]+/.exec(languageTag.trim());
  return match === null ? null : match[0].toLowerCase();
}

/**
 * The expected scripts as a refusal-sentence list — `Latin`, or
 * `Han, Hiragana or Katakana`.
 *
 * @param {string[]} scripts
 * @returns {string}
 */
function expectedList(scripts) {
  if (scripts.length === 1) return scripts[0] ?? "";
  return scripts.slice(0, -1).join(", ") + " or " + (scripts[scripts.length - 1] ?? "");
}

/**
 * Judges one candidate's prose against the configured target language's
 * script. Letters are counted per Unicode script with `\p{L}` membership and
 * `\p{Script=…}` tests — punctuation, digits, whitespace, markdown markup
 * and the machinery's own token spellings carry no votes. The expected set
 * must hold strictly more than half of all counted letters.
 *
 * @param {string} text the candidate — the tokenised answer content, so the
 *   vote measures exactly the translatable prose
 * @param {string} languageTag the pair's configured target language
 * @returns {string | null} the refusal sentence naming the target subtag,
 *   the winning foreign script — or the unlisted-script remainder when no
 *   listed script holds a letter — and the fraction — or null when the gate
 *   passes, the candidate has no counted letters, or the tag is absent from
 *   the table (the gate is not applied)
 */
export function judgeScript(text, languageTag) {
  const subtag = primarySubtag(languageTag);
  const expected = subtag === null ? undefined : SCRIPTS_BY_PRIMARY_SUBTAG.get(subtag);
  if (expected === undefined) return null;

  const counts = new Map();
  let total = 0;
  const withoutTokens = text.replace(HARMONISE_TOKEN, "");
  for (const character of withoutTokens) {
    if (!LETTER.test(character)) continue;
    total++;
    for (const [script, test] of SCRIPT_TESTS) {
      if (test.test(character)) {
        counts.set(script, (counts.get(script) ?? 0) + 1);
        break;
      }
    }
  }
  if (total === 0) return null;

  let expectedCount = 0;
  for (const script of expected) expectedCount += counts.get(script) ?? 0;
  if (expectedCount * 2 > total) return null;

  let winner;
  let winnerCount = 0;
  for (const script of SCRIPT_ORDER) {
    if (expected.includes(script)) continue;
    const count = counts.get(script) ?? 0;
    if (count > winnerCount) {
      winner = script;
      winnerCount = count;
    }
  }
  if (winner === undefined) {
    // Every counted letter sat in the expected scripts or in a script the
    // table does not list. Name the remainder rather than a script that
    // holds nothing: the sentence stays deterministic and content-free.
    winner = "an unlisted script";
    winnerCount = total - expectedCount;
  }
  return (
    `script gate: target language "${subtag}" requires ${expectedList(expected)} ` +
    `to hold the majority of the counted letters, but ${String(winner)} holds ` +
    `${String(winnerCount)}/${String(total)}`
  );
}

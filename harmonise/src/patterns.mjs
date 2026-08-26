/**
 * A language pattern — one line of the config's `languages` map, naming where
 * a language's version of a document lives: `docs/{document}.md`,
 * `locales/vi/{document}.mdx`, whatever shape a repository keeps.
 *
 * `{document}` is the whole variable part: it may span path segments (a file
 * `guides/setup.md` inside `docs/` matches `docs/{document}.md` with the slug
 * `guides/setup`), and nothing else in the pattern varies. Everything around
 * it is literal, so a slug is extracted and re-applied mechanically — no glob
 * semantics, no brace expansion, no guessing. The inventory classifies each
 * tree path against these patterns, and a path that satisfies two of them is
 * refused rather than ambiguously assigned.
 */

const PLACEHOLDER = "{document}";

/**
 * Validates one pattern and returns it, typed as carried. Exactly one
 * `{document}` and no other brace group: a second placeholder would make
 * extraction ambiguous, and a typo like `{doc}` would silently match
 * nothing.
 *
 * @param {string} pattern
 * @param {string} name where the pattern came from, for the error message
 * @returns {string}
 */
export function validateLanguagePattern(pattern, name) {
  if (typeof pattern !== "string" || pattern === "") {
    throw new Error(`${name} must be a non-empty pattern string`);
  }
  const count = pattern.split(PLACEHOLDER).length - 1;
  if (count !== 1) {
    throw new Error(
      `${name} must contain ${PLACEHOLDER} exactly once, got ${String(count)}: '${pattern}'`,
    );
  }
  const other = /\{[^{}]*\}/g.exec(pattern.replace(PLACEHOLDER, ""));
  if (other !== null) {
    throw new Error(
      `${name} carries a second placeholder '${other[0]}' — only ${PLACEHOLDER} exists`,
    );
  }
  return pattern;
}

/**
 * A parsed pattern, ready to extract slugs from paths and apply them back.
 *
 * @typedef {object} LanguagePattern
 * @property {(path: string) => string | null} slugFromPath the slug a repository path carries, or null when the path does not fit the pattern
 * @property {(slug: string) => string} pathFromSlug the repository path a slug takes under this pattern
 * @property {number} weight total literal characters around the placeholder — how specific the pattern is
 */

/**
 * @param {string} pattern validated by `validateLanguagePattern`
 * @returns {LanguagePattern}
 */
export function parseLanguagePattern(pattern) {
  const [before, after] = /** @type {[string, string]} */ (pattern.split(PLACEHOLDER));
  const extractor = new RegExp(`^${escape(before)}(.+)${escape(after)}$`);

  return {
    /**
     * @param {string} path
     */
    slugFromPath(path) {
      const match = extractor.exec(path);
      return match?.[1] ?? null;
    },

    /**
     * @param {string} slug
     */
    pathFromSlug(slug) {
      return `${before}${slug}${after}`;
    },

    weight: before.length + after.length,
  };
}

/** @param {string} literal @returns {string} */
function escape(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The localized-image candidate for a path: `. <lang>` inserted before its
 * final extension. `dev.png` becomes `dev.vi.png`, `logo.brand.svg` becomes
 * `logo.brand.vi.svg`, and an extensionless path gains the tag at its end.
 * Purely mechanical — whether the candidate exists is the inventory's answer,
 * never this function's concern.
 *
 * @param {string} path a decoded, repository-relative image path
 * @param {string} lang the target language tag
 * @returns {string}
 */
export function localizedImagePath(path, lang) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  // A dot in the final segment that leaves an extension — not a leading dot
  // alone (`README` stays `README.vi`-tagged at its end; `.hidden` likewise).
  const hasExtension = dot > slash + 1;
  return hasExtension ? `${path.slice(0, dot)}.${lang}${path.slice(dot)}` : `${path}.${lang}`;
}

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

/** The placeholders an asset layout template may carry, and no others. */
const LAYOUT_PLACEHOLDERS = new Set(["dir", "base", "ext", "lang"]);

/** The most layouts a config may carry — each is one more file a rewrite must imagine. */
export const MAX_ASSET_LAYOUTS = 8;

/**
 * One configured asset layout — a template over `{dir}`, `{base}`, `{ext}`
 * and `{lang}` naming where a localized image lives, relative to the
 * document's own directory. Compiled once at config load; rendering is pure
 * substitution, and whether a rendered candidate exists is never this
 * object's concern.
 *
 * @typedef {object} AssetLayout
 * @property {string} template the template exactly as configured
 * @property {(parts: { dir: string, base: string, ext: string, lang: string }) => string} render the candidate path, relative to the document's directory
 */

/**
 * Validates one asset layout template and returns it compiled. `{lang}` and
 * `{base}` must appear exactly once; `{dir}` and `{ext}` are optional and may
 * repeat. The literal parts — everything the repository author wrote around
 * the placeholders — must always produce a relative, in-directory path: a
 * leading slash or drive letter, a `..` segment or an empty segment can only
 * ever escape the document's directory, and that is refused at startup, not
 * discovered per reference. (`{dir}` varies per reference, so a rendered
 * candidate is re-checked where it is rendered.)
 *
 * @param {string} template
 * @param {string} name where the template came from, for the error message
 * @returns {AssetLayout}
 */
export function parseAssetLayout(template, name) {
  if (typeof template !== "string" || template === "") {
    throw new Error(`${name} must be a non-empty template string`);
  }
  for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
    const placeholder = /** @type {RegExpMatchArray} */ (match)[1] ?? "";
    if (!LAYOUT_PLACEHOLDERS.has(placeholder)) {
      throw new Error(
        placeholder === ""
          ? `${name} carries an empty placeholder '{}' — templates hold {dir}, {base}, {ext} and {lang}`
          : `${name} carries unknown placeholder '{${placeholder}}' — templates hold ` +
              `{dir}, {base}, {ext} and {lang}`,
      );
    }
  }
  const count = (/** @type {string} */ placeholder) =>
    template.split(`{${placeholder}}`).length - 1;
  const langCount = count("lang");
  if (langCount !== 1) {
    throw new Error(
      `${name} must contain {lang} exactly once, got ${String(langCount)}: '${template}'`,
    );
  }
  const baseCount = count("base");
  if (baseCount !== 1) {
    throw new Error(
      `${name} must contain {base} exactly once, got ${String(baseCount)}: '${template}'`,
    );
  }
  if (template.startsWith("/")) {
    throw new Error(
      `${name} must be relative to the document's directory — '${template}' starts with '/'`,
    );
  }
  if (/^[a-zA-Z]:/.test(template)) {
    throw new Error(`${name} names a drive, not a repository path — '${template}'`);
  }
  // Placeholders are blanked, never dropped: a segment that is `..` only
  // because of where a placeholder sits is the repository author's writing,
  // and traversal cannot hide inside a substituted value at config time.
  const segments = template.replace(/\{[^{}]*\}/g, "\u0000").split("/");
  if (segments.includes("")) {
    throw new Error(`${name} carries an empty path segment — '${template}'`);
  }
  if (segments.includes("..")) {
    throw new Error(`${name} climbs out of the document's directory with '..' — '${template}'`);
  }
  return {
    template,
    /** @param {{ dir: string, base: string, ext: string, lang: string }} parts */
    render(parts) {
      return template
        .replaceAll("{dir}", parts.dir)
        .replaceAll("{base}", parts.base)
        .replaceAll("{ext}", parts.ext)
        .replaceAll("{lang}", parts.lang);
    },
  };
}

/**
 * The built-in convention: `. <lang>` inserted before the path's final
 * extension. `dev.png` becomes `dev.vi.png`, `logo.brand.svg` becomes
 * `logo.brand.vi.svg`, and an extensionless path gains the tag at its end.
 *
 * @param {string} path a decoded, repository-absolute image path
 * @param {string} lang the target language tag
 * @returns {string}
 */
function defaultLocalizedImagePath(path, lang) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  // A dot in the final segment that leaves an extension — not a leading dot
  // alone (`README` stays `README.vi`-tagged at its end; `.hidden` likewise).
  const hasExtension = dot > slash + 1;
  return hasExtension ? `${path.slice(0, dot)}.${lang}${path.slice(dot)}` : `${path}.${lang}`;
}

/**
 * The localized-image candidates for a reference, in the order the resolver
 * tries them: the config's `assets.layouts` first, in config order, then the
 * built-in convention last — a repository adopting layouts keeps today's
 * convention as the fallback, and a repository without the key sees exactly
 * one candidate, the one it always saw.
 *
 * A layout names a path relative to the document's directory, so rendering
 * needs the document holding the reference (`fromDocPath`). A reference that
 * does not live inside that directory — `../shared/logo.png` — has no
 * document-relative shape and skips the configured candidates, falling
 * through to the built-in convention. A rendered candidate that escapes the
 * directory or carries an empty segment is skipped, never normalized into
 * acceptance.
 *
 * Purely mechanical — whether a candidate exists is the inventory's answer,
 * never this function's concern. Harmonise never creates, uploads, renames
 * or rewrites asset files: it only points references at localized variants
 * that already exist on the branch.
 *
 * @param {string} path a decoded, repository-absolute image path
 * @param {string} lang the target language tag
 * @param {object} [options]
 * @param {AssetLayout[]} [options.layouts] compiled `assets.layouts`, in config order
 * @param {string} [options.fromDocPath] repository path of the document holding the reference
 * @returns {string[]} candidates, best first
 */
export function localizedImagePath(path, lang, options = {}) {
  /** @type {string[]} */
  const candidates = [];
  const layouts = options.layouts ?? [];
  const docPath = options.fromDocPath;
  if (layouts.length > 0 && docPath !== undefined) {
    const docSlash = docPath.lastIndexOf("/");
    const docDir = docSlash < 0 ? "" : docPath.slice(0, docSlash);
    const prefix = docDir === "" ? "" : `${docDir}/`;
    if (path.startsWith(prefix)) {
      const rel = path.slice(prefix.length);
      const slash = rel.lastIndexOf("/");
      const dot = rel.lastIndexOf(".");
      const dir = slash < 0 ? "" : rel.slice(0, slash);
      const name = slash < 0 ? rel : rel.slice(slash + 1);
      const base = dot > slash + 1 ? name.slice(0, dot - slash - 1) : name;
      const ext = dot > slash + 1 ? rel.slice(dot + 1) : "";
      for (const layout of layouts) {
        const rendered = layout.render({ dir, base, ext, lang });
        const segments = rendered.split("/");
        if (rendered === "" || segments.some((segment) => segment === "" || segment === "..")) {
          continue;
        }
        candidates.push(`${prefix}${rendered}`);
      }
    }
  }
  candidates.push(defaultLocalizedImagePath(path, lang));
  return candidates;
}

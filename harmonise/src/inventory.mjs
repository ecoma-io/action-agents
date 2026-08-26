/**
 * The document inventory — one deterministic answer to "what multilingual
 * documentation does this repository hold, and what is each piece's state".
 *
 * Built from the complete Git tree listing and the config's language map,
 * before any other stage runs, because everything downstream leans on it:
 * pairing decides what gets translated, link resolution trusts it to know
 * whether a localized target exists or is planned, and orphan reporting
 * promises that a translation without a source is never silently judged.
 *
 * A path satisfying two language patterns is refused here rather than
 * classified arbitrarily — the config page calls such a map undefined, and
 * undefined is refused, not guessed.
 */

import { matchGlob } from "./glob.mjs";
import { localizedImagePath } from "./patterns.mjs";

/** A tree entry, as the forge hands it over. @typedef {{ path: string, type: string }} TreeEntry */

/**
 * One source document's standing across every target language.
 *
 * @typedef {object} Pair
 * @property {string} slug
 * @property {string} sourcePath
 * @property {{ lang: string, path: string, state: "existing" | "missing", planned: boolean }[]} targets sorted by language tag
 */

/**
 * @typedef {object} Inventory
 * @property {string[]} sourcePaths every non-ignored source document, sorted
 * @property {Pair[]} pairs one per source slug, sorted by slug
 * @property {{ path: string, lang: string }[]} orphanTranslations sorted; reported, never touched
 * @property {Set<string>} blobPaths every file on the default branch
 * @property {(absPath: string, lang: string) => string | null} resolveDocument where one document lives in `lang` — existing or planned by this run — else null
 * @property {(absPath: string, lang: string) => string | null} resolveImage an image's existing localized variant in `lang`, else null
 */

/**
 * @param {object} input
 * @param {TreeEntry[]} input.entries the default branch's complete tree listing
 * @param {import("./config.mjs").HarmoniseConfig} input.config
 * @param {string[]} input.documents the `documents` glob filter narrowing which pairs this run processes
 * @returns {Inventory}
 */
export function buildInventory({ entries, config, documents }) {
  const languages = Object.entries(config.languages);
  /** @type {Map<string, Record<string, string>>} */ // slug → lang → path
  const bySlug = new Map();
  /** @type {Set<string>} */
  const blobPaths = new Set();
  /** @type {Set<string>} */ // slugs whose source exists but is deliberately untranslated
  const ignoredSlugs = new Set();

  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    blobPaths.add(entry.path);

    // Every pattern that claims this file, with how specific its claim is.
    // Nested layouts (`docs/{document}.md` beside `docs/vi/{document}.md`)
    // are legitimate and common: a file inside a language's own directory is
    // claimed by both shapes, and the more specific pattern — more literal
    // characters around the placeholder — wins. Two patterns of equal
    // specificity claiming one file leave classification genuinely arbitrary,
    // and that is refused rather than guessed.
    /** @type {[string, string, number][]} */ // [lang, slug, weight]
    const matches = [];
    for (const [lang, pattern] of languages) {
      const slug = pattern.slugFromPath(entry.path);
      if (slug !== null) matches.push([lang, slug, pattern.weight]);
    }
    if (matches.length === 0) continue;
    const best = Math.max(...matches.map((match) => match[2]));
    const contenders = matches.filter((match) => match[2] === best);
    if (contenders.length > 1) {
      const named = contenders.map(([lang]) => `'${lang}'`).join(", ");
      throw new Error(
        `'${entry.path}' matches several language patterns equally well (${named}) — ` +
          `make one pattern more specific than the other; classification would otherwise ` +
          `be arbitrary`,
      );
    }
    const contender = contenders[0];
    if (contender === undefined) continue;
    const [lang, slug] = contender;

    if (lang === config.sourceLanguage && matchGlob(config.ignore, entry.path)) {
      ignoredSlugs.add(slug);
      continue;
    }
    const slot = bySlug.get(slug) ?? {};
    slot[lang] = entry.path;
    bySlug.set(slug, slot);
  }

  /** @type {Pair[]} */
  const pairs = [];
  const targetLanguages = languages
    .map(([lang]) => lang)
    .filter((lang) => lang !== config.sourceLanguage)
    .sort();

  for (const slug of [...bySlug.keys()].sort()) {
    const slot = /** @type {Record<string, string>} */ (bySlug.get(slug));
    const sourcePath = slot[config.sourceLanguage];
    if (sourcePath === undefined || ignoredSlugs.has(slug)) continue;

    // Only pairs this run processes will actually gain their missing files.
    // An empty filter selects everything — the map defines the space.
    const selected = documents.length === 0 || matchGlob(documents, sourcePath);
    /** @type {Pair["targets"]} */
    const targets = [];
    for (const lang of targetLanguages) {
      const existing = slot[lang];
      if (existing !== undefined) {
        targets.push({ lang, path: existing, state: "existing", planned: false });
      } else {
        targets.push({
          lang,
          path: pathForTarget(config, slug, lang),
          state: "missing",
          planned: selected,
        });
      }
    }
    pairs.push({ slug, sourcePath, targets });
  }

  /** @type {{ path: string, lang: string }[]} */
  const orphanTranslations = [];
  for (const [slug, slot] of bySlug) {
    if (slot[config.sourceLanguage] !== undefined || ignoredSlugs.has(slug)) continue;
    for (const lang of targetLanguages) {
      const path = slot[lang];
      if (path !== undefined) orphanTranslations.push({ path, lang });
    }
  }
  orphanTranslations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // The canonical lookup index: slug → lang → target. Link resolution asks it
  // once per link instead of scanning `pairs`, and — the real reason it
  // exists — there is exactly one answer to "where does slug X live in lang
  // Y", built here and read everywhere.
  /** @type {Map<string, Map<string, Pair["targets"][number]>>} */
  const targetIndex = new Map();
  for (const pair of pairs) {
    targetIndex.set(pair.slug, new Map(pair.targets.map((target) => [target.lang, target])));
  }

  return {
    sourcePaths: pairs.map((pair) => pair.sourcePath),
    pairs,
    orphanTranslations,
    blobPaths,

    /**
     * Where one document's `lang` version lives: its existing translation,
     * or the path this run plans to create. Null when neither holds — that
     * includes paths that fit no source pattern at all. The slug is always
     * extracted with the source language's pattern: a link is identified by
     * the document it points at, whatever shape the target language keeps.
     */
    resolveDocument(absPath, lang) {
      const slug = config.languages[config.sourceLanguage]?.slugFromPath(absPath);
      if (slug === null || slug === undefined) return null;
      const target = targetIndex.get(slug)?.get(lang);
      if (target === undefined) return null;
      return target.state === "existing" || target.planned ? target.path : null;
    },

    /** An image's localized variant — only ever a file the branch already holds. */
    resolveImage(absPath, lang) {
      const candidate = localizedImagePath(absPath, lang);
      return blobPaths.has(candidate) ? candidate : null;
    },
  };
}

/**
 * @param {import("./config.mjs").HarmoniseConfig} config
 * @param {string} slug
 * @param {string} lang
 * @returns {string}
 */
function pathForTarget(config, slug, lang) {
  const pattern = config.languages[lang];
  if (pattern === undefined) throw new Error(`language '${lang}' has no pattern`);
  return pattern.pathFromSlug(slug);
}

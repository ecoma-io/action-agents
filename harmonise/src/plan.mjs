/**
 * Pair preparation — the whole deterministic half of translating one
 * document, run before any model exists in the picture.
 *
 * For one (source, target-language) pair this fixes everything the model must
 * not decide: the destination path, which terms and regions are protected,
 * where internal links and images point in the translated tree. What comes
 * back is either a prepared pair — protected, link-resolved source text plus
 * the protection map a later stage restores against — or a recorded failure.
 * A pair that fails preparation never reaches translation; the run reports
 * it and carries on with the rest.
 */

import { rewriteLinks } from "./links.mjs";
import { protectDocument } from "./protect.mjs";

/** @typedef {import("./inventory.mjs").Inventory} Inventory */

/**
 * The most source text one pair may carry. Both documents must fit inside the
 * evidence wrapper's 64 KiB frame, so the source alone is capped at half that;
 * a pair past the cap skips with that reason rather than translating a
 * silently truncated document.
 */
export const MAX_SOURCE_BYTES = 32 * 2 ** 10;

/**
 * Why a pair cannot be prepared, or null when it can.
 *
 * @param {string} sourceText
 * @returns {string | null}
 */
export function preparationRefusal(sourceText) {
  if (sourceText === "") return "the source document is empty";
  const bytes = new TextEncoder().encode(sourceText).byteLength;
  if (bytes > MAX_SOURCE_BYTES) {
    return (
      `${String(bytes)} bytes, past the ${String(MAX_SOURCE_BYTES)}-byte cap — split the ` +
      `document so both versions fit the evidence frame`
    );
  }
  return null;
}

/**
 * @typedef {object} PreparedPair
 * @property {string} slug
 * @property {string} lang
 * @property {string} sourcePath
 * @property {string} destinationPath
 * @property {"existing" | "missing"} state
 * @property {string} protectedText the source as the model will receive it
 * @property {ReturnType<typeof protectDocument>} protection
 * @property {number} linksRewritten destinations that moved during preparation
 */

/**
 * Prepares one pair. Throws only on defects that make the pair unpreparable
 * (malformed directives); callers record those per pair and carry on.
 *
 * @param {object} input
 * @param {string} input.slug
 * @param {string} input.lang
 * @param {string} input.sourcePath
 * @param {{ path: string, state: "existing" | "missing" }} input.target
 * @param {string} input.sourceText
 * @param {Inventory} input.inventory
 * @param {import("./config.mjs").HarmoniseConfig} input.config
 * @returns {PreparedPair}
 */
export function preparePair({ slug, lang, sourcePath, target, sourceText, inventory, config }) {
  const protection = protectDocument(sourceText, { glossary: config.glossary });

  /** @type {import("./links.mjs").LinkContext} */
  const context = {
    sourceDocPath: sourcePath,
    translatedDocPath: target.path,
    languageTag: lang,
    resolveDocument: (absPath) => inventory.resolveDocument(absPath, lang),
    resolveImage: (absPath) => inventory.resolveImage(absPath, lang),
  };
  const rewritten = rewriteLinks(protection.text, context);

  return {
    slug,
    lang,
    sourcePath,
    destinationPath: target.path,
    state: target.state,
    protectedText: rewritten.text,
    protection,
    linksRewritten: rewritten.count,
  };
}

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
import { restoreDocument } from "./protect.mjs";
import { parseTranslationAnswer } from "./answer.mjs";
import { buildTranslationPrompt } from "./prompt.mjs";
import { compareStructuralProfiles, structuralProfile } from "./markdown.mjs";

/** @typedef {import("./inventory.mjs").Inventory} Inventory */
/** @typedef {import("#core/chat.mjs").Chat} Chat */
/** @typedef {import("#core/untrusted.mjs").Evidence} Evidence */

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
 * @property {string} sourceText the untouched original, for identity checks and structure comparison
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
    sourceText,
    protectedText: rewritten.text,
    protection,
    linksRewritten: rewritten.count,
  };
}

/**
 * Translates one prepared pair: prompt, one chat request, contract parsing,
 * placeholder restoration, structural comparison. The model's degrees of
 * freedom end at prose and the three contract fields — everything else was
 * already decided when the text was prepared.
 *
 * @param {object} input
 * @param {PreparedPair} input.prepared
 * @param {string} input.sourceLanguage the config's resolved source language
 * @param {string | undefined} input.existingText the translation on the branch, when one exists
 * @param {string} input.model
 * @param {Chat} input.chat
 * @param {Evidence} input.evidence
 * @param {{ name: string, description: string }} input.repository
 * @param {{ instruction?: string, languages: Record<string, string> }} input.documents
 * @returns {Promise<{ outcome: "noop", summary: string } | { outcome: "proposal", text: string, summary: string }>}
 */
export async function translatePair(input) {
  const { messages } = buildTranslationPrompt({
    repository: input.repository,
    sourceLanguage: input.sourceLanguage,
    language: input.prepared.lang,
    protectedSource: input.prepared.protectedText,
    existingTranslation: input.existingText,
    documents: input.documents,
    evidence: input.evidence,
  });

  const { content } = await input.chat.complete({ model: input.model, messages });
  const answer = parseTranslationAnswer(content, {
    existingTranslation: input.existingText,
  });

  // The cheapest identity check runs first, on what the model actually said:
  // an answer carrying the published translation verbatim needs no
  // restoration — the published text holds no placeholders to validate.
  // Without this early exit, an honest no-op could never pass restoration,
  // because the published text legitimately contains none of this run's
  // tokens.
  if (input.existingText !== undefined && answer.content === input.existingText) {
    return { outcome: "noop", summary: answer.summary };
  }

  // Restoration is validation: counts must match and no unknown token may
  // wear this run's namespace, or this throws and the pair fails.
  const restored = restoreDocument(answer.content, input.prepared.protection);

  // A proposal past the same cap the preparation enforces would be a
  // document we could never frame as evidence on a later pass.
  const bytes = new TextEncoder().encode(restored).byteLength;
  if (bytes > MAX_SOURCE_BYTES) {
    throw new Error(
      `the translated document is ${String(bytes)} bytes, past the ` +
        `${String(MAX_SOURCE_BYTES)}-byte cap`,
    );
  }

  // Byte-identity semantics, per the specification: identical to what it
  // replaces is no drift whatever the flag claimed.
  if (input.existingText !== undefined && restored === input.existingText) {
    return { outcome: "noop", summary: answer.summary };
  }

  const violations = compareStructuralProfiles(
    structuralProfile(input.prepared.sourceText),
    structuralProfile(restored),
  );
  if (violations.length > 0) {
    throw new Error(`structural validation failed: ${violations.join("; ")}`);
  }

  return { outcome: "proposal", text: restored, summary: answer.summary };
}

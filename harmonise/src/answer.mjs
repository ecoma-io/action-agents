/**
 * The model's answer against the translation contract — parsed tolerantly,
 * judged intolerantly.
 *
 * Parsing tolerates provider drift: the JSON5 parser, plus one code fence
 * wrapping the whole answer. Judging tolerates none: `drift` must be a
 * boolean, `content` and `summary` strings, and the drift flag must agree
 * with what the content actually is — a `drift: false` whose content differs
 * from the existing translation has not answered the question asked, and an
 * answer that cannot be trusted on its own face is a failed pair.
 *
 * Placeholder counting, restoration and structural comparison live where the
 * protection map is; this module only decides whether the answer is shaped
 * like a decision at all.
 */

import { parseJsonish } from "#core/answer-json.mjs";

/** @typedef {{ drift: boolean, summary: string, content: string }} TranslationAnswer */

/**
 * @param {string} content what the model answered
 * @param {object} input
 * @param {string | undefined} input.existingTranslation
 * @returns {TranslationAnswer}
 */
export function parseTranslationAnswer(content, { existingTranslation }) {
  const value = parseJsonish(content);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the model's answer is not a JSON object");
  }
  const answer = /** @type {Record<string, unknown>} */ (value);

  const drift = answer["drift"];
  if (typeof drift !== "boolean") {
    throw new Error("the model's answer carries no boolean 'drift'");
  }
  const summary = answer["summary"];
  if (typeof summary !== "string") {
    throw new Error("the model's answer carries no 'summary' string");
  }
  const document = answer["content"];
  if (typeof document !== "string") {
    throw new Error("the model's answer carries no 'content' string");
  }
  if (document === "") {
    throw new Error("the model's answer holds empty content");
  }
  // Whitespace between the fences is not a document either.
  if (document.trim() === "") {
    throw new Error("the model's answer holds no content beyond whitespace");
  }

  // A missing translation is always drift: there is nothing it could be
  // byte-identical to.
  if (!drift && existingTranslation === undefined) {
    throw new Error(
      "the model's answer says drift=false for a translation that does not exist yet",
    );
  }

  // A `drift: false` whose content differs from the existing translation is
  // self-contradictory: the model declined to call it changed while changing
  // it. That is not a judgment to act on either way.
  if (!drift && existingTranslation !== undefined && document !== existingTranslation) {
    throw new Error(
      "the model's answer says drift=false but its content differs from the existing translation",
    );
  }

  return { drift, summary, content: document };
}

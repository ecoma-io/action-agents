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

import { json5Parse } from "#core/json5-parse.mjs";

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

/**
 * JSON5 with the fences stripped and a bare object located — everything a
 * drifting provider adds around the JSON it was asked for, and no more.
 * Prose before or after the object is not tolerated: an answer that is
 * mostly prose has not answered.
 *
 * @param {string} content
 * @returns {unknown}
 */
function parseJsonish(content) {
  const trimmed = stripFences(content.trim());
  const attempt = extractObject(trimmed);
  if (attempt === null) {
    throw new Error("the model's answer holds no JSON object");
  }
  try {
    return json5Parse(attempt);
  } catch (cause) {
    const error = new Error("the model's answer does not parse as JSON");
    error.cause = cause;
    throw error;
  }
}

/**
 * Strips one fenced block wrapping the whole answer — ```json … ``` most
 * often. A fence in the middle of prose is left exactly where it is.
 *
 * @param {string} text
 * @returns {string}
 */
function stripFences(text) {
  const match = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return match?.[1] === undefined ? text : match[1];
}

/**
 * The outermost `{…}` of the text, or null when there is none. Bracket
 * counting is string-aware so a brace inside the model's prose does not
 * close the object early.
 *
 * @param {string} text
 * @returns {string | null}
 */
function extractObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

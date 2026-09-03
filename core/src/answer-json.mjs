/**
 * Parsing a model's answer as the JSON object the prompt asked for — the
 * shape `triage` and `harmonise` share, factored into one home so the
 * tolerance and the refusal language cannot drift between them.
 *
 * The tolerance is narrow on purpose: fences are stripped, a bare `{…}`
 * object is located, and everything else — prose before or after the object —
 * is refused. `review`'s answer parser is NOT this one: it is quote-aware in
 * both `"` and `'`, because review's answer grammar quotes the file paths it
 * operates on, while triage and harmonise only ever read double-quoted JSON.
 * The two were identical until review grew that difference; this module is
 * the double-quote-only home the two simple actions import.
 *
 * Every refusal carries the answer's shape class in its message — empty, no
 * object, or bytes that do not parse — as a typed `AnswerShapeError`, so a
 * caller can tell a provider that fumbled the one question it was asked
 * from a model that answered and answered wrong, without ever logging the
 * answer itself (#261).
 */

import { json5Parse } from "./json5-parse.mjs";

/**
 * The answer never presented the JSON object the prompt asked for. The
 * class a pipeline reads when deciding whether the question may be asked
 * once more: an empty answer or prose is a provider fumble, while a
 * parseable answer that misses its contract is a decision — and a decision
 * is never this error, and never retried.
 */
export class AnswerShapeError extends Error {
  /**
   * @param {string} message the shape class, named for the run log — the
   *   answer's own bytes never appear in it
   */
  constructor(message) {
    super(message);
    this.name = "AnswerShapeError";
  }
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
export function parseJsonish(content) {
  const trimmed = stripFences(content.trim());
  if (trimmed === "") {
    throw new AnswerShapeError("the model's answer was empty");
  }
  const attempt = extractObject(trimmed);
  if (attempt === null) {
    throw new AnswerShapeError("the model's answer holds no JSON object");
  }
  try {
    return json5Parse(attempt);
  } catch (cause) {
    const error = new AnswerShapeError("the model's answer does not parse as JSON");
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
export function stripFences(text) {
  const match = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return match?.[1] === undefined ? text : match[1];
}

/**
 * The outermost `{…}` of the text, or null when there is none. Bracket
 * counting is string-aware so a brace inside the model's prose does not
 * close the object early. Single-quote aware only for JSON's own escaping —
 * `'` is not a quote here: triage and harmonise read double-quoted JSON.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

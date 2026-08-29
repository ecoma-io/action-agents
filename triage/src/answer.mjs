/**
 * The model's answer — parsed tolerantly, matched intolerantly.
 *
 * Parsing tolerates provider drift: the same JSON5 parser the config file
 * uses, plus the code fences a model likes to wrap its JSON in. Matching
 * tolerates none of it: `bug `, `Bug` and `BUG` are not `bug`, and an
 * answer that is not on the sheet is refused and logged, never coerced and
 * never retried. The sheet — never the prompt — is the ceiling, and exact
 * match is where that ceiling is enforced in code.
 *
 * An answer entirely off-sheet is a red run rather than green-on-nothing;
 * an answer partly off-sheet applies its on-sheet half and logs the rest.
 */

import { parseJsonish } from "#core/answer-json.mjs";

/** @typedef {{ labels: string[], rationale: string }} LabelsAnswer */
/** @typedef {{ classification: string, rationale: string }} CommentAnswer */

/**
 * Parses a sheet-mode answer: `{"labels": […], "rationale": "…"}`.
 *
 * @param {string} content what the model answered
 * @returns {LabelsAnswer}
 */
export function parseLabelsAnswer(content) {
  const value = parseJsonish(content);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the model's answer is not a JSON object");
  }
  const answer = /** @type {Record<string, unknown>} */ (value);
  if (!Array.isArray(answer["labels"])) {
    throw new Error("the model's answer has no labels array");
  }
  /** @type {string[]} */
  const labels = [];
  for (const label of answer["labels"]) {
    if (typeof label !== "string") {
      throw new Error("the model's answer names a label that is not a string");
    }
    labels.push(label);
  }
  return { labels, rationale: rationaleOf(answer) };
}

/**
 * Parses a no-sheet answer: `{"classification": "…", "rationale": "…"}` —
 * the whole classification becomes the marker comment's text.
 *
 * @param {string} content
 * @returns {CommentAnswer}
 */
export function parseCommentAnswer(content) {
  const value = parseJsonish(content);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the model's answer is not a JSON object");
  }
  const answer = /** @type {Record<string, unknown>} */ (value);
  const classification = answer["classification"];
  if (typeof classification !== "string" || classification === "") {
    throw new Error("the model's answer has no classification string");
  }
  return { classification, rationale: rationaleOf(answer) };
}

/**
 * Matches each chosen label exactly against the sheet. No trimming, no
 * case-folding: a match made loosely enough that `bug ` passes for `bug` is
 * exactly the report `SECURITY.md` asks for.
 *
 * @param {string[]} chosen
 * @param {Map<string, string>} sheet
 * @returns {{ accepted: string[], refused: string[] }}
 */
export function matchLabels(chosen, sheet) {
  /** @type {string[]} */
  const accepted = [];
  /** @type {string[]} */
  const refused = [];
  for (const label of chosen) {
    if (sheet.has(label)) accepted.push(label);
    else refused.push(label);
  }
  return { accepted, refused };
}

/**
 * @param {Record<string, unknown>} answer
 * @returns {string}
 */
function rationaleOf(answer) {
  const rationale = answer["rationale"];
  if (rationale === undefined) return "";
  if (typeof rationale !== "string") {
    throw new Error("the model's answer carries a rationale that is not a string");
  }
  return rationale;
}

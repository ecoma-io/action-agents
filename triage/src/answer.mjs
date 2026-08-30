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

/**
 * The issue-side dimensions the model answers about — quality,
 * relationships and priority — on top of the labels it chose. Strict shape
 * (a dimension of the wrong type is a red run, exactly like a malformed
 * labels answer), lenient vocabulary: a relationship `type` outside the five
 * the prompt offers is a warning the policy logs, never a coercion.
 *
 * @typedef {object} IssueDimensions
 * @property {{ missing?: string[], weak?: string[], completeness?: string, confidence?: number | null }} [quality]
 * @property {{ candidates?: Array<{ index: number, type?: string, confidence?: number | null, evidence?: string }> }} [relationships]
 * @property {{ severity?: string | null, confidence?: number | null }} [priority]
 */

/**
 * Parses the model's `dimensions` field, present only on sheet-mode issue
 * runs. Absent, it is `{}` — the original PR-A/PR-B contract, where an issue
 * answer carried only labels and a rationale, stays a valid answer. Every
 * dimension is optional; a wrong type is refused.
 *
 * @param {string} content
 * @returns {IssueDimensions}
 */
export function parseIssueDimensions(content) {
  const value = parseJsonish(content);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the model's answer is not a JSON object");
  }
  const answer = /** @type {Record<string, unknown>} */ (value);
  if (answer["dimensions"] === undefined) return {};

  const raw = answer["dimensions"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("the model's dimensions are not a JSON object");
  }
  const dimensions = /** @type {Record<string, unknown>} */ (raw);

  /** @type {IssueDimensions} */
  const result = {};

  if (dimensions["quality"] !== undefined) {
    const quality = dimensions["quality"];
    if (typeof quality !== "object" || quality === null || Array.isArray(quality)) {
      throw new Error("the model's quality dimension is not a JSON object");
    }
    const q = /** @type {Record<string, unknown>} */ (quality);
    /** @type {IssueDimensions["quality"]} */
    const parsed = {};
    if (q["missing"] !== undefined) {
      if (!Array.isArray(q["missing"]) || !q["missing"].every((item) => typeof item === "string")) {
        throw new Error("the model's quality.missing is not an array of strings");
      }
      parsed.missing = /** @type {string[]} */ (q["missing"]);
    }
    if (q["weak"] !== undefined) {
      if (!Array.isArray(q["weak"]) || !q["weak"].every((item) => typeof item === "string")) {
        throw new Error("the model's quality.weak is not an array of strings");
      }
      parsed.weak = /** @type {string[]} */ (q["weak"]);
    }
    if (q["completeness"] !== undefined) {
      if (typeof q["completeness"] !== "string") {
        throw new Error("the model's quality.completeness is not a string");
      }
      parsed.completeness = q["completeness"];
    }
    if (q["confidence"] !== undefined && q["confidence"] !== null) {
      if (typeof q["confidence"] !== "number") {
        throw new Error("the model's quality.confidence is not a number");
      }
      parsed.confidence = q["confidence"];
    }
    result.quality = parsed;
  }

  if (dimensions["relationships"] !== undefined) {
    const relationships = dimensions["relationships"];
    if (
      typeof relationships !== "object" ||
      relationships === null ||
      Array.isArray(relationships)
    ) {
      throw new Error("the model's relationships dimension is not a JSON object");
    }
    const r = /** @type {Record<string, unknown>} */ (relationships);
    /** @type {IssueDimensions["relationships"]} */
    const parsed = {};
    if (r["candidates"] !== undefined) {
      if (!Array.isArray(r["candidates"])) {
        throw new Error("the model's relationships.candidates is not an array");
      }
      /** @type {NonNullable<import("./answer.mjs").IssueDimensions["relationships"]>["candidates"]} */
      const candidates = [];
      for (const item of r["candidates"]) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          throw new Error("a model relationship candidate is not a JSON object");
        }
        const candidate = /** @type {Record<string, unknown>} */ (item);
        if (typeof candidate["index"] !== "number") {
          throw new Error("a model relationship candidate has no numeric index");
        }
        /** @type {{ index: number, type?: string, confidence?: number | null, evidence?: string }} */
        const parsedCandidate = { index: candidate["index"] };
        if (candidate["type"] !== undefined) {
          if (typeof candidate["type"] !== "string") {
            throw new Error("a model relationship candidate type is not a string");
          }
          parsedCandidate.type = candidate["type"];
        }
        if (candidate["confidence"] !== undefined && candidate["confidence"] !== null) {
          if (typeof candidate["confidence"] !== "number") {
            throw new Error("a model relationship candidate confidence is not a number");
          }
          parsedCandidate.confidence = candidate["confidence"];
        }
        if (candidate["evidence"] !== undefined) {
          if (typeof candidate["evidence"] !== "string") {
            throw new Error("a model relationship candidate evidence is not a string");
          }
          parsedCandidate.evidence = candidate["evidence"];
        }
        candidates.push(parsedCandidate);
      }
      parsed.candidates = candidates;
    }
    result.relationships = parsed;
  }

  if (dimensions["priority"] !== undefined) {
    const priority = dimensions["priority"];
    if (typeof priority !== "object" || priority === null || Array.isArray(priority)) {
      throw new Error("the model's priority dimension is not a JSON object");
    }
    const p = /** @type {Record<string, unknown>} */ (priority);
    /** @type {IssueDimensions["priority"]} */
    const parsed = {};
    if (p["severity"] !== undefined && p["severity"] !== null) {
      if (typeof p["severity"] !== "string") {
        throw new Error("the model's priority.severity is not a string");
      }
      parsed.severity = p["severity"];
    }
    if (p["confidence"] !== undefined && p["confidence"] !== null) {
      if (typeof p["confidence"] !== "number") {
        throw new Error("the model's priority.confidence is not a number");
      }
      parsed.confidence = p["confidence"];
    }
    result.priority = parsed;
  }

  return result;
}

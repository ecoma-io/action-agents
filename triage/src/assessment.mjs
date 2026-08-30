/**
 * The Assessment — the model's one bounded semantic judgement in the Work
 * Item pipeline.
 *
 * Exactly one chat call happens in a run, and it happens here: the prompt is
 * assembled from the `Evidence` (with the untrusted title/body framed by
 * `core/untrusted.mjs`), one completion is requested, and the answer is
 * parsed into a typed `Assessment`. Parsing tolerates provider drift (the
 * JSON5 parser), matching tolerates none of it — and matching is the policy
 * engine's job, not the model's and not this module's. This module turns
 * bytes into a typed judgement; it never decides what gets mutated.
 */

import { buildPrompt } from "./prompt.mjs";
import { parseCommentAnswer, parseLabelsAnswer } from "./answer.mjs";
/** @typedef {import("#core/untrusted.mjs").Evidence} EvidenceWrapper */

/** @typedef {import("./evidence.mjs").Evidence} Evidence */
/** @typedef {import("./config.mjs").TriageConfig} TriageConfig */

/**
 * The model's bounded judgement. Sheet mode names labels drawn from the
 * offered sheet (enforced by the policy engine downstream); no-sheet mode
 * produces the classification that becomes the marker comment.
 *
 * @typedef {object} LabelsAssessment
 * @property {"labels"} intent
 * @property {string[]} labels the model chose, not yet ceiling-checked
 * @property {string} rationale
 *
 * @typedef {object} CommentAssessment
 * @property {"comment"} intent
 * @property {string} classification
 * @property {string} rationale
 *
 * @typedef {LabelsAssessment | CommentAssessment} Assessment
 */

/**
 * @typedef {object} AssessmentInput
 * @property {Evidence} evidence
 * @property {{ instruction?: string, typeInstruction?: string }} documents
 * @property {ReturnType<typeof import("#core/chat.mjs").createChat>} chat
 * @property {string} model
 * @property {EvidenceWrapper} evidenceWrapper
 */

/**
 * Makes the run's single chat call and parses the answer into an
 * `Assessment`. The prompt's shape (sheet present or not) selects which
 * answer contract the model is asked for, and the matching parser.
 *
 * @param {AssessmentInput} input
 * @returns {Promise<Assessment>}
 */
export async function assess({ evidence, documents, chat, model, evidenceWrapper }) {
  const sheet = evidence.sheet;
  const { messages } = buildPrompt({
    thread: evidence.thread,
    repository: evidence.repository,
    sheet,
    documents,
    files: evidence.files,
    evidence: evidenceWrapper,
  });
  const { content } = await chat.complete({ model, messages });
  if (sheet === null) {
    return { intent: "comment", ...parseCommentAnswer(content) };
  }
  return { intent: "labels", ...parseLabelsAnswer(content) };
}

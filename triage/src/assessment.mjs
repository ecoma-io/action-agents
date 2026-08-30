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
 * The Assessment's contract version and provenance. `assess()` always stamps
 * these on the judgement; evaluator PR-C/D populate the dimensions.
 */
export const ASSESSMENT_VERSION = 1;

/**
 * The empty judgment-dimensions shape. Each slot is advisory metadata an
 * evaluator (PR-C/D) fills in from a severity/rubric judgement — the model
 * is not asked for it in this contract, so it stays empty here. `pr` is the
 * placeholder for a pull-request-specific dimension.
 *
 * @typedef {object} AssessmentDimensions
 * @property {unknown} classification
 * @property {unknown} quality
 * @property {unknown} routing
 * @property {unknown} relationships
 * @property {unknown} priority
 * @property {unknown} pr
 */

/**
 * The model's bounded judgement. Sheet mode names labels drawn from the
 * offered sheet (enforced by the policy engine downstream); no-sheet mode
 * produces the classification that becomes the marker comment. The contract
 * fields (`issuedBy`, `version`, `confidence`, `dimensions`) are stamped by
 * `assess()` on every assessment; the optional marker only keeps minimal
 * literals in tests valid.
 *
 * @typedef {object} LabelsAssessment
 * @property {"labels"} intent
 * @property {string[]} labels the model chose, not yet ceiling-checked
 * @property {string} rationale
 * @property {string} [issuedBy] "triage" — the producer
 * @property {number} [version] the assessment contract version
 * @property {number | null} [confidence] advisory strength, never a
 *   probability-of-correctness; empty until an evaluator populates it
 * @property {AssessmentDimensions} [dimensions] the evaluator-populated slots
 *
 * @typedef {object} CommentAssessment
 * @property {"comment"} intent
 * @property {string} classification
 * @property {string} rationale
 * @property {string} [issuedBy]
 * @property {number} [version]
 * @property {number | null} [confidence]
 * @property {AssessmentDimensions} [dimensions]
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
  const descriptor = {
    issuedBy: "triage",
    version: ASSESSMENT_VERSION,
    // Advisory strength, never a probability-of-correctness. Empty in this
    // contract; an evaluator (PR-C/D) populates it from a rubric judgement.
    confidence: null,
    // The evaluator-populated judgment slots; empty until PR-C/D.
    dimensions: {
      classification: undefined,
      quality: undefined,
      routing: undefined,
      relationships: undefined,
      priority: undefined,
      pr: undefined,
    },
  };
  if (sheet === null) {
    return { intent: "comment", ...parseCommentAnswer(content), ...descriptor };
  }
  return { intent: "labels", ...parseLabelsAnswer(content), ...descriptor };
}

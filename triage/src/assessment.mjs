/**
 * The Assessment — the model's one bounded semantic judgement in the Work
 * Item pipeline.
 *
 * The run's chat calls happen here, and nowhere else: the prompt is
 * assembled from the `Evidence` (with the untrusted title/body framed by
 * `core/untrusted.mjs`), a completion is requested, and the answer is
 * parsed into a typed `Assessment`. An answer that never presented the JSON
 * object the prompt asked for earns exactly one more ask (#261) — a
 * provider fumble, not a judgement; an answer that parses is taken as it
 * stands, off-sheet refusals included, and is never re-asked. Parsing
 * tolerates provider drift (the JSON5 parser), matching tolerates none of
 * it — and matching is the policy engine's job, not the model's and not
 * this module's. This module turns bytes into a typed judgement; it never
 * decides what gets mutated.
 */

import { AnswerShapeError, parseJsonish } from "#core/answer-json.mjs";
import { info } from "#core/runtime.mjs";

import { buildPrompt } from "./prompt.mjs";
import { computePrSignals } from "./pr.mjs";
import {
  parseCommentAnswer,
  parseIssueDimensions,
  parseLabelsAnswer,
  parsePrDimension,
} from "./answer.mjs";
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
    forgeSearch: evidence.forgeSearch,
    evidence: evidenceWrapper,
    quality: evidence.quality,
    policy: evidence.policy,
  });
  // The one redelivery a fumbled answer earns (#261): a provider that
  // answers empty or in prose instead of the JSON object the prompt asked
  // for gets exactly one more ask — the release-PR incident was two such
  // answers in a row that a third ask cleared. An answer that parses is
  // taken as it stands: an off-sheet refusal or a missed contract is the
  // model's decision, and a decision is never retried. The log line names
  // the shape class, never the answer's bytes.
  let { content } = await chat.complete({ model, messages });
  try {
    parseJsonish(content);
  } catch (cause) {
    if (!(cause instanceof AnswerShapeError)) throw cause;
    info(`triage: the model's answer was unusable (${cause.message}) — asking once more`);
    ({ content } = await chat.complete({ model, messages }));
    try {
      parseJsonish(content);
    } catch (retryCause) {
      if (!(retryCause instanceof AnswerShapeError)) throw retryCause;
      throw new AnswerShapeError(`${retryCause.message} (after 2 attempts)`);
    }
  }
  const descriptor = {
    issuedBy: "triage",
    version: ASSESSMENT_VERSION,
    // Advisory strength, never a probability-of-correctness. Empty in this
    // contract; an evaluator (PR-C/D) populates it from a rubric judgement.
    confidence: null,
  };
  // The PR dimension: deterministic signals computed by code (scope, risk,
  // dependency, readiness, routing) plus the model's bounded semantic
  // judgement parsed tolerantly. Evidence and note only — everything that
  // may mutate still flows through the policy engine below. Populated in
  // the return path (PR-C moved `dimensions` out of the descriptor literal),
  // present only on a pull-request thread.
  const prDimension =
    evidence.thread.type === "pr"
      ? {
          facts: computePrSignals(evidence),
          judgement: parsePrDimension(content),
        }
      : undefined;
  if (sheet === null) {
    return {
      intent: "comment",
      ...parseCommentAnswer(content),
      ...descriptor,
      dimensions: {
        classification: undefined,
        quality: undefined,
        relationships: undefined,
        priority: undefined,
        pr: prDimension,
      },
    };
  }
  const labels = parseLabelsAnswer(content);
  const emptyDimensions = {
    classification: undefined,
    quality: undefined,
    relationships: undefined,
    priority: undefined,
    pr: prDimension,
  };
  const isIssue = evidence.thread.type === "issue";
  const dimensions = isIssue
    ? { ...emptyDimensions, ...parseIssueDimensions(content) }
    : emptyDimensions;
  return { intent: "labels", ...labels, ...descriptor, dimensions };
}

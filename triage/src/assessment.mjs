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
 * stands, off-sheet refusals included, and is never re-asked. An answer the
 * provider declares truncated (`finish_reason: length`) is neither fumble
 * nor judgement (#448): an incomplete answer is failed before parsing, so
 * no prefix of it is ever parsed, published or re-asked — the same law
 * review's loop holds (#445). Parsing tolerates provider drift (the JSON5
 * parser), matching tolerates none of it — and matching is the policy
 * engine's job, not the model's and not this module's. This module turns
 * bytes into a typed judgement; it never decides what gets mutated.
 *
 * Each ask leaves its facts in a caller-owned collector (#521): what the
 * ask ended as, the HTTP status the transport saw, the request body's byte
 * length, the provider's declared finish reason — so the run record can say
 * what each of the (at most two) attempts actually saw, not just that they
 * failed.
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
 * @property {ModelAttempt[]} [attempts] the caller-owned collector the ask
 *   facts are pushed into as they are observed (#521); omitted means none
 *   are kept — the ask behaves exactly as it did before
 */

/**
 * The outcome vocabulary one assessment ask may record (#521): what the ask
 * ended as, as a code-minted word. `answered` is a content that presented
 * the JSON object; `empty`, `no-object` and `unparseable` are the shape
 * classes a fumbled answer refused with (#261); `truncated` is a provider
 * that declared its own answer cut short (#448); `unanswered` is an ask the
 * seam could not hand a completion back from — a transport break, an HTTP
 * refusal, a body that is not a chat completion — where the status beside
 * it says which layer gave up.
 *
 * @typedef {"answered" | "empty" | "no-object" | "unparseable" | "truncated" | "unanswered"} AttemptOutcome
 */

/** The outcomes an assessment ask may end in, as the record's validator holds them. */
export const ATTEMPT_OUTCOMES = Object.freeze([
  "answered",
  "empty",
  "no-object",
  "unparseable",
  "truncated",
  "unanswered",
]);

/**
 * One model ask as the run record carries it (#521) — the facts a maintainer
 * needs to tell a provider that answered empty on a large payload from an
 * outage, without re-running the job. `status` is the HTTP status the
 * transport saw, null when the request never produced a response; `bytes` is
 * the request body's byte length as the seam measured it, null when the seam
 * reported none; `finishReason` is the provider's own declaration, raw here
 * and sanitised where it enters the record. Facts of the attempt — recorded
 * once, when observed, never recomputed (I15).
 *
 * @typedef {object} ModelAttempt
 * @property {AttemptOutcome} outcome
 * @property {number | null} status
 * @property {number | null} bytes
 * @property {string} finishReason "" when the ask never produced a completion to declare one
 */

/**
 * The failure a provider-declared truncated answer is (#448), in review's
 * wording (#445) so all three actions speak one language about truncation.
 * Built outside any catch, because the caught shape error of a first answer
 * is not the cause of a later response being cut short.
 *
 * @param {string} which which response the provider cut short — `its` or `the re-asked`
 * @returns {Error}
 */
function truncationError(which) {
  return new Error(
    `the provider truncated ${which} response (finish_reason: length) — ` +
      "the model's output is incomplete and cannot be judged as a triage answer",
  );
}

/**
 * The seam's report of one call, when it made one — a shape it did not make
 * reads as "reported nothing" rather than as a fact, so a test double or a
 * seam that predates the field records the honest nulls instead of invented
 * numbers.
 *
 * @param {unknown} diagnostics
 * @returns {{ status: number | null, requestBytes: number | null }}
 */
function diagnosticsOf(diagnostics) {
  if (typeof diagnostics !== "object" || diagnostics === null) {
    return { status: null, requestBytes: null };
  }
  const report = /** @type {Record<string, unknown>} */ (diagnostics);
  const status = report["status"];
  const requestBytes = report["requestBytes"];
  return {
    status: typeof status === "number" && Number.isInteger(status) ? status : null,
    requestBytes:
      typeof requestBytes === "number" && Number.isInteger(requestBytes) ? requestBytes : null,
  };
}

/**
 * One ask of the model, with its facts pushed into the caller's collector as
 * they are observed (#521). The attempt enters the collector marked
 * `answered` or `unanswered`; the caller re-classifies its own entry when it
 * judges the content — a truncation or a shape refusal is the caller's
 * verdict on a completion this ask did hand back. Errors pass through
 * untouched: class, message and identity are the run's failure vocabulary.
 *
 * @param {object} input
 * @param {AssessmentInput["chat"]} input.chat
 * @param {string} input.model
 * @param {import("#core/chat.mjs").ChatMessage[]} input.messages
 * @param {ModelAttempt[]} input.attempts
 * @returns {Promise<{ content: string, finishReason: string | undefined, attempt: ModelAttempt }>}
 */
async function askModel({ chat, model, messages, attempts }) {
  try {
    const { content, finishReason, diagnostics } = await chat.complete({ model, messages });
    const seen = diagnosticsOf(diagnostics);
    /** @type {ModelAttempt} */
    const attempt = {
      outcome: "answered",
      status: seen.status,
      bytes: seen.requestBytes,
      finishReason: finishReason ?? "",
    };
    attempts.push(attempt);
    return { content, finishReason, attempt };
  } catch (cause) {
    // The seam attaches its report to the errors it raises or passes
    // through; a plain throw from elsewhere reports nothing, and nothing is
    // what gets recorded for it.
    const reported =
      cause instanceof Error
        ? /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (cause))["diagnostics"]
        : undefined;
    const seen = diagnosticsOf(reported);
    attempts.push({
      outcome: "unanswered",
      status: seen.status,
      bytes: seen.requestBytes,
      finishReason: "",
    });
    throw cause;
  }
}

/**
 * Makes the run's single chat call and parses the answer into an
 * `Assessment`. The prompt's shape (sheet present or not) selects which
 * answer contract the model is asked for, and the matching parser.
 *
 * @param {AssessmentInput} input
 * @returns {Promise<Assessment>}
 */
export async function assess({ evidence, documents, chat, model, evidenceWrapper, attempts = [] }) {
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
  // the shape class, never the answer's bytes. Provider-declared truncation
  // is neither fumble nor decision (#448): a response the provider cut
  // short (finish_reason: length) is an incomplete answer, and it fails the
  // run before parsing — its prefix must never become a classification, and
  // the shape-failure re-ask cannot help it, because the same ask would cut
  // the same answer again. The wording is review's (#445), so all three
  // actions speak one language about truncation.
  //
  // Every ask's facts land in the collector as they are observed (#521), so
  // a run that fails here — or one that recovers on the re-ask — leaves the
  // record able to say what each attempt saw, not just that they failed.
  const first = await askModel({ chat, model, messages, attempts });
  let { content, finishReason } = first;
  if (finishReason === "length") {
    first.attempt.outcome = "truncated";
    throw truncationError("its");
  }
  try {
    parseJsonish(content);
  } catch (cause) {
    if (!(cause instanceof AnswerShapeError)) throw cause;
    first.attempt.outcome = cause.shape;
    info(`triage: the model's answer was unusable (${cause.message}) — asking once more`);
    const second = await askModel({ chat, model, messages, attempts });
    ({ content, finishReason } = second);
    if (finishReason === "length") {
      second.attempt.outcome = "truncated";
      throw truncationError("the re-asked");
    }
    try {
      parseJsonish(content);
    } catch (retryCause) {
      if (!(retryCause instanceof AnswerShapeError)) throw retryCause;
      second.attempt.outcome = retryCause.shape;
      throw new AnswerShapeError(`${retryCause.message} (after 2 attempts)`, retryCause.shape);
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

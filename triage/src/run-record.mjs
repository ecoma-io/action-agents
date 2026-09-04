/**
 * The triage run record — the durable, byte-deterministic account of what
 * one run was asked, decided, and ended as. Triage has been log-only: its
 * decisions evaporated with the runner log, while review's artifact proved
 * what a durable record is worth. Issue #275 is this module's record: the
 * builder composes it at the run's terminal points, the validator refuses
 * any shape this module did not specify, and the serialiser's bytes are
 * stable given the run's inputs. The verification block the verification
 * design froze (issue #274) rides in the same schema — present, typed,
 * validated, and empty until that work fills it, so the schema never bumps
 * twice.
 *
 * Everything here is fail-closed: a shape this module did not specify is
 * refused, never coerced. Record fields that carry untrusted text are
 * sanitised and capped at their build sites; the validator's job is shape,
 * not repair.
 */

import { oneLine } from "#core/one-line.mjs";
import { warning } from "#core/runtime.mjs";
import { sanitiseCommentText } from "#core/sanitise.mjs";

import { RATIONALE_CHARS } from "./decision.mjs";

/** @typedef {import("#core/policy.mjs").PolicySource} PolicySource */
/** @typedef {import("./decision.mjs").Decision} Decision */

/** The triage run record's schema version. Additive changes bump it; filling `verification` (issue #274) does not. */
export const triageRecordSchemaVersion = 1;

/** The terminal reason's cap, in characters — the same width as the rationale's. */
export const REASON_CHARS = 300;

/** The cap `signalBody` sanitises a related thread's title under, carried here so the record's copy cannot drift from it. */
const RELATED_TITLE_CHARS = 80;

/**
 * The vocabulary a record's `outcome` may carry: the run contract's terminal
 * states (`docs/run-contract.md`), whole and in its own order. A word outside
 * it is a word the contract has not defined, and the validator refuses it —
 * a record is read against the contract, so a private vocabulary here would
 * read as a contract violation there.
 *
 * @typedef {"published" | "partial" | "refused" | "abandoned" | "skip" | "failed"} TriageOutcome
 */

/** The terminal states, as the validator holds them. */
export const TRIAGE_OUTCOMES = /** @type {readonly TriageOutcome[]} */ ([
  "published",
  "partial",
  "refused",
  "abandoned",
  "skip",
  "failed",
]);

/** The verdict vocabulary a verification answer may carry — frozen by issue #274. */
export const VERIFICATION_VERDICTS = /** @type {const} */ (["confirmed", "refuted", "uncertain"]);

/**
 * One verification answer: the code-minted op the verdict names, the closed
 * verdict, and the digest of the verdict's reason text — the reason itself
 * stays out of the record, its bytes checkable by whoever holds it.
 *
 * @typedef {object} VerificationAnswer
 * @property {string} opId a code-minted operation id: `add:<label>`, `remove:<label>` or `comment`
 * @property {"confirmed" | "refuted" | "uncertain"} verdict
 * @property {string} reasonDigest sha256 (lowercase hex) of the verdict's reason text
 */

/**
 * The verification block every triage record carries from this schema on.
 * Until the opt-in verification pass exists (issue #274), nothing requests
 * verification: the block is present, typed and validated, and empty —
 * filling it later is a fill, not a schema change.
 *
 * @typedef {object} VerificationBlock
 * @property {boolean} requested whether this run asked for verification
 * @property {VerificationAnswer[]} answers one per verified op, in plan order
 * @property {string[]} downgraded op ids the verification downgraded to refusals
 */

/**
 * The verification block a run records while verification does not exist
 * yet: nothing requested, nothing answered, nothing downgraded.
 *
 * @returns {VerificationBlock}
 */
export function buildVerificationBlock() {
  return { requested: false, answers: [], downgraded: [] };
}

/**
 * Whether a string is a code-minted operation id as issue #274 froze the
 * vocabulary: `add:<label>`, `remove:<label>` or the bare `comment`. The
 * label part is any non-empty text after the prefix; its sheet-membership
 * is the decision's business, not the shape's.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isOpId(value) {
  if (typeof value !== "string") return false;
  if (value === "comment") return true;
  return /^add:.+/u.test(value) || /^remove:.+/u.test(value);
}

/**
 * Whether a string is a digest as this module spells them — 64 lowercase
 * hex characters, the sha256 posture review's artifact records already use.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isReasonDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

/**
 * Fail-closed validation of a record's verification block: exactly the
 * three keys, the frozen vocabularies, no repair. A malformed block is a
 * code bug — the builder's output is what flows here — and refusing it
 * beats inventing evidence.
 *
 * @param {unknown} value
 * @returns {VerificationBlock}
 */
export function validateVerificationBlock(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("the verification block is not an object");
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(record).sort();
  const expected = ["answers", "downgraded", "requested"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(
      "the verification block carries keys other than requested/answers/downgraded",
    );
  }
  if (typeof record["requested"] !== "boolean") {
    throw new TypeError("the verification block's 'requested' is not a boolean");
  }
  if (!Array.isArray(record["answers"]) || !Array.isArray(record["downgraded"])) {
    throw new TypeError("the verification block's 'answers' and 'downgraded' must be arrays");
  }
  for (const answer of record["answers"]) {
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
      throw new TypeError("a verification answer is not an object");
    }
    const entry = /** @type {Record<string, unknown>} */ (answer);
    const answerKeys = Object.keys(entry).sort();
    const answerExpected = ["opId", "reasonDigest", "verdict"];
    if (
      answerKeys.length !== answerExpected.length ||
      answerKeys.some((key, index) => key !== answerExpected[index])
    ) {
      throw new TypeError(
        "a verification answer carries keys other than opId/verdict/reasonDigest",
      );
    }
    if (!isOpId(entry["opId"])) {
      throw new TypeError("a verification answer's opId is outside the code-minted vocabulary");
    }
    if (
      entry["verdict"] !== "confirmed" &&
      entry["verdict"] !== "refuted" &&
      entry["verdict"] !== "uncertain"
    ) {
      throw new TypeError("a verification answer's verdict is outside the closed vocabulary");
    }
    if (!isReasonDigest(entry["reasonDigest"])) {
      throw new TypeError("a verification answer's reasonDigest is not a well-formed digest");
    }
  }
  for (const opId of record["downgraded"]) {
    if (!isOpId(opId)) {
      throw new TypeError("a downgraded op id is outside the code-minted vocabulary");
    }
  }
  return /** @type {VerificationBlock} */ (value);
}

/**
 * The policy pin a record carries: the resolved policy source's identifying
 * fields, verbatim. `null` when the run ended before the source resolved —
 * a run with no pin says so rather than naming a branch it never read.
 *
 * @typedef {object} RecordPolicy
 * @property {PolicySource["basis"]} basis why this branch governs the run
 * @property {string} branch the governance branch, as the repository names it
 * @property {string} sha the immutable commit every policy read pinned to
 */

/**
 * One removal as the record carries it — the decision's own removal, whose
 * reason is the code-owned vocabulary (`size`, `marker`, `owned`) that says
 * which deterministic rule removed the label.
 *
 * @typedef {object} RecordRemoval
 * @property {string} name
 * @property {string} reason
 */

/**
 * The record's copy of a code-composed signal — what the signal comment was
 * built from, never its body. The related thread's title is untrusted and is
 * sanitised at the build site, the way `signalBody` sanitises it.
 *
 * @typedef {object} RecordSignal
 * @property {string[]} needsMoreInfo the deterministic missing-required fields, when judged incomplete
 * @property {boolean} modelJudgedQuality true when the incomplete judgement was the model's
 * @property {{ number: number, type: string, title: string } | null} related the best relationship candidate, sanitised title and all
 */

/**
 * The decision a run reached, reduced to its facts: the plan's kind, its
 * label adds and reasoned removals, the off-sheet refusals, the sanitised
 * capped rationale, and the signal when one was composed. The executor's log
 * lines and the comment body stay out — the log lines are the run log's, and
 * the comment itself is the durable form of that path.
 *
 * @typedef {object} RecordDecision
 * @property {"labels" | "comment"} kind
 * @property {string[]} add
 * @property {RecordRemoval[]} remove
 * @property {string[]} refusals
 * @property {string} rationale
 * @property {RecordSignal | null} signal
 */

/**
 * The record one run leaves behind, built from the facts the run holds when
 * it reaches a terminal point. Every field is a fact the code already
 * computed — and nothing reads the clock, so the same run facts build the
 * same bytes. Untrusted text is sanitised here, at the build site: the
 * rationale is model text and gets the comment sanitiser's full pass, the
 * related title gets the treatment `signalBody` gives it, and the terminal
 * reason is whatever the path said, flattened and capped.
 *
 * The builder validates before returning: a record that cannot validate is a
 * code bug, and it fails here rather than at the write.
 *
 * @param {object} input
 * @param {string} input.repository "owner/repo", as the runner named it
 * @param {string} input.eventName the `GITHUB_EVENT_NAME`
 * @param {string} input.eventAction the payload's `action`; "" when the payload carried none
 * @param {"issue" | "pr" | null} input.threadType the thread's type; null when the run ended before the payload was parsed
 * @param {number | null} input.threadNumber the thread's number, null under the same condition
 * @param {boolean} input.dryRun
 * @param {string} input.model the model id the run asked
 * @param {PolicySource | null} input.policy the resolved policy source; null when the run ended before it resolved
 * @param {Decision | null} input.decision the pipeline's decision; null when the run ended before `decide()`
 * @param {TriageOutcome} input.outcome the terminal state, in the run contract's vocabulary
 * @param {string} input.reason the terminal path's own sentence
 * @param {VerificationBlock} [input.verification] the verification block; the empty block when omitted
 * @returns {TriageRecord}
 */
export function buildTriageRecord({
  repository,
  eventName,
  eventAction,
  threadType,
  threadNumber,
  dryRun,
  model,
  policy,
  decision,
  outcome,
  reason,
  verification = buildVerificationBlock(),
}) {
  /** @type {Record<string, unknown>} */
  const record = {
    schemaVersion: triageRecordSchemaVersion,
    repository,
    event: { eventName, action: eventAction },
    // A thread this run never parsed is the honest `null`, not a guessed one;
    // the same is true of a policy pin the run never resolved.
    thread: threadType === null ? null : { type: threadType, number: threadNumber },
    dryRun,
    model,
    policy:
      policy === null ? null : { basis: policy.basis, branch: policy.branch, sha: policy.sha },
    outcome,
    reason: cappedLine(reason, REASON_CHARS),
    verification: validateVerificationBlock(verification),
  };
  // `decision` is present iff the run reached one — the key's absence is the
  // record saying so.
  if (decision !== null) {
    record["decision"] = decisionSection(decision);
  }
  return deepFreeze(validateTriageRecord(record));
}

/**
 * The record's decision section. `logs` stays out because it is the
 * executor's copy of what the run log says, not a fact about the decision;
 * `comment` stays out because the marker comment on the thread IS that
 * path's durable form.
 *
 * @param {Decision} decision
 * @returns {RecordDecision}
 */
function decisionSection(decision) {
  const signal = decision.signal ?? null;
  return {
    kind: decision.kind,
    add: [...decision.add],
    remove: decision.remove.map((removal) => ({ name: removal.name, reason: removal.reason })),
    refusals: [...decision.refusals],
    rationale: cappedLine(decision.rationale, RATIONALE_CHARS),
    signal:
      signal === null
        ? null
        : {
            needsMoreInfo: [...signal.needsMoreInfo],
            modelJudgedQuality: signal.modelJudgedQuality,
            related:
              signal.related === null
                ? null
                : {
                    number: signal.related.number,
                    type: signal.related.type,
                    title: cappedLine(signal.related.title, RELATED_TITLE_CHARS),
                  },
          },
  };
}

/**
 * One sanitiser pass at a build site: flattened to one line, structural
 * tokens removed, mentions broken, capped visibly. The notes are logged the
 * way the comment builders log theirs — the record's bytes stay clean, and
 * the run log carries what the sanitiser bit off.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function cappedLine(text, maxChars) {
  const result = sanitiseCommentText(oneLine(text), { maxChars });
  for (const note of result.notes) {
    warning(`sanitiser: ${note}`);
  }
  return result.text;
}

/** The keys a record serialises with; `decision` is the one a record may omit. */
const RECORD_KEYS = new Set([
  "schemaVersion",
  "repository",
  "event",
  "thread",
  "dryRun",
  "model",
  "policy",
  "decision",
  "outcome",
  "reason",
  "verification",
]);
const RECORD_MANDATORY_KEYS = new Set([...RECORD_KEYS].filter((key) => key !== "decision"));
const EVENT_KEYS = new Set(["eventName", "action"]);
const THREAD_KEYS = new Set(["type", "number"]);
const POLICY_KEYS = new Set(["basis", "branch", "sha"]);
const DECISION_KEYS = new Set(["kind", "add", "remove", "refusals", "rationale", "signal"]);
const SIGNAL_KEYS = new Set(["needsMoreInfo", "modelJudgedQuality", "related"]);
const RELATED_KEYS = new Set(["number", "type", "title"]);
const REMOVAL_KEYS = new Set(["name", "reason"]);

/** A commit sha is exactly 40 hex characters; anything else is not a pin. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Fail-closed validation of a triage record: exactly the keys this module
 * spells, the run contract's outcome vocabulary, the decision's own shape
 * without its executor fields, and nothing over a documented cap. A
 * malformed record is a code bug — the builder's output is what flows here —
 * and refusing it beats inventing evidence. A missing `decision` is legal:
 * a run that ends before `decide()` has none, and the record says so by the
 * key's absence.
 *
 * @param {unknown} value
 * @returns {TriageRecord}
 */
export function validateTriageRecord(value) {
  const record = asRecord(value, "the triage record");
  assertExactKeys(record, "the triage record", RECORD_KEYS, RECORD_MANDATORY_KEYS);
  if (record["schemaVersion"] !== triageRecordSchemaVersion) {
    throw new TypeError(
      `the triage record's schemaVersion is not ${String(triageRecordSchemaVersion)}`,
    );
  }
  asNonEmptyString(record["repository"], "the triage record's 'repository'");
  asEvent(record["event"]);
  asThread(record["thread"]);
  if (typeof record["dryRun"] !== "boolean") {
    throw new TypeError("the triage record's 'dryRun' is not a boolean");
  }
  asNonEmptyString(record["model"], "the triage record's 'model'");
  asPolicy(record["policy"]);
  if (record["decision"] !== undefined) {
    asDecision(record["decision"]);
  }
  asOutcome(record["outcome"]);
  asBoundedString(record["reason"], "the triage record's 'reason'", REASON_CHARS);
  validateVerificationBlock(record["verification"]);
  return /** @type {TriageRecord} */ (value);
}

/**
 * The event a record names. An empty `action` is a fact, not a defect:
 * payloads without an action exist, and the event matrix re-triages them by
 * name.
 *
 * @param {unknown} value
 * @returns {void}
 */
function asEvent(value) {
  const event = asRecord(value, "the triage record's 'event'");
  assertExactKeys(event, "the triage record's 'event'", EVENT_KEYS);
  asNonEmptyString(event["eventName"], "the triage record's 'event.eventName'");
  if (typeof event["action"] !== "string") {
    throw new TypeError("the triage record's 'event.action' is not a string");
  }
}

/**
 * A thread is the parsed subject, or the honest `null`; a partial one — a
 * type without a number, a type the action does not run on — is refused
 * rather than coerced.
 *
 * @param {unknown} value
 * @returns {void}
 */
function asThread(value) {
  if (value === null) return;
  const thread = asRecord(value, "the triage record's 'thread'");
  assertExactKeys(thread, "the triage record's 'thread'", THREAD_KEYS);
  if (thread["type"] !== "issue" && thread["type"] !== "pr") {
    throw new TypeError("the triage record's 'thread.type' is neither 'issue' nor 'pr'");
  }
  if (
    typeof thread["number"] !== "number" ||
    !Number.isInteger(thread["number"]) ||
    thread["number"] <= 0
  ) {
    throw new TypeError("the triage record's 'thread.number' is not a positive integer");
  }
}

/**
 * The policy pin, or the honest `null`. The basis is checked for shape
 * rather than against `#core/policy.mjs`'s own vocabulary: the record's
 * business is the pin, and the sha is what makes it checkable — the basis is
 * why, spelled by the module that owns it.
 *
 * @param {unknown} value
 * @returns {void}
 */
function asPolicy(value) {
  if (value === null) return;
  const policy = asRecord(value, "the triage record's 'policy'");
  assertExactKeys(policy, "the triage record's 'policy'", POLICY_KEYS);
  asNonEmptyString(policy["basis"], "the triage record's 'policy.basis'");
  asNonEmptyString(policy["branch"], "the triage record's 'policy.branch'");
  if (typeof policy["sha"] !== "string" || !SHA_PATTERN.test(policy["sha"])) {
    throw new TypeError("the triage record's 'policy.sha' is not a 40-hex commit sha");
  }
}

/**
 * @param {unknown} value
 * @returns {void}
 */
function asDecision(value) {
  const decision = asRecord(value, "the triage record's 'decision'");
  assertExactKeys(decision, "the triage record's 'decision'", DECISION_KEYS);
  if (decision["kind"] !== "labels" && decision["kind"] !== "comment") {
    throw new TypeError("the triage record's 'decision.kind' is neither 'labels' nor 'comment'");
  }
  asStringList(decision["add"], "the triage record's 'decision.add'");
  const remove = asArray(decision["remove"], "the triage record's 'decision.remove'");
  for (const entry of remove) {
    const removal = asRecord(entry, "a decision removal");
    assertExactKeys(removal, "a decision removal", REMOVAL_KEYS);
    asNonEmptyString(removal["name"], "a decision removal's 'name'");
    asNonEmptyString(removal["reason"], "a decision removal's 'reason'");
  }
  asStringList(decision["refusals"], "the triage record's 'decision.refusals'");
  asBoundedString(
    decision["rationale"],
    "the triage record's 'decision.rationale'",
    RATIONALE_CHARS,
  );
  asSignal(decision["signal"]);
}

/**
 * @param {unknown} value
 * @returns {void}
 */
function asSignal(value) {
  if (value === null) return;
  const signal = asRecord(value, "the triage record's 'decision.signal'");
  assertExactKeys(signal, "the triage record's 'decision.signal'", SIGNAL_KEYS);
  asStringList(signal["needsMoreInfo"], "the triage record's 'decision.signal.needsMoreInfo'");
  if (typeof signal["modelJudgedQuality"] !== "boolean") {
    throw new TypeError(
      "the triage record's 'decision.signal.modelJudgedQuality' is not a boolean",
    );
  }
  if (signal["related"] === null) return;
  const related = asRecord(signal["related"], "the triage record's 'decision.signal.related'");
  assertExactKeys(related, "the triage record's 'decision.signal.related'", RELATED_KEYS);
  if (
    typeof related["number"] !== "number" ||
    !Number.isInteger(related["number"]) ||
    related["number"] <= 0
  ) {
    throw new TypeError(
      "the triage record's 'decision.signal.related.number' is not a positive integer",
    );
  }
  asNonEmptyString(related["type"], "the triage record's 'decision.signal.related.type'");
  asBoundedString(
    related["title"],
    "the triage record's 'decision.signal.related.title'",
    RELATED_TITLE_CHARS,
  );
}

/**
 * @param {unknown} value
 * @returns {void}
 */
function asOutcome(value) {
  for (const candidate of TRIAGE_OUTCOMES) {
    if (candidate === value) return;
  }
  throw new TypeError(
    "the triage record's 'outcome' is outside the run contract's terminal states",
  );
}

/**
 * The name a run record is written under. A thread's records overwrite in
 * place — one file per thread, the newest run's account — and a run that
 * ended before the payload was parsed names the event instead. Both names
 * sit inside the upload glob `triage-record-*.json`, and the event name is
 * flattened to filename-safe characters: it is runner-set environment on its
 * way into a path, and a path this module composes stays inside the
 * directory the writer has already confined.
 *
 * @param {TriageRecord} record
 * @returns {string}
 */
export function triageRecordFilename(record) {
  if (record.thread !== null) {
    return `triage-record-${record.thread.type}-${String(record.thread.number)}.json`;
  }
  const safe = (typeof record.event.eventName === "string" ? record.event.eventName : "").replace(
    /[^A-Za-z0-9._-]+/gu,
    "-",
  );
  return `triage-record-${safe === "" ? "unknown" : safe}.json`;
}

/**
 * Serialises a triage record to a stable JSON string: keys sorted, no
 * whitespace, no trailing newline — the determinism posture review's
 * `serialiseArtifact` keeps, so the bytes are identical however the object
 * was assembled. The record is validated first: a shape this module did not
 * build is refused, not mis-serialised.
 *
 * @param {TriageRecord} record
 * @returns {string}
 */
export function serialiseTriageRecord(record) {
  validateTriageRecord(record);
  return stableStringify(record);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === undefined) {
    throw new TypeError("refuse to serialise an undefined value");
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("refuse to serialise a non-data value");
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    const elements = /** @type {unknown[]} */ (value);
    return `[${elements.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(object).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const element of /** @type {unknown[]} */ (value)) {
      deepFreeze(element);
    }
    Object.freeze(value);
  } else if (value !== null && typeof value === "object") {
    for (const nested of Object.values(/** @type {Record<string, unknown>} */ (value))) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function asRecord(v, label) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError(`${label} is not an object`);
  }
  return /** @type {Record<string, unknown>} */ (v);
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {unknown[]}
 */
function asArray(v, label) {
  if (!Array.isArray(v)) {
    throw new TypeError(`${label} is not an array`);
  }
  return v;
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {string}
 */
function asNonEmptyString(v, label) {
  if (typeof v !== "string" || v.length === 0) {
    throw new TypeError(`${label} is not a non-empty string`);
  }
  return v;
}

/**
 * @param {unknown} v
 * @param {string} label
 * @param {number} max
 * @returns {string}
 */
function asBoundedString(v, label, max) {
  if (typeof v !== "string") {
    throw new TypeError(`${label} is not a string`);
  }
  if (v.length > max) {
    throw new TypeError(`${label} exceeds its ${String(max)}-character cap`);
  }
  return v;
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {string[]}
 */
function asStringList(v, label) {
  const arr = asArray(v, label);
  for (const entry of arr) {
    if (typeof entry !== "string") {
      throw new TypeError(`${label} carries an entry that is not a string`);
    }
  }
  return /** @type {string[]} */ (arr);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} label
 * @param {ReadonlySet<string>} allowed
 * @param {ReadonlySet<string>} [mandatory]
 * @returns {void}
 */
function assertExactKeys(obj, label, allowed, mandatory = allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} carries an unknown key '${key}'`);
    }
  }
  for (const key of mandatory) {
    if (!(key in obj)) {
      throw new TypeError(`${label} is missing '${key}'`);
    }
  }
}

/**
 * The record one run leaves behind — the exact key set this module builds,
 * validates and serialises, in the documented field order: `schemaVersion`,
 * `repository`, `event`, `thread`, `dryRun`, `model`, `policy`, `decision`,
 * `outcome`, `reason`, `verification`. `decision` is the one key a record
 * may omit.
 *
 * @typedef {object} TriageRecord
 * @property {typeof triageRecordSchemaVersion} schemaVersion
 * @property {string} repository "owner/repo", as the runner named it
 * @property {{ eventName: string, action: string }} event
 * @property {{ type: "issue" | "pr", number: number } | null} thread null when the run ended before the payload was parsed
 * @property {boolean} dryRun
 * @property {string} model
 * @property {RecordPolicy | null} policy null when the run ended before the policy source resolved
 * @property {RecordDecision} [decision] present iff the run reached a decision
 * @property {TriageOutcome} outcome a terminal state, as the run contract spells it
 * @property {string} reason the terminal path's own sentence, one line and capped
 * @property {VerificationBlock} verification
 */

/**
 * `pnpm eval` — the offline evaluator (issue #278, wave W5): replay a
 * recorded corpus through the real action modules and print the frozen
 * metric table. Deterministic, repo-local, offline.
 *
 * WHAT IT DOES
 *
 * It walks `evaluation/corpus/<entry>/` and replays every entry through the
 * real action modules — `triage/src/index.mjs`'s `run`,
 * `review/src/index.mjs`'s `run` and `harmonise/src/index.mjs`'s `run` —
 * fed from the recorded snapshot: a forge
 * double that serves exactly the reads the snapshot recorded (and raises a
 * `CorpusDefect` the moment a run reaches for anything else), a chat double
 * that serves the recorded answers in ask order (a run that asks for more
 * than the recording holds — or stops before it is spent — is a
 * `CorpusDefect`), and a workspace built in a temporary directory from the
 * snapshot's recorded head files. There is no network anywhere: the doubles
 * are the only provider, and the evaluator replaces `globalThis.fetch` with
 * a throwing stub for the duration of a replay, so a run that reaches
 * outside the recording fails loudly instead of quietly.
 *
 * Fail-closed in both directions. A snapshot, an answer file or an
 * `expected.json` that does not match its declared shape is a `CorpusDefect`
 * (exit 1), never a silent zero — and so are a replay that throws, a record
 * that fails its own module's validator, and a review finding carrying a
 * verdict that `expected.json` holds no expected verdict for.
 *
 * THE METRICS — the split issue #278 froze, in its own wording
 *
 * Offline-computable (this table):
 *
 *  - triage `refusal-rate` — "runs with >= 1 refusal entry / model-answered
 *    runs" (source: the triage run record — `decision.refusals` plus
 *    `verification.downgraded`; informs ceiling calibration). Threshold:
 *    reported unbounded — a ceiling posture is a dial, not a defect; the
 *    number exists so a change that moves it is visible.
 *  - review `verifier-agreement` — "confirmed / (confirmed + refuted +
 *    uncertain; unresolved stays in the denominator)" (source: the verdicts
 *    on the artifact's findings — the verification pass's durable half;
 *    informs strictness defaults and lane tuning). Threshold: >= 0.5
 *    initially.
 *  - review `anchoring-integrity` — "findings whose anchor re-derives
 *    against the pinned head / findings" (source: the read-ledger digests
 *    the artifact carries, re-derived here from the snapshot's recorded head
 *    bytes — re-derive, never trust; informs provenance-gate strictness).
 *    Threshold: exactly 1.0 — a re-derivation failure is a defect, not a
 *    calibration matter, and is reported as a corpus defect.
 *  - review `precision` — true positives / (true positives + false
 *    positives) against `expected.json`; `false-positive-rate` — false
 *    positives / (false positives + the distractor anchors `expected.json`
 *    marks `valid: false` that stayed unreported); `severity-agreement` —
 *    true positives whose severity matches the expected severity / true
 *    positives; `verification-accuracy` — produced verdicts matching the
 *    expected verdict / produced verdicts (source: corpus + artifact).
 *    Thresholds: >= 0.5 each, initially.
 *  - `mutation-surface` — "total write ops per run by kind" (source: the
 *    writes the replay doubles recorded; drift watch — growth is a design
 *    smell, auto-reported). No threshold: absolute counts, printed so growth
 *    is visible. The harmonise replays join this table with the Git Data
 *    write ops one publication is made of.
 *  - harmonise `validation-refusal-rate` — "runs the deterministic
 *    validation refused / harmonise runs replayed" (source: the replay's
 *    terminal state — a run the real validators declined: the config-absent
 *    refusal, the manual-edit and frontmatter protection refusals, or the
 *    answer contract's tagged validation failures ending the run; informs
 *    validation strictness calibration). Threshold: reported unbounded —
 *    the same dial posture as triage refusal-rate. Harmonise has NO offline
 *    model-quality metric: translation quality is not judgeable without a
 *    reference translation, so apply-clean-rate stays production-deferred
 *    (U-8, below).
 *  - `archkeep violation rate` — NOT computed here: the arch gate itself is
 *    its enforcement. Run `pnpm arch`; CI already does.
 *
 * Every initial threshold is deliberately loose — the corpus is the seed,
 * and thresholds earn strictness with calibration history (issue #278).
 * Tightening one is a reviewed change to `THRESHOLDS` below, never a silent
 * drift.
 *
 * DEFINED BUT PRODUCTION-DEFERRED (U-8) — never silently absent:
 *
 *  - triage `sheet-accuracy` — decisions surviving 30 days without human
 *    revert / applied decisions: needs production observation time and actor
 *    attribution the label timeline cannot always give (triage's own
 *    removals vs a human's); waits for U-8 to name a collection path.
 *  - harmonise `apply-clean-rate` — PRs merged without manual fix / PRs
 *    opened: needs production merge outcomes; this corpus holds none.
 *
 * NOT APPLICABLE OR CAVEATED — marked as such, never silently:
 *
 *  - duplicate-detection precision/recall — no offline ground truth exists;
 *    the relationship signal is advisory text, not a dedupe behaviour.
 *  - routing accuracy — triage has no routing concept; a metric over a
 *    behaviour that does not exist is N/A, not zero.
 *  - finding recall — computable only against the synthetic corpus itself;
 *    its ceiling is the corpus, so the number would read as a quality
 *    measure while measuring the fixture. `docs/evaluation.md` (PR-11)
 *    states that caveat.
 *
 * THE PIN
 *
 * Triage's only frozen offline metric is refusal-rate, so the corpus pins
 * the rest of a triage replay by expectation: an outcome, a label
 * operation, a refusal name or a verification downgrade that diverges from
 * `expected.json` is a corpus defect (exit 1), exactly like a shape
 * violation. Review runs the same pin on the terminal outcome alone — a
 * premise divergence is a defect — and scores findings and verdicts through
 * the metrics instead: a finding-set change moves the numbers and is judged
 * by the thresholds, not by the pin.
 *
 * DETERMINISM
 *
 * Same corpus and same code, same printed bytes: the clock is fixed, the
 * evidence wrapper's delimiter generator is fixed, the report is the only
 * output, and nothing reads the wall clock, the hostname or the
 * environment.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { fileURLToPath } from "node:url";

import { createEvidence } from "#core/untrusted.mjs";
import { isProgramEntry } from "#core/runtime.mjs";

import { run as runTriage } from "../triage/src/index.mjs";
import { validateTriageRecord } from "../triage/src/run-record.mjs";
import { run as runReview } from "../review/src/index.mjs";
import { serialiseArtifact } from "../review/src/artifact.mjs";
import { contentDigest } from "../review/src/digest.mjs";
import { normaliseReadPath } from "../review/src/coverage.mjs";

import { run as runHarmonise } from "../harmonise/src/index.mjs";

/** The repository the corpus describes, as the replay's forge context names it. */
const OWNER = "ecoma-io";
const REPO_NAME = "action-agents";

/** The fixed instant every replay's clock reads. */
const FIXED_NOW = 1_756_800_000_000;

/** The fixed evidence delimiter every replay's wrapper carries. */
const EVIDENCE_ID = "aaaabbbb";

/** The corpus floor the seed promises (issue #278): fewer entries is a broken corpus. */
const MIN_TRIAGE_ENTRIES = 4;
const MIN_REVIEW_ENTRIES = 3;
const MIN_HARMONISE_ENTRIES = 2;

/**
 * The initial thresholds, named so a change to one is a change to this
 * table. Loose on purpose — see the header comment.
 */
export const THRESHOLDS = Object.freeze({
  minPrecision: 0.5,
  maxFalsePositiveRate: 0.5,
  minSeverityAgreement: 0.5,
  minVerifierAgreement: 0.5,
  minVerificationAccuracy: 0.5,
  anchoringIntegrity: 1.0,
});

/**
 * The typed loud failure: every shape deviation, unrecorded read, missing
 * answer and pin divergence the evaluator can raise is one of these, and a
 * run of the evaluator exits 1 when any was raised.
 */
export class CorpusDefect extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "CorpusDefect";
  }
}

// ── Fail-closed corpus validation ───────────────────────────────────────
// Every key set below is closed: a snapshot the evaluator did not specify is
// a broken corpus, not data to repair around.

/** @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Record<string, unknown>}
 */
function asRecord(value, where) {
  if (!isRecord(value)) {
    throw new CorpusDefect(`${where} is not a JSON object`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {string}
 */
function asText(value, where) {
  if (typeof value !== "string" || value === "") {
    throw new CorpusDefect(`${where} is not a non-empty string`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {string[]}
 */
function asTextList(value, where) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new CorpusDefect(`${where} is not an array of strings`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {number}
 */
function asLine(value, where) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new CorpusDefect(`${where} is not a positive integer line`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} expected the allowed key set, sorted
 * @param {string} where
 * @param {readonly string[]} [optional] keys allowed but not required
 * @returns {void}
 */
function assertKeys(value, expected, where, optional = []) {
  const keys = Object.keys(value).sort();
  const unknown = keys.filter((key) => !expected.includes(key) && !optional.includes(key));
  if (unknown.length > 0) {
    throw new CorpusDefect(`${where} carries unknown key(s) ${unknown.join(", ")}`);
  }
  const missing = expected.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new CorpusDefect(`${where} is missing key(s) ${missing.join(", ")}`);
  }
}

/** The reads a recorded world may serve — exactly the forge slice the actions make. */
const WORLD_READS = Object.freeze([
  "getRepository",
  "getIssue",
  "getPullRequest",
  "getRef",
  "listComments",
  "listPullRequestFiles",
  "listRepositoryLabelsDetailed",
  "listTree",
  "searchIssues",
  "whoami",
]);

/** Policy reads never come from the world: `policy.files` is their record. */
const TRIAGE_SNAPSHOT_KEYS = Object.freeze([
  "event",
  "inputs",
  "kind",
  "model",
  "policy",
  "repository",
  "schemaVersion",
  "thread",
  "world",
]);
const REVIEW_SNAPSHOT_KEYS = Object.freeze([...TRIAGE_SNAPSHOT_KEYS, "headFiles"]);
const HARMONISE_SNAPSHOT_KEYS = Object.freeze([
  "event",
  "files",
  "inputs",
  "kind",
  "model",
  "repository",
  "schemaVersion",
  "world",
]);

/**
 * Validates one snapshot against the corpus contract. Policy files, head
 * files and the recorded world are checked structurally here; a read the
 * run makes that the snapshot does not record surfaces later, at the forge
 * double, as a `CorpusDefect` naming the read.
 *
 * @param {unknown} snapshot
 * @param {string} entryName
 * @returns {Record<string, unknown>} the same snapshot, typed
 */
export function validateSnapshot(snapshot, entryName) {
  const where = `snapshot ${entryName}`;
  const record = asRecord(snapshot, where);
  const kind = asText(record["kind"], `${where}.kind`);
  assertKeys(
    record,
    kind === "triage"
      ? TRIAGE_SNAPSHOT_KEYS
      : kind === "harmonise"
        ? HARMONISE_SNAPSHOT_KEYS
        : REVIEW_SNAPSHOT_KEYS,
    where,
  );
  if (record["schemaVersion"] !== 1) {
    throw new CorpusDefect(`${where}.schemaVersion is not 1`);
  }
  asText(record["repository"], `${where}.repository`);
  const model = asText(record["model"], `${where}.model`);
  if (model !== "<recorded>") {
    throw new CorpusDefect(
      `${where}.model must be the placeholder "<recorded>" — the evaluator never calls a provider`,
    );
  }

  const event = asRecord(record["event"], `${where}.event`);
  assertKeys(event, ["action", "name", "payload"], `${where}.event`);
  asText(event["name"], `${where}.event.name`);
  // A workflow_dispatch event carries no action word; a harmonise snapshot
  // records that as the empty string, and only a non-string is a defect.
  if (kind === "harmonise") {
    if (typeof event["action"] !== "string") {
      throw new CorpusDefect(`${where}.event.action is not a string`);
    }
  } else {
    asText(event["action"], `${where}.event.action`);
  }
  asRecord(event["payload"], `${where}.event.payload`);

  if (kind !== "harmonise") {
    const thread = asRecord(record["thread"], `${where}.thread`);
    assertKeys(thread, ["body", "labels", "number", "title", "type"], `${where}.thread`);
    const type = asText(thread["type"], `${where}.thread.type`);
    if (type !== "issue" && type !== "pr") {
      throw new CorpusDefect(`${where}.thread.type is neither "issue" nor "pr"`);
    }
    asLine(thread["number"], `${where}.thread.number`);
    asText(thread["title"], `${where}.thread.title`);
    if (typeof thread["body"] !== "string") {
      throw new CorpusDefect(`${where}.thread.body is not a string`);
    }
    asTextList(thread["labels"], `${where}.thread.labels`);
  }

  const inputs = asRecord(record["inputs"], `${where}.inputs`);
  if (kind === "triage") {
    assertKeys(inputs, ["dryRun", "labels", "verify"], `${where}.inputs`);
    if (inputs["verify"] !== true && inputs["verify"] !== false) {
      throw new CorpusDefect(`${where}.inputs.verify is not a boolean`);
    }
    asTextList(inputs["labels"], `${where}.inputs.labels`);
  } else if (kind === "harmonise") {
    assertKeys(inputs, ["configPath", "documents", "dryRun", "sourceLanguage"], `${where}.inputs`);
    const harmoniseConfigPath = inputs["configPath"];
    if (typeof harmoniseConfigPath !== "string" || harmoniseConfigPath !== "") {
      throw new CorpusDefect(
        `${where}.inputs.configPath must be "" — a named config file must be recorded in files at its default location`,
      );
    }
    if (!Array.isArray(inputs["documents"])) {
      throw new CorpusDefect(`${where}.inputs.documents is not an array of globs`);
    }
    const sourceLanguage = inputs["sourceLanguage"];
    if (typeof sourceLanguage !== "string" || sourceLanguage === "") {
      throw new CorpusDefect(`${where}.inputs.sourceLanguage is not a non-empty string`);
    }
  } else {
    assertKeys(inputs, ["configPath", "contextWindow", "dryRun", "maxTurns"], `${where}.inputs`);
    const configPath = inputs["configPath"];
    if (typeof configPath !== "string" || configPath !== "") {
      throw new CorpusDefect(
        `${where}.inputs.configPath must be "" — a named config file must be recorded in policy.files at its default location`,
      );
    }
    if (typeof inputs["maxTurns"] !== "number" || inputs["maxTurns"] < 1) {
      throw new CorpusDefect(`${where}.inputs.maxTurns is not a positive number`);
    }
    if (typeof inputs["contextWindow"] !== "number" || inputs["contextWindow"] < 1) {
      throw new CorpusDefect(`${where}.inputs.contextWindow is not a positive number`);
    }
  }
  // The corpus exists to replay real runs: a dry-run snapshot would replay a
  // run that writes nothing, which is not the run the metrics measure.
  if (inputs["dryRun"] !== false) {
    throw new CorpusDefect(`${where}.inputs.dryRun must be false — the corpus records real runs`);
  }

  if (kind !== "harmonise") {
    const policy = asRecord(record["policy"], `${where}.policy`);
    assertKeys(policy, ["files"], `${where}.policy`);
    const files = asRecord(policy["files"], `${where}.policy.files`);
    for (const [path, content] of Object.entries(files)) {
      if (content !== null && typeof content !== "string") {
        throw new CorpusDefect(
          `${where}.policy.files['${path}'] is neither file content nor the recorded absence null`,
        );
      }
    }
  }

  const world = asRecord(record["world"], `${where}.world`);
  for (const [member, value] of Object.entries(world)) {
    if (!WORLD_READS.includes(member)) {
      throw new CorpusDefect(
        `${where}.world carries '${member}', outside the forge slice the actions make`,
      );
    }
    if (member === "getRef") {
      const refs = asRecord(value, `${where}.world.getRef`);
      for (const [branch, sha] of Object.entries(refs)) {
        if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
          throw new CorpusDefect(`${where}.world.getRef['${branch}'] is not a 40-hex commit sha`);
        }
      }
    } else if (!isRecord(value) && !Array.isArray(value)) {
      throw new CorpusDefect(`${where}.world.${member} is neither an object nor an array`);
    }
  }

  if (kind === "harmonise") {
    const snapshotFiles = asRecord(record["files"], `${where}.files`);
    const refValues = Object.values(/** @type {Record<string, string>} */ (world["getRef"]));
    for (const [sha, paths] of Object.entries(snapshotFiles)) {
      if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha) || !refValues.includes(sha)) {
        throw new CorpusDefect(
          `${where}.files key '${sha}' is not a 40-hex sha the snapshot's world.getRef declares`,
        );
      }
      const pathMap = asRecord(paths, `${where}.files['${sha}']`);
      for (const [filePath, content] of Object.entries(pathMap)) {
        if (content !== null && typeof content !== "string") {
          throw new CorpusDefect(
            `${where}.files['${sha}']['${filePath}'] is neither file content nor the recorded absence null`,
          );
        }
      }
    }
  }

  if (kind === "review") {
    const headFiles = asRecord(record["headFiles"], `${where}.headFiles`);
    for (const [path, content] of Object.entries(headFiles)) {
      if (typeof content !== "string") {
        throw new CorpusDefect(
          `${where}.headFiles['${path}'] is not the file's recorded head content`,
        );
      }
    }
  }
  return record;
}

const VERDICTS = Object.freeze(["confirmed", "refuted", "uncertain"]);
const SEVERITIES = Object.freeze(["concern", "nit"]);
const ANCHOR_PATTERN = /^[^\s/]+\/[^\s/]+:\d+$/;

/**
 * Validates one `expected.json`. The triage expectation doubles as the run
 * pin (see `pinTriage`); the review expectation only seeds the scoring
 * metrics, and the review pin is the terminal outcome alone.
 *
 * @param {unknown} expected
 * @param {string} entryName
 * @param {"triage" | "review" | "harmonise"} kind
 * @returns {Record<string, unknown>}
 */
export function validateExpected(expected, entryName, kind) {
  const where = `expected ${entryName}`;
  const record = asRecord(expected, where);
  if (kind === "triage") {
    assertKeys(
      record,
      ["adds", "commentExpected", "outcome", "refusals", "removes", "signalExpected"],
      where,
      ["verification"],
    );
    if ("verification" in record && !isRecord(record["verification"])) {
      throw new CorpusDefect(`${where}.verification is not an object`);
    }
    const outcome = asText(record["outcome"], `${where}.outcome`);
    if (!["published", "refused", "skip", "partial", "abandoned", "failed"].includes(outcome)) {
      throw new CorpusDefect(`${where}.outcome is not a triage terminal state`);
    }
    asTextList(record["adds"], `${where}.adds`);
    asTextList(record["removes"], `${where}.removes`);
    asTextList(record["refusals"], `${where}.refusals`);
    if (record["commentExpected"] !== true && record["commentExpected"] !== false) {
      throw new CorpusDefect(`${where}.commentExpected is not a boolean`);
    }
    if (record["signalExpected"] !== true && record["signalExpected"] !== false) {
      throw new CorpusDefect(`${where}.signalExpected is not a boolean`);
    }
  } else if (kind === "harmonise") {
    assertKeys(record, ["outcome", "writes"], where, ["refusal"]);
    const outcome = asText(record["outcome"], `${where}.outcome`);
    if (!["published", "partial", "refused", "failed"].includes(outcome)) {
      throw new CorpusDefect(`${where}.outcome is not a harmonise terminal state`);
    }
    if (!Array.isArray(record["writes"])) {
      throw new CorpusDefect(`${where}.writes is not an array of op names`);
    }
    for (const op of record["writes"]) {
      if (typeof op !== "string") {
        throw new CorpusDefect(`${where}.writes entries must be strings`);
      }
    }
    if (outcome === "refused" && !("refusal" in record)) {
      throw new CorpusDefect(`${where}.refused outcome must carry a refusal reason`);
    }
    if ("refusal" in record && typeof record["refusal"] !== "string") {
      throw new CorpusDefect(`${where}.refusal is not a string`);
    }
  } else {
    assertKeys(record, ["findings", "outcome", "verdicts"], where);
    const outcome = asText(record["outcome"], `${where}.outcome`);
    if (
      ![
        "skip",
        "nothing-to-review",
        "published",
        "published-without-artifact",
        "dry-run",
        "abandoned",
      ].includes(outcome)
    ) {
      throw new CorpusDefect(`${where}.outcome is not a review terminal state`);
    }
    if (!Array.isArray(record["findings"])) {
      throw new CorpusDefect(`${where}.findings is not an array`);
    }
    for (const finding of record["findings"]) {
      const entry = asRecord(finding, `${where}.findings[]`);
      const keys = Object.keys(entry).sort();
      const unknown = keys.filter(
        (key) => !["file", "line", "note", "severity", "valid"].includes(key),
      );
      const missing = ["file", "line", "severity", "valid"].filter((key) => !(key in entry));
      if (unknown.length > 0) {
        throw new CorpusDefect(`${where}.findings[] carries unknown key(s) ${unknown.join(", ")}`);
      }
      if (missing.length > 0) {
        throw new CorpusDefect(`${where}.findings[] is missing key(s) ${missing.join(", ")}`);
      }
      asText(entry["file"], `${where}.findings[].file`);
      asLine(entry["line"], `${where}.findings[].line`);
      const severity = asText(entry["severity"], `${where}.findings[].severity`);
      if (!SEVERITIES.includes(severity)) {
        throw new CorpusDefect(`${where}.findings[].severity is neither "concern" nor "nit"`);
      }
      if (entry["valid"] !== true && entry["valid"] !== false) {
        throw new CorpusDefect(`${where}.findings[].valid is not a boolean`);
      }
    }
    const verdicts = asRecord(record["verdicts"], `${where}.verdicts`);
    for (const [anchor, verdict] of Object.entries(verdicts)) {
      if (!ANCHOR_PATTERN.test(anchor)) {
        throw new CorpusDefect(`${where}.verdicts key '${anchor}' is not a "file:line" anchor`);
      }
      if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) {
        throw new CorpusDefect(
          `${where}.verdicts['${anchor}'] is not confirmed, refuted or uncertain`,
        );
      }
    }
  }
  return record;
}

/**
 * Validates one recorded provider answer. Exactly the shape the chat double
 * returns: content, tool calls and finish reason.
 *
 * @param {unknown} answer
 * @param {string} entryName
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
export function validateAnswerFile(answer, entryName, file) {
  const where = `answer ${entryName}/${file}`;
  const record = asRecord(answer, where);
  assertKeys(record, ["content", "finishReason", "toolCalls"], where);
  if (typeof record["content"] !== "string") {
    throw new CorpusDefect(`${where}.content is not a string`);
  }
  asText(record["finishReason"], `${where}.finishReason`);
  if (!Array.isArray(record["toolCalls"])) {
    throw new CorpusDefect(`${where}.toolCalls is not an array`);
  }
  for (const call of record["toolCalls"]) {
    const entry = asRecord(call, `${where}.toolCalls[]`);
    assertKeys(entry, ["arguments", "id", "name"], `${where}.toolCalls[]`);
    asText(entry["id"], `${where}.toolCalls[].id`);
    asText(entry["name"], `${where}.toolCalls[].name`);
    if (typeof entry["arguments"] !== "string") {
      throw new CorpusDefect(`${where}.toolCalls[].arguments is not the recorded JSON string`);
    }
  }
  return record;
}

const ANSWER_FILE = /^\d{2}-[a-z0-9-]+\.json$/;

/**
 * Loads and validates the whole corpus, sorted. Returns the entries in the
 * order the report is built in. The seed floor is the corpus contract; a
 * caller with a smaller fixture names its own floor rather than weakening
 * the default.
 *
 * @param {string} corpusRoot
 * @param {{floor?: {triage: number, review: number, harmonise: number}}} [options]
 * @returns {Promise<Array<{name: string, dir: string, kind: "triage" | "review" | "harmonise", snapshot: Record<string, unknown>, expected: Record<string, unknown>, answers: Array<Record<string, unknown>>}>>}
 */
export async function loadCorpus(corpusRoot, options = {}) {
  const floor = options.floor ?? {
    triage: MIN_TRIAGE_ENTRIES,
    review: MIN_REVIEW_ENTRIES,
    harmonise: MIN_HARMONISE_ENTRIES,
  };
  /** @type {Array<{name: string, dir: string, kind: "triage" | "review" | "harmonise", snapshot: Record<string, unknown>, expected: Record<string, unknown>, answers: Array<Record<string, unknown>>}>} */
  const entries = [];
  let triageCount = 0;
  let reviewCount = 0;
  let harmoniseCount = 0;
  for (const name of readdirSync(corpusRoot).sort()) {
    const dir = p.join(corpusRoot, name);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new CorpusDefect(`corpus entry ${name} is not a directory`);
    }
    for (const required of ["README.md", "expected.json", "snapshot.json"]) {
      if (!readdirSync(dir).includes(required)) {
        throw new CorpusDefect(`corpus entry ${name} is missing ${required}`);
      }
    }

    let snapshotValue;
    let expectedValue;
    try {
      snapshotValue = JSON.parse(readFileSync(p.join(dir, "snapshot.json"), "utf8"));
      expectedValue = JSON.parse(readFileSync(p.join(dir, "expected.json"), "utf8"));
    } catch (error) {
      throw new CorpusDefect(
        `corpus entry ${name} holds malformed JSON: ${/** @type {Error} */ (error).message}`,
      );
    }
    const snapshot = validateSnapshot(snapshotValue, name);
    const kind = /** @type {"triage" | "review" | "harmonise"} */ (snapshot["kind"]);
    const expected = validateExpected(expectedValue, name, kind);
    if (kind === "triage") {
      triageCount += 1;
    } else if (kind === "harmonise") {
      harmoniseCount += 1;
    } else {
      reviewCount += 1;
    }

    const readme = readFileSync(p.join(dir, "README.md"), "utf8");
    const paragraphs = readme
      .split(/\n\s*\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (paragraphs.length !== 1) {
      throw new CorpusDefect(`corpus entry ${name} README.md is not exactly one paragraph`);
    }

    const answerDir = p.join(dir, "answers");
    // A zero-ask entry records an EMPTY answers/ directory — and git does
    // not track empty directories, so a fresh clone has no answers/ at all.
    // An absent directory is the zero-ask case, not a defect; the answer
    // files that DO exist are still validated below, name-shape and JSON.
    const answerFiles = existsSync(answerDir) ? readdirSync(answerDir).sort() : [];
    /** @type {Array<Record<string, unknown>>} */
    const answers = [];
    for (const file of answerFiles) {
      if (!ANSWER_FILE.test(file)) {
        throw new CorpusDefect(`corpus entry ${name} answer file '${file}' is not NN-name.json`);
      }
      let value;
      try {
        value = JSON.parse(readFileSync(p.join(answerDir, file), "utf8"));
      } catch (error) {
        throw new CorpusDefect(
          `corpus entry ${name} answer '${file}' holds malformed JSON: ${/** @type {Error} */ (error).message}`,
        );
      }
      answers.push(validateAnswerFile(value, name, file));
    }
    entries.push({ name, dir, kind, snapshot, expected, answers });
  }
  if (
    triageCount < floor.triage ||
    reviewCount < floor.review ||
    harmoniseCount < floor.harmonise
  ) {
    throw new CorpusDefect(
      `corpus is below its seed: ${String(triageCount)} triage entries (need ${String(floor.triage)}), ${String(reviewCount)} review entries (need ${String(floor.review)}), ${String(harmoniseCount)} harmonise entries (need ${String(floor.harmonise)})`,
    );
  }
  return entries;
}

// ── Recorded doubles ────────────────────────────────────────────────────
// The forge double serves exactly the recorded world: a read the run makes
// that the snapshot does not hold throws `CorpusDefect` naming the read, and
// a write op the snapshot contract does not allow surfaces the same way.
// The chat double hands out the recorded answers in filename order; a run
// that asks for more than the recording holds is a corpus defect, not an
// empty completion.

/**
 * @typedef {Object} WriteOp
 * @property {string} op
 * @property {unknown[]} args
 */

/**
 * Builds the forge double for one entry.
 *
 * @param {Record<string, unknown>} world
 * @param {Record<string, string | null>} policyFiles
 * @param {WriteOp[]} writes
 * @param {string} entryName
 * @returns {Record<string, unknown>}
 */
export function makeForge(world, policyFiles, writes, entryName, options = {}) {
  return new Proxy(/** @type {Record<string, unknown>} */ ({}), {
    get(_target, member, _receiver) {
      if (typeof member !== "string") {
        return undefined;
      }
      switch (member) {
        case "getContents": {
          /** @param {string} path
           * @param {{ ref?: string }} [opts]
           * @returns {unknown} */
          return async (path, opts) => {
            const ref = opts?.ref;
            const refFiles =
              /** @type {Record<string, Record<string, string | null>> | undefined} */ (
                options["files"]
              );
            if (refFiles !== undefined) {
              // Ref-aware mode: every read resolves against a recorded ref's
              // file set, so a ref the snapshot does not declare is a defect.
              if (ref === undefined || !Object.hasOwn(refFiles, ref)) {
                throw new CorpusDefect(
                  `${entryName}: the run read '${path}' at ref '${String(ref)}', which the snapshot does not record in files`,
                );
              }
              const atRef = refFiles[ref];
              if (!Object.hasOwn(atRef, path)) {
                throw new CorpusDefect(
                  `${entryName}: the run read file '${path}' at ref '${ref}', which the snapshot does not record in that ref's file set`,
                );
              }
              const refContent = atRef[path];
              if (refContent === null) {
                return null;
              }
              return { content: refContent };
            }
            if (!Object.hasOwn(policyFiles, path)) {
              throw new CorpusDefect(
                `${entryName}: the run read policy file '${path}', which the snapshot does not record`,
              );
            }
            const content = policyFiles[path];
            if (content === null) {
              return null;
            }
            return { content };
          };
        }
        case "readRef": {
          return (branch) => {
            const refMap = /** @type {Record<string, string> | undefined} */ (world["getRef"]);
            if (refMap !== undefined && Object.hasOwn(refMap, branch)) {
              return { sha: refMap[branch] };
            }
            return null;
          };
        }
        case "createBlob": {
          return (content) => {
            writes.push({ op: "createBlob", args: [content] });
            return { sha: `blob${String(writes.length).padStart(38, "0")}` };
          };
        }
        case "createTree": {
          return (base, changes) => {
            writes.push({ op: "createTree", args: [base, changes] });
            return { sha: `tree-${base.slice(0, 4)}` };
          };
        }
        case "createCommit": {
          return (message, treeSha, parent) => {
            writes.push({ op: "createCommit", args: [message, treeSha, parent] });
            return { sha: "c".repeat(40) };
          };
        }
        case "upsertBranch": {
          return (branch, commitSha, expectedCurrentSha) => {
            writes.push({ op: "upsertBranch", args: [branch, commitSha, expectedCurrentSha] });
            return undefined;
          };
        }
        case "upsertPullRequest": {
          return (input) => {
            writes.push({ op: "upsertPullRequest", args: [input] });
            return { number: 42, created: true };
          };
        }
        case "addLabels":
        case "removeLabel":
        case "createComment":
        case "updateComment":
        case "deleteComment": {
          return (...args) => {
            writes.push({ op: member, args });
            return member === "createComment" ? { id: 1_000 + writes.length } : undefined;
          };
        }
        default: {
          const served = world[member];
          if (served === undefined && !(member in world)) {
            throw new CorpusDefect(
              `${entryName}: the run called forge.${member}, which the snapshot does not record — a corpus defect, not a missing fixture`,
            );
          }
          if (typeof served !== "function" && typeof served !== "object") {
            return served;
          }
          if (typeof served === "function") {
            return served;
          }
          /** @param {unknown[]} args */
          return (...args) => {
            const recorded = served;
            if (!isRecord(recorded) && !Array.isArray(recorded)) {
              throw new CorpusDefect(`${entryName}: world.${member} is not a recorded value`);
            }
            if (member === "getRef") {
              const branch = /** @type {string} */ (args[0]);
              const refs = /** @type {Record<string, string>} */ (recorded);
              if (typeof branch !== "string" || !Object.hasOwn(refs, branch)) {
                throw new CorpusDefect(
                  `${entryName}: the run read ref '${String(branch)}', which the snapshot does not record`,
                );
              }
              return { sha: refs[branch] };
            }
            return recorded;
          };
        }
      }
    },
  });
}

/**
 * Builds the chat double for one entry: the recorded answers, in ask order.
 * Both actions ask one completion at a time, so `complete` is the only
 * surface; `asks` reports how many the run made.
 *
 * @param {string} entryName
 * @param {Array<Record<string, unknown>>} answers
 * @returns {{asks: () => number, complete: () => Promise<Record<string, unknown>>}}
 */
export function makeChat(entryName, answers) {
  let cursor = 0;
  return {
    asks: () => cursor,
    async complete() {
      if (cursor >= answers.length) {
        throw new CorpusDefect(
          `${entryName}: the run asked for provider answer ${cursor + 1}, but the recording holds ${answers.length}`,
        );
      }
      const answer = answers[cursor];
      cursor += 1;
      return {
        content: /** @type {string} */ (answer["content"]),
        toolCalls: /** @type {Array<unknown>} */ (answer["toolCalls"]),
        finishReason: /** @type {string} */ (answer["finishReason"]),
      };
    },
  };
}

/**
 * Runs `work` with `globalThis.fetch` replaced by a throwing stub. The
 * corpus is offline: any run that reaches past the recorded doubles fails
 * loudly here instead of quietly succeeding.
 *
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withoutNetwork(work) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (
    () => {
      throw new CorpusDefect(
        "the replay reached for the network — the corpus is offline by contract",
      );
    }
  );
  try {
    return await work();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/**
 * Runs `work` with `console.log` silenced: the core runtime logs run banners
 * through `console.log`, and the evaluator's only output is its report.
 *
 * @template T
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function quietly(work) {
  const realLog = console.log;
  console.log = () => {};
  try {
    return await work();
  } finally {
    console.log = realLog;
  }
}

// ── Replays ─────────────────────────────────────────────────────────────
// One temp directory per entry, the snapshot's recorded world as the only
// provider, the real action module doing the work. A replay that throws is
// reported as a corpus defect by `evaluate`, never swallowed.

/** @typedef {{name: string, dir: string, kind: "triage" | "review" | "harmonise", snapshot: Record<string, unknown>, expected: Record<string, unknown>, answers: Array<Record<string, unknown>>}} CorpusEntry */

/**
 * Replays one triage entry through `triage/src/index.mjs`.
 *
 * @param {CorpusEntry} entry
 * @returns {Promise<{record: Record<string, unknown>, writes: WriteOp[], asks: number}>}
 */
export async function replayTriage(entry) {
  const snapshot = entry.snapshot;
  const inputs = /** @type {Record<string, unknown>} */ (snapshot["inputs"]);
  const event = /** @type {Record<string, unknown>} */ (snapshot["event"]);
  /** @type {WriteOp[]} */
  const writes = [];
  const root = mkdtempSync(p.join(tmpdir(), "eval-triage-"));
  try {
    const workspace = p.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(p.join(root, "event.json"), JSON.stringify(event["payload"]), "utf8");
    const chat = makeChat(entry.name, entry.answers);
    await withoutNetwork(() =>
      quietly(
        () =>
          /** @type {Promise<void>} */ (
            runTriage(
              {
                model: snapshot["model"],
                labels: inputs["labels"],
                dryRun: inputs["dryRun"],
                configPath: "",
                recordPath: p.join("workspace", ".triage-record"),
                requestTimeoutMs: 1_000,
                verify: inputs["verify"],
              },
              {
                workspace: root,
                owner: OWNER,
                repo: REPO_NAME,
                eventName: event["name"],
                eventPath: p.join(root, "event.json"),
                apiUrl: "https://api.github.invalid",
              },
              {
                forge: makeForge(
                  snapshot["world"],
                  snapshot["policy"]["files"],
                  writes,
                  entry.name,
                ),
                chat,
                evidence: createEvidence(() => EVIDENCE_ID),
                now: () => FIXED_NOW,
                readEvent: async () => /** @type {Record<string, unknown>} */ (event["payload"]),
              },
            )
          ),
      ),
    );
    const recordDir = p.join(workspace, ".triage-record");
    const files = readdirSync(recordDir).sort();
    if (files.length !== 1) {
      throw new CorpusDefect(
        `${entry.name}: the replay wrote ${files.length} run records, expected exactly one`,
      );
    }
    let record;
    try {
      record = JSON.parse(readFileSync(p.join(recordDir, files[0]), "utf8"));
      validateTriageRecord(record);
    } catch (error) {
      if (error instanceof CorpusDefect) {
        throw error;
      }
      throw new CorpusDefect(
        `${entry.name}: the replay's run record failed its own validator: ${/** @type {Error} */ (error).message}`,
      );
    }
    const asks = chat.asks();
    if (asks !== entry.answers.length) {
      throw new CorpusDefect(
        `${entry.name}: the run made ${asks} asks but the recording holds ${entry.answers.length}`,
      );
    }
    return { record, writes, asks };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Replays one review entry through `review/src/index.mjs`.
 *
 * @param {CorpusEntry} entry
 * @returns {Promise<{outcome: string, artifact: Record<string, unknown> | null, writes: WriteOp[], asks: number}>}
 */
export async function replayReview(entry) {
  const snapshot = entry.snapshot;
  const inputs = /** @type {Record<string, unknown>} */ (snapshot["inputs"]);
  const event = /** @type {Record<string, unknown>} */ (snapshot["event"]);
  const headFiles = /** @type {Record<string, string>} */ (snapshot["headFiles"]);
  /** @type {WriteOp[]} */
  const writes = [];
  const root = mkdtempSync(p.join(tmpdir(), "eval-review-"));
  try {
    const workspace = p.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    for (const [file, content] of Object.entries(headFiles)) {
      const target = p.join(workspace, file);
      mkdirSync(p.dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    writeFileSync(p.join(workspace, "event.json"), JSON.stringify(event["payload"]), "utf8");
    const chat = makeChat(entry.name, entry.answers);
    const result = await withoutNetwork(() =>
      runReview(
        {
          model: snapshot["model"],
          maxTurns: inputs["maxTurns"],
          contextWindow: inputs["contextWindow"],
          dryRun: inputs["dryRun"],
          configPath: inputs["configPath"],
          artifactPath: p.join("workspace", ".review-artifact"),
        },
        {
          workspace,
          owner: OWNER,
          repo: REPO_NAME,
          eventName: event["name"],
          eventPath: p.join(workspace, "event.json"),
          apiUrl: "https://api.github.invalid",
        },
        {
          forge: makeForge(snapshot["world"], snapshot["policy"]["files"], writes, entry.name),
          chat,
          now: () => FIXED_NOW,
          info: () => {},
        },
      ),
    );
    const asks = chat.asks();
    if (asks !== entry.answers.length) {
      throw new CorpusDefect(
        `${entry.name}: the run made ${asks} asks but the recording holds ${entry.answers.length}`,
      );
    }
    let artifact = null;
    if (result.artifact !== undefined) {
      try {
        artifact = JSON.parse(serialiseArtifact(result.artifact));
      } catch (error) {
        throw new CorpusDefect(
          `${entry.name}: the replay's artifact failed its own validator: ${/** @type {Error} */ (error).message}`,
        );
      }
    }
    return { outcome: result.outcome, artifact, writes, asks };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Replays one harmonise entry through `harmonise/src/index.mjs`. A run that
 * resolves published; a run that throws is classified against the run
 * contract's deterministic refusal signatures — the config-absent refusal,
 * the protection refusals, and the every-pair-failed report — before it is
 * called `failed`. Every other message is a genuine failure, not a refusal.
 *
 * @param {CorpusEntry} entry
 * @returns {Promise<{outcome: "published" | "refused" | "failed", writes: WriteOp[], asks: number, message: string | null}>}
 */
export async function replayHarmonise(entry) {
  const snapshot = entry.snapshot;
  const inputs = /** @type {Record<string, unknown>} */ (snapshot["inputs"]);
  const event = /** @type {Record<string, unknown>} */ (snapshot["event"]);
  /** @type {WriteOp[]} */
  const writes = [];
  const root = mkdtempSync(p.join(tmpdir(), "eval-harmonise-"));
  try {
    const workspace = p.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(p.join(root, "event.json"), JSON.stringify(event["payload"]), "utf8");
    const chat = makeChat(entry.name, entry.answers);
    await withoutNetwork(() =>
      quietly(
        () =>
          /** @type {Promise<void>} */ (
            runHarmonise(
              {
                model: /** @type {string} */ (snapshot["model"]),
                configPath: /** @type {string} */ (inputs["configPath"]),
                sourceLanguage: /** @type {string} */ (inputs["sourceLanguage"]),
                documents: /** @type {string[]} */ (inputs["documents"]),
                dryRun: /** @type {boolean} */ (inputs["dryRun"]),
                apiUrl: "https://api.github.invalid",
                apiKey: "sk-eval-placeholder",
                githubToken: "ghs_eval-placeholder",
                requestTimeoutMs: 1_000,
              },
              {
                workspace: root,
                owner: OWNER,
                repo: REPO_NAME,
                eventName: event["name"],
                eventPath: p.join(root, "event.json"),
                apiUrl: "https://api.github.invalid",
              },
              {
                forge: makeForge(
                  snapshot["world"],
                  /** @type {Record<string, string | null>} */ ({}),
                  writes,
                  entry.name,
                  {
                    files: /** @type {Record<string, Record<string, string | null>>} */ (
                      snapshot["files"]
                    ),
                  },
                ),
                chat,
                evidence: createEvidence(() => EVIDENCE_ID),
                sleep: () => Promise.resolve(),
                now: () => FIXED_NOW,
                readEvent: async () => /** @type {Record<string, unknown>} */ (event["payload"]),
              },
            )
          ),
      ),
    );
    const asks = chat.asks();
    if (asks !== entry.answers.length) {
      throw new CorpusDefect(
        `${entry.name}: the run made ${asks} asks but the recording holds ${entry.answers.length}`,
      );
    }
    return { outcome: "published", writes, asks, message: null };
  } catch (error) {
    if (error instanceof CorpusDefect) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const refused =
      message.startsWith("no config file exists ") ||
      message.includes("protection refused:") ||
      message.startsWith("every pair failed:") ||
      message.startsWith("every pair skipped:");
    if (refused) {
      return { outcome: "refused", writes, asks: 0, message };
    }
    return { outcome: "failed", writes, asks: 0, message };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Pins and scoring ────────────────────────────────────────────────────
// Triage is pinned outright (only refusal-rate is its frozen offline metric,
// so a divergence anywhere else is a broken corpus, not a calibration
// signal); review is pinned on the terminal outcome alone and scored.

const DOWNGRADE_LINE = /^verification downgraded '([^']*)' \((confirmed|refuted|uncertain)\): /;

/**
 * The refusal names a triage record carries: the ceilings' own entries as
 * given, plus the op ids the verification downgraded, stripped back to the
 * label name the expectation names (`add:docs` → `docs`; a bare `comment`
 * stays).
 *
 * @param {Record<string, unknown>} record
 * @returns {string[]}
 */
export function refusalNames(record) {
  const decision = record["decision"];
  if (!isRecord(decision)) {
    return [];
  }
  const refusals = asTextList(decision["refusals"], "the replay record's decision.refusals");
  /** @type {string[]} */
  const names = [];
  for (const refusal of refusals) {
    const downgraded = DOWNGRADE_LINE.exec(refusal);
    if (downgraded === null) {
      names.push(refusal);
      continue;
    }
    const opId = downgraded[1];
    names.push(
      opId.startsWith("add:") || opId.startsWith("remove:")
        ? opId.slice(opId.indexOf(":") + 1)
        : opId,
    );
  }
  return names.sort();
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function sorted(values) {
  return [...values].sort();
}

/**
 * @param {WriteOp[]} writes
 * @returns {boolean}
 */
function hasCommentWrite(writes) {
  return writes.some((op) => op.op === "createComment" || op.op === "updateComment");
}

/**
 * Pins one triage replay against its expectation. Any divergence is a
 * corpus defect naming the entry.
 *
 * @param {CorpusEntry} entry
 * @param {{record: Record<string, unknown>, writes: WriteOp[], asks: number}} replay
 * @returns {void}
 */
export function pinTriage(entry, replay) {
  const expected = entry.expected;
  const record = replay.record;
  if (record["outcome"] !== expected["outcome"]) {
    throw new CorpusDefect(
      `${entry.name}: the replay ended '${String(record["outcome"])}', expected '${String(expected["outcome"])}'`,
    );
  }
  const decision = isRecord(record["decision"]) ? record["decision"] : null;
  const adds = decision === null ? [] : asTextList(decision["add"], "the record's decision.add");
  const removes =
    decision === null
      ? []
      : /** @type {Array<Record<string, unknown>>} */ (decision["remove"]).map((removal) =>
          String(removal["name"]),
        );
  const refusals = refusalNames(record);
  for (const [side, produced, wanted] of [
    ["adds", sorted(adds), sorted(/** @type {string[]} */ (expected["adds"]))],
    ["removes", sorted(removes), sorted(/** @type {string[]} */ (expected["removes"]))],
    ["refusals", sorted(refusals), sorted(/** @type {string[]} */ (expected["refusals"]))],
  ]) {
    const same =
      produced.length === wanted.length &&
      produced.every((value, index) => value === wanted[index]);
    if (!same) {
      throw new CorpusDefect(
        `${entry.name}: the replay's ${side} (${produced.join(", ") || "none"}) diverge from the expectation (${wanted.join(", ") || "none"})`,
      );
    }
  }
  const comment = hasCommentWrite(replay.writes);
  const expectedComment =
    expected["commentExpected"] === true || expected["signalExpected"] === true;
  if (comment !== expectedComment) {
    throw new CorpusDefect(
      `${entry.name}: the replay ${comment ? "wrote a comment" : "wrote no comment"}, expected the opposite`,
    );
  }
  const verification = isRecord(record["verification"]) ? record["verification"] : null;
  const wantedVerification = expected["verification"];
  if (wantedVerification === undefined) {
    if (verification?.["requested"] === true) {
      throw new CorpusDefect(`${entry.name}: the replay requested verification, expected none`);
    }
    return;
  }
  const wanted = asRecord(wantedVerification, `${entry.name} expected.verification`);
  if (verification?.["requested"] !== wanted["requested"]) {
    throw new CorpusDefect(
      `${entry.name}: the replay's verification.requested diverges from the expectation`,
    );
  }
  const downgraded = asTextList(
    verification?.["downgraded"] ?? [],
    "the record's verification.downgraded",
  );
  const wantedDowngraded = asTextList(
    wanted["downgraded"],
    `${entry.name} expected.verification.downgraded`,
  );
  const same =
    sorted(downgraded).length === sorted(wantedDowngraded).length &&
    sorted(downgraded).every((value, index) => value === sorted(wantedDowngraded)[index]);
  if (!same) {
    throw new CorpusDefect(
      `${entry.name}: the replay downgraded [${downgraded.join(", ") || "none"}], expected [${wantedDowngraded.join(", ") || "none"}]`,
    );
  }
}

/**
 * Pins one review replay on its terminal outcome alone.
 *
 * @param {CorpusEntry} entry
 * @param {{outcome: string}} replay
 * @returns {void}
 */
export function pinReview(entry, replay) {
  if (replay.outcome !== entry.expected["outcome"]) {
    throw new CorpusDefect(
      `${entry.name}: the replay ended '${replay.outcome}', expected '${String(entry.expected["outcome"])}'`,
    );
  }
}

/**
 * Pins one harmonise replay against its expectation: the terminal state and
 * the exact op sequence the publication made. A refused run additionally
 * pins the refusal reason itself — harmonise's validation is deterministic,
 * so the message the real validator produced is the corpus's own record of
 * it, and a paraphrase is a divergence, not a wording preference.
 *
 * @param {CorpusEntry} entry
 * @param {{outcome: string, writes: WriteOp[], asks: number}} replay
 * @returns {void}
 */
export function pinHarmonise(entry, replay) {
  if (replay.outcome !== entry.expected["outcome"]) {
    throw new CorpusDefect(
      `${entry.name}: the replay ended '${replay.outcome}', expected '${String(entry.expected["outcome"])}'`,
    );
  }
  const wanted = /** @type {string[]} */ (entry.expected["writes"]);
  const made = replay.writes.map((write) => write.op);
  const same = wanted.length === made.length && wanted.every((op, index) => op === made[index]);
  if (!same) {
    throw new CorpusDefect(
      `${entry.name}: the replay's write ops [${made.join(", ") || "none"}] diverge from the expectation [${wanted.join(", ") || "none"}]`,
    );
  }
  const wantedRefusal = entry.expected["refusal"];
  if (typeof wantedRefusal === "string" && replay.message !== wantedRefusal) {
    throw new CorpusDefect(
      `${entry.name}: the replay's refusal message diverges from the expectation — the validator's deterministic wording changed:\n  expected: ${wantedRefusal}\n  produced: ${String(replay.message)}`,
    );
  }
}

/**
 * Scores one review entry's produced findings against its expectation.
 * `tp` are produced anchors the expectation marks `valid: true`; `fp` are
 * produced anchors it does not; `tn` are the `valid: false` distractors
 * that stayed unreported.
 *
 * @param {Array<Record<string, unknown>>} expectedFindings
 * @param {Array<Record<string, unknown>>} produced
 * @returns {{tp: number, fp: number, tn: number, severityAgree: number}}
 */
export function scoreFindings(expectedFindings, produced) {
  /** @type {Map<string, {severity: string, valid: boolean}>} */
  const wanted = new Map();
  for (const finding of expectedFindings) {
    wanted.set(`${finding["file"]}:${finding["line"]}`, {
      severity: String(finding["severity"]),
      valid: finding["valid"] === true,
    });
  }
  let tp = 0;
  let fp = 0;
  let severityAgree = 0;
  /** @type {Set<string>} */
  const producedAnchors = new Set();
  for (const finding of produced) {
    const anchor = `${finding["file"]}:${finding["line"]}`;
    producedAnchors.add(anchor);
    const match = wanted.get(anchor);
    if (match !== undefined && match.valid) {
      tp += 1;
      if (match.severity === finding["severity"]) {
        severityAgree += 1;
      }
    } else {
      fp += 1;
    }
  }
  let tn = 0;
  for (const [anchor, match] of wanted) {
    if (!match.valid && !producedAnchors.has(anchor)) {
      tn += 1;
    }
  }
  return { tp, fp, tn, severityAgree };
}

/**
 * Re-derives every produced finding's anchor from the snapshot's recorded
 * head bytes. Trusting the artifact's digests would make the metric read
 * what it reports; re-deriving makes a divergence a corpus defect.
 *
 * @param {CorpusEntry} entry
 * @param {Record<string, unknown> | null} artifact
 * @returns {void}
 */
export function anchorDefects(entry, artifact) {
  if (artifact === null) {
    return;
  }
  const findings = artifact["findings"];
  if (!Array.isArray(findings)) {
    return;
  }
  const headFiles = /** @type {Record<string, string>} */ (entry.snapshot["headFiles"]);
  for (const finding of findings) {
    const file = String(finding["file"]);
    if (!Object.hasOwn(headFiles, file)) {
      throw new CorpusDefect(
        `${entry.name}: a finding anchors '${file}', which the snapshot does not record in headFiles`,
      );
    }
    const bytes = headFiles[file];
    const provenance = asRecord(finding["provenance"], `${entry.name} finding provenance`);
    const wantedDigest = contentDigest(bytes);
    const wantedEndLine = bytes.split("\n").length;
    const line = asLine(finding["line"], `${entry.name} finding line`);
    if (provenance["path"] !== normaliseReadPath(file)) {
      throw new CorpusDefect(
        `${entry.name}: the finding at ${file}:${line} carries provenance path '${String(provenance["path"])}'`,
      );
    }
    if (provenance["startLine"] !== 1 || provenance["endLine"] !== wantedEndLine) {
      throw new CorpusDefect(
        `${entry.name}: the finding at ${file}:${line} carries a line range the head file does not re-derive`,
      );
    }
    if (provenance["digest"] !== wantedDigest) {
      throw new CorpusDefect(
        `${entry.name}: the finding at ${file}:${line} carries a digest the pinned head does not re-derive`,
      );
    }
    if (line < 1 || line > wantedEndLine) {
      throw new CorpusDefect(
        `${entry.name}: the finding at ${file}:${line} points outside the recorded head file`,
      );
    }
  }
}

/**
 * The verdict accounting one review artifact carries: the pass judged every
 * finding it planned, so each verdict word counts once; an `unresolved`
 * lifecycle with no verdict stays in the agreement denominator.
 *
 * @param {Record<string, unknown> | null} artifact
 * @returns {{confirmed: number, refuted: number, uncertain: number, unresolved: number}}
 */
export function verifierCounts(artifact) {
  const counts = { confirmed: 0, refuted: 0, uncertain: 0, unresolved: 0 };
  if (artifact === null) {
    return counts;
  }
  const findings = artifact["findings"];
  if (!Array.isArray(findings)) {
    return counts;
  }
  for (const finding of findings) {
    const verdict = finding["verdict"];
    if (verdict === "confirmed" || verdict === "refuted" || verdict === "uncertain") {
      counts[verdict] += 1;
    } else if (finding["lifecycle"] === "unresolved") {
      counts.unresolved += 1;
    }
  }
  return counts;
}

/**
 * @param {Record<string, unknown> | null} artifact
 * @returns {Array<Record<string, unknown>>}
 */
function producedFindings(artifact) {
  const findings = artifact?.["findings"];
  return Array.isArray(findings) ? /** @type {Array<Record<string, unknown>>} */ (findings) : [];
}

/**
 * Produced verdicts against the expected verdicts. A produced verdict with
 * no expected verdict is a corpus defect, not a miss — the expectation is
 * the corpus's own record of what the verifier said.
 *
 * @param {Record<string, unknown> | null} artifact
 * @param {Record<string, unknown>} expectedVerdicts
 * @param {string} entryName
 * @returns {{matches: number, total: number}}
 */
export function verificationAccuracy(artifact, expectedVerdicts, entryName) {
  let matches = 0;
  let total = 0;
  for (const finding of producedFindings(artifact)) {
    const verdict = finding["verdict"];
    if (verdict !== "confirmed" && verdict !== "refuted" && verdict !== "uncertain") {
      continue;
    }
    const anchor = `${finding["file"]}:${finding["line"]}`;
    if (!Object.hasOwn(expectedVerdicts, anchor)) {
      throw new CorpusDefect(
        `${entryName}: the artifact holds a '${verdict}' verdict at ${anchor}, but expected.json holds no expected verdict there`,
      );
    }
    total += 1;
    if (expectedVerdicts[anchor] === verdict) {
      matches += 1;
    }
  }
  return { matches, total };
}

// ── Metric math ─────────────────────────────────────────────────────────
// Pure, exported, unit-tested in `tools/evaluate.test.mjs`. Every share is
// null when its denominator is zero — an unmeasured metric prints "n/a",
// never a fabricated 0 or 1.

/**
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number | null}
 */
export function share(numerator, denominator) {
  if (denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

/**
 * @param {number} tp
 * @param {number} fp
 * @returns {number | null}
 */
export function precision(tp, fp) {
  return share(tp, tp + fp);
}

/**
 * @param {number} fp
 * @param {number} tn
 * @returns {number | null}
 */
export function falsePositiveRate(fp, tn) {
  return share(fp, fp + tn);
}

/**
 * @param {number} agree
 * @param {number} tp
 * @returns {number | null}
 */
export function severityAgreement(agree, tp) {
  return share(agree, tp);
}

/**
 * Confirmed over every verdict word the pass can attach, unresolved
 * included — the frozen wording keeps unresolved in the denominator.
 *
 * @param {{confirmed: number, refuted: number, uncertain: number, unresolved: number}} counts
 * @returns {number | null}
 */
export function verifierAgreement(counts) {
  return share(
    counts.confirmed,
    counts.confirmed + counts.refuted + counts.uncertain + counts.unresolved,
  );
}

/**
 * @param {{matches: number, total: number}} accuracy
 * @returns {number | null}
 */
export function verificationAccuracyRate(accuracy) {
  return share(accuracy.matches, accuracy.total);
}

/**
 * @param {number} findings
 * @param {number} failures
 * @returns {number | null}
 */
export function anchoringIntegrity(findings, failures) {
  return share(findings - failures, findings);
}

/**
 * @param {number} refusedRuns
 * @param {number} modelAnsweredRuns
 * @returns {number | null}
 */
export function refusalRate(refusedRuns, modelAnsweredRuns) {
  return share(refusedRuns, modelAnsweredRuns);
}

/**
 * The harmonise metric: runs the deterministic validation refused over every
 * harmonise run replayed. Reported unbounded, like triage's refusal-rate —
 * a ceiling posture is a dial, not a defect; the number exists so a change
 * that moves it is visible.
 *
 * @param {number} refusedRuns
 * @param {number} replayedRuns
 * @returns {number | null}
 */
export function validationRefusalRate(refusedRuns, replayedRuns) {
  return share(refusedRuns, replayedRuns);
}

/**
 * Absolute write-op counts by kind across the corpus — the drift watch.
 *
 * @param {Array<{kind: string, writes: WriteOp[]}>} observations
 * @returns {Record<string, number>}
 */
export function countMutationSurface(observations) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const { kind, writes } of observations) {
    for (const op of writes) {
      const key = `${kind}.${op.op}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

// ── The evaluation ──────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORPUS_ROOT = p.join(REPO_ROOT, "evaluation", "corpus");

/**
 * @typedef {Object} MetricRow
 * @property {string} metric
 * @property {number | null} value
 * @property {string} threshold the printed threshold, in the words the header uses
 * @property {boolean} met whether the value clears its threshold
 */

/**
 * @typedef {Object} EvaluationResult
 * @property {MetricRow[]} rows
 * @property {Record<string, number>} mutationCounts
 * @property {string[]} defects
 * @property {{triage: number, review: number, harmonise: number}} corpusCounts
 * @property {{triage: number, review: number, harmonise: number}} replayed
 * @property {boolean} ok
 */

/**
 * Runs the whole offline evaluation: load the corpus, replay every entry
 * through the real modules, pin, score and return the result. Defects are
 * collected, not thrown — the report names every one and the exit is 1.
 *
 * @param {{corpusRoot?: string}} [options]
 * @returns {Promise<EvaluationResult>}
 */
export async function evaluate(options = {}) {
  const entries = await loadCorpus(options.corpusRoot ?? CORPUS_ROOT);
  /** @type {string[]} */
  const defects = [];
  let triageEntries = 0;
  let reviewEntries = 0;
  let harmoniseEntries = 0;
  let triageReplayed = 0;
  let reviewReplayed = 0;
  let harmoniseReplayed = 0;
  let harmoniseRefused = 0;
  let modelAnswered = 0;
  let refusedRuns = 0;
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let severityAgree = 0;
  let findings = 0;
  let anchorFailures = 0;
  /** @type {{confirmed: number, refuted: number, uncertain: number, unresolved: number}} */
  const verdictCounts = { confirmed: 0, refuted: 0, uncertain: 0, unresolved: 0 };
  let verdictMatches = 0;
  let verdictTotal = 0;
  /** @type {Array<{kind: string, writes: WriteOp[]}>} */
  const observations = [];

  for (const entry of entries) {
    if (entry.kind === "triage") {
      triageEntries += 1;
    } else if (entry.kind === "harmonise") {
      harmoniseEntries += 1;
    } else {
      reviewEntries += 1;
    }
    /** @type {{triage?: Awaited<ReturnType<typeof replayTriage>>, review?: Awaited<ReturnType<typeof replayReview>>, harmonise?: Awaited<ReturnType<typeof replayHarmonise>>}} */
    const replays = {};
    try {
      if (entry.kind === "triage") {
        replays.triage = await replayTriage(entry);
      } else if (entry.kind === "harmonise") {
        replays.harmonise = await replayHarmonise(entry);
      } else {
        replays.review = await replayReview(entry);
      }
    } catch (error) {
      defects.push(
        error instanceof CorpusDefect
          ? error.message
          : `${entry.name}: the replay threw ${/** @type {Error} */ (error).message}`,
      );
      continue;
    }
    if (entry.kind === "triage") {
      triageReplayed += 1;
      const replay = /** @type {NonNullable<typeof replays.triage>} */ (replays.triage);
      observations.push({ kind: "triage", writes: replay.writes });
      try {
        pinTriage(entry, replay);
      } catch (error) {
        defects.push(
          error instanceof CorpusDefect
            ? error.message
            : `${entry.name}: ${/** @type {Error} */ (error).message}`,
        );
      }
      const decision = replay.record["decision"];
      if (isRecord(decision)) {
        modelAnswered += 1;
        if (refusalNames(replay.record).length > 0) {
          refusedRuns += 1;
        }
      }
    } else if (entry.kind === "harmonise") {
      harmoniseReplayed += 1;
      const replay = /** @type {NonNullable<typeof replays.harmonise>} */ (replays.harmonise);
      observations.push({ kind: "harmonise", writes: replay.writes });
      try {
        pinHarmonise(entry, replay);
      } catch (error) {
        defects.push(
          error instanceof CorpusDefect
            ? error.message
            : `${entry.name}: ${/** @type {Error} */ (error).message}`,
        );
      }
      if (replay.outcome === "refused") {
        harmoniseRefused += 1;
      }
    } else {
      reviewReplayed += 1;
      const replay = /** @type {NonNullable<typeof replays.review>} */ (replays.review);
      observations.push({ kind: "review", writes: replay.writes });
      try {
        pinReview(entry, replay);
      } catch (error) {
        defects.push(
          error instanceof CorpusDefect
            ? error.message
            : `${entry.name}: ${/** @type {Error} */ (error).message}`,
        );
      }
      const produced = producedFindings(replay.artifact);
      findings += produced.length;
      try {
        anchorDefects(entry, replay.artifact);
      } catch (error) {
        anchorFailures += 1;
        defects.push(
          error instanceof CorpusDefect
            ? error.message
            : `${entry.name}: ${/** @type {Error} */ (error).message}`,
        );
      }
      const scored = scoreFindings(
        /** @type {Array<Record<string, unknown>>} */ (entry.expected["findings"]),
        produced,
      );
      tp += scored.tp;
      fp += scored.fp;
      tn += scored.tn;
      severityAgree += scored.severityAgree;
      const counts = verifierCounts(replay.artifact);
      verdictCounts.confirmed += counts.confirmed;
      verdictCounts.refuted += counts.refuted;
      verdictCounts.uncertain += counts.uncertain;
      verdictCounts.unresolved += counts.unresolved;
      try {
        const accuracy = verificationAccuracy(
          replay.artifact,
          /** @type {Record<string, unknown>} */ (entry.expected["verdicts"]),
          entry.name,
        );
        verdictMatches += accuracy.matches;
        verdictTotal += accuracy.total;
      } catch (error) {
        defects.push(
          error instanceof CorpusDefect
            ? error.message
            : `${entry.name}: ${/** @type {Error} */ (error).message}`,
        );
      }
    }
  }

  const precisionValue = precision(tp, fp);
  const fprValue = falsePositiveRate(fp, tn);
  const severityValue = severityAgreement(severityAgree, tp);
  const agreementValue = verifierAgreement(verdictCounts);
  const accuracyValue = verificationAccuracyRate({ matches: verdictMatches, total: verdictTotal });
  const integrityValue = anchoringIntegrity(findings, anchorFailures);
  const refusalValue = refusalRate(refusedRuns, modelAnswered);
  const harmoniseRefusalValue = validationRefusalRate(harmoniseRefused, harmoniseReplayed);

  /** @param {number | null} value @param {(value: number) => boolean} meets @returns {boolean} */
  const met = (value, meets) => value !== null && meets(value);
  /** @type {MetricRow[]} */
  const rows = [
    {
      metric: "triage refusal-rate",
      value: refusalValue,
      threshold: "unbounded (reported)",
      met: true,
    },
    {
      metric: "review precision",
      value: precisionValue,
      threshold: `>= ${String(THRESHOLDS.minPrecision)}`,
      met: met(precisionValue, (value) => value >= THRESHOLDS.minPrecision),
    },
    {
      metric: "review false-positive-rate",
      value: fprValue,
      threshold: `<= ${String(THRESHOLDS.maxFalsePositiveRate)}`,
      met: met(fprValue, (value) => value <= THRESHOLDS.maxFalsePositiveRate),
    },
    {
      metric: "review severity-agreement",
      value: severityValue,
      threshold: `>= ${String(THRESHOLDS.minSeverityAgreement)}`,
      met: met(severityValue, (value) => value >= THRESHOLDS.minSeverityAgreement),
    },
    {
      metric: "review verifier-agreement",
      value: agreementValue,
      threshold: `>= ${String(THRESHOLDS.minVerifierAgreement)}`,
      met: met(agreementValue, (value) => value >= THRESHOLDS.minVerifierAgreement),
    },
    {
      metric: "review verification-accuracy",
      value: accuracyValue,
      threshold: `>= ${String(THRESHOLDS.minVerificationAccuracy)}`,
      met: met(accuracyValue, (value) => value >= THRESHOLDS.minVerificationAccuracy),
    },
    {
      metric: "review anchoring-integrity",
      value: integrityValue,
      threshold: `== ${String(THRESHOLDS.anchoringIntegrity)} (pinned)`,
      met: met(integrityValue, (value) => value === THRESHOLDS.anchoringIntegrity),
    },
    {
      metric: "harmonise validation-refusal-rate",
      value: harmoniseRefusalValue,
      threshold: "unbounded (reported)",
      met: true,
    },
  ];
  return {
    rows,
    mutationCounts: countMutationSurface(observations),
    defects,
    corpusCounts: { triage: triageEntries, review: reviewEntries, harmonise: harmoniseEntries },
    replayed: { triage: triageReplayed, review: reviewReplayed, harmonise: harmoniseReplayed },
    ok: defects.length === 0 && rows.every((row) => row.met),
  };
}

/**
 * The deterministic report: header comments carrying each metric's frozen
 * formula, its data source and the decision it informs, then the table,
 * then the mutation surface and — when the corpus is broken — every defect.
 *
 * @param {EvaluationResult} result
 * @returns {string}
 */
export function renderReport(result) {
  /** @param {number | null} value @returns {string} */
  const cell = (value) => (value === null ? "n/a" : value.toFixed(4));
  const lines = [
    "# pnpm eval — offline evaluation of the triage, review and harmonise corpus (issue #278, wave W5)",
    "#",
    "# Offline-computable metrics, in the wording issue #278 froze:",
    "#   triage refusal-rate — runs with >= 1 refusal entry / model-answered runs",
    "#     source: the triage run record (decision.refusals plus verification.downgraded) — informs ceiling calibration",
    "#   review verifier-agreement — confirmed / (confirmed + refuted + uncertain; unresolved stays in the denominator)",
    "#     source: the verdicts on the artifact's findings — informs strictness defaults and lane tuning",
    "#   review anchoring-integrity — findings whose anchor re-derives against the pinned head / findings",
    "#     source: the artifact's provenance digests, re-derived here from the recorded head bytes — informs provenance-gate strictness",
    "#   review precision / false-positive-rate / severity-agreement / verification-accuracy — against labeled corpus entries",
    "#     source: corpus + artifact — informs prompt and verification-pass changes",
    "#   mutation-surface — total write ops per run by kind; source: the replay doubles — drift watch, growth is a design smell",
    "#   harmonise validation-refusal-rate — refused / harmonise runs replayed; source: the replay's terminal state (a run the real validators declined: a config, protection or contract refusal) — informs validation strictness calibration",
    "#   archkeep violation rate — NOT computed here: the arch gate enforces it; run `pnpm arch`",
    "#",
    "# Defined but production-deferred (U-8), never silently absent:",
    "#   triage sheet-accuracy — needs 30-day non-revert observation and actor attribution",
    "#   harmonise apply-clean-rate — needs production merge outcomes; this corpus holds none",
    "#",
    "# Not applicable or caveated, never silently:",
    "#   duplicate-detection precision/recall — no offline ground truth; the relationship signal is advisory text",
    "#   routing accuracy — triage has no routing concept; N/A, not zero",
    "#   finding recall — offline its ceiling is the corpus itself; docs/evaluation.md states the caveat",
    "#",
    "# Every initial threshold is deliberately loose — the corpus is the seed; thresholds earn strictness with calibration history.",
    "#",
    `# corpus: ${String(result.corpusCounts.triage)} triage entries, ${String(result.corpusCounts.review)} review entries, ${String(result.corpusCounts.harmonise)} harmonise entries; replayed: ${String(result.replayed.triage)} triage, ${String(result.replayed.review)} review, ${String(result.replayed.harmonise)} harmonise`,
    "#",
    "metric".padEnd(32) + "value".padStart(8) + "  " + "threshold".padEnd(24) + "met",
    "".padEnd(70, "-"),
  ];
  for (const row of result.rows) {
    const mark = row.value === null ? "—" : row.met ? "yes" : "no";
    lines.push(
      row.metric.padEnd(32) + cell(row.value).padStart(8) + "  " + row.threshold.padEnd(24) + mark,
    );
  }
  lines.push("#");
  lines.push("# mutation-surface — absolute write ops by kind across the corpus:");
  const surface = Object.keys(result.mutationCounts).sort();
  if (surface.length === 0) {
    lines.push("#   (none)");
  } else {
    for (const key of surface) {
      lines.push(`#   ${key.padEnd(28)}${String(result.mutationCounts[key])}`);
    }
  }
  lines.push("#");
  if (result.defects.length > 0) {
    lines.push(`# corpus defects (${String(result.defects.length)}):`);
    for (const defect of result.defects) {
      lines.push(`#   - ${defect}`);
    }
  } else {
    lines.push("# corpus defects: none");
  }
  lines.push("#");
  lines.push(`# result: ${result.ok ? "PASS" : "FAIL"}`);
  return lines.map((line) => `${line}\n`).join("");
}

/**
 * The program entry: evaluate, print, and exit 0 only when every replay
 * succeeded, every pin held, every threshold cleared and no corpus defect
 * was raised.
 *
 * @returns {Promise<void>}
 */
async function main() {
  let result;
  try {
    result = await evaluate();
  } catch (error) {
    process.stdout.write(
      `evaluation failed: ${error instanceof CorpusDefect ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(renderReport(result));
  process.exitCode = result.ok ? 0 : 1;
}

if (isProgramEntry(import.meta.url)) {
  await main();
}

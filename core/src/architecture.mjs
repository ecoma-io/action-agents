/**
 * The Archkeep evidence reader — the boundary between a consumer's pinned
 * architecture step and everything downstream in this repository.
 *
 * What this module is allowed to know is exactly the runtime-evidence
 * protocol: how a `archkeep delta --format json` report envelope and the
 * recipe's manifest look, how the two must agree, and how to normalize a
 * coherent pair into the frozen {@link ArchitectureEvidence} shape. It never
 * knows what the evidence means to a run — no severity mapping, no
 * criticality, no prompt shaping. Those are consumers' decisions, made over
 * the recorded facts and nowhere else.
 *
 * The ceilings this module holds:
 *
 * - **Recorded, never re-derived.** The envelope's `decision.verdict` is
 *   copied as the evidence verdict. A report saying `pass` with ten
 *   violations listed is this reader's refusal to sign, not its input.
 * - **The exit-evidence precedence law.** The recipe's manifest records the
 *   step's real exit. A report absent or unparseable beside a nonzero exit is
 *   `unknown` — incomplete, never green. A report claiming an exit the
 *   manifest does not record is a coin-flip read and is refused outright.
 * - **Staleness withholds.** Evidence whose head provenance is missing or
 *   names any commit other than the one the caller expects is `stale`, and a
 *   stale report's verdict is `unknown` — however attractive its bytes.
 * - **Counts, never findings, for what was not judged.** Unresolvable rows
 *   and custom-rule rows are carried as counts and capped facts; unjudged
 *   material cannot masquerade as evidence.
 * - **Workspace confinement.** Both files are read through the caller's
 *   workspace resolver; a path outside it never opens.
 *
 * Every input here is untrusted bytes on a runner: the report is whatever
 * the step left behind, and the manifest is whatever the recipe wrote. Both
 * are evidence to validate, never instructions to follow.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { WorkspaceRefusal } from "./workspace.mjs";

/** The report byte cap — the frozen capacity ceiling (2 MiB). */
export const MAX_REPORT_BYTES = 2 * 2 ** 20;

/** The manifest byte cap — the recipe's exit record is tiny (64 KiB). */
export const MAX_MANIFEST_BYTES = 64 * 2 ** 10;

/** The envelope schema major this reader speaks (a delta report envelope). */
export const ENVELOPE_SCHEMA_VERSION = 2;

/** The tool name a delta envelope must carry — the npm name, measured at the pin. */
export const TOOL_NAME = "@ecoma-io/archkeep";

/** The command a delta envelope must declare — the only family this reader admits. */
export const DELTA_COMMAND = "delta";

/**
 * The frozen status → exit table a coherent envelope honours. Measured from
 * the pinned Archkeep's own envelope writer; a disagreement here is the
 * envelope describing a run it was not part of.
 */
const EXIT_FOR_STATUS = Object.freeze({ ok: 0, findings: 1, "no-verdict": 3 });

/** The frozen status → verdict mapping the evidence verdict is recorded from. */
const VERDICT_FOR_STATUS = Object.freeze({ ok: "pass", findings: "fail", "no-verdict": "unknown" });

/** How many coverage notes survive into evidence — disclosure, not a transcript. */
const MAX_COVERAGE_NOTES = 16;

/** How many occurrence-reduction notes survive into evidence. */
const MAX_OCCURRENCE_NOTES = 16;

/** How many rename pairs survive into evidence — disclosure, not a transcript. */
const MAX_RENAME_PAIRS = 16;

/** How many sites each normalized item keeps — a sample, never the full list. */
const MAX_SITES_PER_ITEM = 20;

/** How many sites each custom-rule bucket keeps. */
const MAX_SITES_PER_BUCKET = 20;

/** How many distinct rule ids each custom-rule bucket keeps. */
const MAX_RULE_IDS_PER_BUCKET = 16;

/**
 * The two refusal arms a read can end in, mirroring the run contract's F-02
 * split. The `reader` arm is a run that could not honestly read its input
 * (absent, oversized, unreadable) and ends the run red as `failed`. The
 * `validation` arm is bytes that parse but disagree with the protocol
 * (foreign family, incoherent table, contradicted exit) and is a typed
 * refusal the caller maps to `refused`.
 *
 * @typedef {"reader" | "validation"} ArchitectureReaderArm
 */

/** The four bucket names the protocol states its counts in. */
/**
 * @typedef {"introduced" | "resolved" | "unchanged" | "unknown"} BucketName
 */

/** The four violation buckets the protocol names, narrowed to arrays once validated. */
/**
 * @typedef {object} ViolationBuckets
 * @property {unknown[]} introduced
 * @property {unknown[]} resolved
 * @property {unknown[]} unchanged
 * @property {unknown[]} unknown
 */

/**
 * A validated delta's payload, narrowed by validation so normalization never
 * re-casts. Null customRules means the envelope declared no custom rules ran.
 *
 * @typedef {object} DeltaPayload
 * @property {Record<string, unknown>} result
 * @property {ViolationBuckets} violations
 * @property {ViolationBuckets} unresolvable
 * @property {Record<string, unknown> | null} customRules
 */

/**
 * Raised when a read cannot produce admissible evidence. The `arm` names
 * which F-02 lane the failure belongs to; the message is written for a run
 * log and names the file and the disagreement.
 */
export class ArchitectureReaderError extends Error {
  /**
   * @param {string} path the workspace-relative path the refusal names
   * @param {string} detail what was found and why it is not admissible
   * @param {ArchitectureReaderArm} arm which F-02 lane this refusal belongs to
   */
  constructor(path, detail, arm) {
    super(`${path}: ${detail}`);
    this.name = "ArchitectureReaderError";
    /** The workspace-relative path the refusal names. */
    this.path = path;
    /** Which F-02 lane this refusal belongs to. */
    this.arm = arm;
  }
}

/** A git provenance fact as evidence records it — absent facts are null, never guessed. */
/**
 * @typedef {object} ProvenanceFacts
 * @property {string | null} commit
 * @property {boolean | null} dirty
 */

/** One occurrence site, kept as the two facts downstream ever cites. */
/**
 * @typedef {object} EvidenceSite
 * @property {string} file
 * @property {number} line
 */

/**
 * The constraint row that condemns an item, carried verbatim as a frozen
 * deep copy — null when the rule that fired names no row (the five
 * specifier-decided message ids). The row is part of violation identity, and
 * its `decisionRef` member is how a consumer reaches the record behind an
 * intentional evolution; carried, never interpreted.
 *
 * @typedef {Record<string, unknown> | null} ConstraintRow
 */

/** A normalized violation item — the identity facts, counts and a site sample. */
/**
 * @typedef {object} EvidenceItem
 * @property {string | null} messageId
 * @property {string | null} sourceProject
 * @property {string | null} target
 * @property {boolean} targetIsSpecifier
 * @property {ConstraintRow} constraint
 * @property {boolean} waived
 * @property {{ path: string | null, messageId: string | null, reason: string | null, expiresAt: string | null } | null} waivedBy the covering suppression row's law-time fields, verbatim — null when the entry carries no row
 * @property {number} baseCount
 * @property {number} headCount
 * @property {EvidenceSite[]} baseSites
 * @property {EvidenceSite[]} headSites
 * @property {string | null} reason
 * @property {string | null} note
 */

/** Counts of rows Archkeep could not attribute — counts, never findings. */
/**
 * @typedef {object} UnresolvableCounts
 * @property {number} introduced
 * @property {number} resolved
 * @property {number} unchanged
 * @property {number} unknown
 */

/** The capped facts one custom-rule bucket contributes. */
/**
 * @typedef {object} CustomRuleBucketFacts
 * @property {number} count
 * @property {string[]} ruleIds
 * @property {EvidenceSite[]} sites
 */

/**
 * One rename pair: an introduced entry and a resolved entry over identical
 * sites that differ in exactly one project identity field — what a project or
 * target rename looks like in a delta whose producer does no rename matching.
 * Carried beside the raw buckets, never instead of them: both sides stay in
 * `introduced` and `resolved`, so the envelope's own arithmetic survives and
 * the pairing is additive disclosure, never a netting. A wash rendering
 * ("1 introduced, 1 resolved") is exactly what this fact exists to prevent.
 *
 * @typedef {object} RenamePair
 * @property {EvidenceItem} introduced the new-name side
 * @property {EvidenceItem} resolved the old-name side
 */

/**
 * One occurrence-reduction fact: an unchanged entry that shrank without
 * resolving, with the identity the producer's verbatim note belongs to. A
 * shrink is improvement direction, disclosed — never a resolution, and never
 * netted against introduced counts.
 *
 * @typedef {object} OccurrenceReduction
 * @property {string | null} messageId
 * @property {string | null} sourceProject
 * @property {string | null} target
 * @property {string} note the producer's verbatim occurrencesReduced note
 */

/** The coverage facts a run log or artifact may cite. */
/**
 * @typedef {object} CoverageFacts
 * @property {boolean} complete
 * @property {number} analyzedFiles
 * @property {number} notAnalyzedCount
 * @property {number} blindSpotCount
 * @property {string[]} notes
 */

/** Why the verdict is `unknown` despite the read completing. */
/**
 * @typedef {object} ArchitectureIncompleteness
 * @property {"stale" | "incomplete"} reason
 * @property {string} note
 */

/**
 * The frozen evidence shape everything downstream consumes. Built here,
 * frozen here, and never re-derived: a consumer reads these facts or has
 * nothing.
 *
 * @typedef {object} ArchitectureEvidence
 * @property {"pass" | "fail" | "unknown"} verdict the envelope's recorded verdict — stale and incomplete runs record `unknown`
 * @property {boolean} stale whether the head provenance failed to pin to the expected head
 * @property {ArchitectureIncompleteness | null} incompleteness why an `unknown` verdict is not a judgement, when it is not
 * @property {{ head: ProvenanceFacts, base: ProvenanceFacts }} provenance both sides of the compare, baseline verbatim
 * @property {boolean | null} policyChanged whether the policy fingerprints of the two sides differ — null when never assessed
 * @property {string} provider the graph provider the run judged with
 * @property {string | null} toolVersion the Archkeep version the envelope names
 * @property {{ head: string | null, base: string | null }} policyFingerprints both sides' policy fingerprints
 * @property {string | null} reportSha256 sha256 over the raw report bytes — null when the report was absent
 * @property {EvidenceItem[]} introduced introduced violations, in report order
 * @property {EvidenceItem[]} resolved resolved violations, in report order
 * @property {number} unchangedCount
 * @property {number} introducedWaived
 * @property {RenamePair[]} renamePairs introduced+resolved entries over identical sites differing in one project identity — a move, never a wash; capped, both raw buckets kept verbatim
 * @property {{ findings: { introduced: CustomRuleBucketFacts, resolved: CustomRuleBucketFacts, unchanged: CustomRuleBucketFacts, unknown: CustomRuleBucketFacts } } | null} customRules null when the envelope declares no custom rules ran
 * @property {UnresolvableCounts} unresolvable
 * @property {OccurrenceReduction[]} occurrencesReduced shrinking unchanged entries with their identity and the producer's verbatim note, capped
 * @property {CoverageFacts} coverage
 */

/** The minimal workspace surface the reader needs — {@link createWorkspace} provides it. */
/**
 * @typedef {object} ArchitectureWorkspace
 * @property {(relativePath: string) => { absolute: string, relative: string }} resolve
 */

/** The pinned expectations a read is judged against. */
/**
 * @typedef {object} ArchitectureExpect
 * @property {string} headSha the commit this run reviews — a report pinned elsewhere is stale
 */

/** The one call: read both files, validate the pair, normalize the evidence. */
/**
 * @typedef {object} ReadArchitectureInput
 * @property {ArchitectureWorkspace} workspace
 * @property {string} reportPath workspace-relative path to the delta report envelope
 * @property {string} manifestPath workspace-relative path to the recipe's manifest
 * @property {ArchitectureExpect} expect
 */

/** @typedef {import("#core/workspace.mjs").Workspace} Workspace */

/**
 * Reads the pinned Archkeep delta report and the recipe's manifest, judges
 * the pair against the runtime-evidence protocol, and returns the frozen
 * {@link ArchitectureEvidence}. Synchronous, offline, clock-free: the same
 * bytes and the same expectation produce the same evidence, byte for byte.
 *
 * The endings, in order:
 *
 * 1. The manifest is absent, oversized, unreadable or not the recipe's shape —
 *    a `reader` arm refusal. Without the recorded exit there is no
 *    precedence fact and no admissible report.
 * 2. The report is absent beside a zero exit — a `reader` arm refusal
 *    (absent-though-configured: the step claims success and left nothing).
 * 3. The report is absent or unparseable beside a nonzero exit — evidence
 *    with verdict `unknown` and an `incomplete` reason naming the exit. The
 *    precedence law: the recorded nonzero exit wins over absent bytes.
 * 4. The report is past the byte cap — a `reader` arm refusal, regardless of
 *    the recorded exit: capacity is not negotiated by a nonzero exit.
 * 5. The report parses but is not a delta report from this tool, or its
 *    status/exit/decision/coverage table is incoherent, or its exit
 *    contradicts the manifest — a `validation` arm refusal. Bytes that
 *    disagree with the protocol are refused, never coerced.
 * 6. The head provenance does not pin to `expect.headSha` — evidence with
 *    verdict `unknown` and a `stale` reason. Staleness withholds; it never
 *    re-derives.
 * 7. Otherwise — the envelope's own verdict, recorded verbatim.
 *
 * @param {ReadArchitectureInput} input
 * @returns {ArchitectureEvidence}
 */
export function readArchitectureReport({ workspace, reportPath, manifestPath, expect }) {
  if (
    workspace === null ||
    typeof workspace !== "object" ||
    typeof workspace.resolve !== "function"
  ) {
    throw new TypeError("readArchitectureReport requires a workspace with a resolve(path) seam");
  }
  for (const [name, value] of [
    ["reportPath", reportPath],
    ["manifestPath", manifestPath],
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`readArchitectureReport requires a non-empty ${name}`);
    }
  }
  if (
    expect === null ||
    typeof expect !== "object" ||
    typeof expect.headSha !== "string" ||
    expect.headSha.length === 0
  ) {
    throw new TypeError(
      "readArchitectureReport requires expect.headSha — the commit this run reviews",
    );
  }

  const exitCode = readManifestExit(workspace, manifestPath);
  const report = readReportBytes(workspace, reportPath);

  // The precedence law's absent-bytes arms, before anything the bytes could
  // have said: a recorded nonzero exit with no admissible envelope is an
  // incomplete run, not a failure to read.
  if (report === null) {
    if (exitCode === 0) {
      throw new ArchitectureReaderError(
        reportPath,
        "absent while the recipe's manifest records exit 0 — the step claimed success and left no report " +
          "(absent-though-configured)",
        "reader",
      );
    }
    return incompleteEvidence(
      `the report is absent; the recorded step exit is ${String(exitCode)}`,
      null,
    );
  }
  if (report.parseFailed) {
    if (exitCode === 0) {
      throw new ArchitectureReaderError(
        reportPath,
        "does not parse as JSON while the recipe's manifest records exit 0 — a success exit beside unparseable bytes is a contradiction this reader refuses",
        "validation",
      );
    }
    return incompleteEvidence(
      `the report does not parse; the recorded step exit is ${String(exitCode)}`,
      report.digest,
    );
  }

  const envelope = /** @type {Record<string, unknown>} */ (stripVolatile(report.parsed));
  const payload = validateEnvelope(envelope, reportPath, exitCode);
  if (payload === null) {
    return normalizeNoVerdictEvidence(envelope, expect, report.digest);
  }
  return normalizeEvidence(envelope, payload, expect, report.digest, reportPath);
}

// ── The manifest: the precedence fact ─────────────────────────────────────

/**
 * Reads the recipe's manifest and returns the recorded step exit. The
 * manifest is the one file the recipe itself writes from the step's own
 * stdout/exit capture — the fact every precedence judgement reads.
 *
 * @param {ArchitectureWorkspace} workspace
 * @param {string} manifestPath
 * @returns {number}
 */
function readManifestExit(workspace, manifestPath) {
  let text;
  try {
    const resolved = workspace.resolve(manifestPath);
    const bytes = statSync(resolved.absolute).size;
    if (bytes > MAX_MANIFEST_BYTES) {
      throw new ArchitectureReaderError(
        manifestPath,
        `is ${String(bytes)} bytes, past the ${String(MAX_MANIFEST_BYTES)}-byte manifest cap`,
        "reader",
      );
    }
    text = readFileSync(resolved.absolute, "utf8");
  } catch (error) {
    if (error instanceof ArchitectureReaderError) throw error;
    // A confinement refusal is the workspace's own typed answer — the most
    // precise diagnosis there is — and propagates as itself.
    if (error instanceof WorkspaceRefusal) throw error;
    if (isMissingPath(error)) {
      throw new ArchitectureReaderError(
        manifestPath,
        "is absent — the recipe's manifest records the step's exit, and without it no report is admissible",
        "reader",
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new ArchitectureReaderError(
      manifestPath,
      `could not be read through the workspace — ${cause}`,
      "reader",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ArchitectureReaderError(manifestPath, "does not parse as JSON", "reader");
  }
  const exitCode = isPlainObject(parsed) ? parsed.exitCode : undefined;
  if (!isCount(exitCode)) {
    throw new ArchitectureReaderError(
      manifestPath,
      "is not the recipe's manifest shape — expected a JSON object with an integer exitCode",
      "reader",
    );
  }
  return exitCode;
}

// ── The report: raw bytes first, judgement after ──────────────────────────

/**
 * @typedef {object} ReportBytes
 * @property {boolean} parseFailed
 * @property {string} digest sha256 over the raw bytes
 * @property {unknown} parsed
 */

/**
 * Reads the report through workspace confinement under the byte cap.
 * Returns null when the file is absent; a parse failure is reported as a
 * flag so the precedence law can judge absent-vs-contradicted before any
 * validation runs.
 *
 * @param {ArchitectureWorkspace} workspace
 * @param {string} reportPath
 * @returns {ReportBytes | null}
 */
function readReportBytes(workspace, reportPath) {
  let raw;
  try {
    const resolved = workspace.resolve(reportPath);
    const bytes = statSync(resolved.absolute).size;
    if (bytes > MAX_REPORT_BYTES) {
      throw new ArchitectureReaderError(
        reportPath,
        `is ${String(bytes)} bytes, past the ${String(MAX_REPORT_BYTES)}-byte cap — refused as capacity`,
        "reader",
      );
    }
    raw = readFileSync(resolved.absolute);
  } catch (error) {
    if (error instanceof ArchitectureReaderError) throw error;
    // A confinement refusal is the workspace's own typed answer — the most
    // precise diagnosis there is — and propagates as itself.
    if (error instanceof WorkspaceRefusal) throw error;
    if (isMissingPath(error)) return null;
    const cause = error instanceof Error ? error.message : String(error);
    throw new ArchitectureReaderError(
      reportPath,
      `could not be read through the workspace — ${cause}`,
      "reader",
    );
  }
  const digest = createHash("sha256").update(raw).digest("hex");
  try {
    return { parseFailed: false, digest, parsed: JSON.parse(raw.toString("utf8")) };
  } catch {
    return { parseFailed: true, digest, parsed: null };
  }
}

/**
 * Whether a thrown error is the workspace resolver reporting an absent path.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingPath(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    /** @type {{ name?: unknown }} */ (error).name === "MissingPathError"
  );
}

// ── The incomplete arm: evidence without an envelope ──────────────────────

/**
 * The evidence an absent or unparseable report beside a nonzero exit
 * produces: verdict unknown, everything never-assessed carried as null or
 * empty, and the incompleteness note naming the recorded exit.
 *
 * @param {string} note
 * @param {string | null} digest
 * @returns {ArchitectureEvidence}
 */
function incompleteEvidence(note, digest) {
  return deepFreeze({
    verdict: "unknown",
    stale: false,
    incompleteness: { reason: "incomplete", note },
    provenance: {
      head: { commit: null, dirty: null },
      base: { commit: null, dirty: null },
    },
    policyChanged: null,
    provider: "",
    toolVersion: null,
    policyFingerprints: { head: null, base: null },
    reportSha256: digest,
    introduced: [],
    resolved: [],
    unchangedCount: 0,
    introducedWaived: 0,
    renamePairs: [],
    customRules: null,
    unresolvable: { introduced: 0, resolved: 0, unchanged: 0, unknown: 0 },
    occurrencesReduced: [],
    coverage: {
      complete: false,
      analyzedFiles: 0,
      notAnalyzedCount: 0,
      blindSpotCount: 0,
      notes: [],
    },
  });
}

// ── Validation: the protocol, and nothing the protocol does not name ──────

/**
 * Judges the parsed envelope against the runtime-evidence protocol: family
 * before version (a foreign family is a wiring mistake, and naming it first
 * is the diagnosis), then the versioned envelope's coherence table, then the
 * one cross-file fact — the exit the manifest recorded. Returns the narrowed
 * delta payload, or null when the run withheld its verdict — the no-verdict
 * lane has no result block to narrow.
 *
 * @param {Record<string, unknown>} value
 * @param {string} reportPath
 * @param {number} exitCode the manifest's recorded step exit
 * @returns {DeltaPayload | null}
 */
function validateEnvelope(value, reportPath, exitCode) {
  if (!isPlainObject(value)) {
    throw new ArchitectureReaderError(reportPath, "is not a JSON object", "validation");
  }

  // Family before version: a report from another command is not this
  // reader's input at any schema version, and the message says where the
  // file belongs instead of guessing.
  if (!("command" in value)) {
    throw new ArchitectureReaderError(
      reportPath,
      "carries no command — the evidence-snapshot family (archkeep delta --capture) or a history file, " +
        "not a delta report; the consumer's own gate only ever sees a delta",
      "validation",
    );
  }
  if (value.command !== DELTA_COMMAND) {
    const consumer =
      value.command === "check"
        ? "the consumer's own gate"
        : value.command === "graph"
          ? "the consumer's own diff"
          : "its own consumer";
    throw new ArchitectureReaderError(
      reportPath,
      `declares command ${JSON.stringify(String(value.command))} — a ${String(value.command)} report belongs to ${consumer}, not the runtime evidence seam`,
      "validation",
    );
  }

  if (value.schemaVersion !== ENVELOPE_SCHEMA_VERSION) {
    const relation =
      typeof value.schemaVersion === "number" && value.schemaVersion > ENVELOPE_SCHEMA_VERSION
        ? "written by a newer Archkeep than this pin — re-read the design record before widening the protocol"
        : "a schema major this reader has never spoken";
    throw new ArchitectureReaderError(
      reportPath,
      `declares schemaVersion ${JSON.stringify(value.schemaVersion)} where ${String(ENVELOPE_SCHEMA_VERSION)} is the delta envelope's — ${relation}`,
      "validation",
    );
  }

  const tool = value.tool;
  if (!isPlainObject(tool)) {
    throw new ArchitectureReaderError(reportPath, "carries no tool block", "validation");
  }
  if (tool.name !== TOOL_NAME) {
    throw new ArchitectureReaderError(
      reportPath,
      `names tool ${JSON.stringify(String(tool.name ?? null))} where ${TOOL_NAME} is the only producer of this evidence`,
      "validation",
    );
  }
  if (typeof tool.version !== "string" || tool.version.length === 0) {
    throw new ArchitectureReaderError(
      reportPath,
      "carries a tool block without a version — the producer must be attributable",
      "validation",
    );
  }

  // The coherence table: status, exit, decision and coverage are one fact
  // stated four ways. Any disagreement is an envelope describing a run it
  // was not part of.
  const status = value.status;
  if (status !== "ok" && status !== "findings" && status !== "no-verdict") {
    throw new ArchitectureReaderError(
      reportPath,
      `declares status ${JSON.stringify(String(status))} — not a status the protocol names`,
      "validation",
    );
  }
  const expectedExit = EXIT_FOR_STATUS[status];
  if (value.exitCode !== expectedExit) {
    throw new ArchitectureReaderError(
      reportPath,
      `records exit ${JSON.stringify(String(value.exitCode))} beside status ${JSON.stringify(status)} — the protocol's table pins that status to exit ${String(expectedExit)}`,
      "validation",
    );
  }
  if (value.exitCode !== exitCode) {
    throw new ArchitectureReaderError(
      reportPath,
      `claims exit ${String(value.exitCode)} while the manifest records ${String(exitCode)} — a coin-flip read is not admissible evidence`,
      "validation",
    );
  }

  const decision = value.decision;
  if (!isPlainObject(decision)) {
    throw new ArchitectureReaderError(
      reportPath,
      "carries no decision block — a delta report always states one",
      "validation",
    );
  }
  const expectedVerdict = VERDICT_FOR_STATUS[status];
  if (decision.verdict !== expectedVerdict) {
    throw new ArchitectureReaderError(
      reportPath,
      `records verdict ${JSON.stringify(String(decision.verdict))} beside status ${JSON.stringify(status)} — the protocol pins that status to ${JSON.stringify(expectedVerdict)}`,
      "validation",
    );
  }
  if (
    status === "no-verdict" &&
    (typeof decision.reason !== "string" || decision.reason.length === 0)
  ) {
    throw new ArchitectureReaderError(
      reportPath,
      "withholds a verdict without a reason — an unknown verdict must say why",
      "validation",
    );
  }

  validateCoverage(value.coverage, reportPath, status);

  // The result block is the delta's payload: present exactly when the run
  // reached a verdict, absent exactly when it did not.
  if (status === "no-verdict") {
    if ("result" in value) {
      throw new ArchitectureReaderError(
        reportPath,
        "carries a result block beside a withheld verdict — a no-verdict report has no result",
        "validation",
      );
    }
    return null;
  }
  return validateResult(value.result, reportPath);
}

/**
 * The coverage half of the coherence table: a run that succeeded claims
 * completeness, and completeness is falsifiable — no unanalyzed files, no
 * blind spot the graph could not judge.
 *
 * @param {unknown} coverage
 * @param {string} reportPath
 * @param {"ok" | "findings" | "no-verdict"} status
 * @returns {void}
 */
function validateCoverage(coverage, reportPath, status) {
  if (!isPlainObject(coverage)) {
    throw new ArchitectureReaderError(reportPath, "carries no coverage block", "validation");
  }
  if (typeof coverage.complete !== "boolean") {
    throw new ArchitectureReaderError(
      reportPath,
      "carries a coverage block without a complete flag",
      "validation",
    );
  }
  if (!Array.isArray(coverage.notAnalyzed)) {
    throw new ArchitectureReaderError(
      reportPath,
      "carries a coverage block without a notAnalyzed array",
      "validation",
    );
  }
  if (!Array.isArray(coverage.notes)) {
    throw new ArchitectureReaderError(
      reportPath,
      "carries a coverage block without a notes array",
      "validation",
    );
  }
  const blindSpots = coverage.blindSpots ?? [];
  if (!Array.isArray(blindSpots)) {
    throw new ArchitectureReaderError(
      reportPath,
      "carries a blindSpots entry that is not an array",
      "validation",
    );
  }
  const unjudged = blindSpots.filter((spot) => {
    if (!isPlainObject(spot)) return true;
    return spot.dynamic !== true && spot.external !== true;
  });
  if (status === "ok" && coverage.complete !== true) {
    throw new ArchitectureReaderError(
      reportPath,
      "declares an incomplete coverage block beside an ok status — a successful run claims it judged what it read",
      "validation",
    );
  }
  if (coverage.complete === true && (coverage.notAnalyzed.length > 0 || unjudged.length > 0)) {
    throw new ArchitectureReaderError(
      reportPath,
      "claims coverage complete over material it did not judge — notAnalyzed or an unjudged blind spot contradicts the claim",
      "validation",
    );
  }
}

/**
 * The result block: the delta payload's headline structure and the summary's
 * self-count. Per-item field shapes are normalized defensively downstream —
 * the refusal surface is the structure and the counters, not every leaf.
 * Returns the payload narrowed: the two bucket blocks as arrays, the custom
 * rule block as an object or null when none ran.
 *
 * @param {unknown} result
 * @param {string} reportPath
 * @returns {DeltaPayload}
 */
function validateResult(result, reportPath) {
  if (!isPlainObject(result)) {
    throw new ArchitectureReaderError(
      reportPath,
      "carries no result block — a verdict-carrying delta report always has one",
      "validation",
    );
  }
  if (typeof result.policyChanged !== "boolean") {
    throw new ArchitectureReaderError(
      reportPath,
      "carries no policyChanged flag — the two sides' policy fingerprints must be compared",
      "validation",
    );
  }
  for (const side of ["baseline", "head"]) {
    if (!isPlainObject(result[side])) {
      throw new ArchitectureReaderError(
        reportPath,
        `carries no ${String(side)} side in its result — a delta compares exactly two`,
        "validation",
      );
    }
  }
  const summary = result.summary;
  if (!isPlainObject(summary)) {
    throw new ArchitectureReaderError(reportPath, "carries no summary block", "validation");
  }
  const violations = bucketsOf(result.violations, "violations", reportPath);
  const unresolvable = bucketsOf(result.unresolvable, "unresolvable", reportPath);

  // The summary is the report counting itself. A disagreement here is the
  // envelope misstating its own payload — exactly the incoherence the
  // protocol refuses.
  const count = /** @param {unknown} v */ (v) => (isCount(v) ? v : null);
  const pairs = /** @type {[BucketName, number][]} */ ([
    ["introduced", violations.introduced.length],
    ["resolved", violations.resolved.length],
    ["unchanged", violations.unchanged.length],
    ["unknown", violations.unknown.length],
  ]);
  for (const [name, measured] of pairs) {
    if (count(summary[name]) !== measured) {
      throw new ArchitectureReaderError(
        reportPath,
        `summary.${String(name)} says ${JSON.stringify(String(summary[name]))} where the bucket holds ${String(measured)} — the report miscounts itself`,
        "validation",
      );
    }
  }
  const waivedCount = violations.introduced.filter(
    (item) => isPlainObject(item) && /** @type {Record<string, unknown>} */ (item).waived === true,
  ).length;
  if (count(summary.introducedWaived) !== waivedCount) {
    throw new ArchitectureReaderError(
      reportPath,
      `summary.introducedWaived says ${JSON.stringify(String(summary.introducedWaived))} where the introduced bucket waives ${String(waivedCount)} — the report miscounts itself`,
      "validation",
    );
  }
  const summaryUnresolvable = summary.unresolvable;
  if (!isPlainObject(summaryUnresolvable)) {
    throw new ArchitectureReaderError(
      reportPath,
      "carries no summary.unresolvable block — the protocol names all four counts",
      "validation",
    );
  }
  for (const [name] of pairs) {
    const held = unresolvable[name].length;
    if (count(summaryUnresolvable[name]) !== held) {
      throw new ArchitectureReaderError(
        reportPath,
        `summary.unresolvable.${String(name)} says ${JSON.stringify(String(summaryUnresolvable[name]))} where the bucket holds ${String(held)} — the report miscounts itself`,
        "validation",
      );
    }
  }

  // Custom-rule findings mirror their block: the summary counts them exactly
  // when the block is present, and never otherwise.
  const customRules = result.customRules;
  const customFindings = summary.customFindings;
  /** @type {Record<string, unknown> | null} */
  let customRulesNarrowed = null;
  if (customRules === undefined) {
    if (customFindings !== undefined) {
      throw new ArchitectureReaderError(
        reportPath,
        "counts custom findings in its summary without declaring a customRules block",
        "validation",
      );
    }
  } else {
    if (!isPlainObject(customRules)) {
      throw new ArchitectureReaderError(
        reportPath,
        "carries a customRules block that is not an object",
        "validation",
      );
    }
    const findings = customRules.findings;
    if (!isPlainObject(findings)) {
      throw new ArchitectureReaderError(
        reportPath,
        "carries a customRules block without a findings object",
        "validation",
      );
    }
    if (!isPlainObject(customFindings)) {
      throw new ArchitectureReaderError(
        reportPath,
        "declares a customRules block without counting it in summary.customFindings",
        "validation",
      );
    }
    for (const [name] of pairs) {
      const bucket = findings[name];
      if (!Array.isArray(bucket)) {
        throw new ArchitectureReaderError(
          reportPath,
          `carries a customRules.findings.${String(name)} bucket that is not an array`,
          "validation",
        );
      }
      if (count(customFindings[name]) !== bucket.length) {
        throw new ArchitectureReaderError(
          reportPath,
          `summary.customFindings.${String(name)} says ${JSON.stringify(String(customFindings[name]))} where the bucket holds ${String(bucket.length)} — the report miscounts itself`,
          "validation",
        );
      }
    }
    customRulesNarrowed = customRules;
  }
  return { result, violations, unresolvable, customRules: customRulesNarrowed };
}

/**
 * Narrows a four-bucket block (violations or unresolvable) to its arrays,
 * refusing any bucket the protocol names that the block omits.
 *
 * @param {unknown} block
 * @param {string} blockName
 * @param {string} reportPath
 * @returns {ViolationBuckets}
 */
function bucketsOf(block, blockName, reportPath) {
  if (!isPlainObject(block)) {
    throw new ArchitectureReaderError(
      reportPath,
      `carries no ${blockName} block — a verdict-carrying delta report always has one`,
      "validation",
    );
  }
  return {
    introduced: arrayBucket(block, "introduced", blockName, reportPath),
    resolved: arrayBucket(block, "resolved", blockName, reportPath),
    unchanged: arrayBucket(block, "unchanged", blockName, reportPath),
    unknown: arrayBucket(block, "unknown", blockName, reportPath),
  };
}

/**
 * One named bucket, narrowed to its array or refused.
 *
 * @param {Record<string, unknown>} block
 * @param {BucketName} name
 * @param {string} blockName
 * @param {string} reportPath
 * @returns {unknown[]}
 */
function arrayBucket(block, name, blockName, reportPath) {
  const entries = block[name];
  if (!Array.isArray(entries)) {
    throw new ArchitectureReaderError(
      reportPath,
      `carries no ${String(name)} ${blockName} bucket — the protocol names all four`,
      "validation",
    );
  }
  return entries;
}

// ── Normalization: recorded facts, defensively shaped ─────────────────────

/**
 * Normalizes a validated verdict-carrying envelope into the frozen evidence
 * shape, applying the staleness law on the way in. The delta semantics land
 * here: rename pairs over introduced×resolved identical sites, the waived
 * lane's full suppression row, attached occurrence-reduction facts, and the
 * reconciliation latch that makes normalization an identity over the
 * envelope's own arithmetic.
 *
 * @param {Record<string, unknown>} envelope
 * @param {DeltaPayload} payload
 * @param {ArchitectureExpect} expect
 * @param {string} digest
 * @param {string} reportPath
 * @returns {ArchitectureEvidence}
 */
function normalizeEvidence(envelope, payload, expect, digest, reportPath) {
  const { result, violations } = payload;
  const baseline = /** @type {Record<string, unknown>} */ (result.baseline);
  const head = /** @type {Record<string, unknown>} */ (result.head);
  const coverage = /** @type {Record<string, unknown>} */ (envelope.coverage);
  const workspace = /** @type {Record<string, unknown>} */ (envelope.workspace);

  const headProvenance = provenanceFacts(head.provenance);
  const stale = headProvenance.commit === null || headProvenance.commit !== expect.headSha;

  const introduced = violations.introduced.map(normalizeItem);
  const resolved = violations.resolved.map(normalizeItem);
  const unchanged = violations.unchanged.map(normalizeItem);

  /** @type {ArchitectureEvidence} */
  const evidence = {
    verdict: /** @type {"pass" | "fail" | "unknown"} */ (
      /** @type {Record<string, unknown>} */ (envelope.decision).verdict
    ),
    stale,
    incompleteness: null,
    provenance: {
      head: headProvenance,
      base: provenanceFacts(baseline.provenance),
    },
    policyChanged: /** @type {boolean} */ (result.policyChanged),
    provider: typeof workspace.provider === "string" ? workspace.provider : "",
    toolVersion: /** @type {string} */ (
      /** @type {Record<string, unknown>} */ (envelope.tool).version
    ),
    policyFingerprints: {
      head: typeof head.policyFingerprint === "string" ? head.policyFingerprint : null,
      base: typeof baseline.policyFingerprint === "string" ? baseline.policyFingerprint : null,
    },
    reportSha256: digest,
    introduced,
    resolved,
    unchangedCount: unchanged.length,
    introducedWaived: violations.introduced.filter(
      (item) =>
        isPlainObject(item) && /** @type {Record<string, unknown>} */ (item).waived === true,
    ).length,
    renamePairs: capped(detectRenamePairs(introduced, resolved), MAX_RENAME_PAIRS),
    customRules: normalizeCustomRules(payload.customRules),
    unresolvable: normalizeUnresolvable(payload.unresolvable),
    occurrencesReduced: capped(
      unchanged
        .filter((item) => item.note !== null)
        .map(
          (item) =>
            /** @type {OccurrenceReduction} */ ({
              messageId: item.messageId,
              sourceProject: item.sourceProject,
              target: item.target,
              note: /** @type {string} */ (item.note),
            }),
        ),
      MAX_OCCURRENCE_NOTES,
    ),
    coverage: {
      complete: /** @type {boolean} */ (coverage.complete),
      analyzedFiles: isCount(coverage.analyzedFiles) ? coverage.analyzedFiles : 0,
      notAnalyzedCount: Array.isArray(coverage.notAnalyzed) ? coverage.notAnalyzed.length : 0,
      blindSpotCount: Array.isArray(coverage.blindSpots) ? coverage.blindSpots.length : 0,
      notes: capped(stringArray(coverage.notes), MAX_COVERAGE_NOTES),
    },
  };

  assertNormalizationCoherent(evidence, payload, reportPath);

  // Staleness withholds: however coherent the bytes, evidence pinned to a
  // head this run does not review is unknown, and the note says where it is
  // pinned instead.
  if (stale) {
    evidence.verdict = "unknown";
    evidence.incompleteness = {
      reason: "stale",
      note:
        headProvenance.commit === null
          ? "the report records no head commit to pin against"
          : `the report is pinned to ${String(headProvenance.commit)} where this run reviews ${expect.headSha}`,
    };
  }
  return deepFreeze(evidence);
}

/**
 * Normalizes a validated no-verdict envelope — a run Archkeep itself refused
 * to judge. There is no result block to read: the recorded verdict is
 * `unknown`, the withholding reason is carried verbatim, and everything the
 * compare would have established is null. The run's own provenance (the
 * envelope's workspace block, not a compare side) still pins staleness.
 *
 * @param {Record<string, unknown>} envelope
 * @param {ArchitectureExpect} expect
 * @param {string} digest
 * @returns {ArchitectureEvidence}
 */
function normalizeNoVerdictEvidence(envelope, expect, digest) {
  const workspace = isPlainObject(envelope.workspace)
    ? /** @type {Record<string, unknown>} */ (envelope.workspace)
    : {};
  const headProvenance = provenanceFacts(workspace.provenance);
  const stale = headProvenance.commit === null || headProvenance.commit !== expect.headSha;
  const reason = /** @type {Record<string, unknown>} */ (envelope.decision).reason;
  const coverage = isPlainObject(envelope.coverage)
    ? /** @type {Record<string, unknown>} */ (envelope.coverage)
    : {};

  return deepFreeze(
    /** @type {ArchitectureEvidence} */
    ({
      verdict: "unknown",
      stale,
      incompleteness: {
        reason: stale ? "stale" : "incomplete",
        note: stale
          ? headProvenance.commit === null
            ? "the report records no head commit to pin against"
            : `the report is pinned to ${String(headProvenance.commit)} where this run reviews ${expect.headSha}`
          : `archkeep withheld its verdict: ${String(reason ?? "no reason recorded")}`,
      },
      provenance: {
        head: headProvenance,
        base: { commit: null, dirty: null },
      },
      policyChanged: null,
      provider: typeof workspace.provider === "string" ? workspace.provider : "",
      toolVersion: /** @type {string} */ (
        /** @type {Record<string, unknown>} */ (envelope.tool).version
      ),
      policyFingerprints: { head: null, base: null },
      reportSha256: digest,
      introduced: [],
      resolved: [],
      unchangedCount: 0,
      introducedWaived: 0,
      renamePairs: [],
      customRules: null,
      unresolvable: { introduced: 0, resolved: 0, unchanged: 0, unknown: 0 },
      occurrencesReduced: [],
      coverage: {
        complete: coverage.complete === true,
        analyzedFiles: isCount(coverage.analyzedFiles) ? coverage.analyzedFiles : 0,
        notAnalyzedCount: Array.isArray(coverage.notAnalyzed) ? coverage.notAnalyzed.length : 0,
        blindSpotCount: Array.isArray(coverage.blindSpots) ? coverage.blindSpots.length : 0,
        notes: capped(stringArray(coverage.notes), MAX_COVERAGE_NOTES),
      },
    }),
  );
}

/**
 * A git provenance fact, normalized defensively: unknown shapes record null
 * facts, never guessed ones.
 *
 * @param {unknown} provenance
 * @returns {ProvenanceFacts}
 */
function provenanceFacts(provenance) {
  if (!isPlainObject(provenance)) return { commit: null, dirty: null };
  return {
    commit: typeof provenance.commit === "string" ? provenance.commit : null,
    dirty: typeof provenance.dirty === "boolean" ? provenance.dirty : null,
  };
}

/**
 * One violation item, normalized to the identity facts, both counts and a
 * site sample. Leaf shapes the protocol does not headline are carried as
 * null rather than refused — the refusal surface stays exactly the frozen
 * one. The two deltas this reader refuses to coarsen: the constraint row is
 * carried structurally (it is identity), and a `waivedBy` row is carried
 * whole — the producer writes the covering suppression row verbatim, and an
 * acceptance is its path, its rule, its reason and its term, or it is not
 * the acceptance it claims to be.
 *
 * @param {unknown} item
 * @returns {EvidenceItem}
 */
function normalizeItem(item) {
  const entry = isPlainObject(item) ? item : {};
  const waivedBy = isPlainObject(entry.waivedBy) ? entry.waivedBy : null;
  return {
    messageId: textOrNull(entry.messageId),
    sourceProject: textOrNull(entry.sourceProject),
    target: textOrNull(entry.target),
    targetIsSpecifier: entry.targetIsSpecifier === true,
    constraint: normalizeConstraint(entry.constraint),
    waived: entry.waived === true,
    waivedBy:
      waivedBy === null
        ? null
        : {
            path: textOrNull(waivedBy.path),
            messageId: textOrNull(waivedBy.messageId),
            reason: textOrNull(waivedBy.reason),
            expiresAt: textOrNull(waivedBy.expiresAt),
          },
    baseCount: isCount(entry.baseCount) ? entry.baseCount : 0,
    headCount: isCount(entry.headCount) ? entry.headCount : 0,
    baseSites: normalizeSites(entry.baseSites),
    headSites: normalizeSites(entry.headSites),
    reason: textOrNull(entry.reason),
    note: textOrNull(entry.note),
  };
}

/**
 * The constraint row that fired, carried verbatim as a frozen deep copy —
 * anything that is not a plain object records null. The row is untrusted
 * evidence like every other fact here: copied and frozen, never interpreted.
 *
 * @param {unknown} constraint
 * @returns {ConstraintRow}
 */
function normalizeConstraint(constraint) {
  if (!isPlainObject(constraint)) return null;
  return deepFreeze(/** @type {ConstraintRow} */ (verbatimCopy(constraint)));
}

/**
 * A fresh deep copy of JSON-shaped content — plain objects and arrays kept,
 * volatile time-relative keys stripped, primitives passed through. Used only
 * for verbatim carries that must not alias untrusted input.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function verbatimCopy(value) {
  if (Array.isArray(value)) return value.map(verbatimCopy);
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === "sampleTime" || key.endsWith("Ms")) continue;
      copy[key] = verbatimCopy(nested);
    }
    return copy;
  }
  return value;
}

/**
 * A site sample: the well-formed {file, line} pairs, capped. A site without
 * both facts is not evidence and does not survive normalization.
 *
 * @param {unknown} sites
 * @returns {EvidenceSite[]}
 */
function normalizeSites(sites) {
  /** @type {EvidenceSite[]} */
  const kept = [];
  if (!Array.isArray(sites)) return kept;
  for (const site of sites) {
    if (kept.length >= MAX_SITES_PER_ITEM) break;
    if (!isPlainObject(site)) continue;
    const { file, line } = site;
    if (typeof file !== "string" || !isCount(line) || line < 1) continue;
    kept.push({ file, line });
  }
  return kept;
}

// ── Rename pairs: a move, never a wash ─────────────────────────────────────

/**
 * Pairs introduced and resolved entries that are one rename seen twice.
 * Archkeep's delta does no rename matching — a project or target rename
 * surfaces as one introduced entry at the new name and one resolved entry at
 * the old name — so the reader derives the pairing from recorded facts
 * alone: same violation identity, exactly one project identity field moved,
 * and byte-identical site sets with equal counts on the facing sides.
 *
 * Greedy one-to-one in report order: each introduced entry claims at most
 * the first unresolved match, and each resolved entry is claimed at most
 * once. Both raw buckets keep every entry verbatim — the pairing is
 * disclosure beside the arithmetic, never a netting of it.
 *
 * @param {EvidenceItem[]} introduced
 * @param {EvidenceItem[]} resolved
 * @returns {RenamePair[]}
 */
function detectRenamePairs(introduced, resolved) {
  /** @type {RenamePair[]} */
  const pairs = [];
  const claimed = new Set();
  for (const candidate of introduced) {
    // Only a fresh introduction can be the new-name side: an entry grown
    // from occurrences that already existed at base still has its old name
    // present at head, so its counterpart is unchanged, not resolved.
    if (candidate.baseCount !== 0) continue;
    let match = null;
    for (const [index, other] of resolved.entries()) {
      if (claimed.has(index)) continue;
      if (!isRenameOf(candidate, other)) continue;
      match = { index, other };
      break;
    }
    if (match === null) continue;
    claimed.add(match.index);
    pairs.push({ introduced: candidate, resolved: match.other });
  }
  return pairs;
}

/**
 * Whether an introduced entry and a resolved entry are one violation that
 * moved between names: same messageId, deep-equal constraint, same specifier
 * flag, exactly one of the two project identity fields renamed (the other
 * unchanged — both moving is not one rename), equal facing counts, and
 * identical non-empty site sets over the facing sides.
 *
 * @param {EvidenceItem} introduced
 * @param {EvidenceItem} resolved
 * @returns {boolean}
 */
function isRenameOf(introduced, resolved) {
  if (resolved.headCount !== 0) return false;
  if (introduced.messageId === null || introduced.messageId !== resolved.messageId) return false;
  if (!jsonEqual(introduced.constraint, resolved.constraint)) return false;
  if (introduced.targetIsSpecifier !== resolved.targetIsSpecifier) return false;
  const sourceRenamed =
    introduced.sourceProject !== null &&
    resolved.sourceProject !== null &&
    introduced.sourceProject !== resolved.sourceProject;
  const targetRenamed =
    introduced.target !== null && resolved.target !== null && introduced.target !== resolved.target;
  if (sourceRenamed === targetRenamed) return false;
  if (sourceRenamed && introduced.target !== resolved.target) return false;
  if (targetRenamed && introduced.sourceProject !== resolved.sourceProject) return false;
  if (introduced.headCount !== resolved.baseCount) return false;
  return sameSites(introduced.headSites, resolved.baseSites);
}

/**
 * Whether two site samples are the same set of file+line pairs — the
 * recorded facts of a rename are byte-identical sites, and an empty sample
 * cannot establish identity.
 *
 * @param {EvidenceSite[]} left
 * @param {EvidenceSite[]} right
 * @returns {boolean}
 */
function sameSites(left, right) {
  if (left.length === 0 || left.length !== right.length) return false;
  /** @param {EvidenceSite[]} sites */
  const keys = (sites) => new Set(sites.map((site) => `${site.file}:${String(site.line)}`));
  const leftKeys = keys(left);
  const rightKeys = keys(right);
  if (leftKeys.size !== rightKeys.size) return false;
  for (const key of leftKeys) {
    if (!rightKeys.has(key)) return false;
  }
  return true;
}

/**
 * Structural equality over JSON-shaped values, key order agnostic.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function jsonEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && jsonEqual(left[key], right[key]))
    );
  }
  return false;
}

// ── The reconciliation latch ───────────────────────────────────────────────

/**
 * Asserts that normalization was an identity over the envelope's own
 * arithmetic: every lane count equals its raw bucket, the waived count is
 * the introduced lane's own annotation count, the custom and unresolvable
 * facts equal their raw blocks, and every rename pair consumes a distinct
 * member of both raw buckets. Nothing here can disagree on an envelope the
 * validator admitted — it fires when this reader's own arithmetic is wrong,
 * and that failure is a typed refusal, never evidence.
 *
 * @param {ArchitectureEvidence} evidence
 * @param {DeltaPayload} payload
 * @param {string} reportPath
 * @returns {void}
 */
function assertNormalizationCoherent(evidence, payload, reportPath) {
  const { violations, unresolvable, customRules } = payload;
  const rawWaived = violations.introduced.filter(
    (item) => isPlainObject(item) && /** @type {Record<string, unknown>} */ (item).waived === true,
  ).length;
  const introducedMembers = new Set(evidence.introduced);
  const resolvedMembers = new Set(evidence.resolved);
  const pairedIntroduced = new Set(evidence.renamePairs.map((pair) => pair.introduced));
  const pairedResolved = new Set(evidence.renamePairs.map((pair) => pair.resolved));
  const evidenceCustom = evidence.customRules;
  let customCoherent = customRules === null && evidenceCustom === null;
  if (customRules !== null && evidenceCustom !== null && isPlainObject(customRules.findings)) {
    const findings = /** @type {Record<string, unknown>} */ (customRules.findings);
    customCoherent = /** @type {BucketName[]} */ ([
      "introduced",
      "resolved",
      "unchanged",
      "unknown",
    ]).every((name) => {
      const raw = findings[name];
      return Array.isArray(raw) && evidenceCustom.findings[name].count === raw.length;
    });
  }
  const coherent =
    evidence.introduced.length === violations.introduced.length &&
    evidence.resolved.length === violations.resolved.length &&
    evidence.unchangedCount === violations.unchanged.length &&
    evidence.introducedWaived === rawWaived &&
    evidence.unresolvable.introduced === unresolvable.introduced.length &&
    evidence.unresolvable.resolved === unresolvable.resolved.length &&
    evidence.unresolvable.unchanged === unresolvable.unchanged.length &&
    evidence.unresolvable.unknown === unresolvable.unknown.length &&
    customCoherent &&
    pairedIntroduced.size === evidence.renamePairs.length &&
    pairedResolved.size === evidence.renamePairs.length &&
    [...pairedIntroduced].every((item) => introducedMembers.has(item)) &&
    [...pairedResolved].every((item) => resolvedMembers.has(item));
  if (!coherent) {
    throw new ArchitectureReaderError(
      reportPath,
      "normalized into counts that do not reconcile with its own buckets — the reader's arithmetic failed and the evidence is withheld",
      "validation",
    );
  }
}

/**
 * The unresolvable counts — counts only. Rows Archkeep could not attribute
 * are never turned into findings by a consumer that cannot see them.
 *
 * @param {ViolationBuckets} unresolvable
 * @returns {UnresolvableCounts}
 */
function normalizeUnresolvable(unresolvable) {
  return {
    introduced: unresolvable.introduced.length,
    resolved: unresolvable.resolved.length,
    unchanged: unresolvable.unchanged.length,
    unknown: unresolvable.unknown.length,
  };
}

/**
 * The custom-rule findings as capped bucket facts — counts, rule ids and a
 * site sample — or null when the envelope declares none ran.
 *
 * @param {Record<string, unknown> | null} customRules
 * @returns {ArchitectureEvidence["customRules"]}
 */
function normalizeCustomRules(customRules) {
  if (customRules === null || !isPlainObject(customRules.findings)) return null;
  const findings = /** @type {Record<string, unknown>} */ (customRules.findings);
  return {
    findings: {
      introduced: normalizeCustomBucket(findings.introduced),
      resolved: normalizeCustomBucket(findings.resolved),
      unchanged: normalizeCustomBucket(findings.unchanged),
      unknown: normalizeCustomBucket(findings.unknown),
    },
  };
}

/**
 * One custom-rule bucket's capped facts. Rule ids come from `ruleId` on
 * classified entries and fall back to `rule` on entries the classifier could
 * not classify — both name the rule the finding belongs to, and an empty id
 * list for a non-empty bucket would hide which family spoke.
 *
 * @param {unknown} bucket
 * @returns {CustomRuleBucketFacts}
 */
function normalizeCustomBucket(bucket) {
  if (!Array.isArray(bucket)) return { count: 0, ruleIds: [], sites: [] };
  const entries = bucket
    .filter(isPlainObject)
    .map((entry) => /** @type {Record<string, unknown>} */ (entry));
  const ruleIds = [
    ...new Set(
      entries
        .map((entry) => {
          const id = textOrNull(entry.ruleId);
          return id !== null ? id : textOrNull(entry.rule);
        })
        .filter((id) => id !== null),
    ),
  ].sort();
  const sites = [];
  for (const entry of entries) {
    const headSites = normalizeSites(entry.headSites);
    const baseSites = normalizeSites(entry.baseSites);
    for (const site of headSites.length > 0 ? headSites : baseSites) {
      if (sites.length >= MAX_SITES_PER_BUCKET) break;
      sites.push(site);
    }
  }
  return { count: entries.length, ruleIds: capped(ruleIds, MAX_RULE_IDS_PER_BUCKET), sites };
}

// ── Small shared helpers ──────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A count: a non-negative integer, the only shape a counter may be.
 *
 * @param {unknown} value
 * @returns {value is number}
 */
function isCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function textOrNull(value) {
  return typeof value === "string" ? value : null;
}

/**
 * The string members of a list, in order — anything else is not a fact and
 * does not survive.
 *
 * @param {unknown} values
 * @returns {string[]}
 */
function stringArray(values) {
  if (!Array.isArray(values)) return [];
  return /** @type {string[]} */ (values.filter((value) => typeof value === "string"));
}

/**
 * @template T
 * @param {T[]} values
 * @param {number} cap
 * @returns {T[]}
 */
function capped(values, cap) {
  return values.length <= cap ? [...values] : values.slice(0, cap);
}

/**
 * Deep-freezes a value so evidence is immutable the moment it is built.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const element of value) deepFreeze(element);
    Object.freeze(value);
  } else if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Strips volatile, time-relative fields (`sampleTime`, `*Ms`) from a parsed
 * envelope, deeply, on a fresh copy — forward compatibility in the one
 * direction that cannot leak nondeterminism into evidence. The digest stays
 * over the raw bytes: the report is anchored as it was written, the evidence
 * is normalized as it is read.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!isPlainObject(value)) return value;
  /** @type {Record<string, unknown>} */
  const copy = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "sampleTime" || key.endsWith("Ms")) continue;
    copy[key] = stripVolatile(nested);
  }
  return copy;
}

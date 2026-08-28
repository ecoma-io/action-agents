/**
 * The machine-readable run artifact — the code's own record of what one
 * review decided. It exists so a downstream consumer (a CI gate, a dashboard,
 * this repository's own dogfood) can gate on the run's facts rather than parse
 * the prose comment a human reads.
 *
 * This module is pure: it builds and serialises the artifact from a declared,
 * validated `RunFacts` shape, and nothing else. It is not wired into the run —
 * a later task owns publication (writing the artifact as a workflow artifact
 * or a check-run output). The functions and types here are the contract that
 * publication will honour.
 *
 * Doctrine: every value in the artifact is a fact the code already computed —
 * the outcome classification, the findings with their identities, the verdicts
 * that bound to them, the strictness policy that governed the run, the coverage
 * summary and the phase log. No model-composed text enters beyond the
 * findings' own sanitised fields (sanitised upstream by `render.mjs` and the
 * verdict reason cap in `verify.mjs`); this module refuses fields that exceed
 * those documented caps rather than re-sanitise. Validation is fail-closed:
 * unknown keys, missing mandatory fields and verdict↔finding mismatches are
 * refused, never coerced.
 */

import { findingIdentity } from "./answer.mjs";
import { utf8Compare } from "./order.mjs";
import { MESSAGE_CHARS } from "./render.mjs";
import { VERDICT_REASON_CHARS } from "./verify.mjs";

/** The artifact schema this module emits. Bumped only on a breaking shape change. */
export const reviewArtifactSchemaVersion = 1;

const CLASSIFICATIONS = /** @type {const} */ (["published", "abandoned", "refused"]);
const STRICTNESS = /** @type {const} */ (["low", "medium", "high"]);
const STRATEGY = /** @type {const} */ (["standard", "adversarial"]);
const SEVERITIES = /** @type {const} */ (["concern", "nit"]);
const VERDICTS = /** @type {const} */ (["confirmed", "refuted", "uncertain"]);
const PHASES = /** @type {const} */ (["orient", "investigate", "verify", "conclude"]);
const HEAD_REF = /^[0-9a-f]{40}$/;

const FACTS_KEYS = new Set([
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "policy",
  "findings",
  "verdicts",
  "coverage",
  "phases",
  "provenance",
]);
const OUTCOME_KEYS = new Set(["classification", "reason"]);
const POLICY_KEYS = new Set(["strictness", "strategy"]);
const FINDING_KEYS = new Set(["id", "severity", "file", "line", "message"]);
const FINDING_MANDATORY = new Set(["severity", "file", "line", "message"]);
const VERDICT_KEYS = new Set(["id", "verdict", "reason"]);
const COVERAGE_KEYS = new Set(["total", "covered", "uncovered"]);
const PHASE_KEYS = new Set(["from", "to"]);
const PROVENANCE_KEYS = new Set(["commentId"]);
const EMPTY_SET = new Set();
const ARTIFACT_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "policy",
  "findings",
  "verdicts",
  "coverage",
  "phases",
  "provenance",
]);

/**
 * The outcome the code already classified for this run.
 *
 * @typedef {object} RunOutcome
 * @property {"published" | "abandoned" | "refused"} classification published wrote the comment; abandoned the subject moved mid-run; refused a code-owned guard fired (budget, prompt overflow, output contract)
 * @property {string} reason the code-composed sentence, uncapped — it is logged, not rendered
 */

/**
 * The strictness policy that governed the run. `strictness` is the config's arm;
 * `strategy` selects whether verification ran at all — a verdict column is
 * meaningless without it.
 *
 * @typedef {object} RunPolicy
 * @property {"low" | "medium" | "high"} strictness
 * @property {"standard" | "adversarial"} strategy
 */

/**
 * One finding as the builder accepts it. `id` is the plan-local identity
 * `verify.mjs` attaches (`"1"` upward, in findings order); it is present iff
 * the finding was put to the verifier.
 *
 * @typedef {object} ArtifactFinding
 * @property {string} [id]
 * @property {"concern" | "nit"} severity
 * @property {string} file repository-relative path, as the inventory spells it
 * @property {number} line 1-based line in the new file
 * @property {string} message sanitised upstream, capped at MESSAGE_CHARS
 */

/**
 * One verdict, bound to its finding by the shared plan-local id — the id the
 * code attached from the plan, never read out of the model's answer.
 *
 * @typedef {object} ArtifactVerdict
 * @property {string} id the plan-local id shared with the finding
 * @property {"confirmed" | "refuted" | "uncertain"} verdict
 * @property {string} reason sanitised upstream, capped at VERDICT_REASON_CHARS
 */

/**
 * The deterministic read-coverage summary — the expected set partitioned into
 * read and unread, each byte-wise sorted, totalling the expected set's size.
 *
 * @typedef {object} CoverageSummary
 * @property {number} total the expected set's size
 * @property {string[]} covered expected paths the ledger shows read, byte-wise sorted
 * @property {string[]} uncovered expected paths with no read on record, byte-wise sorted
 */

/**
 * One phase transition the loop logged.
 *
 * @typedef {object} PhaseLogEntry
 * @property {"orient" | "investigate" | "verify" | "conclude"} from
 * @property {"orient" | "investigate" | "verify" | "conclude"} to
 */

/**
 * Where the run's other records live — the artifact names them, it does not
 * duplicate them. `commentId` is the forge comment carrying the human-readable
 * record, present when the run wrote one.
 *
 * @typedef {object} Provenance
 * @property {number} [commentId]
 */

/**
 * The declared, validated input — everything a later publication step hands the
 * builder. Every field is a fact the run already computed; nothing here is
 * composed for the artifact.
 *
 * @typedef {object} RunFacts
 * @property {string} repository "owner/repo", as the forge names it
 * @property {number} pullRequest the pull request number
 * @property {string} headRef the reviewed head commit, full 40 hex chars
 * @property {RunOutcome} outcome
 * @property {RunPolicy} policy
 * @property {ArtifactFinding[]} findings the publication set; `id` present iff the finding was planned for verification
 * @property {ArtifactVerdict[]} verdicts one per verified finding, bound by the shared plan-local id
 * @property {CoverageSummary} coverage
 * @property {PhaseLogEntry[]} phases the transitions the loop logged, in order
 * @property {Provenance} provenance where the run's other records live
 */

/**
 * One finding in the artifact — its durable identity prepended.
 *
 * @typedef {object} RunArtifactFinding
 * @property {string} identity the code's finding identity (the same string `answer.mjs` uses for dedup)
 * @property {"concern" | "nit"} severity
 * @property {string} file
 * @property {number} line
 * @property {string} message
 */

/**
 * One verdict in the artifact, bound to its finding by the finding's identity.
 *
 * @typedef {object} RunArtifactVerdict
 * @property {string} findingIdentity the finding's durable identity
 * @property {"confirmed" | "refuted" | "uncertain"} verdict
 * @property {string} reason
 */

/**
 * The machine-readable artifact — deterministic and serialisable. Key order is
 * fixed by the builder; `serialiseArtifact` sorts keys so the bytes are stable
 * regardless of how the object was assembled.
 *
 * @typedef {object} RunArtifact
 * @property {typeof reviewArtifactSchemaVersion} schemaVersion
 * @property {string} repository
 * @property {number} pullRequest
 * @property {string} headRef
 * @property {RunOutcome} outcome
 * @property {RunPolicy} policy
 * @property {RunArtifactFinding[]} findings
 * @property {RunArtifactVerdict[]} verdicts
 * @property {CoverageSummary} coverage
 * @property {PhaseLogEntry[]} phases
 * @property {Provenance} provenance
 */

/**
 * The typed refusal. Every refusal this module raises is one of these, so a
 * caller can tell a malformed artifact input from any other failure — the same
 * posture as `phases.mjs`'s `PhaseError`.
 */
export class ArtifactError extends Error {
  /** @param {string} defect */
  constructor(defect) {
    super(defect);
    this.name = "ArtifactError";
  }
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function asRecord(v, label) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ArtifactError(`${label} must be a plain object — refused`);
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
    throw new ArtifactError(`${label} must be an array — refused`);
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
    throw new ArtifactError(`${label} must be a non-empty string — refused`);
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
    throw new ArtifactError(`${label} must be a string — refused`);
  }
  if (v.length === 0) {
    throw new ArtifactError(`${label} must be non-empty — refused`);
  }
  if (v.length > max) {
    throw new ArtifactError(`${label} exceeds the ${String(max)}-char documented cap — refused`);
  }
  return v;
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {number}
 */
function asPositiveInt(v, label) {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new ArtifactError(`${label} must be a positive integer — refused`);
  }
  return v;
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {number}
 */
function asNonNegInt(v, label) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new ArtifactError(`${label} must be a non-negative integer — refused`);
  }
  return v;
}

/**
 * @template {string} T
 * @param {unknown} v
 * @param {readonly T[]} vocab
 * @param {string} label
 * @returns {T}
 */
function asEnum(v, vocab, label) {
  if (typeof v !== "string") {
    throw new ArtifactError(`${label} must be a string — refused`);
  }
  for (const candidate of vocab) {
    if (candidate === v) {
      return candidate;
    }
  }
  throw new ArtifactError(`${label} '${v}' is outside the vocabulary — refused`);
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
      throw new ArtifactError(`${label} must contain only strings — refused`);
    }
  }
  return /** @type {string[]} */ (arr);
}

/**
 * @param {string[]} list
 * @param {string} label
 * @returns {void}
 */
function assertUtf8Sorted(list, label) {
  /** @type {string | undefined} */
  let prev;
  for (const current of list) {
    if (prev !== undefined && utf8Compare(prev, current) > 0) {
      throw new ArtifactError(`${label} must be byte-wise sorted — refused`);
    }
    prev = current;
  }
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
      throw new ArtifactError(`${label} has an unknown key '${key}' — refused`);
    }
  }
  for (const key of mandatory) {
    if (!(key in obj)) {
      throw new ArtifactError(`${label} is missing '${key}' — refused`);
    }
  }
}

/**
 * Builds the machine-readable artifact from declared, validated run facts.
 * Fail-closed: unknown keys, missing mandatory fields, verdict↔finding
 * mismatches and fields over their documented caps are refused as an
 * {@link ArtifactError}, never coerced.
 *
 * @param {RunFacts} runFacts
 * @returns {RunArtifact}
 */
export function buildArtifact(runFacts) {
  const facts = asRecord(runFacts, "run facts");
  assertExactKeys(facts, "run facts", FACTS_KEYS);

  const repository = asNonEmptyString(facts.repository, "run facts.repository");
  const pullRequest = asPositiveInt(facts.pullRequest, "run facts.pullRequest");
  const headRefRaw = asNonEmptyString(facts.headRef, "run facts.headRef");
  if (!HEAD_REF.test(headRefRaw)) {
    throw new ArtifactError("run facts.headRef must be a 40-char hex commit sha — refused");
  }
  const headRef = headRefRaw;

  const outcomeRec = asRecord(facts.outcome, "run facts.outcome");
  assertExactKeys(outcomeRec, "run facts.outcome", OUTCOME_KEYS);
  const classification = asEnum(
    outcomeRec.classification,
    CLASSIFICATIONS,
    "run facts.outcome.classification",
  );
  const reason = asNonEmptyString(outcomeRec.reason, "run facts.outcome.reason");

  const policyRec = asRecord(facts.policy, "run facts.policy");
  assertExactKeys(policyRec, "run facts.policy", POLICY_KEYS);
  const strictness = asEnum(policyRec.strictness, STRICTNESS, "run facts.policy.strictness");
  const strategy = asEnum(policyRec.strategy, STRATEGY, "run facts.policy.strategy");

  const findingsRaw = asArray(facts.findings, "run facts.findings");
  /** @type {RunArtifactFinding[]} */
  const findingsOut = [];
  /** @type {Map<string, string>} plan-local id → the finding's durable identity */
  const idToIdentity = new Map();
  /** @type {Set<string>} */
  const findingIds = new Set();
  for (let i = 0; i < findingsRaw.length; i += 1) {
    const raw = findingsRaw[i];
    if (raw === undefined) {
      throw new ArtifactError(`run facts.findings[${String(i)}] is missing — refused`);
    }
    const label = `run facts.findings[${String(i)}]`;
    const finding = asRecord(raw, label);
    assertExactKeys(finding, label, FINDING_KEYS, FINDING_MANDATORY);
    const severity = asEnum(finding.severity, SEVERITIES, `${label}.severity`);
    const file = asNonEmptyString(finding.file, `${label}.file`);
    const line = asPositiveInt(finding.line, `${label}.line`);
    const message = asBoundedString(finding.message, `${label}.message`, MESSAGE_CHARS);
    const validated = { severity, file, line, message };
    const identity = findingIdentity(validated);
    if ("id" in finding) {
      const id = asNonEmptyString(finding.id, `${label}.id`);
      if (findingIds.has(id)) {
        throw new ArtifactError(`${label} has a duplicate id '${id}' — refused`);
      }
      findingIds.add(id);
      idToIdentity.set(id, identity);
    }
    findingsOut.push({ identity, severity, file, line, message });
  }

  const verdictsRaw = asArray(facts.verdicts, "run facts.verdicts");
  /** @type {{ id: string, verdict: "confirmed" | "refuted" | "uncertain", reason: string }[]} */
  const verdictsTemp = [];
  /** @type {Set<string>} */
  const verdictIds = new Set();
  for (let i = 0; i < verdictsRaw.length; i += 1) {
    const raw = verdictsRaw[i];
    if (raw === undefined) {
      throw new ArtifactError(`run facts.verdicts[${String(i)}] is missing — refused`);
    }
    const label = `run facts.verdicts[${String(i)}]`;
    const verdict = asRecord(raw, label);
    assertExactKeys(verdict, label, VERDICT_KEYS);
    const id = asNonEmptyString(verdict.id, `${label}.id`);
    if (verdictIds.has(id)) {
      throw new ArtifactError(`${label} has a duplicate id '${id}' — refused`);
    }
    verdictIds.add(id);
    const verdictValue = asEnum(verdict.verdict, VERDICTS, `${label}.verdict`);
    const verdictReason = asBoundedString(verdict.reason, `${label}.reason`, VERDICT_REASON_CHARS);
    verdictsTemp.push({ id, verdict: verdictValue, reason: verdictReason });
  }

  // Cross-reference integrity, both directions: every verdict id binds to a
  // finding that carries it, and every finding id has a verdict. A graph that
  // does not close is refused, never mapped by guess.
  for (const entry of verdictsTemp) {
    if (!findingIds.has(entry.id)) {
      throw new ArtifactError(
        `a verdict names finding id '${entry.id}', which no finding carries — refused`,
      );
    }
  }
  for (const id of findingIds) {
    if (!verdictIds.has(id)) {
      throw new ArtifactError(`finding id '${id}' has no verdict — refused`);
    }
  }

  /** @type {RunArtifactVerdict[]} */
  const verdictsOut = verdictsTemp.map((entry) => ({
    findingIdentity: /** @type {string} */ (idToIdentity.get(entry.id)),
    verdict: entry.verdict,
    reason: entry.reason,
  }));

  const coverageRec = asRecord(facts.coverage, "run facts.coverage");
  assertExactKeys(coverageRec, "run facts.coverage", COVERAGE_KEYS);
  const total = asNonNegInt(coverageRec.total, "run facts.coverage.total");
  const covered = asStringList(coverageRec.covered, "run facts.coverage.covered");
  const uncovered = asStringList(coverageRec.uncovered, "run facts.coverage.uncovered");
  assertUtf8Sorted(covered, "run facts.coverage.covered");
  assertUtf8Sorted(uncovered, "run facts.coverage.uncovered");
  if (covered.length + uncovered.length !== total) {
    throw new ArtifactError("run facts.coverage does not partition the expected set — refused");
  }
  const coveredSet = new Set(covered);
  for (const path of uncovered) {
    if (coveredSet.has(path)) {
      throw new ArtifactError("run facts.coverage has a path both covered and uncovered — refused");
    }
  }

  const phasesRaw = asArray(facts.phases, "run facts.phases");
  /** @type {PhaseLogEntry[]} */
  const phases = [];
  for (let i = 0; i < phasesRaw.length; i += 1) {
    const raw = phasesRaw[i];
    if (raw === undefined) {
      throw new ArtifactError(`run facts.phases[${String(i)}] is missing — refused`);
    }
    const label = `run facts.phases[${String(i)}]`;
    const entry = asRecord(raw, label);
    assertExactKeys(entry, label, PHASE_KEYS);
    const from = asEnum(entry.from, PHASES, `${label}.from`);
    const to = asEnum(entry.to, PHASES, `${label}.to`);
    if (from === to) {
      throw new ArtifactError(`${label} is a no-op transition — refused`);
    }
    phases.push({ from, to });
  }

  const provenanceRec = asRecord(facts.provenance, "run facts.provenance");
  assertExactKeys(provenanceRec, "run facts.provenance", PROVENANCE_KEYS, EMPTY_SET);
  /** @type {Provenance} */
  const provenance = {};
  if ("commentId" in provenanceRec) {
    provenance.commentId = asPositiveInt(provenanceRec.commentId, "run facts.provenance.commentId");
  }

  /** @type {RunArtifact} */
  const artifact = {
    schemaVersion: reviewArtifactSchemaVersion,
    repository,
    pullRequest,
    headRef,
    outcome: { classification, reason },
    policy: { strictness, strategy },
    findings: findingsOut,
    verdicts: verdictsOut,
    coverage: { total, covered, uncovered },
    phases,
    provenance,
  };
  return deepFreeze(artifact);
}

/**
 * Serialises a {@link RunArtifact} to a stable JSON string. Keys are sorted, so
 * the bytes are identical regardless of how the object was assembled — the
 * builder's fixed key order is the only order there is. A foreign object (wrong
 * schema version, unknown or missing keys) is refused, not mis-serialised.
 *
 * @param {RunArtifact} artifact
 * @returns {string}
 */
export function serialiseArtifact(artifact) {
  const record = asRecord(artifact, "artifact");
  assertExactKeys(record, "artifact", ARTIFACT_KEYS);
  if (record.schemaVersion !== reviewArtifactSchemaVersion) {
    throw new ArtifactError(
      "artifact.schemaVersion does not match reviewArtifactSchemaVersion — refused",
    );
  }
  return stableStringify(record);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === undefined) {
    throw new ArtifactError("refuse to serialise an undefined value — refused");
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new ArtifactError("refuse to serialise a non-data value — refused");
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

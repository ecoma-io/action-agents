/**
 * The machine-readable run artifact — the code's own record of what one
 * review decided. It exists so a downstream consumer (a CI gate, a dashboard,
 * this repository's own dogfood) can gate on the run's facts rather than parse
 * the prose comment a human reads.
 *
 * The run builds it from the final run facts — the same set the comment is
 * rendered from — and the action writes the serialised JSON inside the
 * workspace, named after the reviewed head. The comment is the projection;
 * this file is the contract.
 *
 * Doctrine: every value in the artifact is a fact the code already computed —
 * the outcome classification, the findings with their identities, lifecycle
 * states, verdicts and evidence provenance, the strictness policy that
 * governed the run, the per-file risk lanes, the coverage summary, the phase
 * log and every declared gate's result. No model-composed text enters beyond
 * the findings' own sanitised fields (sanitised upstream by `render.mjs` and
 * the verdict reason cap in `verify.mjs`); this module refuses fields that
 * exceed those documented caps rather than re-sanitise. Validation is
 * fail-closed: unknown keys, missing mandatory fields, lifecycle↔verdict
 * mismatches and a verification gate that disagrees with the gate table are
 * refused, never coerced. A fact the run does not record stays absent — no
 * default is invented for it.
 */

import { findingIdentity, SEVERITIES } from "./answer.mjs";
import {
  APPLICABILITY_BASES,
  AUTHOR_PROVENANCES,
  EXECUTION_CONTEXTS,
  HEAD_PROVENANCES,
  POSTURES,
  STRICTNESS_ARMS,
} from "./applicability.mjs";
import { GATES } from "./gates.mjs";
import { PHASES } from "./phases.mjs";
import { STRATEGY } from "./vocabulary.mjs";
import { VERDICTS } from "./verify.mjs";
import { utf8Compare } from "./order.mjs";
import { MESSAGE_CHARS } from "./render.mjs";
import { isDigest } from "./digest.mjs";
import {
  EVIDENCE_EXCERPT_CHARS,
  LIFECYCLE_OF_VERDICT,
  PUBLISHED_LIFECYCLE_STATES,
  VERDICT_REASON_CHARS,
} from "./verify.mjs";

/** The artifact schema a run without an applicability fact emits. Bumped only on a breaking shape change. */
export const reviewArtifactSchemaVersion = 3;

/** The schema version once a run records an applicability fact — the full shape and the skipped shape alike. */
export const applicabilityArtifactSchemaVersion = 4;

/** @typedef {import("./risk.mjs").RiskLevel} RiskLevel */
/** @typedef {import("./lanes.mjs").AttentionLane} AttentionLane */
/** @typedef {import("./gates.mjs").GateName} GateName */
/** @typedef {import("./verify.mjs").PublishedLifecycle} PublishedLifecycle */

const CLASSIFICATIONS = /** @type {const} */ (["published", "abandoned", "refused"]);
const RISKS = /** @type {const} */ (["low", "medium", "high", "critical"]);
const ATTENTION_LANES = /** @type {const} */ (["deep", "standard", "skim"]);
const HEAD_REF = /^[0-9a-f]{40}$/;

const FACTS_KEYS = new Set([
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "policy",
  "risk",
  "findings",
  "verification",
  "gates",
  "coverage",
  "phases",
  "provenance",
]);
const OUTCOME_KEYS = new Set(["classification", "reason"]);
const POLICY_KEYS = new Set(["strictness", "strategy"]);
const RISK_KEYS = new Set(["path", "risk", "lane"]);
const FINDING_KEYS = new Set([
  "id",
  "severity",
  "file",
  "line",
  "message",
  "lifecycle",
  "verdict",
  "reason",
  "provenance",
  "evidence",
]);
const FINDING_MANDATORY = new Set(["severity", "file", "line", "message", "provenance"]);
const READ_KEYS = new Set(["path", "startLine", "endLine", "digest"]);
/** The evidence a bound verdict carries — exactly the digest and the bounded retention excerpt. */
const EVIDENCE_KEYS = new Set(["digest", "excerpt"]);
/** The skip-record vocabulary — which skip path wrote the record. */
const SKIP_KINDS = /** @type {const} */ (["state", "nothing-to-review"]);
const VERIFICATION_KEYS = new Set(["gate"]);
const GATE_OUTCOME_KEYS = new Set(["passed", "reason"]);
const GATE_OUTCOME_MANDATORY = new Set(["passed"]);
const GATE_RESULT_KEYS = new Set(["gate", "passed", "reason"]);
const GATE_RESULT_MANDATORY = new Set(["gate", "passed"]);
const COVERAGE_KEYS = new Set(["total", "covered", "uncovered"]);
const PHASE_KEYS = new Set(["from", "to"]);
const PROVENANCE_KEYS = new Set(["commentId", "context"]);
const EMPTY_SET = new Set();
const ARTIFACT_KEYS = new Set(["schemaVersion", ...FACTS_KEYS]);
const FACTS_KEYS_WITH_APPLICABILITY = new Set([...FACTS_KEYS, "applicability"]);
const APPLICABILITY_ARTIFACT_KEYS = new Set([...ARTIFACT_KEYS, "applicability"]);
const SKIPPED_ARTIFACT_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "applicability",
]);
/** The exact key set a skip record — the durable record for a path with no applicability fact — serialises with. */
const SKIP_RECORD_KEYS = new Set([
  "schemaVersion",
  "kind",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
]);
const APPLICABILITY_SECTION_KEYS = new Set([
  "context",
  "applicable",
  "posture",
  "intensity",
  "matchedRule",
  "basis",
  "inputs",
]);
const APPLICABILITY_INPUT_KEYS = new Set(["association", "head", "authorType"]);
/** The intensity section's one legal delta key. */
const INTENSITY_KEYS = new Set(["strictness"]);
/** A full-shape artifact describes a run that happened; a state skip never enters it. */
const FULL_SHAPE_BASES = /** @type {const} */ (["rule", "default"]);
/** The bases a skipped run can carry — the defaults decided nothing. */
const SKIPPED_SHAPE_BASES = /** @type {const} */ (["rule", "state"]);

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
 * One row of the per-file risk table, as the classifier and the lane
 * assignment recorded it before the loop ran. Config and classifier are the
 * only inputs; nothing the model said moved a file between lanes.
 *
 * @typedef {object} RiskRow
 * @property {string} path repository-relative path, as the inventory spells it
 * @property {RiskLevel} risk the classifier's risk for the path
 * @property {AttentionLane} lane the attention lane the path was assigned
 */

/**
 * The resolved read reference behind a finding's evidence — ledger data only,
 * never model text. The same record the provenance gate re-derives. The
 * digest makes the anchoring content-checkable: sha256 of the covering read's
 * content, fail-closed to isDigest shape.
 *
 * @typedef {object} FindingProvenance
 * @property {string} path the covering read's normalised path
 * @property {number} startLine the covering read's first captured line
 * @property {number} endLine the covering read's last captured line, inclusive
 * @property {string} digest sha256 (lowercase hex) of the covering read's content
 */

/**
 * One finding as the builder accepts it. `id` is the plan-local identity
 * `verify.mjs` attaches (`"1"` upward, in findings order); `lifecycle`,
 * `verdict` and `reason` ride along exactly as the verification pass left
 * them — a finding the strategy never planned carries none of the three, a
 * planned finding the ledger could not evidence carries `lifecycle:
 * "unresolved"` with its skip reason, and a bound verdict carries all three.
 * Every published finding is anchored: `provenance` is mandatory.
 *
 * @typedef {object} ArtifactFinding
 * @property {string} [id]
 * @property {PublishedLifecycle} [lifecycle]
 * @property {"confirmed" | "refuted" | "uncertain"} [verdict]
 * @property {string} [reason]
 * @property {"concern" | "nit"} severity
 * @property {string} file repository-relative path, as the inventory spells it
 * @property {number} line 1-based line in the new file
 * @property {string} message sanitised upstream, capped at MESSAGE_CHARS
 * @property {FindingProvenance} provenance the recorded read the finding anchors into
 * @property {{ digest: string, excerpt: string }} [evidence] a bound verdict's content-checkable evidence — digest and bounded retention excerpt
 */

/**
 * The verification gate's outcome, as the gate table recorded it.
 *
 * @typedef {object} GateOutcome
 * @property {boolean} passed
 * @property {string} [reason] why the gate refused — present only on a failure
 */

/**
 * One verdict, bound to its finding by the finding's durable identity — the
 * binding the code owns, never read out of the model's answer. A bound verdict
 * may carry the evidence the verifier judged: the digest and bounded excerpt.
 *
 * @typedef {object} RunArtifactVerdict
 * @property {string} findingIdentity the finding's durable identity
 * @property {"confirmed" | "refuted" | "uncertain"} verdict
 * @property {PublishedLifecycle} lifecycle
 * @property {string} reason
 * @property {{ digest: string, excerpt: string }} [evidence] the content-checkable digest and bounded retention excerpt
 */

/**
 * The verification facts a caller hands in: the gate outcome only. The
 * bound verdicts are never an input — they derive from the findings.
 *
 * @typedef {object} RunVerificationFacts
 * @property {GateOutcome} gate the verification gate's outcome
 */

/**
 * The verification section: the gate's outcome plus every bound verdict.
 * A planned finding left unresolved without a bound verdict (a skip, a lost
 * record) has no entry here — it carries its state on the finding itself,
 * and inventing a verdict for it is exactly what this schema refuses.
 *
 * @typedef {object} VerificationSection
 * @property {GateOutcome} gate the verification gate's outcome
 * @property {RunArtifactVerdict[]} verdicts the bound verdicts, in findings order
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
 * @property {number} [commentId] the review comment's database id
 * @property {string} [context] the execution context from the applicability fact, when present
 */
/**
 * The declared, validated input — everything the run hands the builder from
 * its final state. Every field is a fact the run already computed; nothing
 * here is composed for the artifact.
 *
 * @typedef {object} RunFacts
 * @property {string} repository "owner/repo", as the forge names it
 * @property {number} pullRequest the pull request number
 * @property {string} headRef the reviewed head commit, full 40 hex chars
 * @property {RunOutcome} outcome
 * @property {ApplicabilitySection} [applicability] the applicability fact when the policy is on
 * @property {RunPolicy} policy
 * @property {RiskRow[]} risk the per-file risk table, byte-wise sorted by path
 * @property {ArtifactFinding[]} findings the publication set, every finding anchored
 * @property {RunVerificationFacts} verification the verification gate's outcome — verdicts derive from the findings
 * @property {import("./gates.mjs").GateResult[]} gates every declared gate's result, in the declared order
 * @property {CoverageSummary} coverage
 * @property {PhaseLogEntry[]} phases the transitions the loop logged, in order
 * @property {Provenance} provenance where the run's other records live
 */

/**
 * One finding in the artifact — its durable identity prepended.
 *
 * @typedef {object} RunArtifactFinding
 * @property {string} identity the code's finding identity (the same string `answer.mjs` uses for dedup)
 * @property {PublishedLifecycle} [lifecycle] present iff the verification pass resolved the finding
 * @property {"confirmed" | "refuted" | "uncertain"} [verdict] present iff a verdict bound to the finding
 * @property {string} [reason] present iff the pass resolved the finding
 * @property {"concern" | "nit"} severity
 * @property {string} file
 * @property {number} line
 * @property {string} message
 * @property {FindingProvenance} provenance
 * @property {{ digest: string, excerpt: string }} [evidence] present iff a bound verdict carried the evidence it judged
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
 * @property {RiskRow[]} risk
 * @property {RunArtifactFinding[]} findings
 * @property {VerificationSection} verification
 * @property {import("./gates.mjs").GateResult[]} gates
 * @property {CoverageSummary} coverage
 * @property {PhaseLogEntry[]} phases
 * @property {Provenance} provenance
 */

/**
 * The applicability fact one run records — the derived context, the axis
 * decisions and the provenance the classification read. PR 1 shipped the
 * run axis; PR 2 the posture axis; PR 3 the intensity axis, so `intensity`
 * records the matched rule's strictness override as `{ strictness }` and
 * stays `{}` under the defaults — a declaration is absolute, so the
 * recorded value is the value the run ran under.
 *
 * @typedef {object} ApplicabilitySection
 * @property {import("./applicability.mjs").ExecutionContext} context the derived execution context
 * @property {boolean} applicable whether review ran, as the rule or default decided
 * @property {import("./applicability.mjs").Posture} posture the posture axis value the rule or default declared
 * @property {{} | { strictness: import("./applicability.mjs").RuleIntensity["strictness"] }} intensity the intensity axis value — `{ strictness }` under a declared override, `{}` under the defaults
 * @property {string | null} matchedRule the deciding rule's id, or null when the defaults decided
 * @property {import("./applicability.mjs").ApplicabilityBasis} basis where the decision's authority came from
 * @property {ApplicabilityInputs} inputs the provenance the classification read
 */

/**
 * The classification's own inputs, as the record carries them.
 *
 * @typedef {object} ApplicabilityInputs
 * @property {string} association the raw `author_association`, `"NONE"` when absent
 * @property {import("./applicability.mjs").HeadProvenance} head the head repository's provenance
 * @property {import("./applicability.mjs").AuthorProvenance} authorType the author's provenance
 */

/**
 * The reduced artifact a skipped run writes — the record IS the run's whole
 * outcome, so it names the skip and the applicability fact that decided it,
 * and nothing else. No policy, risk, findings or coverage: nothing was read
 * beyond the classification.
 *
 * @typedef {object} SkippedRunArtifact
 * @property {typeof applicabilityArtifactSchemaVersion} schemaVersion
 * @property {string} repository
 * @property {number} pullRequest
 * @property {string} headRef
 * @property {{ classification: "skipped", reason: string }} outcome
 * @property {ApplicabilitySection} applicability
 */

/**
 * The durable record for a skip path that leaves no applicability fact — the
 * code-owned state skip under no policy, and the empty universe. It rides the
 * applicability family's version constant (the ledger: skip records ride the
 * applicability family), names its kind, and carries the run identity plus the
 * outcome sentence. No findings, coverage or policy: nothing was read beyond
 * the classification — the same posture buildSkippedArtifact takes.
 *
 * @typedef {object} SkipRecord
 * @property {typeof applicabilityArtifactSchemaVersion} schemaVersion
 * @property {"state" | "nothing-to-review"} kind which skip path wrote the record
 * @property {string} repository
 * @property {number} pullRequest
 * @property {string} headRef
 * @property {{ classification: "skipped", reason: string }} outcome
 */

/** The schema-version-agnostic body the full shapes share. */
/** @typedef {Omit<RunArtifact, "schemaVersion">} PublishedArtifactBody */

/** The full artifact shape, carrying an applicability fact. */
/** @typedef {PublishedArtifactBody & { schemaVersion: typeof applicabilityArtifactSchemaVersion, applicability: ApplicabilitySection }} RunArtifactWithApplicability */

/** The full-shape artifact, with or without an applicability fact. */
/** @typedef {RunArtifact | RunArtifactWithApplicability} PublishedRunArtifact */

/** Every serialisable shape this module emits. */
/** @typedef {PublishedRunArtifact | SkippedRunArtifact | SkipRecord} AnyRunArtifact */

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
 * @param {unknown} v
 * @param {string} label
 * @returns {boolean}
 */
function asBoolean(v, label) {
  if (typeof v !== "boolean") {
    throw new ArtifactError(`${label} must be a boolean — refused`);
  }
  return v;
}

/**
 * Validates one verdict evidence record: exactly the keys `digest` and
 * `excerpt`, `isDigest(digest)`, a non-empty excerpt ≤ EVIDENCE_EXCERPT_CHARS
 * chars. Anything else is refused fail-closed.
 *
 * @param {unknown} v
 * @param {string} label
 * @returns {{ digest: string, excerpt: string }}
 */
function asVerdictEvidence(v, label) {
  const record = asRecord(v, label);
  assertExactKeys(record, label, EVIDENCE_KEYS);
  const digest = asNonEmptyString(record.digest, `${label}.digest`);
  if (!isDigest(digest)) {
    throw new ArtifactError(`${label}.digest is not a well-formed sha256 hex string — refused`);
  }
  const excerpt = asBoundedString(record.excerpt, `${label}.excerpt`, EVIDENCE_EXCERPT_CHARS);
  return { digest, excerpt };
}

/**
 * Validates one gate outcome — the shape both the verification slice and the
 * gate table's entries reduce to. A pass carries no reason; a refusal is
 * never silent.
 *
 * @param {unknown} v
 * @param {string} label
 * @returns {GateOutcome}
 */
function asGateOutcome(v, label) {
  const record = asRecord(v, label);
  assertExactKeys(record, label, GATE_OUTCOME_KEYS, GATE_OUTCOME_MANDATORY);
  const passed = asBoolean(record.passed, `${label}.passed`);
  if (passed && "reason" in record) {
    throw new ArtifactError(`${label} passed but carries a reason — refused`);
  }
  if (!passed && !("reason" in record)) {
    throw new ArtifactError(
      `${label} failed without a reason — a refusal is never silent — refused`,
    );
  }
  return passed
    ? { passed }
    : { passed, reason: asNonEmptyString(record.reason, `${label}.reason`) };
}

/**
 * Builds the machine-readable artifact from declared, validated run facts.
 * Fail-closed: unknown keys, missing mandatory fields, lifecycle↔verdict
 * mismatches, unclosed cross-references, a gate table that is not the
 * declared gates in the declared order, and fields over their documented
 * caps are refused as an {@link ArtifactError}, never coerced.
 *
 * @param {RunFacts} runFacts
 * @returns {RunArtifact}
 */
export function buildArtifact(runFacts) {
  const facts = asRecord(runFacts, "run facts");
  const hasApplicability = "applicability" in facts;
  assertExactKeys(
    facts,
    "run facts",
    hasApplicability ? FACTS_KEYS_WITH_APPLICABILITY : FACTS_KEYS,
  );

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
  const strictness = asEnum(policyRec.strictness, STRICTNESS_ARMS, "run facts.policy.strictness");
  const strategy = asEnum(policyRec.strategy, STRATEGY, "run facts.policy.strategy");

  const riskRaw = asArray(facts.risk, "run facts.risk");
  /** @type {RiskRow[]} */
  const riskRows = [];
  for (let i = 0; i < riskRaw.length; i += 1) {
    const raw = riskRaw[i];
    if (raw === undefined) {
      throw new ArtifactError(`run facts.risk[${String(i)}] is missing — refused`);
    }
    const label = `run facts.risk[${String(i)}]`;
    const row = asRecord(raw, label);
    assertExactKeys(row, label, RISK_KEYS);
    riskRows.push({
      path: asNonEmptyString(row.path, `${label}.path`),
      risk: asEnum(row.risk, RISKS, `${label}.risk`),
      lane: asEnum(row.lane, ATTENTION_LANES, `${label}.lane`),
    });
  }
  assertUtf8Sorted(
    riskRows.map((row) => row.path),
    "run facts.risk",
  );
  const riskPaths = new Set(riskRows.map((row) => row.path));
  if (riskPaths.size !== riskRows.length) {
    throw new ArtifactError("run facts.risk has a duplicated path — refused");
  }

  const findingsRaw = asArray(facts.findings, "run facts.findings");
  /** @type {RunArtifactFinding[]} */
  const findingsOut = [];
  /** @type {Map<string, string>} plan-local id → the finding's durable identity */
  const idToIdentity = new Map();
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
    const provenanceRec = asRecord(finding.provenance, `${label}.provenance`);
    assertExactKeys(provenanceRec, `${label}.provenance`, READ_KEYS);
    const startLine = asPositiveInt(provenanceRec.startLine, `${label}.provenance.startLine`);
    const endLine = asPositiveInt(provenanceRec.endLine, `${label}.provenance.endLine`);
    if (startLine > endLine) {
      throw new ArtifactError(
        `${label}.provenance captures no lines — startLine passes endLine — refused`,
      );
    }
    /** @type {FindingProvenance} */
    const provenance = {
      path: asNonEmptyString(provenanceRec.path, `${label}.provenance.path`),
      startLine,
      endLine,
      digest: asNonEmptyString(provenanceRec.digest, `${label}.provenance.digest`),
    };
    if (!isDigest(provenance.digest)) {
      throw new ArtifactError(
        `${label}.provenance.digest is not a well-formed sha256 hex string — refused`,
      );
    }
    const lifecycle =
      "lifecycle" in finding
        ? asEnum(finding.lifecycle, PUBLISHED_LIFECYCLE_STATES, `${label}.lifecycle`)
        : undefined;
    const verdict =
      "verdict" in finding ? asEnum(finding.verdict, VERDICTS, `${label}.verdict`) : undefined;
    const verdictReason =
      "reason" in finding
        ? asBoundedString(finding.reason, `${label}.reason`, VERDICT_REASON_CHARS)
        : undefined;

    // Lifecycle and its reason stand or fall together — the pass never
    // resolves a finding without saying why, and no unverified finding
    // carries either.
    if ((lifecycle === undefined) !== (verdictReason === undefined)) {
      throw new ArtifactError(
        `${label} carries a lifecycle without a reason, or a reason without a lifecycle — refused`,
      );
    }
    let id;
    if ("id" in finding) {
      id = asNonEmptyString(finding.id, `${label}.id`);
      if (idToIdentity.has(id)) {
        throw new ArtifactError(`${label} has a duplicate id '${id}' — refused`);
      }
      if (lifecycle === undefined) {
        throw new ArtifactError(
          `${label} carries a plan id but no lifecycle — a planned finding is never left a candidate — refused`,
        );
      }
    } else if (lifecycle !== undefined && lifecycle !== "unresolved") {
      throw new ArtifactError(
        `${label} carries lifecycle '${lifecycle}' with no plan id — only a skip's unresolved state survives without one — refused`,
      );
    }
    if (verdict !== undefined) {
      if (id === undefined || lifecycle === undefined || verdictReason === undefined) {
        throw new ArtifactError(
          `${label} carries a verdict without its bound id, lifecycle and reason — refused`,
        );
      }
      if (LIFECYCLE_OF_VERDICT[verdict] !== lifecycle) {
        throw new ArtifactError(
          `${label}.lifecycle '${lifecycle}' does not follow from verdict '${verdict}' — refused`,
        );
      }
    } else if (lifecycle === "confirmed" || lifecycle === "refuted") {
      throw new ArtifactError(
        `${label} carries lifecycle '${lifecycle}' with no verdict — refused`,
      );
    }
    let evidence;
    if ("evidence" in finding) {
      if (verdict === undefined) {
        throw new ArtifactError(
          `${label} carries evidence without a bound verdict — only a bound verdict records what it judged — refused`,
        );
      }
      evidence = asVerdictEvidence(finding.evidence, `${label}.evidence`);
    }

    const validated = { severity, file, line, message };
    const identity = findingIdentity(validated);
    if (id !== undefined) idToIdentity.set(id, identity);
    findingsOut.push({
      identity,
      severity,
      file,
      line,
      message,
      provenance,
      ...(lifecycle !== undefined ? { lifecycle } : {}),
      ...(verdict !== undefined ? { verdict } : {}),
      ...(verdictReason !== undefined ? { reason: verdictReason } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
    });
  }

  const verificationRec = asRecord(facts.verification, "run facts.verification");
  assertExactKeys(verificationRec, "run facts.verification", VERIFICATION_KEYS);
  const verificationGate = asGateOutcome(verificationRec.gate, "run facts.verification.gate");

  // The gate table: every declared gate, in the declared order, no gate
  // silent. A missing gate, an extra one or a reordered one is a code bug,
  // not a shorter table.
  const gatesRaw = asArray(facts.gates, "run facts.gates");
  if (gatesRaw.length !== GATES.length) {
    throw new ArtifactError(
      `run facts.gates holds ${String(gatesRaw.length)} entries, the declared set is ${String(GATES.length)} — refused`,
    );
  }
  /** @type {import("./gates.mjs").GateResult[]} */
  const gatesOut = [];
  for (let i = 0; i < gatesRaw.length; i += 1) {
    const raw = gatesRaw[i];
    if (raw === undefined) {
      throw new ArtifactError(`run facts.gates[${String(i)}] is missing — refused`);
    }
    const label = `run facts.gates[${String(i)}]`;
    const entry = asRecord(raw, label);
    assertExactKeys(entry, label, GATE_RESULT_KEYS, GATE_RESULT_MANDATORY);
    const gate = asEnum(entry.gate, GATES, `${label}.gate`);
    const expected = /** @type {GateName} */ (GATES[i]);
    if (gate !== expected) {
      throw new ArtifactError(
        `run facts.gates[${String(i)}] is '${gate}', the declared order puts '${expected}' there — refused`,
      );
    }
    const passed = asBoolean(entry.passed, `${label}.passed`);
    if (passed && "reason" in entry) {
      throw new ArtifactError(`${label} passed but carries a reason — refused`);
    }
    if (!passed && !("reason" in entry)) {
      throw new ArtifactError(
        `${label} failed without a reason — a refusal is never silent — refused`,
      );
    }
    gatesOut.push(
      passed
        ? { gate, passed }
        : { gate, passed, reason: asNonEmptyString(entry.reason, `${label}.reason`) },
    );
  }

  // The verification slice must agree with the gate table's verification
  // entry — one fact cannot wear two truth values.
  const tableVerification = gatesOut.find((result) => result.gate === "verification");
  if (tableVerification === undefined) {
    throw new ArtifactError("run facts.gates has no verification entry — refused");
  }
  if (
    tableVerification.passed !== verificationGate.passed ||
    tableVerification.reason !== verificationGate.reason
  ) {
    throw new ArtifactError(
      "run facts.verification.gate disagrees with the verification entry in the gate table — refused",
    );
  }

  // Verdicts derive from the findings themselves, so the ledger cannot
  // disagree with the rows it indexes: a bound verdict's identity, state and
  // reason are the finding's own.
  /** @type {RunArtifactVerdict[]} */
  const verdictsOut = [];
  for (const finding of findingsOut) {
    if (finding.verdict === undefined) continue;
    verdictsOut.push({
      findingIdentity: finding.identity,
      verdict: finding.verdict,
      lifecycle: /** @type {PublishedLifecycle} */ (finding.lifecycle),
      reason: /** @type {string} */ (finding.reason),
      ...(finding.evidence !== undefined ? { evidence: finding.evidence } : {}),
    });
  }

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
  if ("context" in provenanceRec) {
    provenance.context = asEnum(
      provenanceRec.context,
      EXECUTION_CONTEXTS,
      "run facts.provenance.context",
    );
  }
  const applicability = hasApplicability
    ? asApplicabilitySection(facts.applicability, FULL_SHAPE_BASES, false)
    : undefined;
  /** @type {RunArtifact} */
  const base = {
    schemaVersion: reviewArtifactSchemaVersion,
    repository,
    pullRequest,
    headRef,
    outcome: { classification, reason },
    policy: { strictness, strategy },
    risk: riskRows,
    findings: findingsOut,
    verification: { gate: verificationGate, verdicts: verdictsOut },
    gates: gatesOut,
    coverage: { total, covered, uncovered },
    phases,
    provenance,
  };
  const artifact =
    applicability !== undefined
      ? /** @type {RunArtifactWithApplicability} */ ({
          ...base,
          schemaVersion: applicabilityArtifactSchemaVersion,
          applicability,
        })
      : base;
  return deepFreeze(/** @type {RunArtifact} */ (artifact));
}

/**
 * Composes and validates the applicability fact a run records. `posture`
 * is the axis value the run evaluated to; `intensity` records a matched
 * rule's strictness override, `{}` under the defaults. Returns a frozen,
 * serialisable section.
 *
 * @param {object} fact the derived and evaluated applicability of one run
 * @param {import("./applicability.mjs").ExecutionContext} fact.context the derived execution context
 * @param {boolean} fact.applicable whether review runs
 * @param {import("./applicability.mjs").Posture} fact.posture the run's posture value
 * @param {{} | import("./applicability.mjs").RuleIntensity} [fact.intensity] the matched rule's strictness override, `{}` under the defaults
 * @param {string | null} fact.matchedRule the deciding rule's id, or null
 * @param {import("./applicability.mjs").ApplicabilityBasis} fact.basis the decision's authority
 * @param {ApplicabilityInputs} fact.inputs the classification's provenance
 * @returns {ApplicabilitySection}
 * @throws {ArtifactError} when any field is outside its vocabulary
 */
export function applicabilitySection({
  context,
  applicable,
  posture,
  intensity,
  matchedRule,
  basis,
  inputs,
}) {
  return asApplicabilitySection(
    { context, applicable, posture, intensity: intensity ?? {}, matchedRule, basis, inputs },
    APPLICABILITY_BASES,
    false,
  );
}

/**
 * Builds the reduced artifact a skipped run writes — the code-owned record
 * that review did not run and the applicability fact that decided it. The
 * record is the skip's whole outcome: exact keys, schemaVersion 3, and
 * nothing that was never read.
 *
 * @param {object} skip
 * @param {string} skip.repository "owner/repo", as the forge names it
 * @param {number} skip.pullRequest the pull request number
 * @param {string} skip.headRef the head the skip describes, full 40 hex chars
 * @param {string} skip.reason the code-composed sentence, uncapped
 * @param {ApplicabilitySection} skip.applicability the deciding applicability fact
 * @throws {ArtifactError} on any malformed field
 * @returns {SkippedRunArtifact}
 */
export function buildSkippedArtifact({ repository, pullRequest, headRef, reason, applicability }) {
  const repo = asNonEmptyString(repository, "skipped run.repository");
  const number = asPositiveInt(pullRequest, "skipped run.pullRequest");
  const ref = asNonEmptyString(headRef, "skipped run.headRef");
  if (!HEAD_REF.test(ref)) {
    throw new ArtifactError("skipped run.headRef must be a 40-char hex commit sha — refused");
  }
  asNonEmptyString(reason, "skipped run.reason");
  const section = asApplicabilitySection(applicability, SKIPPED_SHAPE_BASES, true);
  return deepFreeze({
    schemaVersion: applicabilityArtifactSchemaVersion,
    repository: repo,
    pullRequest: number,
    headRef: ref,
    outcome: { classification: "skipped", reason },
    applicability: section,
  });
}

/**
 * Builds the durable record for a skip path that leaves no applicability fact
 * — the code-owned state skip under no policy, and the empty universe. It
 * mirrors buildSkippedArtifact's validation posture: exact keys, a closed kind
 * vocabulary, the run identity fail-closed, and the code-composed reason
 * uncapped. Byte-deterministic: the same inputs yield the same object and the
 * same serialised bytes.
 *
 * @param {object} skip
 * @param {string} skip.repository "owner/repo", as the forge names it
 * @param {number} skip.pullRequest the pull request number
 * @param {string} skip.headRef the head the skip describes, full 40 hex chars
 * @param {string} skip.reason the code-composed sentence, uncapped
 * @param {"state" | "nothing-to-review"} skip.kind which skip path wrote the record
 * @throws {ArtifactError} on any malformed field
 * @returns {SkipRecord}
 */
export function buildSkipRecord({ repository, pullRequest, headRef, reason, kind }) {
  const repo = asNonEmptyString(repository, "skip record.repository");
  const number = asPositiveInt(pullRequest, "skip record.pullRequest");
  const ref = asNonEmptyString(headRef, "skip record.headRef");
  if (!HEAD_REF.test(ref)) {
    throw new ArtifactError("skip record.headRef must be a 40-char hex commit sha — refused");
  }
  asNonEmptyString(reason, "skip record.reason");
  const skipKind = asEnum(kind, SKIP_KINDS, "skip record.kind");
  return deepFreeze({
    schemaVersion: applicabilityArtifactSchemaVersion,
    kind: skipKind,
    repository: repo,
    pullRequest: number,
    headRef: ref,
    outcome: { classification: "skipped", reason },
  });
}

/**
 * Validates one applicability section, fail-closed. Beyond per-field
 * vocabulary it enforces the cross-field law: basis 'rule' names a rule and
 * only a rule decision does; a full-shape artifact refuses the state basis
 * (a state skip never becomes a review) and a skipped record refuses
 * `applicable: true` and the default basis (the defaults never skip); and
 * anything inapplicable rides the standard posture with an empty intensity —
 * a skipped run took neither.
 *
 * @param {unknown} v
 * @param {readonly import("./applicability.mjs").ApplicabilityBasis[]} allowBases the bases this shape may carry
 * @param {boolean} requireInapplicable whether `applicable: false` is mandatory here
 * @returns {ApplicabilitySection}
 */
function asApplicabilitySection(v, allowBases, requireInapplicable) {
  const section = asRecord(v, "applicability");
  assertExactKeys(section, "applicability", APPLICABILITY_SECTION_KEYS);
  const context = asEnum(section.context, EXECUTION_CONTEXTS, "applicability.context");
  const applicable = asBoolean(section.applicable, "applicability.applicable");
  const posture = asEnum(section.posture, POSTURES, "applicability.posture");
  /** @type {{ strictness?: import("./applicability.mjs").RuleIntensity["strictness"] }} */
  let intensity = {};
  const rawIntensity = asRecord(section.intensity, "applicability.intensity");
  assertExactKeys(rawIntensity, "applicability.intensity", INTENSITY_KEYS, EMPTY_SET);
  if (rawIntensity.strictness !== undefined) {
    intensity = {
      strictness: asEnum(
        rawIntensity.strictness,
        STRICTNESS_ARMS,
        "applicability.intensity.strictness",
      ),
    };
  }
  const basis = asEnum(section.basis, APPLICABILITY_BASES, "applicability.basis");
  if (!allowBases.includes(basis)) {
    throw new ArtifactError(`applicability basis '${basis}' cannot appear in this shape — refused`);
  }
  let matchedRule = null;
  if (section.matchedRule !== null) {
    matchedRule = asNonEmptyString(section.matchedRule, "applicability.matchedRule");
  }
  if (basis === "rule" && matchedRule === null) {
    throw new ArtifactError("applicability basis 'rule' without a matched rule — refused");
  }
  if (basis !== "rule" && matchedRule !== null) {
    throw new ArtifactError("only a rule decision names a matched rule — refused");
  }
  if (requireInapplicable && applicable) {
    throw new ArtifactError(
      "a skipped run's applicability must record applicable: false — refused",
    );
  }
  if (!applicable && posture !== "standard") {
    throw new ArtifactError(
      `applicability records no review under posture '${posture}' — a skipped run took no posture`,
    );
  }
  if (!applicable && intensity.strictness !== undefined) {
    throw new ArtifactError(
      "applicability records no review under a declared intensity — a skipped run took none",
    );
  }
  const inputs = asApplicabilityInputs(section.inputs);
  return deepFreeze({
    context,
    applicable,
    posture,
    intensity,
    matchedRule,
    basis,
    inputs,
  });
}

/**
 * @param {unknown} v
 * @returns {ApplicabilityInputs}
 */
function asApplicabilityInputs(v) {
  const inputs = asRecord(v, "applicability.inputs");
  assertExactKeys(inputs, "applicability.inputs", APPLICABILITY_INPUT_KEYS);
  return {
    association: asNonEmptyString(inputs.association, "applicability.inputs.association"),
    head: asEnum(inputs.head, HEAD_PROVENANCES, "applicability.inputs.head"),
    authorType: asEnum(inputs.authorType, AUTHOR_PROVENANCES, "applicability.inputs.authorType"),
  };
}

/**
 * The comment's newer-head rule, extended to the artifact: a snapshot that
 * names a head other than the one the pull request sits at is refused, never
 * written. A moved subject gets the run's abandoned outcome, the same way the
 * comment guard abandons instead of overwriting.
 *
 * @param {RunArtifact} artifact the built artifact
 * @param {string} headRef the head commit the forge reports for the pull request, full 40 hex chars
 * @returns {void}
 * @throws {ArtifactError} when the artifact's head ref does not match
 */
export function assertFreshArtifact(artifact, headRef) {
  // This guard runs on an artifact buildArtifact already validated; it reads
  // the head ref, it does not re-validate the shape.
  const record = asRecord(artifact, "artifact");
  const described = asNonEmptyString(record.headRef, "artifact.headRef");
  if (!HEAD_REF.test(described) || !HEAD_REF.test(headRef)) {
    throw new ArtifactError("a head ref must be a 40-char hex commit sha — refused");
  }
  if (described !== headRef) {
    throw new ArtifactError(
      `the artifact describes head '${described.slice(0, 12)}', but the pull request sits at ` +
        `'${headRef.slice(0, 12)}' — refusing to publish a stale snapshot`,
    );
  }
}

/**
 * Attaches the comment's identity to an artifact built before the comment
 * existed. `buildArtifact` runs before publication so every refusal it can
 * raise precedes anything irreversible; the one fact it cannot hold yet —
 * the identity of the comment the run went on to write — is attached here,
 * and the result serialises to exactly the bytes the post-comment build
 * would have produced.
 *
 * @param {RunArtifact} artifact the artifact `buildArtifact` returned, provenance still empty
 * @param {number} commentId the id the comment's upsert returned
 * @throws {ArtifactError} when the artifact already names a comment, or the id is not a positive integer
 */
export function withCommentId(artifact, commentId) {
  const record = asRecord(artifact, "artifact");
  const provenance = asRecord(record.provenance, "artifact.provenance");
  if ("commentId" in provenance) {
    throw new ArtifactError(
      "artifact.provenance already names a comment — refusing to attach a second one",
    );
  }
  const id = asPositiveInt(commentId, "commentId");
  const context = /** @type {{ applicability?: { context?: string } }} */ (artifact).applicability
    ?.context;
  return /** @type {RunArtifact} */ (
    deepFreeze({
      ...record,
      provenance: {
        ...provenance,
        commentId: id,
        ...(context !== undefined ? { context } : {}),
      },
    })
  );
}

/**
 * @param {Record<string, unknown>} obj
 * @param {ReadonlySet<string>} keys
 * @returns {boolean} whether obj's key set equals keys exactly
 */
function hasExactKeys(obj, keys) {
  const present = Object.keys(obj);
  return present.length === keys.size && present.every((key) => keys.has(key));
}

/**
 * Serialises an {@link AnyRunArtifact} to a stable JSON string. Keys are
 * sorted, so the bytes are identical regardless of how the object was
 * assembled — the builder's fixed key order is the only order there. A
 * foreign object (wrong schema version, unknown or missing keys) is
 * refused, not mis-serialised.
 *
 * @param {AnyRunArtifact} artifact
 * @returns {string}
 */
export function serialiseArtifact(artifact) {
  const record = asRecord(artifact, "artifact");
  if (record.schemaVersion === reviewArtifactSchemaVersion) {
    assertExactKeys(record, "artifact", ARTIFACT_KEYS);
  } else if (record.schemaVersion === applicabilityArtifactSchemaVersion) {
    // The applicability family's shapes: the full shape carrying an
    // applicability fact, the reduced shape a skipped run writes, and the
    // skip record a path with no applicability fact writes.
    if (
      !hasExactKeys(record, SKIPPED_ARTIFACT_KEYS) &&
      !hasExactKeys(record, APPLICABILITY_ARTIFACT_KEYS) &&
      !hasExactKeys(record, SKIP_RECORD_KEYS)
    ) {
      throw new ArtifactError("artifact keys fit no schema of this version — refused");
    }
  } else {
    throw new ArtifactError(
      "artifact.schemaVersion does not match a schema this module emits — refused",
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

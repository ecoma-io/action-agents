/**
 * The machine-readable run artifact — the code's own record of what one
 * review decided. It exists so a downstream consumer (a CI gate, a dashboard,
 * this repository's own dogfood) can gate on the run's facts rather than parse
 * the prose comment a human reads.
 *
 * The run builds it from the final run facts — the same set the comment is
 * rendered from — and the action writes the serialised JSON inside the
 * workspace, named after the reviewed head. The comment is the projection;
 * this file is the contract. A run that ends red before its own write site
 * still leaves one: the entrypoint's boundary writer builds the reduced
 * red-terminal artifact here (#355), so a failed run's account outlives its
 * runner log exactly a published one's does.
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

import { oneLine } from "#core/one-line.mjs";

import { findingIdentity, SEVERITIES } from "./answer.mjs";
import {
  APPLICABILITY_BASES,
  AUTHOR_PROVENANCES,
  EXECUTION_CONTEXTS,
  HEAD_PROVENANCES,
  POSTURES,
  STRICTNESS_ARMS,
} from "./applicability.mjs";
import { ARCHITECTURE_GATES, GATES, architectureEvidenceEstablished } from "./gates.mjs";
import { PHASES } from "./phases.mjs";
import { FINDING_KINDS, STRATEGY } from "./vocabulary.mjs";
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

/**
 * The artifact schema a run without an applicability fact emits. Bumped only on a breaking shape change.
 * Version 5 added the red-terminal shapes (#355): the `refused` and `failed` artifacts the run
 * boundary builds when the run ends red before its own write site — a vocabulary extension a
 * consumer pinned to 4 must be able to refuse, so the whole family re-stamps.
 */
export const reviewArtifactSchemaVersion = 5;

/**
 * The schema version once a run records an applicability fact — the full shape and the skipped
 * shape alike. Moves in lockstep with the bare family to keep the two numbers disjoint: the bare
 * family's 4 → 5 move (#355) pushes this 5 → 6, so an old applicability record stamped 5 can
 * never be mistaken for one of the new bare-family shapes.
 */
export const applicabilityArtifactSchemaVersion = 6;

/**
 * The artifact schema an architecture-aware run emits — one whose frozen evidence the record
 * carries (#529, frozen at 7/8 ahead of this code by #533). The same lockstep law, one numbering
 * space: the aware family sits above both of today's numbers so no number ever means two shapes,
 * and the two conditions — bare, and with an applicability fact — move together, 7 and 8. The
 * family is defined by what it carries: the architecture section, and (in the full shape) a
 * six-gate table with `architecture` appended after `verification`. Reduced shapes that carry no
 * architecture section — skips, abandonments, dry runs, and a red terminal whose run died before
 * the evidence read — keep their existing stamps exactly; a red terminal whose run held evidence
 * carries the section and joins this family.
 */
export const architectureArtifactSchemaVersion = 7;

/** The architecture family's stamp once the run also records an applicability fact. */
export const architectureApplicabilityArtifactSchemaVersion = 8;

/**
 * How many identity items each architecture detail list keeps — the retention row's fingerprint
 * class: identity and count persist, and the count stays exact, so a truncated list is disclosure
 * capped, never arithmetic changed. The full detail list rides the workflow artifact the report
 * digest names.
 */
export const MAX_ARCHITECTURE_IDENTITY_ITEMS = 32;

/** The documented cap one architecture identity field carries after flattening — a rule id, a project name. */
export const ARCHITECTURE_IDENTITY_CHARS = 200;

/** The documented cap one architecture target field carries after flattening — targets are paths, longer than names. */
export const ARCHITECTURE_TARGET_CHARS = 400;

/** @typedef {import("./risk.mjs").RiskLevel} RiskLevel */
/** @typedef {import("./lanes.mjs").AttentionLane} AttentionLane */
/** @typedef {import("./gates.mjs").GateName} GateName */
/** @typedef {import("./verify.mjs").PublishedLifecycle} PublishedLifecycle */

const CLASSIFICATIONS = /** @type {const} */ ([
  "published",
  "abandoned",
  "refused",
  "failed",
  "dry-run",
]);
/** The classifications a red-terminal artifact may carry — the boundary writer's two words. */
const RED_CLASSIFICATIONS = /** @type {const} */ (["refused", "failed"]);
/** The red artifact's reason cap — the one review reason that interpolates a thrown message, so it is sanitised and capped at its build site (I14). */
export const RED_REASON_CHARS = 300;
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
const POLICY_KEYS = new Set(["strictness", "strategy", "basis", "branch", "sha"]);
const RISK_KEYS = new Set(["path", "risk", "lane"]);
const FINDING_KEYS = new Set([
  "id",
  "severity",
  "kind",
  "file",
  "line",
  "message",
  "lifecycle",
  "verdict",
  "reason",
  "provenance",
  "evidence",
]);
const FINDING_MANDATORY = new Set(["severity", "kind", "file", "line", "message", "provenance"]);
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
const FACTS_KEYS_WITH_ARCHITECTURE = new Set([...FACTS_KEYS, "architecture"]);
const FACTS_KEYS_WITH_ARCHITECTURE_AND_APPLICABILITY = new Set([
  ...FACTS_KEYS,
  "architecture",
  "applicability",
]);
/** The exact key set the architecture family's full bare shape serialises with. */
const ARCHITECTURE_ARTIFACT_KEYS = new Set([...ARTIFACT_KEYS, "architecture"]);
/** The exact key set the architecture family's full shape with an applicability fact serialises with. */
const ARCHITECTURE_APPLICABILITY_ARTIFACT_KEYS = new Set([
  ...APPLICABILITY_ARTIFACT_KEYS,
  "architecture",
]);
const SKIPPED_ARTIFACT_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "policy",
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
  "policy",
]);
/**
 * The exact key set the retired merge-group skip record serialised with
 * (#412) — kept in the schema so a historic artifact file from before the
 * gate's retirement still serialises and validates; nothing builds it any
 * more. A queued group head is not a pull request, so the record named no
 * pull request and carried no policy section.
 */
const MERGE_GROUP_SKIP_KEYS = new Set([
  "schemaVersion",
  "kind",
  "repository",
  "headRef",
  "outcome",
]);
/** The exact key set an abandonment artifact without provenance or applicability — the record for a subject that moved before any write — serialises with. */
const ABANDONED_CORE_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
]);
/** The exact key set an abandonment artifact with provenance but no applicability — a comment was published before the head moved, no policy was active. */
const ABANDONED_WITH_PROVENANCE_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "provenance",
]);
/** The exact key set an abandonment artifact with applicability but no provenance — no comment was published, a policy was active. */
const ABANDONED_WITH_APPLICABILITY_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "applicability",
]);
/** The exact key set an abandonment artifact with both provenance and applicability — a comment was published before the head moved and a policy was active. */
const ABANDONED_FULL_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "provenance",
  "applicability",
]);
/** The exact key set a dry-run artifact without applicability serialises with. */
const DRY_RUN_CORE_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
]);
/** The exact key set a dry-run artifact with applicability serialises with. */
const DRY_RUN_WITH_APPLICABILITY_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "applicability",
]);
/** The exact key set a red-terminal artifact without provenance or applicability serialises with. */
const RED_CORE_KEYS = new Set(["schemaVersion", "repository", "pullRequest", "headRef", "outcome"]);
/** The exact key set a red-terminal artifact with provenance but no applicability — the run died red after its comment landed. */
const RED_WITH_PROVENANCE_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "provenance",
]);
/** The exact key set a red-terminal artifact with applicability but no provenance — the policy classification ran before the run died. */
const RED_WITH_APPLICABILITY_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "applicability",
]);
/** The exact key set a red-terminal artifact with both — a classified run that died red after its comment landed. */
const RED_FULL_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "provenance",
  "applicability",
]);
/** The exact key set a red-terminal artifact carrying the architecture section the run held when it died — the outage record's shape. */
const RED_WITH_ARCHITECTURE_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "architecture",
]);
/** Red, architecture and a comment that landed before the run died red. */
const RED_ARCHITECTURE_WITH_PROVENANCE_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "provenance",
  "architecture",
]);
/** Red, architecture and the applicability context a classified run derived before it died. */
const RED_ARCHITECTURE_WITH_APPLICABILITY_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "applicability",
  "architecture",
]);
/** Red with architecture, provenance and applicability — everything a classified, commenting, evidence-holding run had when it died. */
const RED_ARCHITECTURE_FULL_KEYS = new Set([
  "schemaVersion",
  "repository",
  "pullRequest",
  "headRef",
  "outcome",
  "provenance",
  "applicability",
  "architecture",
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
/** The architecture section's exact key set — the retention row's shape ([ADR 003](../../docs/adr/003-evidence-retention.md)). */
const ARCHITECTURE_SECTION_KEYS = new Set([
  "verdict",
  "stale",
  "unknownReason",
  "coverage",
  "policyChanged",
  "toolVersion",
  "reportDigest",
  "provenance",
  "policyFingerprints",
  "counts",
  "introduced",
  "resolved",
  "renamePairs",
  "customRules",
  "occurrencesReduced",
]);
const ARCHITECTURE_COVERAGE_KEYS = new Set([
  "complete",
  "analyzedFiles",
  "notAnalyzedCount",
  "blindSpotCount",
]);
const ARCHITECTURE_SIDE_KEYS = new Set(["commit"]);
const ARCHITECTURE_PROVENANCE_KEYS = new Set(["head", "base"]);
const ARCHITECTURE_FINGERPRINTS_KEYS = new Set(["head", "base"]);
const ARCHITECTURE_COUNTS_KEYS = new Set([
  "introduced",
  "introducedWaived",
  "resolved",
  "unchanged",
  "unresolvable",
]);
const ARCHITECTURE_INTRODUCED_KEYS = new Set([
  "messageId",
  "sourceProject",
  "target",
  "waived",
  "headCount",
  "decisionRef",
]);
const ARCHITECTURE_RESOLVED_KEYS = new Set(["messageId", "sourceProject", "target"]);
const ARCHITECTURE_RENAME_KEYS = new Set(["messageId", "from", "to"]);
const ARCHITECTURE_CUSTOM_KEYS = new Set(["findings"]);
const ARCHITECTURE_CUSTOM_BUCKET_KEYS = new Set(["count", "ruleIds"]);
const ARCHITECTURE_VERDICTS = /** @type {const} */ (["pass", "fail", "unknown"]);
const ARCHITECTURE_UNKNOWN_REASONS = /** @type {const} */ (["stale", "incomplete"]);
/** How many rule ids one custom-rule bucket's identity list keeps — the reader already capped it; the section keeps the cap honest. */
const MAX_ARCHITECTURE_RULE_IDS = 16;
/** A full-shape artifact describes a run that happened; a state skip never enters it. */
const FULL_SHAPE_BASES = /** @type {const} */ (["rule", "default"]);
/** The bases a skipped run can carry — the defaults decided nothing. */
const SKIPPED_SHAPE_BASES = /** @type {const} */ (["rule", "state"]);

/**
 * The outcome the code already classified for this run.
 *
 * @typedef {object} RunOutcome
 * @property {"published" | "abandoned" | "refused" | "failed" | "dry-run"} classification published wrote the comment; abandoned the subject moved mid-run; refused a code-owned guard fired — the typed deterministic refusal the boundary records (budget, prompt overflow, output contract, config validator, posture document) (#355); failed an undeclared throw the boundary records — a transport break, a defect; dry-run the run was under the dry-run flag
 * @property {string} reason the code-composed sentence, uncapped — it is logged, not rendered
 */

/**
 * The strictness policy that governed the run. `strictness` is the config's arm;
 * `strategy` selects whether verification ran at all — a verdict column is
 * meaningless without it. `basis`, `branch` and `sha` pin the policy source
 * so a stale record is detectable against the governance branch's current tip.
 *
 * @typedef {object} RunPolicy
 * @property {"low" | "medium" | "high"} strictness
 * @property {"standard" | "adversarial"} strategy
 * @property {"default" | "base" | "pushed" | "dispatched"} basis
 * @property {string} branch
 * @property {string} sha
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
 * @property {import("./vocabulary.mjs").FindingKind} kind the finding's claim domain
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
 * @property {ArchitectureSection} [architecture] the retention-shaped architecture record when the run held evidence — selects the 7/8 family and the six-gate table
 * @property {RunPolicy} policy
 * @property {RiskRow[]} risk the per-file risk table, byte-wise sorted by path
 * @property {ArtifactFinding[]} findings the publication set, every finding anchored
 * @property {RunVerificationFacts} verification the verification gate's outcome — verdicts derive from the findings
 * @property {import("./gates.mjs").GateResult[]} gates every declared gate's result, in the declared order — the architecture family's six, when the section is present
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
 * @property {import("./vocabulary.mjs").FindingKind} kind
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
 * The architecture evidence's retention-shaped record — what [ADR 003](../../docs/adr/003-evidence-retention.md)
 * says the artifact may keep of the report: the decision basis persists (verdict,
 * stale flag, digests, commits, fingerprints, counts, `policyChanged`), the
 * detail lists persist as identity and count (the full site lists ride the
 * workflow artifact the report digest names), and no model text exists to
 * keep. Every field is a fact the frozen reader established; producer-derived
 * strings arrive flattened and capped by the section builder, never raw.
 *
 * @typedef {object} ArchitectureSection
 * @property {"pass" | "fail" | "unknown"} verdict the reader's recorded verdict — stale and incomplete runs record `unknown`
 * @property {boolean} stale whether the head provenance failed to pin to the reviewed head
 * @property {"stale" | "incomplete" | null} unknownReason why an `unknown` verdict is not a judgement — null when the verdict was established
 * @property {{ complete: boolean, analyzedFiles: number, notAnalyzedCount: number, blindSpotCount: number }} coverage counts beside the verdict, so a `fail` is never mistaken for fully read
 * @property {boolean | null} policyChanged whether the two sides' policy fingerprints differ — null when never assessed
 * @property {string | null} toolVersion the Archkeep version the envelope names
 * @property {string | null} reportDigest sha256 over the raw report bytes — the workflow artifact's name
 * @property {{ head: { commit: string | null }, base: { commit: string | null } }} provenance both sides of the compare
 * @property {{ head: string | null, base: string | null }} policyFingerprints both sides' policy fingerprints
 * @property {{ introduced: number, introducedWaived: number, resolved: number, unchanged: number, unresolvable: { introduced: number, resolved: number, unchanged: number, unknown: number } }} counts the exact bucket arithmetic — never netted, never truncated
 * @property {{ messageId: string | null, sourceProject: string | null, target: string | null, waived: boolean, headCount: number, decisionRef: string | null }[]} introduced identity and count per introduced item, capped at {@link MAX_ARCHITECTURE_IDENTITY_ITEMS} — `decisionRef` is the constraint row's cited record when it carries one, the one field that tells an intentional evolution from a plain violation
 * @property {{ messageId: string | null, sourceProject: string | null, target: string | null }[]} resolved identity per resolved item, capped the same way
 * @property {{ messageId: string | null, from: string | null, to: string | null }[]} renamePairs each derived move — one item, both names; the wash this fact exists to prevent
 * @property {{ findings: { introduced: { count: number, ruleIds: string[] }, resolved: { count: number, ruleIds: string[] }, unchanged: { count: number, ruleIds: string[] }, unknown: { count: number, ruleIds: string[] } } } | null} customRules per-bucket counts and rule ids — null when the envelope declared none
 * @property {number} occurrencesReduced how many unchanged entries shrank without resolving
 */

/**
 * The reduced artifact a skipped run writes — the record IS the run's whole
 * outcome, so it names the skip and the applicability fact that decided it,
 * and the policy pin so a stale record is detectable. No risk, findings or
 * coverage: nothing was read beyond the classification.
 *
 * @typedef {object} SkippedRunArtifact
 * @property {typeof applicabilityArtifactSchemaVersion} schemaVersion
 * @property {string} repository
 * @property {number} pullRequest
 * @property {string} headRef
 * @property {{ classification: "skip", reason: string }} outcome
 * @property {RunPolicy} policy
 * @property {ApplicabilitySection} applicability
 */

/**
 * The durable record for a skip path that leaves no applicability fact — the
 * code-owned state skip under no policy, and the empty universe. It rides the
 * applicability family's version constant (the ledger: skip records ride the
 * applicability family), names its kind, and carries the run identity, the
 * outcome sentence and the policy pin so a stale record is detectable. No
 * findings or coverage: nothing was read beyond the classification — the same
 * posture buildSkippedArtifact takes.
 *
 * @typedef {object} SkipRecord
 * @property {typeof applicabilityArtifactSchemaVersion} schemaVersion
 * @property {"state" | "nothing-to-review"} kind which skip path wrote the record
 * @property {string} repository
 * @property {number} pullRequest
 * @property {string} headRef
 * @property {{ classification: "skip", reason: string }} outcome
 * @property {RunPolicy} policy
 */

/** The schema-version-agnostic body the full shapes share. */
/** @typedef {Omit<RunArtifact, "schemaVersion">} PublishedArtifactBody */

/** The full artifact shape, carrying an applicability fact. */
/** @typedef {PublishedArtifactBody & { schemaVersion: typeof applicabilityArtifactSchemaVersion, applicability: ApplicabilitySection }} RunArtifactWithApplicability */

/** The architecture family's full bare shape — six-gate table, architecture section, no applicability fact. */
/** @typedef {PublishedArtifactBody & { schemaVersion: typeof architectureArtifactSchemaVersion, architecture: ArchitectureSection }} ArchitectureRunArtifact */

/** The architecture family's full shape with an applicability fact. */
/** @typedef {PublishedArtifactBody & { schemaVersion: typeof architectureApplicabilityArtifactSchemaVersion, architecture: ArchitectureSection, applicability: ApplicabilitySection }} ArchitectureRunArtifactWithApplicability */

/** The full-shape artifact, with or without an applicability fact. */
/** @typedef {RunArtifact | RunArtifactWithApplicability} PublishedRunArtifact */

/**
 * The reduced artifact an abandoned run writes — the subject moved mid-run, so
 * the record names the identity and the outcome. No policy, risk, findings or
 * coverage: nothing was read beyond the classification. `provenance` carries the
 * comment id when the run wrote a comment before the head moved.
 *
 * @typedef {object} AbandonedRunArtifact
 * @property {typeof reviewArtifactSchemaVersion} schemaVersion
 * @property {string} repository
 * @property {number} pullRequest
 * @property {string} headRef
 * @property {{ classification: "abandoned", reason: string }} outcome
 * @property {import("./applicability.mjs").ExecutionContext} [applicability] the applicability fact's context, when the policy is on
 * @property {{ commentId?: number }} [provenance] the comment identity when the run wrote one before the abandonment
 */

/**
 * The reduced artifact a dry-run writes — the record names the identity and the
 * outcome. No policy, risk, findings or coverage: nothing was read beyond the
 * classification.
 *
 * @typedef {object} DryRunRunArtifact
 * @property {typeof reviewArtifactSchemaVersion} schemaVersion
 * @property {string} repository
 * @property {number} pullRequest
 * @property {string} headRef
 * @property {{ classification: "dry-run", reason: string }} outcome
 * @property {import("./applicability.mjs").ExecutionContext} [applicability] the applicability fact's context, when the policy is on
 */

/**
 * The reduced artifact a red run's boundary writes (#355) — the record for a
 * run that ended red before its own write site, so it names only the
 * identity and the outcome the throw's class decides. `headRef` is the
 * honest `null` of a run that died before the snapshot read; `provenance`
 * carries the comment id when one landed before the run died red; the
 * applicability context rides along when the policy classification ran. No
 * policy, risk, findings or coverage: the classification vocabulary those
 * sections serve never reached a terminal point.
 *
 * @typedef {object} RedRunArtifact
 * @property {typeof reviewArtifactSchemaVersion | typeof architectureArtifactSchemaVersion | typeof architectureApplicabilityArtifactSchemaVersion} schemaVersion — 5 for the blind shapes, 7/8 when the record carries the architecture section the run held when it died
 * @property {string} repository
 * @property {number} pullRequest
 * @property {string | null} headRef the head the run pinned to, or null before the snapshot read
 * @property {{ classification: "refused" | "failed", reason: string }} outcome the classification the throw's class decided; the reason is sanitised and capped at the build site — the one review reason that interpolates a thrown message
 * @property {import("./applicability.mjs").ExecutionContext} [applicability] the applicability fact's context, when the policy was active
 * @property {{ commentId?: number }} [provenance] the comment identity when one landed before the run died red — a `failed` record's shape only; a `refused` record never names a comment
 * @property {ArchitectureSection} [architecture] the retention-shaped architecture record, when the evidence read completed before the run died red — the outage rule: evidence lands in the red record too
 */

/** Every serialisable shape this module emits. */
/** @typedef {PublishedRunArtifact | ArchitectureRunArtifact | ArchitectureRunArtifactWithApplicability | SkippedRunArtifact | SkipRecord | AbandonedRunArtifact | DryRunRunArtifact | RedRunArtifact} AnyRunArtifact */

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
  const hasArchitecture = "architecture" in facts;
  assertExactKeys(
    facts,
    "run facts",
    hasArchitecture && hasApplicability
      ? FACTS_KEYS_WITH_ARCHITECTURE_AND_APPLICABILITY
      : hasArchitecture
        ? FACTS_KEYS_WITH_ARCHITECTURE
        : hasApplicability
          ? FACTS_KEYS_WITH_APPLICABILITY
          : FACTS_KEYS,
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
  const policyBasis = asEnum(
    policyRec.basis,
    /** @type {const} */ (["default", "base", "pushed", "dispatched"]),
    "run facts.policy.basis",
  );
  const policyBranch = asNonEmptyString(policyRec.branch, "run facts.policy.branch");
  const policySha = asNonEmptyString(policyRec.sha, "run facts.policy.sha");
  if (!HEAD_REF.test(policySha)) {
    throw new ArtifactError("run facts.policy.sha must be a 40-char hex commit sha — refused");
  }

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
    const kind = asEnum(finding.kind, FINDING_KINDS, `${label}.kind`);
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
      kind,
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
  // not a shorter table. The declared set is the family's: the architecture
  // section the facts carry selects the six-gate table — the gate couples to
  // the family, never to the input, so an architecture-aware run's table
  // always holds all six and a blind run's always the five.
  const declared = hasArchitecture ? ARCHITECTURE_GATES : GATES;
  const gatesRaw = asArray(facts.gates, "run facts.gates");
  if (gatesRaw.length !== declared.length) {
    throw new ArtifactError(
      `run facts.gates holds ${String(gatesRaw.length)} entries, the declared set is ${String(declared.length)} — refused`,
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
    const gate = asEnum(entry.gate, declared, `${label}.gate`);
    const expected = /** @type {GateName} */ (declared[i]);
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

  // The architecture section, validated here so a malformed section refuses
  // the artifact before anything publishes — and its gate entry must agree
  // with the facts the section itself records: the predicate is a function
  // of the recorded basis, never an independent opinion.
  const architecture = hasArchitecture
    ? asArchitectureSection(facts.architecture, "run facts.architecture")
    : undefined;
  if (architecture !== undefined) {
    const tableArchitecture = gatesOut.find((result) => result.gate === "architecture");
    if (tableArchitecture === undefined) {
      throw new ArtifactError("run facts.gates has no architecture entry — refused");
    }
    if (
      tableArchitecture.passed !==
      architectureEvidenceEstablished({
        verdict: architecture.verdict,
        stale: architecture.stale,
        pinnedHead: architecture.provenance.head.commit,
        headSha: headRef,
      })
    ) {
      throw new ArtifactError(
        "run facts.gates' architecture entry disagrees with the section the artifact records — refused",
      );
    }
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
    policy: { strictness, strategy, basis: policyBasis, branch: policyBranch, sha: policySha },
    ...(architecture !== undefined ? { architecture } : {}),
    risk: riskRows,
    findings: findingsOut,
    verification: { gate: verificationGate, verdicts: verdictsOut },
    gates: gatesOut,
    coverage: { total, covered, uncovered },
    phases,
    provenance,
  };
  const artifact =
    architecture === undefined && applicability !== undefined
      ? /** @type {RunArtifactWithApplicability} */ ({
          ...base,
          schemaVersion: applicabilityArtifactSchemaVersion,
          applicability,
        })
      : architecture !== undefined && applicability === undefined
        ? /** @type {ArchitectureRunArtifact} */ ({
            ...base,
            schemaVersion: architectureArtifactSchemaVersion,
          })
        : architecture !== undefined && applicability !== undefined
          ? /** @type {ArchitectureRunArtifactWithApplicability} */ ({
              ...base,
              schemaVersion: architectureApplicabilityArtifactSchemaVersion,
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
 * Reduces the frozen evidence into the retention-shaped architecture section
 * — the one constructor a run's records share, so the artifact, the comment's
 * embedded record and the run result all name the same facts by construction.
 * The reduction is total over evidence the reader froze: producer-derived
 * strings are flattened and capped here (identity fields at their documented
 * caps, control characters gone, one line), never refused — the evidence
 * itself is already validated, and a record field that cannot carry a
 * producer's over-long name truncates deterministically while the counts stay
 * exact. The detail lists keep at most {@link MAX_ARCHITECTURE_IDENTITY_ITEMS}
 * identity items; the exact arithmetic rides `counts`, and the full detail
 * lives in the workflow artifact `reportDigest` names.
 *
 * @param {import("#core/architecture.mjs").ArchitectureEvidence} evidence the frozen reader's output
 * @returns {ArchitectureSection}
 */
export function architectureSection(evidence) {
  return asArchitectureSection(
    {
      verdict: evidence.verdict,
      stale: evidence.stale,
      unknownReason: evidence.incompleteness === null ? null : evidence.incompleteness.reason,
      coverage: {
        complete: evidence.coverage.complete,
        analyzedFiles: evidence.coverage.analyzedFiles,
        notAnalyzedCount: evidence.coverage.notAnalyzedCount,
        blindSpotCount: evidence.coverage.blindSpotCount,
      },
      policyChanged: evidence.policyChanged,
      toolVersion: boundedFact(evidence.toolVersion, ARCHITECTURE_IDENTITY_CHARS),
      reportDigest: evidence.reportSha256,
      provenance: {
        head: { commit: evidence.provenance.head.commit },
        base: { commit: evidence.provenance.base.commit },
      },
      policyFingerprints: {
        head: boundedFact(evidence.policyFingerprints.head, ARCHITECTURE_TARGET_CHARS),
        base: boundedFact(evidence.policyFingerprints.base, ARCHITECTURE_TARGET_CHARS),
      },
      counts: {
        introduced: evidence.introduced.length,
        introducedWaived: evidence.introducedWaived,
        resolved: evidence.resolved.length,
        unchanged: evidence.unchangedCount,
        unresolvable: { ...evidence.unresolvable },
      },
      introduced: evidence.introduced.slice(0, MAX_ARCHITECTURE_IDENTITY_ITEMS).map((item) => ({
        messageId: boundedFact(item.messageId, ARCHITECTURE_IDENTITY_CHARS),
        sourceProject: boundedFact(item.sourceProject, ARCHITECTURE_IDENTITY_CHARS),
        target: boundedFact(item.target, ARCHITECTURE_TARGET_CHARS),
        waived: item.waived,
        headCount: item.headCount,
        decisionRef: constraintDecisionRef(item.constraint),
      })),
      resolved: evidence.resolved.slice(0, MAX_ARCHITECTURE_IDENTITY_ITEMS).map((item) => ({
        messageId: boundedFact(item.messageId, ARCHITECTURE_IDENTITY_CHARS),
        sourceProject: boundedFact(item.sourceProject, ARCHITECTURE_IDENTITY_CHARS),
        target: boundedFact(item.target, ARCHITECTURE_TARGET_CHARS),
      })),
      renamePairs: evidence.renamePairs.map((pair) => ({
        messageId: boundedFact(pair.introduced.messageId, ARCHITECTURE_IDENTITY_CHARS),
        from: boundedFact(renameSide(pair, "from"), ARCHITECTURE_IDENTITY_CHARS),
        to: boundedFact(renameSide(pair, "to"), ARCHITECTURE_IDENTITY_CHARS),
      })),
      customRules:
        evidence.customRules === null
          ? null
          : {
              findings: {
                introduced: customBucketFacts(evidence.customRules.findings.introduced),
                resolved: customBucketFacts(evidence.customRules.findings.resolved),
                unchanged: customBucketFacts(evidence.customRules.findings.unchanged),
                unknown: customBucketFacts(evidence.customRules.findings.unknown),
              },
            },
      occurrencesReduced: evidence.occurrencesReduced.length,
    },
    "architecture section",
  );
}

/**
 * One producer fact flattened to a bounded line — null passes through as the
 * honest absence the evidence records, and everything else loses its control
 * characters and its excess length deterministically.
 *
 * @param {string | null} value
 * @param {number} cap
 * @returns {string | null}
 */
function boundedFact(value, cap) {
  if (value === null) return null;
  return oneLine(value, { maxChars: cap, stripControlChars: true });
}

/**
 * The record a constraint row cites for its exception — the field that tells
 * an intentional evolution from a plain violation. The row is producer bytes
 * carried verbatim by the evidence, so only a string-shaped ref persists,
 * flattened and capped like every identity field; anything else records as
 * the honest absence rather than a coerced string.
 *
 * @param {import("#core/architecture.mjs").ConstraintRow} constraint
 * @returns {string | null}
 */
function constraintDecisionRef(constraint) {
  if (constraint === null) return null;
  const ref = constraint["decisionRef"];
  if (typeof ref !== "string" || ref.length === 0) return null;
  return oneLine(ref, { maxChars: ARCHITECTURE_IDENTITY_CHARS, stripControlChars: true });
}

/**
 * The name a rename pair moved between — the one project-identity field the
 * two sides differ in, whichever it is. The pairing is the reader's derived
 * fact; this only reads the differing field back out.
 *
 * @param {import("#core/architecture.mjs").RenamePair} pair
 * @param {"from" | "to"} side
 * @returns {string | null}
 */
function renameSide(pair, side) {
  if (pair.introduced.sourceProject !== pair.resolved.sourceProject) {
    return side === "from" ? pair.resolved.sourceProject : pair.introduced.sourceProject;
  }
  return side === "from" ? pair.resolved.target : pair.introduced.target;
}

/**
 * @param {import("#core/architecture.mjs").CustomRuleBucketFacts} bucket
 * @returns {{ count: number, ruleIds: string[] }}
 */
function customBucketFacts(bucket) {
  return {
    count: bucket.count,
    ruleIds: bucket.ruleIds
      .slice(0, MAX_ARCHITECTURE_RULE_IDS)
      .map((rule) =>
        oneLine(rule, { maxChars: ARCHITECTURE_IDENTITY_CHARS, stripControlChars: true }),
      ),
  };
}

/**
 * Builds the reduced artifact a skipped run writes — the code-owned record
 * that review did not run and the applicability fact that decided it. The
 * record is the skip's whole outcome: exact keys, schemaVersion 5, the
 * policy pin so a stale record is detectable, and nothing that was never
 * read.
 *
 * @param {object} skip
 * @param {string} skip.repository "owner/repo", as the forge names it
 * @param {number} skip.pullRequest the pull request number
 * @param {string} skip.headRef the head the skip describes, full 40 hex chars
 * @param {string} skip.reason the code-composed sentence, uncapped
 * @param {RunPolicy} skip.policy the policy source pin
 * @param {ApplicabilitySection} skip.applicability the deciding applicability fact
 * @throws {ArtifactError} on any malformed field
 * @returns {SkippedRunArtifact}
 */
export function buildSkippedArtifact({
  repository,
  pullRequest,
  headRef,
  reason,
  policy,
  applicability,
}) {
  const repo = asNonEmptyString(repository, "skipped run.repository");
  const number = asPositiveInt(pullRequest, "skipped run.pullRequest");
  const ref = asNonEmptyString(headRef, "skipped run.headRef");
  if (!HEAD_REF.test(ref)) {
    throw new ArtifactError("skipped run.headRef must be a 40-char hex commit sha — refused");
  }
  asNonEmptyString(reason, "skipped run.reason");
  const policyRecord = asRecord(policy, "skipped run.policy");
  assertExactKeys(policyRecord, "skipped run.policy", POLICY_KEYS);
  const pStrictness = asEnum(
    policyRecord.strictness,
    STRICTNESS_ARMS,
    "skipped run.policy.strictness",
  );
  const pStrategy = asEnum(policyRecord.strategy, STRATEGY, "skipped run.policy.strategy");
  const pBasis = asEnum(
    policyRecord.basis,
    /** @type {const} */ (["default", "base", "pushed", "dispatched"]),
    "skipped run.policy.basis",
  );
  const pBranch = asNonEmptyString(policyRecord.branch, "skipped run.policy.branch");
  const pSha = asNonEmptyString(policyRecord.sha, "skipped run.policy.sha");
  if (!HEAD_REF.test(pSha)) {
    throw new ArtifactError("skipped run.policy.sha must be a 40-char hex commit sha — refused");
  }
  const section = asApplicabilitySection(applicability, SKIPPED_SHAPE_BASES, true);
  return deepFreeze({
    schemaVersion: applicabilityArtifactSchemaVersion,
    repository: repo,
    pullRequest: number,
    headRef: ref,
    outcome: { classification: "skip", reason },
    policy: {
      strictness: pStrictness,
      strategy: pStrategy,
      basis: pBasis,
      branch: pBranch,
      sha: pSha,
    },
    applicability: section,
  });
}

/**
 * Builds the durable record for a skip path that leaves no applicability fact
 * — the code-owned state skip under no policy, and the empty universe. It
 * mirrors buildSkippedArtifact's validation posture: exact keys, a closed kind
 * vocabulary, the run identity fail-closed, and the code-composed reason
 * uncapped. Carries the policy pin so a stale record is detectable.
 * Byte-deterministic: the same inputs yield the same object and the same
 * serialised bytes.
 *
 * @param {object} skip
 * @param {string} skip.repository "owner/repo", as the forge names it
 * @param {number} skip.pullRequest the pull request number
 * @param {string} skip.headRef the head the skip describes, full 40 hex chars
 * @param {string} skip.reason the code-composed sentence, uncapped
 * @param {"state" | "nothing-to-review"} skip.kind which skip path wrote the record
 * @param {RunPolicy} skip.policy the policy source pin
 * @throws {ArtifactError} on any malformed field
 * @returns {SkipRecord}
 */
export function buildSkipRecord({ repository, pullRequest, headRef, reason, kind, policy }) {
  const repo = asNonEmptyString(repository, "skip record.repository");
  const number = asPositiveInt(pullRequest, "skip record.pullRequest");
  const ref = asNonEmptyString(headRef, "skip record.headRef");
  if (!HEAD_REF.test(ref)) {
    throw new ArtifactError("skip record.headRef must be a 40-char hex commit sha — refused");
  }
  asNonEmptyString(reason, "skip record.reason");
  const skipKind = asEnum(kind, SKIP_KINDS, "skip record.kind");
  const policyRecord = asRecord(policy, "skip record.policy");
  assertExactKeys(policyRecord, "skip record.policy", POLICY_KEYS);
  const pStrictness = asEnum(
    policyRecord.strictness,
    STRICTNESS_ARMS,
    "skip record.policy.strictness",
  );
  const pStrategy = asEnum(policyRecord.strategy, STRATEGY, "skip record.policy.strategy");
  const pBasis = asEnum(
    policyRecord.basis,
    /** @type {const} */ (["default", "base", "pushed", "dispatched"]),
    "skip record.policy.basis",
  );
  const pBranch = asNonEmptyString(policyRecord.branch, "skip record.policy.branch");
  const pSha = asNonEmptyString(policyRecord.sha, "skip record.policy.sha");
  if (!HEAD_REF.test(pSha)) {
    throw new ArtifactError("skip record.policy.sha must be a 40-char hex commit sha — refused");
  }
  return deepFreeze({
    schemaVersion: applicabilityArtifactSchemaVersion,
    kind: skipKind,
    repository: repo,
    pullRequest: number,
    headRef: ref,
    outcome: { classification: "skip", reason },
    policy: {
      strictness: pStrictness,
      strategy: pStrategy,
      basis: pBasis,
      branch: pBranch,
      sha: pSha,
    },
  });
}

/**
 * Builds the reduced artifact an abandoned run writes — the subject moved
 * mid-run, so the record names only the identity and the outcome. No policy,
 * risk, findings or coverage: nothing was read beyond the classification.
 * When a comment was published before the head moved, `commentId` names the
 * orphaned comment so an auditor can find it.
 *
 * @param {object} abandoned
 * @param {string} abandoned.repository "owner/repo", as the forge names it
 * @param {number} abandoned.pullRequest the pull request number
 * @param {string} abandoned.headRef the head the abandoned run describes, full 40 hex chars
 * @param {string} abandoned.reason the code-composed sentence, uncapped
 * @param {number} [abandoned.commentId] the published comment's id, when a comment was written before the abandonment
 * @param {import("./applicability.mjs").ExecutionContext} [abandoned.applicability] the applicability context, when the policy was active
 * @throws {ArtifactError} on any malformed field
 * @returns {AbandonedRunArtifact}
 */
export function buildAbandonedArtifact({
  repository,
  pullRequest,
  headRef,
  reason,
  commentId,
  applicability,
}) {
  const repo = asNonEmptyString(repository, "abandoned run.repository");
  const number = asPositiveInt(pullRequest, "abandoned run.pullRequest");
  const ref = asNonEmptyString(headRef, "abandoned run.headRef");
  if (!HEAD_REF.test(ref)) {
    throw new ArtifactError("abandoned run.headRef must be a 40-char hex commit sha — refused");
  }
  asNonEmptyString(reason, "abandoned run.reason");
  /** @type {{ commentId?: number }} */
  const provenance = {};
  if (commentId !== undefined) {
    provenance.commentId = asPositiveInt(commentId, "abandoned run.commentId");
  }
  const context =
    applicability !== undefined
      ? asEnum(applicability, EXECUTION_CONTEXTS, "abandoned run.applicability")
      : undefined;
  return deepFreeze({
    schemaVersion: reviewArtifactSchemaVersion,
    repository: repo,
    pullRequest: number,
    headRef: ref,
    outcome: { classification: "abandoned", reason },
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
    ...(context !== undefined ? { applicability: context } : {}),
  });
}

/**
 * Builds the reduced artifact a dry-run writes — the record names only the
 * identity and the outcome. No policy, risk, findings or coverage: nothing was
 * read beyond the classification.
 *
 * @param {object} dry
 * @param {string} dry.repository "owner/repo", as the forge names it
 * @param {number} dry.pullRequest the pull request number
 * @param {string} dry.headRef the head the dry run describes, full 40 hex chars
 * @param {string} dry.reason the code-composed sentence, uncapped
 * @param {import("./applicability.mjs").ExecutionContext} [dry.applicability] the applicability context, when the policy was active
 * @throws {ArtifactError} on any malformed field
 * @returns {DryRunRunArtifact}
 */
export function buildDryRunArtifact({ repository, pullRequest, headRef, reason, applicability }) {
  const repo = asNonEmptyString(repository, "dry run.repository");
  const number = asPositiveInt(pullRequest, "dry run.pullRequest");
  const ref = asNonEmptyString(headRef, "dry run.headRef");
  if (!HEAD_REF.test(ref)) {
    throw new ArtifactError("dry run.headRef must be a 40-char hex commit sha — refused");
  }
  asNonEmptyString(reason, "dry run.reason");
  const context =
    applicability !== undefined
      ? asEnum(applicability, EXECUTION_CONTEXTS, "dry run.applicability")
      : undefined;
  return deepFreeze({
    schemaVersion: reviewArtifactSchemaVersion,
    repository: repo,
    pullRequest: number,
    headRef: ref,
    outcome: { classification: "dry-run", reason },
    ...(context !== undefined ? { applicability: context } : {}),
  });
}

/**
 * Builds the reduced artifact a red run's boundary writer leaves behind
 * (#355) — the record for a run that ended red before its own write site.
 * The classification is the throw's class decided: `refused` for a typed
 * deterministic refusal, `failed` for every other undeclared throw. The
 * reason arrives sanitised, one-lined and capped at the build site — it
 * interpolates a thrown message, the one review reason that can carry
 * repository text — and this builder only refuses what exceeds the declared
 * cap, the module's standing posture. Partial facts ride only when the run
 * already held them: a `headRef` the snapshot read pinned, the applicability
 * context the classification derived, the comment id an upsert returned —
 * that last one only on a `failed` record, the law this builder enforces.
 *
 * @param {object} red
 * @param {string} red.repository "owner/repo", as the forge names it
 * @param {number} red.pullRequest the pull request number
 * @param {string | null} red.headRef the head the run pinned to, or null when it died before the snapshot read
 * @param {"refused" | "failed"} red.outcome the classification the throw's class decided
 * @param {string} red.reason the thrown error's sentence, sanitised and capped at the build site
 * @param {number} [red.commentId] the comment's id, when one landed before the run died red — refused outright on a `refused` classification
 * @param {import("./applicability.mjs").ExecutionContext} [red.applicability] the applicability context, when the classification ran
 * @param {ArchitectureSection} [red.architecture] the retention-shaped architecture record, when the evidence read completed before the run died — the outage rule: evidence lands in the red record too, and the record joins the 7/8 family
 * @throws {ArtifactError} on any malformed field
 * @returns {RedRunArtifact}
 */
export function buildRedArtifact({
  repository,
  pullRequest,
  headRef,
  outcome,
  reason,
  commentId,
  applicability,
  architecture,
}) {
  const repo = asNonEmptyString(repository, "red run.repository");
  const number = asPositiveInt(pullRequest, "red run.pullRequest");
  const classification = asEnum(outcome, RED_CLASSIFICATIONS, "red run.outcome");
  const sentence = asBoundedString(reason, "red run.reason", RED_REASON_CHARS);
  // The law the boundary's docs state, encoded where the family validates
  // it: every typed refusal fires before the first repository write, so a
  // `refused` record can never name a comment (#355).
  if (classification === "refused" && commentId !== undefined) {
    throw new ArtifactError(
      "a refused record cannot name a comment — every typed refusal fires before the first write — refused",
    );
  }
  if (headRef !== null) {
    const ref = asNonEmptyString(headRef, "red run.headRef");
    if (!HEAD_REF.test(ref)) {
      throw new ArtifactError("red run.headRef must be a 40-char hex commit sha — refused");
    }
  }
  /** @type {{ commentId?: number }} */
  const provenance = {};
  if (commentId !== undefined) {
    provenance.commentId = asPositiveInt(commentId, "red run.commentId");
  }
  const context =
    applicability !== undefined
      ? asEnum(applicability, EXECUTION_CONTEXTS, "red run.applicability")
      : undefined;
  const section =
    architecture !== undefined
      ? asArchitectureSection(architecture, "red run.architecture")
      : undefined;
  return deepFreeze({
    schemaVersion:
      section === undefined
        ? reviewArtifactSchemaVersion
        : context === undefined
          ? architectureArtifactSchemaVersion
          : architectureApplicabilityArtifactSchemaVersion,
    repository: repo,
    pullRequest: number,
    headRef,
    outcome: { classification, reason: sentence },
    ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
    ...(context !== undefined ? { applicability: context } : {}),
    ...(section !== undefined ? { architecture: section } : {}),
  });
}

/**
 * Validates one architecture section, fail-closed: exact keys, closed
 * vocabularies, digests in the one spelling this module knows, counts as
 * non-negative integers, identity fields inside their documented caps. The
 * coherence law the section carries: an established verdict (`pass` or
 * `fail`) never rides beside an unknown reason, and an `unknown` verdict
 * records which kind of unknown it is — a fact the section states or it
 * states nothing.
 *
 * @param {unknown} v
 * @param {string} label
 * @returns {ArchitectureSection}
 */
export function asArchitectureSection(v, label) {
  const section = asRecord(v, label);
  assertExactKeys(section, label, ARCHITECTURE_SECTION_KEYS);
  const verdict = asEnum(section.verdict, ARCHITECTURE_VERDICTS, `${label}.verdict`);
  const stale = asBoolean(section.stale, `${label}.stale`);
  let unknownReason = null;
  if (section.unknownReason !== null) {
    unknownReason = asEnum(
      section.unknownReason,
      ARCHITECTURE_UNKNOWN_REASONS,
      `${label}.unknownReason`,
    );
  }
  if (verdict !== "unknown" && unknownReason !== null) {
    throw new ArtifactError(
      `${label} records verdict '${verdict}' beside an unknown reason — an established verdict explains nothing — refused`,
    );
  }
  if (verdict === "unknown" && unknownReason === null) {
    throw new ArtifactError(
      `${label} records verdict 'unknown' without saying which kind — stale or incomplete — refused`,
    );
  }

  const coverageRec = asRecord(section.coverage, `${label}.coverage`);
  assertExactKeys(coverageRec, `${label}.coverage`, ARCHITECTURE_COVERAGE_KEYS);
  const coverage = {
    complete: asBoolean(coverageRec.complete, `${label}.coverage.complete`),
    analyzedFiles: asNonNegInt(coverageRec.analyzedFiles, `${label}.coverage.analyzedFiles`),
    notAnalyzedCount: asNonNegInt(
      coverageRec.notAnalyzedCount,
      `${label}.coverage.notAnalyzedCount`,
    ),
    blindSpotCount: asNonNegInt(coverageRec.blindSpotCount, `${label}.coverage.blindSpotCount`),
  };

  if (section.policyChanged !== null && typeof section.policyChanged !== "boolean") {
    throw new ArtifactError(`${label}.policyChanged must be a boolean or null — refused`);
  }
  const policyChanged = /** @type {boolean | null} */ (section.policyChanged);

  let toolVersion = null;
  if (section.toolVersion !== null) {
    toolVersion = asProducerString(
      section.toolVersion,
      `${label}.toolVersion`,
      ARCHITECTURE_IDENTITY_CHARS,
    );
  }

  let reportDigest = null;
  if (section.reportDigest !== null) {
    reportDigest = asNonEmptyString(section.reportDigest, `${label}.reportDigest`);
    if (!isDigest(reportDigest)) {
      throw new ArtifactError(
        `${label}.reportDigest is not a well-formed sha256 hex string — refused`,
      );
    }
  }

  const provenanceRec = asRecord(section.provenance, `${label}.provenance`);
  assertExactKeys(provenanceRec, `${label}.provenance`, ARCHITECTURE_PROVENANCE_KEYS);
  const provenance = {
    head: asArchitectureSide(provenanceRec.head, `${label}.provenance.head`),
    base: asArchitectureSide(provenanceRec.base, `${label}.provenance.base`),
  };

  const fingerprintsRec = asRecord(section.policyFingerprints, `${label}.policyFingerprints`);
  assertExactKeys(fingerprintsRec, `${label}.policyFingerprints`, ARCHITECTURE_FINGERPRINTS_KEYS);
  /**
   * @param {"head" | "base"} side
   * @returns {string | null}
   */
  const fingerprint = (side) => {
    const value = fingerprintsRec[side];
    if (value === null) return null;
    return asProducerString(
      value,
      `${label}.policyFingerprints.${side}`,
      ARCHITECTURE_TARGET_CHARS,
    );
  };
  const policyFingerprints = { head: fingerprint("head"), base: fingerprint("base") };

  const countsRec = asRecord(section.counts, `${label}.counts`);
  assertExactKeys(countsRec, `${label}.counts`, ARCHITECTURE_COUNTS_KEYS);
  const unresolvableRec = asRecord(countsRec.unresolvable, `${label}.counts.unresolvable`);
  assertExactKeys(
    unresolvableRec,
    `${label}.counts.unresolvable`,
    new Set(["introduced", "resolved", "unchanged", "unknown"]),
  );
  const counts = {
    introduced: asNonNegInt(countsRec.introduced, `${label}.counts.introduced`),
    introducedWaived: asNonNegInt(countsRec.introducedWaived, `${label}.counts.introducedWaived`),
    resolved: asNonNegInt(countsRec.resolved, `${label}.counts.resolved`),
    unchanged: asNonNegInt(countsRec.unchanged, `${label}.counts.unchanged`),
    unresolvable: {
      introduced: asNonNegInt(
        unresolvableRec.introduced,
        `${label}.counts.unresolvable.introduced`,
      ),
      resolved: asNonNegInt(unresolvableRec.resolved, `${label}.counts.unresolvable.resolved`),
      unchanged: asNonNegInt(unresolvableRec.unchanged, `${label}.counts.unresolvable.unchanged`),
      unknown: asNonNegInt(unresolvableRec.unknown, `${label}.counts.unresolvable.unknown`),
    },
  };
  if (counts.introducedWaived > counts.introduced) {
    throw new ArtifactError(
      `${label}.counts.introducedWaived exceeds introduced — more waivers than violations — refused`,
    );
  }
  const introducedList = asArray(section.introduced, `${label}.introduced`);
  if (introducedList.length > MAX_ARCHITECTURE_IDENTITY_ITEMS) {
    throw new ArtifactError(
      `${label}.introduced holds ${String(introducedList.length)} items, past the ${String(MAX_ARCHITECTURE_IDENTITY_ITEMS)}-item identity cap — refused`,
    );
  }
  const resolvedList = asArray(section.resolved, `${label}.resolved`);
  if (resolvedList.length > MAX_ARCHITECTURE_IDENTITY_ITEMS) {
    throw new ArtifactError(
      `${label}.resolved holds ${String(resolvedList.length)} items, past the ${String(MAX_ARCHITECTURE_IDENTITY_ITEMS)}-item identity cap — refused`,
    );
  }
  /** @type {{ messageId: string | null, sourceProject: string | null, target: string | null, waived: boolean, headCount: number, decisionRef: string | null }[]} */
  const introduced = introducedList.map((item, i) => {
    const record = asRecord(item, `${label}.introduced[${String(i)}]`);
    assertExactKeys(record, `${label}.introduced[${String(i)}]`, ARCHITECTURE_INTRODUCED_KEYS);
    return {
      messageId: identityField(record.messageId, `${label}.introduced[${String(i)}].messageId`),
      sourceProject: identityField(
        record.sourceProject,
        `${label}.introduced[${String(i)}].sourceProject`,
      ),
      target: boundedTarget(record.target, `${label}.introduced[${String(i)}].target`),
      waived: asBoolean(record.waived, `${label}.introduced[${String(i)}].waived`),
      headCount: asNonNegInt(record.headCount, `${label}.introduced[${String(i)}].headCount`),
      decisionRef: identityField(
        record.decisionRef,
        `${label}.introduced[${String(i)}].decisionRef`,
      ),
    };
  });
  /** @type {{ messageId: string | null, sourceProject: string | null, target: string | null }[]} */
  const resolved = resolvedList.map((item, i) => {
    const record = asRecord(item, `${label}.resolved[${String(i)}]`);
    assertExactKeys(record, `${label}.resolved[${String(i)}]`, ARCHITECTURE_RESOLVED_KEYS);
    return {
      messageId: identityField(record.messageId, `${label}.resolved[${String(i)}].messageId`),
      sourceProject: identityField(
        record.sourceProject,
        `${label}.resolved[${String(i)}].sourceProject`,
      ),
      target: boundedTarget(record.target, `${label}.resolved[${String(i)}].target`),
    };
  });
  const waivedCount = introduced.filter((item) => item.waived).length;
  if (waivedCount > counts.introducedWaived) {
    throw new ArtifactError(
      `${label}.introduced lists ${String(waivedCount)} waived items against a count of ${String(counts.introducedWaived)} — refused`,
    );
  }
  if (introduced.length > counts.introduced) {
    throw new ArtifactError(
      `${label}.introduced lists more items than counts.introduced admits — refused`,
    );
  }
  if (resolved.length > counts.resolved) {
    throw new ArtifactError(
      `${label}.resolved lists more items than counts.resolved admits — refused`,
    );
  }

  /** @type {{ messageId: string | null, from: string | null, to: string | null }[]} */
  const renamePairs = asArray(section.renamePairs, `${label}.renamePairs`).map((item, i) => {
    const record = asRecord(item, `${label}.renamePairs[${String(i)}]`);
    assertExactKeys(record, `${label}.renamePairs[${String(i)}]`, ARCHITECTURE_RENAME_KEYS);
    return {
      messageId: identityField(record.messageId, `${label}.renamePairs[${String(i)}].messageId`),
      from: identityField(record.from, `${label}.renamePairs[${String(i)}].from`),
      to: identityField(record.to, `${label}.renamePairs[${String(i)}].to`),
    };
  });

  let customRules = null;
  if (section.customRules !== null) {
    const customRec = asRecord(section.customRules, `${label}.customRules`);
    assertExactKeys(customRec, `${label}.customRules`, ARCHITECTURE_CUSTOM_KEYS);
    const findingsRec = asRecord(customRec.findings, `${label}.customRules.findings`);
    /**
     * @param {"introduced" | "resolved" | "unchanged" | "unknown"} name
     * @returns {{ count: number, ruleIds: string[] }}
     */
    const bucket = (name) => {
      const record = asRecord(findingsRec[name], `${label}.customRules.findings.${name}`);
      assertExactKeys(
        record,
        `${label}.customRules.findings.${name}`,
        ARCHITECTURE_CUSTOM_BUCKET_KEYS,
      );
      const ruleIds = asStringList(record.ruleIds, `${label}.customRules.findings.${name}.ruleIds`);
      if (ruleIds.length > MAX_ARCHITECTURE_RULE_IDS) {
        throw new ArtifactError(
          `${label}.customRules.findings.${name}.ruleIds holds ${String(ruleIds.length)} ids, past the ${String(MAX_ARCHITECTURE_RULE_IDS)}-id cap — refused`,
        );
      }
      for (const rule of ruleIds) {
        if (rule.length > ARCHITECTURE_IDENTITY_CHARS) {
          throw new ArtifactError(
            `${label}.customRules.findings.${name}.ruleIds holds an id past the ${String(ARCHITECTURE_IDENTITY_CHARS)}-char cap — refused`,
          );
        }
      }
      return {
        count: asNonNegInt(record.count, `${label}.customRules.findings.${name}.count`),
        ruleIds,
      };
    };
    customRules = {
      findings: {
        introduced: bucket("introduced"),
        resolved: bucket("resolved"),
        unchanged: bucket("unchanged"),
        unknown: bucket("unknown"),
      },
    };
  }

  return deepFreeze({
    verdict,
    stale,
    unknownReason,
    coverage,
    policyChanged,
    toolVersion,
    reportDigest,
    provenance,
    policyFingerprints,
    counts,
    introduced,
    resolved,
    renamePairs,
    customRules,
    occurrencesReduced: asNonNegInt(section.occurrencesReduced, `${label}.occurrencesReduced`),
  });
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {{ commit: string | null }}
 */
function asArchitectureSide(v, label) {
  const record = asRecord(v, label);
  assertExactKeys(record, label, ARCHITECTURE_SIDE_KEYS);
  if (record.commit === null) return { commit: null };
  return { commit: asProducerString(record.commit, `${label}.commit`, 40) };
}

/**
 * A producer-derived identity string — null passes as the recorded absence,
 * and an empty string is the degenerate name the producer wrote, carried
 * verbatim rather than refused: the evidence is already validated upstream,
 * and the section records what was said, never what would have been nicer.
 *
 * @param {unknown} v
 * @param {string} label
 * @returns {string | null}
 */
function identityField(v, label) {
  if (v === null) return null;
  return asProducerString(v, label, ARCHITECTURE_IDENTITY_CHARS);
}

/**
 * @param {unknown} v
 * @param {string} label
 * @returns {string | null}
 */
function boundedTarget(v, label) {
  if (v === null) return null;
  return asProducerString(v, label, ARCHITECTURE_TARGET_CHARS);
}

/**
 * A producer-derived string under a documented cap — type and cap enforced,
 * emptiness allowed, sanitisation already applied by the section builder.
 *
 * @param {unknown} v
 * @param {string} label
 * @param {number} max
 * @returns {string}
 */
function asProducerString(v, label, max) {
  if (typeof v !== "string") {
    throw new ArtifactError(`${label} must be a string — refused`);
  }
  if (v.length > max) {
    throw new ArtifactError(`${label} exceeds the ${String(max)}-char documented cap — refused`);
  }
  return v;
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
    // The review-artifact family's shapes: the full published shape, the
    // reduced abandonment shapes, the reduced dry-run shapes, and the
    // reduced red-terminal shapes the boundary writer builds (#355).
    if (
      !hasExactKeys(record, ARTIFACT_KEYS) &&
      !hasExactKeys(record, ABANDONED_CORE_KEYS) &&
      !hasExactKeys(record, ABANDONED_WITH_PROVENANCE_KEYS) &&
      !hasExactKeys(record, ABANDONED_WITH_APPLICABILITY_KEYS) &&
      !hasExactKeys(record, ABANDONED_FULL_KEYS) &&
      !hasExactKeys(record, DRY_RUN_CORE_KEYS) &&
      !hasExactKeys(record, DRY_RUN_WITH_APPLICABILITY_KEYS) &&
      !hasExactKeys(record, RED_CORE_KEYS) &&
      !hasExactKeys(record, RED_WITH_PROVENANCE_KEYS) &&
      !hasExactKeys(record, RED_WITH_APPLICABILITY_KEYS) &&
      !hasExactKeys(record, RED_FULL_KEYS)
    ) {
      throw new ArtifactError("artifact keys fit no schema of this version — refused");
    }
  } else if (record.schemaVersion === applicabilityArtifactSchemaVersion) {
    // The applicability family's shapes: the full shape carrying an
    // applicability fact, the reduced shape a skipped run writes, and the
    // skip record a path with no applicability fact writes. The merge-group
    // skip shape stays in the set only so a historic artifact still
    // serialises — nothing builds it since the gate's retirement (ADR 006).
    if (
      !hasExactKeys(record, SKIPPED_ARTIFACT_KEYS) &&
      !hasExactKeys(record, APPLICABILITY_ARTIFACT_KEYS) &&
      !hasExactKeys(record, SKIP_RECORD_KEYS) &&
      !hasExactKeys(record, MERGE_GROUP_SKIP_KEYS)
    ) {
      throw new ArtifactError("artifact keys fit no schema of this version — refused");
    }
  } else if (record.schemaVersion === architectureArtifactSchemaVersion) {
    // The architecture family's bare shapes: the full six-gate shape, and
    // the red terminal an evidence-holding run leaves when it dies (#529).
    if (
      !hasExactKeys(record, ARCHITECTURE_ARTIFACT_KEYS) &&
      !hasExactKeys(record, RED_WITH_ARCHITECTURE_KEYS) &&
      !hasExactKeys(record, RED_ARCHITECTURE_WITH_PROVENANCE_KEYS)
    ) {
      throw new ArtifactError("artifact keys fit no schema of this version — refused");
    }
  } else if (record.schemaVersion === architectureApplicabilityArtifactSchemaVersion) {
    // The architecture family's applicability shapes: the full six-gate
    // shape with an applicability fact, and the red terminals that carry
    // both the section and the classification's context.
    if (
      !hasExactKeys(record, ARCHITECTURE_APPLICABILITY_ARTIFACT_KEYS) &&
      !hasExactKeys(record, RED_ARCHITECTURE_WITH_APPLICABILITY_KEYS) &&
      !hasExactKeys(record, RED_ARCHITECTURE_FULL_KEYS)
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

/**
 * The Evidence layer — the deterministic facts a decision may rest on,
 * separated from the untrusted semantic content the model answers about.
 *
 * Item 2 of #224: "an evidence layer (deterministic GitHub API/event facts
 * separated from untrusted semantic content)". Everything in an `Evidence`
 * object is read by code from GitHub or the event payload, except the two
 * fields this module marks as untrusted — the thread's `title` and `body`,
 * which are content an answer may be *drawn from*, never instruction to act
 * on (framed as such by `core/untrusted.mjs` when the prompt is built).
 *
 * The policy engine reads `Evidence` and the bounded `Assessment`; it never
 * reads `title` or `body` directly, and never decides mutation from them.
 * Schema and the meaning of a config key are `triage`'s own domain — nothing
 * here lives in `core/`.
 */

/** @typedef {import("#core/forge.mjs").PullRequestFile} PullRequestFile */
/** @typedef {import("./config.mjs").TriageConfig} TriageConfig */

/**
 * The thread as evidence: what it is (trusted, from the event), what it
 * currently carries (trusted label names), and what it says (untrusted
 * semantic content the model answers about, never a decision input).
 *
 * @typedef {object} ThreadEvidence
 * @property {"issue" | "pr"} type
 * @property {number} number
 * @property {string} title untrusted — the author's words
 * @property {string} body untrusted — the author's words
 * @property {string[]} labels the labels the thread already carries, trusted facts
 * @property {string} createdAt when the thread was filed, ISO — trusted event fact
 * @property {string} creator the thread author's login — trusted event fact
 * @property {string} state "open", "closed", or whatever the event names — trusted event fact
 */

/**
 * One search hit offered to the model as a relationship candidate. The
 * number and state are forge facts; the title is author prose — untrusted,
 * like the thread's own title, and framed as such when the prompt is built.
 *
 * @typedef {object} SearchCandidate
 * @property {number} number
 * @property {string} title untrusted — the author's words
 * @property {string} state
 * @property {string} url the thread's html URL
 * @property {string} createdAt
 */

/**
 * The bounded search read: the candidates the model was offered (in the
 * order offered — position is the index its relationship judgement cites),
 * the forge's total count, and the cap the read was taken at. `totalCount`
 * above `cappedAt` means overflow: a search that found more than the cap was
 * a search that found more than this run ever looks at.
 *
 * @typedef {object} ForgeSearchFacts
 * @property {SearchCandidate[]} candidates
 * @property {number} totalCount
 * @property {number} cappedAt
 */

/**
 * The deterministic quality facts: which issue form the body came from (if
 * any), which of its fields are answered, and the body's shape. All code
 * facts — `missingRequired` is never a model judgement.
 *
 * @typedef {object} QualityFacts
 * @property {{ id: string, name: string } | null} template the form the body matches, if any
 * @property {Array<{ label: string, present: boolean, required: boolean }>} fieldsPresent the matched form's fields
 * @property {string[]} missingRequired the matched form's required fields the body leaves empty
 * @property {number} bodyLength
 * @property {number} urlCount
 * @property {boolean} templatesOverflow true when the template read was capped
 */

/**
 * The deterministic PR-side facts beyond the diff: the pull request's own
 * flags (draft, merged, state), its mergeability as the forge computes it,
 * its two commits, the check-run rollup at the head (null when the forge
 * does not report one), and the review routing state. Everything here is
 * read by code from the forge — none of it is a model judgement, and none
 * of it is untrusted semantic content. Present only for a `pr` thread;
 * `null` on an issue.
 *
 * @typedef {object} PrEvidence
 * @property {string} state "open", "closed", or whatever the forge answers
 * @property {boolean} draft
 * @property {boolean} merged
 * @property {boolean | null} mergeable null while the forge is still computing it
 * @property {boolean} hasConflicts deterministic conflict signal — the forge classified the merge state as dirty
 * @property {string} body the pull request's description — presence is a fact
 * @property {{ ref: string, sha: string }} base
 * @property {{ ref: string, sha: string }} head
 * @property {{ total: number, byConclusion: Partial<import("#core/forge.mjs").CheckRunsSummary["byConclusion"]> } | null} checks null when the forge reports no check runs at the head
 * @property {string[]} reviewRequested logins asked to review and not yet done
 * @property {{ state: string, count: number }[]} reviews submitted reviews by disposition
 */

/**
 * @typedef {object} SizeMeasurement
 * @property {number} counted
 * @property {number} excluded
 * @property {number} files
 * @property {string} label
 */

/**
 * Everything a decision may rest on, gathered deterministically.
 *
 * @typedef {object} Evidence
 * @property {ThreadEvidence} thread
 * @property {{ name: string, description: string }} repository
 * @property {TriageConfig | null} policy the validated config — the policy, never the model, decides against it
 * @property {Map<string, string> | null} sheet the effective sheet (offered label → GitHub gloss)
 * @property {Map<string, { name: string, description: string, color: string }>} labelMetadata the repository's label registry, GitHub as source of truth
 * @property {PullRequestFile[]} files the PR's diff files (empty for an issue)
 * @property {SizeMeasurement | null} measuredSize measured in code, never a model choice
 * @property {QualityFacts | null} quality the issue-form facts, when policy and thread type make them available
 * @property {ForgeSearchFacts | null} forgeSearch the bounded duplicate/relationship search, when it ran
 * @property {string} eventAction the event's `action` field
 * @property {PrEvidence | null} pr the PR-side deterministic facts — present only for a `pr` thread, null for an issue
 */

/**
 * @typedef {object} EvidenceInput
 * @property {{ type: "issue" | "pr", number: number, title: string, body: string, labels: string[], createdAt?: string, creator?: string, state?: string }} thread
 * @property {{ name: string, description: string }} repository
 * @property {TriageConfig | null} config
 * @property {Map<string, string> | null} sheet
 * @property {Map<string, { name: string, description: string, color: string }>} metadata
 * @property {PullRequestFile[]} files
 * @property {SizeMeasurement | null} size
 * @property {QualityFacts | null} [quality] the issue-form facts, when a sheet-mode issue run gathered them
 * @property {ForgeSearchFacts | null} [forgeSearch] the bounded candidate search, when a sheet-mode issue run ran it
 * @property {string} eventAction
 * @property {PrEvidence | null} [pr] the PR-side deterministic facts — omitted (→ null) for an issue or when the reads are unavailable
 */

/**
 * Packages the run's reads into one `Evidence` object, marking the two
 * fields that are untrusted semantic content. Pure — the reads themselves
 * (event payload, forge, size measurement) happen in the orchestrator.
 *
 * @param {EvidenceInput} input
 * @returns {Evidence}
 */
export function gatherEvidence({
  thread,
  repository,
  config,
  sheet,
  metadata,
  files,
  size,
  quality,
  forgeSearch,
  eventAction,
  pr,
}) {
  return {
    thread: {
      type: thread.type,
      number: thread.number,
      title: thread.title,
      body: thread.body,
      labels: thread.labels,
      createdAt: thread.createdAt ?? "",
      creator: thread.creator ?? "",
      state: thread.state ?? "",
    },
    repository,
    policy: config,
    sheet,
    labelMetadata: metadata,
    files,
    measuredSize: size,
    quality: quality ?? null,
    forgeSearch: forgeSearch ?? null,
    eventAction,
    pr: pr ?? null,
  };
}

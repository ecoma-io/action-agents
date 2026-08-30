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
 * @property {string} eventAction the event's `action` field
 */

/**
 * @typedef {object} EvidenceInput
 * @property {{ type: "issue" | "pr", number: number, title: string, body: string, labels: string[] }} thread
 * @property {{ name: string, description: string }} repository
 * @property {TriageConfig | null} config
 * @property {Map<string, string> | null} sheet
 * @property {Map<string, { name: string, description: string, color: string }>} metadata
 * @property {PullRequestFile[]} files
 * @property {SizeMeasurement | null} size
 * @property {string} eventAction
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
  eventAction,
}) {
  return {
    thread: {
      type: thread.type,
      number: thread.number,
      title: thread.title,
      body: thread.body,
      labels: thread.labels,
    },
    repository,
    policy: config,
    sheet,
    labelMetadata: metadata,
    files,
    measuredSize: size,
    eventAction,
  };
}

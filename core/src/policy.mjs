/**
 * The policy source — the one answer to "which branch governs this run",
 * resolved once per execution from the event context and pinned to an
 * immutable commit. Policy and configuration are read from that commit and
 * never from anywhere else: a pull request cannot edit the policy that
 * judges it, a branch moving mid-run changes nothing a running read sees,
 * and a repository with several development lines gets each line's own
 * governance with no configuration at all.
 *
 * The resolver is infrastructure, not an action's domain logic: it knows
 * GitHub event semantics and nothing about what any action does with the
 * files it finds. Branch names appear only as opaque strings passed to
 * `getRef` — no line of code ever inspects, matches, or ranks a name, so a
 * name like `v2` or `release-*` cannot enter any decision.
 *
 * @packageDocumentation
 */

/**
 * Why this branch governs this run — the audit word, not a decoration.
 *
 * - `default`: no per-line fact in the event (schedule, issues, tags, a
 *   single-branch repository) — the repository's declared governance line.
 * - `base`: a pull request's base branch — the line the pull request
 *   targets, same-repo or fork alike.
 * - `pushed`: the branch a push event is about, at the tip the event itself
 *   fixes.
 * - `dispatched`: the branch a `workflow_dispatch` ran on.
 *
 * @typedef {"default" | "base" | "pushed" | "dispatched"} PolicyBasis
 */

/**
 * The one answer every policy read in a run shares.
 *
 * @typedef {object} PolicySource
 * @property {PolicyBasis} basis why this branch (event semantics, never a name heuristic)
 * @property {string} branch the governance branch, as the repository names it
 * @property {string} sha the immutable commit every policy read pins to — full 40-hex
 */

/**
 * The forge slice the resolver needs — structurally satisfied by
 * `createForge`.
 *
 * @typedef {object} PolicyForge
 * @property {() => Promise<{ defaultBranch: string }>} getRepository
 * @property {(branch: string) => Promise<{ sha: string }>} getRef
 */

/**
 * The forge slice the pinned reader needs.
 *
 * @typedef {object} PolicyContents
 * @property {(path: string, options?: { ref?: string }) => Promise<{ content: string } | null>} getContents
 */

/** A commit sha is exactly 40 hex characters; anything else is not a pin. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** A branch-deletion push announces itself with the all-zero sha. */
const ZERO_SHA = "0".repeat(40);

const HEADS_PREFIX = "refs/heads/";

/**
 * The typed refusal. Every way the execution context can fail to name a
 * trusted policy source — a push without a commit, a base branch that does
 * not resolve, a policy file declaring a schema this runtime does not
 * understand — raises one of these, so a refusal reads as a refusal and
 * never as a forge hiccup.
 */
export class PolicyResolutionError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "PolicyResolutionError";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Maps the execution context to the trusted policy source. Deterministic,
 * fail-closed, no model involvement — the actions call it where they load
 * their policy, before the first model call by construction.
 *
 * The mapping is positional only: `pull_request` and `pull_request_target`
 * resolve the live tip of `pull_request.base.ref` (never the payload's
 * `base.sha`, which is the tip at pull-request creation time, not the
 * governance line's current one); a `push` to `refs/heads/*` is governed by
 * its own `after` commit; a `workflow_dispatch` on a branch is governed by
 * that branch's tip; every other event — tags, schedule, issues — falls to
 * the default branch. `head.*` is never read, on any event: a fork's branch
 * tip has no code path to a policy source.
 *
 * @param {object} input
 * @param {string} input.eventName GITHUB_EVENT_NAME, as readContext reports it
 * @param {Record<string, unknown>} input.event the parsed payload file
 * @param {PolicyForge} input.forge
 * @returns {Promise<PolicySource>}
 */
export async function resolvePolicySource({ eventName, event, forge }) {
  const payload = event !== null && typeof event === "object" ? event : {};

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const base = /** @type {Record<string, unknown> | undefined} */ (
      /** @type {unknown} */ (payload["pull_request"])
    )?.["base"];
    const baseRef = /** @type {Record<string, unknown> | undefined} */ (
      /** @type {unknown} */ (base)
    )?.["ref"];
    if (typeof baseRef !== "string" || baseRef === "") {
      throw new PolicyResolutionError(
        `the '${eventName}' event names no base branch — no governance line to resolve policy from`,
      );
    }
    return { basis: "base", branch: baseRef, sha: await refTip(forge, baseRef) };
  }

  if (eventName === "push") {
    const ref = payload["ref"];
    if (typeof ref !== "string" || ref === "") {
      throw new PolicyResolutionError(
        "the push event names no ref — no governance line to resolve policy from",
      );
    }
    if (ref.startsWith(HEADS_PREFIX)) {
      const branch = ref.slice(HEADS_PREFIX.length);
      if (branch === "") {
        throw new PolicyResolutionError(
          "the push event's ref is the bare branch namespace — no branch name in it",
        );
      }
      const after = payload["after"];
      if (typeof after !== "string" || !SHA_PATTERN.test(after)) {
        throw new PolicyResolutionError(
          `the push to '${branch}' carries no 40-hex after sha — refusing to derive a policy source from it`,
        );
      }
      if (after === ZERO_SHA) {
        throw new PolicyResolutionError(
          `the push to '${branch}' deletes the branch (all-zero after sha) — a deletion names no policy source`,
        );
      }
      // The event fixes the tip it is about: no extra call, and a second push
      // landing between event emission and run start cannot move this policy.
      return { basis: "pushed", branch, sha: after };
    }
    // A tag is content, not governance — it can name any commit in history,
    // including one a fork authored. Tags fall to the default branch.
    return defaultSource(forge);
  }

  if (eventName === "workflow_dispatch") {
    const ref = payload["ref"];
    if (typeof ref !== "string" || ref === "") {
      throw new PolicyResolutionError(
        "the workflow_dispatch event names no ref — no governance line to resolve policy from",
      );
    }
    if (ref.startsWith(HEADS_PREFIX)) {
      const branch = ref.slice(HEADS_PREFIX.length);
      if (branch !== "") {
        return { basis: "dispatched", branch, sha: await refTip(forge, branch) };
      }
    }
    // Dispatched on a tag or another non-branch ref: the default branch governs.
    return defaultSource(forge);
  }

  // schedule, issues, and every other event: no per-line fact in the payload,
  // so the repository's declared governance line governs.
  return defaultSource(forge);
}

/**
 * The default branch as the policy source — resolved live so the run pins
 * to the governance line's actual tip, not a stale copy.
 *
 * @param {PolicyForge} forge
 * @returns {Promise<PolicySource>}
 */
async function defaultSource(forge) {
  let repository;
  try {
    repository = await forge.getRepository();
  } catch (cause) {
    throw new PolicyResolutionError(
      "the repository's default branch could not be read — no policy source for this run",
      { cause },
    );
  }
  const branch = repository.defaultBranch;
  return { basis: "default", branch, sha: await refTip(forge, branch) };
}

/**
 * A branch's current tip, as a full 40-hex commit sha — the pin every
 * policy read of the run shares. A branch that does not resolve is a
 * refusal, never a fallback to another branch's file.
 *
 * @param {PolicyForge} forge
 * @param {string} branch
 * @returns {Promise<string>}
 */
async function refTip(forge, branch) {
  let ref;
  try {
    ref = await forge.getRef(branch);
  } catch (cause) {
    throw new PolicyResolutionError(
      `the tip of branch '${branch}' could not be resolved — no policy source for this run`,
      { cause },
    );
  }
  const sha = /** @type {Record<string, unknown> | undefined} */ (/** @type {unknown} */ (ref))?.[
    "sha"
  ];
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
    throw new PolicyResolutionError(
      `the tip of branch '${branch}' is not a 40-hex commit sha — refusing to pin policy to it`,
    );
  }
  return sha;
}

/**
 * Binds the forge to one resolved source: every read lands at `source.sha`.
 * The returned function is the reader the actions hand their config and
 * document loaders, so no call site is asked to remember `{ ref: sha }` —
 * and none can forget it.
 *
 * @param {PolicyContents} forge
 * @param {PolicySource} source
 * @returns {(path: string) => Promise<{ content: string } | null>}
 */
export function policyReader(forge, source) {
  return (path) => forge.getContents(path, { ref: source.sha });
}

/**
 * The one audit line every action logs at resolution time, before its first
 * model call — the record that answers "what governed this run" after the
 * branch has moved on. The sha is always the full 40 hex characters: the
 * exact commit, not an abbreviation of it.
 *
 * @param {object} input
 * @param {string} input.eventName
 * @param {PolicySource} input.source
 * @param {string} input.path the policy file the run reads, "" when none exists
 * @returns {string}
 */
export function policySourceAuditLine({ eventName, source, path }) {
  return (
    `policy source: event=${eventName} basis=${source.basis} ` +
    `branch=${source.branch} sha=${source.sha} path=${path === "" ? "(none)" : path}`
  );
}

/**
 * The optional `schemaVersion` a policy file may declare. Absent equals the
 * current major — every policy file written before versioning keeps working
 * untouched. Any other value — an older major, a newer one, a string, a
 * fraction — is a startup refusal naming the branch, the sha, the path, and
 * both majors, before any model call. This runtime understands exactly one
 * major per action when `supportedMajor` is a single number; a range
 * (`number[]`) is how a migration window reads more than one. A migration
 * window is a deliberate, documented widening — the reader accepts the old
 * major alongside the current one while existing policies move over — not a
 * license to hold every major forever. A minor digit, if ever introduced,
 * will be a deliberate widening of this check, not a silent one.
 *
 * @param {object} input
 * @param {Record<string, unknown> | null} input.raw the parsed policy file, null when absent
 * @param {number | number[]} input.supportedMajor the schema major(s) this action understands; an array is a migration window
 * @param {string} input.path the policy file's path, for the refusal
 * @param {PolicySource} input.source the resolved policy source, for the refusal
 * @returns {void}
 */
export function assertPolicySchemaVersion({ raw, supportedMajor, path, source }) {
  if (raw === null) return;
  const declared = raw["schemaVersion"];
  if (declared === undefined) return;
  if (
    typeof declared !== "number" ||
    !Number.isInteger(declared) ||
    !majors(supportedMajor).includes(declared)
  ) {
    const found = JSON.stringify(declared) ?? String(declared);
    throw new PolicyResolutionError(
      `'${path}' on branch '${source.branch}' at ${source.sha} declares schemaVersion ${found}, ` +
        `but this action understands schema major ${String(supportedMajor)} only — ` +
        `update the file on its branch, or run an action version that reads it`,
    );
  }
}

/**
 * @param {number | number[]} supportedMajor
 * @returns {number[]}
 */
function majors(supportedMajor) {
  return Array.isArray(supportedMajor) ? supportedMajor : [supportedMajor];
}

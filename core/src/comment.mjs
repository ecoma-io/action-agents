/**
 * The marker upsert — the one route by which model text reaches a thread.
 *
 * One comment per action per thread, found by exact marker **and** by known
 * bot identity. The identity half is not decoration: a maintainer who quotes
 * the action's comment copies its marker into their own words, and a marker
 * alone cannot tell a quote from the original. Only comments authored by the
 * logins in `ownLogins` are candidates for updating or deleting; a
 * marker-bearing comment by anyone else is named in a log line and left
 * exactly as its author wrote it. When no candidate exists but foreign
 * markers do, a fresh comment is created rather than a foreign one claimed —
 * two comments on the thread beat one human's words rewritten by a bot.
 *
 * The marker itself is an HTML comment, invisible in rendered Markdown:
 *
 * ```text
 * <!-- action-agents:<action>:<id> -->
 * <!-- action-agents:<action>:<id>:head=<sha> -->   (when a head is recorded)
 * ```
 *
 * The `<id>` is run-scoped: a fresh one is minted when the comment is
 * created, and preserved on every update after — it identifies this action's
 * presence on this thread, not one particular run. The sanitiser guarantees
 * model text cannot contain it, so a marker found in a comment was written
 * by the action, not injected into its own output.
 *
 * If a race leaves several of the action's own comments, the newest wins and
 * the losers are deleted with a log line — the upsert keeps exactly one of
 * *its own*, and touches nothing else. Where the caller records a head
 * commit, a comment holding a head written after this run started is never
 * overwritten: a concurrent run got there first, and the older result is
 * abandoned with a log line instead.
 */

import { randomBytes } from "node:crypto";

/**
 * @typedef {import("./forge.mjs").CommentEntry} CommentEntry
 */

/**
 * The forge operations the upsert needs. `triage` and `review` pass their
 * `createForge` client; the tests pass a stub. Listed operation by operation
 * so a client that cannot do one of these is a type error, not a runtime
 * surprise.
 *
 * @typedef {object} CommentStore
 * @property {(number: number) => Promise<CommentEntry[]>} listComments
 * @property {(number: number, body: string) => Promise<{ id: number }>} createComment
 * @property {(id: number, body: string) => Promise<void>} updateComment
 * @property {(id: number) => Promise<void>} deleteComment
 */

/**
 * @typedef {object} Marker
 * @property {string} action
 * @property {string} id
 * @property {string | undefined} head
 */

/** The whole marker, as it sits in a comment. */
const MARKER =
  /<!--\s*action-agents:([a-z0-9-]+):([0-9a-f-]{6,64})(?::head=([0-9a-f]{7,40}))?\s*-->/g;

/** The login this repo's actions write under when nothing exotic is configured. */
const DEFAULT_OWN_LOGIN = "github-actions[bot]";
const DEFAULT_OWN_LOGINS = [DEFAULT_OWN_LOGIN];

/**
 * @param {string} action
 * @param {string} id
 * @param {string} [head]
 * @returns {string}
 */
export function markerLine(action, id, head) {
  return head === undefined
    ? `<!-- action-agents:${action}:${id} -->`
    : `<!-- action-agents:${action}:${id}:head=${head} -->`;
}

/**
 * The first action-agents marker in a comment body, or null. A body without
 * one is not this machinery's to touch.
 *
 * @param {string} body
 * @returns {Marker | null}
 */
export function parseMarker(body) {
  MARKER.lastIndex = 0;
  const match = MARKER.exec(body);
  if (match === null) return null;
  return { action: match[1] ?? "", id: match[2] ?? "", head: match[3] };
}

/** @returns {string} */
function defaultNewId() {
  return randomBytes(6).toString("hex");
}

/**
 * @typedef {object} UpsertOptions
 * @property {CommentStore} store
 * @property {string} action the acting action's name, the marker's namespace
 * @property {number} issueNumber the thread — an issue number or a pull request's
 * @property {(marker: string) => string} buildBody the action's comment, around the marker it is handed
 * @property {string[]} [ownLogins] the logins this action's own comments carry — defaults to the workflow-token bot; the actions resolve theirs from the token with {@linkcode resolveOwnLogins}, and a caller with other plans says so here
 * @property {string | undefined} [head] the commit the comment records, when the action records one — an issue thread's upsert passes undefined, and its marker carries no head
 * @property {number} [startedAt] epoch milliseconds, for the newer-head rule
 * @property {() => string} [newId]
 * @property {(message: string) => void} [log]
 */

/**
 * Creates or updates the action's one comment on a thread.
 *
 * @param {UpsertOptions} options
 * @returns {Promise<{ outcome: "created" | "updated" | "abandoned", id: number }>}
 */
export async function upsertComment(options) {
  const log = options.log ?? (() => undefined);
  const ownLogins = options.ownLogins ?? DEFAULT_OWN_LOGINS;
  const comments = await options.store.listComments(options.issueNumber);

  /** @type {CommentEntry[]} */
  const marked = [];
  let foreign = 0;
  for (const comment of comments) {
    const marker = parseMarker(comment.body);
    if (marker?.action !== options.action) continue;
    const login = comment.user?.login;
    if (login === undefined || !ownLogins.includes(login)) {
      // A quoted marker in someone else's words. Claiming it would be
      // rewriting a human's comment; deleting it would be worse. Named and
      // left alone.
      foreign++;
      continue;
    }
    marked.push(comment);
  }
  if (foreign > 0) {
    log(
      `${String(foreign)} comment(s) on #${String(options.issueNumber)} carry this ` +
        `action's marker but were written by other accounts — left untouched`,
    );
  }

  if (marked.length === 0) {
    const mint = options.newId ?? defaultNewId;
    const marker = markerLine(options.action, mint(), options.head);
    const created = await options.store.createComment(
      options.issueNumber,
      options.buildBody(marker),
    );
    return { outcome: "created", id: created.id };
  }

  // Newest wins: ids ascend with creation, and the upsert keeps exactly one
  // of its own.
  marked.sort((a, b) => a.id - b.id);
  const winner = marked[marked.length - 1] ?? null;
  if (winner === null) {
    throw new Error("the marker upsert found no comment after finding some");
  }
  for (const loser of marked.slice(0, -1)) {
    log(
      `deleting a duplicate ${options.action} comment (${String(loser.id)}) — the upsert keeps exactly one`,
    );
    await options.store.deleteComment(loser.id);
  }

  const marker = parseMarker(winner.body);
  if (
    options.head !== undefined &&
    marker?.head !== undefined &&
    marker.head !== options.head &&
    options.startedAt !== undefined
  ) {
    const updatedAt = Date.parse(winner.updated_at);
    // Fail closed on an unreadable timestamp: a NaN `updated_at` cannot
    // prove the comment is older than this run started, so this run must not
    // assume it owns the thread. Abandoning over-writes nothing; clobbering
    // a thread it cannot date would drop a concurrent run's write.
    const newerThanStart = !Number.isFinite(updatedAt) || updatedAt > options.startedAt;
    if (newerThanStart) {
      log(
        `abandoning the ${options.action} comment on #${String(options.issueNumber)} — ` +
          `a concurrent run recorded head ${marker.head} after this one started`,
      );
      return { outcome: "abandoned", id: winner.id };
    }
  }

  await options.store.updateComment(
    winner.id,
    options.buildBody(markerLine(options.action, marker?.id ?? "", options.head)),
  );
  return { outcome: "updated", id: winner.id };
}

/**
 * Resolves the logins a run's own comments carry, from the identity the
 * workflow's token actually writes as — `github-actions[bot]` under a
 * GITHUB_TOKEN, the app's bot login under an App token, the token's user
 * under a PAT — read from the API rather than assumed, so the upsert keeps
 * exactly one of its own whatever token the workflow chose. When the read
 * fails the default bot login stands in: exact under GITHUB_TOKEN, and under
 * anything else it costs one duplicate comment that the next healthy run's
 * upsert claims and collapses.
 *
 * @param {{ whoami: () => Promise<{ login: string }> }} forge
 * @param {(message: string) => void} log
 * @returns {Promise<string[]>}
 */
export async function resolveOwnLogins(forge, log) {
  try {
    const { login } = await forge.whoami();
    return [login];
  } catch (cause) {
    log(
      `could not read the token's writing identity ` +
        `(${cause instanceof Error ? cause.message : String(cause)}) — assuming ${DEFAULT_OWN_LOGIN}`,
    );
    return [...DEFAULT_OWN_LOGINS];
  }
}

/**
 * The marker upsert — the one route by which model text reaches a thread.
 *
 * One comment per action per thread. It is found by author first, then by
 * exact marker: the author pass covers the ordinary case (the same token
 * identity wrote it), and the marker pass covers a rename — the bot account
 * was renamed, or the workflow switched tokens — where the author no longer
 * matches but the marker still names the action.
 *
 * The marker is an HTML comment, invisible in rendered Markdown:
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
 * If a race or a rename leaves several matches, the newest wins and the
 * losers are deleted with a log line — the upsert keeps exactly one. Where
 * the caller records a head commit, a comment holding a head written after
 * this run started is never overwritten: a concurrent run got there first,
 * and the older result is abandoned with a log line instead.
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
 * @property {() => Promise<{ login: string }>} whoami
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
 * @property {string} [head] the commit the comment records, when the action records one
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
  const { login } = await options.store.whoami();
  const comments = await options.store.listComments(options.issueNumber);

  /** @type {CommentEntry[]} */
  const marked = [];
  for (const comment of comments) {
    const marker = parseMarker(comment.body);
    if (marker?.action === options.action) marked.push(comment);
  }

  // Author first, marker second. A human quoting the action's comment copies
  // its marker along; claiming that quote is not ours to do while our own
  // comment stands. The marker-only fallback covers a rename — the login no
  // longer matches, the marker still names the action.
  const byAuthor = marked.filter((comment) => comment.user?.login === login);
  const found = byAuthor.length > 0 ? byAuthor : marked;

  if (found.length === 0) {
    const mint = options.newId ?? defaultNewId;
    const marker = markerLine(options.action, mint(), options.head);
    const created = await options.store.createComment(
      options.issueNumber,
      options.buildBody(marker),
    );
    return { outcome: "created", id: created.id };
  }

  // Newest wins: ids ascend with creation, and the upsert keeps exactly one.
  found.sort((a, b) => a.id - b.id);
  const winner = found[found.length - 1] ?? null;
  if (winner === null) {
    throw new Error("the marker upsert found no comment after finding some");
  }
  for (const loser of found.slice(0, -1)) {
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
    options.startedAt !== undefined &&
    Date.parse(winner.updated_at) > options.startedAt
  ) {
    log(
      `abandoning the ${options.action} comment on #${String(options.issueNumber)} — ` +
        `a concurrent run recorded head ${marker.head} after this one started`,
    );
    return { outcome: "abandoned", id: winner.id };
  }

  await options.store.updateComment(
    winner.id,
    options.buildBody(markerLine(options.action, marker?.id ?? "", options.head)),
  );
  return { outcome: "updated", id: winner.id };
}

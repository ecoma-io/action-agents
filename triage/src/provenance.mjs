/**
 * Classification provenance (issue #498) — the read path that lets a later
 * run prove which labels THIS action applied, so a stale classification can
 * be superseded without ever touching a label the action cannot vouch for.
 *
 * The write side lives in `decision.mjs`: every sheet-mode classification
 * upserts its marker comment with an embedded record block naming the labels
 * it applied. This module owns the block's format and the read side. The
 * block is evidence, never instruction: only a comment authored by the
 * token's own login counts, a malformed block is ignored, and a read that
 * cannot be resolved leaves provenance `null` — which the policy treats as
 * "proves nothing" and refuses a conflicting member instead of replacing it.
 */

import { parseMarker, resolveOwnLogins } from "#core/comment.mjs";

/** The record block's prefix. The action name keeps triage's blocks from being read as another action's evidence. */
export const RECORD_PREFIX = "action-agents-record:triage:";

/** The block is one line: the prefix, then the base64 of the version-1 JSON. The token alphabet is exactly base64's. */
const RECORD_BLOCK = /action-agents-record:triage:([A-Za-z0-9+/=]+)/;

/**
 * The version-1 record block for the labels a run applied: a single line the
 * comment sanitiser cannot mistake for prose and a later run can parse
 * fail-closed.
 *
 * @param {string[]} labels
 * @returns {string}
 */
export function recordBlock(labels) {
  return `${RECORD_PREFIX}${Buffer.from(
    JSON.stringify({ schemaVersion: 1, applied: labels }),
    "utf8",
  ).toString("base64")}`;
}

/**
 * Parses the first well-formed record block in a comment body. Anything else
 * — no block, undecodable bytes, a shape this version did not specify — is
 * `null`: a block the reader cannot prove is a block the reader must ignore.
 *
 * @param {string} body
 * @returns {{ schemaVersion: 1, applied: string[] } | null}
 */
export function extractRecordBlock(body) {
  const match = RECORD_BLOCK.exec(body);
  const encoded = match?.[1];
  if (encoded === undefined) return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const shape = /** @type {{ schemaVersion?: unknown, applied?: unknown }} */ (
    typeof parsed === "object" && parsed !== null ? parsed : {}
  );
  if (
    shape.schemaVersion !== 1 ||
    !(shape.applied instanceof Array) ||
    !shape.applied.every((name) => typeof name === "string")
  ) {
    return null;
  }
  return { schemaVersion: 1, applied: shape.applied };
}

/**
 * Reads the labels this action can prove it applied on a thread: the union
 * of the record blocks in the marker comments the token's own login wrote.
 * A failure to resolve the token's identity or to list the thread's comments
 * is not an empty set — it is `null`, "proves nothing", so a caller cannot
 * mistake an unread thread for a clean one.
 *
 * @param {{
 *   whoami: () => Promise<{ login: string }>,
 *   listComments: (issueNumber: number) => Promise<{ id: number, user?: { login: string } | null, body: string }[]>,
 * }} forge
 * @param {number} issueNumber
 * @returns {Promise<Set<string> | null>}
 */
export async function readClassificationProvenance(forge, issueNumber) {
  let ownLogins;
  try {
    ownLogins = await resolveOwnLogins(forge);
  } catch {
    return null;
  }
  let comments;
  try {
    comments = await forge.listComments(issueNumber);
  } catch {
    return null;
  }
  const applied = new Set();
  for (const comment of comments) {
    const login = comment.user?.login;
    if (login === undefined || !ownLogins.includes(login)) continue;
    // A record block is the classification comment's payload; an own-authored
    // comment without the marker is not a classification the action wrote.
    if (parseMarker(comment.body)?.action !== "triage") continue;
    const record = extractRecordBlock(comment.body);
    if (record === null) continue;
    for (const name of record.applied) applied.add(name);
  }
  return applied;
}

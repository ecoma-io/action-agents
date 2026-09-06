/**
 * The comment-embedded canonical record — how one published review hands its
 * canonical result to the next (ADR 004 decision 3). The run artifact does
 * not survive across runs, but the marker comment does, so the record rides
 * in it: one inert HTML comment carrying the record as base64 over compact
 * JSON, appended after the rendered prose by the same upsert that publishes
 * the comment.
 *
 * ```text
 * <!-- action-agents-record:review:<base64> -->
 * ```
 *
 * The encoding is chosen for inertness. Base64's alphabet holds no `<`,
 * `>` or `-`, so the block cannot break out of its HTML comment, cannot
 * spell a marker (`parseMarker` matches only `action-agents:`), and cannot
 * form markdown structure; the payload itself carries no token the comment
 * sanitiser strips, byte-for-byte — a discipline this module's tests
 * verify rather than assume, since the record's finding messages are
 * model-derived text. The scaffolding is action-generated, carried exactly
 * the way the marker already is. Parsing is the mirror
 * guard: a block that is absent, undecodable, off-version, not from a
 * published run, or fails the canonical constructor's revalidation — the
 * stored fingerprints included — leaves the previous record `undefined`,
 * and the next comment renders as it would on a first run. Never an error,
 * never a red run.
 *
 * The block carries the canonical result minus `collapsed` — the same-run
 * collapse audit trail reconciliation never reads and a re-run of the
 * constructor cannot reproduce from deduplicated findings — so the embedded
 * bytes and the parsed record agree exactly. Selection is newest-marker-
 * wins over the thread, the same order the upsert and the clearing write
 * use, and what a recovered record feeds is rendered prose only: the
 * labels, the count line and the resolved list, all sanitised at render.
 * No consequence ever reads it — the gate, the SARIF projection and every
 * exit path read the current canonical record alone.
 *
 * The record is honored only from a comment this run's own token authored,
 * whose marker names this action and whose marker head equals the record's
 * `head` — authorship is the one thing GitHub authenticates about a comment
 * (`user.login` cannot be forged to a bot principal), content shape never
 * is. A block posing in a foreign or markerless comment, or claiming a head
 * its comment's marker does not carry, is refused, and the newest own
 * comment whose record fails any of these still ends the search: first run.
 */

import { parseMarker } from "#core/comment.mjs";

import { createCanonicalResult } from "./canonical.mjs";

/** The whole record block, as it sits in a comment. */
const RECORD = /<!--\s*action-agents-record:review:([A-Za-z0-9+/=]+)\s*-->/;

/**
 * The block one published run leaves for the next. Deterministic: the same
 * record renders the same bytes — fixed key order, compact JSON, base64's
 * alphabet, no timestamps, one line.
 *
 * @param {import("./canonical.mjs").CanonicalResult} record the run's canonical result
 * @returns {string}
 */
export function embedRecordBlock(record) {
  const payload = {
    version: record.version,
    head: record.head,
    run: {
      state: record.run.state,
      verdict: record.run.verdict,
      // Additive since the fact's introduction: a record without one embeds
      // byte-identically to the v1 payload.
      ...(record.run.publication !== undefined ? { publication: record.run.publication } : {}),
    },
    findings: record.findings.map((finding) => ({ ...finding })),
    ...(record.coverage !== undefined
      ? {
          coverage: {
            covered: [...record.coverage.covered],
            uncovered: [...record.coverage.uncovered],
            total: record.coverage.total,
          },
        }
      : {}),
  };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return `<!-- action-agents-record:review:${bytes.toString("base64")} -->`;
}

/**
 * The canonical record a comment body carries, or `undefined` when it
 * carries none this machinery can trust. Every failure mode — no block,
 * broken base64, non-JSON bytes, a version the pipeline never spelled, a record
 * whose run never published, a mangled fingerprint — collapses to the same
 * `undefined` the honest absence of a block produces.
 *
 * @param {string} body the comment body to read
 * @returns {import("./canonical.mjs").CanonicalResult | undefined}
 */
export function parseRecordBlock(body) {
  const encoded = RECORD.exec(body)?.[1];
  if (encoded === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    const { run } = /** @type {{ run?: { state?: unknown } }} */ (parsed);
    if (run === null || typeof run !== "object" || run.state !== "published") return undefined;
    // The canonical constructor is the guard: the record version (it spells
    // the identity scheme — a stored v1 record verifies under the retired
    // spelling), vocabulary, shape, and every stored fingerprint against the
    // tuple it recomputes. Anything a truncated or hand-mangled block lost
    // throws here and counts as absent.
    return createCanonicalResult(/** @type {any} */ (parsed));
  } catch {
    return undefined;
  }
}

/**
 * The previous canonical record for a thread: the newest comment this run's
 * own token authored carrying this action's marker wins, the same
 * newest-first order and ownership test the upsert applies, and its
 * embedded record is the previous state. A comment from any other author is
 * not the run's history — a forged marker, however valid its record, is
 * skipped without ending the search. An own marker comment without a
 * readable record — an older action's comment, a cleared thread, a mangled
 * block — is a first run as far as reconciliation is concerned; older
 * comments are never fallen back to, because the newest own marker is the
 * thread's latest truth.
 *
 * @param {import("#core/forge.mjs").CommentEntry[]} comments the thread's comments, any order
 * @param {string} action the acting action's marker namespace
 * @param {string[]} ownLogins the logins this run's token writes as, resolved before the search
 * @returns {import("./canonical.mjs").CanonicalResult | undefined}
 */
export function previousRecord(comments, action, ownLogins) {
  for (const comment of [...comments].sort((a, b) => b.id - a.id)) {
    const login = comment.user?.login;
    if (login === undefined || !ownLogins.includes(login)) continue;
    const marker = parseMarker(comment.body);
    if (marker?.action !== action) continue;
    const record = parseRecordBlock(comment.body);
    if (record !== undefined && record.head === marker.head) return record;
    return undefined;
  }
  return undefined;
}

/**
 * The Controlled Mutation stage — the only writer in the Work Item pipeline.
 *
 * A `Decision` produced by the policy engine is executed here, and here
 * alone. It writes labels and the action's one comment — the no-sheet
 * classification or a sheet-mode signal — through the forge's primitives,
 * nothing else: assign, close, merge, review, any mention — all stay
 * unreachable, because no `Decision` this repository's policy can produce
 * names them (SECURITY ceiling #2). Dry run renders the decision and writes
 * nothing: absolute zero mutation means zero.
 *
 * Before any write, the thread is read live and the views the decision was
 * built from — the event payload's labels, and for a pull request the
 * snapshot's state, merged flag and head — are checked against it. The
 * payload and the snapshot are claims; the live read is the authority. A
 * thread that changed while the run was in flight is skipped with the
 * reason in the log: a decision derived from the old view is never applied
 * to a thread it no longer describes (the forge's read-twice doctrine,
 * `core/src/forge.mjs`; review does the same before publishing). The
 * comment upserts record the live head, which arms the marker upsert's
 * newer-head guard — a concurrent run that got there first is never
 * overwritten last-writer-wins.
 */

import { resolveOwnLogins, upsertComment } from "#core/comment.mjs";
import { info, warning } from "#core/runtime.mjs";

import { commentBody, renderDryRun, signalBody } from "./decision.mjs";

/** @typedef {import("./decision.mjs").Decision} Decision */

/**
 * @typedef {object} MutateInput
 * @property {Decision} decision the mutation plan to execute — never built here
 * @property {ReturnType<typeof import("#core/forge.mjs").createForge>} forge
 * @property {number} issueNumber
 * @property {boolean} dryRun preview and log, write nothing
 * @property {() => number} now the clock, for the comment marker
 * @property {string} action the action's name, for the comment marker
 * @property {string[]} threadLabels the thread's labels as the event payload claimed them — the view the decision was derived from
 * @property {SubjectClaim | null} subject the pull request facts the decision was built from; null exactly for an issue thread
 */

/**
 * The pull-request facts a run's decision was built from — the snapshot the
 * Evidence stage read. The live read arbitrates them at the write. `null`
 * says the thread is an issue, which has no head to move.
 *
 * @typedef {object} SubjectClaim
 * @property {string} head the head SHA the snapshot read
 * @property {string} state the snapshot's state — a run only writes while the thread is still open
 * @property {boolean} merged the snapshot's merged flag
 */

/**
 * The thread as GitHub has it at the moment of the read — the authority the
 * write is judged against.
 *
 * @typedef {object} LiveThread
 * @property {string[]} labels
 * @property {string | null} state null for an issue read, which this stage does not gate on
 * @property {boolean | null} merged null for an issue read
 * @property {string | null} head the head SHA; null for an issue, which has none
 */

/**
 * Emits a decision's log lines, then executes (or dry-run previews) it.
 *
 * @param {MutateInput} input
 * @returns {Promise<void>}
 */
export async function mutate({
  decision,
  forge,
  issueNumber,
  dryRun,
  now,
  action,
  threadLabels,
  subject,
}) {
  for (const line of decision.logs) {
    if (line.level === "warning") warning(line.text);
    else info(line.text);
  }

  if (dryRun) {
    for (const line of renderDryRun(decision)) info(line);
    return;
  }

  // The live re-read, immediately before anything is written — the pair of
  // reads that makes deciding on one view while writing on another
  // unreachable in practice. The payload's labels and the Evidence-stage
  // snapshot are claims; the thread itself is the authority, and a thread
  // that has moved on receives nothing: the decision was derived from a
  // view it no longer matches, and re-deriving it would mean another model
  // call, so the run skips with the reason in the log instead. Dry runs
  // render only, and pay for no read.
  const live = await readLiveThread(forge, issueNumber, subject !== null);
  const reason = divergenceReason(live, threadLabels, subject);
  if (reason !== null) {
    warning(
      `${action}: nothing written — the thread changed while this run was in flight: ${reason}`,
    );
    return;
  }

  // The head the upserts record — the live one, which the guard above has
  // just agreed with the claim. An issue has none: its markers carry no
  // head, and the newer-head guard simply never engages for it.
  const head = live.head === null ? undefined : live.head;

  if (decision.kind === "comment") {
    const answer = /** @type {{ classification: string, rationale: string }} */ (decision.comment);
    const ownLogins = await resolveOwnLogins(forge, info);
    const outcome = await upsertComment({
      store: forge,
      action,
      issueNumber,
      buildBody: (marker) => commentBody(answer, marker),
      ownLogins,
      head,
      startedAt: now(),
      log: info,
    });
    info(`classification comment ${outcome.outcome} (${String(outcome.id)})`);
    return;
  }

  if (decision.add.length > 0) {
    await forge.addLabels(issueNumber, decision.add);
  }
  for (const removal of decision.remove) {
    await forge.removeLabel(issueNumber, removal.name);
  }

  // A sheet-mode issue run may carry a code-composed signal: needs-more-info
  // or a best relationship. It is a comment in the same marker namespace as
  // the no-sheet classification, so the upsert keeps exactly one of the
  // action's comments on the thread whichever mode the last run used. The
  // signal is composed entirely by code — model text never reaches it.
  if (decision.signal != null) {
    const signal = decision.signal;
    const ownLogins = await resolveOwnLogins(forge, info);
    const outcome = await upsertComment({
      store: forge,
      action,
      issueNumber,
      buildBody: (marker) => signalBody(signal, marker),
      ownLogins,
      head,
      startedAt: now(),
      log: info,
    });
    info(`signal comment ${outcome.outcome} (${String(outcome.id)})`);
  }
}

/**
 * Reads the thread live — labels for every thread; for a pull request also
 * the state, merged flag and head.
 *
 * @param {ReturnType<typeof import("#core/forge.mjs").createForge>} forge
 * @param {number} issueNumber
 * @param {boolean} isPullRequest a pull request's snapshot read carries the facts an issue's does not
 * @returns {Promise<LiveThread>}
 */
async function readLiveThread(forge, issueNumber, isPullRequest) {
  if (!isPullRequest) {
    const { labels } = await forge.getIssue(issueNumber);
    return { labels, state: null, merged: null, head: null };
  }
  const snapshot = await forge.getPullRequest(issueNumber);
  return {
    labels: snapshot.labels,
    state: snapshot.state,
    merged: snapshot.merged,
    head: snapshot.head.sha,
  };
}

/**
 * The first reason the live thread cannot receive this decision, or null
 * when the thread still is the one the decision was built from. The
 * pull-request facts are judged absolutely — the run writes only while the
 * thread is open, unmerged and at the head the run read — and the labels
 * against the event payload's claim: any set difference is a thread the
 * decision no longer describes.
 *
 * @param {LiveThread} live
 * @param {string[]} threadLabels the payload's label claim
 * @param {SubjectClaim | null} subject the pull request claim; null for an issue
 * @returns {string | null}
 */
function divergenceReason(live, threadLabels, subject) {
  if (subject !== null) {
    if (live.state !== "open") {
      return `the pull request is now ${/** @type {string} */ (live.state)}`;
    }
    if (live.merged === true) return "the pull request is now merged";
    if (live.head !== subject.head) {
      return `the head is now ${String(live.head).slice(0, 12)}, not the ${subject.head.slice(0, 12)} this run read`;
    }
  }
  if (!sameLabels(live.labels, threadLabels)) {
    return (
      `the labels are now [${live.labels.join(", ")}], ` +
      `not the [${threadLabels.join(", ")}] the event carried`
    );
  }
  return null;
}

/**
 * Whether two label lists name the same set — order-insensitive.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function sameLabels(a, b) {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((name, index) => name === right[index]);
}

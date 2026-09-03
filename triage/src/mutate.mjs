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
 * The plan is executed remove-then-add with per-operation outcome capture:
 * the run log states what each operation did, and a run that dies part-way
 * raises a typed error naming exactly what applied, what failed, and what
 * was never attempted (failure class partial-mutation). A run cancelled
 * mid-mutation is the same class without the throw: it leaves the same
 * half-state behind, and there is no code to report it — the invariant that
 * covers both is the next run's: every run derives its plan from the state
 * it reads, and none ever replays a previous run's plan.
 */

import { resolveOwnLogins, upsertComment } from "#core/comment.mjs";
import { oneLine } from "#core/one-line.mjs";
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
 * One operation in a mutation plan, in execution order. `removeLabel` is
 * one write per name; `addLabels` is one batched write for the whole add
 * list; `upsertComment` is the signal comment's one marker upsert.
 *
 * @typedef {object} MutationOp
 * @property {"removeLabel" | "addLabels" | "upsertComment"} op the forge operation, as the accounting names it
 * @property {string} target what the operation acts on — the label names, or the comment's role
 * @property {() => Promise<void>} apply the call itself
 */

/**
 * A mutation stopped part-way. The message is the accounting: what applied,
 * what failed, what was never attempted — the run log states the thread's
 * state instead of leaving it to be reconstructed from timestamps. The
 * `cause` is the original operation's error.
 */
export class PartialMutationError extends Error {
  /**
   * @param {{ applied: string[], failed: string, notAttempted: string[] }} accounting
   * @param {Error} cause
   */
  constructor(accounting, cause) {
    super(
      `the triage mutation stopped part-way: ` +
        (accounting.applied.length > 0
          ? `applied [${accounting.applied.join(", ")}]`
          : `no operation had applied`) +
        `; ${accounting.failed} failed (${cause.message})` +
        (accounting.notAttempted.length > 0
          ? `; not attempted: [${accounting.notAttempted.join(", ")}]`
          : `; nothing further was planned`) +
        ` — the thread is left in a partial state; ` +
        `the next run re-derives from live state, it never replays this plan`,
    );
    this.name = "PartialMutationError";
    this.cause = cause;
  }
}

/**
 * The forge operation's name in the run log and the accounting — the target
 * carried so a failure names its write, not just its endpoint.
 *
 * @param {MutationOp} op
 * @returns {string}
 */
function describeOp(op) {
  return `${op.op} ${op.target}`;
}

/**
 * The log line as it may be emitted: control characters become spaces
 * before the collapse (#259). Decision log lines and the divergence reason
 * interpolate untrusted fragments — the model's rationale, a refused label
 * name, the live thread's labels — and `runtime.mjs` wraps a warning in a
 * workflow-command annotation, so a raw control character is log-forgery
 * material. `oneLine`'s whitespace collapse alone is not enough: escape and
 * separator control characters are not whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
function forLog(text) {
  return oneLine(text, { stripControlChars: true });
}

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
  // Every decision log line interpolates untrusted text — the model's
  // rationale, a refused label name, the live thread's labels — and a
  // warning is a workflow-command annotation, so an unstripped control
  // character is log-forgery material (#259). The strip happens here, at
  // the emission boundary, so a builder that forgets is still covered.
  for (const line of decision.logs) {
    if (line.level === "warning") warning(forLog(line.text));
    else info(forLog(line.text));
  }

  if (dryRun) {
    for (const line of renderDryRun(decision)) info(forLog(line));
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
      forLog(
        `${action}: nothing written — the thread changed while this run was in flight: ${reason}`,
      ),
    );
    return;
  }

  // The head the upserts record — the live one, which the guard above has
  // just agreed with the claim. An issue has none: its markers carry no
  // head, and the newer-head guard simply never engages for it.
  const head = live.head === null ? undefined : live.head;

  if (decision.kind === "comment") {
    const answer = /** @type {{ classification: string, rationale: string }} */ (decision.comment);
    const ownLogins = await resolveOwnLogins(forge);
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

  // Remove-then-add, never add-then-remove. The order decides which
  // half-state a run that dies part-way leaves behind: an addition lost
  // leaves the thread without a label the decision was about to place — a
  // state the next run re-derives and repairs. A removal lost leaves the
  // stale claim standing — the previous size rung beside the new one, the
  // queue marker beside its category — and a thread that claims what the
  // decision was withdrawing is the less safe half.
  /** @type {MutationOp[]} */
  const ops = [];
  for (const removal of decision.remove) {
    ops.push({
      op: "removeLabel",
      target: removal.name,
      apply: async () => {
        await forge.removeLabel(issueNumber, removal.name);
      },
    });
  }
  if (decision.add.length > 0) {
    const adds = decision.add;
    ops.push({
      op: "addLabels",
      target: `[${adds.join(", ")}]`,
      apply: async () => {
        await forge.addLabels(issueNumber, adds);
      },
    });
  }
  if (decision.signal != null) {
    const signal = decision.signal;
    ops.push({
      op: "upsertComment",
      target: "signal comment",
      apply: async () => {
        // A sheet-mode issue run may carry a code-composed signal:
        // needs-more-info or a best relationship. It is a comment in the
        // same marker namespace as the no-sheet classification, so the
        // upsert keeps exactly one of the action's comments on the thread
        // whichever mode the last run used. The signal is composed entirely
        // by code — model text never reaches it.
        const ownLogins = await resolveOwnLogins(forge);
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
      },
    });
  }

  // Per-operation outcome capture. Each operation is attempted in order and
  // its landing is logged; the first failure raises the accounting as a
  // typed error and abandons everything after it — a write is never
  // attempted after one has already failed in the same plan.
  /** @type {string[]} */
  const applied = [];
  for (const [index, op] of ops.entries()) {
    try {
      await op.apply();
    } catch (cause) {
      throw new PartialMutationError(
        {
          applied: [...applied],
          failed: describeOp(op),
          notAttempted: ops.slice(index + 1).map(describeOp),
        },
        cause instanceof Error ? cause : new Error(String(cause)),
      );
    }
    info(`applied ${describeOp(op)}`);
    applied.push(describeOp(op));
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

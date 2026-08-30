/**
 * The Controlled Mutation stage — the only writer in the Work Item pipeline.
 *
 * A `Decision` produced by the policy engine is executed here, and here
 * alone. It writes labels and one comment through the forge's primitives,
 * nothing else: assign, close, merge, review, any mention — all stay
 * unreachable, because no `Decision` this repository's policy can produce
 * names them (SECURITY ceiling #2). Dry run renders the decision and writes
 * nothing: absolute zero mutation means zero.
 */

import { resolveOwnLogins, upsertComment } from "#core/comment.mjs";
import { info, warning } from "#core/runtime.mjs";

import { commentBody, renderDryRun } from "./decision.mjs";

/** @typedef {import("./decision.mjs").Decision} Decision */

/**
 * @typedef {object} MutateInput
 * @property {Decision} decision the mutation plan to execute — never built here
 * @property {ReturnType<typeof import("#core/forge.mjs").createForge>} forge
 * @property {number} issueNumber
 * @property {boolean} dryRun preview and log, write nothing
 * @property {() => number} now the clock, for the comment marker
 * @property {string} action the action's name, for the comment marker
 */

/**
 * Emits a decision's log lines, then executes (or dry-run previews) it.
 *
 * @param {MutateInput} input
 * @returns {Promise<void>}
 */
export async function mutate({ decision, forge, issueNumber, dryRun, now, action }) {
  for (const line of decision.logs) {
    if (line.level === "warning") warning(line.text);
    else info(line.text);
  }

  if (dryRun) {
    for (const line of renderDryRun(decision)) info(line);
    return;
  }

  if (decision.kind === "comment") {
    const answer = /** @type {{ classification: string, rationale: string }} */ (decision.comment);
    const ownLogins = await resolveOwnLogins(forge, info);
    const outcome = await upsertComment({
      store: forge,
      action,
      issueNumber,
      buildBody: (marker) => commentBody(answer, marker),
      ownLogins,
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
}

/**
 * One review run, end to end, over injected dependencies — the part of
 * `review` that decides, in order: whether there is anything here at all,
 * what exists for this review, what the model may see and do, what came
 * back, and whether any of it may be published. Every write this module
 * performs is its own decision; model output is data at every step.
 *
 * The publication law, restated where it bites: skips and abandonments are
 * green no-ops; failures are red and never delete or overwrite the last
 * complete review; a COMPLETE answer always upserts (clearing stale
 * findings); PARTIAL says so prominently; dry-run writes nothing anywhere.
 */

import { createWorkspace } from "#core/workspace.mjs";
import { markerLine, parseMarker, resolveOwnLogins, upsertComment } from "#core/comment.mjs";

import { loadConfigFile, validateConfig, loadDocuments } from "./config.mjs";
import { buildInventory, selectActiveRules } from "./inventory.mjs";
import { canConcludeReview, parseDiffPaths, unifiedDiff } from "./coverage.mjs";
import { createTools } from "./tools.mjs";
import { buildPrompt } from "./prompt.mjs";
import { runLoop, reaskFinalAnswer, estimateTokens } from "./loop.mjs";
import { parseAnswer, validateAnswer } from "./answer.mjs";
import { renderComment, renderNothingToReview } from "./render.mjs";

/**
 * The forge operations one review run makes, listed so a test doubles only
 * these and a client missing one is a type error. A slice of `createForge`,
 * structurally satisfied by it.
 *
 * @typedef {object} ReviewForge
 * @property {(number: number) => Promise<import("#core/forge.mjs").PullRequestSnapshot>} getPullRequest
 * @property {() => Promise<{ defaultBranch: string, name: string, description: string }>} getRepository
 * @property {(number: number) => Promise<import("#core/forge.mjs").PullRequestFile[]>} listPullRequestFiles
 * @property {(number: number) => Promise<import("#core/forge.mjs").CommentEntry[]>} listComments
 * @property {(number: number, body: string) => Promise<{ id: number }>} createComment
 * @property {(id: number, body: string) => Promise<void>} updateComment
 * @property {(path: string) => Promise<{ content: string } | null>} getContents reads the default branch
 * @property {(id: number) => Promise<void>} deleteComment
 * @property {() => Promise<{ login: string }>} whoami the token's writing identity
 */

/** The chat seam is the whole client; its shape is the protocol's. */

export const ACTION = "review";

/**
 * @typedef {object} RunInputs the action's own knobs, already read and validated
 * @property {string} model
 * @property {number} maxTurns
 * @property {number} contextWindow
 * @property {boolean} dryRun
 * @property {string} configPath
 */

/**
 * @typedef {object} Io
 * @property {ReviewForge} forge
 * @property {import("#core/chat.mjs").Chat} chat
 * @property {() => number} now epoch milliseconds
 * @property {(message: string) => void} info
 */

/**
 * @typedef {object} RunResult
 * @property {"skip" | "abandoned" | "nothing-to-review" | "published" | "dry-run"} outcome
 * @property {string} reason human-readable, logged by the caller
 * @property {number} [commentId]
 */

/**
 * @param {object} input
 * @param {RunInputs} input.inputs
 * @param {{ owner: string, repo: string, workspace: string }} input.context
 * @param {number} input.pullRequestNumber
 * @param {Io} input.io
 * @returns {Promise<RunResult>}
 */
export async function reviewPullRequest({ inputs, context, pullRequestNumber, io }) {
  // Sampled once at the very start: core's newer-head guard compares the
  // comment's server-side update time against THIS moment, not write time.
  const startedAt = io.now();
  // ── Snapshot: one read fixes the subject ────────────────────────────────
  const snapshot = await io.forge.getPullRequest(pullRequestNumber);
  if (snapshot.draft) {
    return {
      outcome: "skip",
      reason: `#${String(pullRequestNumber)} is a draft — not ready means not reviewed`,
    };
  }
  if (snapshot.state !== "open" || snapshot.merged) {
    return {
      outcome: "skip",
      reason: `#${String(pullRequestNumber)} is ${snapshot.state}${snapshot.merged ? " and merged" : ""}`,
    };
  }
  const headSha = snapshot.head.sha;

  // ── Policy: config, documents, all before the first model call ─────────
  const loaded = await loadConfigFile({ forge: io.forge, configPath: inputs.configPath });
  const config = validateConfig(loaded.raw);
  const documents = await loadDocuments({ forge: io.forge, config });

  // ── Universe: inventory, budget, rules ──────────────────────────────────
  const files = await io.forge.listPullRequestFiles(pullRequestNumber);
  const inventory = buildInventory({
    files,
    ignore: config.ignore,
    maxDiffLines: config.maxDiffLines,
  });
  if (inventory.excluded.length > 0) {
    throw new Error(
      `the diff counts ${String(inventory.countedDiffLines + inventory.excludedDiffLines)} lines ` +
        `against a ${String(config.maxDiffLines)}-line budget — the ${String(inventory.excluded.length)} ` +
        `file(s) past the break (${inventory.excluded[0]?.filename ?? ""} onward) are refused, not half-reviewed`,
    );
  }

  if (inventory.reviewed.length === 0) {
    return nothingToReview({ pullRequestNumber, headSha, io, dryRun: inputs.dryRun, startedAt });
  }

  // ── Coverage: the expected set, derived in code from the diff ───────────
  const expectedPaths = parseDiffPaths(unifiedDiff(inventory.reviewed));
  const reviewedNames = new Set(inventory.reviewed.map((file) => file.filename));
  if (
    expectedPaths.length !== reviewedNames.size ||
    !expectedPaths.every((path) => reviewedNames.has(path))
  ) {
    throw new Error(
      `coverage accounting derived ${String(expectedPaths.length)} of ` +
        `${String(reviewedNames.size)} expected path(s) from the diff — a derivation that ` +
        `cannot account for the whole universe is refused, not under-counted`,
    );
  }

  // ── The conversation's raw materials ────────────────────────────────────
  const activeRules = selectActiveRules(config.rules, inventory.reviewed);
  /** @type {Map<string, string>} */
  const ruleDocuments = new Map();
  for (const rule of activeRules) {
    const document = documents.ruleDocuments.get(rule.instruction);
    if (document !== undefined) ruleDocuments.set(rule.instruction, document);
  }

  const repository = await io.forge.getRepository();
  const { messages, evidence } = buildPrompt({
    repoName: `${context.owner}/${context.repo}`,
    repoDescription: repository.description,
    baseSha: snapshot.base.sha,
    headSha,
    title: snapshot.title,
    body: snapshot.body,
    language: config.language,
    strictness: config.strictness,
    strategy: config.strategy,
    reviewed: inventory.reviewed,
    instruction: documents.instruction,
    activeRules,
    ruleDocuments,
  });

  const workspace = createWorkspace({ root: context.workspace });
  const tools = createTools({ workspace, evidence, ignore: config.ignore });

  const estimated = estimateTokens(messages);
  if (estimated > inputs.contextWindow / 2) {
    throw new Error(
      `the assembled prompt estimates at ${String(estimated)} tokens, past half the ` +
        `${String(inputs.contextWindow)}-token window — a review that cannot fit is refused, not truncated`,
    );
  }

  // ── The loop ────────────────────────────────────────────────────────────
  const outcome = await runLoop({
    chat: io.chat,
    model: inputs.model,
    tools,
    messages,
    maxTurns: inputs.maxTurns,
    contextWindow: inputs.contextWindow,
    expectedPaths,
  });
  for (const line of outcome.log) io.info(`review: ${line}`);
  io.info(
    `review: coverage ${outcome.coverage.covered.length}/${String(outcome.coverage.total)} expected file(s) read`,
  );

  let parsed = parseAnswer(outcome.candidate);
  if (!parsed.ok && outcome.naturalStopped) {
    // The one re-ask: natural stops only, once, tools withheld inside.
    io.info("review: the first answer failed the contract — asking once more");
    const second = await reaskFinalAnswer({
      chat: io.chat,
      model: inputs.model,
      transcript: outcome.transcript,
    });
    parsed = parseAnswer(second);
  }
  if (!parsed.ok) {
    throw new Error(`the final answer failed the output contract twice: ${parsed.defect}`);
  }

  const validated = validateAnswer({
    rawFindings: parsed.rawFindings,
    summary: parsed.summary,
    reviewed: inventory.reviewed,
    workspace,
  });

  for (const rejection of validated.rejections) io.info(`review: finding rejected — ${rejection}`);
  // Strictness is review policy, not a rendering detail: at low the nits
  // leave the published set here — each drop logged, concerns untouchable.
  const findings = applyStrictness(validated.findings, config.strictness, (line) => io.info(line));

  // The concluding state is code's verdict: a bound or a coverage gap names
  // the partial reason; the model's summary text is never consulted.
  const status = concludingStatus(outcome, config.strictness);
  const body = renderComment({
    status: status.label,
    headSha,
    coverage: outcome.coverage,
    summary: validated.summary,
    findings,
    strictness: config.strictness,
    ...(status.label === "Partial" ? { partialReason: status.reason } : {}),
  });

  // ── Before publication: the guard that makes stale reviews unreachable ──
  const fresh = await io.forge.getPullRequest(pullRequestNumber);
  if (fresh.state !== "open" || fresh.draft || fresh.head.sha !== headSha) {
    return {
      outcome: "abandoned",
      reason:
        `#${String(pullRequestNumber)} moved while it was being reviewed ` +
        `(now ${fresh.state} at ${fresh.head.sha.slice(0, 12)}) — nothing written`,
    };
  }

  if (inputs.dryRun) {
    io.info(`review: dry run — the comment that would have been published:\n${body}`);
    return { outcome: "dry-run", reason: "dry run: nothing written" };
  }
  // The identity read sits behind every skip and dry-run gate: paid only by
  // a run about to write.
  const ownLogins = await resolveOwnLogins(io.forge, (message) => io.info(`review: ${message}`));

  const upsert = await upsertComment({
    store: io.forge,
    action: ACTION,
    issueNumber: pullRequestNumber,
    buildBody: (marker) => `${marker}\n${body}`,
    ownLogins,
    head: headSha,
    startedAt,
  });
  return {
    outcome: "published",
    reason: `${status.label} review published (${findings.length} findings)`,
    commentId: upsert.id,
  };
}

/**
 * The strictness policy over the validated list. At `low` a nit is below
 * the inclusion bar: it leaves the set here, before rendering, and its drop
 * is logged like any other refusal — the model never controls its own bar,
 * and `medium`/`high` keep every finding. Rendering still omits low's nits
 * section, which this makes trivially empty rather than load-bearing.
 *
 * @param {import("./answer.mjs").Finding[]} findings the validated, capped list
 * @param {import("./config.mjs").Strictness} strictness
 * @param {(line: string) => void} info the run's log sink
 * @returns {import("./answer.mjs").Finding[]} the published set
 */
function applyStrictness(findings, strictness, info) {
  if (strictness !== "low") return findings;
  /** @type {import("./answer.mjs").Finding[]} */
  const kept = [];
  for (const finding of findings) {
    if (finding.severity === "nit") {
      info(
        `review: nit dropped at low strictness — ${finding.file}:${String(finding.line)} ${finding.message}`,
      );
      continue;
    }
    kept.push(finding);
  }
  return kept;
}

/**
 * The universe emptied: an existing marker gets a deterministic clearing
 * body so stale findings do not outlive their relevance; with no marker,
 * a green log line is the whole result.
 *
 * @param {{ pullRequestNumber: number, headSha: string, io: Io, dryRun: boolean, startedAt: number }} input
 * @returns {Promise<RunResult>}
 */
async function nothingToReview({ pullRequestNumber, headSha, io, dryRun, startedAt }) {
  // Same publication guard as the main path: the clearing update is a
  // write, and writes re-check state and head first.
  const fresh = await io.forge.getPullRequest(pullRequestNumber);
  if (fresh.state !== "open" || fresh.draft || fresh.head.sha !== headSha) {
    return {
      outcome: "abandoned",
      reason: `#${String(pullRequestNumber)} moved while it was being reviewed — nothing written`,
    };
  }
  // Same gate as the write below: the identity read is paid only when a
  // marker comment may actually be claimed.
  const ownLogins = await resolveOwnLogins(io.forge, (message) => io.info(`review: ${message}`));
  const comments = await io.forge.listComments(pullRequestNumber);
  for (const comment of [...comments].sort((a, b) => b.id - a.id)) {
    const marker = parseMarker(comment.body);
    if (
      marker?.action === ACTION &&
      comment.user?.login !== undefined &&
      ownLogins.includes(comment.user.login)
    ) {
      const body = `${markerLine(ACTION, marker.id ?? "", headSha)}\n${renderNothingToReview(headSha)}`;
      if (dryRun) {
        io.info(`review: dry run — the clearing update that would have been written:\n${body}`);
        return { outcome: "dry-run", reason: "dry run: universe empty, nothing written" };
      }
      const upsert = await upsertComment({
        store: io.forge,
        action: ACTION,
        issueNumber: pullRequestNumber,
        buildBody: () => body,
        ownLogins,
        head: headSha,
        startedAt,
      });
      void upsert;
      return { outcome: "nothing-to-review", reason: "universe empty — marker cleared" };
    }
  }
  return { outcome: "skip", reason: "universe empty and no prior review comment — nothing to do" };
}

/**
 * Where the bound that ended a review becomes the sentence the comment
 * leads with.
 *
 * @param {import("./loop.mjs").Bound} bound
 * @returns {string}
 */
function partialReason(bound) {
  switch (bound) {
    case "max-turns":
      return "the reading-turn budget was reached before the reviewer stopped asking questions.";
    case "tool-calls":
      return "the tool-call ceiling was reached before the reviewer stopped reading.";
    case "evidence":
      return "the evidence budget was reached before the reviewer finished reading.";
  }
}

/**
 * The concluding state, decided by code: a fired bound is Partial with the
 * bound named; under the strict arm (`high`), unread expected files are
 * Partial with the gap named; otherwise Complete. The coverage verdict is
 * `canConcludeReview`'s — the model's summary text is never consulted.
 *
 * @param {import("./loop.mjs").LoopOutcome} outcome
 * @param {import("./config.mjs").Strictness} strictness
 * @returns {{ label: "Complete" | "Partial", reason?: string }}
 */
function concludingStatus(outcome, strictness) {
  if (outcome.bound !== undefined) {
    return { label: "Partial", reason: partialReason(outcome.bound) };
  }
  if (!canConcludeReview(outcome.coverage, strictness)) {
    return { label: "Partial", reason: coverageReason(outcome.coverage) };
  }
  return { label: "Complete" };
}

/**
 * The coverage gap becomes the sentence a partial review leads with, in
 * the same voice as `partialReason`'s.
 *
 * @param {import("./coverage.mjs").CoverageReport} report
 * @returns {string}
 */
function coverageReason(report) {
  const files = report.total === 1 ? "file was" : "files were";
  return (
    `${String(report.uncovered.length)} of ${String(report.total)} changed ${files} never ` +
    `read: ${report.uncovered.join(", ")}.`
  );
}

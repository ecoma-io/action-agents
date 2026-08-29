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
import { createEvidence } from "#core/untrusted.mjs";
import { markerLine, parseMarker, resolveOwnLogins, upsertComment } from "#core/comment.mjs";

import { loadConfigFile, validateConfig, loadDocuments } from "./config.mjs";
import { buildInventory, selectActiveRules } from "./inventory.mjs";
import { normaliseReadPath, parseDiffPaths, unifiedDiff } from "./coverage.mjs";
import { createTools, TOOL_SPECS } from "./tools.mjs";
import { classifyRisk } from "./risk.mjs";
import { assignLanes, laneBudget } from "./lanes.mjs";
import { buildPrompt } from "./prompt.mjs";
import { MAX_CALL_ARGUMENT_BYTES, runLoop, reaskFinalAnswer, estimateTokens } from "./loop.mjs";
import { evaluateGate, evaluateGates } from "./gates.mjs";
import { parseAnswer, validateAnswer } from "./answer.mjs";
import {
  applyVerdicts,
  parseVerdict,
  planVerification,
  verifierMessages,
  VERIFIER_MAX_EVIDENCE_BYTES,
  VERIFIER_MAX_TOOL_CALLS,
} from "./verify.mjs";
import { attachProvenance, readsFromRecordedReads } from "./provenance.mjs";
import { renderComment, renderNothingToReview } from "./render.mjs";
import { assertFreshArtifact, buildArtifact, withCommentId } from "./artifact.mjs";

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
 * @property {"skip" | "abandoned" | "nothing-to-review" | "published" | "published-without-artifact" | "dry-run"} outcome
 * @property {string} reason human-readable, logged by the caller
 * @property {number} [commentId]
 * @property {import("./artifact.mjs").RunArtifact} [artifact] the machine-readable run record — present only when the run published, the comment's own identity is known, and the fresh read at write time still names the reviewed head; absent when the artifact file write failed after the comment was published (outcome `published-without-artifact`)
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

  // A deletion's own diff section is in the prompt by construction — the removed
  // lines are the content there is to examine, and read_file cannot open a path
  // the reviewed head no longer has. The code records that inspection up front:
  // a deterministic set seeded into the loop's ledger, derived from the same
  // inventory entries that rendered the sections, through the same normalisation
  // the read record uses. Nothing the model writes can grow or shrink it, and
  // the expected set itself does not move — a deletion stays expected; what
  // changes is only that the expectation can now be met.
  const diffInspectedPaths = inventory.reviewed
    .filter((file) => file.status === "removed")
    .map((file) => normaliseReadPath(file.filename));

  // ── Attention: lanes, fixed before any model call ───────────────────────
  // Per-file risk comes from the same deterministic classifier the plan
  // documents describe — one file per call, so each row is that file's
  // own plan. Config and classifier are the only inputs: nothing the
  // model says can move a file between lanes.
  const lanes = assignLanes(
    inventory.reviewed.map((file) => ({ path: file.filename, riskPlan: classifyRisk([file]) })),
    config,
  );
  const laneBudgets = laneBudget(lanes, inputs.maxTurns);

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
    lanes,
    laneBudgets,
    reviewed: inventory.reviewed,
    instruction: documents.instruction,
    activeRules,
    ruleDocuments,
  });

  const workspace = createWorkspace({ root: context.workspace });
  /** The verification ledger: bytes the loop actually captured, keyed by
   * normalised path. The pass verifies only against these. */
  /** @type {Map<string, string>} */
  const recordedReads = new Map();
  const tools = createTools({ workspace, evidence, ignore: config.ignore, recordedReads });

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
    diffInspectedPaths,
    strictness: config.strictness,
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
  // Gate `conclusion` — the output contract held after at most the one
  // re-ask. The refusal fires here, before validation, verification or
  // publication spend a single further call against an answer that never
  // satisfied the contract.
  const answer = parsed.ok
    ? { rawFindings: parsed.rawFindings, summary: parsed.summary }
    : undefined;
  const conclusion = evaluateGate(
    "conclusion",
    parsed.ok ? { held: true } : { held: false, defect: parsed.defect },
  );
  if (answer === undefined || !conclusion.passed) {
    io.info(`review: gate ${conclusion.gate} failed — ${conclusion.reason}`);
    throw new Error(`the final answer failed the output contract twice: ${conclusion.reason}`);
  }

  const validated = validateAnswer({
    rawFindings: answer.rawFindings,
    summary: answer.summary,
    reviewed: inventory.reviewed,
    workspace,
  });
  for (const rejection of validated.rejections) io.info(`review: finding rejected — ${rejection}`);
  // Provenance is the code's own bookkeeping, applied before the nit-drop:
  // a finding publishes only where the loop's recorded reads already went.
  // An unanchored finding is quarantined — logged by identity, reason
  // `unanchored` — never silently discarded, never published, never
  // verified against evidence the loop does not hold.
  const anchored = attachProvenance(validated.findings, readsFromRecordedReads(recordedReads));
  for (const quarantined of anchored.quarantined) {
    io.info(
      `review: finding quarantined — unanchored: ${quarantined.finding.file}:${String(quarantined.finding.line)} ` +
        `${quarantined.finding.message}`,
    );
  }
  // Strictness is review policy, not a rendering detail: at low the nits
  // leave the published set here — each drop logged, concerns untouchable.
  const findings = applyStrictness(anchored.published, config.strictness, (line) => io.info(line));

  // The verification pass sits between the nit-drop and rendering: planned
  // findings each get their own bounded investigation, and verdicts assign
  // each one its lifecycle state — refuted and unresolved publish, labeled.
  // What it publishes is what renders and what the count names.
  const verified = await runVerificationPass({
    findings,
    policy: { strategy: config.strategy, strictness: config.strictness },
    lanes,
    recordedReads,
    workspace,
    ignore: config.ignore,
    chat: io.chat,
    model: inputs.model,
    info: (line) => io.info(`review: ${line}`),
  });
  const published = verified.findings;

  // The declared gates decide the concluding posture — the loop's bound
  // accounting, the coverage condition, the publication invariants. The
  // provenance facts are the FINAL published set — the collection the
  // comment body (and, once wired, the artifact) carries: post nit-drop,
  // post verification — and the gate re-derives every published finding's
  // anchor from the run's recorded reads itself, not from the references
  // the findings already wear. The model's summary text is never
  // consulted; each refusal names its gate in the log, and the first
  // failure's reason leads the partial comment.
  const report = evaluateGates({
    conclusion: { held: true },
    bound: {
      bound: outcome.bound,
      readingTurns: outcome.readingTurns,
      maxTurns: outcome.maxTurns,
      toolCalls: outcome.toolCalls,
      maxToolCalls: outcome.maxToolCalls,
      evidenceBytes: outcome.evidenceBytes,
      maxEvidenceBytes: outcome.maxEvidenceBytes,
    },
    coverage: { report: outcome.coverage, strictness: config.strictness },
    provenance: {
      published,
      quarantined: anchored.quarantined,
      ledger: readsFromRecordedReads(recordedReads),
    },
    verification: verified.accounting,
  });
  for (const result of report.failed) {
    io.info(`review: gate ${result.gate} failed — ${result.reason}`);
  }
  /** @type {{ label: "Complete" | "Partial", reason?: string }} */
  const status = report.mayPublish
    ? { label: "Complete" }
    : { label: "Partial", reason: report.failed[0]?.reason ?? "the run's gates did not all pass" };
  const body = renderComment({
    status: status.label,
    headSha,
    coverage: outcome.coverage,
    summary: validated.summary,
    findings: published,
    strictness: config.strictness,
    quarantinedCount: anchored.quarantined.length,
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

  // The artifact is the run's machine-readable record, built from the same
  // final facts the comment renders — BEFORE the comment, so every refusal
  // buildArtifact can raise refuses a run that has not yet written anything
  // irreversible. The one fact it cannot hold yet is the comment's identity:
  // the upsert below returns it and `withCommentId` attaches it, so the two
  // records still name each other. `published` carries the provenance the
  // anchoring pass put on every finding (the provenance gate re-derives the
  // anchors itself, and buildArtifact refuses a finding without one).
  const publishedAnchored =
    /** @type {Array<import("./verify.mjs").VerifiedFinding & { provenance: import("./provenance.mjs").Provenance }>} */ (
      published
    );
  const verificationGate = report.results.find((result) => result.gate === "verification");
  if (verificationGate === undefined) {
    throw new Error("the declared gates hold no verification entry — the gate table is broken");
  }
  const reason = `${status.label} review published (${published.length} findings)`;
  const artifact = buildArtifact({
    repository: `${context.owner}/${context.repo}`,
    pullRequest: pullRequestNumber,
    headRef: headSha,
    outcome: { classification: "published", reason },
    policy: { strictness: config.strictness, strategy: config.strategy },
    risk: lanes,
    findings: publishedAnchored,
    verification: {
      gate: verificationGate.passed
        ? { passed: true }
        : { passed: false, reason: verificationGate.reason ?? "" },
    },
    gates: report.results,
    coverage: outcome.coverage,
    phases: outcome.phaseLog,
    provenance: {},
  });

  // The built record is validated against a read taken here — before the
  // comment exists — so a refusal of the record refuses a run that has
  // written nothing, never one that has already spoken.
  const preComment = await io.forge.getPullRequest(pullRequestNumber);
  try {
    assertFreshArtifact(artifact, preComment.head.sha);
  } catch (cause) {
    return {
      outcome: "abandoned",
      reason:
        `#${String(pullRequestNumber)} moved while it was being reviewed ` +
        `(${cause instanceof Error ? cause.message : String(cause)}) — nothing written`,
    };
  }

  const upsert = await upsertComment({
    store: io.forge,
    action: ACTION,
    issueNumber: pullRequestNumber,
    buildBody: (marker) => `${marker}\n${body}`,
    ownLogins,
    head: headSha,
    startedAt,
  });
  const record = withCommentId(artifact, upsert.id);

  // The comment's newer-head rule extends to the artifact, and the guard
  // runs on a read taken here — at the write, after the comment exists —
  // not on the object the pre-publication guard already proved. A push
  // landing in that window must end in no artifact, never in an artifact
  // describing a head the pull request has already left; the run reports
  // the abandonment and the comment it leaves standing.
  const freshAtWrite = await io.forge.getPullRequest(pullRequestNumber);
  try {
    assertFreshArtifact(record, freshAtWrite.head.sha);
  } catch (cause) {
    return {
      outcome: "abandoned",
      reason:
        `#${String(pullRequestNumber)} moved while its review was being published ` +
        `(comment ${String(upsert.id)} stands) — the artifact is not written: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    };
  }
  return {
    outcome: "published",
    reason,
    commentId: upsert.id,
    artifact: record,
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
 * The adversarial verification pass, between the nit-drop and rendering.
 * Each planned finding gets its own bounded investigation — a fresh
 * conversation with the fixed tools, a fresh evidence wrapper, and the
 * verifier's own budget independent of the reviewer's. Manners defects
 * become tool errors the verifier can correct; protocol defects degrade
 * that finding to `uncertain` — a verifier misbehaving must never crash
 * the whole review. Verdicts assign each planned finding its lifecycle
 * state and delete nothing; the plan is policy, and the ledger — what was
 * read, what the lanes assigned — is evidence. Every decision is rendered
 * into the run log.
 *
 * @param {object} input
 * @param {import("./answer.mjs").Finding[]} input.findings the post-nit-drop set
 * @param {{ strategy: import("./config.mjs").Strategy, strictness: import("./config.mjs").Strictness }} input.policy the config's strategy and strictness — the gate's mode policy is derived from both
 * @param {import("./lanes.mjs").LaneAssignment[]} input.lanes the lanes code assigned before the loop
 * @param {ReadonlyMap<string, string>} input.recordedReads the loop's captured read bytes
 * @param {import("#core/workspace.mjs").Workspace} input.workspace the confined resolver every verifier path goes through
 * @param {string[]} input.ignore the config's universe filter, glob patterns
 * @param {import("#core/chat.mjs").Chat} input.chat
 * @param {string} input.model
 * @param {(line: string) => void} input.info the run's log sink, `review:`-prefixed
 * @returns {Promise<{ findings: import("./verify.mjs").VerifiedFinding[], accounting: import("./gates.mjs").VerificationFacts }>} the publication set and the recorded outcome the verification gate judges
 */
async function runVerificationPass({
  findings,
  policy,
  lanes,
  recordedReads,
  workspace,
  ignore,
  chat,
  model,
  info,
}) {
  const lanesByPath = new Map(lanes.map((lane) => [lane.path, lane.lane]));
  const plan = planVerification(findings, {
    strategy: policy.strategy,
    laneOf: (path) => lanesByPath.get(path),
    recordedReads,
  });
  info(
    `verification pass — planned ${String(plan.items.length)} of ${String(findings.length)} finding(s)`,
  );
  for (const skip of plan.skipped) {
    info(
      `verification pass — ${skip.finding.file}:${String(skip.finding.line)} left unverified: ${skip.reason}`,
    );
  }
  /** @type {import("./verify.mjs").VerdictEntry[]} */
  const verdicts = [];
  for (const item of plan.items) {
    verdicts.push({
      id: item.id,
      ...(await oneVerdict({ item, chat, model, workspace, ignore, info })),
    });
  }
  const applied = applyVerdicts(findings, verdicts, plan);
  for (const refusal of applied.refusals) {
    info(`verification pass — ${refusal}`);
  }
  for (const finding of applied.findings) {
    if (finding.verdict === undefined || finding.lifecycle === "confirmed") {
      continue;
    }
    info(
      `verification pass — ${finding.verdict} ${finding.file}:${String(finding.line)} ` +
        `(finding ${finding.id}): ${finding.reason}`,
    );
  }
  return {
    findings: applied.findings,
    accounting: {
      planned: plan.items.map((item) => item.id),
      outcomes: applied.findings.flatMap((finding) => {
        if (finding.id === undefined || finding.lifecycle === undefined) return [];
        return [
          {
            id: finding.id,
            lifecycle: finding.lifecycle,
            ...(finding.verdict !== undefined ? { verdict: finding.verdict } : {}),
            ...(finding.reason !== undefined ? { reason: finding.reason } : {}),
          },
        ];
      }),
      skipped: plan.skipped.map((skip) => ({
        file: skip.finding.file,
        line: skip.finding.line,
        reason: skip.reason,
      })),
      strategy: policy.strategy,
      strictness: policy.strictness,
    },
  };
}

/**
 * The instruction delivered when the verifier's budget fires — one
 * final request, tools withheld, so the verifier judges from the evidence
 * already gathered rather than going silent.
 */
const VERIFIER_BUDGET_INSTRUCTION =
  "The verification budget for this finding is spent. Answer now with only " +
  "the JSON verdict object — judged from the evidence already gathered.";

/**
 * One bounded verification investigation: a fresh conversation per finding
 * with the fixed three tools, the verifier's own budget, and the reviewer's
 * confinement. The loop mirrors the reviewer's dispatch rules:
 *
 *  - manners defects (wrong arguments, unknown tool name, policy refusals)
 *    become tool error results the verifier can correct;
 *  - protocol defects (unparsable arguments, oversized call arguments,
 *    a `fatal` result) degrade the finding to `uncertain` — a verifier
 *    misbehaving must never crash the whole review;
 *  - budget exhaustion (tool-call ceiling or evidence ceiling) triggers
 *    one final no-tools request; a refusal there is `uncertain`;
 *  - transport failure is `uncertain` (existing rule).
 *
 * @param {{ item: import("./verify.mjs").VerificationItem, chat: import("#core/chat.mjs").Chat, model: string, workspace: import("#core/workspace.mjs").Workspace, ignore: string[], info: (line: string) => void }} input
 * @returns {Promise<{ verdict: import("./verify.mjs").Verdict, reason: string }>}
 */
async function oneVerdict({ item, chat, model, workspace, ignore, info }) {
  const evidence = createEvidence();
  const tools = createTools({ workspace, evidence, ignore, recordedReads: new Map() });
  /** @type {import("#core/chat.mjs").ChatMessage[]} */
  const messages = verifierMessages(item, evidence);
  let toolCalls = 0;
  let evidenceBytes = 0;
  try {
    for (;;) {
      const response = await chat.complete({ model, messages, tools: TOOL_SPECS });
      if (response.toolCalls.length === 0) {
        return settle(item, parseVerdict(response.content), info);
      }
      messages.push({
        role: "assistant",
        content: response.content === "" ? null : response.content,
        toolCalls: response.toolCalls,
      });
      for (const call of response.toolCalls) {
        if (toolCalls >= VERIFIER_MAX_TOOL_CALLS) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: "(not executed — the verification budget for this finding was spent)",
          });
          continue;
        }
        toolCalls++;
        if (Buffer.byteLength(call.arguments, "utf8") > MAX_CALL_ARGUMENT_BYTES) {
          return wireDefect(
            item,
            `'${call.id}' carried ${String(Buffer.byteLength(call.arguments, "utf8"))} bytes of arguments — beyond any legitimate call`,
            info,
          );
        }
        const result = tools.execute(call.name, call.arguments);
        if (result.fatal === true) {
          return wireDefect(
            item,
            `'${call.id}' carried unparsable arguments — the wire contract is broken`,
            info,
          );
        }
        if (result.ok) evidenceBytes += Buffer.byteLength(result.output, "utf8");
        messages.push({ role: "tool", toolCallId: call.id, content: result.output });
      }
      if (toolCalls >= VERIFIER_MAX_TOOL_CALLS || evidenceBytes >= VERIFIER_MAX_EVIDENCE_BYTES) {
        const bound = evidenceBytes >= VERIFIER_MAX_EVIDENCE_BYTES ? "evidence" : "tool-call";
        info(
          `verification pass — finding ${item.id}: the verifier's ${bound} budget fired; ` +
            `one final answer is requested`,
        );
        const final = await chat.complete({
          model,
          messages: [...messages, { role: "user", content: VERIFIER_BUDGET_INSTRUCTION }],
        });
        return settle(item, parseVerdict(final.content), info);
      }
    }
  } catch (error) {
    // Transport errors are ours, not the model's: their text may reach the
    // log, and the finding stays — an infrastructure failure must never
    // delete a reviewer's finding.
    const detail = error instanceof Error ? error.message : String(error);
    info(
      `verification pass — the call for finding ${item.id} failed (${detail}); it counts as uncertain`,
    );
    return { verdict: "uncertain", reason: "the verification call failed" };
  }
}

/**
 * @param {import("./verify.mjs").VerificationItem} item
 * @param {import("./verify.mjs").ParsedVerdict | import("./verify.mjs").RefusedVerdict} parsed
 * @param {(line: string) => void} info
 * @returns {{ verdict: import("./verify.mjs").Verdict, reason: string }}
 */
function settle(item, parsed, info) {
  if (parsed.ok) return { verdict: parsed.verdict, reason: parsed.reason };
  info(
    `verification pass — the answer to finding ${item.id} was refused (${parsed.defect}); ` +
      `it counts as uncertain`,
  );
  return { verdict: "uncertain", reason: `the verifier's answer was refused: ${parsed.defect}` };
}

/**
 * A protocol defect: the verifier broke the wire contract — degrade to
 * `uncertain`, never crash the run. The reviewer's loop would throw for the
 * same defect because the whole review is damaged; for the verifier it is
 * one finding's side-check, and the review publishes.
 *
 * @param {import("./verify.mjs").VerificationItem} item
 * @param {string} detail
 * @param {(line: string) => void} info
 * @returns {{ verdict: import("./verify.mjs").Verdict, reason: string }}
 */
function wireDefect(item, detail, info) {
  info(
    `verification pass — the verifier for finding ${item.id} broke the wire contract ` +
      `(${detail}); it counts as uncertain`,
  );
  return {
    verdict: "uncertain",
    reason: "the verifier's tool call broke the conversation protocol",
  };
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

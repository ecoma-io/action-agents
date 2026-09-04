/**
 * `triage` — classify issues and pull requests, apply labels drawn from a
 * sheet the repository declared, measure size from the diff.
 *
 * The pipeline is `docs/development/triage.md`'s, in its order: inputs and
 * context; the config file from the default branch (absent = empty policy);
 * the effective sheet, validated whole before anything else happens; the
 * thread from the event; one chat request; the answer parsed tolerantly and
 * matched exactly; size measured, never asked; then either labels applied
 * or — with no sheet — one marker comment upserted.
 *
 * The write surface is labels and that comment, and nothing else. Labels
 * are add-only: re-classifying never removes a label a human chose, because
 * the action does not track which labels it applied itself. Two things are
 * removed by code, never by the model's choice. Size, because one size label
 * is meaningful at a time and size is measured rather than judged, so a new
 * size replaces the old — including one a human applied by hand. And the
 * `labels.workflowMarkers` — the queue label the issue forms apply — once a
 * semantic-classification category is classified, because a thread carrying a
 * category no longer awaits triage; the model is never told the marker's name.
 *
 * Everything the decision was built from is re-checked against the thread
 * immediately before any of that lands: the payload's label list is a claim
 * the live read arbitrates, and a pull request snapshot's state, merged
 * flag and head are claims too. A thread that moved on while the run was in
 * flight receives nothing — the decision described a thread that no longer
 * exists, so the run ends `abandoned` with the divergence reason in the log
 * and the run record (the forge's read-twice doctrine, `core/src/forge.mjs`;
 * review's pre-publication re-read is the precedent).
 *
 * Before any of that, an event gate (item 1 of #224) decides whether the
 * event that fired this run could have changed triage-relevant evidence.
 * An event that cannot — a milestone, a review request, a label change
 * that does not move the queue, a close — logs one audit line and stops:
 * no evidence read, no model call, no mutation. The matrix and its
 * reasons live in `events.mjs`.
 *
 * Every run ends in a record, whatever its terminal point: a landed
 * mutation, a dry run, an event-gate skip, a failure. The record is a local
 * file inside the workspace — the durable account the runner log is not —
 * and `run-record.mjs` builds, validates and serialises it. Its `outcome`
 * speaks the run contract's terminal states, and a record-write failure is
 * judged by the two-tier rule the contract states: after the run's own
 * outcome has landed it is a logged loss, everywhere else it is the red run.
 *
 * The shape is the seed's, kept: `readInputs` is pure over an environment;
 * `run` takes its inputs as arguments; and the one place that touches
 * process state is `main` plus the default `io`, which tests replace whole.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

import * as p from "node:path";

import { readSharedInputs } from "#core/inputs.mjs";
import { createChat } from "#core/chat.mjs";
import { MAX_SEARCH_CANDIDATES, createForge } from "#core/forge.mjs";
import { oneLine } from "#core/one-line.mjs";
import { createEvidence } from "#core/untrusted.mjs";
import { policyReader, policySourceAuditLine, resolvePolicySource } from "#core/policy.mjs";
import {
  getBooleanInput,
  getInput,
  getListInput,
  info,
  isProgramEntry,
  maskSecret,
  readContext,
  setFailed,
  warning,
} from "#core/runtime.mjs";

import {
  effectiveSheet,
  loadConfigFile,
  loadInstructions,
  migrateConfig,
  validateConfig,
} from "./config.mjs";
import { assessIssueForm, loadIssueForms } from "./issue-forms.mjs";
import { gatherEvidence } from "./evidence.mjs";
import { assess } from "./assessment.mjs";
import { decide } from "./policy.mjs";
import { mutate, ThreadMovedError } from "./mutate.mjs";
import { measureSize } from "./size.mjs";
import { decideEvent, eventAuditLine, eventChangedLabel } from "./events.mjs";
import {
  buildTriageRecord,
  buildVerificationBlock,
  serialiseTriageRecord,
  triageRecordFilename,
} from "./run-record.mjs";
import { applyVerification, mintVerificationPlan, verifyDecision } from "./verify.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */
/** @typedef {import("#core/inputs.mjs").SharedInputs} SharedInputs */
export const ACTION = "triage";

/**
 * @typedef {SharedInputs & { labels: string[], dryRun: boolean, configPath: string, recordPath: string, requestTimeoutMs: number, verify: boolean }} Inputs
 */

/**
 * @param {Env} [env]
 * @returns {Inputs}
 */
export function readInputs(env = process.env) {
  return {
    ...readSharedInputs(env),
    labels: getListInput("labels", {}, env),
    dryRun: getBooleanInput("dry-run", { default: true }, env),
    configPath: getInput("config-path", {}, env),
    // Where inside the workspace the run record lands. The default agrees
    // with the manifest; the write is confined below either way.
    recordPath: getInput("record-path", { default: ".triage-record" }, env),
    // Opt-in verification (issue #274): off by default, and never requested
    // by a dry run — an operator previewing a decision sees the unverified
    // decision, exactly as without the input.
    verify: getBooleanInput("verify", { default: false }, env),
  };
}

/**
 * Everything `run` touches that isn't its arguments, as one replaceable
 * object: the forge, the model seam, the evidence wrapper, the clock and
 * the event file. A test that can state the whole world as a literal can
 * pin the pipeline without a runner.
 *
 * @typedef {object} Io
 * @property {ReturnType<typeof createForge>} forge
 * @property {ReturnType<typeof createChat>} chat
 * @property {ReturnType<typeof createEvidence>} evidence
 * @property {() => number} now
 * @property {() => Promise<Record<string, unknown>>} readEvent
 */

/**
 * @param {Inputs} inputs
 * @param {ReturnType<typeof readContext>} context
 * @param {Partial<Io> & { fetchImpl?: typeof globalThis.fetch }} [overrides] injectable members; the chat client is built with `fetchImpl` when no `chat` is given
 * @returns {Io}
 */
function realIo(inputs, context, overrides = {}) {
  return {
    forge:
      overrides.forge ??
      createForge({
        owner: context.owner,
        repo: context.repo,
        token: inputs.githubToken,
        apiUrl: context.apiUrl,
      }),
    chat:
      overrides.chat ??
      createChat({
        apiUrl: inputs.apiUrl,
        apiKey: inputs.apiKey,
        timeoutMs: inputs.requestTimeoutMs,
        ...(overrides.fetchImpl !== undefined ? { fetchImpl: overrides.fetchImpl } : {}),
      }),
    evidence: overrides.evidence ?? createEvidence(),
    now: overrides.now ?? (() => Date.now()),
    readEvent:
      overrides.readEvent ??
      (async () => {
        try {
          return /** @type {Record<string, unknown>} */ (
            JSON.parse(readFileSync(context.eventPath, "utf8"))
          );
        } catch (cause) {
          const error = new Error(`the event payload at ${context.eventPath} does not parse`);
          error.cause = cause;
          throw error;
        }
      }),
  };
}

/**
 * @param {Inputs} inputs
 * @param {ReturnType<typeof readContext>} context
 * @param {Partial<Io> & { fetchImpl?: typeof globalThis.fetch }} [io] injectable for tests; real clients omit it, and realIo builds every member
 * @returns {Promise<void>}
 */
export async function run(inputs, context, io) {
  /** @type {Io} */
  const world = realIo(inputs, context, io ?? {});

  // The record draft: the facts a terminal record carries, filled in as the
  // run discovers them. It exists before the first read, so a run that dies
  // anywhere still ends in a record — a run that died before the payload was
  // parsed names no thread and no policy pin, and the record says so by the
  // nulls rather than going unwritten.
  /** @type {{ eventAction: string, thread: { type: "issue" | "pr", number: number } | null, policy: import("#core/policy.mjs").PolicySource | null, decision: import("./decision.mjs").Decision | null, verification: import("./run-record.mjs").VerificationBlock }} */
  const draft = {
    eventAction: "",
    thread: null,
    policy: null,
    decision: null,
    verification: buildVerificationBlock(),
  };
  /** @param {import("./run-record.mjs").TriageOutcome} outcome @param {string} reason */
  const buildRecord = (outcome, reason) =>
    buildTriageRecord({
      repository: `${context.owner}/${context.repo}`,
      eventName: context.eventName,
      eventAction: draft.eventAction,
      threadType: draft.thread?.type ?? null,
      threadNumber: draft.thread?.number ?? null,
      dryRun: inputs.dryRun,
      model: inputs.model,
      policy: draft.policy,
      decision: draft.decision,
      outcome,
      reason,
      verification: draft.verification,
    });

  try {
    const event = await world.readEvent();
    draft.eventAction = typeof event["action"] === "string" ? event["action"] : "";
    const thread = threadFromEvent(context.eventName, event);
    draft.thread = { type: thread.type, number: thread.number };

    // The policy source is resolved once, from the execution context: for a
    // pull request thread, the base branch's live tip; for everything else,
    // the default branch. Every policy read below is pinned to that commit —
    // never the working tree, never another branch. A pull request cannot
    // edit the policy that governs it.
    const source = await resolvePolicySource({
      eventName: context.eventName,
      event: /** @type {Record<string, unknown>} */ (event),
      forge: world.forge,
    });
    draft.policy = source;
    const policy = { getContents: policyReader(world.forge, source) };

    // The config file is fetched once, pinned to the resolved source. A pull
    const loaded = await loadConfigFile({ forge: policy, configPath: inputs.configPath, source });
    const migration = migrateConfig(loaded.raw);
    if (migration.migrated) {
      warning(
        `the config file at '${loaded.path}' is schema 1 — migrated to the schema 2 labels.use policy; ` +
          `descriptions are now read from GitHub, and a top-level triageMarker becomes labels.workflowMarkers`,
      );
    }
    const config = validateConfig(migration.raw);
    info(policySourceAuditLine({ eventName: context.eventName, source, path: loaded.path }));
    // The event gate (item 1 of #224): whether this event could have changed
    // triage-relevant evidence. A skip logs one audit line and stops before
    // any read past the config — no metadata fetch, no evidence, no model
    // call, no mutation. The label-relevant facts are the payload's and the
    // policy's own declarations; `events.mjs` documents the whole matrix.
    const eventAction = draft.eventAction;
    const changedLabel = eventChangedLabel(event);
    const eventCall = decideEvent({
      eventName: context.eventName,
      action: eventAction,
      changedLabel,
      markerLabels: config?.labels.workflowMarkers ?? [],
      roleOf: config === null ? undefined : (name) => config.labels.roles.get(name),
      threadLabels: thread.labels,
    });
    info(
      eventAuditLine({ eventName: context.eventName, action: eventAction, decision: eventCall }),
    );
    if (eventCall.mode === "skip") {
      info("triage: nothing written — the event changed no triage-relevant evidence");
      // A skip's record is the skip's whole outcome, so a failed write here is
      // a red run — the tier the two-tier rule keeps red.
      writeRunRecord({
        workspace: context.workspace,
        directory: inputs.recordPath,
        record: buildRecord("skip", eventCall.reason),
      });
      return;
    }
    // The repository's label metadata is read once and shared by the name
    // check and the sheet: what the config declares must exist on GitHub, and
    // what the sheet offers to the model is each label's own description.
    let metadata = new Map();
    if (config !== null) {
      const labels = await world.forge.listRepositoryLabelsDetailed();
      metadata = new Map(labels.map((label) => [label.name, label]));
      await assertLabelsExist(world.forge, config, metadata);
    }

    const { sheet } = effectiveSheet({
      config,
      threadType: thread.type,
      narrowing: inputs.labels,
      metadata,
    });
    const documents = await loadInstructions({ forge: policy, config, threadType: thread.type });

    // Issue-side deterministic facts, gathered only when a sheet makes the
    // issue evaluators live (sheet mode + issue thread): which issue form the
    // body came through and what it leaves missing, and the bounded
    // duplicate/relationship search — at most MAX_SEARCH_CANDIDATES open
    // threads in this repository, never followed past the cap. Both stay
    // facts for the model and the policy to judge; neither writes anything.
    let quality = null;
    let forgeSearch = null;
    if (sheet !== null && thread.type === "issue") {
      const forms = await loadIssueForms({ forge: world.forge, policy, source });
      quality = assessIssueForm(thread.body, forms.forms, {
        templatesOverflow: forms.templatesOverflow,
      });
      const query = issueSearchQuery(context, thread.title);
      if (query !== null) {
        const search = await world.forge.searchIssues(query, {
          limit: MAX_SEARCH_CANDIDATES,
        });
        forgeSearch = {
          candidates: search.items
            .filter((item) => item.number !== thread.number)
            .map((item) => ({
              number: item.number,
              title: item.title,
              state: item.state,
              url: item.url,
              createdAt: item.createdAt,
            })),
          totalCount: search.totalCount,
          cappedAt: search.cappedAt,
        };
      }
    }

    // PR: the diff counts the size measurement and the diff-stats evidence
    // both read. The event payload does not carry them, which is why the
    // files listing is walked here — and a pull request past that listing's
    // ceiling is refused rather than guessed at.
    const files = thread.type === "pr" ? await world.forge.listPullRequestFiles(thread.number) : [];

    // PR: the deterministic reads that feed the `pr` dimension — the pull
    // request snapshot (state, draft/merged, mergeability, prose, both commit
    // shas), the check-run rollup at the head, and the review routing state.
    // The snapshot is load-bearing — a run cannot assess a PR it cannot read —
    // and its failure stays a hard error. The check and review reads are
    // advisory: a forge that does not answer them degrades those slots to
    // "no data" rather than failing the whole run, and "no data" is itself a
    // fact the readiness and routing signals weigh as absent, never as green.
    let pr = null;
    if (thread.type === "pr") {
      const snapshot = await world.forge.getPullRequest(thread.number);
      /** @type {import("./evidence.mjs").PrEvidence["checks"]} */
      let checks = null;
      try {
        if (typeof snapshot.head?.sha === "string" && snapshot.head.sha !== "") {
          checks = await world.forge.listCheckRuns(snapshot.head.sha);
        }
      } catch {
        // The check-read is advisory: no rollup reads as "no data", and the
        // readiness signal weighs absence as absent, never as green.
        checks = null;
      }
      /** @type {{ requestedReviewers: string[], reviews: { state: string, count: number }[] }} */
      let reviewState;
      try {
        reviewState = await world.forge.listPullRequestReviews(thread.number);
      } catch {
        // The review read is advisory: missing data reads as "no one
        // requested, no one reviewed", never as a red run.
        reviewState = { requestedReviewers: [], reviews: [] };
      }
      pr = {
        state: snapshot.state,
        draft: snapshot.draft,
        merged: snapshot.merged,
        mergeable: snapshot.mergeable,
        hasConflicts: snapshot.mergeableState === "dirty",
        base: { ref: snapshot.base.ref, sha: snapshot.base.sha },
        head: { ref: snapshot.head.ref, sha: snapshot.head.sha },
        body: snapshot.body ?? "",
        checks,
        reviewRequested: reviewState.requestedReviewers,
        reviews: reviewState.reviews,
      };
    }

    // Size is measured in the Evidence stage: never offered to the model, and
    // a measured rung stays authoritative (code-derived, always on-sheet).
    const size =
      config?.size !== undefined && thread.type === "pr"
        ? measureSize(files, config.size.exclude, config.size.ladder)
        : null;
    if (size !== null) {
      info(
        `size: ${String(size.counted)} counted lines (${String(size.excluded)} of ${String(size.files)} files excluded) → ${size.label}`,
      );
    }

    // Evidence → Assessment → Policy → Decision → Controlled Mutation.
    // The model answers only the one bounded question (assessment); every
    const evidence = gatherEvidence({
      thread,
      repository: repositoryFromEvent(event, context),
      config,
      sheet,
      metadata,
      files,
      size,
      quality,
      forgeSearch,
      eventAction,
      pr,
    });

    const assessment = await assess({
      evidence,
      documents,
      chat: world.chat,
      model: inputs.model,
      evidenceWrapper: world.evidence,
    });

    const decision = decide({ evidence, assessment });

    // Opt-in verification (issue #274), between the decision and any write:
    // one bounded call restating the plan — code-minted op ids — against the
    // same evidence snapshot the decision was derived from. Downgrade-only:
    // a refuted or uncertain op becomes a refusal entry and leaves the plan,
    // and a verdict can never add, widen or enable a write. A dry run never
    // requests it, so an operator previewing a decision sees the unverified
    // decision; with the input off this whole step is absent and the record's
    // verification block stays the empty block.
    /** @type {import("./verify.mjs").VerificationPlan} */
    const plan = mintVerificationPlan(decision);
    /** @type {string[]} */
    let downgraded = [];
    /** @type {import("./decision.mjs").Decision} */
    let acted = decision;
    /** @type {import("./verify.mjs").VerificationOutcome | null} */
    let outcome = null;
    if (inputs.verify && !inputs.dryRun) {
      outcome = await verifyDecision({
        plan,
        thread: evidence.thread,
        chat: world.chat,
        model: inputs.model,
        evidenceWrapper: world.evidence,
      });
      for (const note of outcome.notes) {
        warning(oneLine(note, { stripControlChars: true }));
      }
      acted = applyVerification(decision, plan, outcome.judged).decision;
      downgraded = outcome.block.downgraded;
      draft.verification = outcome.block;
      info(
        `triage: verification judged ${String(plan.ops.length)} proposed operation(s) — ` +
          `${String(plan.ops.length - downgraded.length)} confirmed, ` +
          `${String(downgraded.length)} downgraded`,
      );
    }
    // The decision the record carries is the post-filter one: what the run
    // actually acted on. The verification block names what the verifier did
    // to it.
    draft.decision = acted;

    // Everything downgraded is nothing to write: the ceilings refused the
    // whole plan, the mutate call never happens, and the run stays green —
    // a refusal is the ceilings working, not a failure. The record write
    // here is the run's whole outcome, so its failure is the red run, the
    // same tier the event-gate skip and the withheld write sit in.
    if (plan.ops.length > 0 && downgraded.length === plan.ops.length) {
      const reason =
        `verification downgraded every proposed operation: ` +
        downgraded
          .map((opId) => {
            const judged = outcome?.judged.find((op) => op.opId === opId);
            return `${opId} (${judged?.verdict ?? "uncertain"})`;
          })
          .join(", ");
      warning(oneLine(`triage: nothing written — ${reason}`, { stripControlChars: true }));
      writeRunRecord({
        workspace: context.workspace,
        directory: inputs.recordPath,
        record: buildRecord("refused", reason),
      });
      return;
    }

    try {
      await mutate({
        decision: acted,
        forge: world.forge,
        issueNumber: thread.number,
        dryRun: inputs.dryRun,
        now: world.now,
        action: ACTION,
        threadLabels: thread.labels,
        subject: pr !== null ? { head: pr.head.sha, state: pr.state, merged: pr.merged } : null,
      });
    } catch (cause) {
      // A freshness divergence is not a failure: nothing landed and a newer
      // state superseded the decision, so the run stays green — but this
      // record IS the run's whole outcome, which is why the write sits in
      // the red tier (a failed record write here goes red), the same tier
      // the event-gate skip sits in. The reason is thread-controlled text
      // (it interpolates the live labels), so it enters the record through
      // the sanitiser boundary: control characters stripped here (#259's
      // rule for this same warning line), the record builder's comment
      // sanitiser and reason cap doing the rest.
      if (!(cause instanceof ThreadMovedError)) throw cause;
      writeRunRecord({
        workspace: context.workspace,
        directory: inputs.recordPath,
        record: buildRecord("abandoned", oneLine(cause.message, { stripControlChars: true })),
      });
      return;
    }

    // The run's outcome has landed — the mutate. The record write sits one
    // tier down here: a failed write is a logged loss, not a red run,
    // because the mutate was the outcome and the record was the loss.
    try {
      const file = writeRunRecord({
        workspace: context.workspace,
        directory: inputs.recordPath,
        record: buildRecord(inputs.dryRun ? "skip" : "published", decisionSummary(acted)),
      });
      info(`triage: run record written to ${file}`);
    } catch (recordCause) {
      warning(`triage: the run record was not written: ${writeReason(recordCause)}`);
    }
  } catch (cause) {
    // The failure record first, then the original error — never masked by
    // the record's own write failing. What lands here is a defect or an
    // environment break; the ceilings' refusals are decided upstream, as a
    // `refusals` entry or a skip, not thrown.
    try {
      writeRunRecord({
        workspace: context.workspace,
        directory: inputs.recordPath,
        record: buildRecord("failed", writeReason(cause)),
      });
    } catch (recordCause) {
      warning(`triage: the run record was not written: ${writeReason(recordCause)}`);
    }
    throw cause;
  }
}

/**
 * The success record's reason. `mutate` reports by logging rather than
 * returning, so the record carries the decision's own summary — the counts
 * its applied lines add up to — composed here instead of parsed from the log.
 *
 * @param {import("./decision.mjs").Decision} decision
 * @returns {string}
 */
function decisionSummary(decision) {
  if (decision.kind === "comment") {
    return "comment decision: no labels — the classification is written as the marker comment";
  }
  const counts =
    `labels decision: ${String(decision.add.length)} to add, ` +
    `${String(decision.remove.length)} to remove, ${String(decision.refusals.length)} refused`;
  return decision.signal == null ? counts : `${counts}, 1 signal comment`;
}

/**
 * The failure record's reason: the error message the run log will name, one
 * line and sanitiser-capped. A thrown non-Error is stringified the way
 * `main` reports it, so the record and the log carry the same fact.
 *
 * @param {unknown} cause
 * @returns {string}
 */
function writeReason(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Writes the serialised run record inside the workspace, under a
 * deterministic name derived from the thread (or the event, when the run
 * died before the thread was known). The ceiling is the same one every read
 * honours, pointed the other way: the path resolves inside
 * `GITHUB_WORKSPACE` or the run fails loudly — a symlinked branch of the
 * tree cannot carry the write out, and `.git` is refused outright, because
 * that is where the checkout's credential lives.
 *
 * @param {object} input
 * @param {string} input.workspace the runner's workspace root
 * @param {string} input.directory the record-path input, relative to the root
 * @param {import("./run-record.mjs").TriageRecord} input.record the run's machine-readable record
 * @returns {string} the file the record was written to
 */
export function writeRunRecord({ workspace, directory, record }) {
  const root = realpathSync(workspace);
  const target = p.resolve(root, directory);
  if (target !== root && !target.startsWith(root + p.sep)) {
    throw new Error(`record-path '${directory}' resolves outside the workspace — refused`);
  }
  for (const segment of p.relative(root, target).split(p.sep)) {
    // Case-insensitive: the hosting filesystem may capitalise the directory
    // (.Git, .GIT), and the checkout's credential still lives there.
    if (segment.toLowerCase() === ".git") {
      throw new Error(`record-path '${directory}' touches .git — refused`);
    }
  }
  mkdirSync(target, { recursive: true });
  // A directory on the way may be a symlink pointing outside the workspace
  // or into the git metadata; resolve the real location and hold it to the
  // same ceiling and the same .git rule before a single byte is written.
  const real = realpathSync(target);
  if (real !== root && !real.startsWith(root + p.sep)) {
    throw new Error(`record-path '${directory}' resolves outside the workspace — refused`);
  }
  for (const segment of p.relative(root, real).split(p.sep)) {
    if (segment.toLowerCase() === ".git") {
      throw new Error(`record-path '${directory}' resolves inside .git — refused`);
    }
  }
  const file = p.join(real, triageRecordFilename(record));
  writeFileSync(file, serialiseTriageRecord(record), "utf8");
  return file;
}

/**
 * `issues` carries `issue`, `pull_request` carries `pull_request`; anything
 * else is a workflow pointing the action at an event it was not built for,
 * and that is a red run with a name, not a silent skip.
 *
 * @param {string} eventName
 * @param {Record<string, unknown>} event
 * @returns {{ type: "issue" | "pr", number: number, title: string, body: string, labels: string[], createdAt: string, creator: string, state: string }}
 */
function threadFromEvent(eventName, event) {
  const key =
    eventName === "issues" ? "issue" : eventName === "pull_request" ? "pull_request" : null;
  if (key === null) {
    throw new Error(
      `triage runs on 'issues' and 'pull_request' events — this run was '${eventName}'`,
    );
  }
  const raw = event[key];
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`the event payload carries no '${key}' object`);
  }
  const thread = /** @type {Record<string, unknown>} */ (raw);
  const number = thread["number"];
  const title = thread["title"];
  if (typeof number !== "number" || typeof title !== "string") {
    throw new Error(`the event payload's '${key}' has no number and title`);
  }
  const body = thread["body"];
  /** @type {string[]} */
  const labels = [];
  if (Array.isArray(thread["labels"])) {
    for (const label of thread["labels"]) {
      // A label entry that is not `{ name: string }` is a payload this action
      // was not built for. Refuse it by name, the way a missing number or
      // title is refused, rather than silently classifying a thread with no
      // labels: a label list silently dropped is the one failure that hides.
      const name = (typeof label === "object" && label !== null ? label["name"] : null) ?? null;
      if (typeof name !== "string") {
        throw new Error("the event payload's 'labels' carries an entry without a string name");
      }
      labels.push(name);
    }
  }
  const createdAt = thread["created_at"];
  const state = thread["state"];
  const author =
    typeof thread["user"] === "object" && thread["user"] !== null
      ? /** @type {Record<string, unknown>} */ (thread["user"])["login"]
      : undefined;
  return {
    type: eventName === "issues" ? "issue" : "pr",
    number,
    title,
    body: typeof body === "string" ? body : "",
    labels,
    createdAt: typeof createdAt === "string" ? createdAt : "",
    creator: typeof author === "string" ? author : "",
    state: typeof state === "string" ? state : "",
  };
}

/**
 * @param {Record<string, unknown>} event
 * @param {ReturnType<typeof readContext>} context
 * @returns {{ name: string, description: string }}
 */
function repositoryFromEvent(event, context) {
  const repository =
    typeof event["repository"] === "object" && event["repository"] !== null
      ? /** @type {Record<string, unknown>} */ (event["repository"])
      : {};
  const name = typeof repository["name"] === "string" ? repository["name"] : context.repo;
  const description =
    typeof repository["description"] === "string" ? repository["description"] : "";
  return { name, description };
}

/**
 * Composes the bounded search query for the duplicate/relationship pass:
 * the repository, open threads only, and the issue title's substantive
 * tokens. The query is capped so an over-long or empty title yields a
 * `null` (no search) rather than an over-length request or a search for
 * nothing — the search itself is deterministic and never writes.
 *
 * @param {ReturnType<typeof readContext>} context
 * @param {string} title
 * @returns {string | null}
 */
function issueSearchQuery(context, title) {
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => /^[a-z0-9]+$/u.test(token))
    .filter((token, index, all) => index === all.indexOf(token));
  if (tokens.length === 0) {
    return null;
  }
  const keywords = tokens.join(" ").slice(0, 100).trim();
  if (keywords.length === 0) {
    return null;
  }
  return `repo:${context.owner}/${context.repo} state:open ${keywords}`;
}

/**
 * A label the policy declares but the repository no longer has is refused
 * before the model is called — applying it would be a guaranteed failure
 * after the one request that matters, and a sheet naming ghosts is stale
 * configuration. The names checked are the whole policy's: what may be
 * applied (`use`), what is applied by code (`triageOwned`) and what resets
 * a queue (`workflowMarkers`).
 *
 * @param {ReturnType<typeof createForge>} forge
 * @param {NonNullable<ReturnType<typeof validateConfig>>} config
 * @param {Map<string, { name: string, description: string, color: string }>} metadata repository label metadata by name
 * @returns {Promise<void>}
 */
async function assertLabelsExist(forge, config, metadata) {
  const declared = [
    ...config.labels.use,
    ...config.labels.workflowMarkers,
    ...config.labels.triageOwned,
  ];
  if (declared.length === 0) return;
  const existing = new Set(metadata.keys());
  for (const name of declared) {
    if (!existing.has(name)) {
      throw new Error(
        `the config file declares the label '${name}', which the repository does not have — ` +
          `create the label or remove it from the sheet`,
      );
    }
  }
}

/**
 * @param {Env} [env]
 * @param {typeof run} [execute]
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
export async function main(env = process.env, execute = run) {
  try {
    const inputs = readInputs(env);
    // Before anything can print it, and before the first request is built.
    maskSecret(inputs.apiKey);
    maskSecret(inputs.githubToken);
    const context = readContext(env);
    info(
      `triage: ${context.owner}/${context.repo} on ${context.eventName}` +
        (inputs.dryRun ? " (dry run — nothing will be written)" : ""),
    );
    await execute(inputs, context);
    return { ok: true };
  } catch (cause) {
    setFailed(cause);
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

if (isProgramEntry(import.meta.url)) await main();

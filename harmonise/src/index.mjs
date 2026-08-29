/**
 * `harmonise` — keep multilingual documentation semantically in step.
 *
 * The full pipeline, in the specification's order: config map; complete
 * default-branch inventory; pairing with orphan detection; per-pair
 * preparation (glossary + skip protection, manual-edit protection, link/image
 * localization); translation through the model with contract validation, a
 * drifted pair's proposal merged three-way against the last published
 * translation; then — for real runs only — one branch, one commit through
 * the Git Data API, one pull request updated in place.
 *
 * The shape is deliberate. `readInputs` is pure over an environment; `run`
 * takes its inputs plus one replaceable I/O record, so a test states the
 * whole world as a literal; and `main` is the only place that touches
 * process state.
 */

import { readFileSync } from "node:fs";

import { createChat } from "#core/chat.mjs";
import { createForge } from "#core/forge.mjs";
import {
  DEFAULT_RETRY_DELAY_MS,
  HttpError,
  TransportError as HttpTransportError,
} from "#core/transport-errors.mjs";
import { readSharedInputs } from "#core/inputs.mjs";
import { policyReader, policySourceAuditLine, resolvePolicySource } from "#core/policy.mjs";
import { createEvidence } from "#core/untrusted.mjs";
import {
  getBooleanInput,
  getInput,
  getListInput,
  getNumberInput,
  info,
  isProgramEntry,
  maskSecret,
  readContext,
  setFailed,
} from "#core/runtime.mjs";

import {
  MAX_PAIR_CONCURRENCY,
  loadConfigFile,
  loadInstructions,
  validateConfig,
} from "./config.mjs";
import { buildInventory } from "./inventory.mjs";
import { detectDrift } from "./drift.mjs";
import { contentFingerprint, policyFingerprint, TRANSFORMATION_VERSION } from "./fingerprint.mjs";
import { readState, renderState, STATE_PATH, STATE_SCHEMA_VERSION } from "./state.mjs";
import { classifyPair } from "./stale.mjs";
import { matchGlob } from "#core/glob.mjs";
import {
  MAX_SOURCE_BYTES,
  pairBlockShape,
  planFrontmatterGuard,
  preparationRefusal,
  preparePair,
  translatePair,
} from "./plan.mjs";
import { protectionDecision } from "./protection.mjs";
import { buildPullRequestBody, renderPullRequestTitle } from "./pull-request.mjs";
import { buildTmKey, createTmStore, readTm, serialize as serializeTm, TM_PATH } from "./tm.mjs";
import { mergeThreeWay, summarizeMerge } from "./threeway.mjs";
import { runPool } from "./pool.mjs";
import {
  DEFAULT_POLICY,
  classifyFailure,
  classFromStatus,
  delayClass,
  nextAction,
} from "./recovery.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */
/** @typedef {import("#core/inputs.mjs").SharedInputs} SharedInputs */
/** @typedef {import("#core/forge.mjs").Forge} Forge */

export const ACTION = "harmonise";

/** The TM file path lives with the document format it names, in tm.mjs. */
export { TM_PATH };

/**
 * The caller's half of the recovery contract: `recovery.mjs` names a delay,
 * this file pays it in milliseconds. `short` is the transport layer's own
 * backoff step — `DEFAULT_RETRY_DELAY_MS`, shared by import rather than
 * restated; `long` is the wait before the policy's second transport retry.
 * The pure policy module stays millisecond-free by design.
 *
 * @type {Readonly<Record<import("./recovery.mjs").DelayName, number>>}
 */
export const DELAY_MS = Object.freeze({
  immediate: 0,
  short: DEFAULT_RETRY_DELAY_MS,
  long: 5_000,
});

/**
 * The run's clock: one awaited pause. Injectable as `io.sleep` so a test
 * observes the policy's waits without spending real time.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The pair loop's classification of anything a failed attempt raised. The
 * transport layer's own verdicts map onto declared classes here — by status
 * for an `HttpError`, by constructor for a network failure or a timeout —
 * and everything else goes to `classifyFailure`: instances of the declared
 * error classes classify as tagged at their raise sites (the answer
 * contract's refusals inside `translatePair`), the rest land conservatively
 * in `unknown`. Total: classifying a failure never throws.
 *
 * @param {unknown} cause
 * @returns {import("./recovery.mjs").FailureClass}
 */
function classifyPairFailure(cause) {
  if (cause instanceof HttpError) return classFromStatus(cause.status);
  if (cause instanceof HttpTransportError) return "transport";
  return classifyFailure(cause);
}

/**
 * @typedef {SharedInputs & { configPath: string, sourceLanguage: string, documents: string[], dryRun: boolean, requestTimeoutMs: number }} Inputs
 */

/**
 * @param {Env} [env]
 * @returns {Inputs}
 */
export function readInputs(env = process.env) {
  return {
    ...readSharedInputs(env),
    configPath: getInput("config-path", {}, env),
    sourceLanguage: getInput("source-language", { required: true }, env),
    // A filter over the map's own space — empty means all of it. A non-empty
    // default here would silently hide documents the config declared.
    documents: getListInput("documents", { default: [] }, env),
    dryRun: getBooleanInput("dry-run", { default: true }, env),
    requestTimeoutMs: getNumberInput("request-timeout-ms", { default: 30_000, min: 1_000 }, env),
  };
}

/**
 * Everything `run` touches that isn't its arguments, as one replaceable object.
 *
 * @typedef {object} Io
 * @property {Forge} forge
 * @property {ReturnType<typeof createChat>} chat
 * @property {ReturnType<typeof createEvidence>} evidence
 * @property {(ms: number) => Promise<void>} sleep
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
    sleep: overrides.sleep ?? defaultSleep,
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
 * One translated pair's full record — the proposal if there is one, plus the
 * preparation statistics every report line shows.
 *
 * @typedef {object} PairOutcome
 * @property {string} lang
 * @property {string} sourcePath
 * @property {string} destinationPath
 * @property {"existing" | "missing"} state
 * @property {"proposed" | "unchanged" | "unchanged-skipped"} outcome
 * @property {{ glossaryHits: number, skippedSpans: number, linksRewritten: number }} stats
 * @property {import("./plan.mjs").PairBlockShape} blocks the pair's change shape
 * @property {string | undefined} content the proposal text, undefined for unchanged
 *   and unchanged-skipped
 * @property {string} summary
 */
/**
 * One translatable pair carried from the classification walk to the pool:
 * everything its model path needs, so the pooled worker never re-reads.
 *
 * @typedef {object} PairJob
 * @property {number} slot position in the stable pair order this pair fills
 * @property {import("./plan.mjs").PreparedPair} prepared
 * @property {string | undefined} existing the destination's current bytes, when it has any
 * @property {import("./plan.mjs").PairBlockShape} blocks the pair's change shape
 * @property {string} sourceFingerprint
 * @property {string} lang
 * @property {string} sourcePath
 * @property {string | undefined} [mergeBase] the verified text of the last publication,
 *   present exactly when manual-edit protection requires the pair's proposal
 *   to be merged three-way instead of taken verbatim
 */

/**
 * One pooled pair's settled result, identified by pair — never by completion
 * order: the outcome on success, the report line on failure.
 *
 * @typedef {{ ok: true, outcome: PairOutcome, sourceFingerprint: string } | { ok: false, line: string }} PairResult
 */

/**
 * @param {Inputs} inputs
 * @param {ReturnType<typeof readContext>} context
 * @param {Partial<Io> & { fetchImpl?: typeof globalThis.fetch }} [io] injectable for tests; real clients omit it, and realIo builds every member
 * @returns {Promise<void>}
 */
export async function run(inputs, context, io) {
  /** @type {Io} */
  const world = realIo(inputs, context, io ?? {});
  const event = await world.readEvent();

  // The policy source is resolved once, from the execution context: for a
  // pull request run, the base branch's live tip; for everything else, the
  // default branch. The config is read pinned to that commit and the whole
  // proposal below descends from the same instant — a pull request cannot
  // edit the policy that governs it.
  const source = await resolvePolicySource({
    eventName: context.eventName,
    event: /** @type {Record<string, unknown>} */ (event),
    forge: world.forge,
  });
  const policy = { getContents: policyReader(world.forge, source) };
  const loaded = await loadConfigFile({ forge: policy, configPath: inputs.configPath, source });
  let config = validateConfig(loaded.raw);
  info(policySourceAuditLine({ eventName: context.eventName, source, path: loaded.path }));

  const requested = inputs.sourceLanguage;
  if (!Object.hasOwn(config.languages, requested)) {
    throw new Error(
      `source-language '${requested}' is not a language the config declares ` +
        `(${Object.keys(config.languages).join(", ")})`,
    );
  }
  config = { ...config, sourceLanguage: requested };

  const repository = await world.forge.getRepository();
  /** @type {import("#core/forge.mjs").Forge} */
  const f = world.forge;
  const ownBranch = branchName(config.sourceLanguage);
  const branchBefore = await f.readRef(ownBranch);

  // Every read below is pinned to this exact commit: inventory, sources,
  // config and instructions describe one instant of the repository, and the
  // commit built from them parents on that same instant.
  /** @type {(path: string) => Promise<{ content: string } | null>} */
  const readAtBase = policyReader(world.forge, source);

  // The recorded state is advisory and fails closed: a file that is missing,
  // unreadable, unparseable, or of a foreign schema version leaves no
  // records, and a thrown read degrades the same way. A state problem may
  // never block the run and may never cause a silent skip — with no usable
  // records every pair is judged from the world alone: a missing target
  // still translates, and existing bytes are human work that manual-edit
  // protection preserves (merge against a verified base, or refuse).
  /** @type {import("./state.mjs").SyncStateRecord[]} */
  let recordedRecords = [];
  try {
    const state = await readState({
      getContents: (path, options) => f.getContents(path, options),
      branchRef: branchBefore === null ? null : branchBefore.sha,
      defaultRef: source.sha,
    });
    if (state !== null) recordedRecords = state.records;
  } catch {
    recordedRecords = [];
  }

  // The translation memory resolves from the same snapshot authority as the
  // sync state above: ONE resolution of the harmonise branch tip — the
  // snapshot taken before any work — feeds both advisory reads, so a run
  // can never pair a state from one commit with a memory from another. A
  // run publishes state.json and tm.json in one commit on the proposal
  // branch, so reading both at that resolved tip keeps the state→memory
  // join resolvable while the pull request is still unmerged —
  // a record can always reach the merge base it references. The memory is
  // advisory both ways: a file that is missing, unreadable, corrupt or of a
  // foreign schema version leaves an empty store — no prior translations are
  // offered and the run proceeds exactly as a repository without a memory
  // file always has. A corrupt branch file degrades to absent the same way
  // state does, without silently substituting a stale default. Writing:
  // entries recorded on publication are offered to later runs as reference
  // only; everything the model returns passes the same deterministic
  // validation with or without a hit.
  /** @type {ReturnType<typeof createTmStore>} */
  let memory = createTmStore();
  try {
    const stored = await readTm({
      getContents: (path, options) => f.getContents(path, options),
      branchRef: branchBefore === null ? null : branchBefore.sha,
      defaultRef: source.sha,
    });
    if (stored !== null) memory = stored.store;
  } catch {
    memory = createTmStore();
  }

  // Instruction prose is read once, capped, pinned to the audited tip, and
  // shared by every prompt.
  const documents = await loadInstructions({
    forge: { getContents: (path) => f.getContents(path, { ref: source.sha }) },
    config,
  });

  // The translation policy as one digest: the same inputs the prompts are
  // built from, hashed once and shared by every pair this run classifies.
  const policyDigest = policyFingerprint({
    glossary: config.glossary,
    // Absent and explicit `undefined` hash identically, so omitting the key
    // when no instruction document exists changes nothing.
    ...(documents.instruction !== undefined ? { instruction: documents.instruction } : {}),
    languageInstructions: documents.languages,
    transformationVersion: TRANSFORMATION_VERSION,
  });

  // Completeness is a contract: a listing GitHub had to truncate throws
  // rather than becoming an inventory that looks finished.
  const entries = await world.forge.listTree(source.sha);
  const inventory = buildInventory({
    entries,
    config,
    documents: inputs.documents,
  });

  if (inventory.pairs.length === 0) {
    throw new Error(
      `no document matches the source language '${config.sourceLanguage}' on ` +
        `'${source.branch}' — nothing to keep in step`,
    );
  }

  const selected =
    inputs.documents.length === 0
      ? inventory.pairs
      : inventory.pairs.filter((pair) => matchGlob(inputs.documents, pair.sourcePath));
  if (selected.length === 0) {
    throw new Error(
      `the documents input (${inputs.documents.join(", ")}) narrows ` +
        `${String(inventory.pairs.length)} source documents to none — narrowing to nothing ` +
        `is a misconfiguration, not an empty schedule`,
    );
  }

  /**
   * One settled slot in the stable pair order — a pair's outcome once it has
   * one (translated or unchanged-skipped), empty for a pair that failed, so
   * the report and the publication below stay ordered by pair identity
   * rather than by completion order.
   *
   * @type {(PairOutcome | undefined)[]}
   */
  const slots = [];
  /** Source fingerprint per proposed destination — what its state record pins. */
  /** @type {Map<string, string>} */
  const publishedSources = new Map();
  /** Re-pinned record per noop destination — the pair's carried record made current. */
  /** @type {Map<string, import("./state.mjs").SyncStateRecord>} */
  const rePinned = new Map();
  /** @type {string[]} */
  const failedLines = [];
  /** @type {string[]} */
  const skippedLines = [];
  /** @type {PairJob[]} */
  const jobs = [];

  // The classification walk is sequential and ordered, exactly as before: it
  // reads pinned bytes and decides, per pair, between the zero-model-call
  // skip and the model path. Only the model path continues below — a skipped
  // pair consumes no slot and no model call, exactly as the skip path made it.
  for (const pair of selected) {
    const file = await readAtBase(pair.sourcePath);
    if (file === null) {
      failedLines.push(`${pair.sourcePath}: gone from the branch since the tree was listed`);
      continue;
    }
    // Eligibility is a property of the source, judged once: every language's
    // pair skips together, with the same reason in the report.
    const refusal = preparationRefusal(file.content);
    if (refusal !== null) {
      for (const target of pair.targets) {
        skippedLines.push(`${target.lang} ${pair.sourcePath}: ${refusal}`);
      }
      continue;
    }
    // Frontmatter protection is a property of the source, planned once for
    // every language's pair: protected values must be tokens before any
    // machinery sees the text. A plan that refuses is a pair that never
    // reaches the model — fail-closed, never translated half-protected.
    const frontmatter = planFrontmatterGuard(file.content);
    if (frontmatter.kind === "refused") {
      for (const target of pair.targets) {
        skippedLines.push(
          `${target.lang} ${pair.sourcePath}: frontmatter protection refused: ${frontmatter.message}`,
        );
      }
      continue;
    }
    const fmGuard = frontmatter.kind === "planned" ? frontmatter.guard : undefined;
    // The source's content identity, hashed once per source document: every
    // language's pair classifies against the same digest.
    const sourceFingerprint = contentFingerprint(file.content);

    for (const target of pair.targets) {
      try {
        const prepared = preparePair({
          slug: pair.slug,
          lang: target.lang,
          sourcePath: pair.sourcePath,
          target,
          sourceText: file.content,
          inventory,
          config,
          frontmatter: fmGuard,
        });

        const existing =
          target.state === "existing"
            ? await readAtBase(target.path).then((found) => found?.content ?? undefined)
            : undefined;
        if (existing !== undefined) {
          // Both documents must fit the evidence frame together; a published
          // translation past the cap cannot be judged whole, so its pair
          // skips with that reason rather than comparing against a truncated
          // view.
          const existingBytes = new TextEncoder().encode(existing).byteLength;
          if (existingBytes > MAX_SOURCE_BYTES) {
            skippedLines.push(
              `${target.lang} ${pair.sourcePath}: the existing translation is ` +
                `${String(existingBytes)} bytes, past the ${String(MAX_SOURCE_BYTES)}-byte cap — ` +
                `shrink or split it first`,
            );
            continue;
          }
        }

        // The deterministic gate. Only the exact conjunction — the recorded
        // state proves source, policy and version all unchanged AND the
        // target's bytes are still the recorded publication — consumes zero
        // model calls. Every other verdict continues below — manual-edit
        // protection judges the drifted ones, and the rest run the model
        // path exactly as before. Nothing model-shaped can reach this
        // decision: both sides are digests of repository bytes.
        const recorded =
          recordedRecords.find((record) => record.destinationPath === prepared.destinationPath) ??
          null;
        const blocks = pairBlockShape(recorded, null);
        const current = {
          sourceFingerprint,
          policyFingerprint: policyDigest,
          transformationVersion: TRANSFORMATION_VERSION,
        };
        const drift = detectDrift(recorded, existing);
        if (classifyPair(recorded, current) === "unchanged" && drift === "canonical") {
          slots.push({
            lang: target.lang,
            sourcePath: pair.sourcePath,
            destinationPath: prepared.destinationPath,
            state: prepared.state,
            outcome: "unchanged-skipped",
            stats: {
              glossaryHits: prepared.protection.glossaryHits,
              skippedSpans: prepared.protection.skippedSpans,
              linksRewritten: prepared.linksRewritten,
            },
            blocks,
            content: undefined,
            summary: "in step with the recorded publication; skipped without a model call",
          });
          continue;
        }
        // Manual-edit protection. The policy turns the drift verdict plus the
        // target's presence into exactly one action class, and this wiring
        // honors it in full: every `preserve-required` row proceeds only into
        // a three-way merge against a verified base — which needs both the
        // base and existing bytes on disk — and is refused outright
        // otherwise, before any model call. No slot, no overwrite: generated
        // text never silently displaces human work. An `unrecorded` pair
        // never has a base to verify, an `unknown` pair cannot prove what
        // harmonise last published, and a record whose target has vanished
        // preserves the deletion.
        /** @type {string | undefined} */
        let mergeBase;
        if (protectionDecision(drift, existing !== undefined) === "preserve-required") {
          mergeBase =
            existing !== undefined ? recordedMergeBase(recorded, target.lang, memory) : undefined;
          if (mergeBase === undefined) {
            failedLines.push(
              `${target.lang} ${pair.sourcePath}: manual-edit protection refused: ` +
                protectionRefusalReason(drift, existing !== undefined),
            );
            continue;
          }
        }

        // The model path: carried to the pool below, not translated inline.
        // The slot is reserved now and filled when the pooled worker settles,
        // so a slow pair ahead never reshuffles the ones behind it.
        jobs.push({
          slot: slots.length,
          prepared,
          existing,
          blocks,
          sourceFingerprint,
          lang: target.lang,
          sourcePath: pair.sourcePath,
          mergeBase,
        });
        slots.push(undefined);
      } catch (cause) {
        failedLines.push(
          `${target.lang} ${pair.sourcePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }

  // The bound is a declared resource policy: the config states it, validated
  // fail-closed at startup, and a module-level ceiling caps whatever it
  // declares. Nothing a model returns can move it.
  const concurrency = Math.min(config.concurrency, MAX_PAIR_CONCURRENCY);

  /**
   * One pair's model path, run under the pool: the memory lookup, then the
   * retry policy from `recovery.mjs` wrapped around `translatePair` — a
   * failure is classified, the policy decides retry or stop, and a retry
   * waits the class's mapped delay — and never a publication. The worker
   * never throws: a refusal, an exhausted class or a give-up settles as
   * this pair's failed report line, leaving its siblings working.
   *
   * @param {PairJob} job
   * @returns {Promise<PairResult>}
   */
  const translateJob = async (job) => {
    // The memory is consulted only for pairs the model path already runs —
    // a provably unchanged pair keeps its zero model calls.
    const prior = memory.lookup(
      buildTmKey({
        sourceHash: job.sourceFingerprint,
        targetLang: job.lang,
        policyContext: policyDigest,
      }),
    );

    /** @type {{ noop: boolean, text?: string, summary?: string }} */
    let translated;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await translatePair({
          prepared: job.prepared,
          sourceLanguage: config.sourceLanguage,
          existingText: job.existing,
          priorTranslation: prior,
          model: inputs.model,
          chat: world.chat,
          evidence: world.evidence,
          repository: { name: repository.name, description: repository.description },
          documents,
        });
        translated =
          result.outcome === "noop"
            ? { noop: true, summary: result.summary }
            : { noop: false, text: result.text, summary: result.summary };
        break;
      } catch (cause) {
        const failureClass = classifyPairFailure(cause);
        const action = nextAction(failureClass, attempt, DEFAULT_POLICY);
        if (action !== "retry") {
          return {
            ok: false,
            line: `${job.lang} ${job.sourcePath}: ${
              cause instanceof Error ? cause.message : String(cause)
            } (classified ${failureClass}, ${action})`,
          };
        }
        await world.sleep(DELAY_MS[delayClass(failureClass, attempt)]);
      }
    }

    // The publication text is the verified three-way merge when manual-edit
    // protection demanded one, the raw translation otherwise. A conflict is
    // the merge refusing: the pair fails with the disagreement reported —
    // the raw translation never slips in behind a refused merge. The merge
    // is deterministic over repository bytes and one validated answer; the
    // model decides nothing about the outcome. A no-op answer carries no
    // fresh text, so there is nothing to merge and nothing to displace.
    /** @type {string | undefined} */
    let content = translated.text;
    let summary = /** @type {string} */ (translated.summary);
    if (job.mergeBase !== undefined && !translated.noop) {
      // Protection attached a base only after proving the drifted target has
      // bytes on disk, so the manual side is a string by construction.
      const merged = mergeThreeWay(
        job.mergeBase,
        /** @type {string} */ (job.existing),
        /** @type {string} */ (content),
      );
      const first = merged.conflicts[0];
      if (first === undefined) {
        const counts = summarizeMerge(merged);
        content = merged.merged;
        summary =
          `${summary} (three-way merge: ${String(counts.preservedManual)} manual region(s) ` +
          `preserved, ${String(counts.adoptedFresh)} fresh adopted)`;
      } else {
        return {
          ok: false,
          line:
            `${job.lang} ${job.sourcePath}: three-way merge refused: ` +
            `${String(merged.conflicts.length)} conflict region(s), first at merged line ` +
            `${String(first.startLine)} — the manual edit and the fresh translation disagree ` +
            `(manual: "${oneLine(first.manualExcerpt)}", fresh: "${oneLine(first.freshExcerpt)}"); ` +
            `resolve by hand`,
        };
      }
    }
    return {
      ok: true,
      sourceFingerprint: job.sourceFingerprint,
      outcome: {
        lang: job.lang,
        sourcePath: job.sourcePath,
        destinationPath: job.prepared.destinationPath,
        state: job.prepared.state,
        outcome: translated.noop ? "unchanged" : "proposed",
        stats: {
          glossaryHits: job.prepared.protection.glossaryHits,
          skippedSpans: job.prepared.protection.skippedSpans,
          linksRewritten: job.prepared.linksRewritten,
        },
        blocks: job.blocks,
        content,
        summary,
      },
    };
  };

  // Only the model path pools. The pool collects sibling failures (it never
  // rejects) and reports results by input position — the walk order above —
  // so completion order never reaches the outcomes, the logs or the report.
  const { results, errors } = await runPool(jobs, translateJob, { concurrency });

  // A worker never throws by construction; a collected error is the defense
  // in depth for one that does, mapped back onto its pair like any failure.
  for (const error of errors) {
    const job = jobs[error.index];
    if (job !== undefined) failedLines.push(`${job.lang} ${job.sourcePath}: ${error.message}`);
  }

  // Assembly in input order — the stable pair identity, never completion
  // order: outcomes land in the walk the classification took, so the report
  // and the single publication that follows the drain stay honest.
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result === undefined) continue;
    const job = jobs[index];
    if (job === undefined) continue;
    if (!result.ok) {
      failedLines.push(result.line);
      continue;
    }
    if (result.outcome.outcome === "proposed") {
      publishedSources.set(result.outcome.destinationPath, result.sourceFingerprint);
    } else {
      // A noop is a re-check that came back as an endorsement: the model saw
      // the bytes already on disk and answered that they already convey the
      // current source. The record is re-pinned onto exactly those bytes —
      // this run's source, policy and version — so the next run proves the
      // pair unchanged and skips it at zero model calls (#88, #95). The
      // endorsed bytes enter the memory under the same key a publication
      // would use, so a later manual edit on this pair still finds a
      // verified base to merge against. A never-recorded pair stays
      // unrecorded: adopting pre-existing files is a human decision, not
      // something an endorsement does behind the protection gate.
      const recorded = recordedRecords.find(
        (record) => record.destinationPath === result.outcome.destinationPath,
      );
      const endorsed = job.existing;
      if (recorded !== undefined && endorsed !== undefined) {
        rePinned.set(result.outcome.destinationPath, {
          ...recorded,
          sourceFingerprint: result.sourceFingerprint,
          translationFingerprint: contentFingerprint(endorsed),
          policyFingerprint: policyDigest,
          transformationVersion: TRANSFORMATION_VERSION,
        });
        memory.record(
          buildTmKey({
            sourceHash: result.sourceFingerprint,
            targetLang: result.outcome.lang,
            policyContext: policyDigest,
          }),
          endorsed,
        );
      }
    }
    slots[job.slot] = result.outcome;
  }

  /** @type {PairOutcome[]} */
  const outcomes = [];
  for (const entry of slots) {
    if (entry !== undefined) outcomes.push(entry);
  }

  // Every pair failing or skipping is red: work existed and none of it was
  // attempted successfully. Some failing or skipping is reported and carried.
  const proposed = outcomes.filter((entry) => entry.outcome === "proposed");
  if (outcomes.length === 0 && skippedLines.length === 0 && failedLines.length > 0) {
    throw new Error(`every pair failed:\n${failedLines.map((line) => `- ${line}`).join("\n")}`);
  }
  if (outcomes.length === 0 && failedLines.length === 0 && skippedLines.length > 0) {
    throw new Error(`every pair skipped:\n${skippedLines.map((line) => `- ${line}`).join("\n")}`);
  }

  info(`harmonise report — ${context.owner}/${context.repo} at ${source.sha.slice(0, 12)}`);
  info(
    `documents: ${String(inventory.pairs.length)} source(s), ` +
      `${String(selected.length)} selected, languages ${Object.keys(config.languages).join(", ")}`,
  );
  for (const entry of outcomes) {
    info(
      (entry.outcome === "unchanged-skipped" ? "unchanged-skipped" : "translated") +
        ` ${entry.lang} ${entry.sourcePath} → ${entry.destinationPath}` +
        ` [${entry.state}] ${entry.outcome}` +
        ` glossary=${String(entry.stats.glossaryHits)}` +
        ` skip=${String(entry.stats.skippedSpans)}` +
        ` links=${String(entry.stats.linksRewritten)}` +
        (entry.blocks.planning === "planned"
          ? ` blocks=planned changed:${String(entry.blocks.changed)}` +
            ` unchanged:${String(entry.blocks.unchanged)}` +
            ` added:${String(entry.blocks.added)}` +
            ` removed:${String(entry.blocks.removed)}`
          : ` blocks=whole-file`) +
        (entry.summary !== undefined ? ` — ${oneLine(entry.summary)}` : ""),
    );
  }
  for (const line of failedLines) info(`failed ${line}`);
  for (const line of skippedLines) info(`skipped ${line}`);
  if (inventory.orphanTranslations.length === 0) {
    info("orphans: none");
  } else {
    info(`orphans: ${String(inventory.orphanTranslations.length)} (reported, never touched)`);
    for (const orphan of inventory.orphanTranslations) {
      info(`orphan ${orphan.path} [${orphan.lang}]`);
    }
  }

  // A failed pair is a failed run, always. What the specification adds is
  // ordering: successful proposals publish FIRST, then the run exits red.
  const failureReport =
    failedLines.length > 0
      ? `${String(failedLines.length)} pair(s) failed:\n${failedLines.map((line) => `- ${line}`).join("\n")}`
      : "";

  if (inputs.dryRun) {
    info("dry run — nothing was written");
    if (failureReport !== "") throw new Error(failureReport);
    return;
  }

  if (proposed.length === 0 && rePinned.size === 0) {
    // All pairs in step: a green run and a log line — the honest common case
    // on a schedule. No branch, no commit, no pull request. A run that only
    // re-pinned records is not this case: its state write still publishes.
    info("nothing to propose — no branch, no commit, no pull request");
    if (failureReport !== "") throw new Error(failureReport);
    return;
  }

  const branch = branchName(config.sourceLanguage);
  // One title for the commit subject and the pull request alike: the
  // repository's own convention when its config names one, the built-in
  // conventional-commits shape otherwise — "harmonise" is a scope there,
  // never a type.
  const title = renderPullRequestTitle(config, proposed.length);

  // Blobs first, then exactly one tree layered over the audited base, one
  // commit on top, one branch pointing at it, one request carrying it.
  const changes = [];
  for (const proposal of proposed) {
    const blob = await world.forge.createBlob(/** @type {string} */ (proposal.content));
    changes.push({ path: proposal.destinationPath, blobSha: blob.sha });
  }
  // The state file rides the same commit as the translations it describes:
  // prior records this publication does not supersede are carried — the
  // re-pinned ones made current, the rest verbatim — each proposed pair
  // gains its record, and the merged file is one blob in the same tree.
  // Content and the record of what produced it land as one instant, never
  // two.
  /** @type {import("./state.mjs").SyncStateRecord[]} */
  const records = recordedRecords
    .map((record) => rePinned.get(record.destinationPath) ?? record)
    .filter((record) => !publishedSources.has(record.destinationPath));
  for (const proposal of proposed) {
    records.push({
      schemaVersion: STATE_SCHEMA_VERSION,
      sourcePath: proposal.sourcePath,
      destinationPath: proposal.destinationPath,
      language: proposal.lang,
      sourceFingerprint: /** @type {string} */ (publishedSources.get(proposal.destinationPath)),
      translationFingerprint: contentFingerprint(/** @type {string} */ (proposal.content)),
      policyFingerprint: policyDigest,
      transformationVersion: TRANSFORMATION_VERSION,
    });
    // The memory rides the same commit: each proposed pair's exact source
    // fingerprint is recorded with the translation that was accepted for it,
    // so a later run that cannot prove unchanged-ness from the state file
    // alone still has the accepted wording to offer as reference.
    memory.record(
      buildTmKey({
        sourceHash: /** @type {string} */ (publishedSources.get(proposal.destinationPath)),
        targetLang: proposal.lang,
        policyContext: policyDigest,
      }),
      /** @type {string} */ (proposal.content),
    );
  }
  // The memory is serialized down to exactly the entries the records above
  // reference: the state→memory join can never lose a base to eviction,
  // because there is no eviction — the file is bounded by the state it
  // serves, and entries no record references are dropped here.
  const liveKeys = new Set(
    records.map((record) =>
      buildTmKey({
        sourceHash: record.sourceFingerprint,
        targetLang: record.language,
        policyContext: record.policyFingerprint,
      }),
    ),
  );
  const stateBlob = await world.forge.createBlob(renderState(records));
  changes.push({ path: STATE_PATH, blobSha: stateBlob.sha });
  const tmBlob = await world.forge.createBlob(serializeTm(memory, { keepKeys: liveKeys }));
  changes.push({ path: TM_PATH, blobSha: tmBlob.sha });
  const tree = await world.forge.createTree(source.sha, changes);
  const commit = await world.forge.createCommit(
    `${title}\n\nAuthored by harmonise from ${source.sha}.`,
    tree.sha,
    source.sha,
  );
  // The optimistic lock is the action's own branch tip as this run found it:
  // unchanged means nobody else touched our branch while we worked.
  await world.forge.upsertBranch(
    branch,
    commit.sha,
    /** @type {string | null} */ (branchBefore?.sha ?? null),
  );

  const body = buildPullRequestBody({
    sourceLanguage: config.sourceLanguage,
    proposals: proposed.map((proposal) => ({
      lang: proposal.lang,
      destinationPath: proposal.destinationPath,
      created: proposal.state === "missing",
      summary: proposal.summary,
    })),
    orphans: inventory.orphanTranslations,
    skipped: skippedLines,
    failures: failedLines,
  });
  const pullRequest = await world.forge.upsertPullRequest({
    base: source.branch,
    head: branch,
    title,
    body,
  });

  info(
    pullRequest.created
      ? `opened pull request #${String(pullRequest.number)} (${branch} → ${source.branch})`
      : `updated pull request #${String(pullRequest.number)} in place (${branch} → ${source.branch})`,
  );

  // Published first, red second — exactly the specification's ordering.
  if (failureReport !== "") throw new Error(failureReport);
}

/** @param {string} sourceLanguage @returns {string} */
function branchName(sourceLanguage) {
  return `harmonise/${sourceLanguage}`;
}

/**
 * The summary is model text and reaches logs: flattened to one line, so it
 * cannot forge report structure. Full sanitisation is the pull request's
 * business, not the log's.
 *
 * @param {string} summary
 * @returns {string}
 */
function oneLine(summary) {
  let flat = "";
  for (const char of summary) {
    const code = char.codePointAt(0) ?? 0;
    // Control characters never reach a log line: they are log-forgery
    // material, and whitespace collapses to the space it reads as.
    flat += code <= 0x1f || code === 0x7f ? " " : char;
  }
  return flat.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * The verified base text for a three-way merge: the translation memory's
 * entry for the pair under its recorded (source, policy) fingerprints,
 * accepted only when its bytes hash to exactly the translation fingerprint
 * the state record pinned at publication. Anything else — a memory miss, a
 * foreign or stale entry — returns undefined, and the caller refuses rather
 * than merging against unproven bytes.
 *
 * @param {import("./state.mjs").SyncStateRecord | null} recorded the pair's record, or null
 * @param {string} lang the target language
 * @param {{ lookup: (key: string) => string | undefined }} memory the run's translation memory
 * @returns {string | undefined} the verified base text, or undefined
 */
function recordedMergeBase(recorded, lang, memory) {
  if (recorded === null) return undefined;
  const candidate = memory.lookup(
    buildTmKey({
      sourceHash: recorded.sourceFingerprint,
      targetLang: lang,
      policyContext: recorded.policyFingerprint,
    }),
  );
  if (candidate === undefined) return undefined;
  return contentFingerprint(candidate) === recorded.translationFingerprint ? candidate : undefined;
}

/**
 * The fail-closed reason a `preserve-required` pair was refused instead of
 * merged: why no verified three-way path exists for this (verdict,
 * existence) row. One honest string per reachable row — the report says
 * what blocked the pair and what resolves it, never a generic error.
 *
 * @param {import("./drift.mjs").DriftVerdict} drift the pair's verdict
 * @param {boolean} targetExists whether the target file exists on disk
 * @returns {string} the refusal reason, one line
 */
function protectionRefusalReason(drift, targetExists) {
  if (!targetExists) {
    return (
      "the record says harmonise published this destination, but the target is " +
      "missing on disk — restore the file, or delete the record to let a fresh " +
      "translation be created"
    );
  }
  if (drift === "target-drift") {
    return (
      "the target changed outside harmonise since the last publication, and no " +
      "recorded base translation could be verified to merge against — resolve " +
      "the edit by hand or restore the translation memory"
    );
  }
  if (drift === "unknown") {
    return (
      "the recorded state cannot prove what harmonise last published, and no " +
      "verifiable base translation exists to merge against — resolve the edit " +
      "by hand or restore the translation memory"
    );
  }
  return (
    "the target exists but harmonise has never recorded publishing it, and " +
    "there is no base translation to merge against — adopt the file into the " +
    "sync state by hand, or resolve it manually"
  );
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
    const context = readContext(env);
    info(
      `harmonise: ${context.owner}/${context.repo} on ${context.eventName}` +
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

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

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as p from "node:path";

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
import { oneLine as oneLineCore } from "#core/one-line.mjs";
import {
  getBooleanInput,
  getInput,
  getListInput,
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
import { DeterministicRefusalError } from "./refusal.mjs";
import { buildInventory } from "./inventory.mjs";
import { detectDrift } from "./drift.mjs";
import { contentFingerprint, policyFingerprint, TRANSFORMATION_VERSION } from "./fingerprint.mjs";
import { readState, renderState, statePath, STATE_SCHEMA_VERSION } from "./state.mjs";
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
import { buildTmKey, createTmStore, readTm, serialize as serializeTm, tmPath } from "./tm.mjs";
import { mergeThreeWay, summarizeMerge } from "./threeway.mjs";
import { runPool } from "./pool.mjs";
import {
  DEFAULT_POLICY,
  classifyFailure,
  classFromStatus,
  delayClass,
  nextAction,
} from "./recovery.mjs";
import {
  buildHarmoniseRecord,
  harmoniseRecordFilename,
  serialiseHarmoniseRecord,
} from "./run-record.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */
/** @typedef {import("#core/inputs.mjs").SharedInputs} SharedInputs */
/** @typedef {import("#core/forge.mjs").Forge} Forge */

export const ACTION = "harmonise";

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
 * @typedef {SharedInputs & { configPath: string, sourceLanguage: string, documents: string[], dryRun: boolean, requestTimeoutMs: number, recordPath: string }} Inputs
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
    // Where inside the workspace the run record lands. The default agrees
    // with the manifest; the write is confined below either way.
    recordPath: getInput("record-path", { default: ".harmonise-record" }, env),
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
 * @property {(input: { record: import("./run-record.mjs").HarmoniseRecord }) => string} writeRecord serialises the record into the workspace and returns the file it wrote
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
    writeRecord:
      overrides.writeRecord ??
      (({ record }) =>
        writeRunRecord({ workspace: context.workspace, directory: inputs.recordPath, record })),
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
 * One red-ledger line with its class declared at the push: `refusal` marks a
 * deterministic refusal — a protection verdict or a ceiling — and `false` a
 * defect: provider, transport, or plain code bug. The red aggregate reads
 * the column, never the text, and the run boundary reads the class: a
 * pure-refusal red set records `refused`, one defect line fails the run
 * (F-09's mapping stays a function).
 *
 * @typedef {{ text: string, refusal: boolean }} PairLine
 */
/**
 * One pooled pair's settled result, identified by pair — never by completion
 * order: the outcome on success, the report line on failure.
 *
 * @typedef {{ ok: true, outcome: PairOutcome, sourceFingerprint: string } | { ok: false, line: PairLine }} PairResult
 */

/**
 * The red-run facts `harmoniseRun` has landed so far, stashed as they become
 * true. A `null` means the run died before the fact existed — never that
 * there was none — and is what the boundary writer records.
 *
 * @typedef {object} RedFacts
 * @property {string | null} headSha the base commit the reads pinned to, once the policy source resolved
 * @property {import("./run-record.mjs").RecordPairs | null} pairs the pair accounting, once the schedule was finalised
 * @property {import("./run-record.mjs").RecordPullRequest | null} pullRequest the pull request, once the upsert landed
 * @property {import("./run-record.mjs").HarmoniseRecord | null} record a declared terminal's built record its own write could not land; the boundary writer's first choice (#347)
 * @property {boolean} recorded whether a declared terminal point already wrote this run's one record
 */

/**
 * The red terminal for an every-pair red set. The message text is identical
 * either way; the class is the record's outcome: every line a deterministic
 * refusal makes the set the typed refusal (#347), one defect line makes it
 * a plain failure — the mapping stays a function of the worst line (F-09).
 *
 * @param {string} name
 * @param {PairLine[]} lines
 * @returns {Error}
 */
function redSetTerminal(name, lines) {
  const message = `${name}:\n${lines.map((line) => `- ${line.text}`).join("\n")}`;
  return lines.every((line) => line.refusal)
    ? new DeterministicRefusalError(message)
    : new Error(message);
}
/**
 * A declared record write that failed: the loss is logged — the run log is
 * where a record loss lives — and the built record is stashed, so a red
 * exit re-attempts that record instead of relabelling the terminal from
 * the throw (#347). Whether the loss keeps the run's verdict or reddens a
 * run whose only outcome was the record is the write site's tier, not this
 * helper's (F-14).
 *
 * @param {RedFacts} red
 * @param {import("./run-record.mjs").HarmoniseRecord} record
 * @param {unknown} cause
 * @returns {void}
 */
function loseRecord(red, record, cause) {
  red.record = record;
  info(
    `harmonise: the run record was not written: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

/**
 * Runs one harmonise pass and, when it ends red, writes the run's one red
 * record before the original error fails the step (#344): `refused` when the
 * throw is a typed deterministic refusal, `failed` for every other
 * undeclared throw (#347). The record never masks the throw it records, and
 * its own failure is a logged loss, not a replacement error; a declared
 * terminal point that already wrote — a skip record, the published or
 * partial record — is never overwritten, and one whose write failed is
 * re-attempted exactly as it was built (#347).
 *
 * @param {Inputs} inputs
 * @param {ReturnType<typeof readContext>} context
 * @param {Partial<Io> & { fetchImpl?: typeof globalThis.fetch }} [io] injectable for tests; real clients omit it, and realIo builds every member
 * @returns {Promise<void>}
 */
export async function run(inputs, context, io) {
  /** @type {Io} */
  const world = realIo(inputs, context, io ?? {});
  /** @type {RedFacts} */
  const red = { headSha: null, pairs: null, pullRequest: null, record: null, recorded: false };
  try {
    await harmoniseRun(inputs, context, world, red);
  } catch (cause) {
    if (!red.recorded) {
      // The stashed record a declared terminal built comes first: a write
      // that failed must never relabel the terminal it was written for
      // (#347). The fallback build is for a throw no declared point saw.
      const record =
        red.record ??
        buildHarmoniseRecord({
          repository: `${context.owner}/${context.repo}`,
          eventName: context.eventName,
          sourceLanguage: inputs.sourceLanguage,
          dryRun: inputs.dryRun,
          outcome: cause instanceof DeterministicRefusalError ? "refused" : "failed",
          reason: cause instanceof Error ? cause.message : String(cause),
          pairs: red.pairs,
          pullRequest: red.pullRequest,
          headSha: red.headSha,
        });
      try {
        world.writeRecord({ record });
      } catch (recordCause) {
        info(
          `harmonise: ${red.record === null ? "the failed-run" : "the run"} record was not written: ` +
            `${recordCause instanceof Error ? recordCause.message : String(recordCause)}`,
        );
      }
    }
    throw cause;
  }
}

/**
 * The run body: everything between the event read and the final verdict,
 * parameterised over the io world and the red-facts holder it stashes into.
 *
 * @param {Inputs} inputs
 * @param {ReturnType<typeof readContext>} context
 * @param {Io} world
 * @param {RedFacts} red
 * @returns {Promise<void>}
 */
async function harmoniseRun(inputs, context, world, red) {
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
  // The red-run stash begins: from here on, a red exit names the commit it
  // was judging.
  red.headSha = source.sha;
  const policy = { getContents: policyReader(world.forge, source) };
  const loaded = await loadConfigFile({ forge: policy, configPath: inputs.configPath, source });
  let config;
  try {
    config = validateConfig(loaded.raw);
  } catch (cause) {
    // validateConfig is pure over the parsed file (config.mjs's contract):
    // every throw reaching here — its own or the pattern validators' — is a
    // startup refusal, so the boundary retypes it once instead of every
    // raise site carrying the class.
    throw new DeterministicRefusalError(cause instanceof Error ? cause.message : String(cause), {
      cause,
    });
  }
  info(policySourceAuditLine({ eventName: context.eventName, source, path: loaded.path }));

  const requested = inputs.sourceLanguage;
  if (!Object.hasOwn(config.languages, requested)) {
    throw new DeterministicRefusalError(
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

  // The recorded state is advisory but, like every read pinned to the base
  // tip, fails closed: a missing or corrupt file (404 from the reader, or an
  // unparseable/foreign-schema document) leaves no records and every pair is
  // judged from the world alone — a missing target still translates, and
  // existing bytes are human work that manual-edit protection preserves.
  // Absence degrades; a transport failure in the read is a real error and
  // propagates — a run never silently continues on a state file it could
  // not reach (the reader maps 404 to `null` and repairs corruption itself,
  // so nothing is lost by letting every other failure through).
  /** @type {import("./state.mjs").SyncStateRecord[]} */
  let recordedRecords = [];
  const state = await readState({
    getContents: (path, options) => f.getContents(path, options),
    branchRef: branchBefore === null ? null : branchBefore.sha,
    defaultRef: source.sha,
    sourceLanguage: config.sourceLanguage,
  });
  if (state !== null) recordedRecords = state.records;

  // The translation memory resolves from the same snapshot authority as the
  // sync state above: ONE resolution of the harmonise branch tip — the
  // snapshot taken before any work — feeds both advisory reads, so a run
  // can never pair a state from one commit with a memory from another. A
  // run publishes the language-suffixed advisory files in one commit on
  // the proposal branch, so reading both at that resolved tip keeps the
  // state→memory join resolvable while the pull request is still unmerged —
  // advisory both ways: a file that is missing, unreadable, corrupt or of a
  // foreign schema version leaves an empty store — no prior translations are
  // offered and the run proceeds exactly as a repository without a memory
  // file always has. A corrupt branch file degrades to absent the same way
  // state does, without silently substituting a stale default. Writing:
  // entries recorded on publication are offered to later runs as reference
  // only; everything the model returns passes the same deterministic
  // validation with or without a hit. Absence and corruption degrade; a
  // transport failure in the read propagates, exactly as for state above —
  // a run never continues on a memory it could not reach.
  /** @type {ReturnType<typeof createTmStore>} */
  let memory = createTmStore();
  const stored = await readTm({
    getContents: (path, options) => f.getContents(path, options),
    branchRef: branchBefore === null ? null : branchBefore.sha,
    defaultRef: source.sha,
    sourceLanguage: config.sourceLanguage,
  });
  if (stored !== null) memory = stored.store;

  // Instruction prose is read once, capped, pinned to the audited tip, and
  // shared by every prompt.
  const documents = await loadInstructions({
    forge: { getContents: (path) => f.getContents(path, { ref: source.sha }) },
    config,
  });

  // The translation policy as one digest: the same inputs the prompts are
  // built from, hashed once and shared by every pair this run classifies —
  // plus the model identity (#252): a record must prove the model that
  // produced the wording it carries, so a model or endpoint swap re-runs
  // every affected pair instead of silently inheriting it.
  const policyDigest = policyFingerprint({
    glossary: config.glossary,
    // Absent and explicit `undefined` hash identically, so the key can be
    // passed unconditionally when no instruction document exists.
    instruction: documents.instruction,
    languageInstructions: documents.languages,
    transformationVersion: TRANSFORMATION_VERSION,
    model: inputs.model,
    apiUrl: inputs.apiUrl,
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
    throw new DeterministicRefusalError(
      `no document matches the source language '${config.sourceLanguage}' on ` +
        `'${source.branch}' — nothing to keep in step`,
    );
  }

  // A positive glob is a selection claim: this run keeps in step the
  // documents like this one. When nothing in the listed tree can match it,
  // the entry is dead — a typo or a path the branch no longer has — and
  // refusing here beats silently keeping fewer documents in step than the
  // workflow named, the same posture the labels input's narrowing gate holds
  // one action over. A negated entry is exempt: excluding from an empty set
  // is vacuous, not a mistake, and an entry negated away later still passes
  // here to fall into the nothing-selected refusal below when the net
  // selection is empty.
  for (const entry of inputs.documents) {
    if (entry === "" || entry.startsWith("!")) continue;
    const alive = inventory.pairs.some((pair) => matchGlob([entry], pair.sourcePath));
    if (!alive) {
      throw new DeterministicRefusalError(
        `the documents input names '${entry}', which matches none of the ` +
          `${String(inventory.pairs.length)} source documents on '${source.branch}' — ` +
          `a positive glob must name at least one document`,
      );
    }
  }

  const selected =
    inputs.documents.length === 0
      ? inventory.pairs
      : inventory.pairs.filter((pair) => matchGlob(inputs.documents, pair.sourcePath));
  if (selected.length === 0) {
    throw new DeterministicRefusalError(
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
  /** @type {PairLine[]} */
  const failedLines = [];
  /** @type {PairLine[]} */
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
      // Every read is pinned to the listed tree, so this is defence, not the
      // ordinary path — but the pair accounting counts pair-targets, one
      // line per source-and-language, so the source's every language fails
      // here, exactly as any other failed pair is reported.
      for (const target of pair.targets) {
        failedLines.push({
          text: `${target.lang} ${pair.sourcePath}: gone from the branch since the tree was listed`,
          // A source vanished between the tree listing and its read — a race,
          // a defect of timing, not a ceiling.
          refusal: false,
        });
      }
      continue;
    }
    // Eligibility is a property of the source, judged once: every language's
    // pair skips together, with the same reason in the report.
    const refusal = preparationRefusal(file.content);
    if (refusal !== null) {
      for (const target of pair.targets) {
        skippedLines.push({
          text: `${target.lang} ${pair.sourcePath}: ${refusal}`,
          refusal: true,
        });
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
        skippedLines.push({
          text: `${target.lang} ${pair.sourcePath}: frontmatter protection refused: ${frontmatter.message}`,
          refusal: true,
        });
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
            skippedLines.push({
              text:
                `${target.lang} ${pair.sourcePath}: the existing translation is ` +
                `${String(existingBytes)} bytes, past the ${String(MAX_SOURCE_BYTES)}-byte cap — ` +
                `shrink or split it first`,
              refusal: true,
            });
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
            failedLines.push({
              text:
                `${target.lang} ${pair.sourcePath}: manual-edit protection refused: ` +
                protectionRefusalReason(drift, existing !== undefined),
              refusal: true,
            });
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
        failedLines.push({
          text: `${target.lang} ${pair.sourcePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
          refusal: cause instanceof DeterministicRefusalError,
        });
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
            line: {
              text: `${job.lang} ${job.sourcePath}: ${
                cause instanceof Error ? cause.message : String(cause)
              } (classified ${failureClass}, ${action})`,
              // The model path's failures are provider defects or junk
              // answers — F-09's other arm fails — with one exception
              // (#351): the protection layer's restoration verdict carries
              // the refusal class, and the run records it refused.
              refusal: cause instanceof DeterministicRefusalError,
            },
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
          line: {
            text:
              `${job.lang} ${job.sourcePath}: three-way merge refused: ` +
              `${String(merged.conflicts.length)} conflict region(s), first at merged line ` +
              `${String(first.startLine)} — the manual edit and the fresh translation disagree ` +
              `(manual: "${oneLine(first.manualExcerpt)}", fresh: "${oneLine(first.freshExcerpt)}"); ` +
              `resolve by hand`,
            refusal: true,
          },
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
    if (job !== undefined)
      failedLines.push({ text: `${job.lang} ${job.sourcePath}: ${error.message}`, refusal: false });
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

  const proposed = outcomes.filter((entry) => entry.outcome === "proposed");
  // The run's pair accounting, as the record carries it. The unit is the
  // pair-target — one source document against one language — the unit every
  // path above lands a pair in, and `selected` is that schedule's size for
  // this run. `proposed`, `unchanged`, `skipped` and `failed` partition it,
  // totalling it exactly, and the record validator refuses a record where
  // they do not. `unchanged` gathers both noop verdicts — a proven-in-step
  // skip and a model's endorsement — the two faces of "already in step".
  const unchangedCount = outcomes.filter(
    (entry) => entry.outcome === "unchanged" || entry.outcome === "unchanged-skipped",
  ).length;
  const pairCounts = {
    selected: selected.reduce((total, pair) => total + pair.targets.length, 0),
    proposed: proposed.length,
    unchanged: unchangedCount,
    skipped: skippedLines.length,
    failed: failedLines.length,
  };
  // The red-run stash: once the accounting exists, a red exit records it.
  red.pairs = pairCounts;
  // Every pair failing or skipping is red: work existed and none of it was
  // attempted successfully. Some failing or skipping is reported and carried.
  if (outcomes.length === 0 && skippedLines.length === 0 && failedLines.length > 0) {
    throw redSetTerminal("every pair failed", failedLines);
  }
  if (outcomes.length === 0 && failedLines.length === 0 && skippedLines.length > 0) {
    throw redSetTerminal("every pair skipped", skippedLines);
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
  for (const line of failedLines) info(`failed ${line.text}`);
  for (const line of skippedLines) info(`skipped ${line.text}`);
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
      ? `${String(failedLines.length)} pair(s) failed:\n${failedLines.map((line) => `- ${line.text}`).join("\n")}`
      : "";

  const recordBase = {
    repository: `${context.owner}/${context.repo}`,
    eventName: context.eventName,
    sourceLanguage: config.sourceLanguage,
    dryRun: inputs.dryRun,
    pairs: pairCounts,
    headSha: source.sha,
  };

  if (inputs.dryRun) {
    info("dry run — nothing was written");
    const record = buildHarmoniseRecord({
      ...recordBase,
      outcome: "skip",
      reason: "dry run — nothing was written",
      pullRequest: null,
    });
    try {
      world.writeRecord({ record });
      red.recorded = true;
    } catch (cause) {
      loseRecord(red, record, cause);
    }
    if (failureReport !== "") throw new Error(failureReport);
    return;
  }

  if (proposed.length === 0 && rePinned.size === 0) {
    // All pairs in step: a green run and a log line — the honest common case
    // on a schedule. No branch, no commit, no pull request. A run that only
    // re-pinned records is not this case: its state write still publishes.
    info("nothing to propose — no branch, no commit, no pull request");
    const record = buildHarmoniseRecord({
      ...recordBase,
      outcome: "skip",
      reason: "nothing to propose — no branch, no commit, no pull request",
      pullRequest: null,
    });
    try {
      world.writeRecord({ record });
      red.recorded = true;
    } catch (cause) {
      loseRecord(red, record, cause);
    }
    if (failureReport !== "") throw new Error(failureReport);
    return;
  }

  const branch = branchName(config.sourceLanguage);
  assertOwnedBranch(branch, config.sourceLanguage);
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
  changes.push({ path: statePath(config.sourceLanguage), blobSha: stateBlob.sha });
  const tmBlob = await world.forge.createBlob(serializeTm(memory, { keepKeys: liveKeys }));
  changes.push({ path: tmPath(config.sourceLanguage), blobSha: tmBlob.sha });
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
    skipped: skippedLines.map((line) => line.text),
    failures: failedLines.map((line) => line.text),
  });
  const pullRequest = await world.forge.upsertPullRequest({
    base: source.branch,
    head: branch,
    title,
    body,
  });
  red.pullRequest = { number: pullRequest.number, created: pullRequest.created };

  info(
    pullRequest.created
      ? `opened pull request #${String(pullRequest.number)} (${branch} → ${source.branch})`
      : `updated pull request #${String(pullRequest.number)} in place (${branch} → ${source.branch})`,
  );

  // Published first, red second — exactly the specification's ordering. The
  // record is written here, after the publication landed, so a record-write
  // failure is a logged loss and the run keeps its verdict (F-14's posture).
  const record = buildHarmoniseRecord({
    ...recordBase,
    outcome: failureReport !== "" ? "partial" : "published",
    reason:
      failureReport !== ""
        ? `${pullRequest.created ? "opened" : "updated"} pull request #${String(pullRequest.number)}; ${failureReport.split("\n")[0]}`
        : pullRequest.created
          ? `opened pull request #${String(pullRequest.number)} (${branch} → ${source.branch})`
          : `updated pull request #${String(pullRequest.number)} in place (${branch} → ${source.branch})`,
    pullRequest: { number: pullRequest.number, created: pullRequest.created },
  });
  try {
    world.writeRecord({ record });
    red.recorded = true;
  } catch (cause) {
    loseRecord(red, record, cause);
  }

  // Published first, red second — exactly the specification's ordering.
  if (failureReport !== "") throw new Error(failureReport);
}

/** @param {string} sourceLanguage @returns {string} */
function branchName(sourceLanguage) {
  return `harmonise/${sourceLanguage}`;
}

/**
 * Writes the serialised run record inside the workspace, under a
 * deterministic name derived from the base commit the run pinned to. The
 * ceiling is the same one every read honours, pointed the other way: the
 * path resolves inside `GITHUB_WORKSPACE` or the run fails loudly — a
 * symlinked branch of the tree cannot carry the write out, and `.git` is
 * refused outright, because that is where the checkout's credential lives.
 *
 * @param {object} input
 * @param {string} input.workspace the runner's workspace root
 * @param {string} input.directory the record-path input, relative to the root
 * @param {import("./run-record.mjs").HarmoniseRecord} input.record the run's machine-readable record
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
  const file = p.join(real, harmoniseRecordFilename(record));
  writeFileSync(file, serialiseHarmoniseRecord(record), "utf8");
  return file;
}

/**
 * The owned-branch bound, code-checked where the ref is written (#253):
 * harmonise writes exactly one branch of its own and its name is
 * `harmonise/<validated source language>` — never a derived or refactored
 * variant. The bound held by call-site proximity before this guard existed:
 * the name was derived from validated config two lines above, and nothing
 * but prose tied the ref about to be written to it. A second write site, a
 * rename, or a refactor that drops the derivation now fails here instead of
 * publishing a foreign ref — the comparison is against the config's
 * validated value, and a mismatch is a refusal, not a correction.
 *
 * @param {string} branch the ref name about to be written
 * @param {string} sourceLanguage the config's validated source language
 * @returns {void}
 * @throws {Error} when the ref is outside the owned namespace
 */
export function assertOwnedBranch(branch, sourceLanguage) {
  const expected = branchName(sourceLanguage);
  if (branch !== expected) {
    throw new Error(
      `refusing to publish to a ref outside the owned namespace: '${branch}' is not '${expected}'`,
    );
  }
}

/**
 * The summary is model text and reaches logs: flattened to one line, so it
 * cannot forge report structure. Full sanitisation is the pull request's
 * business, not the log's. The flatten rule and the cap live in core; this
 * wrapper adds harmonise's control-character strip.
 *
 * @param {string} summary
 * @returns {string}
 */
function oneLine(summary) {
  return oneLineCore(summary, { maxChars: 200, stripControlChars: true });
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
    maskSecret(inputs.githubToken);
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

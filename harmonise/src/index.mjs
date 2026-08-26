/**
 * `harmonise` — keep multilingual documentation semantically in step.
 *
 * The full pipeline, in the specification's order: config map; complete
 * default-branch inventory; pairing with orphan detection; per-pair
 * preparation (glossary + skip protection, link/image localization);
 * translation through the model with contract validation; then — for real
 * runs only — one branch, one commit through the Git Data API, one pull
 * request updated in place.
 *
 * The shape is deliberate. `readInputs` is pure over an environment; `run`
 * takes its inputs plus one replaceable I/O record, so a test states the
 * whole world as a literal; and `main` is the only place that touches
 * process state.
 */

import { createChat } from "#core/chat.mjs";
import { createForge } from "#core/forge.mjs";
import { readSharedInputs } from "#core/inputs.mjs";
import { createEvidence } from "#core/untrusted.mjs";
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

import { loadConfigFile, loadInstructions, validateConfig } from "./config.mjs";
import { buildInventory } from "./inventory.mjs";
import { matchGlob } from "./glob.mjs";
import { MAX_SOURCE_BYTES, preparationRefusal, preparePair, translatePair } from "./plan.mjs";
import { buildPullRequestBody } from "./pull-request.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */
/** @typedef {import("#core/inputs.mjs").SharedInputs} SharedInputs */
/** @typedef {import("#core/forge.mjs").Forge} Forge */

export const ACTION = "harmonise";

/** Semantic retries per pair: a malformed answer gets exactly one more try. */
const ATTEMPTS_PER_PAIR = 2;

/**
 * @typedef {SharedInputs & { configPath: string, sourceLanguage: string, documents: string[], dryRun: boolean }} Inputs
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
  };
}

/**
 * Everything `run` touches that isn't its arguments, as one replaceable object.
 *
 * @typedef {object} Io
 * @property {Forge} forge
 * @property {ReturnType<typeof createChat>} chat
 * @property {ReturnType<typeof createEvidence>} evidence
 */

/**
 * @param {Inputs} inputs
 * @param {ReturnType<typeof readContext>} context
 * @returns {Io}
 */
function realIo(inputs, context) {
  return {
    forge: createForge({
      owner: context.owner,
      repo: context.repo,
      token: inputs.githubToken,
      apiUrl: context.apiUrl,
    }),
    chat: createChat({ apiUrl: inputs.apiUrl, apiKey: inputs.apiKey }),
    evidence: createEvidence(),
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
 * @property {"proposed" | "unchanged"} outcome
 * @property {{ glossaryHits: number, skippedSpans: number, linksRewritten: number }} stats
 * @property {string | undefined} content the proposal text, undefined for unchanged
 * @property {string} summary
 */

/**
 * @param {Inputs} inputs
 * @param {ReturnType<typeof readContext>} context
 * @param {Io} [io]
 * @returns {Promise<void>}
 */
export async function run(inputs, context, io = realIo(inputs, context)) {
  const { raw } = await loadConfigFile({ forge: io.forge, configPath: inputs.configPath });
  let config = validateConfig(raw);

  const requested = inputs.sourceLanguage;
  if (!Object.hasOwn(config.languages, requested)) {
    throw new Error(
      `source-language '${requested}' is not a language the config declares ` +
        `(${Object.keys(config.languages).join(", ")})`,
    );
  }
  config = { ...config, sourceLanguage: requested };

  const repository = await io.forge.getRepository();
  const ref = await io.forge.getRef(repository.defaultBranch);

  // The action's own branch is snapshotted now, before any work: at update
  // time its tip must be where this run left it, or another writer moved it
  // mid-run and is refused rather than overwritten.
  /** @type {import("#core/forge.mjs").Forge} */
  const f = io.forge;
  const ownBranch = branchName(config.sourceLanguage);
  const branchBefore = await f.getRef(ownBranch).catch((cause) => {
    if (cause instanceof Error && /HTTP 404/.test(cause.message)) return null;
    throw cause;
  });

  // Every read below is pinned to this exact commit: inventory, sources,
  // config and instructions describe one instant of the repository, and the
  // commit built from them parents on that same instant.
  /** @type {(path: string) => Promise<{ content: string } | null>} */
  const readAtBase = (path) => io.forge.getContents(path, { ref: ref.sha });

  // Instruction prose is read once, capped, pinned to the audited tip, and
  // shared by every prompt.
  const documents = await loadInstructions({
    forge: { getContents: (path) => f.getContents(path, { ref: ref.sha }) },
    config,
  });

  // Completeness is a contract: a listing GitHub had to truncate throws
  // rather than becoming an inventory that looks finished.
  const entries = await io.forge.listTree(ref.sha);
  const inventory = buildInventory({
    entries,
    config,
    documents: inputs.documents,
  });

  if (inventory.pairs.length === 0) {
    throw new Error(
      `no document matches the source language '${config.sourceLanguage}' on ` +
        `'${repository.defaultBranch}' — nothing to keep in step`,
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

  /** @type {PairOutcome[]} */
  const outcomes = [];
  /** @type {string[]} */
  const failedLines = [];
  /** @type {string[]} */
  const skippedLines = [];

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

        let lastFailure = "";
        /** @type {{ noop: boolean, text?: string, summary?: string } | undefined} */
        let translated;
        for (let attempt = 1; attempt <= ATTEMPTS_PER_PAIR; attempt++) {
          try {
            const result = await translatePair({
              prepared,
              sourceLanguage: config.sourceLanguage,
              existingText: existing,
              model: inputs.model,
              chat: io.chat,
              evidence: io.evidence,
              repository: { name: repository.name, description: repository.description },
              documents,
            });
            translated =
              result.outcome === "noop"
                ? { noop: true, summary: result.summary }
                : { noop: false, text: result.text, summary: result.summary };
            lastFailure = "";
            break;
          } catch (cause) {
            lastFailure = cause instanceof Error ? cause.message : String(cause);
          }
        }
        if (translated === undefined || lastFailure !== "") {
          failedLines.push(`${target.lang} ${pair.sourcePath}: ${lastFailure}`);
        } else {
          outcomes.push({
            lang: target.lang,
            sourcePath: pair.sourcePath,
            destinationPath: prepared.destinationPath,
            state: prepared.state,
            outcome: translated.noop ? "unchanged" : "proposed",
            stats: {
              glossaryHits: prepared.protection.glossaryHits,
              skippedSpans: prepared.protection.skippedSpans,
              linksRewritten: prepared.linksRewritten,
            },
            content: translated.text,
            summary: /** @type {string} */ (translated.summary),
          });
        }
      } catch (cause) {
        failedLines.push(
          `${target.lang} ${pair.sourcePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
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

  info(`harmonise report — ${context.owner}/${context.repo} at ${ref.sha.slice(0, 12)}`);
  info(
    `documents: ${String(inventory.pairs.length)} source(s), ` +
      `${String(selected.length)} selected, languages ${Object.keys(config.languages).join(", ")}`,
  );
  for (const entry of outcomes) {
    info(
      `translated ${entry.lang} ${entry.sourcePath} → ${entry.destinationPath}` +
        ` [${entry.state}] ${entry.outcome}` +
        ` glossary=${String(entry.stats.glossaryHits)}` +
        ` skip=${String(entry.stats.skippedSpans)}` +
        ` links=${String(entry.stats.linksRewritten)}` +
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

  if (proposed.length === 0) {
    // All pairs in step: a green run and a log line — the honest common case
    // on a schedule. No branch, no commit, no pull request.
    info("nothing to propose — no branch, no commit, no pull request");
    if (failureReport !== "") throw new Error(failureReport);
    return;
  }

  const branch = branchName(config.sourceLanguage);
  const title = `harmonise: sync ${String(proposed.length)} documents with ${config.sourceLanguage}`;

  // Blobs first, then exactly one tree layered over the audited base, one
  // commit on top, one branch pointing at it, one request carrying it.
  const changes = [];
  for (const proposal of proposed) {
    const blob = await io.forge.createBlob(/** @type {string} */ (proposal.content));
    changes.push({ path: proposal.destinationPath, blobSha: blob.sha });
  }
  const tree = await io.forge.createTree(ref.sha, changes);
  const commit = await io.forge.createCommit(
    `${title}\n\nAuthored by harmonise from ${ref.sha}.`,
    tree.sha,
    ref.sha,
  );
  // The optimistic lock is the action's own branch tip as this run found it:
  // unchanged means nobody else touched our branch while we worked.
  await io.forge.upsertBranch(
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
  const pullRequest = await io.forge.upsertPullRequest({
    base: repository.defaultBranch,
    head: branch,
    title,
    body,
  });

  info(
    pullRequest.created
      ? `opened pull request #${String(pullRequest.number)} (${branch} → ${repository.defaultBranch})`
      : `updated pull request #${String(pullRequest.number)} in place (${branch} → ${repository.defaultBranch})`,
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

/**
 * `harmonise` — keep multilingual documentation semantically in step.
 *
 * This build carries the deterministic half of the pipeline and nothing past
 * it: the config map, the complete default-branch inventory, pairing,
 * orphan detection, glossary and skip-directive protection, internal link and
 * image resolution, and the per-pair report a dry run exists to show. What it
 * refuses to do yet is propose text — the model half and the Git half land in
 * their own changes, so a real run today fails loudly rather than half-work.
 *
 * The shape is deliberate. `readInputs` is pure over an environment; `run`
 * takes its inputs plus one replaceable I/O record, so a test states the whole
 * world as a literal; and `main` is the only place that touches process state.
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
import { preparationRefusal, preparePair, translatePair } from "./plan.mjs";

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
 * @param {Inputs} inputs
 * @param {ReturnType<typeof readContext>} context
 * @param {Io} [io]
 * @returns {Promise<void>}
 */
export async function run(inputs, context, io = realIo(inputs, context)) {
  if (!inputs.dryRun) {
    // Honest refusal, not a degraded proposal: without the Git stage there is
    // nowhere for a proposal to land, and a real run that wrote nothing while
    // claiming to propose would be green-on-nothing in the worst way.
    throw new Error(
      "harmonise cannot open pull requests yet — translation and validation are in place; " +
        "the branch/commit/PR stage lands with the Git integration. Run with dry-run until then.",
    );
  }

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

  // Instruction prose is read once, capped, and shared by every prompt.
  const documents = await loadInstructions({ forge: io.forge, config });

  const repository = await io.forge.getRepository();
  const ref = await io.forge.getRef(repository.defaultBranch);
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

  /** @type {string[]} */
  const preparedLines = [];
  /** @type {string[]} */
  const failedLines = [];
  /** @type {string[]} */
  const skippedLines = [];

  for (const pair of selected) {
    const file = await io.forge.getContents(pair.sourcePath);
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
            ? await io.forge.getContents(target.path).then((found) => found?.content ?? undefined)
            : undefined;

        let lastFailure = "";
        for (let attempt = 1; attempt <= ATTEMPTS_PER_PAIR; attempt++) {
          try {
            const outcome = await translatePair({
              prepared,
              sourceLanguage: config.sourceLanguage,
              existingText: existing,
              model: inputs.model,
              chat: io.chat,
              evidence: io.evidence,
              repository: { name: repository.name, description: repository.description },
              documents,
            });
            if (outcome.outcome === "noop") {
              preparedLines.push(
                pairLine(prepared, "unchanged") + " — byte-identical to what is published",
              );
            } else {
              preparedLines.push(pairLine(prepared, "proposed") + ` — ${oneLine(outcome.summary)}`);
            }
            lastFailure = "";
            break;
          } catch (cause) {
            lastFailure = cause instanceof Error ? cause.message : String(cause);
          }
        }
        if (lastFailure !== "")
          failedLines.push(`${target.lang} ${pair.sourcePath}: ${lastFailure}`);
      } catch (cause) {
        failedLines.push(
          `${target.lang} ${pair.sourcePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }

  // Every pair failing or skipping is red: work existed and none of it was
  // attempted successfully. Some failing or skipping is reported and carried.
  if (preparedLines.length === 0 && skippedLines.length === 0 && failedLines.length > 0) {
    throw new Error(`every pair failed:\n${failedLines.map((line) => `- ${line}`).join("\n")}`);
  }
  if (preparedLines.length === 0 && failedLines.length === 0 && skippedLines.length > 0) {
    throw new Error(`every pair skipped:\n${skippedLines.map((line) => `- ${line}`).join("\n")}`);
  }

  info(`harmonise report — ${context.owner}/${context.repo} at ${ref.sha.slice(0, 12)}`);
  info(
    `documents: ${String(inventory.pairs.length)} source(s), ` +
      `${String(selected.length)} selected, languages ${Object.keys(config.languages).join(", ")}`,
  );
  for (const line of preparedLines) info(`translated ${line}`);
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
}

/**
 * One report line per translated pair: destination, state, protection counts,
 * and the outcome — with the model's one-line summary only when it proposed.
 *
 * @param {ReturnType<typeof preparePair>} prepared
 * @param {"proposed" | "unchanged"} outcome
 * @returns {string}
 */
function pairLine(prepared, outcome) {
  return (
    `${prepared.lang} ${prepared.sourcePath} → ${prepared.destinationPath}` +
    ` [${prepared.state}] ${outcome} glossary=${String(prepared.protection.glossaryHits)}` +
    ` skip=${String(prepared.protection.skippedSpans)}` +
    ` links=${String(prepared.linksRewritten)}`
  );
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
  return summary.trim().replace(/\s+/g, " ").slice(0, 200);
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

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
 * The shape is the seed's, kept: `readInputs` is pure over an environment;
 * `run` takes its inputs as arguments; and the one place that touches
 * process state is `main` plus the default `io`, which tests replace whole.
 */

import { readFileSync } from "node:fs";

import { readSharedInputs } from "#core/inputs.mjs";
import { createChat } from "#core/chat.mjs";
import { createForge } from "#core/forge.mjs";
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
import { gatherEvidence } from "./evidence.mjs";
import { assess } from "./assessment.mjs";
import { decide } from "./policy.mjs";
import { mutate } from "./mutate.mjs";
import { measureSize } from "./size.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */
/** @typedef {import("#core/inputs.mjs").SharedInputs} SharedInputs */
export const ACTION = "triage";

/**
 * @typedef {SharedInputs & { labels: string[], dryRun: boolean, configPath: string, requestTimeoutMs: number }} Inputs
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
  const event = await world.readEvent();
  const thread = threadFromEvent(context.eventName, event);

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

  // PR: the diff counts the size measurement and the diff-stats evidence
  // both read. The event payload does not carry them, which is why the
  // files listing is walked here — and a pull request past that listing's
  // ceiling is refused rather than guessed at.
  const files = thread.type === "pr" ? await world.forge.listPullRequestFiles(thread.number) : [];

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
  // mutation decision is the policy engine's, and mutate is the only writer.
  const evidence = gatherEvidence({
    thread,
    repository: repositoryFromEvent(event, context),
    config,
    sheet,
    metadata,
    files,
    size,
    eventAction: typeof event["action"] === "string" ? event["action"] : "",
  });

  const assessment = await assess({
    evidence,
    documents,
    chat: world.chat,
    model: inputs.model,
    evidenceWrapper: world.evidence,
  });

  const decision = decide({ evidence, assessment });

  await mutate({
    decision,
    forge: world.forge,
    issueNumber: thread.number,
    dryRun: inputs.dryRun,
    now: world.now,
    action: ACTION,
  });
}

/**
 * `issues` carries `issue`, `pull_request` carries `pull_request`; anything
 * else is a workflow pointing the action at an event it was not built for,
 * and that is a red run with a name, not a silent skip.
 *
 * @param {string} eventName
 * @param {Record<string, unknown>} event
 * @returns {{ type: "issue" | "pr", number: number, title: string, body: string, labels: string[] }}
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
  return {
    type: eventName === "issues" ? "issue" : "pr",
    number,
    title,
    body: typeof body === "string" ? body : "",
    labels,
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

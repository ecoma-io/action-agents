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
 * `triageMarker` — the queue label the issue forms apply — once a universal
 * category is classified, because a thread carrying a category no longer
 * awaits triage; the model is never told the marker's name.
 *
 * The shape is the seed's, kept: `readInputs` is pure over an environment;
 * `run` takes its inputs as arguments; and the one place that touches
 * process state is `main` plus the default `io`, which tests replace whole.
 */

import { readFileSync } from "node:fs";

import { readSharedInputs } from "#core/inputs.mjs";
import { createChat } from "#core/chat.mjs";
import { createForge } from "#core/forge.mjs";
import { resolveOwnLogins, upsertComment } from "#core/comment.mjs";
import { sanitiseCommentText } from "#core/sanitise.mjs";
import { createEvidence } from "#core/untrusted.mjs";
import { oneLine } from "#core/one-line.mjs";
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

import { matchLabels, parseCommentAnswer, parseLabelsAnswer } from "./answer.mjs";
import { effectiveSheet, loadConfigFile, loadInstructions, validateConfig } from "./config.mjs";
import { buildPrompt } from "./prompt.mjs";
import { currentSizeLabels, measureSize } from "./size.mjs";

/** @typedef {import("#core/runtime.mjs").Env} Env */
/** @typedef {import("#core/inputs.mjs").SharedInputs} SharedInputs */
/** @typedef {import("#core/forge.mjs").PullRequestFile} PullRequestFile */

/** @typedef {{ labels: string[], classification: string, rationale: string, files: PullRequestFile[] }} AnswerLog */

export const ACTION = "triage";
/** The rationale's cap in the marker comment and the run log, in characters. */
export const RATIONALE_CHARS = 300;

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
  // request cannot edit the policy that governs it.
  const loaded = await loadConfigFile({ forge: policy, configPath: inputs.configPath, source });
  const config = validateConfig(loaded.raw);
  info(policySourceAuditLine({ eventName: context.eventName, source, path: loaded.path }));
  if (config !== null) {
    await assertLabelsExist(world.forge, config);
  }

  const { sheet } = effectiveSheet({
    config,
    threadType: thread.type,
    narrowing: inputs.labels,
  });
  const documents = await loadInstructions({ forge: policy, config, threadType: thread.type });

  // PR: the diff counts the size measurement and the diff-stats evidence
  // both read. The event payload does not carry them, which is why the
  // files listing is walked here — and a pull request past that listing's
  // ceiling is refused rather than guessed at.
  const files = thread.type === "pr" ? await world.forge.listPullRequestFiles(thread.number) : [];

  const { messages } = buildPrompt({
    thread,
    repository: repositoryFromEvent(event, context),
    sheet,
    documents,
    files,
    evidence: world.evidence,
  });
  const { content } = await world.chat.complete({ model: inputs.model, messages });

  const size =
    config?.size !== undefined && thread.type === "pr"
      ? measureSize(files, config.size.exclude, config.size.ladder)
      : null;
  if (size !== null) {
    info(
      `size: ${String(size.counted)} counted lines (${String(size.excluded)} of ${String(size.files)} files excluded) → ${size.label}`,
    );
  }

  if (sheet === null) {
    const answer = parseCommentAnswer(content);
    logRationale(answer.rationale);
    /** @param {string} marker */
    const body = (marker) => commentBody(answer, marker);
    if (inputs.dryRun) {
      info("dry run — the classification would be written as this comment:");
      info(body("<!-- action-agents:triage:dry-run -->"));
      return;
    }
    // The identity read sits behind every dry-run and label-sheet gate: paid
    // only by a run about to write a comment.
    const ownLogins = await resolveOwnLogins(world.forge, info);
    const outcome = await upsertComment({
      store: world.forge,
      action: ACTION,
      issueNumber: thread.number,
      buildBody: body,
      ownLogins,
      startedAt: world.now(),
      log: info,
    });
    info(`classification comment ${outcome.outcome} (${String(outcome.id)})`);
    return;
  }

  const answer = parseLabelsAnswer(content);
  const { accepted, refused } = matchLabels(answer.labels, sheet);
  // A size rung is a measurement, never a model choice: the ladder is never
  // offered, so a model naming a rung cannot be "on sheet" — but on a PR the
  // rung's only legitimate role is to echo the measurement the diff already
  // produced. A rung-named answer therefore never counts as off-sheet and is
  // never applied raw; the measured rung stays authoritative (code-derived,
  // always on-sheet, reversible). On an issue there is no measurement, so a
  // rung name is off-sheet like any other unoffered name.
  const rungs = config?.size?.ladder.map((rung) => rung.label) ?? [];
  const offSheet = size === null ? refused : refused.filter((name) => !rungs.includes(name));
  for (const name of offSheet) {
    warning(
      `refused the off-sheet label '${name}' — it is not on the effective sheet; not applied`,
    );
  }
  logRationale(answer.rationale);
  if (accepted.length === 0 && offSheet.length > 0) {
    throw new Error(
      "the model's answer was entirely off-sheet — refusing rather than applying nothing",
    );
  }

  // Add-only for the sheet's labels; replacement for size, whichever hand
  // applied the last one. `sizeLabels` exists only to keep the ladder's
  // names from ever being offered; the replacement reads the rungs.
  const add = accepted.filter((name) => !thread.labels.includes(name));
  const replace =
    size === null || config?.size === undefined
      ? []
      : currentSizeLabels(thread.labels, config.size.ladder).filter((name) => name !== size.label);
  const sizeAdd = size !== null && !thread.labels.includes(size.label) ? [size.label] : [];
  // The triage marker (this repository's is `needs triage`) is the queue label
  // the issue forms apply. It is cleared — code-deterministically, never a
  // model choice — once a universal category is classified: a thread carrying
  // a category no longer awaits triage. Absent from the config, nothing is
  // removed; the model is never told the marker's name, because it is on no
  // sheet offered to it.
  const marker = config?.triageMarker;
  const classifiedCategory =
    marker !== undefined && config !== null
      ? accepted.some((name) => config.universal.has(name))
      : false;
  const clearMarker =
    marker !== undefined && classifiedCategory && thread.labels.includes(marker) ? [marker] : [];

  // Dedupe the add list: a model answer (or a size rung colliding with an
  // accepted category) must not send the same label twice, in the dry-run
  // log or in the write. GitHub would absorb the duplicate, but the dry-run
  // promise is a faithful preview.
  const toAdd = [...new Set([...add, ...sizeAdd])];
  if (inputs.dryRun) {
    info(
      `dry run — would add [${toAdd.join(", ")}]` +
        (replace.length > 0
          ? ` and remove [${replace.join(", ")}] (size is replaced, not added to)`
          : "") +
        (clearMarker.length > 0
          ? ` and remove [${clearMarker.join(", ")}] (triage marker cleared on classification)`
          : ""),
    );
    return;
  }
  if (toAdd.length > 0) {
    await world.forge.addLabels(thread.number, toAdd);
  }
  for (const name of replace) {
    await world.forge.removeLabel(thread.number, name);
  }
  for (const name of clearMarker) {
    await world.forge.removeLabel(thread.number, name);
  }
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
 * A declared label the repository no longer has is refused before the model
 * is called — applying it would be a guaranteed failure after the one
 * request that matters, and a sheet naming ghosts is stale configuration.
 *
 * @param {ReturnType<typeof createForge>} forge
 * @param {NonNullable<ReturnType<typeof validateConfig>>} config
 * @returns {Promise<void>}
 */
async function assertLabelsExist(forge, config) {
  const declared = [
    ...config.universal.keys(),
    ...config.issues.keys(),
    ...config.pr.keys(),
    ...(config.triageMarker !== undefined ? [config.triageMarker] : []),
  ];
  if (declared.length === 0) return;
  const existing = new Set(await forge.listRepositoryLabels());
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
 * The marker comment written when there is no sheet — the whole of what the
 * action can produce in that mode. Model text reaches it only through the
 * sanitiser; the scaffolding around it is the action's own.
 *
 * @param {{ classification: string, rationale: string }} answer
 * @param {string} marker
 * @returns {string}
 */
function commentBody(answer, marker) {
  const classification = sanitiseCommentText(oneLine(answer.classification), {
    maxChars: RATIONALE_CHARS,
    forbidden: [marker],
  });
  const rationale = sanitiseCommentText(oneLine(answer.rationale), {
    maxChars: RATIONALE_CHARS,
    forbidden: [marker],
  });
  for (const note of [...classification.notes, ...rationale.notes]) {
    warning(`sanitiser: ${note}`);
  }
  return [
    marker,
    "",
    `**${classification.text || "(no classification)"}**`,
    "",
    rationale.text === "" ? "" : `> ${rationale.text}`,
    "",
    "_Classified by the `triage` action. No label sheet is configured in this repository, so the classification is posted as a comment — configure `.github/action-agents/triage/triage.json5` to apply labels instead._",
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

/** @param {string} rationale */
function logRationale(rationale) {
  const flat = oneLine(rationale);
  if (flat !== "") info(`rationale: ${flat.slice(0, RATIONALE_CHARS)}`);
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

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
 * the action does not track which labels it applied itself. Size is the one
 * exception, and the cost is stated in the design page: one size label is
 * meaningful at a time and size is measured rather than judged, so a new
 * size replaces the old — including one a human applied by hand.
 *
 * The shape is the seed's, kept: `readInputs` is pure over an environment;
 * `run` takes its inputs as arguments; and the one place that touches
 * process state is `main` plus the default `io`, which tests replace whole.
 */

import { readFileSync } from "node:fs";

import { readSharedInputs } from "#core/inputs.mjs";
import { createChat } from "#core/chat.mjs";
import { createForge } from "#core/forge.mjs";
import { upsertComment } from "#core/comment.mjs";
import { sanitiseCommentText } from "#core/sanitise.mjs";
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

/**
 * @typedef {SharedInputs & { labels: string[], dryRun: boolean, configPath: string }} Inputs
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
    now: () => Date.now(),
    readEvent: async () => {
      try {
        return /** @type {Record<string, unknown>} */ (
          JSON.parse(readFileSync(context.eventPath, "utf8"))
        );
      } catch (cause) {
        const error = new Error(`the event payload at ${context.eventPath} does not parse`);
        error.cause = cause;
        throw error;
      }
    },
  };
}

/**
 * @param {Inputs} inputs
 * @param {ReturnType<typeof readContext>} context
 * @param {Io} [io]
 * @returns {Promise<void>}
 */
export async function run(inputs, context, io = realIo(inputs, context)) {
  const event = await io.readEvent();
  const thread = threadFromEvent(context.eventName, event);

  // The config file is fetched once, from the default branch — never the
  // working tree. A pull request cannot edit the policy that governs it.
  const { raw } = await loadConfigFile({ forge: io.forge, configPath: inputs.configPath });
  const config = validateConfig(raw);
  if (config !== null) {
    await assertLabelsExist(io.forge, config);
  }

  const { sheet } = effectiveSheet({
    config,
    threadType: thread.type,
    narrowing: inputs.labels,
  });
  const documents = await loadInstructions({ forge: io.forge, config, threadType: thread.type });

  // PR: the diff counts the size measurement and the diff-stats evidence
  // both read. The event payload does not carry them, which is why the
  // files listing is walked here — and a pull request past that listing's
  // ceiling is refused rather than guessed at.
  const files = thread.type === "pr" ? await io.forge.listPullRequestFiles(thread.number) : [];

  const { messages } = buildPrompt({
    thread,
    repository: repositoryFromEvent(event, context),
    sheet,
    documents,
    files,
    evidence: io.evidence,
  });
  const { content } = await io.chat.complete({ model: inputs.model, messages });

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
    const outcome = await upsertComment({
      store: io.forge,
      action: ACTION,
      issueNumber: thread.number,
      buildBody: body,
      startedAt: io.now(),
      log: info,
    });
    info(`classification comment ${outcome.outcome} (${String(outcome.id)})`);
    return;
  }

  const answer = parseLabelsAnswer(content);
  const { accepted, refused } = matchLabels(answer.labels, sheet);
  for (const name of refused) {
    warning(
      `refused the off-sheet label '${name}' — it is not on the effective sheet; not applied`,
    );
  }
  logRationale(answer.rationale);
  if (accepted.length === 0 && refused.length > 0) {
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

  if (inputs.dryRun) {
    info(
      `dry run — would add [${[...add, ...sizeAdd].join(", ")}]` +
        (replace.length > 0
          ? ` and remove [${replace.join(", ")}] (size is replaced, not added to)`
          : ""),
    );
    return;
  }
  if (add.length + sizeAdd.length > 0) {
    await io.forge.addLabels(thread.number, [...add, ...sizeAdd]);
  }
  for (const name of replace) {
    await io.forge.removeLabel(thread.number, name);
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
      if (typeof label === "object" && label !== null) {
        const name = /** @type {Record<string, unknown>} */ (label)["name"];
        if (typeof name === "string") labels.push(name);
      }
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
  const declared = [...config.universal.keys(), ...config.issues.keys(), ...config.pr.keys()];
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
    maxChars: 300,
  });
  const rationale = sanitiseCommentText(oneLine(answer.rationale), { maxChars: 300 });
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
    "_Classified by the `triage` action. No label sheet is configured in this repository, so the classification is posted as a comment — configure `.github/action-agents/triage.json5` to apply labels instead._",
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

/**
 * The contract asks for one line; a model that answered in paragraphs gets
 * its answer flattened, not its comment ballooned.
 *
 * @param {string} text
 * @returns {string}
 */
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** @param {string} rationale */
function logRationale(rationale) {
  const flat = oneLine(rationale);
  if (flat !== "") info(`rationale: ${flat.slice(0, 300)}`);
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

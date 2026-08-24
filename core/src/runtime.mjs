/**
 * The Actions runtime, as this repository needs it — and nothing more.
 *
 * `@actions/core` is a dependency that exists to read environment variables and
 * write a handful of `::command::` lines to stdout. Both halves are specified in
 * GitHub's own documentation and neither has moved in years, so taking the
 * package would mean an install step on every consumer's runner in exchange for
 * the lines below. The whole arrangement of this repository — no build, no
 * `dist/`, no install before an action starts — rests on not making that trade.
 *
 * Escaping is the part that is quietly easy to get wrong: a value carrying a
 * newline terminates the command line early and the rest is swallowed as log
 * output, which reads as a message that truncated rather than as an error. The
 * two encoders below are GitHub's own.
 *
 * Every reader takes its environment as an argument, defaulting to
 * `process.env`. That is what lets the tests state a whole environment as a
 * literal instead of mutating the process they run in.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* eslint-disable no-console -- stdout IS the interface here: workflow commands are read by the runner, not by a human. */

/** @typedef {Record<string, string | undefined>} Env */

/**
 * @param {string} value
 * @returns {string}
 */
export function encodeData(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * @param {string} value
 * @returns {string}
 */
export function encodeProperty(value) {
  return encodeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/**
 * @param {string} command
 * @param {Record<string, string | number | undefined>} properties
 * @param {string} message
 * @returns {string}
 */
export function formatCommand(command, properties, message) {
  const props = Object.entries(properties)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${encodeProperty(String(value))}`)
    .join(",");
  return `::${command}${props === "" ? "" : ` ${props}`}::${encodeData(message)}`;
}

/**
 * The environment variable the runner sets for an action input.
 *
 * @param {string} name
 * @returns {string}
 */
export function inputVariable(name) {
  return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}

/**
 * Reads an action input. Absent and empty are the same thing: a workflow
 * writing `with: { model: "" }` meant to say nothing, not to say the empty
 * string, and every caller here wants the default in both cases.
 *
 * @param {string} name
 * @param {{ required?: boolean, default?: string }} [options]
 * @param {Env} [env]
 * @returns {string}
 */
export function getInput(name, options = {}, env = process.env) {
  const raw = env[inputVariable(name)]?.trim() ?? "";
  if (raw !== "") return raw;
  if (options.default !== undefined) return options.default;
  if (options.required === true) {
    throw new Error(`Input '${name}' is required and was not supplied`);
  }
  return "";
}

/**
 * @param {string} name
 * @param {{ default?: boolean }} [options]
 * @param {Env} [env]
 * @returns {boolean}
 */
export function getBooleanInput(name, options = {}, env = process.env) {
  const raw = getInput(name, {}, env).toLowerCase();
  if (raw === "") return options.default ?? false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Input '${name}' must be 'true' or 'false', got '${raw}'`);
}

/**
 * @param {string} name
 * @param {{ default?: number, min?: number }} [options]
 * @param {Env} [env]
 * @returns {number}
 */
export function getNumberInput(name, options = {}, env = process.env) {
  const raw = getInput(name, {}, env);
  if (raw === "") {
    if (options.default === undefined) {
      throw new Error(`Input '${name}' is required and was not supplied`);
    }
    return options.default;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Input '${name}' must be a number, got '${raw}'`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new Error(`Input '${name}' must be at least ${String(options.min)}, got ${raw}`);
  }
  return parsed;
}

/**
 * A comma-separated input, as a list with the empty entries dropped.
 *
 * @param {string} name
 * @param {{ default?: string[] }} [options]
 * @param {Env} [env]
 * @returns {string[]}
 */
export function getListInput(name, options = {}, env = process.env) {
  const raw = getInput(name, {}, env);
  if (raw === "") return options.default ?? [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Registers a value for masking in the log. Every secret these actions handle
 * passes through here before anything else can print it.
 *
 * @param {string} value
 * @returns {void}
 */
export function maskSecret(value) {
  if (value !== "") console.log(formatCommand("add-mask", {}, value));
}

/** @param {string} message @returns {void} */
export function info(message) {
  console.log(message);
}

/** @param {string} message @returns {void} */
export function debug(message) {
  console.log(formatCommand("debug", {}, message));
}

/**
 * @param {string} message
 * @param {{ file?: string, line?: number, title?: string }} [annotation]
 * @returns {void}
 */
export function warning(message, annotation = {}) {
  console.log(formatCommand("warning", annotation, message));
}

/**
 * @param {string} message
 * @param {{ file?: string, line?: number, title?: string }} [annotation]
 * @returns {void}
 */
export function error(message, annotation = {}) {
  console.log(formatCommand("error", annotation, message));
}

/**
 * Fails the step. Sets `process.exitCode` rather than calling `process.exit`,
 * so pending stdout writes still flush — an action that exits hard can lose the
 * very annotation explaining why it failed.
 *
 * @param {unknown} cause
 * @returns {void}
 */
export function setFailed(cause) {
  error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}

/**
 * The runner-provided facts every action here needs, read once at the top so a
 * missing one fails immediately with a name rather than as `undefined` deep
 * inside a request.
 *
 * @param {Env} [env]
 * @returns {{ workspace: string, owner: string, repo: string, eventName: string, eventPath: string, apiUrl: string }}
 */
export function readContext(env = process.env) {
  const repository = required("GITHUB_REPOSITORY", env);
  const [owner, repo] = repository.split("/");
  if (owner === undefined || repo === undefined || owner === "" || repo === "") {
    throw new Error(`GITHUB_REPOSITORY is not 'owner/repo': '${repository}'`);
  }
  return {
    workspace: required("GITHUB_WORKSPACE", env),
    owner,
    repo,
    eventName: required("GITHUB_EVENT_NAME", env),
    eventPath: required("GITHUB_EVENT_PATH", env),
    apiUrl: env["GITHUB_API_URL"] ?? "https://api.github.com",
  };
}

/**
 * @param {string} name
 * @param {Env} env
 * @returns {string}
 */
function required(name, env) {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set — this action must run inside GitHub Actions`);
  }
  return value;
}

/**
 * Whether this module was RUN rather than imported.
 *
 * An action's entry file must do its work when the runner launches it and
 * nothing at all when a test imports it. Comparing `realpath` on both sides
 * rather than the usual `import.meta.url === pathToFileURL(argv[1]).href` is
 * what keeps that true when the path traverses a symlink — which it does,
 * because the runner resolves the action into `_actions/<owner>/<repo>/<ref>/`.
 *
 * @param {string} moduleUrl
 * @param {string | undefined} [argv1]
 * @returns {boolean}
 */
export function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (argv1 === undefined || argv1 === "") return false;
  const real = (/** @type {string} */ path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

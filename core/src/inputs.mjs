/**
 * The inputs every action here takes, read and validated in one place.
 *
 * These four are infrastructure, not policy: they say which forge to write to
 * and which model endpoint to ask, and nothing about what any action decides.
 * That is the line `pnpm arch` judges — a helper only one action could ever
 * want does not belong in `core/` even when the import direction is legal.
 *
 * Two validation choices are deliberate and worth stating, because both look
 * like omissions:
 *
 *   - **An empty `api-key` is valid.** Some people run these actions against an
 *     OpenAI-compatible endpoint with no key at all, and that configuration is
 *     a supported path rather than a degraded one. Requiring a key would refuse
 *     a setup that works.
 *   - **`api-url` is checked for a scheme, not reachability.** A typo'd URL
 *     should fail before a token is read or a thread is fetched, and a network
 *     probe in an input reader is a unit that cannot be tested offline.
 */

import { getInput, getNumberInput } from "./runtime.mjs";

/** @typedef {import("./runtime.mjs").Env} Env */

/**
 * @typedef {object} SharedInputs
 * @property {string} githubToken the token every write is made with
 * @property {string} apiUrl the OpenAI-compatible base URL, without a trailing slash
 * @property {string} apiKey the endpoint's key, or "" for a keyless endpoint
 * @property {string} model the model id to ask
 * @property {number} requestTimeoutMs the per-request timeout, in
 *   milliseconds. One number every action shares, so a caller tightening it
 *   for a slow model changes one input rather than three identical reads.

/**
 * @param {Env} [env]
 * @returns {SharedInputs}
 */
export function readSharedInputs(env = process.env) {
  const apiUrl = normaliseUrl(getInput("api-url", { required: true }, env));
  return {
    githubToken: getInput("github-token", { required: true }, env),
    apiUrl,
    apiKey: getInput("api-key", {}, env),
    model: getInput("model", { required: true }, env),
    requestTimeoutMs: getNumberInput("request-timeout-ms", { default: 30_000, min: 1_000 }, env),
  };
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normaliseUrl(value) {
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Input 'api-url' is not a URL: '${value}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Input 'api-url' must be http or https, got '${parsed.protocol}'`);
  }
  return value.replace(/\/+$/, "");
}

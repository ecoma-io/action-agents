/**
 * The chat-completions request — the whole of what crosses the seam to a
 * model.
 *
 * Nothing provider-specific lives above this module: what crosses into the
 * rest of the code is the OpenAI chat-completions protocol, and a feature
 * needing more than the protocol offers is proposing to narrow who can use
 * these actions (CONTRIBUTING.md). This speaks the protocol and nothing else —
 * one request, `model` and `messages`, no tools, no streaming, no tuning
 * knobs a free-tier endpoint may refuse.
 *
 * The provider's answer is returned as a raw content string. Judging it —
 * parsing, matching against a sheet, refusing the off-sheet — is the calling
 * action's job; this module's job is to deliver the string or fail loudly,
 * in the shapes providers actually produce:
 *
 *   - non-2xx, timeout, unreachable after retries — the http layer's errors;
 *   - HTTP 200 with an error object in the body — several providers do this,
 *     and it is an error, not an empty answer;
 *   - a body that is not JSON (HTML, most often) — an error naming the body;
 *   - a body that is JSON but holds no `choices[0].message.content` string —
 *     the model stopped partway, and an empty answer must not be handed on
 *     as though it were a decided one.
 *
 * The keyless configuration is a supported path, not a degraded one: with no
 * `api-key` the request carries no `Authorization` header at all.
 */

/**
 * The client `createChat` returns, named so an action's JSDoc can say
 * `import("#core/chat.mjs").Chat`.
 *
 * @typedef {ReturnType<typeof createChat>} Chat
 */

import { createHttpClient } from "./http.mjs";

/**
 * @typedef {object} ChatMessage
 * @property {"system" | "user" | "assistant"} role
 * @property {string} content
 */

/**
 * @typedef {object} ChatConfig
 * @property {string} apiUrl the OpenAI-compatible base URL, already normalised
 * @property {string} apiKey the endpoint's key, or "" for a keyless endpoint
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {number} [timeoutMs]
 * @property {number} [maxAttempts]
 * @property {number} [retryDelayMs]
 */

/** The provider answered, but the answer is not a usable chat completion. */
export class ChatError extends Error {
  /** @param {string} message @param {{ excerpt?: string }} [details] */
  constructor(message, details = {}) {
    super(details.excerpt === undefined ? message : `${message}: ${details.excerpt}`);
    this.name = "ChatError";
    this.excerpt = details.excerpt ?? "";
  }
}

/** How much of a body an error message quotes — enough to recognise, not enough to flood a log. */
const EXCERPT_BYTES = 200;

/**
 * @param {ChatConfig} config
 * @returns {{ complete: (request: { model: string, messages: ChatMessage[] }) => Promise<{ content: string }> }}
 */
export function createChat(config) {
  const http = createHttpClient({
    baseUrl: config.apiUrl,
    headers: { accept: "application/json" },
    // Keyless is a supported configuration: no header at all, not a blank one.
    authorization: config.apiKey === "" ? undefined : `Bearer ${config.apiKey}`,
    fetchImpl: config.fetchImpl,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    retryDelayMs: config.retryDelayMs,
  });

  return {
    /**
     * Makes one chat-completions request and returns the answer's content.
     *
     * @param {{ model: string, messages: ChatMessage[] }} request
     * @returns {Promise<{ content: string }>}
     */
    async complete(request) {
      const response = await http.request("/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { model: request.model, messages: request.messages },
      });

      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(response.text);
      } catch {
        throw new ChatError("the provider's response body is not JSON", {
          excerpt: excerpt(response.text),
        });
      }

      const embedded = embeddedErrorMessage(parsed);
      if (embedded !== null) {
        throw new ChatError("the provider returned an error object with HTTP 200", {
          excerpt: embedded,
        });
      }

      const content = readContent(parsed);
      if (content === undefined) {
        throw new ChatError("the provider's response holds no choices[0].message.content", {
          excerpt: excerpt(response.text),
        });
      }
      return { content };
    },
  };
}

/**
 * Several providers report failure as HTTP 200 with `{"error": …}` in the
 * body. That is an error, not an empty answer.
 *
 * @param {unknown} parsed
 * @returns {string | null}
 */
function embeddedErrorMessage(parsed) {
  if (typeof parsed !== "object" || parsed === null) return null;
  const error = /** @type {Record<string, unknown>} */ (parsed)["error"];
  if (typeof error !== "object" || error === null) return null;
  const message = /** @type {Record<string, unknown>} */ (error)["message"];
  return typeof message === "string" ? message : null;
}

/**
 * `choices[0].message.content`, or undefined when the response does not carry
 * a string there — a null content (a refusal, a stop partway) is not an empty
 * answer and must not become one.
 *
 * @param {unknown} parsed
 * @returns {string | undefined}
 */
function readContent(parsed) {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const choices = /** @type {Record<string, unknown>} */ (parsed)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = /** @type {Record<string, unknown>} */ (first)["message"];
  if (typeof message !== "object" || message === null) return undefined;
  const content = /** @type {Record<string, unknown>} */ (message)["content"];
  return typeof content === "string" ? content : undefined;
}

/**
 * @param {string} text
 * @returns {string}
 */
function excerpt(text) {
  // Flattened to one line while it is here: an error message travels into
  // logs, and a multi-line excerpt is a log-forgery primitive, not context.
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.slice(0, EXCERPT_BYTES);
  return cut.length < flat.length ? `${cut}…` : cut;
}

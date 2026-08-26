/**
 * The chat-completions request — the whole of what crosses the seam to a
 * model.
 *
 * Nothing provider-specific lives above this module: what crosses into the
 * rest of the code is the OpenAI chat-completions protocol, and a feature
 * needing more than the protocol offers is proposing to narrow who can use
 * these actions (CONTRIBUTING.md). This speaks the protocol and nothing else
 * — one request, `model`, `messages`, and optionally `tools`; no streaming,
 * no tuning knobs a free-tier endpoint may refuse.
 *
 * Tool calling is where the protocol grew for `review`'s agent loop, and it
 * grew without bending: a request built without `tools` behaves byte-for-byte
 * as it always did, down to refusing a missing content string. A request
 * built with `tools` accepts the two shapes a tool turn can take — prose, or
 * tool calls, or both together — and returns the calls verbatim: parsing a
 * call's `arguments` is the caller's decision, never this module's repair.
 * What this module refuses is the wire contract itself — tool calls whose ids
 * repeat, whose names are absent, whose arguments are not strings. Those are
 * defects in the conversation, not answers to hand on.
 *
 * The provider's answer is returned raw otherwise. Judging it — parsing,
 * matching against a sheet, refusing the off-sheet — is the calling action's
 * job; this module's job is to deliver the answer or fail loudly, in the
 * shapes providers actually produce:
 *
 *   - non-2xx, timeout, unreachable after retries — the http layer's errors;
 *   - HTTP 200 with an error object in the body — several providers do this,
 *     and it is an error, not an empty answer;
 *   - a body that is not JSON (HTML, most often) — an error naming the body;
 *   - a body that is JSON but holds no usable `choices[0].message` — the
 *     model stopped partway, and an empty answer must not be handed on as
 *     though it were a decided one.
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
 * One tool call the model asks for, verbatim off the wire. `arguments` stays
 * a string here — whether it parses, and into what, is the calling loop's
 * business, decided against its own fixed registry.
 *
 * @typedef {object} ChatToolCall
 * @property {string} id
 * @property {string} name
 * @property {string} arguments
 */

/**
 * A tool offered to the model, in the protocol's function shape.
 *
 * @typedef {object} ChatTool
 * @property {string} name
 * @property {string} [description]
 * @property {Record<string, unknown>} [parameters] a JSON Schema object
 */

/**
 * One turn of the conversation. The four roles are the protocol's; the
 * optional fields attach per role:
 *
 *   - `system` / `user`: plain prose;
 *   - `assistant`: prose and/or `toolCalls` — a tool-call turn may carry
 *     accompanying prose, which rides along as data;
 *   - `tool`: one call's result, `toolCallId` naming the call answered.
 *
 * @typedef {object} ChatMessage
 * @property {"system" | "user" | "assistant" | "tool"} role
 * @property {string | null} [content] null only where the protocol says so — an assistant turn that asks for tools and says nothing else
 * @property {ChatToolCall[]} [toolCalls] assistant turns that ask for tools
 * @property {string} [toolCallId] tool-result turns: which call this answers
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
 * @returns {{
 *   complete: (request: { model: string, messages: ChatMessage[], tools?: ChatTool[] }) => Promise<{
 *     content: string,
 *     toolCalls: ChatToolCall[],
 *     finishReason: string | undefined,
 *   }>,
 * }}
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
     * Makes one chat-completions request and returns the answer's content,
     * any requested tool calls, and the provider's finish reason.
     *
     * Without `tools` the answer is exactly what it always was: a content
     * string, or a refusal to pretend a half-answer was one. With `tools`,
     * a `null` content beside real tool calls is a tool turn, not a failure.
     *
     * @param {{ model: string, messages: ChatMessage[], tools?: ChatTool[] }} request
     * @returns {Promise<{ content: string, toolCalls: ChatToolCall[], finishReason: string | undefined }>}
     */
    async complete(request) {
      const tools = request.tools;
      const offeringTools = tools !== undefined && tools.length > 0;
      const response = await http.request("/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          model: request.model,
          messages: request.messages.map(toWireMessage),
          ...(offeringTools ? { tools: tools.map(toWireTool) } : {}),
        },
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

      const answer = readAnswer(parsed);
      if (answer === null) {
        throw new ChatError("the provider's response holds no choices[0].message", {
          excerpt: excerpt(response.text),
        });
      }
      if (answer.defect !== "") {
        // A violation of the conversation's own wire format — repeated call
        // ids, absent names, non-string arguments — is a broken answer, not
        // one to hand to a loop that would have to guess at repairing it.
        throw new ChatError(
          `the provider's tool-call response violates the protocol: ${answer.defect}`,
          {
            excerpt: excerpt(response.text),
          },
        );
      }

      if (!offeringTools) {
        if (typeof answer.content !== "string") {
          throw new ChatError("the provider's response holds no choices[0].message.content", {
            excerpt: excerpt(response.text),
          });
        }
        return { content: answer.content, toolCalls: [], finishReason: answer.finishReason };
      }

      if (typeof answer.content !== "string" && answer.toolCalls.length === 0) {
        throw new ChatError(
          "the provider's response carries neither content nor well-formed tool calls",
          { excerpt: excerpt(response.text) },
        );
      }
      return {
        content: answer.content ?? "",
        toolCalls: answer.toolCalls,
        finishReason: answer.finishReason,
      };
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
 * `choices[0].message` taken apart: its content (`null` where the protocol
 * puts null), its tool calls validated against the wire contract, and the
 * finish reason. Null means the response carried no readable message at all.
 * A wire-contract violation comes back as `defect` rather than thrown from
 * here, so the caller can name it once, in one place.
 *
 * @param {unknown} parsed
 * @returns {{
 *   content: string | null,
 *   toolCalls: ChatToolCall[],
 *   finishReason: string | undefined,
 *   defect: string,
 * } | null}
 */
function readAnswer(parsed) {
  if (typeof parsed !== "object" || parsed === null) return null;
  const choices = /** @type {Record<string, unknown>} */ (parsed)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const choice = /** @type {Record<string, unknown>} */ (first);
  const rawMessage = choice["message"];
  if (typeof rawMessage !== "object" || rawMessage === null) return null;
  const message = /** @type {Record<string, unknown>} */ (rawMessage);

  const rawContent = message["content"];
  const content =
    typeof rawContent === "string" ? rawContent : rawContent === null ? null : undefined;

  const finishReason =
    typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : undefined;

  /** @type {ChatToolCall[]} */
  const toolCalls = [];
  const rawCalls = message["tool_calls"];
  if (rawCalls === undefined) {
    // No tool_calls key at all: content must speak for itself, and `undefined`
    // (missing, or a non-string the protocol never sends) means it cannot.
    return { content: content ?? null, toolCalls, finishReason, defect: "" };
  }
  if (!Array.isArray(rawCalls)) {
    return {
      content: content ?? null,
      toolCalls,
      finishReason,
      defect: "tool_calls is not an array",
    };
  }

  /** @type {Set<string>} */
  const seenIds = new Set();
  for (const raw of rawCalls) {
    if (typeof raw !== "object" || raw === null) {
      return {
        content: content ?? null,
        toolCalls,
        finishReason,
        defect: "a tool call is not an object",
      };
    }
    const record = /** @type {Record<string, unknown>} */ (raw);
    const id = record["id"];
    if (typeof id !== "string" || id === "") {
      return { content: content ?? null, toolCalls, finishReason, defect: "a tool call has no id" };
    }
    if (seenIds.has(id)) {
      return {
        content: content ?? null,
        toolCalls,
        finishReason,
        defect: `two tool calls share the id '${flatten(id)}'`,
      };
    }
    seenIds.add(id);
    if (record["type"] !== "function") {
      return {
        content: content ?? null,
        toolCalls,
        finishReason,
        defect: `tool call '${flatten(id)}' is not of type "function"`,
      };
    }
    const fn = record["function"];
    if (typeof fn !== "object" || fn === null) {
      return {
        content: content ?? null,
        toolCalls,
        finishReason,
        defect: `tool call '${flatten(id)}' has no function`,
      };
    }
    const functionRecord = /** @type {Record<string, unknown>} */ (fn);
    const name = functionRecord["name"];
    const args = functionRecord["arguments"];
    if (typeof name !== "string" || name === "") {
      return {
        content: content ?? null,
        toolCalls,
        finishReason,
        defect: `tool call '${flatten(id)}' has no name`,
      };
    }
    if (typeof args !== "string") {
      return {
        content: content ?? null,
        toolCalls,
        finishReason,
        defect: `tool call '${flatten(id)}' carries arguments that are not a string`,
      };
    }
    toolCalls.push({ id, name, arguments: args });
  }

  return { content: content ?? null, toolCalls, finishReason, defect: "" };
}

/**
 * One conversation turn, in the exact shape the wire expects.
 *
 * @param {ChatMessage} message
 * @returns {Record<string, unknown>}
 */
function toWireMessage(message) {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content ?? "" };
  }
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    return {
      role: "assistant",
      content: message.content ?? null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content ?? "" };
}

/**
 * One offered tool, in the protocol's function shape.
 *
 * @param {ChatTool} tool
 * @returns {Record<string, unknown>}
 */
function toWireTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    },
  };
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

/**
 * One line, however hostile the string — provider-controlled ids travel into
 * error text, which travels into logs.
 *
 * @param {string} text
 * @returns {string}
 */
function flatten(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_BYTES);
}

// Non-JSON / wrong-shape completions — the provider-boundary surface.
//
// A hostile provider answers a chat-completions call with HTTP 200 but a body
// that is not a usable completion: invalid JSON, `{"error": …}` (several
// gateways report failure as 200 with an error object), or a non-object
// (an array, a bare number). The seam's promise is that none of these ever
// reaches the caller as a "completion" string — each is refused as the typed
// `ChatError`, so an action can tell "the provider broke" apart from "the
// model answered". The refusal is the bounded shape: the caller gets an error,
// never raw provider text passed off as model output.
//
// What must hold: every junk 200 rejects with `ChatError` (a documented
// contract), the success case resolves with the parsed content, and no call
// site ever sees the raw wire text as a completion.
//
// Deterministic and offline: the provider is a scripted fetch returning the
// fixed junk bodies; no network, no model.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createChat } from "#core/chat.mjs";
import { ChatError } from "#core/chat.mjs";

/**
 * A provider that answers every chat-completions call with the given HTTP 200
 * body.
 *
 * @param {string} body
 * @returns {{ chat: ReturnType<typeof createChat> }}
 */
function chatAnswering(body) {
  const fetchImpl = /** @type {typeof globalThis.fetch} */ (
    async () => {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  );
  const chat = createChat({
    apiUrl: "https://api.example/v1",
    apiKey: "sk-secret",
    fetchImpl,
    // No retries: the seam must judge the junk body itself, unchanged.
    maxAttempts: 1,
  });
  return { chat };
}

/** The exact request `complete` performs on the seam. */
const REQUEST = { model: "gpt-4", messages: [{ role: "user", content: "hi" }] };

describe("junk HTTP-200 bodies are refused as typed ChatError, never a completion", () => {
  it("invalid JSON rejects as ChatError", async () => {
    const { chat } = chatAnswering("{not json!");
    const error = await chat.complete(REQUEST).catch((cause) => cause);
    assert.ok(error instanceof ChatError, "expected a typed ChatError on invalid JSON");
    assert.match(error.message, /not JSON/);
  });

  it("an embedded {error} object under HTTP 200 rejects as ChatError", async () => {
    const { chat } = chatAnswering(JSON.stringify({ error: { message: "rate limited" } }));
    const error = await chat.complete(REQUEST).catch((cause) => cause);
    assert.ok(error instanceof ChatError, "expected a typed ChatError on an embedded error");
    assert.match(error.message, /error object/);
  });

  it("a non-object JSON body (array) rejects as ChatError, not a completion", async () => {
    const { chat } = chatAnswering(JSON.stringify([1, 2, 3]));
    const error = await chat.complete(REQUEST).catch((cause) => cause);
    assert.ok(error instanceof ChatError, "expected a typed ChatError on a non-object body");
  });

  it("a bare JSON number rejects as ChatError, not a completion", async () => {
    const { chat } = chatAnswering("42");
    const error = await chat.complete(REQUEST).catch((cause) => cause);
    assert.ok(error instanceof ChatError, "expected a typed ChatError on a bare number");
  });

  it("a well-formed completion still resolves, so the refusal is not over-broad", async () => {
    const { chat } = chatAnswering(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      }),
    );
    const result = await chat.complete(REQUEST);
    assert.equal(result.content, "hello", "the valid completion should come back intact");
    assert.equal(result.finishReason, "stop");
  });
});

// Tests for the chat-completions seam.
//
// No model is ever called from a test — the seam is stubbed, and what gets
// pinned is how this code behaves against the responses a provider actually
// produces, including the ugly ones: a 200 carrying an error object, HTML
// where JSON was promised, an answer with no content behind it. The keyless
// configuration is pinned as a first-class path, not an afterthought.

import { describe, expect, it } from "vitest";

import { HttpError } from "./http.mjs";
import { ChatError, createChat } from "./chat.mjs";

/** @typedef {import("./chat.mjs").ChatMessage} ChatMessage */

const MESSAGES = /** @type {ChatMessage[]} */ ([
  { role: "system", content: "Classify the thread." },
  { role: "user", content: "evidence" },
]);

/**
 * @param {(body: string, status?: number) => Response} respond
 * @returns {{ chat: ReturnType<typeof createChat>, calls: { url: string, init: RequestInit | undefined }[] }}
 */
function withFetch(respond) {
  /** @type {{ url: string, init: RequestInit | undefined }[]} */
  const calls = [];
  /** @type {typeof globalThis.fetch} */
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond('{"choices":[{"message":{"content":"{\\"labels\\":[\\"bug\\"]}"}}]}');
  };
  return {
    chat: createChat({ apiUrl: "https://api.example/v1", apiKey: "sk-x", fetchImpl }),
    calls,
  };
}

describe("the request", () => {
  it("asks {api-url}/chat/completions with the model and messages", async () => {
    const { chat, calls } = withFetch(
      () => new Response('{"choices":[{"message":{"content":"{}"}}]}'),
    );

    await chat.complete({ model: "gpt-x", messages: MESSAGES });

    const request = calls[0];
    expect(request?.url).toBe("https://api.example/v1/chat/completions");
    expect(request?.init?.method).toBe("POST");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      model: "gpt-x",
      messages: MESSAGES,
    });
  });

  it("sends the key as a bearer token, and nothing at all when keyless", async () => {
    /** @type {Record<string, string>[]} */
    const headers = [];
    /** @type {typeof globalThis.fetch} */
    const fetchImpl = async (_url, init) => {
      headers.push(/** @type {Record<string, string>} */ (init?.headers ?? {}));
      return new Response('{"choices":[{"message":{"content":"x"}}]}');
    };

    await createChat({ apiUrl: "https://api.example/v1", apiKey: "sk-x", fetchImpl }).complete({
      model: "m",
      messages: MESSAGES,
    });
    await createChat({ apiUrl: "https://api.example/v1", apiKey: "", fetchImpl }).complete({
      model: "m",
      messages: MESSAGES,
    });

    expect(headers[0]?.["Authorization"]).toBe("Bearer sk-x");
    expect(headers[1]?.["Authorization"]).toBeUndefined();
  });
});

describe("the answer", () => {
  it("returns the content of the first choice", async () => {
    const { chat } = withFetch(() => new Response('{"choices":[{"message":{"content":"hello"}}]}'));
    await expect(chat.complete({ model: "m", messages: MESSAGES })).resolves.toEqual({
      content: "hello",
    });
  });

  it("refuses an HTTP 200 carrying an error object, with the provider's message", async () => {
    const { chat } = withFetch(
      () => new Response('{"error":{"message":"quota exhausted","code":429}}'),
    );

    const error = await chat.complete({ model: "m", messages: MESSAGES }).catch((c) => c);
    expect(error).toBeInstanceOf(ChatError);
    expect(error.message).toMatch(/quota exhausted/);
  });

  it("refuses a body that is not JSON — HTML most often", async () => {
    const { chat } = withFetch(() => new Response("<html>gateway</html>"));

    const error = await chat.complete({ model: "m", messages: MESSAGES }).catch((c) => c);
    expect(error).toBeInstanceOf(ChatError);
    expect(error.message).toMatch(/not JSON/);
    expect(error.message).toMatch(/<html>/);
  });

  it("refuses a JSON body with no choices, or no string content", async () => {
    const noChoices = withFetch(() => new Response('{"id":"x"}'));
    const nullContent = withFetch(
      () => new Response('{"choices":[{"message":{"content":null,"refusal":"no"}}]}'),
    );

    await expect(noChoices.chat.complete({ model: "m", messages: MESSAGES })).rejects.toThrow(
      /no choices/,
    );
    await expect(nullContent.chat.complete({ model: "m", messages: MESSAGES })).rejects.toThrow(
      /no choices\[0\]\.message\.content/,
    );
  });

  it("carries a non-2xx through as the http layer's error", async () => {
    const { chat } = withFetch(() => new Response("overloaded", { status: 503 }));

    const error = await chat.complete({ model: "m", messages: MESSAGES }).catch((c) => c);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(503);
  });

  it("never places the api key in an error message", async () => {
    /** @type {typeof globalThis.fetch} */
    const fetchImpl = async () => new Response("Server Error", { status: 500 });
    const chat = createChat({
      apiUrl: "https://api.example/v1",
      apiKey: "sk-secret",
      fetchImpl,
      maxAttempts: 1,
      retryDelayMs: 1,
    });

    const error = await chat.complete({ model: "m", messages: MESSAGES }).catch((c) => c);
    expect(error.message).not.toContain("sk-secret");
  });
});

// Tests for the chat-completions seam.
//
// No model is ever called from a test — the seam is stubbed, and what gets
// pinned is how this code behaves against the responses a provider actually
// produces, including the ugly ones: a 200 carrying an error object, HTML
// where JSON was promised, an answer with no content behind it. The keyless
// configuration is pinned as a first-class path, not an afterthought.

import { describe, expect, it } from "vitest";

import { HttpError } from "./transport-errors.mjs";
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
      toolCalls: [],
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

describe("tool calls", () => {
  const TOOLS = [
    {
      name: "read_file",
      description: "one file's content",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
  ];

  it("carries the tools in the request's function shape, and only when offered", async () => {
    const { chat, calls } = withFetch(
      () => new Response('{"choices":[{"message":{"content":"{}"}}]}'),
    );

    await chat.complete({ model: "m", messages: MESSAGES, tools: TOOLS });

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "m",
      messages: MESSAGES,
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "one file's content",
            parameters: TOOLS[0]?.parameters,
          },
        },
      ],
    });

    const without = withFetch(() => new Response('{"choices":[{"message":{"content":"{}"}}]}'));
    await without.chat.complete({ model: "m", messages: MESSAGES });
    expect(Object.keys(JSON.parse(String(without.calls[0]?.init?.body)))).not.toContain("tools");
  });

  it("maps conversation tool turns onto the wire format exactly", async () => {
    const { chat, calls } = withFetch(
      () => new Response('{"choices":[{"message":{"content":"ok"}}]}'),
    );
    const messages = /** @type {ChatMessage[]} */ ([
      ...MESSAGES,
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"a.mjs"}' }],
      },
      { role: "tool", toolCallId: "call_1", content: "file body" },
    ]);

    await chat.complete({ model: "m", messages, tools: TOOLS });

    expect(JSON.parse(String(calls[0]?.init?.body)).messages.slice(2)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.mjs"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file body" },
    ]);
  });

  it("returns a tool-call turn verbatim, finish reason included", async () => {
    const { chat } = withFetch(
      () =>
        new Response(
          '{"choices":[{"finish_reason":"tool_calls","message":{"content":null,' +
            '"tool_calls":[{"id":"call_9","type":"function","function":{"name":"search",' +
            '"arguments":"{\\"query\\":\\"TODO\\"}"}}]}}]}',
        ),
    );

    await expect(chat.complete({ model: "m", messages: MESSAGES, tools: TOOLS })).resolves.toEqual({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_9", name: "search", arguments: '{"query":"TODO"}' }],
    });
  });

  it("keeps prose that accompanies tool calls, as data", async () => {
    const { chat } = withFetch(
      () =>
        new Response(
          '{"choices":[{"message":{"content":"let me look.",' +
            '"tool_calls":[{"id":"c1","type":"function","function":{"name":"read_file","arguments":"{}"}}]}}]}',
        ),
    );

    const answer = await chat.complete({ model: "m", messages: MESSAGES, tools: TOOLS });
    expect(answer.content).toBe("let me look.");
    expect(answer.toolCalls).toHaveLength(1);
  });

  it("refuses the wire contract's violation shapes", async () => {
    /**
     * @param {string} fn
     */
    const call = (fn) => `{"choices":[{"message":{"content":null,"tool_calls":[${fn}]}}]}`;
    const cases = [
      // duplicate ids
      call(
        `{"id":"x","type":"function","function":{"name":"a","arguments":"{}"}},` +
          `{"id":"x","type":"function","function":{"name":"b","arguments":"{}"}}`,
      ),
      // missing id
      call(`{"type":"function","function":{"name":"a","arguments":"{}"}}`),
      // wrong type
      call(`{"id":"y","type":"code_interpreter","function":{"name":"a","arguments":"{}"}}`),
      // missing name
      call(`{"id":"z","type":"function","function":{"arguments":"{}"}}`),
      // non-string arguments
      call(`{"id":"w","type":"function","function":{"name":"a","arguments":{"path":"x"}}}`),
      // tool_calls not an array
      `{"choices":[{"message":{"content":null,"tool_calls":{"id":"q"}}}]}`,
    ];
    for (const body of cases) {
      const { chat } = withFetch(() => new Response(body));
      await expect(chat.complete({ model: "m", messages: MESSAGES, tools: TOOLS })).rejects.toThrow(
        /violates the protocol/,
      );
    }
  });

  it("treats an explicit null tool_calls as absence — several gateways send it", async () => {
    const withTools = withFetch(
      () =>
        new Response(
          '{"choices":[{"finish_reason":"stop","message":{"content":"done","tool_calls":null}}]}',
        ),
    );
    await expect(
      withTools.chat.complete({ model: "m", messages: MESSAGES, tools: TOOLS }),
    ).resolves.toEqual({ content: "done", toolCalls: [], finishReason: "stop" });

    const withoutTools = withFetch(
      () => new Response('{"choices":[{"message":{"content":"plain","tool_calls":null}}]}'),
    );
    await expect(withoutTools.chat.complete({ model: "m", messages: MESSAGES })).resolves.toEqual({
      content: "plain",
      toolCalls: [],
    });
  });

  it("refuses an answer with neither content nor tool calls when tools were offered", async () => {
    const neither = withFetch(() => new Response('{"choices":[{"message":{"content":null}}]}'));
    const emptyCalls = withFetch(
      () => new Response('{"choices":[{"message":{"content":null,"tool_calls":[]}}]}'),
    );

    await expect(
      neither.chat.complete({ model: "m", messages: MESSAGES, tools: TOOLS }),
    ).rejects.toThrow(/neither content nor/);
    await expect(
      emptyCalls.chat.complete({ model: "m", messages: MESSAGES, tools: TOOLS }),
    ).rejects.toThrow(/neither content nor/);
  });

  it("keeps the no-tools contract strict — a null content is still no answer", async () => {
    const { chat } = withFetch(
      () =>
        new Response(
          '{"choices":[{"message":{"content":null,"tool_calls":[{"id":"c","type":"function","function":{"name":"read_file","arguments":"{}"}}]}}]}',
        ),
    );

    // The provider volunteered tool calls nobody asked for; without a tools
    // offer this remains the plain-content seam triage and harmonise use.
    await expect(chat.complete({ model: "m", messages: MESSAGES })).rejects.toThrow(
      /no choices\[0\]\.message\.content/,
    );
  });
});

// Tests for the Assessment stage — the run's single chat call. The model is
// stubbed; what is pinned is that exactly one completion is requested, that
// the prompt carries the evidence-framed title and body, and that the answer
// contract (labels vs comment) is chosen by sheet presence, not by anything
// the model said.

import { describe, expect, it, vi } from "vitest";

import { assess } from "./assessment.mjs";

/** @typedef {{ model: string, messages: import("#core/chat.mjs").ChatMessage[], tools?: import("#core/chat.mjs").ChatTool[] }} ChatRequest */

/** @type {import("./evidence.mjs").ThreadEvidence} */
const THREAD = {
  type: "issue",
  number: 7,
  title: "Import fails",
  body: "Steps to reproduce.",
  labels: [],
};

/** @type {import("#core/untrusted.mjs").Evidence} */
const WRAPPER = {
  wrap: (label, content) => `[evidence:${label}]\n${content}\n[end-evidence:${label}]`,
};

/**
 * @param {object} [options]
 * @param {string} [options.content] what the stub model answers
 * @param {Error} [options.error] thrown by the stub model
 */
function world(options = {}) {
  return {
    chat: {
      complete: vi.fn(
        /**
         * @param {ChatRequest} _request
         */
        async (_request) => {
          if (options.error) throw options.error;
          return { content: options.content ?? "{}", toolCalls: [], finishReason: "stop" };
        },
      ),
    },
  };
}

/** @returns {import("./assessment.mjs").AssessmentInput} */
function input(overrides = {}) {
  return {
    evidence: {
      thread: THREAD,
      repository: { name: "repo", description: "d" },
      policy: null,
      sheet: null,
      labelMetadata: new Map(),
      files: [],
      measuredSize: null,
      eventAction: "opened",
    },
    documents: {},
    chat: world().chat,
    model: "gpt-x",
    evidenceWrapper: WRAPPER,
    ...overrides,
  };
}

describe("assess", () => {
  it("makes exactly one chat call", async () => {
    const chat = world({ content: '{"labels":["bug"],"rationale":"r"}' }).chat;
    await assess(
      input({ chat, evidence: { ...input().evidence, sheet: new Map([["bug", "a bug"]]) } }),
    );
    expect(chat.complete).toHaveBeenCalledTimes(1);
  });

  it("parses a sheet-mode answer into a labels assessment", async () => {
    const chat = world({ content: '{"labels":["bug","docs"],"rationale":"two"}' }).chat;
    const assessment = await assess(
      input({ chat, evidence: { ...input().evidence, sheet: new Map([["bug", "a bug"]]) } }),
    );
    expect(assessment).toEqual({ intent: "labels", labels: ["bug", "docs"], rationale: "two" });
  });

  it("parses a no-sheet answer into a comment assessment", async () => {
    const chat = world({ content: '{"classification":"a bug","rationale":"Because."}' }).chat;
    const assessment = await assess(input({ chat }));
    expect(assessment).toEqual({
      intent: "comment",
      classification: "a bug",
      rationale: "Because.",
    });
  });

  it("forwards the model, the messages and the configured model name to the chat", async () => {
    const chat = world({ content: '{"labels":[],"rationale":""}' }).chat;
    await assess(
      input({ chat, model: "custom-model", evidence: { ...input().evidence, sheet: new Map() } }),
    );
    const request = chat.complete.mock.calls[0]?.[0];
    if (request === undefined) throw new Error("assess made no chat call");
    expect(request.model).toBe("custom-model");
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[1]?.role).toBe("user");
  });

  it("frames the untrusted title and body as evidence in the user message", async () => {
    const chat = world({ content: '{"labels":[],"rationale":""}' }).chat;
    await assess(input({ chat, evidence: { ...input().evidence, sheet: new Map() } }));
    const request = chat.complete.mock.calls[0]?.[0];
    if (request === undefined) throw new Error("assess made no chat call");
    const user = request.messages[1]?.content;
    expect(user).toContain("[evidence:title]");
    expect(user).toContain("Import fails");
    expect(user).toContain("[evidence:thread-body]");
    expect(user).toContain("Steps to reproduce.");
  });

  it("adds diff-stats evidence for a pull request with files", async () => {
    const chat = world({ content: '{"labels":[],"rationale":""}' }).chat;
    await assess(
      input({
        chat,
        evidence: {
          ...input().evidence,
          thread: { ...THREAD, type: "pr" },
          files: [{ filename: "a.mjs", status: "modified", additions: 5, deletions: 3 }],
          sheet: new Map(),
        },
      }),
    );
    const request = chat.complete.mock.calls[0]?.[0];
    if (request === undefined) throw new Error("assess made no chat call");
    const user = request.messages[1]?.content;
    expect(user).toContain("[evidence:diff-stats]");
    expect(user).toContain("a.mjs");
  });

  it("propagates a provider error", async () => {
    const boom = new Error("provider down");
    const chat = world({ error: boom }).chat;
    await expect(
      assess(input({ chat, evidence: { ...input().evidence, sheet: new Map() } })),
    ).rejects.toThrow("provider down");
  });

  it("propagates a malformed answer as the parser's error", async () => {
    const chat = world({ content: "not json" }).chat;
    await expect(
      assess(input({ chat, evidence: { ...input().evidence, sheet: new Map() } })),
    ).rejects.toThrow();
  });
});

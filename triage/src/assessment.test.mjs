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
  createdAt: "2026-01-02T03:04:05Z",
  creator: "someauthor",
  state: "open",
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
      quality: null,
      forgeSearch: null,
      eventAction: "opened",
      pr: null,
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
    expect(assessment).toEqual({
      intent: "labels",
      labels: ["bug", "docs"],
      rationale: "two",
      issuedBy: "triage",
      version: 1,
      confidence: null,
      dimensions: {
        classification: undefined,
        quality: undefined,
        relationships: undefined,
        priority: undefined,
        pr: undefined,
      },
    });
  });

  it("parses a no-sheet answer into a comment assessment", async () => {
    const chat = world({ content: '{"classification":"a bug","rationale":"Because."}' }).chat;
    const assessment = await assess(input({ chat }));
    expect(assessment).toEqual({
      intent: "comment",
      classification: "a bug",
      rationale: "Because.",
      issuedBy: "triage",
      version: 1,
      confidence: null,
      dimensions: {
        classification: undefined,
        quality: undefined,
        relationships: undefined,
        priority: undefined,
        pr: undefined,
      },
    });
  });

  it("stamps the Assessment contract shape on every judgement", async () => {
    const chat = world({ content: '{"labels":["bug"],"rationale":"one"}' }).chat;
    const assessment = await assess(
      input({ chat, evidence: { ...input().evidence, sheet: new Map([["bug", "a bug"]]) } }),
    );
    expect(assessment.issuedBy).toBe("triage");
    expect(typeof assessment.version).toBe("number");
    // Advisory strength slot — never a probability-of-correctness in this
    // contract; empty (null) until an evaluator (PR-C/D) populates it.
    expect(assessment.confidence).toBeNull();
    const dimensions = /** @type {import("./assessment.mjs").AssessmentDimensions} */ (
      assessment.dimensions
    );
    expect(Object.keys(dimensions).sort()).toEqual([
      "classification",
      "pr",
      "priority",
      "quality",
      "relationships",
    ]);
  });

  it("populates the pr dimension for a pull request, keeping it empty for an issue", async () => {
    const prThread = { ...THREAD, type: "pr" };
    const prEvidence = {
      ...input().evidence,
      thread: prThread,
      files: [{ filename: "src/index.ts", status: "modified", additions: 4, deletions: 1 }],
      pr: {
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        hasConflicts: false,
        base: { ref: "main", sha: "b" },
        head: { ref: "h", sha: "a" },
        checks: { total: 1, byConclusion: { success: 1 } },
        reviewRequested: [],
        reviews: [],
      },
    };
    const chat = world({
      content:
        '{"classification":"x","rationale":"r","pr":{"scope":{"obviousMismatch":false},"readiness":{"descriptionQuality":"good"},"notes":[]}}',
    }).chat;

    const prAssessment = await assess(input({ chat, evidence: prEvidence }));
    const prDimension = /** @type {any} */ (prAssessment.dimensions).pr;
    expect(prDimension.facts.scope.fileCount).toBe(1);
    expect(prDimension.facts.readiness.ready).toBe(true);
    expect(prDimension.judgement.scope.obviousMismatch).toBe(false);
    expect(prDimension.judgement.readiness.descriptionQuality).toBe("good");

    const issueAssessment = await assess(
      input({
        chat: world({ content: '{"classification":"x","rationale":"r"}' }).chat,
        evidence: input().evidence,
      }),
    );
    expect(/** @type {any} */ (issueAssessment.dimensions).pr).toBeUndefined();
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

  it("parses the dimensions on a sheet-mode issue run", async () => {
    const chat = world({
      content: JSON.stringify({
        labels: ["bug"],
        rationale: "r",
        dimensions: {
          quality: { completeness: "missing-evidence" },
          priority: { severity: "high" },
        },
      }),
    }).chat;
    const assessment = await assess(
      input({
        chat,
        evidence: {
          ...input().evidence,
          sheet: new Map([["bug", "gloss"]]),
          thread: { ...THREAD, type: "issue" },
        },
      }),
    );
    expect(assessment.dimensions).toMatchObject({
      quality: { completeness: "missing-evidence" },
      priority: { severity: "high" },
    });
  });

  it("leaves the dimensions empty on a PR run even with a sheet", async () => {
    const chat = world({
      content: JSON.stringify({
        labels: ["bug"],
        rationale: "r",
        dimensions: { priority: { severity: "high" } },
      }),
    }).chat;
    const assessment = await assess(
      input({
        chat,
        evidence: {
          ...input().evidence,
          sheet: new Map([["bug", "gloss"]]),
          thread: { ...THREAD, type: "pr" },
        },
      }),
    );
    expect(assessment.dimensions).toMatchObject({
      quality: undefined,
      priority: undefined,
    });
  });

  it("carries empty dimensions on a no-sheet run", async () => {
    const chat = world({ content: '{"classification":"a bug","rationale":"r"}' }).chat;
    const assessment = await assess(
      input({
        chat,
        evidence: { ...input().evidence, sheet: null },
      }),
    );
    expect(assessment.intent).toBe("comment");
    expect(assessment.dimensions).toMatchObject({ priority: undefined });
  });
});

describe("assess — the one retry a fumbled answer earns (#261)", () => {
  /**
   * A chat stub that answers from a scripted sequence: attempt one, then
   * attempt two. What is pinned is how many times the question was asked.
   *
   * @param {string[]} answers the answer for each attempt, in order
   */
  function scriptedChat(answers) {
    let attempt = 0;
    return {
      complete: vi.fn(async () => {
        const content = answers[Math.min(attempt, answers.length - 1)];
        attempt += 1;
        return { content, toolCalls: [], finishReason: "stop" };
      }),
    };
  }

  it("asks once more after an empty answer and proceeds on the retry", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const chat = scriptedChat(["", '{"labels":["bug"],"rationale":"the retry answered"}']);
    const assessment = await assess(
      input({ chat, evidence: { ...input().evidence, sheet: new Map([["bug", "a bug"]]) } }),
    );
    expect(assessment).toMatchObject({ intent: "labels", labels: ["bug"] });
    expect(chat.complete).toHaveBeenCalledTimes(2);
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes(
          "triage: the model's answer was unusable (the model's answer was empty) — asking once more",
        ),
      ),
    ).toBe(true);
    log.mockRestore();
  });

  it("asks once more after a prose answer; a second fumble names both attempts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const chat = scriptedChat(["just prose, twice", "still just prose"]);
    await expect(
      assess(
        input({ chat, evidence: { ...input().evidence, sheet: new Map([["bug", "a bug"]]) } }),
      ),
    ).rejects.toThrow("the model's answer holds no JSON object (after 2 attempts)");
    expect(chat.complete).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("never re-asks an answer that parsed but missed its contract", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const chat = scriptedChat(['{"labels":"not-an-array"}']);
    await expect(
      assess(
        input({ chat, evidence: { ...input().evidence, sheet: new Map([["bug", "a bug"]]) } }),
      ),
    ).rejects.toThrow("the model's answer has no labels array");
    // A contract miss is a decision, not a fumble: one ask, no retry.
    expect(chat.complete).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some((call) => String(call[0]).includes("asking once more"))).toBe(false);
    log.mockRestore();
  });
});

describe("assess — provider truncation (finish_reason: length, #448)", () => {
  /**
   * A chat stub answering from a scripted sequence of contents, each with
   * its own finish reason — the shape a truncating provider produces.
   *
   * @param {{ content: string, finishReason: string }[]} script
   */
  function truncatingChat(script) {
    let cursor = 0;
    return {
      complete: vi.fn(async () => {
        const next = script[Math.min(cursor, script.length - 1)];
        cursor++;
        return {
          content: next?.content ?? "",
          toolCalls: [],
          finishReason: next?.finishReason ?? "stop",
        };
      }),
    };
  }

  it("fails a no-sheet truncated answer before parsing — the prefix never becomes a classification", async () => {
    // The object closes, so extractObject would hand the prefix to the
    // parser; with the guard it must never get there.
    const chat = truncatingChat([
      {
        content: '{"classification":"a bug whose rationale was cut"}{"dimen',
        finishReason: "length",
      },
    ]);
    await expect(
      assess(input({ chat, evidence: { ...input().evidence, sheet: null } })),
    ).rejects.toThrow(
      "the provider truncated its response (finish_reason: length) — " +
        "the model's output is incomplete and cannot be judged as a triage answer",
    );
    // Truncation earns no re-ask: the same ask would cut the same answer.
    expect(chat.complete).toHaveBeenCalledTimes(1);
  });

  it("fails a truncated answer whose JSON5 was cut mid-string — before the doomed re-ask", async () => {
    const chat = truncatingChat([
      {
        content: '{"labels":["bug"],"rationale":"the buffer ran out mid-sent',
        finishReason: "length",
      },
    ]);
    await expect(
      assess(
        input({ chat, evidence: { ...input().evidence, sheet: new Map([["bug", "a bug"]]) } }),
      ),
    ).rejects.toThrow(/truncated its response \(finish_reason: length\)/);
    // The shape-failure re-ask (#261) must not fire for truncation: one ask.
    expect(chat.complete).toHaveBeenCalledTimes(1);
  });

  it("fails truncation inside the re-ask window too — a stop-fumble then a length-cut", async () => {
    const chat = truncatingChat([
      { content: "just prose, not json", finishReason: "stop" },
      { content: '{"classification":"bug', finishReason: "length" },
    ]);
    await expect(
      assess(input({ chat, evidence: { ...input().evidence, sheet: null } })),
    ).rejects.toThrow(
      "the provider truncated the re-asked response (finish_reason: length) — " +
        "the model's output is incomplete and cannot be judged as a triage answer",
    );
    expect(chat.complete).toHaveBeenCalledTimes(2);
  });

  it("keeps the shape-failure re-ask for a non-truncated bad shape — stop, not length", async () => {
    // The control: the same prose fumble with finish_reason stop still earns
    // its one redelivery, and a good second answer is judged normally.
    const chat = truncatingChat([
      { content: "", finishReason: "stop" },
      {
        content: '{"classification":"a bug","rationale":"the retry answered"}',
        finishReason: "stop",
      },
    ]);
    const assessment = await assess(
      input({ chat, evidence: { ...input().evidence, sheet: null } }),
    );
    expect(assessment).toMatchObject({ intent: "comment", classification: "a bug" });
    expect(chat.complete).toHaveBeenCalledTimes(2);
  });
});

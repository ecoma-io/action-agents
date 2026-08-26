// Tests for the agent loop, run against a scripted chat stub and a real
// tool registry over a tiny tree. Pinned here: the accounting rules that
// make two implementations agree — natural stop vs bound, the single
// tools-withheld finalisation, every call answered even past the ceiling,
// compaction firing on the estimate, and fatal wire defects ending the run.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createEvidence } from "#core/untrusted.mjs";
import { createWorkspace } from "#core/workspace.mjs";

import { estimateTokens, runLoop } from "./loop.mjs";
import { createTools } from "./tools.mjs";

/** @typedef {import("#core/chat.mjs").ChatMessage} ChatMessage */
/** @typedef {import("#core/chat.mjs").ChatToolCall} ChatToolCall */

/** @type {string} */
let root;
/** @type {ReturnType<typeof createWorkspace>} */
let workspace;
const evidence = createEvidence(() => "aaaabbbbccccdddd");

beforeAll(() => {
  root = mkdtempSync(p.join(tmpdir(), "loop-test-"));
  mkdirSync(p.join(root, "src"));
  writeFileSync(p.join(root, "src", "a.mjs"), "alpha\n");
  workspace = createWorkspace({ root });
});

/**
 * A chat stub that replays a script of responses; each request is recorded.
 *
 * @param {Array<{ content: string, toolCalls?: ChatToolCall[] }>} script
 */
function scriptedChat(script) {
  /** @type {{ messages: ChatMessage[], tools: unknown }[]} */
  const requests = [];
  let cursor = 0;
  return {
    requests,
    /** @param {{ messages: ChatMessage[], tools?: unknown }} request */
    complete: async ({ messages, tools }) => {
      requests.push({ messages, tools });
      const next = script[Math.min(cursor, script.length - 1)];
      cursor++;
      if (next === undefined) throw new Error("script exhausted");
      if (cursor > script.length) throw new Error("the loop asked beyond its script");
      return {
        content: next.content,
        toolCalls: next.toolCalls ?? [],
        finishReason: next.toolCalls !== undefined ? "tool_calls" : "stop",
      };
    },
  };
}

/**
 * @param {{ id?: string, name?: string, argumentsJson?: string }} [over]
 * @returns {ChatToolCall}
 */
function readCall(over = {}) {
  return {
    id: over.id ?? "c1",
    name: over.name ?? "read_file",
    arguments: over.argumentsJson ?? JSON.stringify({ path: "src/a.mjs" }),
  };
}

/** @type {ChatMessage[]} */
const BASE_MESSAGES = [
  { role: "system", content: "system contract" },
  { role: "user", content: "task + evidence" },
];

function toolsForRoot() {
  return createTools({ workspace, evidence, ignore: [] });
}

describe("turn accounting", () => {
  it("returns a natural stop as the candidate, unbounded", async () => {
    const chat = scriptedChat([{ content: '{"findings":[],"summary":"done"}' }]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
    });
    expect(outcome.naturalStopped).toBe(true);
    expect(outcome.bound).toBeUndefined();
    expect(outcome.candidate).toContain('"summary":"done"');
    expect(outcome.readingTurns).toBe(0);
  });

  it("executes tool calls, feeds results back, and keeps the transcript well-formed", async () => {
    const chat = scriptedChat([
      {
        content: "",
        toolCalls: [
          readCall(),
          readCall({ id: "c2", name: "search", argumentsJson: '{"query":"alpha"}' }),
        ],
      },
      { content: '{"findings":[],"summary":"s"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 5,
      contextWindow: 128_000,
    });

    expect(outcome.toolCalls).toBe(2);
    const second = chat.requests[1];
    const transcript = second?.messages ?? [];
    const toolMessages = transcript.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain("[evidence:aaaabbbbccccdddd read-file]");
    // The assistant turn carrying calls precedes its answers.
    const assistantIndex = transcript.findIndex((m) => m.role === "assistant");
    const firstToolIndex = transcript.findIndex((m) => m.role === "tool");
    expect(assistantIndex).toBeLessThan(firstToolIndex);

    // The finalisation-free path never withholds tools.
    expect(second?.tools).toBeDefined();
  });

  it("answers every call in a response, budget or not — our own wire stays valid", async () => {
    const chat = scriptedChat([
      {
        content: "",
        toolCalls: [
          readCall({ id: "a" }),
          readCall({ id: "b", argumentsJson: '{"path":"nope.txt"}' }),
          readCall({ id: "c" }),
          readCall({ id: "d" }),
        ],
      },
      { content: "{}" },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 3,
      contextWindow: 128_000,
      limits: { maxToolCalls: 2 },
    });

    expect(outcome.bound).toBe("tool-calls");
    const last = chat.requests.at(-1)?.messages ?? [];
    const answers = last.filter((m) => m.role === "tool");
    expect(answers).toHaveLength(4); // every id answered
    expect(answers[2]?.content).toMatch(/budget was spent/);
    expect(answers[3]?.content).toMatch(/budget was spent/);
    // And the finalisation request carried no tools at all.
    expect(chat.requests.at(-1)?.tools).toBeUndefined();
  });
});

describe("reading bounds and finalisation", () => {
  it("finalises once, tools withheld, when max-turns fires", async () => {
    let turn = 0;
    /** @type {Array<{ content: string, toolCalls?: ChatToolCall[] }>} */
    const script = [
      { content: "", toolCalls: [readCall()] },
      { content: "", toolCalls: [readCall()] },
    ];
    const chat = {
      /** @type {{ messages: ChatMessage[], tools: unknown }[]} */
      requests: [],
      /** @param {{ messages: ChatMessage[], tools?: unknown }} request */
      complete: async ({ messages, tools }) => {
        chat.requests.push({ messages, tools });
        if (turn < script.length) {
          const step = script[turn];
          turn++;
          return {
            content: step?.content ?? "",
            toolCalls: step?.toolCalls ?? [],
            finishReason: "",
          };
        }
        return { content: '{"findings":[],"summary":"partial"}', toolCalls: [], finishReason: "" };
      },
    };

    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 2,
      contextWindow: 128_000,
    });

    expect(outcome.naturalStopped).toBe(false);
    expect(outcome.bound).toBe("max-turns");
    expect(outcome.candidate).toContain("partial");
    const finalRequest = chat.requests.at(-1);
    expect(finalRequest?.tools).toBeUndefined();
    expect(finalRequest?.messages.at(-1)?.content).toMatch(/budget is exhausted/);
    expect(outcome.log.some((line) => line.includes("max-turns"))).toBe(true);
  });
});

describe("compaction", () => {
  it("replaces history with the state inventory when the estimate crosses 80%", async () => {
    // One big file read pushes the wrapped result past 80% of a 1000-token
    // window (~800 estimated tokens ≈ 3200 ASCII chars).
    writeFileSync(p.join(root, "src", "big.mjs"), "y".repeat(4000) + "\n");
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall({ argumentsJson: '{"path":"src/big.mjs"}' })] },
      { content: '{"findings":[],"summary":"after compact"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 4,
      contextWindow: 1000,
    });

    expect(outcome.log.some((line) => line.includes("compacted"))).toBe(true);
    const final = chat.requests.at(-1)?.messages ?? [];
    // System + task kept verbatim; everything later collapsed to ONE state
    // message — raw evidence and the model's prose are gone from context.
    expect(final).toHaveLength(3);
    expect(final[0]?.content).toBe("system contract");
    expect(JSON.stringify(final)).not.toContain("[evidence:");
    expect(final[2]?.content).toContain("[state inventory]");
    expect(final[2]?.content).toContain("files read:");
    expect(final[2]?.content).toContain("src/big.mjs");
  });

  it("returns the post-compaction transcript so reaskFinalAnswer does not exceed the window", async () => {
    // Regression for REVIEW-001: conclude() used to capture transcript by
    // value before ask() compacted it, sending the pre-compaction array to
    // reaskFinalAnswer and blowing past the context window.
    writeFileSync(p.join(root, "src", "big.mjs"), "y".repeat(4000) + "\n");
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall({ argumentsJson: '{"path":"src/big.mjs"}' })] },
      { content: '{"findings":[],"summary":"partial"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 1,
      contextWindow: 1000,
    });

    // The transcript returned should be the compacted one (system + task + state),
    // not the pre-compaction one (which would contain the large evidence block).
    const hasEvidence = outcome.transcript.some(
      (m) => typeof m.content === "string" && m.content.includes("[evidence:"),
    );
    expect(hasEvidence).toBe(false);
    // The state inventory message should be present.
    const hasState = outcome.transcript.some(
      (m) => typeof m.content === "string" && m.content.includes("[state inventory]"),
    );
    expect(hasState).toBe(true);
  });
});

describe("fatal wire defects", () => {
  it("end the run when arguments were never valid JSON — provider failure, not manners", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall({ argumentsJson: "{broken" })] },
    ]);
    await expect(
      runLoop({
        chat: /** @type {any} */ (chat),
        model: "m",
        tools: toolsForRoot(),
        messages: BASE_MESSAGES,
        maxTurns: 3,
        contextWindow: 128_000,
      }),
    ).rejects.toThrow(/wire contract is broken/);
  });
});

describe("estimateTokens", () => {
  it("counts bytes÷4 for ASCII and bytes÷1.5 above U+2E80 — the spec formula, biased safe", () => {
    const ascii = estimateTokens([{ role: "user", content: "abcd" }]);
    expect(ascii).toBe(1);
    // Four CJK chars at 3 UTF-8 bytes each: 12 ÷ 1.5 = 8.
    const cjk = estimateTokens([{ role: "user", content: "\u4e00\u4e01\u4e02\u4e03" }]);
    expect(cjk).toBe(8);
    // Astral chars cost their full byte weight too.
    const emoji = estimateTokens([{ role: "user", content: "\u{1F600}" }]); // 4 bytes
    expect(emoji).toBe(3);
  });

  it("counts tool-call arguments the wire will echo back", () => {
    const withCall = estimateTokens([
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"x"}' }],
      },
    ]);
    expect(withCall).toBeGreaterThan(0);
  });
});

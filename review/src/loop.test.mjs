// Tests for the agent loop, run against a scripted chat stub and a real
// tool registry over a tiny tree. Pinned here: the accounting rules that
// make two implementations agree — natural stop vs bound, the single
// tools-withheld finalisation, every call answered even past the ceiling,
// compaction firing on the estimate, and fatal wire defects ending the run.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { createEvidence } from "#core/untrusted.mjs";
import { createWorkspace } from "#core/workspace.mjs";

import { canConcludeReview } from "./coverage.mjs";
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

/**
 * How many code-authored uncovered-files notices the transcript carries —
 * the once-guard's observable.
 *
 * @param {ChatMessage[]} messages
 * @returns {number}
 */
function noticeCount(messages) {
  return messages.filter(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.includes("[coverage check]"),
  ).length;
}

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
    // No tool turn happened, so the machine never left orient and the log
    // holds nothing — an answer at once is not a phase change.
    expect(outcome.phaseLog).toEqual([]);
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

describe("the uncovered-files notice before a natural stop (#424)", () => {
  it("one natural stop with unread files sends one notice, offers the tools again, and the loop continues", async () => {
    // One read covers src/a.mjs; the stop leaves src/b.mjs unread; the
    // notice goes out; the model goes and reads it before answering.
    writeFileSync(p.join(root, "src", "b.mjs"), "beta\n");
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall()] },
      { content: '{"findings":[],"summary":"stopped after one read"}' },
      { content: "", toolCalls: [readCall({ id: "c2", argumentsJson: '{"path":"src/b.mjs"}' })] },
      { content: '{"findings":[],"summary":"complete now"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs", "src/b.mjs"],
    });
    expect(outcome.naturalStopped).toBe(true);
    expect(outcome.bound).toBeUndefined();
    // The loop continued past the notice and covered the remaining file.
    expect(outcome.coverage).toEqual({
      covered: ["src/a.mjs", "src/b.mjs"],
      uncovered: [],
      total: 2,
    });
    expect(outcome.candidate).toContain("complete now");
    // Exactly one notice, persisted in the transcript that followed it.
    expect(noticeCount(outcome.transcript)).toBe(1);
    // The request sent right after the notice carried it and the tools.
    const afterNotice = chat.requests[2];
    const notice = (afterNotice?.messages ?? []).find(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("[coverage check]"),
    );
    expect(notice?.content).toContain("1 of 2");
    expect(notice?.content).toContain("src/b.mjs");
    // The notice lists files; it quotes none of the tree's bytes (the
    // captured content of src/a.mjs is "alpha\n").
    expect(notice?.content).not.toContain("alpha");
    // The tools were offered again — the notice never withholds them.
    const offered = /** @type {{ name: string }[] | undefined} */ (afterNotice?.tools);
    expect((offered ?? []).map((tool) => tool.name)).toContain("read_file");
    // The loop's own account of the nudge is in the run log.
    expect(outcome.log.some((line) => line.includes("notice went out once"))).toBe(true);
  });

  it("a second natural stop with coverage still incomplete ends the run — the notice never re-asks", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall()] },
      { content: '{"findings":[],"summary":"first stop"}' },
      { content: '{"findings":[],"summary":"second stop"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs", "src/b.mjs"],
    });
    expect(outcome.naturalStopped).toBe(true);
    expect(outcome.coverage.uncovered).toEqual(["src/b.mjs"]);
    expect(outcome.candidate).toContain("second stop");
    // One notice, then the stop was accepted: no nudge loop.
    expect(noticeCount(outcome.transcript)).toBe(1);
    expect(chat.requests).toHaveLength(3);
  });

  it("a bound exit never sends the notice — the bound wins", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall()] },
      { content: "", toolCalls: [readCall({ id: "c2" })] },
      { content: '{"findings":[],"summary":"budget spent"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 2,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs", "src/b.mjs"],
    });
    expect(outcome.bound).toBe("max-turns");
    expect(outcome.naturalStopped).toBe(false);
    // Finalisation with the tools withheld, exactly as before the notice
    // existed — and not one coverage message anywhere on the wire.
    expect(chat.requests.at(-1)?.tools).toBeUndefined();
    for (const request of chat.requests) {
      expect(noticeCount(request.messages)).toBe(0);
    }
  });

  it("complete coverage never sends the notice — the natural stop is accepted as before", async () => {
    writeFileSync(p.join(root, "src", "b.mjs"), "beta\n");
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall()] },
      { content: "", toolCalls: [readCall({ id: "c2", argumentsJson: '{"path":"src/b.mjs"}' })] },
      { content: '{"findings":[],"summary":"complete without help"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs", "src/b.mjs"],
    });
    expect(outcome.naturalStopped).toBe(true);
    expect(outcome.coverage.uncovered).toEqual([]);
    expect(chat.requests).toHaveLength(3);
    for (const request of chat.requests) {
      expect(noticeCount(request.messages)).toBe(0);
    }
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
    // System + task kept verbatim; raw evidence is gone from context. The
    // scripted turns carry no prose, so nothing else survives — one state
    // message replaces the rest.
    expect(final).toHaveLength(3);
    expect(final[0]?.content).toBe("system contract");
    expect(JSON.stringify(final)).not.toContain("[evidence:");
    expect(final[2]?.content).toContain("[state inventory]");
    expect(final[2]?.content).toContain("files read:");
    expect(final[2]?.content).toContain("src/big.mjs");
  });

  it("keeps the model's own analysis prose across compaction, verbatim", async () => {
    writeFileSync(p.join(root, "src", "big.mjs"), "y".repeat(4000) + "\n");
    const analysis =
      "the guard at src/big.mjs:1 never bounds the index — this is the finding to verify.";
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall({ id: "c1", argumentsJson: '{"path":"src/big.mjs"}' })] },
      {
        content: analysis,
        toolCalls: [readCall({ id: "c2", argumentsJson: '{"path":"src/big.mjs"}' })],
      },
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
    // The analysis prose survives verbatim with its toolCalls payload
    // stripped: the results those calls produced ride in the state message,
    // and a tool call without its answers would break the wire.
    expect(final[2]).toEqual({ role: "assistant", content: analysis });
    expect(JSON.stringify(final)).not.toContain("[evidence:");
    expect(final[3]?.content).toContain("[state inventory]");
    expect(final[3]?.content).toContain("src/big.mjs");
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

describe("coverage accounting", () => {
  it("reports the empty shape when the caller supplied no expected set", async () => {
    const chat = scriptedChat([{ content: '{"findings":[],"summary":"done"}' }]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
    });
    expect(outcome.coverage).toEqual({ covered: [], uncovered: [], total: 0 });
  });

  it("reports every expected file uncovered when the natural stop read none — and hears the notice once", async () => {
    const chat = scriptedChat([
      { content: '{"findings":[],"summary":"done"}' },
      { content: '{"findings":[],"summary":"still unread"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs", "src/b.mjs"],
    });
    expect(outcome.coverage).toEqual({
      covered: [],
      uncovered: ["src/a.mjs", "src/b.mjs"],
      total: 2,
    });
    // The stop was heard once and then accepted: the second stop ends the
    // run exactly as the first would have before the notice existed.
    expect(noticeCount(outcome.transcript)).toBe(1);
    expect(outcome.naturalStopped).toBe(true);
  });

  it("counts a ./spelled read_file argument as covering its diff-spelled path", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall({ argumentsJson: '{"path":"./src/a.mjs"}' })] },
      { content: '{"findings":[],"summary":"s"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs"],
    });
    expect(outcome.coverage.covered).toEqual(["src/a.mjs"]);
    expect(outcome.coverage.uncovered).toEqual([]);
  });

  it("reports the reads the ledger holds at a bound exit", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall()] },
      { content: '{"findings":[],"summary":"done"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 1,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs", "src/b.mjs"],
    });
    expect(outcome.bound).toBe("max-turns");
    expect(outcome.coverage.covered).toEqual(["src/a.mjs"]);
    expect(outcome.coverage.total).toBe(2);
  });
  it("a refused read never covers its path — coverage counts captured bytes", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall({ argumentsJson: '{"path":"src/missing.mjs"}' })] },
      { content: '{"findings":[],"summary":"s"}' },
      { content: '{"findings":[],"summary":"s again"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      expectedPaths: ["src/missing.mjs"],
    });
    expect(outcome.coverage.covered).toEqual([]);
    expect(outcome.coverage.uncovered).toEqual(["src/missing.mjs"]);
    // The refused attempt bought the run one notice, not two: the second
    // stop was accepted with the file still unread.
    expect(noticeCount(outcome.transcript)).toBe(1);
  });

  it("a read of a path past the display cap still covers at its full spelling", async () => {
    const rel = `src/${"d".repeat(120)}/${"e".repeat(120)}/${"f".repeat(120)}/x.mjs`;
    mkdirSync(p.join(root, "src", "d".repeat(120), "e".repeat(120), "f".repeat(120)), {
      recursive: true,
    });
    writeFileSync(p.join(root, rel), "content\n");
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall({ argumentsJson: JSON.stringify({ path: rel }) })] },
      { content: '{"findings":[],"summary":"s"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      expectedPaths: [rel],
    });
    expect(outcome.coverage.covered).toEqual([rel]);
  });

  it("the state inventory truncates a long read path for display only", async () => {
    const rel = `src/${"d".repeat(120)}/${"e".repeat(120)}/${"f".repeat(120)}/x.mjs`;
    mkdirSync(p.join(root, "src", "d".repeat(120), "e".repeat(120), "f".repeat(120)), {
      recursive: true,
    });
    writeFileSync(p.join(root, rel), "y".repeat(4000) + "\n");
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall({ argumentsJson: JSON.stringify({ path: rel }) })] },
      { content: '{"findings":[],"summary":"after compact"}' },
    ]);
    await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 4,
      contextWindow: 1000,
      expectedPaths: [rel],
    });
    const state = chat.requests.at(-1)?.messages[2]?.content ?? "";
    expect(state).toContain(JSON.stringify(rel).slice(0, 300)); // the bounded spelling is shown
    expect(state).not.toContain(rel); // the full path never rides in the message
  });

  it("zero captured bytes leave the expected set uncovered — the coverage gate refuses at high", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall({ argumentsJson: '{"path":"src/missing.mjs"}' })] },
      { content: '{"findings":[],"summary":"s"}' },
      { content: '{"findings":[],"summary":"s once more"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      expectedPaths: ["src/missing.mjs"],
      strictness: "high",
    });
    expect(canConcludeReview(outcome.coverage, "high")).toBe(false);
  });
});

describe("review phases", () => {
  /**
   * @param {{ tools: unknown } | undefined} request
   * @returns {string[]}
   */
  function offered(request) {
    const tools = /** @type {{ name: string }[] | undefined} */ (request?.tools);
    return (tools ?? []).map((tool) => tool.name);
  }

  it("offers the orient tools first, the wider registry after the first turn", async () => {
    const chat = scriptedChat([
      {
        content: "",
        toolCalls: [readCall({ name: "list_files", argumentsJson: '{"path":"src"}' })],
      },
      { content: "", toolCalls: [readCall()] },
      { content: '{"findings":[],"summary":"s"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 5,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs"],
    });

    expect(offered(chat.requests[0])).toEqual(["list_files", "search"]);
    expect(offered(chat.requests[1])).toEqual(["read_file", "list_files", "search"]);
    expect(offered(chat.requests[2])).toEqual(["read_file", "list_files", "search"]);
    expect(outcome.log).toContain("phase: orient → investigate");
    expect(outcome.log).toContain("phase: investigate → verify");
    expect(outcome.phase).toBe("verify");
    expect(outcome.phaseLog).toEqual([
      { from: "orient", to: "investigate" },
      { from: "investigate", to: "verify" },
    ]);
  });

  it("the offer is the gate: the registry itself never grows or guards", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall()] },
      { content: '{"findings":[],"summary":"s"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 5,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs"],
    });

    // read_file was not offered in orient — and a provider that called it
    // anyway would find the registry unchanged. Narrowing binds the offer.
    expect(offered(chat.requests[0])).toEqual(["list_files", "search"]);
    expect(outcome.toolCalls).toBe(1);
    expect(outcome.coverage.covered).toEqual(["src/a.mjs"]);
  });

  it("finalises with the machine in conclude when the bound fires at medium", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall()] },
      { content: '{"findings":[],"summary":"done"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs"],
      strictness: "medium",
      limits: { maxToolCalls: 1 },
    });

    expect(outcome.bound).toBe("tool-calls");
    expect(outcome.phase).toBe("conclude");
    expect(chat.requests.at(-1)?.tools).toBeUndefined();
    // The cap fired before the wider registry was ever offered, so the
    // machine finalised straight out of orient.
    expect(outcome.phaseLog.at(-1)).toEqual({ from: "orient", to: "conclude" });
  });

  it("holds the machine out of conclude under strict policy with uncovered files — the review still ends", async () => {
    const chat = scriptedChat([
      {
        content: "",
        toolCalls: [readCall({ name: "list_files", argumentsJson: '{"path":"src"}' })],
      },
      { content: '{"findings":[],"summary":"partial"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs", "src/b.mjs"],
      strictness: "high",
      limits: { maxToolCalls: 1 },
    });

    expect(outcome.bound).toBe("tool-calls");
    expect(outcome.phase).not.toBe("conclude");
    expect(outcome.log.some((line) => line.includes("holds the review in investigate"))).toBe(true);
    // The code-owned exit still finalised, tools withheld — #69 semantics
    // and the single finalisation are untouched.
    expect(outcome.naturalStopped).toBe(false);
    expect(chat.requests.at(-1)?.tools).toBeUndefined();
  });

  it("compaction renders the live phase into the state inventory", async () => {
    writeFileSync(p.join(root, "src", "huge.mjs"), "y".repeat(4000) + "\n");
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall({ argumentsJson: '{"path":"src/huge.mjs"}' })] },
      { content: '{"findings":[],"summary":"after compact"}' },
    ]);
    await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 4,
      contextWindow: 1000,
      expectedPaths: ["src/huge.mjs"],
    });

    const final = chat.requests.at(-1)?.messages ?? [];
    expect(final[2]?.content).toContain("current phase: investigate");
  });
});

describe("loop accounting facts", () => {
  it("carries evidenceBytes and the enforced caps on a natural-stop outcome", async () => {
    const chat = scriptedChat([{ content: '{"findings":[],"summary":"done"}' }]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 8,
      contextWindow: 128_000,
    });
    expect(outcome.naturalStopped).toBe(true);
    expect(typeof outcome.evidenceBytes).toBe("number");
    expect(outcome.maxTurns).toBe(8);
    expect(outcome.maxToolCalls).toBeGreaterThan(0);
    expect(outcome.maxEvidenceBytes).toBeGreaterThan(0);
  });

  it("carries evidenceBytes and the enforced caps on a bound-fired outcome", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall()] },
      { content: "", toolCalls: [readCall({ id: "c2" })] },
      { content: '{"findings":[],"summary":"concluded"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 2,
      contextWindow: 128_000,
    });
    expect(outcome.bound).toBe("max-turns");
    expect(outcome.naturalStopped).toBe(false);
    expect(typeof outcome.evidenceBytes).toBe("number");
    expect(outcome.evidenceBytes).toBeGreaterThan(0);
    expect(outcome.maxTurns).toBe(2);
    expect(outcome.maxToolCalls).toBeGreaterThan(0);
    expect(outcome.maxEvidenceBytes).toBeGreaterThan(0);
    expect(outcome.readingTurns).toBe(2);
  });

  it("reports evidence accumulating over successive reads", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall()] },
      { content: "", toolCalls: [readCall({ id: "c3" })] },
      { content: '{"findings":[],"summary":"three calls"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 5,
      contextWindow: 128_000,
    });
    // Three complete calls: two reads + one answer. Evidence accrues across
    // the two reading turns but never exceeds the cap (512 KiB default).
    expect(outcome.naturalStopped).toBe(true);
    expect(outcome.readingTurns).toBe(2);
    expect(outcome.evidenceBytes).toBeGreaterThan(0);
    expect(outcome.evidenceBytes).toBeLessThanOrEqual(outcome.maxEvidenceBytes);
  });
});

describe("deletion coverage", () => {
  it("records a deletion's inspection in code — covered with no read on record at all", async () => {
    const chat = scriptedChat([
      { content: '{"findings":[],"summary":"done"}' },
      { content: '{"findings":[],"summary":"still not read"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 5,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs", "lib/gone.mjs"],
      diffInspectedPaths: ["lib/gone.mjs"],
    });
    expect(outcome.naturalStopped).toBe(true);
    expect(outcome.coverage).toEqual({
      covered: ["lib/gone.mjs"],
      uncovered: ["src/a.mjs"],
      total: 2,
    });
  });

  it("a read composes with the code-recorded set — both sides land covered", async () => {
    const chat = scriptedChat([
      { content: "", toolCalls: [readCall()] },
      { content: '{"findings":[],"summary":"read the survivor"}' },
    ]);
    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools: toolsForRoot(),
      messages: BASE_MESSAGES,
      maxTurns: 5,
      contextWindow: 128_000,
      expectedPaths: ["src/a.mjs", "lib/gone.mjs"],
      diffInspectedPaths: ["lib/gone.mjs"],
    });
    expect(outcome.coverage).toEqual({
      covered: ["lib/gone.mjs", "src/a.mjs"],
      uncovered: [],
      total: 2,
    });
  });
});

describe("alias read coverage — resolved path", () => {
  it("counts a read through an intermediate symlink against the resolved inventory path", async () => {
    const tree = mkdtempSync(p.join(tmpdir(), "loop-ledger-"));
    mkdirSync(p.join(tree, "realdir"));
    writeFileSync(p.join(tree, "realdir", "file.mjs"), "content\n");
    symlinkSync(p.join(tree, "realdir"), p.join(tree, "link"), "dir");

    const tools = createTools({
      workspace: createWorkspace({ root: tree }),
      evidence: createEvidence(() => "aaaabbbbccccdddd"),
      ignore: [],
    });
    const chat = scriptedChat([
      {
        content: "",
        toolCalls: [readCall({ argumentsJson: JSON.stringify({ path: "link/file.mjs" }) })],
      },
      { content: '{"findings":[],"summary":"read through the alias"}' },
    ]);

    const outcome = await runLoop({
      chat: /** @type {any} */ (chat),
      model: "m",
      tools,
      messages: BASE_MESSAGES,
      maxTurns: 5,
      contextWindow: 128_000,
      expectedPaths: ["realdir/file.mjs"],
    });

    expect(outcome.naturalStopped).toBe(true);
    expect(outcome.coverage).toEqual({
      covered: ["realdir/file.mjs"],
      uncovered: [],
      total: 1,
    });
  });
});

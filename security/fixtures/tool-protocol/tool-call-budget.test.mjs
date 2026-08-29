// Tool-call and evidence budgets — the loop-level tool-protocol surface.
//
// Attacks:
//   - a model that never stops requesting tool calls → the loop still
//     finalises: exactly MAX_TOOL_CALLS calls execute, the budget-spent
//     instruction is the final ask, tools are withheld there, and the
//     conversation wire stays well-formed across every request
//   - tool answers whose wrapped evidence together crosses
//     MAX_CUMULATIVE_EVIDENCE_BYTES → the loop closes with
//     bound === "evidence" (the run renders this as the Partial posture with
//     the BOUND_REASONS.evidence reason) after a finalisation turn
//   - evidence that stays under the cap → the loop reports a natural stop
//     with no bound
//
// Security property asserted: the loop NEVER runs past its budget no matter
// how relentless the model is — it finalises, withholds tools, and says so.
//
// Deterministic and offline: the chat seam is a scripted stub inside this
// file, the tree lives in a throwaway temp dir and the evidence delimiter is
// injected; no network, no model, no timers.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { after, before, describe, it } from "node:test";

import { createEvidence } from "#core/untrusted.mjs";
import { createWorkspace } from "#core/workspace.mjs";

import {
  MAX_CUMULATIVE_EVIDENCE_BYTES,
  MAX_TOOL_CALLS,
  runLoop,
} from "../../../review/src/loop.mjs";
import { createTools } from "../../../review/src/tools.mjs";

/** @type {string} */
let root;
/** @type {ReturnType<typeof createWorkspace>} */
let workspace;
/** @type {ReturnType<typeof createTools>} */
let tools;

const evidence = createEvidence(() => "aaaabbbbccccdddd");

/** The two messages every run starts from — mirror of review/src/loop.test.mjs. */
const BASE_MESSAGES = [
  { role: "system", content: "system contract" },
  { role: "user", content: "task + evidence" },
];

before(() => {
  root = mkdtempSync(p.join(tmpdir(), "tool-protocol-budget-"));
  workspace = createWorkspace({ root });
  tools = createTools({ workspace, evidence, ignore: [] });
  mkdirSync(p.join(root, "src"));
  writeFileSync(p.join(root, "src", "a.mjs"), "alpha\n");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A chat stub that never stops asking for one more tool call — the
 * "endless loop" model. The loop MUST terminate by its own budget, so this
 * stub answers as many requests as the loop makes.
 *
 * @returns {{ requests: Array<{ messages: import("#core/chat.mjs").ChatMessage[], tools: unknown }>, complete: (input: { messages: import("#core/chat.mjs").ChatMessage[], tools?: unknown }) => Promise<{ content: string, toolCalls: Array<{ id: string, name: string, arguments: string }>, finishReason: string }> }}
 */
function relentlessChat() {
  /** @type {Array<{ messages: import("#core/chat.mjs").ChatMessage[], tools: unknown }>} */
  const requests = [];
  return {
    requests,
    complete: async ({ messages, tools: withTools }) => {
      requests.push({ messages, tools: withTools });
      return {
        content: "",
        toolCalls: [
          {
            id: `c${String(requests.length)}`,
            name: "read_file",
            arguments: JSON.stringify({ path: "src/a.mjs" }),
          },
        ],
        finishReason: "tool_calls",
      };
    },
  };
}

/**
 * A finite chat stub that plays a script and stops. The cursor is clamped so
 * the loop's finalisation ask reads the last scripted answer.
 *
 * @param {Array<{ content: string, toolCalls?: Array<{ id: string, name: string, arguments: string }> }>} script
 * @returns {{ requests: Array<{ messages: import("#core/chat.mjs").ChatMessage[], tools: unknown }> }}
 */
function scriptedChat(script) {
  let cursor = 0;
  /** @type {Array<{ messages: import("#core/chat.mjs").ChatMessage[], tools: unknown }>} */
  const requests = [];
  return {
    requests,
    complete: async ({ messages, tools: withTools }) => {
      requests.push({ messages, tools: withTools });
      const next = script[Math.min(cursor, script.length - 1)];
      cursor++;
      return {
        content: next.content,
        toolCalls: next.toolCalls ?? [],
        finishReason: next.toolCalls !== undefined ? "tool_calls" : "stop",
      };
    },
  };
}

/**
 * Every assistant tool-call turn is answered by exactly as many tool
 * messages, paired by id — the wire stays valid across the whole run.
 *
 * @param {import("#core/chat.mjs").ChatMessage[]} messages
 */
function assertWireValid(messages) {
  const roles = new Set(messages.map((m) => m.role));
  assert.deepEqual([...roles].sort(), ["assistant", "system", "tool", "user"]);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (
      message.role !== "assistant" ||
      message.toolCalls === undefined ||
      message.toolCalls.length === 0
    ) {
      continue;
    }
    for (let j = 0; j < message.toolCalls.length; j++) {
      const answer = messages[i + 1 + j];
      assert.ok(answer !== undefined, "every tool call is followed by its answer");
      assert.equal(answer.role, "tool", "the answer to a call is a tool message");
      assert.equal(
        answer.toolCallId,
        message.toolCalls[j].id,
        "tool answers pair with their calls by id",
      );
    }
  }
}

describe("tool-call budget — the loop always finalises", () => {
  it("an endless tool-call loop finalises at the 200-call ceiling with tools withheld and a valid wire", async () => {
    const chat = relentlessChat();

    const outcome = await runLoop({
      chat,
      model: "m",
      tools,
      messages: BASE_MESSAGES,
      maxTurns: 1000,
      contextWindow: 128_000,
    });

    assert.equal(MAX_TOOL_CALLS, 200, "the tool-call ceiling is frozen at 200");
    assert.equal(outcome.bound, "tool-calls");
    assert.equal(outcome.naturalStopped, false);
    assert.equal(outcome.toolCalls, MAX_TOOL_CALLS, "exactly the ceiling executed");
    assert.equal(
      chat.requests.length,
      MAX_TOOL_CALLS + 1,
      "one finalisation request follows the ceiling",
    );

    const last = chat.requests.at(-1);
    assert.ok(last !== undefined, "the finalisation request exists");
    assert.equal(last.tools, undefined, "tools are withheld at finalisation");
    const tail = last.messages.at(-1);
    assert.ok(tail !== undefined && tail.role === "user", "the final ask is a user message");
    assert.ok(
      tail.content.includes("reading budget is exhausted"),
      "the budget-spent instruction closes the run",
    );
    assertWireValid(last.messages);
  });
});

describe("evidence budget — finalisation is bounded by bytes, not turns", () => {
  it("cumulative evidence crossing 512 KiB closes the loop with bound 'evidence'", async () => {
    writeFileSync(p.join(root, "src", "blob.txt"), "y".repeat(80 * 1024));
    const chat = {
      requests: [],
      complete: async ({ messages, tools: withTools }) => {
        chat.requests.push({ messages, tools: withTools });
        return {
          content: "",
          toolCalls: [
            {
              id: `b${String(chat.requests.length)}`,
              name: "read_file",
              arguments: JSON.stringify({ path: "src/blob.txt" }),
            },
          ],
          finishReason: "tool_calls",
        };
      },
    };

    const outcome = await runLoop({
      chat,
      model: "m",
      tools,
      messages: BASE_MESSAGES,
      maxTurns: 1000,
      contextWindow: 128_000,
    });

    assert.equal(
      MAX_CUMULATIVE_EVIDENCE_BYTES,
      512 * 2 ** 10,
      "the evidence ceiling is frozen at 512 KiB",
    );
    assert.equal(outcome.bound, "evidence");
    assert.equal(outcome.naturalStopped, false);
    assert.ok(outcome.evidenceBytes >= outcome.maxEvidenceBytes, "the ledger crossed the ceiling");
    assert.ok(
      outcome.toolCalls < 12,
      "the evidence ceiling fires long before the tool-call ceiling",
    );

    const last = chat.requests.at(-1);
    assert.ok(last !== undefined, "the finalisation request exists");
    assert.equal(last.tools, undefined, "tools are withheld at finalisation");
    const tail = last.messages.at(-1);
    assert.ok(tail !== undefined && tail.role === "user");
    assert.ok(
      tail.content.includes("reading budget is exhausted"),
      "the final ask names the exhausted budget",
    );
    assertWireValid(last.messages);
  });
});

describe("under the cap — a natural stop", () => {
  it("evidence below the cap ends in a natural, unbounded stop", async () => {
    const chat = scriptedChat([
      {
        content: "",
        toolCalls: [
          { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/a.mjs" }) },
        ],
      },
      { content: '{"findings":[],"summary":"done"}' },
    ]);

    const outcome = await runLoop({
      chat,
      model: "m",
      tools,
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      limits: { evidenceBytes: 64 * 2 ** 10 },
    });

    assert.equal(outcome.bound, undefined, "no budget was reached");
    assert.equal(outcome.naturalStopped, true, "the model stopped reading on its own");
    assert.ok(outcome.evidenceBytes > 0, "the read's evidence was counted");
    assert.ok(outcome.evidenceBytes < 64 * 2 ** 10, "the ledger stayed under the cap");
    assertWireValid(chat.requests.at(-1).messages);
  });
});

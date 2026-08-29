// Unknown tool names — the loop-level tool-protocol surface.
//
// Attack: the model asks for a tool that is not in the fixed registry — here
// `shell`, a name no review run will ever offer. The question is whether the
// loop silently dispatches or guesses at it, or refuses it.
//
// Security property asserted: the review loop ONLY ever executes tools from
// the fixed registry (`read_file`, `list_files`, `search`). An unknown name
// is refused as a bounded tool error by `createTools().execute` — the run
// never runs a shell or any other unknown side effect — and the refusal is
// handed back as a normal tool message so the conversation stays well-formed.
// The refusal is NOT fatal and does NOT hang the loop: the model can recover
// and stop naturally, and a model that insists on the unknown tool forever is
// still bounded by `MAX_TOOL_CALLS` — the unknown call counts one slot, never
// dispatches, and can never outrun the cap or grow the ledger unboundedly.
//
// Grounding: `review/src/loop.mjs` owns the real run loop; tool dispatch is
// `tools.execute(call.name, call.arguments)` at loop.mjs, and the refusal
// lives in `review/src/tools.mjs`'s `createTools().execute`: any name other
// than the three registry entries returns
// `unknown tool '<name>' — the fixed registry offers read_file, list_files,
// search` as a `{ ok: false }` result.
//
// Deterministic and offline: the chat seam is a scripted stub, the tree lives
// in a throwaway temp dir, no network, no model, no timers.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { after, before, describe, it } from "node:test";

import { createEvidence } from "#core/untrusted.mjs";
import { createWorkspace } from "#core/workspace.mjs";

import { MAX_TOOL_CALLS, runLoop } from "../../../review/src/loop.mjs";
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
  root = mkdtempSync(p.join(tmpdir(), "tool-unknown-"));
  workspace = createWorkspace({ root });
  tools = createTools({ workspace, evidence, ignore: [] });
  mkdirSync(p.join(root, "src"));
  writeFileSync(p.join(root, "src", "a.mjs"), "alpha\n");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A chat stub that asks for the unknown tool once and then stops naturally —
 * the model that tried one hostile call and moved on.
 *
 * @returns {{ requests: Array<{ messages: unknown }>, complete: (input: { messages: unknown }) => Promise<{ content: string, toolCalls: Array<{ id: string, name: string, arguments: string }>, finishReason: string }> }}
 */
function onceThenStopChat() {
  /** @type {Array<{ messages: unknown }>} */
  const requests = [];
  let turns = 0;
  return {
    requests,
    complete: async ({ messages }) => {
      requests.push({ messages });
      turns++;
      if (turns === 1) {
        return {
          content: "",
          toolCalls: [{ id: "c1", name: "shell", arguments: JSON.stringify({ cmd: "id" }) }],
          finishReason: "tool_calls",
        };
      }
      return { content: '{"findings":[]}', toolCalls: [], finishReason: "stop" };
    },
  };
}

/**
 * A chat stub that ALWAYS asks for the unknown tool — the relentless hostile
 * model. The loop MUST terminate on its own budget, never run the tool, and
 * never hang.
 *
 * @returns {{ requests: Array<{ messages: unknown, tools: unknown }>, complete: (input: { messages: unknown, tools?: unknown }) => Promise<{ content: string, toolCalls: Array<{ id: string, name: string, arguments: string }>, finishReason: string }> }}
 */
function relentlessUnknownChat() {
  /** @type {Array<{ messages: unknown, tools: unknown }>} */
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
            name: "shell",
            arguments: JSON.stringify({ cmd: "id" }),
          },
        ],
        finishReason: "tool_calls",
      };
    },
  };
}

/** The exact refusal the registry returns for a name outside it. */
const UNKNOWN_SHELL_REFUSAL =
  "unknown tool 'shell' — the fixed registry offers read_file, list_files, search";

describe("unknown tool name — the run loop refuses, never dispatches", () => {
  it("a single shell call is refused as a tool message and the loop stops naturally, executing no side effect", async () => {
    const chat = onceThenStopChat();

    const outcome = await runLoop({
      chat,
      model: "m",
      tools,
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      limits: { evidenceBytes: 64 * 2 ** 10 },
    });

    // The loop finalised: the unknown call did not hang it or blind-run it.
    assert.equal(outcome.bound, undefined, "the model recovered and stopped on its own");
    assert.equal(outcome.naturalStopped, true, "a natural, unbounded stop");
    assert.equal(outcome.toolCalls, 1, "exactly the one unknown call was attempted");

    // The refusal is a bounded tool error, not a dispatch: the tool message is
    // the registry's "unknown tool" text — never a shell result, never silent.
    const toolMessages = outcome.transcript.filter(
      (m) => m.role === "tool" && m.toolCallId === "c1",
    );
    assert.equal(toolMessages.length, 1, "the one call received exactly one answer");
    assert.equal(toolMessages[0].content, UNKNOWN_SHELL_REFUSAL, "the answer is the typed refusal");

    // No unknown side effect ever produced evidence: a refused call captures
    // nothing into the ledger.
    assert.equal(outcome.evidenceBytes, 0, "the shell call added no evidence bytes");
  });

  it("every tool message across the whole run is well-formed and paired, so the wire never breaks", async () => {
    const chat = onceThenStopChat();
    const outcome = await runLoop({
      chat,
      model: "m",
      tools,
      messages: BASE_MESSAGES,
      maxTurns: 30,
      contextWindow: 128_000,
      limits: { evidenceBytes: 64 * 2 ** 10 },
    });
    const roles = new Set(outcome.transcript.map((m) => m.role));
    assert.deepEqual([...roles].sort(), ["assistant", "system", "tool", "user"]);
    const assistant = outcome.transcript.find(
      (m) => m.role === "assistant" && m.toolCalls !== undefined,
    );
    assert.ok(assistant !== undefined, "the assistant turn carries the call");
    assert.equal(
      assistant.toolCalls[0].name,
      "shell",
      "the hostile name stayed on the wire, unmangled",
    );
    const answer = outcome.transcript.find((m) => m.role === "tool");
    assert.equal(answer.toolCallId, "c1", "the answer pairs with the call by id");
    assert.equal(answer.content, UNKNOWN_SHELL_REFUSAL);
  });

  it("a relentless unknown-tool model terminates at the budget, tools withheld, with zero evidence", async () => {
    const chat = relentlessUnknownChat();

    const outcome = await runLoop({
      chat,
      model: "m",
      tools,
      messages: BASE_MESSAGES,
      maxTurns: 1000,
      contextWindow: 128_000,
    });

    assert.equal(MAX_TOOL_CALLS, 200, "the tool-call ceiling is frozen at 200");
    assert.equal(outcome.bound, "tool-calls", "the budget fired — the loop did not hang");
    assert.equal(outcome.naturalStopped, false);
    assert.equal(outcome.toolCalls, MAX_TOOL_CALLS, "exactly the ceiling was attempted");
    assert.equal(
      chat.requests.length,
      MAX_TOOL_CALLS + 1,
      "one finalisation request follows the ceiling",
    );

    // Every one of the attempts was refused — no shell ever ran, nothing was
    // captured, and the call counted one bounded slot toward the cap, never
    // an unbounded or silent dispatch.
    assert.equal(outcome.evidenceBytes, 0, "no unknown tool produced evidence bytes");
    const toolMessages = outcome.transcript.filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, MAX_TOOL_CALLS, "all attempts were answered");
    assert.ok(
      toolMessages.every((m) => m.content === UNKNOWN_SHELL_REFUSAL),
      "every attempt was refused as the unknown tool",
    );

    const last = chat.requests.at(-1);
    assert.ok(last !== undefined, "the finalisation request exists");
    assert.equal(last.tools, undefined, "tools are withheld at finalisation");
  });
});

// Argument-shape and parser-depth bounds — the tool-protocol's typed
// refusals.
//
// Attacks:
//   - tool calls carrying unknown or missing arguments → a typed refusal
//     ("unknown argument 'x'" / "missing argument 'y'"), never a silent
//     partial application of the accepted subset
//   - one hostile call mixed into a turn of good calls → the hostile call
//     alone is refused; the good calls still apply and still cover paths
//   - a document nested ~40k levels deep → parses correctly (the parser is
//     iterative; a recursive parser would blow the stack)
//   - a deep document that never closes → a typed SyntaxError refusal; the
//     parse simply completes with an error (no hang, no RangeError)
//
// Security property asserted: every malformed or deep input is refused with
// a typed, positioned error, while well-formed calls and well-formed deep
// documents still work.
//
// Deterministic and offline: scripted tree, scripted chat, injected evidence
// delimiter; no network, no model, no timers.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as p from "node:path";
import { after, before, describe, it } from "node:test";

import { json5Parse } from "#core/json5-parse.mjs";
import { createEvidence } from "#core/untrusted.mjs";
import { createWorkspace } from "#core/workspace.mjs";

import { runLoop } from "../../../review/src/loop.mjs";
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
  root = mkdtempSync(p.join(tmpdir(), "tool-protocol-args-"));
  workspace = createWorkspace({ root });
  tools = createTools({ workspace, evidence, ignore: [] });
  mkdirSync(p.join(root, "src"));
  writeFileSync(p.join(root, "src", "ok.mjs"), "alpha\n");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A finite chat stub that plays a script and stops.
 *
 * @param {Array<{ content: string, toolCalls?: Array<{ id: string, name: string, arguments: string }> }>} script
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

/** @param {string} path */
function readFileCall(path) {
  return { id: "c1", name: "read_file", arguments: JSON.stringify({ path }) };
}

function searchCall(query) {
  return { id: "c2", name: "search", arguments: JSON.stringify({ query }) };
}

describe("argument-shape refusals — typed, and never partial", () => {
  it("rejects an unknown argument outright — no partial application", () => {
    const result = tools.execute("read_file", '{"path":"src/ok.mjs","truncate":true}');

    assert.equal(result.ok, false);
    assert.equal(result.output, "unknown argument 'truncate'");
  });

  it("rejects a missing required argument", () => {
    const result = tools.execute("read_file", '{"bogus":1}');

    assert.equal(result.ok, false);
    assert.equal(result.output, "missing argument 'path'");
  });

  it("rejects unknown and missing arguments for search too", () => {
    const unknown = tools.execute("search", '{"query":"alpha","deep":true}');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.output, "unknown argument 'deep'");

    const missing = tools.execute("search", '{"path":"src"}');
    assert.equal(missing.ok, false);
    assert.equal(missing.output, "missing argument 'query'");
  });
});

describe("batch isolation — one hostile call refuses alone", () => {
  it("good and hostile calls in one turn: the hostile one is refused, the good ones apply", async () => {
    const chat = scriptedChat([
      {
        content: "",
        toolCalls: [
          readFileCall("src/ok.mjs"),
          { id: "hostile", name: "read_file", arguments: '{"path":"src/ok.mjs","offset":9}' },
          searchCall("alpha"),
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
      expectedPaths: ["src/ok.mjs"],
    });

    assert.equal(outcome.bound, undefined);
    assert.equal(outcome.naturalStopped, true);
    assert.equal(outcome.toolCalls, 3, "every call in the batch was answered");
    assert.deepEqual(outcome.coverage.covered, ["src/ok.mjs"], "the good read covered its path");
    assert.ok(!outcome.coverage.covered.includes("hostile.txt"), "a refused read never covers");

    const last = chat.requests.at(-1);
    assert.ok(last !== undefined, "the finalisation request exists");
    const toolContents = last.messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.equal(toolContents.length, 3, "one tool message per call — refusal included");
    assert.ok(
      toolContents.some((c) => c.includes("unknown argument 'offset'")),
      "the hostile call alone was refused",
    );
    assert.ok(
      toolContents.some((c) => c.includes("[evidence:aaaabbbbccccdddd read-file]")),
      "the good read's evidence is marked",
    );
    assert.ok(
      toolContents.some((c) => c.includes("[evidence:aaaabbbbccccdddd search]")),
      "the good search's evidence is marked",
    );
  });
});

describe("json5 parser depth bounds — iterative, typed refusals", () => {
  /** The nesting depth the parse must survive without recursion. */
  const DEPTH = 40_000;

  it("a valid document nested ~40k levels parses correctly, no stack overflow", () => {
    const doc = "[".repeat(DEPTH) + "]".repeat(DEPTH);

    const parsed = json5Parse(doc);

    let node = parsed;
    let depth = 0;
    while (Array.isArray(node)) {
      depth++;
      node = node[0];
    }
    assert.equal(depth, DEPTH, "every level parsed");
    assert.equal(node, undefined, "the innermost array is empty");
  });

  it("a deep document that never closes is a typed SyntaxError, and completes", () => {
    const doc = "[".repeat(DEPTH) + "]".repeat(DEPTH - 1);

    let caught;
    try {
      json5Parse(doc);
    } catch (error) {
      caught = error;
    }

    assert.ok(caught !== undefined, "the unbalanced document is refused");
    assert.ok(caught instanceof SyntaxError, "the refusal is typed, not a RangeError");
    assert.ok(typeof caught.lineNumber === "number", "the typed refusal carries a position");
  });
});

/**
 * The agent loop — what to read next, when to stop, how to compact. It
 * speaks no protocol of its own and invents no ceilings: the protocol is
 * `chat.mjs`'s, the bounds are the spec's constants, and the model never
 * touches GitHub — every effect this loop produces is a line in its own
 * transcript.
 *
 * Accounting, exactly as specified:
 *
 *   - one turn is one model response; responses carrying tool calls are
 *     reading turns, bounded by `maxTurns`;
 *   - every tool call in a response gets exactly one result message — calls
 *     past the tool-call ceiling receive a budget-spent notice instead of
 *     execution, because an answered `tool_calls` with missing results is a
 *     wire violation of our own making;
 *   - wrapped results charge the cumulative-evidence ceiling;
 *   - when any reading bound fires first, ONE finalisation request goes out
 *     with the tools withheld — no further call is even expressible — and
 *     its content is the candidate, flagged partial with the bound named;
 *   - a response without tool calls while reading turns remain is a natural
 *     stop, and its content is the candidate — the only path a corrective
 *     re-ask may ever follow;
 *   - before every request, the token estimate is checked: past 80% of the
 *     window the transcript is compacted deterministically — system and task
 *     messages kept, everything later replaced by one state message built
 *     from the ledger. The model's prose along the way is discarded
 *     wholesale; a summary a model wrote never becomes context the loop
 *     trusts.
 *
 * A fatal tool result — arguments that were not JSON at all — ends the run
 * here: the conversation's wire format broke, which is provider failure,
 * not a turn to hand back.
 */

import { TOOL_SPECS } from "./tools.mjs";

/** @typedef {import("#core/chat.mjs").Chat} Chat */
/** @typedef {import("#core/chat.mjs").ChatMessage} ChatMessage */

export const MAX_TOOL_CALLS = 200;

/** No honest read_file/list_files/search arguments approach this. */
export const MAX_CALL_ARGUMENT_BYTES = 64 * 2 ** 10;
export const MAX_CUMULATIVE_EVIDENCE_BYTES = 512 * 2 ** 10;

/** @typedef {"max-turns" | "tool-calls" | "evidence"} Bound */

/**
 * @typedef {object} LoopOutcome
 * @property {string} candidate the final-answer candidate's text
 * @property {boolean} naturalStopped true when the model stopped on its own
 * @property {Bound | undefined} bound the reading bound that fired, when one did
 * @property {number} readingTurns
 * @property {number} toolCalls
 * @property {ChatMessage[]} transcript the loop's final transcript, for the re-ask
 * @property {string[]} log lines for the runner's log
 */

/**
 * The loop's own bookkeeping — the inventory that survives compaction.
 *
 * @typedef {object} Ledger
 * @property {number} readingTurns
 * @property {number} toolCalls
 * @property {number} evidenceBytes
 * @property {string[]} filesRead
 * @property {string[]} searchesRun
 * @property {string[]} toolErrors
 */

/**
 * @param {object} input
 * @param {Chat} input.chat
 * @param {string} input.model
 * @param {{ execute: (name: string, argumentsJson: string) => { ok: boolean, output: string, fatal?: true } }} input.tools
 * @param {ChatMessage[]} input.messages the assembled system + task messages, evidence included
 * @param {number} input.maxTurns
 * @param {number} input.contextWindow
 * @param {{ maxToolCalls?: number, evidenceBytes?: number }} [input.limits]
 * @returns {Promise<LoopOutcome>}
 */
export async function runLoop({ chat, model, tools, messages, maxTurns, contextWindow, limits }) {
  const maxToolCalls = limits?.maxToolCalls ?? MAX_TOOL_CALLS;
  const maxEvidenceBytes = limits?.evidenceBytes ?? MAX_CUMULATIVE_EVIDENCE_BYTES;

  if (messages[0] === undefined || messages[1] === undefined) {
    throw new Error("the loop needs a system message and a task message");
  }
  /** @type {Ledger} */
  const ledger = {
    readingTurns: 0,
    toolCalls: 0,
    evidenceBytes: 0,
    filesRead: [],
    searchesRun: [],
    toolErrors: [],
  };
  /** @type {ChatMessage[]} */
  let transcript = [...messages];
  /** @type {string[]} */
  const log = [];

  /**
   * One request, preceded by the compaction check. The transcript IS what
   * is sent; nothing is pending outside it.
   *
   * @param {import("#core/chat.mjs").ChatTool[] | undefined} offeredTools
   * @param {ChatMessage[]} [pending] one-shot additions — the finalisation instruction — never persisted
   */
  async function ask(offeredTools, pending = []) {
    if (estimateTokens(transcript) > 0.8 * contextWindow && transcript.length > 2) {
      transcript = [...transcript.slice(0, 2), { role: "user", content: renderState(ledger) }];
      log.push(
        `compacted the transcript to ${String(estimateTokens(transcript))} estimated tokens`,
      );
    }
    const response = await chat.complete({
      model,
      messages: [...transcript, ...pending],
      ...(offeredTools === undefined ? {} : { tools: offeredTools }),
    });
    return { response, transcript };
  }

  for (;;) {
    const { response, transcript: currentTranscript } = await ask(TOOL_SPECS);
    transcript = currentTranscript;

    if (response.toolCalls.length === 0) {
      // Natural stop while reading turns remain: the candidate speaks now.
      return {
        candidate: response.content,
        naturalStopped: true,
        bound: undefined,
        readingTurns: ledger.readingTurns,
        toolCalls: ledger.toolCalls,
        transcript,
        log,
      };
    }

    transcript.push({
      role: "assistant",
      content: response.content === "" ? null : response.content,
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      if (ledger.toolCalls >= maxToolCalls) {
        // Past the ceiling nothing executes — but the conversation stays
        // well-formed: every call receives its answer.
        transcript.push({
          role: "tool",
          toolCallId: call.id,
          content: "(not executed — the review's tool budget was spent)",
        });
        continue;
      }
      ledger.toolCalls++;
      if (Buffer.byteLength(call.arguments, "utf8") > MAX_CALL_ARGUMENT_BYTES) {
        // No legitimate call to a three-tool registry carries this much
        // argument text; a provider that emits one is breaking the wire.
        throw new Error(
          `the provider's tool call '${call.id}' carried ${String(Buffer.byteLength(call.arguments, "utf8"))} ` +
            `bytes of arguments — beyond any legitimate call`,
        );
      }
      track(ledger, call.name, call.arguments);

      const result = tools.execute(call.name, call.arguments);
      if (result.fatal === true) {
        throw new Error(
          `the provider's tool call '${call.id}' carried unparsable arguments — the wire contract is broken`,
        );
      }
      if (!result.ok) {
        ledger.toolErrors.push(`${call.name}: ${result.output.slice(0, 160)}`);
      } else {
        ledger.evidenceBytes += Buffer.byteLength(result.output, "utf8");
      }
      transcript.push({ role: "tool", toolCallId: call.id, content: result.output });
    }

    ledger.readingTurns++;
    if (
      ledger.readingTurns >= maxTurns ||
      ledger.toolCalls >= maxToolCalls ||
      ledger.evidenceBytes >= maxEvidenceBytes
    ) {
      const bound =
        ledger.evidenceBytes >= maxEvidenceBytes
          ? "evidence"
          : ledger.toolCalls >= maxToolCalls
            ? "tool-calls"
            : "max-turns";
      log.push(`reading bound fired: ${bound}`);
      return await conclude({ ask, ledger, log, bound, transcript });
    }
  }
}

/**
 * The one finalisation request: transcript plus an explicit instruction,
 * tools withheld so no further call is even expressible.
 *
 * @param {object} input
 * @param {(offeredTools: import("#core/chat.mjs").ChatTool[] | undefined, pending?: ChatMessage[]) => Promise<{ response: { content: string }, transcript: ChatMessage[] }>} input.ask
 * @param {Ledger} input.ledger
 * @param {string[]} input.log
 * @param {Bound} input.bound
 * @param {ChatMessage[]} input.transcript
 * @returns {Promise<LoopOutcome>}
 */
async function conclude({ ask, ledger, log, bound, transcript: _transcript }) {
  const { response, transcript: finalTranscript } = await ask(undefined, [
    {
      role: "user",
      content:
        "The review's reading budget is exhausted. Produce the final answer now: only the " +
        "JSON object the output contract specifies, findings you are confident in, nothing else.",
    },
  ]);
  return {
    candidate: response.content,
    naturalStopped: false,
    bound,
    readingTurns: ledger.readingTurns,
    toolCalls: ledger.toolCalls,
    transcript: finalTranscript,
    log,
  };
}

/**
 * One corrective re-ask after a NATURAL stop produced a structurally invalid
 * answer. Tools withheld; not a reading turn; never follows a bound.
 *
 * @param {object} input
 * @param {Chat} input.chat
 * @param {string} input.model
 * @param {ChatMessage[]} input.transcript the loop's final transcript
 * @returns {Promise<string>}
 */
export async function reaskFinalAnswer({ chat, model, transcript }) {
  const response = await chat.complete({
    model,
    messages: [
      ...transcript,
      {
        role: "user",
        content:
          "That answer does not satisfy the output contract. Answer again: only the JSON object " +
          "the contract specifies — findings and summary — with no prose around it.",
      },
    ],
  });
  return response.content;
}

/**
 * UTF-8 bytes ÷ 4, except codepoints above U+2E80 at ÷ 1.5 — crude on
 * purpose, biased against underestimating CJK-heavy text, identical
 * everywhere it runs.
 *
 * @param {ChatMessage[]} messages
 * @returns {number}
 */
export function estimateTokens(messages) {
  let tokens = 0;
  const charge = (/** @type {string} */ text) => {
    for (const char of text) {
      const bytes = Buffer.byteLength(char, "utf8");
      tokens += /** @type {number} */ (char.codePointAt(0)) > 0x2e80 ? bytes / 1.5 : bytes / 4;
    }
  };
  for (const message of messages) {
    charge(message.content ?? "");
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      // The wire carries these strings verbatim on the way back; an estimate
      // that cannot see them cannot protect the window they ride in.
      for (const call of message.toolCalls) charge(call.arguments);
    }
  }
  return Math.ceil(tokens);
}

/**
 * @param {Ledger} ledger
 * @returns {string}
 */
function renderState(ledger) {
  /** @type {string[]} */
  const parts = [
    "[state inventory]",
    `reading turns used: ${String(ledger.readingTurns)}; tool calls made: ${String(ledger.toolCalls)}`,
  ];
  if (ledger.filesRead.length > 0) parts.push(`files read:\n- ${ledger.filesRead.join("\n- ")}`);
  if (ledger.searchesRun.length > 0) {
    parts.push(`searches run:\n- ${ledger.searchesRun.join("\n- ")}`);
  }
  if (ledger.toolErrors.length > 0) {
    parts.push(`tool errors seen (do not repeat them):\n- ${ledger.toolErrors.join("\n- ")}`);
  }
  parts.push("Earlier tool results were discarded to fit the window. Re-read anything you need.");
  return parts.join("\n\n");
}

/**
 * @param {Ledger} ledger
 * @param {string} name
 * @param {string} argumentsJson
 */
function track(ledger, name, argumentsJson) {
  try {
    const args = /** @type {Record<string, unknown>} */ (JSON.parse(argumentsJson));
    if (name === "read_file" && typeof args["path"] === "string") {
      ledger.filesRead.push(JSON.stringify(String(args["path"]).slice(0, 300)));
    } else if (name === "search" && typeof args["query"] === "string") {
      ledger.searchesRun.push(JSON.stringify(String(args["query"]).slice(0, 60)));
    }
  } catch {
    // Unparsable arguments are fatal upstream; nothing to record here.
  }
}
